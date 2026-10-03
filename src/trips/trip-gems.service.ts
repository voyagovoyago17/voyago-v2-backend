import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenancyService } from '../tenancy/tenancy.service';
import { GamificationService } from '../gamification/gamification.service';
import { AiService } from '../ai/ai.service';
import { TripDocument, TripSchema } from './schemas/trip.schema';

/** XP d'une pépite selon sa rareté (fixée par le serveur, jamais par l'IA ni l'app) */
export const GEM_XP: Record<string, number> = { commune: 5, rare: 10, legendaire: 20 };

/** Distance maximale (mètres) entre le voyageur et la pépite pour la ramasser (marge GPS incluse) */
export const GEM_COLLECT_RADIUS_M = 80;

const DAY_MS = 24 * 3600 * 1000;
/** Tolérance de fuseau horaire autour des dates du voyage */
const TIMEZONE_MARGIN_MS = 14 * 3600 * 1000;

export interface GemsWindow {
  /** Le radar est actif maintenant : les pépites peuvent être ramassées */
  active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  /** Voyage sans dates : le voyageur démarre le radar lui-même (« Démarrer mon voyage ») */
  needs_start: boolean;
  ended: boolean;
}

/** Distance en mètres entre deux points GPS (haversine). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Les pépites ne se ramassent que pendant le voyage :
 * - voyage daté : du premier au dernier jour (marge de fuseau horaire) ;
 * - voyage sans dates : pendant sa durée, à partir du « Démarrer mon voyage ».
 */
export function gemsWindow(trip: any, now = new Date()): GemsWindow {
  const days = Math.max(1, trip.duration_days || 1);
  let start: Date | null = null;
  let end: Date | null = null;

  if (trip.start_date) {
    const first = new Date(`${String(trip.start_date).slice(0, 10)}T00:00:00Z`);
    const last = trip.end_date
      ? new Date(`${String(trip.end_date).slice(0, 10)}T00:00:00Z`)
      : new Date(first.getTime() + (days - 1) * DAY_MS);
    if (!isNaN(first.getTime()) && !isNaN(last.getTime())) {
      start = new Date(first.getTime() - TIMEZONE_MARGIN_MS);
      end = new Date(last.getTime() + DAY_MS + TIMEZONE_MARGIN_MS);
    }
  } else if (trip.gems_started_at) {
    start = new Date(trip.gems_started_at);
    end = new Date(start.getTime() + days * DAY_MS);
  }

  if (!start || !end) {
    return { active: false, starts_at: null, ends_at: null, needs_start: !trip.completed_at, ended: !!trip.completed_at };
  }
  const ended = now >= end || !!trip.completed_at;
  return { active: now >= start && !ended, starts_at: start, ends_at: end, needs_start: false, ended };
}

/** Radar des pépites : lieux secrets à ramasser sur place pendant le voyage pour gagner de l'XP. */
@Injectable()
export class TripGemsService {
  private readonly logger = new Logger(TripGemsService.name);

  constructor(
    private readonly tenancyService: TenancyService,
    private readonly gamificationService: GamificationService,
    private readonly aiService: AiService,
  ) {}

  private tripModel(userId: string) {
    return this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
  }

