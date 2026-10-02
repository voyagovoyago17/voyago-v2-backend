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
import { Resend } from 'resend';

import { User, UserDocument } from './schemas/user.schema';
import { UserSession, UserSessionDocument } from './schemas/user-session.schema';
import { PasswordReset, PasswordResetDocument } from './schemas/password-reset.schema';
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

@Injectable()
export class AuthService {
  private resend: Resend;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    @InjectModel(UserSession.name, GLOBAL_DB_CONNECTION) private readonly sessionModel: Model<UserSessionDocument>,
    @InjectModel(PasswordReset.name, GLOBAL_DB_CONNECTION) private readonly passwordResetModel: Model<PasswordResetDocument>,
    private readonly tenancyService: TenancyService,
    private readonly configService: ConfigService,
  ) {
    const resendKey = this.configService.get<string>('RESEND_API_KEY');
    if (resendKey) {
      this.resend = new Resend(resendKey);
    }
  }

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

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() }).exec();

    // Always return success to avoid email enumeration
    if (!user || user.auth_provider !== 'email') {
      return { message: 'If that email is registered, a reset code has been sent.' };
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const code_hash = await bcrypt.hash(code, 10);
    const expires_at = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Remove existing resets for this email
    await this.passwordResetModel.deleteMany({ email: dto.email.toLowerCase() }).exec();

    await this.passwordResetModel.create({
      email: dto.email.toLowerCase(),
      user_id: user.user_id,
      code_hash,
      expires_at,
      attempts: 0,
      created_at: new Date(),
    });

    // Send email via Resend
    if (this.resend) {
      try {
        await this.resend.emails.send({
          from: 'Voyago <noreply@voyago.app>',
          to: dto.email,
          subject: 'Votre code de réinitialisation Voyago',
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #6366f1;">Réinitialisation de mot de passe</h2>
              <p>Voici votre code de réinitialisation :</p>
              <div style="background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
                <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #111827;">${code}</span>
              </div>
              <p>Ce code expire dans <strong>30 minutes</strong>.</p>
              <p>Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
            </div>
          `,
        });
      } catch (err) {
        console.error('Failed to send reset email:', err);
      }
    } else {
      console.log(`[DEV] Password reset code for ${dto.email}: ${code}`);
    }

    return { message: 'If that email is registered, a reset code has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const reset = await this.passwordResetModel
      .findOne({ email: dto.email.toLowerCase() })
      .sort({ created_at: -1 })
      .exec();

    if (!reset) {
      throw new BadRequestException('No reset request found for this email');
    }

    if (new Date() > reset.expires_at) {
      await this.passwordResetModel.deleteOne({ _id: reset._id }).exec();
      throw new BadRequestException('Reset code has expired');
    }

    if (reset.attempts >= 5) {
      throw new BadRequestException('Too many failed attempts. Please request a new code.');
    }

    const valid = await bcrypt.compare(dto.code, reset.code_hash);
    if (!valid) {
      await this.passwordResetModel.updateOne({ _id: reset._id }, { $inc: { attempts: 1 } }).exec();
      throw new BadRequestException('Invalid reset code');
    }

    const password_hash = await bcrypt.hash(dto.new_password, 12);
    await this.userModel.updateOne(
      { user_id: reset.user_id },
      { $set: { password_hash } },
    ).exec();

    // Invalidate all sessions
    await this.sessionModel.deleteMany({ user_id: reset.user_id }).exec();

    // Remove reset record
    await this.passwordResetModel.deleteOne({ _id: reset._id }).exec();

    return { message: 'Password reset successfully' };
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
