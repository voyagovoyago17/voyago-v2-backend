import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CommunityCircleDocument = CommunityCircle & Document;

@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class CommunityCircle {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, index: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ default: '🧭' })
  avatar_emoji: string;

  @Prop({ default: '' })
  cover_image_url: string;

  @Prop({ default: 'general', index: true })
  category: string; // 'culture', 'nature', 'roadtrip', 'food', 'relax', 'adventure', 'solo', 'general'

  @Prop({ default: null })
  destination_city: string;

  @Prop({ default: null })
  destination_country: string;

  @Prop({ required: true, index: true })
  creator_id: string;

  @Prop({ default: 1 })
  members_count: number;

  @Prop({ default: 0 })
  trips_count: number;

  @Prop({ default: 0 })
  posts_count: number;

  @Prop({ default: true })
  is_public: boolean;

  /** Code d'invitation des cercles privés (seul moyen de les rejoindre) */
  @Prop({ type: String, required: false })
  invite_code?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop()
  created_at: Date;

  @Prop()
  updated_at: Date;
}

export const CommunityCircleSchema = SchemaFactory.createForClass(CommunityCircle);

// Unicité des codes d'invitation, en ignorant les cercles qui n'en ont pas
CommunityCircleSchema.index(
  { invite_code: 1 },
  { unique: true, partialFilterExpression: { invite_code: { $type: 'string' } } },
);
