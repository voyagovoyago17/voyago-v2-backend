import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CommunityPostDocument = CommunityPost & Document;

@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class CommunityPost {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ required: true, index: true })
  circle_id: string;

  @Prop({ required: true, index: true })
  user_id: string;

  @Prop({ required: true })
  content: string;

  @Prop({ default: null, index: true })
  trip_id: string;

  @Prop({ default: null })
  poi_title: string;

  @Prop({ default: null })
  poi_city: string;

  @Prop({ default: null })
  poi_country: string;

  @Prop({ type: [String], default: [] })
  image_urls: string[];

  @Prop({ default: 0 })
  likes_count: number;

  @Prop({ type: [String], default: [] })
  liked_by: string[];

  @Prop({ default: 0 })
  comments_count: number;

  @Prop()
  created_at: Date;

  @Prop()
  updated_at: Date;
}

export const CommunityPostSchema = SchemaFactory.createForClass(CommunityPost);
// Fil d'actualité : posts des cercles de l'utilisateur, du plus récent au plus ancien
CommunityPostSchema.index({ circle_id: 1, created_at: -1 });
