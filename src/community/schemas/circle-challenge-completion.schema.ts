import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CircleChallengeCompletionDocument = CircleChallengeCompletion & Document;

/** Défi de cercle réussi pour une période (les récompenses ne sont données qu'une fois). */
@Schema({ timestamps: { createdAt: 'created_at', updatedAt: false } })
export class CircleChallengeCompletion {
  @Prop({ required: true })
  circle_id: string;

  /** Mois du défi, AAAA-MM (UTC) */
  @Prop({ required: true })
  period: string;

  @Prop({ required: true })
  challenge_id: string;

  @Prop({ type: [String], default: [] })
  rewarded_user_ids: string[];
}

export const CircleChallengeCompletionSchema = SchemaFactory.createForClass(CircleChallengeCompletion);
CircleChallengeCompletionSchema.index({ circle_id: 1, period: 1, challenge_id: 1 }, { unique: true });
