import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { Trip, TripDocument } from '../trips/schemas/trip.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { canViewTrip } from '../trips/trip-visibility';
import { CircleAccessService } from './circle-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';
import { CommunityService } from './community.service';
import { CommunityCircle, CommunityCircleDocument } from './schemas/community-circle.schema';
import { CommunityMember, CommunityMemberDocument } from './schemas/community-member.schema';
import { CommunityPost, CommunityPostDocument } from './schemas/community-post.schema';
import {
  CommentTargetType,
  CommunityComment,
  CommunityCommentDocument,
} from './schemas/community-comment.schema';
import { CommunityReport, CommunityReportDocument, ReportTargetType } from './schemas/community-report.schema';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UserBlock, UserBlockDocument } from './schemas/user-block.schema';
import { hiddenUserIds, isBlockedBetween } from './blocks';
import { GamificationService } from '../gamification/gamification.service';

/** Contenu commenté : son auteur et ceux qui peuvent modérer ses commentaires. */
interface CommentTarget {
  ownerId: string;
  moderatorIds: string[];
  label: string;
  circleId?: string;
}

/**
 * Interactions sociales : commentaires (avec réponses), suppression et signalements.
 * Les droits suivent la visibilité : on ne commente que ce qu'on peut voir.
 */
@Injectable()
export class CommunitySocialService {
  private readonly logger = new Logger(CommunitySocialService.name);

  constructor(
    @InjectModel(Trip.name, TENANT_DB_CONNECTION) private readonly sharedTripModel: Model<TripDocument>,
    @InjectModel(CommunityCircle.name, TENANT_DB_CONNECTION) private readonly circleModel: Model<CommunityCircleDocument>,
    @InjectModel(CommunityMember.name, TENANT_DB_CONNECTION) private readonly memberModel: Model<CommunityMemberDocument>,
    @InjectModel(CommunityPost.name, TENANT_DB_CONNECTION) private readonly postModel: Model<CommunityPostDocument>,
    @InjectModel(CommunityComment.name, TENANT_DB_CONNECTION) private readonly commentModel: Model<CommunityCommentDocument>,
    @InjectModel(CommunityReport.name, TENANT_DB_CONNECTION) private readonly reportModel: Model<CommunityReportDocument>,
    @InjectModel(UserBlock.name, TENANT_DB_CONNECTION) private readonly blockModel: Model<UserBlockDocument>,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    private readonly communityService: CommunityService,
    private readonly notificationsService: NotificationsService,
    private readonly gamificationService: GamificationService,
    private readonly circleAccess: CircleAccessService,
  ) {}

  // =========================================================================
  // ACCÈS AUX CONTENUS
  // =========================================================================

  /** Vérifie que `viewerId` peut voir le contenu (404 sinon) et renvoie qui le modère. */
  private async resolveTarget(type: CommentTargetType, id: string, viewerId?: string): Promise<CommentTarget> {
    const target = await this.resolveVisibleTarget(type, id, viewerId);
    // Contenu d'un voyageur bloqué (dans un sens ou dans l'autre) : inexistant pour le lecteur
    if (await isBlockedBetween(this.blockModel, viewerId, target.ownerId)) {
      throw new NotFoundException(type === 'trip' ? 'Voyage introuvable' : 'Publication introuvable');
    }
    return target;
  }

  private async resolveVisibleTarget(type: CommentTargetType, id: string, viewerId?: string): Promise<CommentTarget> {
    if (type === 'trip') {
      const trip: any = await this.sharedTripModel
        .findOne({ id })
        .select('user_id visibility is_public destination')
        .lean()
        .exec();
      if (!trip || !(await canViewTrip(this.memberModel, trip, viewerId))) {
        throw new NotFoundException('Voyage introuvable');
      }
      return { ownerId: trip.user_id, moderatorIds: [trip.user_id], label: `ton voyage ${trip.destination}` };
    }

    const post: any = await this.postModel.findOne({ id }).select('user_id circle_id').lean().exec();
    const circle: any = post ? await this.circleModel.findOne({ id: post.circle_id }).lean().exec() : null;
    if (!post || !circle) {
      throw new NotFoundException('Publication introuvable');
    }
    await this.communityService.assertCircleAccess(circle, viewerId);
    const circleModerators: string[] = await this.memberModel
      .distinct('user_id', { circle_id: circle.id, role: { $in: ['creator', 'admin'] } })
      .exec();
    return {
      ownerId: post.user_id,
      moderatorIds: [post.user_id, ...circleModerators],
      label: `ta publication dans « ${circle.name} »`,
      circleId: circle.id,
    };
  }

