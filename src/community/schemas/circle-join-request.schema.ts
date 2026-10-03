import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CircleJoinRequestDocument = CircleJoinRequest & Document;

export const JOIN_REQUEST_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

/** Demande d'un voyageur pour rejoindre un cercle privé. */
@Schema({ collection: 'circle_join_requests', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class CircleJoinRequest {
  @Prop({ required: true, unique: true })
  id: string;

  @Prop({ required: true, index: true })
  circle_id: string;

  @Prop({ required: true, index: true })
  user_id: string;

  @Prop({ type: String, enum: JOIN_REQUEST_STATUSES, default: 'pending', index: true })
  status: JoinRequestStatus;

  /** Mot du voyageur / réponse à la question du fondateur */
  @Prop({ default: '' })
  message: string;

  /** Membres qui se portent garants du voyageur (parrainage) */
  @Prop({ type: [{ user_id: String, at: Date }], default: [] })
  vouched_by: { user_id: string; at: Date }[];

  /** Réponse du fondateur en moins de 24 h (badge « Fondateur actif ») */
  @Prop({ default: false })
  quick_decision: boolean;

  @Prop({ type: String, default: null })
  decided_by: string | null;

  @Prop({ type: Date, default: null })
  decided_at: Date | null;

  created_at: Date;
  updated_at: Date;
}

export const CircleJoinRequestSchema = SchemaFactory.createForClass(CircleJoinRequest);

CircleJoinRequestSchema.index({ circle_id: 1, status: 1, created_at: -1 });
CircleJoinRequestSchema.index({ decided_by: 1, quick_decision: 1 });
// Une seule demande en attente par voyageur et par cercle
CircleJoinRequestSchema.index(
  { circle_id: 1, user_id: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_request' },
);
