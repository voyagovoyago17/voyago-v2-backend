import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Trip, TripDocument, TripSchema } from '../trips/schemas/trip.schema';
import { PlaceReview, PlaceReviewDocument } from '../places/schemas/place-review.schema';
import { placeKey } from '../places/place-key';
import { JournalEntry, JournalEntryDocument, JournalEntrySchema } from './schemas/journal-entry.schema';
import { UpsertJournalEntryDto } from './dto/upsert-entry.dto';
import { TripScheduleService } from '../trips/trip-schedule.service';
import { isTripPast, tripBadge, tripDistanceKm, tripEndDate } from './journal-utils';
import { TenancyService } from '../tenancy/tenancy.service';
import { GamificationService } from '../gamification/gamification.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadService } from '../upload/upload.service';
import { TripsService } from '../trips/trips.service';
import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';

const MAX_PHOTOS_PER_ENTRY = 6;
const TRIP_GENERATION_XP = 3;
const REVIEW_XP = 2;
const SHARE_JOURNAL_XP = 5;

@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(
    @InjectModel(Trip.name, TENANT_DB_CONNECTION) private readonly sharedTripModel: Model<TripDocument>,
    @InjectModel(PlaceReview.name, GLOBAL_DB_CONNECTION) private readonly reviewModel: Model<PlaceReviewDocument>,
    private readonly tenancyService: TenancyService,
    private readonly gamificationService: GamificationService,
    private readonly notificationsService: NotificationsService,
    private readonly uploadService: UploadService,
    private readonly tripsService: TripsService,
    private readonly tripSchedule: TripScheduleService,
  ) {}

  private tripModel(userId: string) {
    return this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
  }

  private entryModel(userId: string) {
    return this.tenancyService.getTenantModel<JournalEntryDocument>(userId, 'JournalEntry', JournalEntrySchema);
  }

  /** Voyages passés du voyageur, du plus récent au plus ancien, avec leurs chiffres clés. */
  async list(userId: string) {
    const [TripModel, EntryModel] = await Promise.all([this.tripModel(userId), this.entryModel(userId)]);
    const trips: any[] = await TripModel.find({ user_id: userId }).select('-weather').lean().exec();
    const past = trips.filter((t) => isTripPast(t));
    if (past.length === 0) return { trips: [] };

    const [reviews, entries] = await Promise.all([
      this.reviewModel.find({ user_id: userId }).select('place_key rating liked').lean().exec(),
      EntryModel.find({ trip_id: { $in: past.map((t) => t.id) } })
        .select('trip_id poi_name visited photos note')
        .lean()
        .exec(),
    ]);
    const reviewByKey = new Map(reviews.map((r: any) => [r.place_key, r]));

    const summaries = past.map((trip) => {
      const tripEntries = entries.filter((e: any) => e.trip_id === trip.id);
      const stats = this.computeStats(trip, tripEntries, reviewByKey);
      return {
        trip_id: trip.id,
        destination: trip.destination,
        city: trip.city || null,
        country: trip.country || null,
        cover_image_url: trip.cover_image_url || trip.pois?.[0]?.image_url || null,
        start_date: trip.start_date || null,
        end_date: tripEndDate(trip)?.toISOString().slice(0, 10) || null,
        duration_days: trip.duration_days,
        completed_at: trip.completed_at || null,
        journal_shared: !!trip.journal_shared_at,
        badge: tripBadge(trip, stats),
        stats,
      };
    });

    summaries.sort((a, b) => this.sortDate(b).localeCompare(this.sortDate(a)));
    return { trips: summaries };
  }

  /** Journal complet d'un voyage : jours, lieux, souvenirs, avis donnés, météo. */
  async detail(userId: string, tripId: string) {
    const [TripModel, EntryModel] = await Promise.all([this.tripModel(userId), this.entryModel(userId)]);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId }).lean().exec();
    if (!trip) throw new NotFoundException(`Voyage ${tripId} introuvable`);

    const pois: any[] = trip.pois || [];
    const keys = pois.map((p) => placeKey(p.name, p.lat, p.lng));
    const [entries, reviews] = await Promise.all([
      EntryModel.find({ trip_id: tripId }).lean().exec(),
      this.reviewModel.find({ user_id: userId, place_key: { $in: keys } }).lean().exec(),
    ]);
    const reviewByKey = new Map(reviews.map((r: any) => [r.place_key, r]));
    const entryByPoi = new Map(entries.map((e: any) => [e.poi_name, e]));
    const stats = this.computeStats(trip, entries, reviewByKey);

    const start = trip.start_date ? new Date(trip.start_date) : null;
    const days = Array.from({ length: trip.duration_days || 1 }, (_, i) => i + 1).map((day) => {
      const dayPois = pois
        .filter((p) => p.day === day)
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((p) => {
          const entry: any = entryByPoi.get(p.name);
          const review: any = reviewByKey.get(placeKey(p.name, p.lat, p.lng));
          return {
            ...p,
            visited: !!(entry?.visited || review),
            entry: entry ? this.toEntryDto(entry) : null,
            review: review
              ? { rating: review.rating, liked: !!review.liked, comment: review.comment || '' }
              : null,
          };
        });
      const date = start && !isNaN(start.getTime()) ? new Date(start.getTime() + (day - 1) * 86400000) : null;
      return {
        day,
        date: date ? date.toISOString().slice(0, 10) : null,
        weather: trip.weather?.[day - 1] || null,
        pois: dayPois,
      };
    });

    return {
      trip_id: trip.id,
      destination: trip.destination,
      city: trip.city || null,
      country: trip.country || null,
      cover_image_url: trip.cover_image_url || pois[0]?.image_url || null,
      start_date: trip.start_date || null,
      end_date: tripEndDate(trip)?.toISOString().slice(0, 10) || null,
      duration_days: trip.duration_days,
      transports: trip.transports || [],
      interests: trip.interests || [],
      completed_at: trip.completed_at || null,
      is_past: isTripPast(trip),
      journal_shared: !!trip.journal_shared_at,
      badge: tripBadge(trip, stats),
      stats,
      days,
    };
  }

  /** Écrit (ou complète) le souvenir d'un lieu : note, humeurs, visité. */
  async upsertEntry(userId: string, tripId: string, dto: UpsertJournalEntryDto) {
    await this.assertTrip(userId, tripId);
    const EntryModel = await this.entryModel(userId);
    const set: Record<string, any> = { day: dto.day };
    if (dto.note !== undefined) set.note = dto.note.trim();
    if (dto.mood_tags !== undefined) {
      set.mood_tags = [...new Set(dto.mood_tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
    }
    if (dto.visited !== undefined) {
      set.visited = dto.visited;
      set.visited_at = dto.visited ? new Date() : null;
    }

    const entry = await EntryModel.findOneAndUpdate(
      { trip_id: tripId, poi_name: dto.poi_name },
      { $set: set, $setOnInsert: { id: uuidv4(), trip_id: tripId, poi_name: dto.poi_name, user_id: userId } },
      { upsert: true, new: true },
    )
      .lean()
      .exec();
    return this.toEntryDto(entry);
  }

  async addPhoto(userId: string, tripId: string, poiName: string, day: number, file: Express.Multer.File) {
    if (!poiName) throw new BadRequestException('poi_name est requis');
    await this.assertTrip(userId, tripId);
    const EntryModel = await this.entryModel(userId);

    const existing: any = await EntryModel.findOne({ trip_id: tripId, poi_name: poiName }).lean().exec();
    if ((existing?.photos?.length || 0) >= MAX_PHOTOS_PER_ENTRY) {
      throw new BadRequestException(`${MAX_PHOTOS_PER_ENTRY} photos maximum par lieu`);
    }

    const photo = await this.uploadService.uploadImage(file, `journal_${userId}_${tripId}`);
    const entry = await EntryModel.findOneAndUpdate(
      { trip_id: tripId, poi_name: poiName },
      {
        $push: { photos: photo },
        $set: { day: day || existing?.day || 1 },
        $setOnInsert: { id: uuidv4(), trip_id: tripId, poi_name: poiName, user_id: userId },
      },
      { upsert: true, new: true },
    )
      .lean()
      .exec();
    return this.toEntryDto(entry);
  }

  async removePhoto(userId: string, tripId: string, photoKey: string) {
    const EntryModel = await this.entryModel(userId);
    const entry = await EntryModel.findOneAndUpdate(
      { trip_id: tripId, 'photos.key': photoKey },
      { $pull: { photos: { key: photoKey } } },
      { new: true },
    )
      .lean()
      .exec();
    if (!entry) throw new NotFoundException('Photo introuvable');
    this.uploadService.deleteFileFromUploadThing(photoKey).catch(() => {});
    return this.toEntryDto(entry);
  }

  /** Termine le voyage : il quitte la carte et rejoint le journal. */
  async complete(userId: string, tripId: string) {
    return this.setCompleted(userId, tripId, new Date());
  }

  /** Remet un voyage terminé manuellement sur la carte. */
  async reopen(userId: string, tripId: string) {
    return this.setCompleted(userId, tripId, null);
  }

  /** Partage le journal à la communauté (le voyage devient public) : +XP la première fois. */
  async share(userId: string, tripId: string) {
    const TripModel = await this.tripModel(userId);
    // Mise à jour conditionnelle : un double appel ne rapporte l'XP qu'une fois
    const res = await TripModel.updateOne(
      { id: tripId, user_id: userId, journal_shared_at: null },
      { $set: { journal_shared_at: new Date() } },
    ).exec();

    if (res.matchedCount === 0) {
      await this.assertTrip(userId, tripId);
    }
    // Rend le voyage public et (re)crée sa copie partagée pour le fil communautaire
    await this.tripsService.updateVisibility(userId, tripId, 'public');

    if (res.matchedCount === 0) {
      return { shared: true, xp_awarded: 0, gamification: null };
    }

    let gamification: any = null;
    try {
      gamification = await this.gamificationService.awardXP(userId, 'share_journal');
    } catch (err: any) {
      this.logger.warn(`XP partage journal non attribuée à ${userId}: ${err.message}`);
    }
    return { shared: true, xp_awarded: gamification ? SHARE_JOURNAL_XP : 0, gamification };
  }

  private async setCompleted(userId: string, tripId: string, completedAt: Date | null) {
    const TripModel = await this.tripModel(userId);
    const res = await TripModel.updateOne({ id: tripId, user_id: userId }, { $set: { completed_at: completedAt } }).exec();
    if (res.matchedCount === 0) throw new NotFoundException(`Voyage ${tripId} introuvable`);
    this.sharedTripModel.updateOne({ id: tripId }, { $set: { completed_at: completedAt } }).exec().catch(() => {});

    const trip: any = await TripModel.findOne({ id: tripId }).select('destination completed_at start_date end_date duration_days').lean().exec();
    if (completedAt) {
      // Terminé à la main : plus de clôture automatique (un voyage rouvert le reste aussi)
      this.tripSchedule.markProcessed(tripId).catch(() => undefined);
      this.notificationsService.notifySafely(userId, {
        type: 'system',
        title: `Ton journal de ${trip.destination} est prêt 📖`,
        body: 'Retrouve tes lieux, tes avis et tes souvenirs, puis crée ta story à partager.',
        data: { trip_id: tripId, journal: true },
        dedupe_key: `journal_ready:${tripId}`,
      });
    }
    return { trip_id: tripId, completed_at: trip?.completed_at || null, is_past: isTripPast(trip) };
  }

  private async assertTrip(userId: string, tripId: string) {
    const TripModel = await this.tripModel(userId);
    const exists = await TripModel.exists({ id: tripId, user_id: userId }).exec();
    if (!exists) throw new NotFoundException(`Voyage ${tripId} introuvable`);
  }

  private computeStats(trip: any, entries: any[], reviewByKey: Map<string, any>) {
    const pois: any[] = trip.pois || [];
    const entryByPoi = new Map(entries.map((e) => [e.poi_name, e]));
    let visited = 0;
    let reviewsCount = 0;
    let favorites = 0;
    let ratingSum = 0;
    for (const p of pois) {
      const review = reviewByKey.get(placeKey(p.name, p.lat, p.lng));
      if (review) {
        reviewsCount++;
        ratingSum += review.rating || 0;
        if (review.liked) favorites++;
      }
      if (review || entryByPoi.get(p.name)?.visited) visited++;
    }
    const stats = {
      distance_km: tripDistanceKm(pois),
      places_count: pois.length,
      visited_count: visited,
      reviews_count: reviewsCount,
      favorites_count: favorites,
      avg_rating_given: reviewsCount ? Math.round((ratingSum / reviewsCount) * 10) / 10 : null,
      hidden_gems: pois.filter((p) => p.hidden_gem).length,
      photos_count: entries.reduce((n, e) => n + (e.photos?.length || 0), 0),
      notes_count: entries.filter((e) => (e.note || '').trim().length > 0).length,
      xp_earned: TRIP_GENERATION_XP + reviewsCount * REVIEW_XP + (trip.journal_shared_at ? SHARE_JOURNAL_XP : 0),
    };
    return stats;
  }

  private sortDate(summary: any): string {
    return (summary.end_date || (summary.completed_at ? new Date(summary.completed_at).toISOString() : '')) as string;
  }

  private toEntryDto(e: any) {
    return {
      id: e.id,
      poi_name: e.poi_name,
      day: e.day,
      note: e.note || '',
      mood_tags: e.mood_tags || [],
      photos: (e.photos || []).map((p: any) => ({ url: p.url, key: p.key })),
      visited: !!e.visited,
      visited_at: e.visited_at || null,
      updated_at: e.updated_at,
    };
  }
}