  private async incrementCommentCount(type: CommentTargetType, id: string, delta: number) {
    const model: Model<any> = type === 'trip' ? this.sharedTripModel : this.postModel;
    await model.updateOne({ id }, { $inc: { comments_count: delta } }).exec();
    if (delta < 0) {
      // Ne jamais descendre sous zéro (anciens contenus sans compteur)
      await model.updateOne({ id, comments_count: { $lt: 0 } }, { $set: { comments_count: 0 } }).exec();
    }
  }

  private async authorsById(userIds: string[]) {
    const users: any[] = await this.userModel
      .find({ user_id: { $in: [...new Set(userIds)] } })
      .select('user_id name pseudo avatar_emoji picture is_pro')
      .lean()
      .exec();
    return new Map(
      users.map((u) => [
        u.user_id,
        {
          user_id: u.user_id,
          name: u.name,
          pseudo: u.pseudo || null,
          avatar_emoji: u.avatar_emoji || null,
          picture: u.picture || null,
          is_pro: u.is_pro || false,
        },
      ]),
    );
  }

  private toCommentDto(c: any, authors: Map<string, any>, viewerId: string | undefined, target: CommentTarget) {
    return {
      id: c.id,
      target_type: c.target_type,
      target_id: c.target_id,
      parent_id: c.parent_id || null,
      content: c.content,
      created_at: c.created_at,
      author: authors.get(c.user_id) || { user_id: c.user_id, name: 'Voyageur' },
      can_delete: !!viewerId && (c.user_id === viewerId || target.moderatorIds.includes(viewerId)),
    };
  }

  // =========================================================================
  // COMMENTAIRES
  // =========================================================================

  /** Commentaires d'un contenu, du plus ancien au plus récent (les réponses portent parent_id). */
  async listComments(type: CommentTargetType, targetId: string, authHeader?: string) {
    const viewerId = await this.communityService.authUserId(authHeader);
    const target = await this.resolveTarget(type, targetId, viewerId);

    const hidden = await hiddenUserIds(this.blockModel, viewerId);
    const comments: any[] = await this.commentModel
      .find({ target_type: type, target_id: targetId, ...(hidden.length ? { user_id: { $nin: hidden } } : {}) })
      .sort({ created_at: 1 })
      .limit(500)
      .lean()
      .exec();
    const authors = await this.authorsById(comments.map((c) => c.user_id));
    return comments.map((c) => this.toCommentDto(c, authors, viewerId, target));
  }

  async addComment(userId: string, dto: CreateCommentDto) {
    const target = await this.resolveTarget(dto.target_type, dto.target_id, userId);
    if (target.circleId) await this.circleAccess.assertCanContribute(target.circleId, userId);
    const content = dto.content.trim();
    if (!content) {
      throw new BadRequestException('Commentaire vide');
    }

    // Une réponse se rattache toujours au commentaire racine (un seul niveau)
    let parent: any = null;
    if (dto.parent_id) {
      parent = await this.commentModel
        .findOne({ id: dto.parent_id, target_type: dto.target_type, target_id: dto.target_id })
        .lean()
        .exec();
      if (!parent || (await isBlockedBetween(this.blockModel, userId, parent.user_id))) {
        throw new NotFoundException('Commentaire introuvable');
      }
    }

    const comment = await this.commentModel.create({
      id: crypto.randomUUID(),
      target_type: dto.target_type,
      target_id: dto.target_id,
      user_id: userId,
      content,
      parent_id: parent ? parent.parent_id || parent.id : null,
    });
    await this.incrementCommentCount(dto.target_type, dto.target_id, 1);
    this.rewardComment(userId);

    const authors = await this.authorsById([userId]);
    const author = authors.get(userId);
    const who = author?.pseudo || author?.name || 'Un voyageur';
    const data = {
      target_type: dto.target_type,
      target_id: dto.target_id,
      comment_id: comment.id,
      ...(target.circleId ? { circle_id: target.circleId } : {}),
      ...(dto.target_type === 'trip' ? { trip_id: dto.target_id } : {}),
    };
    const excerpt = content.length > 120 ? `${content.slice(0, 117)}...` : content;

    if (target.ownerId !== userId) {
      this.notificationsService.notifySafely(target.ownerId, {
        type: 'comment',
        title: `💬 ${who} a commenté ${target.label}`,
        body: excerpt,
        data,
      });
    }
    if (parent && parent.user_id !== userId && parent.user_id !== target.ownerId) {
      this.notificationsService.notifySafely(parent.user_id, {
        type: 'comment',
        title: `↩️ ${who} a répondu à ton commentaire`,
        body: excerpt,
        data,
      });
    }

    return this.toCommentDto(comment.toObject(), authors, userId, target);
  }

