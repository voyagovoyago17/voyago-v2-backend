import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NotificationDocument = Notification & Document;

export const NOTIFICATION_TYPES = ['arrival', 'trip_ready', 'review_thanks', 'system', 'comment', 'trip_remixed', 'tribe_trip', 'circle_request'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

@Schema({ collection: 'notifications', timestamps: { createdAt: 'created_at', updatedAt: false } })
export class Notification {
  @Prop({ required: true, unique: true })
  id: string;

  @Prop({ required: true, index: true })
  user_id: string;

  @Prop({ type: String, required: true, enum: NOTIFICATION_TYPES })
  type: NotificationType;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  body: string;

  /** Données contextuelles (trip_id, place_key, place_name, lat, lng, day...) */
  @Prop({ type: Object, default: {} })
  data: Record<string, any>;

  @Prop({ default: false })
  read: boolean;

  /** Clé d'idempotence : empêche les doublons (ex : une seule arrivée par lieu et par voyage) */
  @Prop({ type: String })
  dedupe_key?: string;

  created_at: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ user_id: 1, created_at: -1 });
NotificationSchema.index({ user_id: 1, read: 1 });
// Unicité seulement pour les notifications qui ont une clé d'idempotence.
// (« sparse » ne suffit pas sur un index composé : user_id présent => dedupe_key null indexé,
// ce qui bloquait toute 2e notification sans clé pour un même utilisateur.)
export const DEDUPE_INDEX_NAME = 'user_id_dedupe_key_unique';
NotificationSchema.index(
  { user_id: 1, dedupe_key: 1 },
  { name: DEDUPE_INDEX_NAME, unique: true, partialFilterExpression: { dedupe_key: { $type: 'string' } } },
);
