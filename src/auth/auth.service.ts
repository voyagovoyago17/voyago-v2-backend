import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

import { User, UserDocument } from './schemas/user.schema';
import { UserSession, UserSessionDocument } from './schemas/user-session.schema';
import { PasswordReset, PasswordResetDocument } from './schemas/password-reset.schema';
import { EmailVerification, EmailVerificationDocument } from './schemas/email-verification.schema';
import { MailService } from '../mail/mail.service';
import { GamificationService } from '../gamification/gamification.service';
import { ProfileSchema } from '../gamification/schemas/profile.schema';

import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleSessionDto } from './dto/google-session.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { isProActive } from '../pro/pro-status';
import { TenancyService } from '../tenancy/tenancy.service';

/** Validité des codes envoyés par e-mail */
const VERIFY_CODE_MINUTES = 15;
const RESET_CODE_MINUTES = 30;
/** Délai minimum entre deux envois de code (anti-spam) */
const CODE_RESEND_COOLDOWN_S = 60;
const MAX_CODE_ATTEMPTS = 5;

/** Code à 6 chiffres, tiré avec un générateur cryptographique */
function sixDigitCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    @InjectModel(UserSession.name, GLOBAL_DB_CONNECTION) private readonly sessionModel: Model<UserSessionDocument>,
    @InjectModel(PasswordReset.name, GLOBAL_DB_CONNECTION) private readonly passwordResetModel: Model<PasswordResetDocument>,
    @InjectModel(EmailVerification.name, GLOBAL_DB_CONNECTION)
    private readonly emailVerificationModel: Model<EmailVerificationDocument>,
    private readonly tenancyService: TenancyService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly gamificationService: GamificationService,
  ) {}

  private generateSessionToken(): string {
    return crypto.randomBytes(36).toString('base64url');
  }

  private async createSession(user_id: string): Promise<string> {
    const token = this.generateSessionToken();
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await this.sessionModel.create({
      user_id,
      session_token: token,
      expires_at,
      created_at: new Date(),
    });

    return token;
  }

  /**
   * Creates a profile in the user's own tenant database (tenant_<user_id>).
   */
  private async createProfile(user_id: string): Promise<void> {
    try {
      const ProfileModel = await this.tenancyService.getTenantModel(
        user_id,
        'Profile',
        ProfileSchema,
      );

      const existing = await ProfileModel.findOne({ user_id }).exec();
      if (!existing) {
        await ProfileModel.create({
          user_id,
          tenant_id: user_id,
          xp: 0,
          level: 1,
          streak: 0,
          badges: [],
          trips_count: 0,
          last_active: new Date(),
        });
        this.logger.log(`Profile created in tenant DB for user: ${user_id}`);
      }
    } catch (err) {
      this.logger.error(`Failed to create profile for ${user_id}: ${err}`);
    }
  }

  private sanitizeUser(user: UserDocument): object {
    const obj = user.toObject ? user.toObject() : { ...user };
    delete obj.password_hash;
    delete obj._id;
    delete obj.__v;
    // Abonnement réellement valide (is_pro seul ne tient pas compte de l'échéance)
    obj.pro_active = isProActive(obj);
    return obj;
  }

  async emailSignup(dto: SignupDto): Promise<{ session_token: string; user_id: string; tenant_id: string; user: object }> {
    const existing = await this.userModel.findOne({ email: dto.email.toLowerCase() }).exec();
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const password_hash = await bcrypt.hash(dto.password, 12);
    const user_id = 'user_' + uuidv4();

    const user = await this.userModel.create({
      user_id,
      auth_provider: 'email',
      email: dto.email.toLowerCase(),
      name: dto.name,
      pseudo: dto.pseudo || null,
      avatar_emoji: dto.avatar_emoji || null,
      date_of_birth: dto.date_of_birth || null,
      gender: 'prefer_not_to_say',
      thermal_sensitivity: 'balanced',
      onboarding_completed: false,
      country: dto.country || null,
      city: dto.city || null,
      password_hash,
      tenant_id: user_id,
      is_pro: false,
      pro_tier: null,
      pro_expires_at: null,
      created_at: new Date(),
    });

    await this.createProfile(user_id);
    const session_token = await this.createSession(user_id);

    // Code de vérification envoyé tout de suite (n'empêche jamais l'inscription d'aboutir)
    this.sendEmailVerification(user).catch((err) =>
      this.logger.warn(`Code de vérification non envoyé à ${user.email}: ${err.message}`),
    );

    return { session_token, user_id, tenant_id: user_id, user: this.sanitizeUser(user) };
  }

  async emailLogin(dto: LoginDto): Promise<{ session_token: string; user_id: string; tenant_id: string; user: object }> {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() }).exec();
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.auth_provider !== 'email' || !user.password_hash) {
      throw new UnauthorizedException('This account uses a different login method');
    }

    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Ensure tenant_id is set on the user record
    if (!user.tenant_id || user.tenant_id === 'default') {
      await this.userModel.updateOne({ user_id: user.user_id }, { $set: { tenant_id: user.user_id } }).exec();
      user.tenant_id = user.user_id;
    }

    // Ensure profile exists in tenant DB
    await this.createProfile(user.user_id);

    const session_token = await this.createSession(user.user_id);
    return { session_token, user_id: user.user_id, tenant_id: user.user_id, user: this.sanitizeUser(user) };
  }

  async googleSession(dto: GoogleSessionDto): Promise<{ session_token: string; user_id: string; tenant_id: string; user: object }> {
    let oauthData: any;

    try {
      const response = await axios.get(
        `https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data/${dto.session_id}`,
        { timeout: 10000 },
      );
      oauthData = response.data;
    } catch (err) {
      throw new BadRequestException('Failed to retrieve Google OAuth session data');
    }

    const email = oauthData?.email || oauthData?.user?.email;
    const name = oauthData?.name || oauthData?.user?.name || 'Google User';
    const picture = oauthData?.picture || oauthData?.user?.picture || null;

    if (!email) {
      throw new BadRequestException('No email returned from OAuth provider');
    }

    let user = await this.userModel.findOne({ email: email.toLowerCase() }).exec();

    if (!user) {
      const user_id = 'user_' + uuidv4();
      user = await this.userModel.create({
        user_id,
        auth_provider: 'google',
        email: email.toLowerCase(),
        // Adresse déjà confirmée par Google
        email_verified: true,
        email_verified_at: new Date(),
        name,
        picture,
        tenant_id: user_id,
        is_pro: false,
        pro_tier: null,
        pro_expires_at: null,
        created_at: new Date(),
      });
      await this.createProfile(user_id);
    } else {
      // Connexion Google : l'adresse est confirmée par Google
      if (!user.email_verified) {
        await this.userModel
          .updateOne({ user_id: user.user_id }, { $set: { email_verified: true, email_verified_at: new Date() } })
          .exec();
        user.email_verified = true;
      }
      // Update picture if changed
      if (picture && user.picture !== picture) {
        await this.userModel.updateOne({ user_id: user.user_id }, { $set: { picture } }).exec();
        user.picture = picture;
      }
      // Ensure tenant_id is set
      if (!user.tenant_id || user.tenant_id === 'default') {
        await this.userModel.updateOne({ user_id: user.user_id }, { $set: { tenant_id: user.user_id } }).exec();
        user.tenant_id = user.user_id;
      }
      // Ensure profile exists
      await this.createProfile(user.user_id);
    }

    const session_token = await this.createSession(user.user_id);
    return { session_token, user_id: user.user_id, tenant_id: user.user_id, user: this.sanitizeUser(user) };
  }

  async guestLogin(guest_user_id: string): Promise<{ session_token: string; user_id: string; tenant_id: string; user: object }> {
    if (!guest_user_id.startsWith('guest_')) {
      throw new BadRequestException('Invalid guest user_id format');
    }

    let user = await this.userModel.findOne({ user_id: guest_user_id }).exec();

    if (!user) {
      user = await this.userModel.create({
        user_id: guest_user_id,
        auth_provider: 'guest',
        name: 'Guest',
        tenant_id: guest_user_id,
        is_pro: false,
        pro_tier: null,
        pro_expires_at: null,
        created_at: new Date(),
      });
      await this.createProfile(guest_user_id);
    } else {
      // Ensure tenant_id is set
      if (!user.tenant_id || user.tenant_id === 'default') {
        await this.userModel.updateOne({ user_id: user.user_id }, { $set: { tenant_id: user.user_id } }).exec();
        user.tenant_id = user.user_id;
      }
    }

    const session_token = await this.createSession(user.user_id);
    return { session_token, user_id: user.user_id, tenant_id: guest_user_id, user: this.sanitizeUser(user) };
  }

  // =========================================================================
  // VÉRIFICATION DE L'ADRESSE E-MAIL (code à 6 chiffres)
  // =========================================================================

  /**
   * Envoie (ou renvoie) un code de vérification à l'adresse du compte.
   * Un seul code actif par compte, un envoi toutes les 60 secondes au plus.
   */
  async sendEmailVerification(user: UserDocument): Promise<object> {
    if (!user.email) {
      throw new BadRequestException("Ce compte n'a pas d'adresse e-mail");
    }
    if (user.email_verified) {
      return { sent: false, already_verified: true, email: user.email };
    }

    const previous = await this.emailVerificationModel.findOne({ user_id: user.user_id }).lean().exec();
    if (previous) {
      const elapsed = (Date.now() - new Date(previous.created_at).getTime()) / 1000;
      if (elapsed < CODE_RESEND_COOLDOWN_S) {
        const wait = Math.ceil(CODE_RESEND_COOLDOWN_S - elapsed);
        return { sent: false, cooldown_seconds: wait, email: user.email, message: `Patiente ${wait} s avant de redemander un code` };
      }
    }

    const code = sixDigitCode();
    await this.emailVerificationModel
      .findOneAndUpdate(
        { user_id: user.user_id },
        {
          $set: {
            email: user.email,
            code_hash: await bcrypt.hash(code, 10),
            expires_at: new Date(Date.now() + VERIFY_CODE_MINUTES * 60 * 1000),
            attempts: 0,
            created_at: new Date(),
          },
        },
        { upsert: true },
      )
      .exec();

    const sent = await this.mailService.sendEmailVerificationCode(user.email, user.pseudo || user.name, code, VERIFY_CODE_MINUTES);
    if (!sent) {
      await this.emailVerificationModel.deleteOne({ user_id: user.user_id }).exec();
      throw new InternalServerErrorException("L'e-mail n'a pas pu être envoyé, réessaie dans un instant");
    }
    return {
      sent: true,
      email: user.email,
      cooldown_seconds: CODE_RESEND_COOLDOWN_S,
      expires_in_minutes: VERIFY_CODE_MINUTES,
    };
  }

  /** Confirme l'adresse avec le code reçu : badge « vérifié » et un peu d'XP. */
  async confirmEmailVerification(user: UserDocument, code: string): Promise<object> {
    if (user.email_verified) {
      return { verified: true, user: this.sanitizeUser(user) };
    }
    const pending = await this.emailVerificationModel.findOne({ user_id: user.user_id }).exec();
    if (!pending || pending.email !== user.email) {
      throw new BadRequestException('Aucun code en cours : demande un nouveau code');
    }
    if (new Date() > pending.expires_at) {
      await this.emailVerificationModel.deleteOne({ _id: pending._id }).exec();
      throw new BadRequestException('Ce code a expiré : demande un nouveau code');
    }
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      throw new BadRequestException('Trop de tentatives : demande un nouveau code');
    }
    if (!(await bcrypt.compare(code, pending.code_hash))) {
      await this.emailVerificationModel.updateOne({ _id: pending._id }, { $inc: { attempts: 1 } }).exec();
      const left = MAX_CODE_ATTEMPTS - pending.attempts - 1;
      throw new BadRequestException(
        left > 0 ? `Code incorrect (${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''})` : 'Code incorrect : demande un nouveau code',
      );
    }

    const updated = await this.userModel
      .findOneAndUpdate(
        { user_id: user.user_id },
        { $set: { email_verified: true, email_verified_at: new Date() } },
        { new: true },
      )
      .exec();
    await this.emailVerificationModel.deleteOne({ _id: pending._id }).exec();

    let xp_awarded = 0;
    try {
      const res: any = await this.gamificationService.awardXP(user.user_id, 'compte_verifie');
      xp_awarded = res?.xp_awarded || 0;
    } catch (err: any) {
      this.logger.warn(`XP de vérification non attribuée à ${user.user_id}: ${err.message}`);
    }
    return { verified: true, xp_awarded, user: this.sanitizeUser(updated!) };
  }

  // =========================================================================
  // MOT DE PASSE OUBLIÉ (code à 6 chiffres)
  // =========================================================================

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string; cooldown_seconds: number }> {
    const email = dto.email.toLowerCase().trim();
    // Même réponse dans tous les cas : on ne révèle pas si l'adresse a un compte
    const response = {
      message: 'Si un compte existe avec cette adresse, un code vient de lui être envoyé.',
      cooldown_seconds: CODE_RESEND_COOLDOWN_S,
    };

    const user = await this.userModel.findOne({ email }).exec();
    if (!user || user.auth_provider !== 'email') {
      return response;
    }

    const previous = await this.passwordResetModel.findOne({ email }).sort({ created_at: -1 }).lean().exec();
    if (previous && (Date.now() - new Date(previous.created_at).getTime()) / 1000 < CODE_RESEND_COOLDOWN_S) {
      return response;
    }

    const code = sixDigitCode();
    await this.passwordResetModel.deleteMany({ email }).exec();
    await this.passwordResetModel.create({
      email,
      user_id: user.user_id,
      code_hash: await bcrypt.hash(code, 10),
      expires_at: new Date(Date.now() + RESET_CODE_MINUTES * 60 * 1000),
      attempts: 0,
      created_at: new Date(),
    });

    await this.mailService.sendPasswordResetCode(email, user.pseudo || user.name, code, RESET_CODE_MINUTES);
    return response;
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const email = dto.email.toLowerCase().trim();
    const reset = await this.passwordResetModel.findOne({ email }).sort({ created_at: -1 }).exec();

    if (!reset) {
      throw new BadRequestException('Aucune demande en cours pour cette adresse : demande un nouveau code');
    }
    if (new Date() > reset.expires_at) {
      await this.passwordResetModel.deleteOne({ _id: reset._id }).exec();
      throw new BadRequestException('Ce code a expiré : demande un nouveau code');
    }
    if (reset.attempts >= MAX_CODE_ATTEMPTS) {
      throw new BadRequestException('Trop de tentatives : demande un nouveau code');
    }
    if (!(await bcrypt.compare(dto.code, reset.code_hash))) {
      await this.passwordResetModel.updateOne({ _id: reset._id }, { $inc: { attempts: 1 } }).exec();
      const left = MAX_CODE_ATTEMPTS - reset.attempts - 1;
      throw new BadRequestException(
        left > 0 ? `Code incorrect (${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''})` : 'Code incorrect : demande un nouveau code',
      );
    }

    const password_hash = await bcrypt.hash(dto.new_password, 12);
    // Le code reçu par e-mail prouve aussi que l'adresse appartient au voyageur
    const user = await this.userModel
      .findOneAndUpdate(
        { user_id: reset.user_id },
        { $set: { password_hash, email_verified: true, email_verified_at: new Date() } },
        { new: true },
      )
      .exec();

    // Déconnexion de tous les appareils, puis alerte de sécurité
    await this.sessionModel.deleteMany({ user_id: reset.user_id }).exec();
    await this.passwordResetModel.deleteOne({ _id: reset._id }).exec();
    if (user?.email) {
      this.mailService.sendPasswordChanged(user.email, user.pseudo || user.name).catch(() => {});
    }

    return { message: 'Mot de passe modifié : tu peux te connecter avec le nouveau.' };
  }

  async getMe(user: UserDocument): Promise<object> {
    return this.sanitizeUser(user);
  }

  async updateMe(user: UserDocument, dto: UpdateProfileDto): Promise<object> {
    const updateFields: any = {};

    if (dto.name !== undefined) updateFields.name = dto.name;
    if (dto.pseudo !== undefined) updateFields.pseudo = dto.pseudo;
    if (dto.avatar_emoji !== undefined) updateFields.avatar_emoji = dto.avatar_emoji;
    if (dto.date_of_birth !== undefined) updateFields.date_of_birth = dto.date_of_birth;
    if (dto.gender !== undefined) updateFields.gender = dto.gender;
    if (dto.thermal_sensitivity !== undefined) updateFields.thermal_sensitivity = dto.thermal_sensitivity;
    if (dto.onboarding_completed !== undefined) updateFields.onboarding_completed = dto.onboarding_completed;
    if (dto.country !== undefined) updateFields.country = dto.country;
    if (dto.city !== undefined) updateFields.city = dto.city;
    if (dto.picture !== undefined) {
      updateFields.picture = dto.picture;
      if (!dto.picture) {
        updateFields.picture_key = null;
      }
    }

    const updated = await this.userModel
      .findOneAndUpdate(
        { user_id: user.user_id },
        { $set: updateFields },
        { new: true },
      )
      .exec();

    return this.sanitizeUser(updated);
  }

  async logout(sessionToken: string): Promise<{ message: string }> {
    await this.sessionModel.deleteOne({ session_token: sessionToken }).exec();
    return { message: 'Logged out successfully' };
  }

  getAuthOptions(): object {
    const countries = [
      'France', 'Belgique', 'Suisse', 'Canada', 'Maroc', 'Algérie', 'Tunisie',
      'Sénégal', "Côte d'Ivoire", 'États-Unis', 'Royaume-Uni', 'Espagne', 'Italie',
      'Allemagne', 'Portugal', 'Pays-Bas', 'Brésil', 'Mexique', 'Japon', 'Australie', 'Autre',
    ];
    const avatar_emojis = ['🦜', '🦁', '🐼', '🦊', '🐨', '🦋', '🐬', '🦅', '🐯', '🦄', '🐺', '🦩'];
    return { countries, avatar_emojis };
  }
}