  private async loadTrip(userId: string, tripId: string): Promise<any> {
    const TripModel = await this.tripModel(userId);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId })
      .select('id destination duration_days start_date end_date completed_at gems gems_started_at gems_backfilled_at')
      .lean()
      .exec();
    if (!trip) {
      throw new NotFoundException(`Trip ${tripId} not found`);
    }
    return trip;
  }

  private toDto(trip: any) {
    const gems = (trip.gems || []).map((g: any) => ({ ...g, xp: GEM_XP[g.rarity] ?? GEM_XP.commune }));
    const collected = gems.filter((g: any) => g.collected_at);
    return {
      trip_id: trip.id,
      window: gemsWindow(trip),
      collect_radius_m: GEM_COLLECT_RADIUS_M,
      gems,
      collected_count: collected.length,
      total_count: gems.length,
      xp_earned: collected.reduce((sum: number, g: any) => sum + g.xp, 0),
      xp_available: gems.reduce((sum: number, g: any) => sum + g.xp, 0),
    };
  }

  /** Pépites de mon voyage et état du radar (réservé à l'auteur du voyage). */
  async getGems(userId: string, tripId: string) {
    const trip = await this.loadTrip(userId, tripId);
    if (!trip.gems?.length && !trip.gems_backfilled_at && !gemsWindow(trip).ended) {
      trip.gems = await this.backfillGems(userId, tripId);
    }
    return this.toDto(trip);
  }

  /**
   * Voyage créé avant le radar : génère ses pépites une seule fois (petit appel IA dédié).
   * Le marqueur est posé avant l'appel pour éviter toute double génération.
   */
  private async backfillGems(userId: string, tripId: string): Promise<any[]> {
    const TripModel = await this.tripModel(userId);
    const claimed = await TripModel.updateOne(
      { id: tripId, gems_backfilled_at: null },
      { $set: { gems_backfilled_at: new Date() } },
    ).exec();
    if (claimed.modifiedCount === 0) return [];

    const full: any = await TripModel.findOne({ id: tripId }).select('destination duration_days transports pois').lean().exec();
    if (!full?.pois?.length) return [];
    const generated = await this.aiService.generateGemsForItinerary(full);
    const gems = await Promise.all(
      generated.map(async (g) => ({
        ...g,
        image_url: await this.aiService.findImage(g.image_query).catch(() => null),
      })),
    );
    if (gems.length) {
      await TripModel.updateOne({ id: tripId }, { $set: { gems } }).exec();
      this.logger.log(`${gems.length} pépites ajoutées au voyage ${tripId}`);
    }
    return gems;
  }

  /** Voyage sans dates : démarre le radar pour la durée du voyage. */
  async start(userId: string, tripId: string) {
    const trip = await this.loadTrip(userId, tripId);
    if (trip.start_date) {
      throw new BadRequestException('Ce voyage a des dates : le radar suit ses dates automatiquement');
    }
    if (!trip.gems_started_at) {
      const TripModel = await this.tripModel(userId);
      await TripModel.updateOne({ id: tripId, gems_started_at: null }, { $set: { gems_started_at: new Date() } }).exec();
    }
    return this.getGems(userId, tripId);
  }

  /** Ramasse une pépite : pendant le voyage, à moins de GEM_COLLECT_RADIUS_M mètres, une seule fois. */
  async collect(userId: string, tripId: string, gemId: string, lat: number, lng: number) {
    const trip = await this.loadTrip(userId, tripId);
    const gem = (trip.gems || []).find((g: any) => g.id === gemId);
    if (!gem) {
      throw new NotFoundException('Pépite introuvable');
    }
    if (gem.collected_at) {
      return { collected: true, already: true, xp_awarded: 0, gem_id: gemId };
    }
    const window = gemsWindow(trip);
    if (!window.active) {
      throw new BadRequestException(
        window.ended
          ? 'Ce voyage est terminé : les pépites ne peuvent plus être ramassées'
          : 'Le radar s\'active pendant ton voyage',
      );
    }
    const distance = distanceMeters(lat, lng, gem.lat, gem.lng);
    if (distance > GEM_COLLECT_RADIUS_M) {
      throw new BadRequestException(`Approche-toi encore : la pépite est à ${Math.round(distance)} m`);
    }

    // Marquage atomique : un double appel ne rapporte l'XP qu'une fois
    const TripModel = await this.tripModel(userId);
    const res = await TripModel.updateOne(
      { id: tripId, gems: { $elemMatch: { id: gemId, collected_at: null } } },
      { $set: { 'gems.$.collected_at': new Date() } },
    ).exec();
    if (res.modifiedCount === 0) {
      return { collected: true, already: true, xp_awarded: 0, gem_id: gemId };
    }

    const rarity = GEM_XP[gem.rarity] !== undefined ? gem.rarity : 'commune';
    let gamification: any = null;
    try {
      gamification = await this.gamificationService.awardXpOnce(userId, `gem_${rarity}`, `${tripId}:${gemId}`);
      await this.gamificationService.awardXP(userId, 'chasseur_pepites');
    } catch (err: any) {
      this.logger.warn(`XP pépite non attribuée à ${userId}: ${err.message}`);
    }
    return { collected: true, already: false, xp_awarded: GEM_XP[rarity], gem_id: gemId, gamification };
  }
}
