import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TripDocument = Trip & Document;

export class POI {
  name: string;
  description: string;
  lat: number;
  lng: number;
  day: number;
  order: number;
  duration_minutes: number;
  category: string;
  image_query: string;
  image_url: string | null;
  rating?: number;
  reviews_count?: number;
  insider_tip?: string | null;
  /** Pépite secrète peu connue des touristes (comptée dans le journal) */
  hidden_gem?: boolean;
}

export class DayWeather {
  date: string;
  weather_code: number;
  temp_max: number;
  temp_min: number;
  icon: string;
  summary: string;
}

@Schema({ collection: 'trips' })
export class Trip {
  @Prop({ required: true })
  id: string;

  @Prop({ default: 'default' })
  tenant_id: string;

  @Prop({ required: true })
  user_id: string;

  @Prop({ required: true })
  destination: string;

  @Prop({ required: true })
  duration_days: number;

  @Prop({ required: true })
  pace: string;

  @Prop({ type: [String], default: [] })
  transports: string[];

  @Prop({ required: true })
  budget: string;

  @Prop({ type: [String], default: [] })
  interests: string[];

  @Prop({ type: [Object], default: [] })
  pois: POI[];

  @Prop({ type: [Object], default: [] })
  weather: DayWeather[];

  @Prop({ required: false })
  city?: string;

  @Prop({ required: false })
  country?: string;

  @Prop({ required: false })
  cover_image_url?: string;

  @Prop({ required: false })
  country_code?: string;

  @Prop({ required: false })
  start_date?: string;

  @Prop({ required: false })
  end_date?: string;

  /** Toujours égal à `visibility === 'public'` (le fil public filtre dessus) */
  @Prop({ default: false })
  is_public: boolean;

  /** private | tribe | public — absent sur les anciens voyages (déduit de is_public) */
  @Prop({ type: String, enum: ['private', 'tribe', 'public'], required: false })
  visibility?: 'private' | 'tribe' | 'public';

  @Prop({ default: 0 })
  likes: number;

  @Prop({ type: [String], default: [] })
  liked_by: string[];

  /** Commentaires de la communauté (tenu à jour sur la copie partagée) */
  @Prop({ default: 0 })
  comments_count: number;

  /** Pépites à collectionner pendant le voyage (radar) : lieux secrets hors itinéraire */
  @Prop({ type: [Object], default: [] })
  gems: any[];

  /** Pépites générées a posteriori (voyage créé avant le radar) : une seule tentative */
  @Prop({ type: Date, default: null })
  gems_backfilled_at?: Date | null;

  /** Début du radar pour un voyage sans dates (« Démarrer mon voyage ») */
  @Prop({ type: Date, default: null })
  gems_started_at?: Date | null;

  /** Nombre de voyageurs ayant refait ce voyage (copie partagée) */
  @Prop({ default: 0 })
  remix_count: number;

  /** Voyage d'origine quand celui-ci a été créé via « Refaire ce voyage » */
  @Prop({ type: Object, default: null })
  remixed_from?: { trip_id: string; user_id: string; destination?: string } | null;

  @Prop({ default: Date.now })
  created_at: Date;

  /** Voyage terminé manuellement : il quitte la carte pour le journal */
  @Prop({ type: Date, default: null })
  completed_at?: Date | null;

  /** Budget annoncé (facultatif) et devise */
  @Prop({ type: Number, default: null })
  budget_amount?: number | null;

  @Prop({ type: String, default: null })
  currency?: string | null;

  /** Qui part : composition du groupe (adultes, âges des enfants) */
  @Prop({ type: Object, default: null })
  travelers?: { party: string; adults: number; children_ages: number[] } | null;

  /** « Et maintenant ? » : idées de prochain voyage (générées une fois, à la fin du voyage) */
  @Prop({ type: Object, default: null })
  next_suggestions?: Record<string, any> | null;

  /** Valise : liste à préparer (générée par l'IA, cochée par le voyageur) */
  @Prop({ type: Object, default: null })
  packing_list?: Record<string, any> | null;

  /** Journal partagé à la communauté (XP attribuée une seule fois) */
  @Prop({ type: Date, default: null })
  journal_shared_at?: Date | null;
}

export const TripSchema = SchemaFactory.createForClass(Trip);

// Explicit Indexes
TripSchema.index({ id: 1 }, { unique: true });
TripSchema.index({ tenant_id: 1 });
TripSchema.index({ user_id: 1 });
TripSchema.index({ user_id: 1, tenant_id: 1 });
TripSchema.index({ is_public: 1, created_at: -1 });
TripSchema.index({ tenant_id: 1, is_public: 1, created_at: -1 });
TripSchema.index({ visibility: 1, user_id: 1, created_at: -1 });
TripSchema.index({ destination: 1 });
TripSchema.index({ city: 1 });
TripSchema.index({ country: 1 });
