import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import Stripe from 'stripe';

import { PaymentTransaction, PaymentTransactionDocument } from './schemas/payment-transaction.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { ProfileSchema } from '../gamification/schemas/profile.schema';
import { TenancyService } from '../tenancy/tenancy.service';

const TIERS = [
  {
    id: 'monthly',
    name: 'Mensuel',
    price: 4.99,
    currency: 'eur',
    duration: 'month',
    benefits: [
      'Voyages illimités',
      'Météo étendue 16 jours',
      'Badge Pro 💎',
      "Accès anticipé aux nouvelles fonctionnalités",
    ],
    stripe_price_id: 'price_monthly',
  },
  {
    id: 'annual',
    name: 'Annuel',
    price: 39.99,
    currency: 'eur',
    duration: 'year',
    benefits: [
      'Voyages illimités',
      'Météo étendue 16 jours',
      'Badge Pro 💎',
      'Accès anticipé',
      '2 mois offerts',
    ],
    stripe_price_id: 'price_annual',
    best_offer: true,
  },
  {
    id: 'lifetime',
    name: 'À vie',
    price: 79.99,
    currency: 'eur',
    duration: 'lifetime',
    benefits: [
      'Voyages illimités',
      'Météo étendue 16 jours',
      'Badge Pro 💎',
      'Accès anticipé',
      'Toutes les futures fonctionnalités',
    ],
    stripe_price_id: 'price_lifetime',
  },
];

import { GLOBAL_DB_CONNECTION } from '../common/constants';

@Injectable()
export class ProService {
  private stripe: Stripe;
  private readonly logger = new Logger(ProService.name);

