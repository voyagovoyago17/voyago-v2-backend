import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EmailVerificationDocument = EmailVerification & Document;

/** Code de vérification d'e-mail en attente (un seul par utilisateur, supprimé à l'expiration). */
@Schema({ collection: 'email_verifications' })
export class EmailVerification {
  @Prop({ required: true, unique: true })
  user_id: string;

  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  code_hash: string;

  @Prop({ required: true })
  expires_at: Date;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ default: Date.now })
  created_at: Date;
}

export const EmailVerificationSchema = SchemaFactory.createForClass(EmailVerification);
EmailVerificationSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
