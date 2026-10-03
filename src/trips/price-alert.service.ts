import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenancyService } from '../tenancy/tenancy.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { TripDocument, TripSchema } from './schemas/trip.schema';
import { PriceWatch, PriceWatchDocument } from './schemas/price-watch.schema';
import { TravelpayoutsService } from './travelpayouts.service';

/** Vérification des prix toutes les 3 h (le cache Aviasales se renouvelle au fil des recherches) */
const CHECK_EVERY_MS = 3 * 3600_000;
const FIRST_CHECK_DELAY_MS = 5 * 60_000;
/** On ne revérifie pas une alerte vue il y a moins de 2 h 30 */
const MIN_RECHECK_MS = 150 * 60_000;
/** Une baisse compte si elle dépasse 8 % ET 10 (devise) par personne */
const DROP_RATIO = 0.92;
const DROP_MIN_ABS = 10;
/** Alertes traitées par passage, pour rester loin des limites de l'API */
const MAX_PER_RUN = 300;

/**
 * Alerte prix : le voyageur active le suivi du vol de son voyage ; toutes les 3 h on relit le meilleur
 * prix aller-retour et on le prévient (in-app + push) quand il baisse vraiment.
 */
@Injectable()
export class PriceAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceAlertService.name);
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly tenancyService: TenancyService,
    private readonly travelpayouts: TravelpayoutsService,
    private readonly notificationsService: NotificationsService,
    @InjectModel(PriceWatch.name, GLOBAL_DB_CONNECTION) private readonly watchModel: Model<PriceWatchDocument>,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.firstRun = setTimeout(() => this.run(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => this.run(), CHECK_EVERY_MS);
  }

  onModuleDestroy() {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------------------
  // Côté voyageur
  // ---------------------------------------------------------------------------

  async status(userId: string, tripId: string) {
    const watch: any = await this.watchModel.findOne({ user_id: userId, trip_id: tripId }).lean().exec();
    return this.toDto(watch);
  }

  async enable(userId: string, tripId: string) {
    if (!this.travelpayouts.enabled) throw new BadRequestException('Alerte prix indisponible pour le moment');
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId })
      .select('id destination city duration_days start_date currency travelers')
      .lean()
      .exec();
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    const departure = trip.start_date ? String(trip.start_date).slice(0, 10) : null;
    if (!departure) throw new BadRequestException('Ajoute les dates du voyage pour suivre le prix du vol');
    if (departure <= new Date().toISOString().slice(0, 10)) throw new BadRequestException('Ce voyage a déjà commencé');

    const user: any = await this.userModel.findOne({ user_id: userId }).select('city country').lean().exec();
    const home = user?.city || user?.country;
    if (!home) throw new BadRequestException('Renseigne ta ville dans ton profil pour suivre le prix des vols');
    const where = trip.city || trip.destination;
    const [origin, destination] = await Promise.all([this.travelpayouts.cityCode(home), this.travelpayouts.cityCode(where)]);
    if (!origin || !destination || origin.code === destination.code) {
      throw new BadRequestException('Aucun vol à suivre pour ce trajet');
    }

    const days = Math.max(1, trip.duration_days || 1);
    const back = new Date(`${departure}T00:00:00Z`);
    back.setUTCDate(back.getUTCDate() + days - 1);
    const returnDate = back.toISOString().slice(0, 10);
    const currency = trip.currency || 'EUR';
    const price = await this.travelpayouts.bestPrice(origin.code, destination.code, departure, returnDate, currency);

    const watch = await this.watchModel
      .findOneAndUpdate(
        { user_id: userId, trip_id: tripId },
        {
          $set: {
            label: `${home} → ${where}`,
            origin: origin.code,
            destination: destination.code,
            departure,
            return_date: returnDate,
            currency,
            adults: Math.max(1, trip.travelers?.adults ?? 1),
            children_ages: trip.travelers?.children_ages ?? [],
            baseline_price: price,
            last_price: price,
            lowest_price: price,
            last_notified_price: price,
            checked_at: new Date(),
            enabled: true,
          },
        },
        { upsert: true, new: true },
      )
      .lean()
      .exec();
    return this.toDto(watch);
  }

  async disable(userId: string, tripId: string) {
    await this.watchModel.updateOne({ user_id: userId, trip_id: tripId }, { $set: { enabled: false } }).exec();
    return this.status(userId, tripId);
  }

  private toDto(watch: any) {
    if (!watch) return { enabled: false, last_price: null, lowest_price: null, baseline_price: null, checked_at: null };
    return {
      enabled: !!watch.enabled,
      label: watch.label,
      currency: watch.currency,
      baseline_price: watch.baseline_price ?? null,
      last_price: watch.last_price ?? null,
      lowest_price: watch.lowest_price ?? null,
      checked_at: watch.checked_at ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Vérification périodique
  // ---------------------------------------------------------------------------

  async run(): Promise<number> {
    if (this.running || !this.travelpayouts.enabled) return 0;
    this.running = true;
    let notified = 0;
    try {
      const today = new Date().toISOString().slice(0, 10);
      // Voyages partis : l'alerte n'a plus d'objet
      await this.watchModel.updateMany({ enabled: true, departure: { $lte: today } }, { $set: { enabled: false } }).exec();

      const watches = await this.watchModel
        .find({ enabled: true, $or: [{ checked_at: null }, { checked_at: { $lt: new Date(Date.now() - MIN_RECHECK_MS) } }] })
        .sort({ checked_at: 1 })
        .limit(MAX_PER_RUN)
        .lean()
        .exec();

      for (const w of watches as any[]) {
        try {
          if (await this.check(w)) notified++;
        } catch (err: any) {
          this.logger.warn(`Alerte prix ${w.trip_id} : ${err.message}`);
        }
      }
      if (notified) this.logger.log(`${notified} baisse(s) de prix annoncée(s)`);
    } finally {
      this.running = false;
    }
    return notified;
  }

  private async check(w: any): Promise<boolean> {
    const price = await this.travelpayouts.bestPrice(w.origin, w.destination, w.departure, w.return_date, w.currency);
    const update: any = { checked_at: new Date() };
    if (price == null) {
      await this.watchModel.updateOne({ _id: w._id }, { $set: update }).exec();
      return false;
    }
    update.last_price = price;
    update.lowest_price = w.lowest_price == null ? price : Math.min(w.lowest_price, price);
    if (w.baseline_price == null) update.baseline_price = price;

    // Référence : le dernier prix annoncé (ou le premier relevé) — seule une vraie nouvelle baisse prévient
    const reference = w.last_notified_price ?? w.baseline_price;
    const drop = reference != null ? reference - price : 0;
    const isDrop = reference != null && price <= reference * DROP_RATIO && drop >= DROP_MIN_ABS;
    if (!isDrop) {
      // Remontée nette : la prochaine baisse se mesure depuis ce nouveau palier
      if (reference == null || price > reference) update.last_notified_price = price;
      await this.watchModel.updateOne({ _id: w._id }, { $set: update }).exec();
      return false;
    }

    update.last_notified_price = price;
    await this.watchModel.updateOne({ _id: w._id }, { $set: update }).exec();
    const passengers = Math.max(1, w.adults) + (w.children_ages || []).filter((a: number) => a >= 2).length;
    const fmt = (v: number) => `${v} ${w.currency === 'EUR' ? '€' : w.currency}`;
    this.notificationsService.notifySafely(w.user_id, {
      type: 'price_drop',
      title: `✈️ Le vol ${w.label} baisse : ${fmt(price)}/pers.`,
      body:
        passengers > 1
          ? `−${fmt(drop)} par personne, soit −${fmt(drop * passengers)} pour vous ${passengers}. Réserve avant que ça remonte !`
          : `−${fmt(drop)} depuis ta dernière alerte. Réserve avant que ça remonte !`,
      data: {
        trip_id: w.trip_id,
        price,
        drop,
        link: this.travelpayouts.routeLink(w.origin, w.destination, w.departure, w.return_date, w.adults, w.children_ages || []),
      },
      dedupe_key: `price_drop:${w.trip_id}:${price}`,
    });
    return true;
  }
}
