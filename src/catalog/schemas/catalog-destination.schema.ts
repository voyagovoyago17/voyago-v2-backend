import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CatalogDestinationDocument = CatalogDestination & Document;

/**
 * Fiche partagée d'une destination pour un mois, un standing et une devise :
 * pass touristique, transport local, budget repas, astuces. Générée une fois, réutilisée par tous.
 */
@Schema({ collection: 'catalog_destinations', timestamps: true })
export class CatalogDestination {
  /** « rome|11|moyen|EUR » */
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  destination: string;

  @Prop({ default: 0 })
  month: number;

  @Prop({ default: 'moyen' })
  level: string;

  @Prop({ default: 'EUR' })
  currency: string;

  @Prop({ type: Object, default: null })
  local_transport: { name: string; price_per_day: number; tip?: string } | null;

  @Prop({ type: Number, default: null })
  meals_per_person_per_day: number | null;

  @Prop({ type: Object, default: null })
  city_pass: { name: string; price_adult: number; price_child?: number; covers: string[]; tip?: string } | null;

  @Prop({ type: [String], default: [] })
  money_tips: string[];

  @Prop({ type: Date, default: Date.now })
  priced_at: Date;

  @Prop({ default: false })
  locked: boolean;

  @Prop({ default: false })
  needs_refresh: boolean;
}

export const CatalogDestinationSchema = SchemaFactory.createForClass(CatalogDestination);
