import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TripSchedule, TripScheduleDocument } from './schemas/trip-schedule.schema';
import { tripEndDate } from '../journal/journal-utils';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { AiService } from '../ai/ai.service';

/** Marge après le dernier jour avant la clôture auto (couvre tous les fuseaux horaires) */
export const AUTO_COMPLETE_DELAY_MS = 30 * 3600 * 1000;

@Injectable()
export class TripScheduleService {
  private readonly logger = new Logger(TripScheduleService.name);

  constructor(
    @InjectModel(TripSchedule.name, GLOBAL_DB_CONNECTION)
    private readonly scheduleModel: Model<TripScheduleDocument>,
    private readonly aiService: AiService,
  ) {}

  /** Décalage horaire de la destination, d'après le premier lieu du voyage. */
  private async destinationOffset(trip: any): Promise<number | null> {
    const poi = (trip?.pois || []).find((p: any) => p.lat && p.lng);
    if (!poi) return null;
    return this.aiService.fetchUtcOffsetMinutes(Number(poi.lat), Number(poi.lng));
  }

  /** Enregistre (ou met à jour) la fin d'un voyage daté. Ne lève jamais d'erreur. */
  async register(userId: string, trip: any): Promise<void> {
    try {
      const end = tripEndDate(trip);
      if (!end || !trip?.id) {
        await this.scheduleModel.deleteOne({ trip_id: trip?.id }).exec();
        return;
      }
      const existing: any = await this.scheduleModel.findOne({ trip_id: trip.id }).select('dest_utc_offset_minutes').lean().exec();
      const destOffset =
        existing?.dest_utc_offset_minutes ?? (await this.destinationOffset(trip).catch(() => null));
      await this.scheduleModel
        .updateOne(
          { trip_id: trip.id },
          {
            $set: {
              user_id: userId,
              dest_utc_offset_minutes: destOffset,
              destination: trip.destination || '',
              end_date: end,
              start_date: trip.start_date ? new Date(`${String(trip.start_date).slice(0, 10)}T00:00:00Z`) : null,
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

  /** Voyage annulé (redevenu une idée sans dates) : plus de rappel ni de clôture automatique. */
  async unregister(tripId: string): Promise<void> {
    await this.scheduleModel.deleteOne({ trip_id: tripId }).exec().catch(() => undefined);
  }

  /** Dates modifiées : le voyage sera de nouveau clôturé automatiquement à sa nouvelle fin. */
  async reset(userId: string, trip: any): Promise<void> {
    await this.scheduleModel
      .updateOne({ trip_id: trip.id }, { $set: { processed_at: null, departure_notified_at: null, last_recap_on: null } })
      .exec()
      .catch(() => undefined);
    await this.register(userId, trip);
  }

  /** Voyages existants (créés avant le registre) : rattrapage silencieux à l'ouverture de la liste. */
  syncUser(userId: string, trips: any[]): void {
    const dated = trips.filter((t) => !t.completed_at && tripEndDate(t));
    if (!dated.length) return;
    (async () => {
      // Déjà connus et à jour (date de début enregistrée) : rien à faire
      const known = new Set(
        (
          await this.scheduleModel
            .find({
              trip_id: { $in: dated.map((t) => t.id) },
              $or: [{ start_date: { $ne: null }, dest_utc_offset_minutes: { $ne: null } }, { processed_at: { $ne: null } }],
            })
            .select('trip_id')
            .lean()
            .exec()
        ).map((s: any) => s.trip_id),
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

  /** Départ demain (ou dans les prochaines heures) : rappel pas encore envoyé. */
  departuresDue(limit = 200) {
    const now = Date.now();
    return this.scheduleModel
      .find({
        processed_at: null,
        departure_notified_at: null,
        start_date: { $gt: new Date(now - 36 * 3600 * 1000), $lte: new Date(now + 48 * 3600 * 1000) },
      })
      .limit(limit)
      .lean()
      .exec();
  }

  /** Voyages en cours aujourd'hui (UTC) dont le récap du soir n'a pas été envoyé. */
  /** Voyages en cours (à ±1 jour près, selon le fuseau de la destination). */
  ongoing(limit = 500) {
    const now = Date.now();
    return this.scheduleModel
      .find({
        processed_at: null,
        start_date: { $lte: new Date(now + 24 * 3600 * 1000) },
        end_date: { $gte: new Date(now - 48 * 3600 * 1000) },
      })
      .limit(limit)
      .lean()
      .exec();
  }

  markDepartureNotified(tripId: string) {
    return this.scheduleModel.updateOne({ trip_id: tripId }, { $set: { departure_notified_at: new Date() } }).exec();
  }

  markRecapSent(tripId: string, today: string) {
    return this.scheduleModel.updateOne({ trip_id: tripId }, { $set: { last_recap_on: today } }).exec();
  }

  markProcessed(tripId: string) {
    return this.scheduleModel.updateOne({ trip_id: tripId }, { $set: { processed_at: new Date() } }).exec();
  }

  remove(tripId: string) {
    return this.scheduleModel.deleteOne({ trip_id: tripId }).exec();
  }
}