  constructor(
    @InjectModel(PaymentTransaction.name, GLOBAL_DB_CONNECTION) private readonly transactionModel: Model<PaymentTransactionDocument>,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    private readonly tenancyService: TenancyService,
    private readonly configService: ConfigService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
    }
  }

  getTiers(): object[] {
    return TIERS;
  }

  async createCheckout(user: UserDocument, tier: string): Promise<{ checkout_url: string; session_id: string }> {
    if (!this.stripe) {
      throw new InternalServerErrorException('Stripe not configured');
    }

    const tierConfig = TIERS.find((t) => t.id === tier);
    if (!tierConfig) {
      throw new BadRequestException(`Unknown tier: ${tier}`);
    }

    const appBaseUrl = this.configService.get<string>('APP_BASE_URL', 'http://localhost:8001');

    const isSubscription = tier !== 'lifetime';

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: isSubscription ? 'subscription' : 'payment',
      success_url: `${appBaseUrl}/pricing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBaseUrl}/pricing?cancelled=true`,
      metadata: {
        user_id: user.user_id,
        tier,
        email: user.email || '',
      },
      // Retrouvé sur chaque facture de renouvellement (invoice.subscription_details.metadata)
      ...(isSubscription && {
        subscription_data: { metadata: { user_id: user.user_id, tier } },
      }),
      line_items: [
        {
          price_data: {
            currency: tierConfig.currency,
            product_data: {
              name: `Voyago ${tierConfig.name}`,
              description: tierConfig.benefits.join(', '),
            },
            unit_amount: Math.round(tierConfig.price * 100),
            ...(isSubscription && {
              recurring: {
                interval: tier === 'annual' ? 'year' : 'month',
              },
            }),
          },
          quantity: 1,
        },
      ],
    };

    if (user.email) {
      sessionParams.customer_email = user.email;
    }

    const session = await this.stripe.checkout.sessions.create(sessionParams);

    await this.transactionModel.create({
      session_id: session.id,
      user_id: user.user_id,
      tier,
      amount: Math.round(tierConfig.price * 100),
      currency: tierConfig.currency,
      status: 'initiated',
      payment_status: 'unpaid',
      applied: false,
      metadata: { user_id: user.user_id, tier, email: user.email || '' },
      created_at: new Date(),
      updated_at: new Date(),
    });

    return { checkout_url: session.url, session_id: session.id };
  }

  async pollPaymentStatus(session_id: string): Promise<{ status: string; payment_status: string; applied: boolean }> {
    if (!this.stripe) {
      throw new InternalServerErrorException('Stripe not configured');
    }

    const transaction = await this.transactionModel.findOne({ session_id }).exec();
    if (!transaction) {
      throw new NotFoundException(`Transaction ${session_id} not found`);
    }

    const stripeSession = await this.stripe.checkout.sessions.retrieve(session_id);

    const paymentStatus = stripeSession.payment_status;
    const status = stripeSession.status;

    await this.transactionModel.updateOne(
      { session_id },
      {
        $set: {
          status: status || 'unknown',
          payment_status: paymentStatus || 'unpaid',
          updated_at: new Date(),
        },
      },
    ).exec();

    if (paymentStatus === 'paid' && !transaction.applied) {
      await this.applyProStatus(transaction.user_id, transaction.tier, session_id);
    }

    const updated = await this.transactionModel.findOne({ session_id }).lean().exec();
    return {
      status: updated.status,
      payment_status: updated.payment_status,
      applied: updated.applied,
    };
  }

  /**
   * Renouvellement d'abonnement payé : prolonge l'échéance jusqu'à la fin de la
   * période facturée. Les abonnements antérieurs sans métadonnées sont retrouvés par e-mail.
   */
  async renewFromInvoice(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.subscription) return;
    const metadata: Record<string, string> = (invoice as any).subscription_details?.metadata || {};
    let userId = metadata.user_id;
    if (!userId && invoice.customer_email) {
      const user: any = await this.userModel.findOne({ email: invoice.customer_email.toLowerCase() }).lean().exec();
      userId = user?.user_id;
    }
    if (!userId) {
      this.logger.warn(`Renouvellement Stripe sans utilisateur identifiable (facture ${invoice.id})`);
      return;
    }

    const periodEnd = invoice.lines?.data?.[0]?.period?.end;
    let expiresAt: Date;
    if (periodEnd) {
      expiresAt = new Date(periodEnd * 1000);
    } else {
      expiresAt = new Date();
      if (metadata.tier === 'annual') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      else expiresAt.setMonth(expiresAt.getMonth() + 1);
    }

    await this.userModel
      .updateOne(
        { user_id: userId },
        { $set: { is_pro: true, pro_expires_at: expiresAt, ...(metadata.tier ? { pro_tier: metadata.tier } : {}) } },
      )
      .exec();
    this.logger.log(`Abonnement Pro de ${userId} prolongé jusqu'au ${expiresAt.toISOString()}`);
  }

  async applyProStatus(user_id: string, tier: string, session_id: string): Promise<void> {
    let pro_expires_at: Date | null = null;

    if (tier === 'monthly') {
      pro_expires_at = new Date();
      pro_expires_at.setMonth(pro_expires_at.getMonth() + 1);
    } else if (tier === 'annual') {
      pro_expires_at = new Date();
      pro_expires_at.setFullYear(pro_expires_at.getFullYear() + 1);
    } else if (tier === 'lifetime') {
      pro_expires_at = null;
    }

    await this.userModel.updateOne(
      { user_id },
      {
        $set: {
          is_pro: true,
          pro_tier: tier,
          pro_expires_at,
        },
      },
    ).exec();

    // Award voyago_pro badge in user's tenant DB
    try {
      const ProfileModel = await this.tenancyService.getTenantModel<any>(
        user_id,
        'Profile',
        ProfileSchema,
      );
      await ProfileModel.updateOne(
        { user_id },
        { $addToSet: { badges: 'voyago_pro' } },
      ).exec();
    } catch (err) {
      this.logger.warn(`Failed to award pro badge for ${user_id}: ${err.message}`);
    }

    // Mark transaction as applied
    if (session_id) {
      await this.transactionModel.updateOne(
        { session_id },
        {
          $set: {
            applied: true,
            status: 'complete',
            payment_status: 'paid',
            updated_at: new Date(),
          },
        },
      ).exec();
    }
  }

  async getProStatus(user: UserDocument): Promise<object> {
    return {
      is_pro: user.is_pro,
      tier: user.pro_tier || null,
      expires_at: user.pro_expires_at || null,
    };
  }
}
