import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DeviceTokenDocument = DeviceToken & Document;

export const DEVICE_PLATFORMS = ['android', 'ios', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** Jeton FCM d'un appareil : une ligne par appareil, rattachée au dernier compte connecté dessus. */
@Schema({ collection: 'device_tokens', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class DeviceToken {
  @Prop({ required: true, unique: true })
  token: string;

  @Prop({ required: true, index: true })
  user_id: string;

  @Prop({ type: String, enum: DEVICE_PLATFORMS, default: 'android' })
  platform: DevicePlatform;

  @Prop({ type: String })
  app_version?: string;

  @Prop({ type: Date, default: () => new Date() })
  last_seen_at: Date;

  created_at: Date;
  updated_at: Date;
}

export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken);

DeviceTokenSchema.index({ user_id: 1, last_seen_at: -1 });
