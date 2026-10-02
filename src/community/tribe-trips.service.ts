import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { GenerateTripDto } from '../trips/dto/generate-trip.dto';
import { TripsService } from '../trips/trips.service';
import { GamificationService } from '../gamification/gamification.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';
import { CommunityService } from './community.service';
import { CommunityCircle, CommunityCircleDocument } from './schemas/community-circle.schema';
import { CommunityMember, CommunityMemberDocument } from './schemas/community-member.schema';
import { CircleTripPlan, CircleTripPlanDocument } from './schemas/circle-trip-plan.schema';
import { CircleTripVote, CircleTripVoteDocument } from './schemas/circle-trip-vote.schema';
import { CreateTripPlanDto } from './dto/create-trip-plan.dto';
import { isProActive } from '../pro/pro-status';

/** Projets de voyage en cours de vote autorisés en même temps dans un cercle */
const MAX_ACTIVE_PLANS_PER_CIRCLE = 3;

/** Ancienneté maximale d'un parcours réutilisable (« Parcours déjà connu ») */
const REUSE_MAX_AGE_DAYS = 90;

/** Voyages de tribu générés par l'IA par membre Pro et par mois */
export const MAX_AI_PLANS_PER_MONTH = 4;

/** Lieux proposés par jour : un peu plus que le rythme équilibré final pour laisser le choix */
const CANDIDATES_PER_DAY_PACE = 'equilibre';

/** Empreinte des paramètres qui influencent les lieux proposés par l'IA. */
export function candidatesKey(destination: string, days: number, budget: string, interests: string[]): string {
  const normalized = destination
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return [normalized, days, budget, [...interests].map((i) => i.toLowerCase()).sort().join(',')].join('|');
}

/** Centres d'intérêt par défaut selon la catégorie du cercle */
const CATEGORY_INTERESTS: Record<string, string[]> = {
  culture: ['culture', 'histoire', 'musées'],
  adventure: ['aventure', 'nature', 'panoramas'],
  nature: ['nature', 'randonnée', 'panoramas'],
  food: ['gastronomie', 'marchés', 'vie locale'],
  beach: ['plage', 'détente', 'gastronomie'],
};

interface Tally {
  up: number;
  down: number;
}

/**
 * Voyages de tribu : l'IA propose des lieux, chaque membre vote (swipe),
 * puis l'itinéraire final retient les lieux préférés de la tribu.
 */
@Injectable()
export class TribeTripsService {
  private readonly logger = new Logger(TribeTripsService.name);

  constructor(
    @InjectModel(CircleTripPlan.name, TENANT_DB_CONNECTION) private readonly planModel: Model<CircleTripPlanDocument>,
    @InjectModel(CircleTripVote.name, TENANT_DB_CONNECTION) private readonly voteModel: Model<CircleTripVoteDocument>,
    @InjectModel(CommunityCircle.name, TENANT_DB_CONNECTION) private readonly circleModel: Model<CommunityCircleDocument>,
    @InjectModel(CommunityMember.name, TENANT_DB_CONNECTION) private readonly memberModel: Model<CommunityMemberDocument>,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    private readonly communityService: CommunityService,
    private readonly tripsService: TripsService,
    private readonly gamificationService: GamificationService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // =========================================================================
  // ACCÈS
  // =========================================================================

  /** Cercle visible par le voyageur (404 sinon) et son adhésion éventuelle. */
  private async circleFor(circleId: string, userId?: string) {
    const circle: any = await this.circleModel.findOne({ id: circleId }).lean().exec();
    if (!circle) {
      throw new NotFoundException('Cercle introuvable');
    }
    const membership: any = await this.communityService.assertCircleAccess(circle, userId);
    return { circle, membership };
  }

  /** Participer (proposer, voter, rejoindre) est réservé aux membres de la tribu. */
  private async memberCircle(circleId: string, userId: string) {
    const { circle, membership } = await this.circleFor(circleId, userId);
    if (!membership) {
      throw new ForbiddenException('Rejoins la tribu pour participer à ses voyages');
    }
    return { circle, membership };
  }

  private async planFor(planId: string): Promise<any> {
    const plan: any = await this.planModel.findOne({ id: planId }).lean().exec();
    if (!plan) {
      throw new NotFoundException('Voyage de tribu introuvable');
    }
    return plan;
  }

  // =========================================================================
  // VOTES
  // =========================================================================

  private async tallies(planId: string): Promise<{ byKey: Map<string, Tally>; voters: number }> {
    const [rows, voters] = await Promise.all([
      this.voteModel.aggregate([
        { $match: { plan_id: planId } },
        {
          $group: {
            _id: '$poi_key',
            up: { $sum: { $cond: [{ $eq: ['$vote', 'up'] }, 1, 0] } },
            down: { $sum: { $cond: [{ $eq: ['$vote', 'down'] }, 1, 0] } },
          },
        },
      ]),
      this.voteModel.distinct('user_id', { plan_id: planId }).exec(),
    ]);
    return {
      byKey: new Map(rows.map((r: any) => [r._id, { up: r.up, down: r.down }])),
      voters: voters.length,
    };
  }

  private activitiesPerDay(pace: string): number {
    return pace === 'tranquille' ? 3 : pace === 'intensif' ? 5 : 4;
  }

  /**
   * Lieux retenus : votes positifs nets (au moins un 👍), les mieux notés d'abord,
   * puis remis dans l'ordre géographique proposé par l'IA et répartis par jour.
   */
  private selectFinalPois(plan: any, byKey: Map<string, Tally>): any[] {
    const limit = plan.duration_days * this.activitiesPerDay(plan.pace);
    const ranked = plan.candidates
      .map((c: any, index: number) => ({ c, index, t: byKey.get(c.key) || { up: 0, down: 0 } }))
      .filter((x) => x.t.up > 0 && x.t.up >= x.t.down)
      .sort((a, b) => b.t.up - b.t.down - (a.t.up - a.t.down) || b.t.up - a.t.up || a.index - b.index)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index);

    const perDay = Math.max(1, Math.ceil(ranked.length / plan.duration_days));
    return ranked.map((x, i) => ({
      ...x.c,
      day: Math.floor(i / perDay) + 1,
      order: (i % perDay) + 1,
      tribe_votes: x.t.up,
    }));
  }

