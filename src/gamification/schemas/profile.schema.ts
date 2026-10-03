import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProfileDocument = Profile & Document;

@Schema({ collection: 'profiles' })
export class Profile {
  @Prop({ required: true })
  user_id: string;

  @Prop({ default: 'default' })
  tenant_id: string;

  @Prop({ default: 0 })
  xp: number;

  /** Éclats (pépites ramassées) échangés contre des modifications : jamais retirés des XP */
  @Prop({ default: 0 })
  gem_points_spent: number;

  @Prop({ default: 1 })
  level: number;

  @Prop({ default: 0 })
  streak: number;

  @Prop({ type: [String], default: [] })
  badges: string[];

  @Prop({ default: 0 })
  trips_count: number;

  @Prop({ default: Date.now })
  last_active: Date;
}

export const ProfileSchema = SchemaFactory.createForClass(Profile);

// Explicit Indexes
ProfileSchema.index({ user_id: 1 }, { unique: true });
ProfileSchema.index({ tenant_id: 1 });
ProfileSchema.index({ user_id: 1, tenant_id: 1 });
ProfileSchema.index({ xp: -1 });
ProfileSchema.index({ level: -1 });
