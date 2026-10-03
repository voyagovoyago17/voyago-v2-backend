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

  /** Clôture automatique déjà traitée (journal + notification) */
  @Prop({ type: Date, default: null })
  processed_at: Date | null;
}

export const TripScheduleSchema = SchemaFactory.createForClass(TripSchedule);
TripScheduleSchema.index({ processed_at: 1, end_date: 1 });
