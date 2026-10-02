import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CircleTripVoteDocument = CircleTripVote & Document;

/** Vote d'un membre sur un lieu proposé (un seul vote par lieu, modifiable). */
@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class CircleTripVote {
  @Prop({ required: true })
  plan_id: string;

  @Prop({ required: true })
  user_id: string;

  @Prop({ required: true })
  poi_key: string;

  @Prop({ type: String, required: true, enum: ['up', 'down'] })
  vote: 'up' | 'down';
}

export const CircleTripVoteSchema = SchemaFactory.createForClass(CircleTripVote);
CircleTripVoteSchema.index({ plan_id: 1, user_id: 1, poi_key: 1 }, { unique: true });
CircleTripVoteSchema.index({ plan_id: 1, poi_key: 1 });
