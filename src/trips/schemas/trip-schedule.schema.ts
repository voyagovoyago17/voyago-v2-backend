import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TripScheduleDocument = TripSchedule & Document;

/**
 * Registre global des fins de voyage (les voyages vivent dans la base de chaque voyageur) :
 * permet de clôturer automatiquement les voyages terminés sans parcourir toutes les bases.
 */
@Schema({ collection: 'trip_schedules', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class TripSchedule {
  @Prop({ required: true, unique: true })
  trip_id: string;

  @Prop({ required: true, index: true })
  user_id: string;

  @Prop({ default: '' })
  destination: string;

  /** Dernier jour du voyage (minuit UTC) */
  @Prop({ type: Date, required: true })
  end_date: Date;

  /** Premier jour du voyage (minuit UTC) : rappel de la veille et récap du soir */
  @Prop({ type: Date, default: null })
  start_date: Date | null;

  /** Rappel « départ demain » déjà envoyé */
  @Prop({ type: Date, default: null })
  departure_notified_at: Date | null;

  /** Dernier récap du soir envoyé (AAAA-MM-JJ) */
  @Prop({ type: String, default: null })
  last_recap_on: string | null;

  /** Clôture automatique déjà traitée (journal + notification) */
  @Prop({ type: Date, default: null })
  processed_at: Date | null;
}

export const TripScheduleSchema = SchemaFactory.createForClass(TripSchedule);
TripScheduleSchema.index({ processed_at: 1, end_date: 1 });
TripScheduleSchema.index({ departure_notified_at: 1, start_date: 1 });
