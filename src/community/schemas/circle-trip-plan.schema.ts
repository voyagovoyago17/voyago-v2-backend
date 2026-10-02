import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CircleTripPlanDocument = CircleTripPlan & Document;

/**
 * Voyage de tribu : l'IA propose des lieux, les membres du cercle votent (swipe),
 * puis l'itinéraire final garde les lieux préférés de la tribu.
 */
@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class CircleTripPlan {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ required: true, index: true })
  circle_id: string;

  @Prop({ required: true })
  created_by: string;

  @Prop({ required: true })
  destination: string;

  @Prop()
  city?: string;

  @Prop()
  country?: string;

  @Prop()
  country_code?: string;

  @Prop()
  cover_image_url?: string;

  @Prop({ required: true, min: 1, max: 14 })
  duration_days: number;

  @Prop()
  start_date?: string;

  @Prop({ default: 'equilibre' })
  pace: string;

  @Prop({ default: 'moyen' })
  budget: string;

  @Prop({ type: [String], default: [] })
  transports: string[];

  @Prop({ type: [String], default: [] })
  interests: string[];

  /** Empreinte destination + paramètres : réutilise les lieux déjà générés (sans appel IA) */
  @Prop({ index: true })
  candidates_key?: string;

  /** Lieux proposés au vote ; chacun porte une clé stable `key` */
  @Prop({ type: [Object], default: [] })
  candidates: any[];

  @Prop({ type: String, enum: ['voting', 'finalized'], default: 'voting', index: true })
  status: 'voting' | 'finalized';

  /** Itinéraire retenu après le vote */
  @Prop({ type: [Object], default: [] })
  final_pois: any[];

  @Prop({ type: Date, default: null })
  finalized_at?: Date | null;

  /** Membres ayant ajouté le voyage de tribu à leurs voyages */
  @Prop({ type: [String], default: [] })
  joined_by: string[];

  @Prop()
  created_at: Date;

  @Prop()
  updated_at: Date;
}

export const CircleTripPlanSchema = SchemaFactory.createForClass(CircleTripPlan);
CircleTripPlanSchema.index({ circle_id: 1, created_at: -1 });
