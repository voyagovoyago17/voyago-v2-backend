import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PlaceReview, PlaceReviewDocument } from '../places/schemas/place-review.schema';
import { GamificationService } from '../gamification/gamification.service';
import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';
import { CommunityService } from './community.service';
import { CommunityCircle, CommunityCircleDocument } from './schemas/community-circle.schema';
import { CommunityMember, CommunityMemberDocument } from './schemas/community-member.schema';
import { CommunityPost, CommunityPostDocument } from './schemas/community-post.schema';
import { CommunityComment, CommunityCommentDocument } from './schemas/community-comment.schema';
import { CircleTripVote, CircleTripVoteDocument } from './schemas/circle-trip-vote.schema';
import { CircleTripPlan, CircleTripPlanDocument } from './schemas/circle-trip-plan.schema';
import {
  CircleChallengeCompletion,
  CircleChallengeCompletionDocument,
} from './schemas/circle-challenge-completion.schema';

interface ChallengeDef {
  id: string;
  emoji: string;
  title: string;
  description: string;
  /** Objectif de base, relevé pour les grandes tribus */
  baseTarget: number;
  perMember: number;
}

/** Défis renouvelés chaque mois dans chaque cercle, réussis collectivement par ses membres. */
const CHALLENGES: ChallengeDef[] = [
  {
    id: 'trips_shared',
    emoji: '✈️',
    title: 'Partager des voyages',
    description: 'Partagez vos itinéraires dans la tribu',
    baseTarget: 3,
    perMember: 0.2,
  },
  {
    id: 'moments',
    emoji: '📸',
    title: 'Raconter vos moments',
    description: 'Publiez des moments de voyage dans la tribu',
    baseTarget: 8,
    perMember: 0.5,
  },
  {
    id: 'comments',
    emoji: '💬',
    title: 'Faire vivre la discussion',
    description: 'Commentez les publications de la tribu',
    baseTarget: 15,
    perMember: 1,
  },
  {
    id: 'places_reviewed',
    emoji: '⭐',
    title: 'Explorer le terrain',
    description: 'Notez des lieux visités pendant vos voyages',
    baseTarget: 5,
    perMember: 0.5,
  },
  {
    id: 'tribe_votes',
    emoji: '🗳️',
    title: 'Voter en tribu',
    description: 'Votez pour les lieux des voyages de tribu',
    baseTarget: 20,
    perMember: 2,
  },
];

@Injectable()
export class CircleChallengesService {
  private readonly logger = new Logger(CircleChallengesService.name);

  constructor(
    @InjectModel(CommunityCircle.name, TENANT_DB_CONNECTION) private readonly circleModel: Model<CommunityCircleDocument>,
    @InjectModel(CommunityMember.name, TENANT_DB_CONNECTION) private readonly memberModel: Model<CommunityMemberDocument>,
    @InjectModel(CommunityPost.name, TENANT_DB_CONNECTION) private readonly postModel: Model<CommunityPostDocument>,
    @InjectModel(CommunityComment.name, TENANT_DB_CONNECTION) private readonly commentModel: Model<CommunityCommentDocument>,
    @InjectModel(CircleTripPlan.name, TENANT_DB_CONNECTION) private readonly planModel: Model<CircleTripPlanDocument>,
    @InjectModel(CircleTripVote.name, TENANT_DB_CONNECTION) private readonly voteModel: Model<CircleTripVoteDocument>,
    @InjectModel(CircleChallengeCompletion.name, TENANT_DB_CONNECTION)
    private readonly completionModel: Model<CircleChallengeCompletionDocument>,
    @InjectModel(PlaceReview.name, GLOBAL_DB_CONNECTION) private readonly reviewModel: Model<PlaceReviewDocument>,
    private readonly communityService: CommunityService,
    private readonly gamificationService: GamificationService,
  ) {}

