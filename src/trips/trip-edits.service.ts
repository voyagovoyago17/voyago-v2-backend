import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenancyService } from '../tenancy/tenancy.service';
import { AiService } from '../ai/ai.service';
import { PlaceGroundingService, kmBetween, placeNorm } from '../ai/place-grounding.service';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { ProfileSchema } from '../gamification/schemas/profile.schema';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { isProActive } from '../pro/pro-status';
import { TripDocument, TripSchema } from './schemas/trip.schema';
import { GenerateTripDto } from './dto/generate-trip.dto';
import { TripsService } from './trips.service';
import { TripScheduleService } from './trip-schedule.service';
import { TripBookingsService } from './trip-bookings.service';

export type EditPlan = 'free' | 'monthly' | 'annual' | 'lifetime';

/**
 * Modifications d'un voyage programmé, par formule :
 * - remplacer un lieu (parmi des lieux réels vérifiés, sans IA) : 2 par voyage en gratuit, illimité en Pro ;
 * - refaire une journée / tout refaire (IA) : compteur commun 2 (Mensuel) / 4 (Annuel) / 6 (À vie) par voyage,
 *   1 essai offert en gratuit sur un seul voyage ; crédits en plus via XP ou pack.
 */
export const EDIT_LIMITS: Record<EditPlan, { swaps: number; redos: number }> = {
  free: { swaps: 2, redos: 0 },
  monthly: { swaps: Infinity, redos: 2 },
  annual: { swaps: Infinity, redos: 4 },
  lifetime: { swaps: Infinity, redos: 6 },
};
/** Un crédit de modification en échange d'XP (le niveau n'est pas touché) */
export const XP_PER_CREDIT = 50;
/** Pack de crédits payant pour un voyage */
export const EDIT_PACK = { credits: 3, price: 0.99, currency: 'eur' };

type RedoSource = 'plan' | 'extra' | 'trial' | null;

