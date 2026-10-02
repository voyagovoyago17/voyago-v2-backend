import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ collection: 'users' })
export class User {
  @Prop({ required: true })
  user_id: string;

  @Prop({ default: 'default' })
  tenant_id: string;

  @Prop({ required: true, enum: ['email', 'google', 'guest'] })
  auth_provider: string;

  @Prop()
  email: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  picture: string;

  @Prop({ default: null })
  picture_key: string;

  @Prop()
  pseudo: string;

  @Prop()
  avatar_emoji: string;

  @Prop()
  date_of_birth: string;

  @Prop({ enum: ['male', 'female', 'other', 'prefer_not_to_say'], default: 'prefer_not_to_say' })
  gender: string;

  @Prop({ enum: ['cold', 'balanced', 'warm'], default: 'balanced' })
  thermal_sensitivity: string;

  @Prop({ default: false })
  onboarding_completed: boolean;

  @Prop()
  country: string;

  @Prop()
  city: string;

  @Prop()
  password_hash: string;

  /** Adresse e-mail confirmée (code reçu par e-mail, ou compte Google) */
  @Prop({ default: false })
  email_verified: boolean;

  @Prop({ type: Date, default: null })
  email_verified_at: Date | null;

  @Prop({ default: false })
  is_pro: boolean;

  @Prop({ default: null })
  pro_tier: string;

  @Prop({ default: null })
  pro_expires_at: Date;

  @Prop({ default: Date.now })
  created_at: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Explicit Indexes
UserSchema.index({ user_id: 1 }, { unique: true });
UserSchema.index({ email: 1 }, { sparse: true, unique: true });
UserSchema.index({ tenant_id: 1 });
UserSchema.index({ user_id: 1, tenant_id: 1 });
UserSchema.index({ auth_provider: 1 });
UserSchema.index({ created_at: -1 });