  private async toDto(plan: any, viewerId?: string, canManage = false) {
    const [{ byKey, voters }, myVotes, creator] = await Promise.all([
      this.tallies(plan.id),
      viewerId
        ? this.voteModel.find({ plan_id: plan.id, user_id: viewerId }).select('poi_key vote').lean().exec()
        : Promise.resolve([]),
      this.userModel.findOne({ user_id: plan.created_by }).select('user_id name pseudo avatar_emoji picture').lean().exec(),
    ]);
    const myVoteByKey = new Map((myVotes as any[]).map((v) => [v.poi_key, v.vote]));
    const { _id, __v, joined_by, ...rest } = plan;

    return {
      ...rest,
      candidates: plan.candidates.map((c: any) => ({
        ...c,
        up: byKey.get(c.key)?.up || 0,
        down: byKey.get(c.key)?.down || 0,
        my_vote: myVoteByKey.get(c.key) || null,
      })),
      voters_count: voters,
      my_votes_count: myVoteByKey.size,
      joined_count: (joined_by || []).length,
      joined_by_me: !!viewerId && (joined_by || []).includes(viewerId),
      can_finalize: plan.status === 'voting' && (canManage || plan.created_by === viewerId),
      creator: creator
        ? {
            user_id: (creator as any).user_id,
            name: (creator as any).name,
            pseudo: (creator as any).pseudo || null,
            avatar_emoji: (creator as any).avatar_emoji || null,
            picture: (creator as any).picture || null,
          }
        : null,
    };
  }

  private isManager(membership: any): boolean {
    return ['creator', 'admin'].includes(membership?.role);
  }

  // =========================================================================
  // CYCLE DE VIE D'UN VOYAGE DE TRIBU
  // =========================================================================