  /** Défis du mois en cours, avec la progression de la tribu et la contribution du voyageur. */
  async getChallenges(circleId: string, authHeader?: string) {
    const viewerId = await this.communityService.authUserId(authHeader);
    const circle: any = await this.circleModel.findOne({ id: circleId }).lean().exec();
    if (!circle) {
      throw new NotFoundException('Cercle introuvable');
    }
    await this.communityService.assertCircleAccess(circle, viewerId);

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const period = start.toISOString().slice(0, 7);
    const inPeriod = { $gte: start, $lt: end };

    const memberIds: string[] = await this.memberModel.distinct('user_id', { circle_id: circleId }).exec();
    const members = { $in: memberIds };

    // Contributions du mois : identifiant du membre pour chaque action comptée
    const [sharedTrips, moments, circlePostIds, planIds, reviews] = await Promise.all([
      this.postModel.find({ circle_id: circleId, user_id: members, trip_id: { $ne: null }, created_at: inPeriod }).select('user_id').lean().exec(),
      this.postModel.find({ circle_id: circleId, user_id: members, trip_id: null, created_at: inPeriod }).select('user_id').lean().exec(),
      this.postModel.distinct('id', { circle_id: circleId }).exec() as Promise<string[]>,
      this.planModel.distinct('id', { circle_id: circleId }).exec() as Promise<string[]>,
      this.reviewModel.find({ user_id: members, created_at: inPeriod }).select('user_id').lean().exec(),
    ]);
    const [comments, votes] = await Promise.all([
      this.commentModel
        .find({ target_type: 'post', target_id: { $in: circlePostIds }, user_id: members, created_at: inPeriod })
        .select('user_id')
        .lean()
        .exec(),
      this.voteModel.find({ plan_id: { $in: planIds }, user_id: members, created_at: inPeriod }).select('user_id').lean().exec(),
    ]);

    const contributions: Record<string, string[]> = {
      trips_shared: sharedTrips.map((d: any) => d.user_id),
      moments: moments.map((d: any) => d.user_id),
      comments: comments.map((d: any) => d.user_id),
      places_reviewed: reviews.map((d: any) => d.user_id),
      tribe_votes: votes.map((d: any) => d.user_id),
    };

    return {
      period,
      ends_at: end,
      members_count: memberIds.length,
      challenges: CHALLENGES.map((def) => {
        const contributors = contributions[def.id] || [];
        const target = Math.max(def.baseTarget, Math.ceil(memberIds.length * def.perMember));
        const progress = contributors.length;
        const completed = progress >= target;
        if (completed) {
          this.rewardCompletion(circleId, period, def.id, [...new Set(contributors)]);
        }
        return {
          id: def.id,
          emoji: def.emoji,
          title: def.title,
          description: def.description,
          target,
          progress: Math.min(progress, target),
          completed,
          contributors_count: new Set(contributors).size,
          my_contribution: viewerId ? contributors.filter((id) => id === viewerId).length : 0,
        };
      }),
    };
  }

  /**
   * Défi réussi : XP pour chaque membre qui y a contribué et badge « Esprit de Tribu »
   * au premier défi. Le marqueur de réussite garantit une seule distribution.
   */
  private rewardCompletion(circleId: string, period: string, challengeId: string, contributorIds: string[]) {
    (async () => {
      const res = await this.completionModel
        .updateOne(
          { circle_id: circleId, period, challenge_id: challengeId },
          { $setOnInsert: { rewarded_user_ids: contributorIds } },
          { upsert: true },
        )
        .exec();
      if (!res.upsertedCount) return;
      for (const userId of contributorIds) {
        const awarded = await this.gamificationService.awardXpOnce(
          userId,
          'circle_challenge',
          `${circleId}:${period}:${challengeId}`,
        );
        if (awarded) await this.gamificationService.awardXP(userId, 'esprit_tribu');
      }
    })().catch((err) => this.logger.warn(`Récompenses du défi ${challengeId} non distribuées: ${err.message}`));
  }
}
