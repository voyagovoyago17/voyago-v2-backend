import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TripScheduleService } from '../trips/trip-schedule.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TripDocument, TripSchema } from '../trips/schemas/trip.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Trip } from '../trips/schemas/trip.schema';
import { TENANT_DB_CONNECTION } from '../common/constants';

const RUN_EVERY_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90 * 1000;
/** Voyages terminés depuis plus longtemps : rangés dans le journal sans notification (rattrapage) */
const NOTIFY_WITHIN_MS = 7 * 24 * 3600 * 1000;

/**
 * Clôture automatique : chaque heure, les voyages dont le dernier jour est passé
 * rejoignent le journal et le voyageur est prévenu (in-app + push).
 */
@Injectable()
export class TripAutoCompleteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripAutoCompleteService.name);
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly tripSchedule: TripScheduleService,
    private readonly tenancyService: TenancyService,
    private readonly notificationsService: NotificationsService,
    @InjectModel(Trip.name, TENANT_DB_CONNECTION) private readonly sharedTripModel: Model<TripDocument>,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.firstRun = setTimeout(() => this.run(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => this.run(), RUN_EVERY_MS);
  }

  onModuleDestroy() {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let completed = 0;
    try {
      const due = await this.tripSchedule.due();
      for (const entry of due) {
        try {
          if (await this.completeTrip(entry)) completed++;
          await this.tripSchedule.markProcessed(entry.trip_id);
        } catch (err: any) {
          this.logger.warn(`Clôture auto du voyage ${entry.trip_id} : ${err.message}`);
        }
      }
      if (completed) this.logger.log(`${completed} voyage(s) terminé(s) rangé(s) dans le journal`);
    } catch (err: any) {
      this.logger.warn(`Clôture automatique des voyages : ${err.message}`);
    } finally {
      this.running = false;
    }
    return completed;
  }

  private async completeTrip(entry: any): Promise<boolean> {
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(entry.user_id, 'Trip', TripSchema);
    const now = new Date();
    // Conditionnel : un voyage déjà terminé (à la main) ou supprimé n'est pas touché
    const res = await TripModel.updateOne(
      { id: entry.trip_id, user_id: entry.user_id, completed_at: null },
      { $set: { completed_at: now } },
    ).exec();
    if (res.modifiedCount === 0) return false;
    this.sharedTripModel.updateOne({ id: entry.trip_id }, { $set: { completed_at: now } }).exec().catch(() => undefined);

    const recent = now.getTime() - new Date(entry.end_date).getTime() <= NOTIFY_WITHIN_MS;
    if (recent) {
      this.notificationsService.notifySafely(entry.user_id, {
        type: 'system',
        title: `🎉 Bon retour ! Ton voyage à ${entry.destination} est terminé`,
        body: 'Ton journal de voyage est prêt : tes lieux, tes avis, tes photos… et ta story à partager.',
        data: { trip_id: entry.trip_id, journal: true, auto_completed: true },
        dedupe_key: `journal_ready:${entry.trip_id}`,
      });
    }
    return true;
  }
}