  /**
   * Un membre Pro lance un voyage de tribu : l'IA propose des lieux à départager.
   * Les lieux déjà générés pour la même destination (30 jours) sont réutilisés sans appel IA.
   */
  async createPlan(user: UserDocument, circleId: string, dto: CreateTripPlanDto) {
    if (!isProActive(user)) {
      throw new ForbiddenException('Planifier un voyage de tribu est réservé aux membres Voyagooo Pro');
    }
    const { circle, membership } = await this.memberCircle(circleId, user.user_id);

    const active = await this.planModel.countDocuments({ circle_id: circleId, status: 'voting' }).exec();
    if (active >= MAX_ACTIVE_PLANS_PER_CIRCLE) {
      throw new BadRequestException(
        `Déjà ${MAX_ACTIVE_PLANS_PER_CIRCLE} voyages en cours de vote dans cette tribu : finalisez-en un d'abord`,
      );
    }

    const pace = dto.pace || 'equilibre';
    const budget = dto.budget || 'moyen';
    const interests = dto.interests?.length
      ? dto.interests
      : CATEGORY_INTERESTS[circle.category] || ['culture', 'gastronomie', 'nature'];

    // Un jour de lieux en plus (4 par jour) pour laisser le choix à la tribu
    const candidateDto = {
      destination: dto.destination.trim(),
      duration_days: Math.min(dto.duration_days + 1, 8),
      pace: CANDIDATES_PER_DAY_PACE,
      transports: ['marche'],
      budget,
      interests,
      start_date: dto.start_date?.slice(0, 10),
      city: dto.city,
      country: dto.country,
      country_code: dto.country_code,
    } as GenerateTripDto;

    const cacheKey = candidatesKey(candidateDto.destination, candidateDto.duration_days, budget, interests);
    // « Parcours déjà connu » : lieux d'un voyage de tribu récent sur la même destination
    const cached: any =
      dto.mode === 'reuse'
        ? await this.planModel
            .findOne({
              candidates_key: cacheKey,
              created_at: { $gte: new Date(Date.now() - REUSE_MAX_AGE_DAYS * 24 * 3600 * 1000) },
            })
            .sort({ created_at: -1 })
            .select('candidates city country cover_image_url')
            .lean()
            .exec()
        : null;

    let places: { pois: any[]; city?: string; country?: string; monument: { imageUrl?: string } };
    const aiGenerated = !cached?.candidates?.length;
    if (aiGenerated) {
      await this.assertAiPlanQuota(user.user_id);
    }
    if (!aiGenerated) {
      this.logger.log(`Voyage de tribu ${candidateDto.destination} : parcours réutilisé (sans appel IA)`);
      places = {
        pois: cached.candidates.map(({ key, ...poi }: any) => poi),
        city: cached.city,
        country: cached.country,
        monument: { imageUrl: cached.cover_image_url },
      };
    } else {
      places = await this.tripsService.generatePlaces(candidateDto);
    }
    if (!places.pois.length) {
      throw new BadRequestException("L'IA n'a trouvé aucun lieu pour cette destination, réessaie");
    }

    const plan = await this.planModel.create({
      id: crypto.randomUUID(),
      circle_id: circleId,
      created_by: user.user_id,
      destination: candidateDto.destination,
      city: places.city,
      country: places.country,
      country_code: dto.country_code,
      cover_image_url: places.monument.imageUrl,
      duration_days: dto.duration_days,
      start_date: candidateDto.start_date,
      pace,
      budget,
      transports: ['marche'],
      interests,
      candidates_key: cacheKey,
      ai_generated: aiGenerated,
      candidates: places.pois.map((p, i) => ({ ...p, key: `p${i}` })),
      status: 'voting',
    });

    this.notifyMembers(circleId, user.user_id, {
      title: `🧭 Nouveau voyage de tribu : ${plan.destination}`,
      body: `${user.pseudo || user.name || 'Un membre'} propose ${plan.duration_days} jour(s) dans « ${circle.name} ». Vote pour tes lieux préférés !`,
      data: { circle_id: circleId, plan_id: plan.id },
      dedupe: `tribe_plan:${plan.id}`,
    });

    return this.toDto(plan.toObject(), user.user_id, this.isManager(membership));
  }

  /** Plafond de voyages de tribu générés par l'IA, par membre et par mois civil (UTC). */
  private async assertAiPlanQuota(userId: string): Promise<void> {
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const used = await this.planModel
      .countDocuments({ created_by: userId, ai_generated: { $ne: false }, created_at: { $gte: startOfMonth } })
      .exec();
    if (used >= MAX_AI_PLANS_PER_MONTH) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'TRIBE_PLAN_QUOTA',
          message:
            `Tu as lancé ${MAX_AI_PLANS_PER_MONTH} nouveaux itinéraires de tribu ce mois-ci. ` +
            'Choisis « Parcours déjà connu » ou attends le mois prochain.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async listPlans(circleId: string, authHeader?: string) {
    const viewerId = await this.communityService.authUserId(authHeader);
    const { membership } = await this.circleFor(circleId, viewerId);
    const plans: any[] = await this.planModel
      .find({ circle_id: circleId })
      .sort({ created_at: -1 })
      .limit(20)
      .lean()
      .exec();
    return Promise.all(plans.map((p) => this.toDto(p, viewerId, this.isManager(membership))));
  }

  async getPlan(planId: string, authHeader?: string) {
    const viewerId = await this.communityService.authUserId(authHeader);
    const plan = await this.planFor(planId);
    const { membership } = await this.circleFor(plan.circle_id, viewerId);
    return this.toDto(plan, viewerId, this.isManager(membership));
  }

