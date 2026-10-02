import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const REPORT_TARGET_TYPES = ['trip', 'post', 'comment'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export type CommunityReportDocument = CommunityReport & Document;

/** Signalement d'un contenu par un voyageur (un seul par contenu et par voyageur). */
@Schema({ timestamps: { createdAt: 'created_at', updatedAt: false } })
export class CommunityReport {
  @Prop({ type: String, required: true, enum: REPORT_TARGET_TYPES })
  target_type: ReportTargetType;

  @Prop({ required: true })
  target_id: string;

  @Prop({ required: true })
  reporter_id: string;

  /** Auteur du contenu signalé */
  @Prop({ type: String, default: null, index: true })
  reported_user_id: string | null;

  @Prop({ default: '' })
  reason: string;

  @Prop({ type: String, default: 'open', enum: ['open', 'reviewed'] })
  status: 'open' | 'reviewed';

  @Prop()
  created_at: Date;
}

export const CommunityReportSchema = SchemaFactory.createForClass(CommunityReport);
CommunityReportSchema.index({ target_type: 1, target_id: 1, reporter_id: 1 }, { unique: true });
CommunityReportSchema.index({ status: 1, created_at: -1 });