const RAINY = (code: number) => (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

@Injectable()
export class TripEditsService {
  private readonly logger = new Logger(TripEditsService.name);

  constructor(
    private readonly tenancyService: TenancyService,
    private readonly aiService: AiService,
    private readonly grounding: PlaceGroundingService,
    private readonly tripsService: TripsService,
    private readonly tripSchedule: TripScheduleService,
    private readonly tripBookings: TripBookingsService,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
  ) {}

  private tripModel(userId: string) {
    return this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
  }

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  planOf(user: any): EditPlan {
    if (!isProActive(user)) return 'free';
    return (['monthly', 'annual', 'lifetime'] as EditPlan[]).includes(user.pro_tier) ? user.pro_tier : 'monthly';
  }

  private async load(userId: string, tripId: string) {
    const [TripModel, user] = await Promise.all([this.tripModel(userId), this.userModel.findOne({ user_id: userId }).lean().exec()]);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId }).lean().exec();
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    return { TripModel, trip, user: user as any };
  }

  /** État du voyage : commencé ? passé ? jour courant */
  private stage(trip: any) {
    const start = trip.start_date ? String(trip.start_date).slice(0, 10) : null;
    const days = Math.max(1, trip.duration_days || 1);
    const end = start ? new Date(Date.parse(`${start}T00:00:00Z`) + (days - 1) * 86400000).toISOString().slice(0, 10) : null;
    const today = this.today();
    const started = !!start && start <= today;
    const finished = !!trip.completed_at || (!!end && end < today);
    const currentDay = started && !finished ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1 : 0;
    return { start, end, started, finished, currentDay };
  }

  private dayDate(trip: any, day: number): string | undefined {
    if (!trip.start_date) return undefined;
    return new Date(Date.parse(`${String(trip.start_date).slice(0, 10)}T00:00:00Z`) + (day - 1) * 86400000).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------------------
  // Droits et compteurs
  // ---------------------------------------------------------------------------

  async options(userId: string, tripId: string) {
    const { trip, user } = await this.load(userId, tripId);
    return this.optionsFor(trip, user, await this.xpBalance(userId));
  }

  /** XP disponibles pour des crédits : gagnés − déjà dépensés */
  private async xpBalance(userId: string): Promise<number | null> {
    try {
      const ProfileModel = await this.tenancyService.getTenantModel<any>(userId, 'Profile', ProfileSchema);
      const p: any = await ProfileModel.findOne({ user_id: userId }).select('xp xp_spent').lean().exec();
      return p ? Math.max(0, (p.xp ?? 0) - (p.xp_spent ?? 0)) : 0;
    } catch {
      return null;
    }
  }

  private optionsFor(trip: any, user: any, xpBalance: number | null = null) {
    const plan = this.planOf(user);
    const limits = EDIT_LIMITS[plan];
    const edits = trip.edits || {};
    const st = this.stage(trip);
    const extra = edits.extra_credits ?? 0;
    const freeTrial = plan === 'free' && !user?.free_redo_used;
    const redoLimit = limits.redos + extra + (freeTrial ? 1 : 0);
    return {
      plan,
      started: st.started,
      finished: st.finished,
      current_day: st.currentDay,
      can_cancel: !st.started && !st.finished && !!trip.start_date,
      can_shift_dates: !st.started && !st.finished,
      date_changes: { used: edits.date_changes ?? 0, limit: plan === 'free' ? 1 : null },
      swaps: { used: edits.swaps ?? 0, limit: Number.isFinite(limits.swaps) ? limits.swaps : null },
      redos: {
        used: edits.redos ?? 0,
        limit: redoLimit,
        remaining: Math.max(0, limits.redos - (edits.redos ?? 0)) + extra + (freeTrial ? 1 : 0),
        extra_credits: extra,
        free_trial: freeTrial,
      },
      can_regenerate: !st.started && !st.finished,
      can_edit_places: !trip.tribe_plan?.founder_id || trip.tribe_plan.founder_id === user?.user_id,
      plan_b_days: edits.plan_b_days ?? [],
      xp_per_credit: XP_PER_CREDIT,
      xp_balance: xpBalance,
      pack: EDIT_PACK,
      plans: Object.fromEntries(
        Object.entries(EDIT_LIMITS).map(([k, v]) => [k, { swaps: Number.isFinite(v.swaps) ? v.swaps : null, redos: v.redos }]),
      ),
    };
  }

  /** Voyage de tribu : seul le fondateur du vote peut changer l'itinéraire */
  private assertCanEditPlaces(trip: any, userId: string) {
    const founder = trip.tribe_plan?.founder_id;
    if (founder && founder !== userId) {
      throw new ForbiddenException('Cet itinéraire a été voté par ta tribu : seul son fondateur peut le modifier.');
    }
  }

  private quotaError(action: 'swap' | 'redo', plan: EditPlan, message: string) {
    return new HttpException(
      { statusCode: 402, code: 'EDIT_QUOTA', action, plan, message, error: 'Payment Required' },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  /** Consomme une modification IA : quota de la formule, puis crédits en plus, puis essai gratuit */
  private async consumeRedo(TripModel: Model<TripDocument>, trip: any, user: any): Promise<RedoSource> {
    const plan = this.planOf(user);
    const used = trip.edits?.redos ?? 0;
    const extra = trip.edits?.extra_credits ?? 0;
    const base = EDIT_LIMITS[plan].redos;
    if (used < base) {
      await TripModel.updateOne({ id: trip.id }, { $inc: { 'edits.redos': 1 } }).exec();
      return 'plan';
    }
    if (extra > 0) {
      await TripModel.updateOne({ id: trip.id }, { $inc: { 'edits.redos': 1, 'edits.extra_credits': -1 } }).exec();
      return 'extra';
    }
    if (plan === 'free' && !user?.free_redo_used) {
      await this.userModel.updateOne({ user_id: user.user_id }, { $set: { free_redo_used: true } }).exec();
      await TripModel.updateOne({ id: trip.id }, { $inc: { 'edits.redos': 1 } }).exec();
      return 'trial';
    }
    throw this.quotaError(
      'redo',
      plan,
      plan === 'free'
        ? 'Refaire une journée ou tout le voyage est réservé aux membres Pro (ton essai offert est utilisé).'
        : `Tu as utilisé tes ${base} modifications pour ce voyage. Ajoute des crédits (XP ou pack) ou passe à une formule supérieure.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Remplacer un lieu (lieux réels, sans IA)
  // ---------------------------------------------------------------------------

  private scopeOf(trip: any) {
    const pts = (trip.pois || []).filter((p: any) => isFinite(p.lat) && isFinite(p.lng) && p.lat !== 0);
    const center = pts.length
      ? { lat: pts.reduce((s: number, p: any) => s + p.lat, 0) / pts.length, lng: pts.reduce((s: number, p: any) => s + p.lng, 0) / pts.length }
      : { lat: 0, lng: 0 };
    return { destination: trip.city || trip.destination, center, countryCode: trip.country_code || null, isCountry: false };
  }

  async alternatives(userId: string, tripId: string, day: number, order: number) {
    if (!Number.isInteger(day) || !Number.isInteger(order)) throw new BadRequestException('Jour ou lieu invalide');
    const { trip } = await this.load(userId, tripId);
    const poi = (trip.pois || []).find((p: any) => p.day === day && p.order === order);
    if (!poi) throw new NotFoundException('Lieu introuvable dans ce voyage');
    const places = await this.grounding.candidates(this.scopeOf(trip));
    const picks = this.grounding.replacements(
      places,
      (trip.pois || []).map((p: any) => p.name),
      { lat: poi.lat, lng: poi.lng },
      order === 2,
      8,
    );
    const items = await Promise.all(
      picks.map(async (p) => ({
        name: p.name,
        kind: p.kind || null,
        distance_km: Math.round(kmBetween(p, poi) * 10) / 10,
        image_url: await this.grounding.imageFor(p).catch(() => null),
      })),
    );
    return { day, order, current: poi.name, items };
  }

  async swap(userId: string, tripId: string, body: { day: number; order: number; name: string }) {
    const { TripModel, trip, user } = await this.load(userId, tripId);
    const st = this.stage(trip);
    if (st.finished) throw new BadRequestException('Ce voyage est terminé.');
    if (st.started && body.day < st.currentDay) throw new BadRequestException('Cette journée est déjà passée.');
    this.assertCanEditPlaces(trip, userId);
    const plan = this.planOf(user);
    const limit = EDIT_LIMITS[plan].swaps;
    if ((trip.edits?.swaps ?? 0) >= limit) {
      throw this.quotaError('swap', plan, `Tu as remplacé ${limit} lieux sur ce voyage. Passe Pro pour en remplacer autant que tu veux.`);
    }
    const idx = (trip.pois || []).findIndex((p: any) => p.day === body.day && p.order === body.order);
    if (idx < 0) throw new NotFoundException('Lieu introuvable dans ce voyage');
    const old = trip.pois[idx];
    // Seul un lieu réel de la liste vérifiée est accepté (aucune saisie libre, rien d'inventé)
    const places = await this.grounding.candidates(this.scopeOf(trip));
    const pick = places.find((p) => placeNorm(p.name) === placeNorm(body.name));
    if (!pick) throw new BadRequestException('Ce lieu ne fait pas partie des lieux vérifiés proposés.');
    const extracts = pick.wiki ? await this.grounding.extracts([pick.wiki]) : new Map<string, string>();
    const next = {
      ...old,
      name: pick.name,
      lat: pick.lat,
      lng: pick.lng,
      image_query: pick.name,
      image_url: await this.grounding.imageFor(pick).catch(() => null),
      description:
        (pick.wiki && extracts.get(`${pick.wiki.lang}:${pick.wiki.title}`)) ||
        `${pick.kind && pick.kind !== 'lieu' ? `${pick.kind[0].toUpperCase()}${pick.kind.slice(1)} ` : 'Lieu '}référencé sur la carte : vérifie les horaires avant d'y aller.`,
      insider_tip: '',
      hidden_gem: false,
      verified: true,
      source: pick.source,
      wiki: pick.wiki || null,
      rating: undefined,
      reviews_count: undefined,
    };
    const pois = [...trip.pois];
    pois[idx] = next;
    await TripModel.updateOne({ id: tripId }, { $set: { pois }, $inc: { 'edits.swaps': 1 } }).exec();
    this.logger.log(`Voyage ${tripId} : « ${old.name} » remplacé par « ${pick.name} »`);
    return this.result(userId, tripId);
  }

  // ---------------------------------------------------------------------------
  // Refaire une journée / tout refaire (IA, avec vérification des lieux)
  // ---------------------------------------------------------------------------

  private async dtoOf(trip: any, user: any, overrides: Partial<GenerateTripDto> = {}): Promise<GenerateTripDto> {
    return {
      destination: trip.destination,
      city: trip.city,
      country: trip.country,
      duration_days: trip.duration_days,
      pace: trip.pace,
      transports: trip.transports || [],
      budget: trip.budget,
      interests: trip.interests || [],
      start_date: trip.start_date || undefined,
      thermal_sensitivity: user?.thermal_sensitivity || 'balanced',
      ...(trip.budget_amount ? { budget_amount: trip.budget_amount, currency: trip.currency || 'EUR' } : {}),
      ...(trip.travelers
        ? { travel_party: trip.travelers.party, adults: trip.travelers.adults, children_ages: trip.travelers.children_ages || [] }
        : {}),
      ...overrides,
    } as GenerateTripDto;
  }

  async redoDay(userId: string, tripId: string, day: number, opts: { planB?: boolean } = {}) {
    const { TripModel, trip, user } = await this.load(userId, tripId);
    const st = this.stage(trip);
    if (st.finished) throw new BadRequestException('Ce voyage est terminé.');
    if (!Number.isInteger(day) || day < 1 || day > (trip.duration_days || 1)) throw new BadRequestException('Jour invalide');
    if (st.started && day < st.currentDay) throw new BadRequestException('Cette journée est déjà passée.');
    this.assertCanEditPlaces(trip, userId);
    const plan = this.planOf(user);

    if (opts.planB) {
      // Plan B pluie : avantage Pro, une fois par journée, sans entamer le quota
      if (plan === 'free') {
        throw this.quotaError('redo', plan, 'Le plan B pluie est un avantage Pro : un nouveau programme à l’abri en un geste.');
      }
      if ((trip.edits?.plan_b_days ?? []).includes(day)) throw new BadRequestException('Le plan B de cette journée est déjà appliqué.');
    }
    const source: RedoSource = opts.planB ? null : await this.consumeRedo(TripModel, trip, user);

    const avoid = (trip.pois || []).filter((p: any) => p.day !== day).map((p: any) => p.name);
    const dto = await this.dtoOf(trip, user, { start_date: this.dayDate(trip, day) });
    let pois: any[];
    try {
      pois = await this.aiService.generateDayPois(dto, { day, avoid, indoor: !!opts.planB });
    } catch (err: any) {
      await this.refundRedo(TripModel, trip, user, source);
      throw new BadRequestException('La journée n’a pas pu être refaite pour le moment, réessaie dans un instant.');
    }
    if (!pois.length) {
      await this.refundRedo(TripModel, trip, user, source);
      throw new BadRequestException('Aucun lieu vérifié trouvé pour cette journée, réessaie plus tard.');
    }
    const kept = (trip.pois || []).filter((p: any) => p.day !== day);
    const next = [...kept, ...pois.map((p) => ({ ...p, day }))].sort((a, b) => a.day - b.day || a.order - b.order);
    const gems = (trip.gems || []).filter((g: any) => g.day !== day || g.collected_at);
    await TripModel.updateOne(
      { id: tripId },
      { $set: { pois: next, gems }, ...(opts.planB ? { $addToSet: { 'edits.plan_b_days': day } } : {}) },
    ).exec();
    this.logger.log(`Voyage ${tripId} : jour ${day} refait${opts.planB ? ' (plan B pluie)' : ''}`);
    return this.result(userId, tripId);
  }

  /** Échec de génération : la modification est rendue (quota, crédit ou essai offert) */
  private async refundRedo(TripModel: Model<TripDocument>, trip: any, user: any, source: RedoSource) {
    if (!source) return;
    const inc: Record<string, number> = { 'edits.redos': -1, ...(source === 'extra' ? { 'edits.extra_credits': 1 } : {}) };
    await TripModel.updateOne({ id: trip.id }, { $inc: inc }).exec().catch(() => undefined);
    if (source === 'trial') {
      await this.userModel.updateOne({ user_id: user.user_id }, { $set: { free_redo_used: false } }).exec().catch(() => undefined);
    }
  }

  /** Tout refaire avant le départ : rythme, budget, centres d'intérêt, déplacements ou durée */
  async regenerate(
    userId: string,
    tripId: string,
    changes: { pace?: string; budget?: string; interests?: string[]; transports?: string[]; duration_days?: number },
  ) {
    const { TripModel, trip, user } = await this.load(userId, tripId);
    const st = this.stage(trip);
    if (st.started || st.finished) throw new BadRequestException('Ce voyage a déjà commencé : refais plutôt une journée.');
    this.assertCanEditPlaces(trip, userId);
    const overrides: Partial<GenerateTripDto> = {};
    if (changes.pace) overrides.pace = changes.pace;
    if (changes.budget) overrides.budget = changes.budget;
    if (changes.interests?.length) overrides.interests = changes.interests.slice(0, 10);
    if (changes.transports?.length) overrides.transports = changes.transports.slice(0, 6);
    if (changes.duration_days) overrides.duration_days = Math.min(30, Math.max(1, Math.round(changes.duration_days)));
    const days = overrides.duration_days ?? trip.duration_days;
    if (trip.start_date && days !== trip.duration_days) await this.tripsService.assertNoOverlap(userId, trip.start_date, days, tripId);

    const source = await this.consumeRedo(TripModel, trip, user);
    const dto = await this.dtoOf(trip, user, overrides);
    let content: Awaited<ReturnType<TripsService['generatePlaces']>>;
    try {
      content = await this.tripsService.generatePlaces(dto, { withWeather: !!trip.start_date });
    } catch {
      await this.refundRedo(TripModel, trip, user, source);
      throw new BadRequestException('Le voyage n’a pas pu être refait pour le moment, réessaie dans un instant.');
    }
    const end =
      trip.start_date && days
        ? new Date(Date.parse(`${String(trip.start_date).slice(0, 10)}T00:00:00Z`) + (days - 1) * 86400000).toISOString().slice(0, 10)
        : trip.end_date || null;
    await TripModel.updateOne(
      { id: tripId },
      {
        $set: {
          pois: content.pois,
          gems: content.gems,
          ...(content.weather?.length ? { weather: content.weather } : {}),
          duration_days: days,
          pace: dto.pace,
          budget: dto.budget,
          interests: dto.interests,
          transports: dto.transports,
          end_date: end,
          // Les estimations de Réservations & Budget se recalculent ; les réservations restent
          bookings_plan: null,
        },
      },
    ).exec();
    const updated: any = await TripModel.findOne({ id: tripId }).lean().exec();
    if (updated?.start_date) await this.tripSchedule.reset(userId, updated);
    this.tripBookings.warmUp(userId, tripId);
    return this.result(userId, tripId);
  }

  // ---------------------------------------------------------------------------
  // Crédits en plus : XP et pack payant
  // ---------------------------------------------------------------------------

  async creditWithXp(userId: string, tripId: string) {
    const { TripModel, trip } = await this.load(userId, tripId);
    if (this.stage(trip).finished) throw new BadRequestException('Ce voyage est terminé.');
    const ProfileModel = await this.tenancyService.getTenantModel<any>(userId, 'Profile', ProfileSchema);
    // Solde = XP gagnés − XP dépensés : le niveau, calculé sur les XP gagnés, ne baisse jamais
    const res = await ProfileModel.updateOne(
      { user_id: userId, $expr: { $gte: [{ $subtract: ['$xp', { $ifNull: ['$xp_spent', 0] }] }, XP_PER_CREDIT] } },
      { $inc: { xp_spent: XP_PER_CREDIT } },
    ).exec();
    if (res.modifiedCount === 0) {
      throw new BadRequestException(`Il te faut ${XP_PER_CREDIT} XP disponibles pour débloquer une modification.`);
    }
    await TripModel.updateOne({ id: tripId }, { $inc: { 'edits.extra_credits': 1 } }).exec();
    return this.result(userId, tripId);
  }

  /** Pack payé (Stripe) : crédits ajoutés au voyage */
  async addPackCredits(userId: string, tripId: string, credits = EDIT_PACK.credits) {
    const TripModel = await this.tripModel(userId);
    await TripModel.updateOne({ id: tripId, user_id: userId }, { $inc: { 'edits.extra_credits': credits } }).exec();
  }

  // ---------------------------------------------------------------------------
  // Plan B pluie : la veille, prévision de pluie pour le lendemain
  // ---------------------------------------------------------------------------

  /** Pluie prévue ce jour-là sur les lieux du programme ? (Open-Meteo) */
  async rainForecast(trip: any, day: number): Promise<{ rainy: boolean; summary?: string }> {
    const dayPois = (trip.pois || []).filter((p: any) => p.day === day && p.lat && p.lng);
    const date = this.dayDate(trip, day);
    if (!dayPois.length || !date) return { rainy: false };
    const list = await this.aiService.fetchWeather(dayPois[0].lat, dayPois[0].lng, 1, date).catch(() => []);
    const w: any = list?.[0];
    return w && RAINY(Number(w.weather_code)) ? { rainy: true, summary: w.summary } : { rainy: false };
  }

  private async result(userId: string, tripId: string) {
    const { trip, user } = await this.load(userId, tripId);
    return { trip, options: this.optionsFor(trip, user, await this.xpBalance(userId)) };
  }
}
