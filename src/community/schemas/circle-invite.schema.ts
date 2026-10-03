import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CircleInviteDocument = CircleInvite & Document;

/** Code d'invitation à usage limité (durée et/ou nombre d'utilisations). */
@Schema({ collection: 'circle_invites', timestamps: { createdAt: 'created_at', updatedAt: false } })
export class CircleInvite {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true, index: true })
  circle_id: string;

  @Prop({ required: true })
  created_by: string;

  /** Libellé libre (« Soirée de lancement », « Amis de Lyon »...) */
  @Prop({ default: '' })
  label: string;

  /** null = illimité */
  @Prop({ type: Number, default: null })
  max_uses: number | null;

  @Prop({ default: 0 })
  uses: number;

  /** null = sans date d'expiration */
  @Prop({ type: Date, default: null })
  expires_at: Date | null;

  @Prop({ type: Date, default: null })
  revoked_at: Date | null;

  created_at: Date;
}

export const CircleInviteSchema = SchemaFactory.createForClass(CircleInvite);
