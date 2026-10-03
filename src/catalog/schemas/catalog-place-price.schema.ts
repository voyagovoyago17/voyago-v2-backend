import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CatalogPlacePriceDocument = CatalogPlacePrice & Document;

/** Prix d'entrée d'un lieu, partagé par tous les voyageurs, avec date, saison et historique */
@Schema({ collection: 'catalog_place_prices', timestamps: true })
export class CatalogPlacePrice {
  /** « rome|colisee » (destination et lieu normalisés) */
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  destination: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: 'EUR' })
  currency: string;

  /** 0 : entrée gratuite (mémorisée pour ne pas redemander) */
  @Prop({ default: 0 })
  price_adult: number;

  @Prop({ default: 0 })
  price_child: number;

  /** Tarif de haute saison et ses mois (1-12), si le lieu en a un */
  @Prop({ type: Number, default: null })
  peak_price_adult: number | null;

  @Prop({ type: [Number], default: [] })
  peak_months: number[];

  @Prop({ type: String, default: null })
  advice: string | null;

  /** Date du relevé (IA, voyageurs ou admin) */
  @Prop({ type: Date, default: Date.now })
  priced_at: Date;

  /** ia | voyageurs | admin */
  @Prop({ default: 'ia' })
  source: string;

  /** Prix corrigé par un admin : l'IA ne l'écrase plus */
  @Prop({ default: false })
  locked: boolean;

  /** Signalé ou écart constaté : à rafraîchir au prochain passage */
  @Prop({ default: false })
  needs_refresh: boolean;

  @Prop({ type: [Object], default: [] })
  reports: { per_adult: number; at: Date; user_id?: string; kind: 'paid' | 'flag' }[];

  @Prop({ type: [Object], default: [] })
  history: { price_adult: number; price_child: number; at: Date; source: string }[];
}

export const CatalogPlacePriceSchema = SchemaFactory.createForClass(CatalogPlacePrice);
CatalogPlacePriceSchema.index({ destination: 1 });
