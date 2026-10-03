import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TripSchedule, TripScheduleDocument } from './schemas/trip-schedule.schema';
import { tripEndDate } from '../journal/journal-utils';
import { GLOBAL_DB_CONNECTION } from '../common/constants';

/** Marge après le dernier jour avant la clôture auto (couvre tous les fuseaux horaires) */
export const AUTO_COMPLETE_DELAY_MS = 30 * 3600 * 1000;

@Injectable()
export class TripScheduleService {
  private readonly logger = new Logger(TripScheduleService.name);

  constructor(
    @InjectModel(TripSchedule.name, GLOBAL_DB_CONNECTION)
    private readonly scheduleModel: Model<TripScheduleDocument>,
  ) {}

  /** Enregistre (ou met à jour) la fin d'un voyage daté. Ne lève jamais d'erreur. */
  async register(userId: string, trip: any): Promise<void> {
    try {
      const end = tripEndDate(trip);
      if (!end || !trip?.id) {
        await this.scheduleModel.deleteOne({ trip_id: trip?.id }).exec();
        return;
      }
      await this.scheduleModel
        .updateOne(
          { trip_id: trip.id },
          {
            $set: {
              user_id: userId,
              destination: trip.destination || '',
              end_date: end,
              // Voyage déjà terminé à la main : rien à faire
              ...(trip.completed_at ? { processed_at: new Date(trip.completed_at) } : {}),
            },
            ...(trip.completed_at ? {} : { $setOnInsert: { processed_at: null } }),
          },
          { upsert: true },
        )
        .exec();
    } catch (err: any) {
      this.logger.warn(`Fin du voyage ${trip?.id} non enregistrée : ${err.message}`);
    }
  }

  /** Dates modifiées : le voyage sera de nouveau clôturé automatiquement à sa nouvelle fin. */
  async reset(userId: string, trip: any): Promise<void> {
    await this.scheduleModel.updateOne({ trip_id: trip.id }, { $set: { processed_at: null } }).exec().catch(() => undefined);
    await this.register(userId, trip);
  }

  /** Voyages existants (créés avant le registre) : rattrapage silencieux à l'ouverture de la liste. */
  syncUser(userId: string, trips: any[]): void {
    const dated = trips.filter((t) => !t.completed_at && tripEndDate(t));
    if (!dated.length) return;
    (async () => {
      const known = new Set(
        (await this.scheduleModel.find({ trip_id: { $in: dated.map((t) => t.id) } }).select('trip_id').lean().exec()).map(
          (s: any) => s.trip_id,
        ),
      );
      for (const t of dated) {
        if (!known.has(t.id)) await this.register(userId, t);
      }
    })().catch((err) => this.logger.warn(`Rattrapage des fins de voyage de ${userId} : ${err.message}`));
  }

  /** Voyages dont la fin est passée et pas encore clôturés. */
  due(limit = 200) {
    return this.scheduleModel
      .find({ processed_at: null, end_date: { $lte: new Date(Date.now() - AUTO_COMPLETE_DELAY_MS) } })
      .sort({ end_date: 1 })
      .limit(limit)
      .lean()
      .exec();
  }

  markProcessed(tripId: string) {
    return this.scheduleModel.updateOne({ trip_id: tripId }, { $set: { processed_at: new Date() } }).exec();
  }

  remove(tripId: string) {
    return this.scheduleModel.deleteOne({ trip_id: tripId }).exec();
  }
}
