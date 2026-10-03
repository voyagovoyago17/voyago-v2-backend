import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TripScheduleService } from '../trips/trip-schedule.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TripDocument, TripSchema } from '../trips/schemas/trip.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Trip } from '../trips/schemas/trip.schema';
import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';
import { User, UserDocument } from '../auth/schemas/user.schema';

/** Heure « murale » locale : un Date dont les champs UTC donnent l'heure locale. */
function localClock(offsetMinutes: number, at = Date.now()): Date {
  return new Date(at + offsetMinutes * 60000);
}

const RUN_EVERY_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90 * 1000;
/** Voyages terminés depuis plus longtemps : rangés dans le journal sans notification (rattrapage) */
const NOTIFY_WITHIN_MS = 7 * 24 * 3600 * 1000;
/** Récap du soir : à partir de 19 h, heure de la destination */
const RECAP_LOCAL_HOUR = 19;
/** Rappel de départ : la veille à partir de 18 h, heure du voyageur */
const DEPARTURE_LOCAL_HOUR = 18;
/** Fuseau par défaut si inconnu (UTC+1 : Europe de l'Ouest / Afrique centrale) */
const DEFAULT_OFFSET_MIN = 60;
const DAY_MS = 24 * 3600 * 1000;

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
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
  ) {}

  /** Fuseau du voyageur (téléphone), sinon celui de la destination. */
  private async homeOffset(entry: any): Promise<number> {
    const user: any = await this.userModel.findOne({ user_id: entry.user_id }).select('utc_offset_minutes').lean().exec();
    return user?.utc_offset_minutes ?? entry.dest_utc_offset_minutes ?? DEFAULT_OFFSET_MIN;
  }

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
      await this.sendDepartureReminders();
      await this.sendEveningRecaps();
    } catch (err: any) {
      this.logger.warn(`Clôture automatique des voyages : ${err.message}`);
    } finally {
      this.running = false;
    }
    return completed;
  }

  private async loadTrip(entry: any): Promise<any> {
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(entry.user_id, 'Trip', TripSchema);
    return TripModel.findOne({ id: entry.trip_id, user_id: entry.user_id })
      .select('id destination duration_days start_date weather pois gems packing_list completed_at')
      .lean()
      .exec();
  }

  /** Veille du départ : compte à rebours, météo du premier jour et dernier check de la valise. */
  private async sendDepartureReminders() {
    const due = await this.tripSchedule.departuresDue();
    for (const entry of due) {
      try {
        // start_date = minuit (UTC) du jour J : on compare à l'heure murale du voyageur
        const local = localClock(await this.homeOffset(entry)).getTime();
        const start = new Date(entry.start_date).getTime();
        const sendFrom = start - DAY_MS + DEPARTURE_LOCAL_HOUR * 3600 * 1000;
        if (local < sendFrom) continue; // trop tôt : on attend la veille au soir
        const stale = local > start + 12 * 3600 * 1000; // départ déjà passé : on n'insiste pas
        const trip: any = stale ? null : await this.loadTrip(entry);
        if (trip && !trip.completed_at) {
          const w = (trip.weather || [])[0];
          const weather = w ? ` Météo du jour 1 : ${Math.round(w.temp_max)}°C${w.summary ? `, ${String(w.summary).toLowerCase()}` : ''}.` : '';
          const items = (trip.packing_list?.categories || []).flatMap((c: any) => c.items || []);
          const left = items.filter((i: any) => !i.packed).length;
          const packing = items.length
            ? left
              ? ` Il reste ${left} objet${left > 1 ? 's' : ''} à mettre dans ta valise 🧳`
              : ' Ta valise est prête 🧳'
            : ' Fais le dernier check de ta valise 🧳';
          const sameDay = local >= start;
          this.notificationsService.notifySafely(entry.user_id, {
            type: 'system',
            title: sameDay ? `✈️ C'est le grand jour : direction ${entry.destination} !` : `✈️ Départ demain pour ${entry.destination} !`,
            body: `${weather}${packing}`.trim(),
            data: { trip_id: entry.trip_id, packing: true, destination: entry.destination },
            dedupe_key: `departure:${entry.trip_id}:${String(trip.start_date).slice(0, 10)}`,
          });
        }
        await this.tripSchedule.markDepartureNotified(entry.trip_id);
      } catch (err: any) {
        this.logger.warn(`Rappel de départ ${entry.trip_id} : ${err.message}`);
      }
    }
  }

  /** Pendant le voyage : récap du soir avec le programme du lendemain et les pépites à proximité. */
  private async sendEveningRecaps() {
    const ongoing = await this.tripSchedule.ongoing();
    for (const entry of ongoing) {
      try {
        if (!entry.start_date) continue;
        const local = localClock(entry.dest_utc_offset_minutes ?? DEFAULT_OFFSET_MIN);
        if (local.getUTCHours() < RECAP_LOCAL_HOUR) continue;
        const today = local.toISOString().slice(0, 10);
        const todayMs = new Date(`${today}T00:00:00Z`).getTime();
        // Jour local hors du voyage, ou récap déjà envoyé ce soir
        if (todayMs < new Date(entry.start_date).getTime() || todayMs > new Date(entry.end_date).getTime()) continue;
        if (entry.last_recap_on === today) continue;

        const trip: any = await this.loadTrip(entry);
        if (trip && !trip.completed_at) {
          const dayIndex = Math.floor((todayMs - new Date(entry.start_date).getTime()) / DAY_MS) + 1;
          const tomorrow = dayIndex + 1;
          const last = dayIndex >= (trip.duration_days || 1);
          const nextPois = (trip.pois || [])
            .filter((p: any) => p.day === tomorrow)
            .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
          const gemsLeft = (trip.gems || []).filter((g: any) => !g.collected_at && g.day === tomorrow).length;
          const w = (trip.weather || [])[tomorrow - 1];
          const weather = w ? ` ${Math.round(w.temp_max)}°C${w.summary ? `, ${String(w.summary).toLowerCase()}` : ''}.` : '';
          const body = last
            ? "Dernière soirée ! Demain, ton journal de voyage t'attendra avec tous tes souvenirs 📖"
            : nextPois.length
              ? `Demain : ${nextPois.length} étape${nextPois.length > 1 ? 's' : ''}, à commencer par ${nextPois[0].name}.${weather}${gemsLeft ? ` 💎 ${gemsLeft} pépite${gemsLeft > 1 ? 's' : ''} à dénicher en chemin.` : ''}`
              : `Demain, journée libre : laisse-toi surprendre !${weather}`;
          this.notificationsService.notifySafely(entry.user_id, {
            type: 'system',
            title: last ? `🌙 Dernière soirée à ${entry.destination}` : `🌙 Jour ${dayIndex} terminé à ${entry.destination}`,
            body,
            data: { trip_id: entry.trip_id, recap: true, day: tomorrow },
            dedupe_key: `recap:${entry.trip_id}:${today}`,
          });
        }
        await this.tripSchedule.markRecapSent(entry.trip_id, today);
      } catch (err: any) {
        this.logger.warn(`Récap du soir ${entry.trip_id} : ${err.message}`);
      }
    }
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
        body: 'Ton bilan de voyage est prêt : lieux, pépites, photos, ta story à partager… et 3 idées pour la suite ✨',
        data: { trip_id: entry.trip_id, journal: true, auto_completed: true },
        dedupe_key: `journal_ready:${entry.trip_id}`,
      });
    }
    return true;
  }
}