  /** XP d'engagement : 1 XP par commentaire (5 par jour max) et badge « Bavard » au premier. */
  private rewardComment(userId: string) {
    (async () => {
      await this.gamificationService.awardXP(userId, 'comment');
      await this.gamificationService.awardXP(userId, 'first_comment');
    })().catch((err) => this.logger.warn(`XP commentaire non attribuée à ${userId}: ${err.message}`));
  }

  /** Supprime un commentaire (et ses réponses) : son auteur, l'auteur du contenu ou un modérateur du cercle. */
  async deleteComment(userId: string, commentId: string) {
    const comment: any = await this.commentModel.findOne({ id: commentId }).lean().exec();
    if (!comment) {
      throw new NotFoundException('Commentaire introuvable');
    }
    if (comment.user_id !== userId) {
      const target = await this.resolveTarget(comment.target_type, comment.target_id, userId);
      if (!target.moderatorIds.includes(userId)) {
        throw new ForbiddenException('Tu ne peux pas supprimer ce commentaire');
      }
    }

    const res = await this.commentModel
      .deleteMany({ $or: [{ id: commentId }, { parent_id: commentId }] })
      .exec();
    await this.incrementCommentCount(comment.target_type, comment.target_id, -res.deletedCount);
    return { deleted: true, comment_id: commentId, deleted_count: res.deletedCount };
  }

  // =========================================================================
  // MODÉRATION
  // =========================================================================

  /** Supprime une publication de cercle : son auteur ou un créateur / admin du cercle. */
  async deletePost(userId: string, postId: string) {
    const post: any = await this.postModel.findOne({ id: postId }).lean().exec();
    if (!post) {
      throw new NotFoundException('Publication introuvable');
    }
    if (post.user_id !== userId) {
      const target = await this.resolveTarget('post', postId, userId);
      if (!target.moderatorIds.includes(userId)) {
        throw new ForbiddenException('Tu ne peux pas supprimer cette publication');
      }
    }

    await Promise.all([
      this.postModel.deleteOne({ id: postId }).exec(),
      this.commentModel.deleteMany({ target_type: 'post', target_id: postId }).exec(),
    ]);
    const [postsCount, tripsCount] = await Promise.all([
      this.postModel.countDocuments({ circle_id: post.circle_id }).exec(),
      this.postModel.countDocuments({ circle_id: post.circle_id, trip_id: { $ne: null } }).exec(),
    ]);
    await this.circleModel
      .updateOne({ id: post.circle_id }, { $set: { posts_count: postsCount, trips_count: tripsCount } })
      .exec();
    return { deleted: true, post_id: postId, circle_id: post.circle_id };
  }

  /** Signale un contenu visible par le voyageur ; un second signalement est ignoré. */
  async report(userId: string, type: ReportTargetType, targetId: string, reason?: string) {
    let reportedUserId: string;
    if (type === 'comment') {
      const comment: any = await this.commentModel.findOne({ id: targetId }).lean().exec();
      if (!comment) throw new NotFoundException('Commentaire introuvable');
      await this.resolveTarget(comment.target_type, comment.target_id, userId);
      reportedUserId = comment.user_id;
    } else {
      reportedUserId = (await this.resolveTarget(type, targetId, userId)).ownerId;
    }

    await this.reportModel
      .updateOne(
        { target_type: type, target_id: targetId, reporter_id: userId },
        {
          $setOnInsert: {
            reported_user_id: reportedUserId,
            reason: reason?.trim() || '',
            status: 'open',
          },
        },
        { upsert: true },
      )
      .exec();
    this.logger.warn(`Signalement ${type} ${targetId} par ${userId}`);
    return { reported: true };
  }
}
