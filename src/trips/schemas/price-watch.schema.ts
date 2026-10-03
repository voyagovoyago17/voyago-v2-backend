import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PriceWatchDocument = PriceWatch & Document;

/** Alerte prix sur le vol aller-retour d'un voyage (Aviasales via Travelpayouts) */
@Schema({ collection: 'price_watches', timestamps: true })
export class PriceWatch {
  @Prop({ required: true, index: true })
  user_id: string;

  @Prop({ required: true })
  trip_id: string;

  /** Libellé affiché : « Paris → Rome » */
  @Prop({ required: true })
  label: string;

  @Prop({ required: true })
  origin: string;

  @Prop({ required: true })
  destination: string;

  @Prop({ required: true })
  departure: string;

  @Prop({ type: String, default: null })
  return_date: string | null;

  @Prop({ default: 'EUR' })
  currency: string;

  @Prop({ default: 1 })
  adults: number;

  @Prop({ type: [Number], default: [] })
  children_ages: number[];

  /** Prix par adulte au moment où l'alerte a été activée */
  @Prop({ type: Number, default: null })
  baseline_price: number | null;

  @Prop({ type: Number, default: null })
  last_price: number | null;

  @Prop({ type: Number, default: null })
  lowest_price: number | null;

  /** Dernier prix annoncé au voyageur : on ne prévient que d'une vraie nouvelle baisse */
  @Prop({ type: Number, default: null })
  last_notified_price: number | null;

  @Prop({ type: Date, default: null })
  checked_at: Date | null;

  @Prop({ default: true, index: true })
  enabled: boolean;
}

export const PriceWatchSchema = SchemaFactory.createForClass(PriceWatch);
PriceWatchSchema.index({ user_id: 1, trip_id: 1 }, { unique: true });
