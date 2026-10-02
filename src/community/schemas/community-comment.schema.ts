import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const COMMENT_TARGET_TYPES = ['trip', 'post'] as const;
export type CommentTargetType = (typeof COMMENT_TARGET_TYPES)[number];

export type CommunityCommentDocument = CommunityComment & Document;

/** Commentaire sur un voyage partagé ou un post de cercle (une réponse = parent_id). */
@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class CommunityComment {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ type: String, required: true, enum: COMMENT_TARGET_TYPES })
  target_type: CommentTargetType;

  @Prop({ required: true })
  target_id: string;

  @Prop({ required: true, index: true })
  user_id: string;

  @Prop({ required: true })
  content: string;

  /** Commentaire auquel on répond (un seul niveau de réponses) */
  @Prop({ type: String, default: null, index: true })
  parent_id: string | null;

  @Prop()
  created_at: Date;

  @Prop()
  updated_at: Date;
}

export const CommunityCommentSchema = SchemaFactory.createForClass(CommunityComment);
CommunityCommentSchema.index({ target_type: 1, target_id: 1, created_at: 1 });
