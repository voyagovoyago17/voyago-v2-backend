import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { TenancyService } from '../tenancy/tenancy.service';
import { AiService, PACKING_CATEGORIES } from '../ai/ai.service';
import { GamificationService } from '../gamification/gamification.service';
import { TripDocument, TripSchema } from './schemas/trip.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { ageFrom } from '../community/circle-access.service';

/**
 * Valise du voyage : liste sur mesure générée une fois par l'IA (climat, durée, activités),
 * puis cochée par le voyageur jusqu'au « dernier check ».
 */
@Injectable()
export class TripPackingService {
  private readonly logger = new Logger(TripPackingService.name);
  /** Générations en cours : un double appel n'interroge l'IA qu'une fois */
  private readonly pending = new Map<string, Promise<any>>();

  constructor(
    private readonly tenancyService: TenancyService,
    private readonly aiService: AiService,
    private readonly gamificationService: GamificationService,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
  ) {}

  private tripModel(userId: string) {
    return this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
  }

  private toDto(tripId: string, list: any) {
    const categories = (list?.categories || []).map((c: any) => ({
      ...c,
      packed_count: (c.items || []).filter((i: any) => i.packed).length,
    }));
    const items = categories.flatMap((c: any) => c.items || []);
    const packed = items.filter((i: any) => i.packed).length;
    const essentials = items.filter((i: any) => i.essential);
    return {
      trip_id: tripId,
      generated_at: list?.generated_at || null,
      categories,
      total: items.length,
      packed_count: packed,
      essentials_total: essentials.length,
      essentials_packed: essentials.filter((i: any) => i.packed).length,
      ready: items.length > 0 && packed === items.length,
    };
  }

  async get(userId: string, tripId: string) {
    const TripModel = await this.tripModel(userId);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId })
      .select('id destination country duration_days start_date pace budget transports interests weather pois travelers packing_list')
      .lean()
      .exec();
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    if (trip.packing_list?.categories?.length) return this.toDto(tripId, trip.packing_list);

    const key = `${userId}:${tripId}`;
    if (!this.pending.has(key)) {
      this.pending.set(
        key,
        this.generate(userId, trip).finally(() => this.pending.delete(key)),
      );
    }
    return this.toDto(tripId, await this.pending.get(key));
  }

  private async generate(userId: string, trip: any) {
    const user: any = await this.userModel.findOne({ user_id: userId }).select('gender date_of_birth').lean().exec();
    const drafts = await this.aiService.generatePackingList({
      ...trip,
      traveler: { gender: user?.gender ?? null, age: ageFrom(user?.date_of_birth) },
    });
    const list = {
      generated_at: new Date(),
      categories: drafts.map((c) => ({
        key: c.key,
        title: c.title,
        items: c.items.map((i) => ({ id: uuidv4().slice(0, 8), ...i, packed: false, custom: false })),
      })),
    };
    const TripModel = await this.tripModel(userId);
    // Conditionnel : une liste déjà enregistrée (autre appareil) n'est pas écrasée
    await TripModel.updateOne({ id: trip.id, user_id: userId, packing_list: null }, { $set: { packing_list: list } }).exec();
    const saved: any = await TripModel.findOne({ id: trip.id }).select('packing_list').lean().exec();
    return saved?.packing_list || list;
  }

  /** Coche / décoche un objet. */
  async toggle(userId: string, tripId: string, itemId: string, packed: boolean) {
    const TripModel = await this.tripModel(userId);
    const res = await TripModel.updateOne(
      { id: tripId, user_id: userId },
      { $set: { 'packing_list.categories.$[].items.$[it].packed': packed } },
      { arrayFilters: [{ 'it.id': itemId }] },
    ).exec();
    if (res.matchedCount === 0) throw new NotFoundException(`Trip ${tripId} not found`);
    return this.afterChange(userId, tripId);
  }

  /** Ajoute un objet personnel dans une catégorie. */
  async addItem(userId: string, tripId: string, label: string, category?: string) {
    const clean = (label || '').trim().slice(0, 80);
    if (!clean) throw new BadRequestException('Objet vide');
    const key = PACKING_CATEGORIES.includes(category as any) ? category! : 'divers';
    const TripModel = await this.tripModel(userId);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId }).select('packing_list').lean().exec();
    if (!trip?.packing_list) throw new NotFoundException('Prépare d\'abord ta valise');
    const item = { id: uuidv4().slice(0, 8), label: clean, essential: false, packed: false, custom: true };
    const hasCategory = (trip.packing_list.categories || []).some((c: any) => c.key === key);
    await TripModel.updateOne(
      { id: tripId, user_id: userId },
      hasCategory
        ? { $push: { 'packing_list.categories.$[c].items': item } }
        : { $push: { 'packing_list.categories': { key, title: key === 'divers' ? 'Divers' : key, items: [item] } } },
      hasCategory ? { arrayFilters: [{ 'c.key': key }] } : {},
    ).exec();
    return this.afterChange(userId, tripId);
  }

  async removeItem(userId: string, tripId: string, itemId: string) {
    const TripModel = await this.tripModel(userId);
    await TripModel.updateOne(
      { id: tripId, user_id: userId },
      { $pull: { 'packing_list.categories.$[].items': { id: itemId, custom: true } } },
    ).exec();
    return this.afterChange(userId, tripId);
  }

  /** Valise complète : +1 XP la première fois pour ce voyage. */
  private async afterChange(userId: string, tripId: string) {
    const TripModel = await this.tripModel(userId);
    const trip: any = await TripModel.findOne({ id: tripId }).select('packing_list').lean().exec();
    const dto = this.toDto(tripId, trip?.packing_list);
    let gamification: any = null;
    if (dto.ready) {
      try {
        gamification = await this.gamificationService.awardXpOnce(userId, 'valise_prete', tripId);
      } catch (err: any) {
        this.logger.warn(`XP valise non attribuée à ${userId}: ${err.message}`);
      }
    }
    return { ...dto, gamification };
  }
}
