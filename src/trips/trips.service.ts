import {
  Injectable,
  NotFoundException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { TripScheduleService } from './trip-schedule.service';
import { TripBookingsService } from './trip-bookings.service';
import { PriceAlertService } from './price-alert.service';
import { nameSimilarity } from '../ai/place-grounding.service';
import { UpdateTripDatesDto } from './dto/update-trip-dates.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import { DayWeather, Trip, TripDocument, TripSchema } from './schemas/trip.schema';
import { ProfileSchema } from '../gamification/schemas/profile.schema';
import { UserXpActionSchema } from '../gamification/schemas/user-xp-action.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { GenerateTripDto } from './dto/generate-trip.dto';
import { AiService } from '../ai/ai.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';
import { CommunityMember, CommunityMemberDocument } from '../community/schemas/community-member.schema';
import { UserBlock, UserBlockDocument } from '../community/schemas/user-block.schema';
import { isBlockedBetween } from '../community/blocks';
import { GamificationService } from '../gamification/gamification.service';
import { isProActive } from '../pro/pro-status';
import { TripGem } from '../ai/ai.service';

/** Voyages créés par mois avec la formule gratuite */
export const FREE_TRIPS_PER_MONTH = 2;
import {
  TripVisibility,
  canViewTrip,
  sharesCircle,
  tripVisibility,
  visibilityFields,
} from './trip-visibility';

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    // Static TENANT_DB connection — used for community feed (public trips mirror)
    @InjectModel(Trip.name, TENANT_DB_CONNECTION) private readonly sharedTripModel: Model<TripDocument>,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    @InjectModel(CommunityMember.name, TENANT_DB_CONNECTION) private readonly memberModel: Model<CommunityMemberDocument>,
    @InjectModel(UserBlock.name, TENANT_DB_CONNECTION) private readonly blockModel: Model<UserBlockDocument>,
    private readonly gamificationService: GamificationService,
    private readonly aiService: AiService,
    private readonly tenancyService: TenancyService,
    private readonly notificationsService: NotificationsService,
    private readonly tripSchedule: TripScheduleService,
    private readonly tripBookings: TripBookingsService,
    private readonly priceAlerts: PriceAlertService,
  ) {}

  /**
   * Attend au plus `budgetMs` qu'une tâche d'enrichissement se termine.
   * Au-delà, la réponse part sans attendre : la tâche continue en arrière-plan
   * et persiste son résultat, qui sera servi au prochain chargement.
   */
  private async withinBudget(task: Promise<unknown>, budgetMs = 1500): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    });
    await Promise.race([task.catch(() => {}), timeout]);
    clearTimeout(timer);
  }

  /** Voyages programmés (datés, ni terminés ni passés) : leurs jours sont bloqués dans le calendrier. */
  async busyDates(userId: string, excludeTripId?: string) {
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
    const trips: any[] = await TripModel.find({ user_id: userId, start_date: { $nin: [null, ''] }, completed_at: null })
      .select('id destination city start_date end_date duration_days')
      .lean()
      .exec();
    const today = new Date().toISOString().slice(0, 10);
    return trips
      .map((t) => ({
        trip_id: t.id,
        destination: t.city || String(t.destination).split(',')[0],
        start: String(t.start_date).slice(0, 10),
        end: (t.end_date ? String(t.end_date) : this.endDateFrom(t.start_date, t.duration_days) || String(t.start_date)).slice(0, 10),
      }))
      .filter((t) => t.trip_id !== excludeTripId && t.end >= today)
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  /**
   * Un voyage ne peut pas chevaucher un autre voyage programmé. Le jour de transition est permis
   * (un voyage peut commencer le jour où le précédent se termine : Rome → Naples).
   */
  async assertNoOverlap(userId: string, start: string | undefined, durationDays: number, excludeTripId?: string) {
    if (!start || !/^\d{4}-\d{2}-\d{2}/.test(start)) return;
    const s0 = start.slice(0, 10);
    const e0 = this.endDateFrom(s0, durationDays)!;
    const fr = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    for (const t of await this.busyDates(userId, excludeTripId)) {
      const overlaps = (s0 < t.end && t.start < e0) || s0 === t.start;
      if (overlaps) {
        throw new HttpException(
          {
            statusCode: 409,
            code: 'TRIP_DATES_OVERLAP',
            message: `Ces dates chevauchent ton voyage à ${t.destination} (${fr(t.start)} → ${fr(t.end)}). Choisis d'autres dates ou décale ce voyage.`,
            trip_id: t.trip_id,
            error: 'Conflict',
          },
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  /**
   * Annuler un voyage programmé (gratuit pour tous) : il devient une idée sans dates, gardée dans
   * « Mes idées » avec son itinéraire et son budget, prête à être reprogrammée.
   */
  async cancelTrip(userId: string, tripId: string) {
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId }).lean().exec();
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    if (trip.completed_at) throw new BadRequestException('Ce voyage est déjà terminé : il est rangé dans ton journal.');
    const today = new Date().toISOString().slice(0, 10);
    if (trip.start_date && String(trip.start_date).slice(0, 10) <= today) {
      throw new BadRequestException('Ce voyage a déjà commencé : tu peux encore remplacer un lieu ou refaire une journée.');
    }
    const set = {
      start_date: null,
      end_date: null,
      cancelled_at: new Date(),
      cancelled_dates: trip.start_date ? { start: trip.start_date, end: trip.end_date || null } : null,
    };
    await TripModel.updateOne({ id: tripId, user_id: userId }, { $set: set }).exec();
    this.sharedTripModel.updateOne({ id: tripId }, { $set: { start_date: null, end_date: null } }).exec().catch(() => undefined);
    await this.tripSchedule.unregister(tripId);
    await this.priceAlerts.disable(userId, tripId).catch(() => undefined);
    return TripModel.findOne({ id: tripId }).lean().exec();
  }

  /** Dernier jour (AAAA-MM-JJ) d'un voyage de `days` jours commençant le `start`. */
  private endDateFrom(start?: string, days?: number): string | undefined {
    if (!start || !/^\d{4}-\d{2}-\d{2}/.test(start)) return undefined;
    const end = new Date(`${start.slice(0, 10)}T00:00:00Z`);
    if (isNaN(end.getTime())) return undefined;
    end.setUTCDate(end.getUTCDate() + Math.max((days || 1) - 1, 0));
    return end.toISOString().slice(0, 10);
  }

  /**
   * Ajoute ou change les dates d'un voyage : fin recalculée, météo rafraîchie,
   * clôture automatique reprogrammée (un voyage terminé redaté dans le futur revient sur la carte).
   */
  async updateDates(userId: string, tripId: string, dto: UpdateTripDatesDto) {
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId }).lean().exec();
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);

    const start = dto.start_date.slice(0, 10);
    if (isNaN(new Date(`${start}T00:00:00Z`).getTime())) {
      throw new BadRequestException('Date de début invalide');
    }
    const today = new Date().toISOString().slice(0, 10);
    const hadDates = !!trip.start_date;
    if (hadDates && !trip.completed_at) {
      // Voyage commencé : on ne décale plus ses dates (on peut encore remplacer un lieu ou refaire une journée)
      if (String(trip.start_date).slice(0, 10) <= today) {
        throw new BadRequestException('Ce voyage a déjà commencé : ses dates ne peuvent plus être décalées.');
      }
      if (start < today) throw new BadRequestException('Choisis une date à partir d’aujourd’hui.');
      // Formule gratuite : un seul décalage par voyage (ajouter des dates la première fois reste libre)
      const user: any = await this.userModel.findOne({ user_id: userId }).lean().exec();
      if (!isProActive(user) && (trip.edits?.date_changes ?? 0) >= 1) {
        throw new HttpException(
          {
            statusCode: 402,
            code: 'EDIT_QUOTA',
            action: 'date_change',
            message: 'Tu as déjà décalé ce voyage une fois. Passe Pro pour décaler tes voyages autant que tu veux.',
            error: 'Payment Required',
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    }
    await this.assertNoOverlap(userId, start, trip.duration_days, tripId);
    const end = this.endDateFrom(start, trip.duration_days)!;
    const set: Record<string, any> = { start_date: start, end_date: end, cancelled_at: null };

    if (trip.completed_at && end >= today) set.completed_at = null;

    // Météo des nouveaux jours (prévisions à 16 jours, sinon tendances de saison)
    const firstPoi = (trip.pois || []).find((p: any) => p.lat && p.lng);
    if (firstPoi) {
      try {
        set.weather = await this.aiService.fetchWeather(firstPoi.lat, firstPoi.lng, trip.duration_days, start);
      } catch (err: any) {
        this.logger.warn(`Météo non rafraîchie pour ${tripId}: ${err.message}`);
      }
    }

    await TripModel.updateOne(
      { id: tripId, user_id: userId },
      { $set: set, ...(hadDates && !trip.completed_at ? { $inc: { 'edits.date_changes': 1 } } : {}) },
    ).exec();
    this.sharedTripModel.updateOne({ id: tripId }, { $set: { start_date: start, end_date: end } }).exec().catch(() => undefined);
    const updated: any = await TripModel.findOne({ id: tripId }).lean().exec();
    await this.tripSchedule.reset(userId, updated);
    // Report sans perte : l'alerte prix suit les nouvelles dates
    const watch: any = await this.priceAlerts.status(userId, tripId).catch(() => null);
    if (watch?.enabled) this.priceAlerts.enable(userId, tripId).catch(() => undefined);
    // Dates connues : Réservations & Budget se prépare en arrière-plan
    this.tripBookings.warmUp(userId, tripId);
    return updated;
  }

  async getUserTrips(
    user_id: string,
    options: { viewerId?: string } = {},
  ): Promise<Trip[]> {
    // Read from the user's own tenant database
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(
      user_id,
      'Trip',
      TripSchema,
    );

    let trips = await TripModel.find({ user_id }).sort({ created_at: -1 }).exec();
    // Voyages datés créés avant le registre des fins : clôture automatique programmée
    if (options.viewerId === user_id) this.tripSchedule.syncUser(user_id, trips.map((t: any) => t.toObject?.() ?? t));

    // If no trips in tenant DB yet, check legacy shared DB
    if (!trips || trips.length === 0) {
      try {
        const legacyTrips = await this.sharedTripModel.find({ user_id }).sort({ created_at: -1 }).exec();
        if (legacyTrips && legacyTrips.length > 0) {
          this.logger.log(`Found ${legacyTrips.length} legacy trips for user ${user_id}, migrating to tenant DB...`);
          for (const lt of legacyTrips) {
            const tripData = lt.toObject ? lt.toObject() : { ...lt };
            delete tripData._id;
            delete tripData.__v;
            tripData.tenant_id = user_id;
            try {
              await TripModel.create(tripData);
            } catch (err) {
              // ignore duplicate key errors if already exists
            }
          }
          trips = await TripModel.find({ user_id }).sort({ created_at: -1 }).exec();
        }
      } catch (err) {
        this.logger.warn(`Could not check legacy trips for ${user_id}: ${err.message}`);
      }
    }

    // L'auteur voit tout ; les autres voient les voyages publics, et ceux de la tribu s'ils partagent un cercle
    if (options.viewerId !== user_id) {
      if (await isBlockedBetween(this.blockModel, options.viewerId, user_id)) {
        return [];
      }
      const isTribeMate = options.viewerId
        ? await sharesCircle(this.memberModel, options.viewerId, user_id)
        : false;
      trips = trips.filter((t) => {
        const visibility = tripVisibility(t);
        return visibility === 'public' || (visibility === 'tribe' && isTribeMate);
      });
    }

    // Assurer que chaque voyage affiche l'édifice / monument réel de son pays
    const verifiedTrips = await Promise.all(
      trips.map(async (t) => {
        const tripObj = t.toObject ? t.toObject() : t;
        const isParisBridge =
          tripObj.pois?.[0]?.image_url?.includes('photo-1499856871958-5b9627545d1a') ||
          tripObj.cover_image_url?.includes('photo-1499856871958-5b9627545d1a');
        const isNotParis = !tripObj.destination?.toLowerCase().includes('paris');
        const lacksCover = !tripObj.cover_image_url || tripObj.cover_image_url.trim() === '';

        if ((isParisBridge && isNotParis) || lacksCover) {
          // Budget de temps : la liste ne doit pas attendre l'IA pour s'afficher
          await this.withinBudget((async () => {
            const monument = await this.aiService.resolveCountryMonument(
              tripObj.destination,
              tripObj.country,
              tripObj.city,
            );
            tripObj.cover_image_url = monument.imageUrl;
            if (tripObj.pois && tripObj.pois.length > 0) {
              if (isParisBridge || !tripObj.pois[0].image_url) {
                tripObj.pois[0].image_url = monument.imageUrl;
              }
            }
            TripModel.updateOne(
              { id: tripObj.id },
              { $set: { cover_image_url: monument.imageUrl, 'pois.0.image_url': monument.imageUrl } },
            ).exec().catch(() => {});
          })());
        }
        return tripObj;
      }),
    );

    return verifiedTrips;
  }

  async getTripById(trip_id: string, user_id?: string): Promise<Trip> {
    // user_id = voyageur connecté : son propre voyage est lu dans son tenant,
    // sinon la copie partagée n'est servie que si la visibilité le permet
    let trip: any = null;
    let model: any = null;

    // If we have a user_id, look in their tenant DB first
    if (user_id) {
      const TripModel = await this.tenancyService.getTenantModel<TripDocument>(
        user_id,
        'Trip',
        TripSchema,
      );
      model = TripModel;
      trip = await TripModel.findOne({ id: trip_id }).exec();
    }

    // Fallback: look in shared DB (for community/public trips)
    if (!trip) {
      model = this.sharedTripModel;
      trip = await this.sharedTripModel.findOne({ id: trip_id }).exec();
      if (
        trip &&
        (!(await canViewTrip(this.memberModel, trip, user_id)) ||
          (await isBlockedBetween(this.blockModel, user_id, trip.user_id)))
      ) {
        trip = null;
      }
    }

    if (!trip) {
      throw new NotFoundException(`Trip ${trip_id} not found`);
    }

    const tripObj = trip.toObject ? trip.toObject() : trip;
    const isParisBridge =
      tripObj.pois?.[0]?.image_url?.includes('photo-1499856871958-5b9627545d1a') ||
      tripObj.cover_image_url?.includes('photo-1499856871958-5b9627545d1a');
    const isNotParis = !tripObj.destination?.toLowerCase().includes('paris');
    const lacksCover = !tripObj.cover_image_url || tripObj.cover_image_url.trim() === '';

    if ((isParisBridge && isNotParis) || lacksCover) {
      // Budget de temps : le détail ne doit pas attendre l'IA pour s'afficher
      await this.withinBudget((async () => {
        const monument = await this.aiService.resolveCountryMonument(
          tripObj.destination,
          tripObj.country,
          tripObj.city,
        );
        tripObj.cover_image_url = monument.imageUrl;
        if (tripObj.pois && tripObj.pois.length > 0) {
          if (isParisBridge || !tripObj.pois[0].image_url) {
            tripObj.pois[0].image_url = monument.imageUrl;
          }
        }
        if (model) {
          model.updateOne(
            { id: trip_id },
            { $set: { cover_image_url: monument.imageUrl, 'pois.0.image_url': monument.imageUrl } },
          ).exec().catch(() => {});
        }
      })());
    }

    return tripObj;
  }

  private async awardBadges(ProfileModel: Model<any>, profile: any): Promise<void> {
    const badgesToAward: string[] = [];

    if (!profile.badges.includes('first_swipe')) {
      badgesToAward.push('first_swipe');
    }

    if (profile.trips_count >= 1 && !profile.badges.includes('first_trip')) {
      badgesToAward.push('first_trip');
    }

    if (profile.trips_count >= 5 && !profile.badges.includes('globe_trotter')) {
      badgesToAward.push('globe_trotter');
    }

    if (profile.trips_count >= 10 && !profile.badges.includes('explorateur')) {
      badgesToAward.push('explorateur');
    }

    if (profile.streak >= 3 && !profile.badges.includes('en_feu')) {
      badgesToAward.push('en_feu');
    }

    if (badgesToAward.length > 0) {
      await ProfileModel.updateOne(
        { user_id: profile.user_id },
        { $addToSet: { badges: { $each: badgesToAward } } },
      ).exec();
    }
  }

  /** Formule gratuite : FREE_TRIPS_PER_MONTH voyages créés par mois (générés, refaits ou de tribu). */
  private async assertFreemiumQuota(user: UserDocument, TripModel: Model<TripDocument>): Promise<void> {
    if (!isProActive(user)) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const tripsThisMonth = await TripModel.countDocuments({
        user_id: user.user_id,
        created_at: { $gte: startOfMonth },
      }).exec();

      if (tripsThisMonth >= FREE_TRIPS_PER_MONTH) {
        throw new HttpException(
          {
            statusCode: 402,
            message: `Tu as atteint tes ${FREE_TRIPS_PER_MONTH} voyages gratuits du mois. Passe Pro pour des voyages illimités.`,
            code: 'FREE_TRIP_QUOTA',
            error: 'Payment Required',
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    }
  }

  /** XP, compteur de voyages et badges après la création d'un voyage. */
  private async rewardTripCreation(user: UserDocument, ProfileModel: Model<any>): Promise<void> {
    const profile = await ProfileModel.findOne({ user_id: user.user_id }).exec();
    if (profile) {
      const isFirst = (profile.trips_count || 0) === 0;
      const tripXp = isFirst ? 7 : 3;
      const newXp = (profile.xp || 0) + tripXp;
      const newLevel = Math.floor(newXp / 100) + 1;
      const newTripsCount = (profile.trips_count || 0) + 1;

      await ProfileModel.updateOne(
        { user_id: user.user_id },
        {
          $set: {
            xp: newXp,
            level: newLevel,
            trips_count: newTripsCount,
            last_active: new Date(),
            tenant_id: user.user_id,
          },
        },
      ).exec();

      // Enregistrer l'action dans user_xp_actions (anti-triche & cohérence de collection)
      try {
        const ActionModel = await this.tenancyService.getTenantModel<any>(
          user.user_id,
          'UserXpAction',
          UserXpActionSchema,
        );
        const actionKey = isFirst ? 'first_trip' : 'generate_trip';
        await ActionModel.findOneAndUpdate(
          { user_id: user.user_id, action: actionKey },
          {
            $set: {
              user_id: user.user_id,
              tenant_id: user.user_id,
              action: actionKey,
              xp: tripXp,
              completed: true,
              completed_at: new Date(),
            },
            $inc: { count: 1 },
          },
          { upsert: true },
        ).exec();
      } catch (err: any) {
        this.logger.warn(`Could not sync trip to user_xp_actions: ${err.message}`);
      }

      const updatedProfile = await ProfileModel.findOne({ user_id: user.user_id }).exec();
      if (updatedProfile) {
        await this.awardBadges(ProfileModel, updatedProfile);
      }
    }
  }

  /**
   * Génère les lieux d'un voyage par IA, avec leurs photos (et la météo si demandé).
   * Le premier lieu porte toujours le monument emblématique du pays.
   */
  async generatePlaces(
    dto: GenerateTripDto,
    options: { withWeather?: boolean } = {},
  ): Promise<{
    pois: any[];
    weather: DayWeather[];
    monument: { imageUrl: string };
    city: string;
    country?: string;
    gems: TripGem[];
  }> {
    const parts = dto.destination.split(',').map((s) => s.trim());
    const derivedCity = dto.city || (parts.length > 0 ? parts[0] : dto.destination);
    const derivedCountry = dto.country || (parts.length > 1 ? parts.slice(1).join(', ') : undefined);

    const [{ pois: rawPois, gems: rawGems }, monument] = await Promise.all([
      this.aiService.generatePoisAndGems(dto),
      this.aiService.resolveCountryMonument(dto.destination, derivedCountry, derivedCity),
    ]);

    const firstValidPoi = rawPois.find((p) => p.lat !== 0 && p.lng !== 0);
    const lat = firstValidPoi?.lat ?? 48.8566;
    const lng = firstValidPoi?.lng ?? 2.3522;

    const [poisWithImages, weather] = await Promise.all([
      Promise.all(
        rawPois.map(async (poi: any, idx) => {
          // Lieux vérifiés : l'image est celle du lieu lui-même, sinon aucune (jamais celle d'un autre lieu)
          if (poi.verified !== undefined) {
            if (poi.image_url) return poi;
            const isMonument = idx === 0 && nameSimilarity(poi.name, monument.monumentName) >= 0.6;
            return { ...poi, image_url: isMonument ? monument.imageUrl : null };
          }
          // Jour 1, Premier lieu : Toujours le monument / édifice emblématique résolu
          if (idx === 0) {
            return { ...poi, image_url: monument.imageUrl };
          }
          const isStaticPlaceholder =
            poi.image_url &&
            (poi.image_url.includes('photo-1499856871958-5b9627545d1a') ||
             poi.image_url.includes('photo-1550966871-3ed3cdb5ed0c') ||
             poi.image_url.includes('photo-1502602898657-3e91760cbb34') ||
             poi.image_url.includes('photo-1544816155-12df9643f363') ||
             poi.image_url.includes('photo-1514933651103-005eec06c04b') ||
             poi.image_url.includes('photo-1540555700478-4be289fbecef') ||
             poi.image_url.includes('photo-1483985988355-763728e1935b') ||
             poi.image_url.includes('photo-1486406146926-c627a92ad1ab') ||
             poi.image_url.includes('photo-1488646953014-85cb44e25828'));

          let imageUrl = poi.image_url;
          if (!imageUrl || isStaticPlaceholder) {
            const query = poi.image_query || `${poi.name} ${dto.destination}`;
            imageUrl = await this.aiService.findImage(query);
          }
          return { ...poi, image_url: imageUrl || null };
        }),
      ),
      options.withWeather
        ? this.aiService.fetchWeather(lat, lng, dto.duration_days, dto.start_date)
        : Promise.resolve([] as DayWeather[]),
    ]);

    // Photos des pépites (Wikimedia, gratuit) en parallèle, sans bloquer si une échoue
    const gems = await Promise.all(
      rawGems.map(async (g: any) => ({
        ...g,
        // Pépite vérifiée : image déjà trouvée sur place (ou aucune) ; sinon recherche, sans image générique
        image_url:
          g.verified !== undefined ? g.image_url ?? null : await this.aiService.findImage(g.image_query).catch(() => null),
      })),
    );

    return { pois: poisWithImages, weather, monument, city: derivedCity, country: derivedCountry, gems };
  }

  async generateTrip(user: UserDocument, dto: GenerateTripDto): Promise<Trip> {
    const tenantId = user.user_id; // Multi-DB: tenant = user

    // Get tenant-specific models
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(
      tenantId,
      'Trip',
      TripSchema,
    );
    const ProfileModel = await this.tenancyService.getTenantModel<any>(
      tenantId,
      'Profile',
      ProfileSchema,
    );

    await this.assertFreemiumQuota(user, TripModel);
    await this.assertNoOverlap(user.user_id, dto.start_date, dto.duration_days);

    this.logger.log(`Generating trip for user ${user.user_id} (${user.name}) in ${dto.destination} [tenant: ${tenantId}]`);

    // 1. Generate POIs with AI (Gemini or Claude with smart fallback)
    const tripDto: GenerateTripDto = {
      ...dto,
      thermal_sensitivity: dto.thermal_sensitivity || user.thermal_sensitivity || 'balanced',
    };
    // 2. Résoudre le monument ou l'édifice emblématique du pays via IA & Wikimedia.
    // Indépendant des POIs : lancé en parallèle de la génération pour ne pas
    // additionner les deux latences IA.
    const { pois: poisWithImages, weather, monument, city: derivedCity, country: derivedCountry, gems } =
      await this.generatePlaces(tripDto, { withWeather: true });

    // 3. Create trip document in user's tenant DB
    const tripId = uuidv4();
    const visibility: TripVisibility = dto.visibility ?? 'private';

    const tripData = {
      id: tripId,
      user_id: user.user_id,
      tenant_id: tenantId,
      destination: dto.destination,
      city: derivedCity,
      country: derivedCountry,
      country_code: dto.country_code,
      cover_image_url: monument.imageUrl,
      start_date: dto.start_date,
      // Fin toujours renseignée quand le début est connu (début + durée)
      end_date: dto.end_date || this.endDateFrom(dto.start_date, dto.duration_days),
      duration_days: dto.duration_days,
      pace: dto.pace,
      transports: dto.transports,
      budget: dto.budget,
      budget_amount: dto.budget_amount ?? null,
      currency: dto.budget_amount ? dto.currency || 'EUR' : null,
      travelers: dto.travel_party
        ? { party: dto.travel_party, adults: dto.adults ?? 1, children_ages: dto.children_ages ?? [] }
        : null,
      interests: dto.interests,
      pois: poisWithImages,
      weather,
      gems,
      ...visibilityFields(visibility),
      likes: 0,
      created_at: new Date(),
    };

    const trip = await TripModel.create(tripData);
    this.tripSchedule.register(user.user_id, tripData);

    // 4. Mirror to shared DB for community feed (public & tribe trips only)
    if (visibility !== 'private') {
      try {
        await this.sharedTripModel.create(tripData);
      } catch (err) {
        this.logger.warn(`Failed to mirror trip to shared DB (non-blocking): ${err.message}`);
      }
    }

    // 5. Update profile in user's tenant DB: award XP, increment trips_count, check badges
    await this.rewardTripCreation(user, ProfileModel);

    this.notificationsService.notifySafely(user.user_id, {
      type: 'trip_ready',
      title: `Ton itinéraire pour ${dto.destination} est prêt ✈️`,
      body: `${dto.duration_days} jour(s), ${poisWithImages.length} lieux. Ouvre la carte et laisse-toi guider !`,
      data: { trip_id: tripId, destination: dto.destination },
      dedupe_key: `trip_ready:${tripId}`,
    });

    // Voyage daté : Réservations & Budget se prépare en arrière-plan (prêt à la première ouverture)
    if (dto.start_date) this.tripBookings.warmUp(user.user_id, tripId);

    return trip;
  }

  /**
   * Change la visibilité d'un voyage de l'auteur.
   * La copie partagée (fil, cercles, likes) est créée au besoin, et conservée
   * en privé pour garder ses likes si le voyage redevient visible.
   */
  async updateVisibility(userId: string, tripId: string, visibility: TripVisibility) {
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
    const trip: any = await TripModel.findOneAndUpdate(
      { id: tripId, user_id: userId },
      { $set: visibilityFields(visibility) },
      { new: true },
    )
      .lean()
      .exec();
    if (!trip) {
      throw new NotFoundException(`Trip ${tripId} not found`);
    }

    if (visibility === 'private') {
      await this.sharedTripModel.updateOne({ id: tripId }, { $set: visibilityFields(visibility) }).exec();
    } else {
      // Likes et commentaires ne vivent que sur la copie partagée : on ne les écrase pas
      const { _id, __v, likes, liked_by, comments_count, remix_count, ...mirror } = trip;
      await this.sharedTripModel
        .updateOne(
          { id: tripId },
          { $set: mirror, $setOnInsert: { likes: 0, liked_by: [], comments_count: 0, remix_count: 0 } },
          { upsert: true },
        )
        .exec();
    }

    return { trip_id: tripId, ...visibilityFields(visibility) };
  }

  /**
   * « Refaire ce voyage » : copie l'itinéraire d'un autre voyageur (visible par moi)
   * dans mes voyages, en privé, avec mes dates et une météo recalculée.
   */
  async remixTrip(user: UserDocument, sourceTripId: string, startDate?: string): Promise<Trip> {
    const source: any = await this.sharedTripModel.findOne({ id: sourceTripId }).lean().exec();
    if (
      !source ||
      !(await canViewTrip(this.memberModel, source, user.user_id)) ||
      (await isBlockedBetween(this.blockModel, user.user_id, source.user_id))
    ) {
      throw new NotFoundException(`Trip ${sourceTripId} not found`);
    }
    if (source.user_id === user.user_id) {
      throw new HttpException('Ce voyage est déjà le tien', HttpStatus.BAD_REQUEST);
    }

    const trip = await this.createTripFromItinerary(user, source, {
      startDate,
      origin: { remixed_from: { trip_id: source.id, user_id: source.user_id, destination: source.destination } },
    });

    await this.sharedTripModel.updateOne({ id: source.id }, { $inc: { remix_count: 1 } }).exec();
    this.rewardRemixedAuthor(source.user_id, source.id, user);

    return trip;
  }

  /** L'auteur d'origine : XP une fois par voyageur, badge « Éclaireur » et notification. */
  private rewardRemixedAuthor(authorId: string, tripId: string, remixer: UserDocument) {
    (async () => {
      const awarded = await this.gamificationService.awardXpOnce(authorId, 'trip_remixed', `${tripId}:${remixer.user_id}`);
      if (!awarded) return;
      await this.gamificationService.awardXP(authorId, 'eclaireur');
      const source: any = await this.sharedTripModel.findOne({ id: tripId }).select('destination').lean().exec();
      this.notificationsService.notifySafely(authorId, {
        type: 'trip_remixed',
        title: `🧭 ${remixer.pseudo || remixer.name || 'Un voyageur'} refait ton voyage ${source?.destination ?? ''}`.trim(),
        body: 'Ton itinéraire inspire la communauté !',
        data: { trip_id: tripId },
        dedupe_key: `trip_remixed:${tripId}:${remixer.user_id}`,
      });
    })().catch((err) => this.logger.warn(`Récompense « voyage refait » non attribuée à ${authorId}: ${err.message}`));
  }

  /**
   * Crée dans mes voyages (privé) un voyage à partir d'un itinéraire existant :
   * voyage refait, voyage de tribu... Quota gratuit, XP et météo recalculée.
   */
  async createTripFromItinerary(
    user: UserDocument,
    itinerary: {
      destination: string;
      city?: string;
      country?: string;
      country_code?: string;
      cover_image_url?: string;
      duration_days?: number;
      pace: string;
      transports?: string[];
      budget: string;
      interests?: string[];
      pois: any[];
      /** Pépites du voyage d'origine (reprises non ramassées) */
      gems?: any[];
    },
    options: { startDate?: string; origin?: Record<string, any> } = {},
  ): Promise<Trip> {
    const TripModel = await this.tenancyService.getTenantModel<TripDocument>(user.user_id, 'Trip', TripSchema);
    const ProfileModel = await this.tenancyService.getTenantModel<any>(user.user_id, 'Profile', ProfileSchema);
    await this.assertFreemiumQuota(user, TripModel);

    const days = Math.max(1, itinerary.duration_days || 1);
    const startDate = options.startDate?.slice(0, 10);
    await this.assertNoOverlap(user.user_id, startDate, days);
    let endDate: string | undefined;
    if (startDate) {
      const end = new Date(`${startDate}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + days - 1);
      endDate = end.toISOString().slice(0, 10);
    }

    // Les lieux sont repris tels quels ; seule la météo dépend des nouvelles dates
    const pois = (itinerary.pois || []).map((p: any) => ({ ...p }));
    const firstValidPoi = pois.find((p: any) => p.lat && p.lng);
    let weather: DayWeather[] = [];
    try {
      weather = await this.aiService.fetchWeather(
        firstValidPoi?.lat ?? 48.8566,
        firstValidPoi?.lng ?? 2.3522,
        days,
        startDate,
      );
    } catch (err: any) {
      this.logger.warn(`Météo indisponible pour le voyage copié: ${err.message}`);
    }

    const trip = await TripModel.create({
      id: uuidv4(),
      user_id: user.user_id,
      tenant_id: user.user_id,
      destination: itinerary.destination,
      city: itinerary.city,
      country: itinerary.country,
      country_code: itinerary.country_code,
      cover_image_url: itinerary.cover_image_url,
      start_date: startDate,
      end_date: endDate,
      duration_days: days,
      pace: itinerary.pace,
      transports: itinerary.transports || [],
      budget: itinerary.budget,
      interests: itinerary.interests || [],
      pois,
      weather,
      gems: (itinerary.gems || []).map((g: any) => ({ ...g, collected_at: null })),
      ...visibilityFields('private'),
      likes: 0,
      ...(options.origin || {}),
      created_at: new Date(),
    });

    this.tripSchedule.register(user.user_id, trip.toObject ? trip.toObject() : trip);
    await this.rewardTripCreation(user, ProfileModel);
    return trip;
  }
}
