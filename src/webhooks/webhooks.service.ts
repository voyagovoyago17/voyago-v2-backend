import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { ProService } from '../pro/pro.service';

@Injectable()
export class WebhooksService {
  private stripe: Stripe;
  private webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly proService: ProService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    this.webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET', '');

    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
    }
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string): Promise<{ received: boolean }> {
    if (!this.stripe) {
      throw new InternalServerErrorException('Stripe not configured');
    }

    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        if (session.payment_status === 'paid') {
          const userId = session.metadata?.user_id;
          const tier = session.metadata?.tier;

          if (userId && tier) {
            await this.proService.applyProStatus(userId, tier, session.id);
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        // La première facture est déjà traitée par checkout.session.completed
        if (invoice.billing_reason === 'subscription_cycle') {
          await this.proService.renewFromInvoice(invoice);
        }
        break;
      }

      default:
        // Unhandled event type — log but don't error
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    return { received: true };
  }
}