  /** Vote (ou change son vote) sur un lieu proposé. */
  async vote(userId: string, planId: string, poiKey: string, vote: 'up' | 'down') {
    const plan = await this.planFor(planId);
    await this.memberCircle(plan.circle_id, userId);
    if (plan.status !== 'voting') {
      throw new BadRequestException('Le vote est terminé pour ce voyage');
    }
    if (!plan.candidates.some((c: any) => c.key === poiKey)) {
      throw new NotFoundException('Lieu introuvable');
    }

    await this.voteModel
      .updateOne({ plan_id: planId, user_id: userId, poi_key: poiKey }, { $set: { vote } }, { upsert: true })
      .exec();
    this.gamificationService
      .awardXpOnce(userId, 'tribe_vote', planId)
      .catch((err) => this.logger.warn(`XP vote de tribu non attribuée à ${userId}: ${err.message}`));

    const t = (await this.tallies(planId)).byKey.get(poiKey) || { up: 0, down: 0 };
    return { poi_key: poiKey, vote, up: t.up, down: t.down };
  }

  /** Clôt le vote et construit l'itinéraire (auteur du projet, créateur ou admin du cercle). */
  async finalize(userId: string, planId: string) {
    const plan = await this.planFor(planId);
    const { membership } = await this.memberCircle(plan.circle_id, userId);
    if (plan.created_by !== userId && !this.isManager(membership)) {
      throw new ForbiddenException("Seul l'auteur du projet ou un admin de la tribu peut le finaliser");
    }
    if (plan.status !== 'voting') {
      throw new BadRequestException('Ce voyage est déjà finalisé');
    }

    const { byKey } = await this.tallies(planId);
    const finalPois = this.selectFinalPois(plan, byKey);
    if (!finalPois.length) {
      throw new BadRequestException("Aucun lieu n'a encore reçu de vote positif");
    }

    const updated: any = await this.planModel
      .findOneAndUpdate(
        { id: planId, status: 'voting' },
        { $set: { status: 'finalized', final_pois: finalPois, finalized_at: new Date() } },
        { new: true },
      )
      .lean()
      .exec();
    if (!updated) {
      throw new BadRequestException('Ce voyage est déjà finalisé');
    }

    const voters: string[] = await this.voteModel.distinct('user_id', { plan_id: planId }).exec();
    for (const voterId of voters.filter((id) => id !== userId)) {
      this.notificationsService.notifySafely(voterId, {
        type: 'tribe_trip',
        title: `✅ Le voyage de tribu ${plan.destination} est prêt`,
        body: `${finalPois.length} lieux choisis par la tribu. Ajoute-le à tes voyages !`,
        data: { circle_id: plan.circle_id, plan_id: planId },
        dedupe_key: `tribe_plan_final:${planId}`,
      });
    }

    return this.toDto(updated, userId, this.isManager(membership));
  }

  /** Ajoute l'itinéraire de la tribu à mes voyages (privé, avec ma date de départ). */
  async join(user: UserDocument, planId: string, startDate?: string) {
    const plan = await this.planFor(planId);
    await this.memberCircle(plan.circle_id, user.user_id);
    if (plan.status !== 'finalized') {
      throw new BadRequestException("Le vote n'est pas encore terminé");
    }

    const trip = await this.tripsService.createTripFromItinerary(
      user,
      {
        destination: plan.destination,
        city: plan.city,
        country: plan.country,
        country_code: plan.country_code,
        cover_image_url: plan.cover_image_url,
        duration_days: plan.duration_days,
        pace: plan.pace,
        transports: plan.transports,
        budget: plan.budget,
        interests: plan.interests,
        pois: plan.final_pois.map(({ key, tribe_votes, ...poi }: any) => poi),
      },
      {
        startDate: startDate || plan.start_date,
        origin: { tribe_plan: { plan_id: plan.id, circle_id: plan.circle_id } },
      },
    );
    await this.planModel.updateOne({ id: planId }, { $addToSet: { joined_by: user.user_id } }).exec();
    return trip;
  }

  private notifyMembers(
    circleId: string,
    exceptUserId: string,
    n: { title: string; body: string; data: Record<string, any>; dedupe: string },
  ) {
    (async () => {
      const memberIds: string[] = await this.memberModel.distinct('user_id', { circle_id: circleId }).exec();
      for (const memberId of memberIds.filter((id) => id !== exceptUserId).slice(0, 200)) {
        this.notificationsService.notifySafely(memberId, {
          type: 'tribe_trip',
          title: n.title,
          body: n.body,
          data: n.data,
          dedupe_key: n.dedupe,
        });
      }
    })().catch((err) => this.logger.warn(`Notifications de tribu non envoyées: ${err.message}`));
  }
}
