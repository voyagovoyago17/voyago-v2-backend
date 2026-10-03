import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { GamificationService } from '../gamification/gamification.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isProActive } from '../pro/pro-status';
import { CircleJoinRules, CommunityCircle, CommunityCircleDocument } from './schemas/community-circle.schema';
import { CommunityMember, CommunityMemberDocument } from './schemas/community-member.schema';
import { CircleJoinRequest, CircleJoinRequestDocument } from './schemas/circle-join-request.schema';
import { UserBlock, UserBlockDocument } from './schemas/user-block.schema';
import { isBlockedBetween } from './blocks';
import { UpdateCircleAccessDto } from './dto/circle-access.dto';
import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';

/** Délai avant de pouvoir redemander après un refus */
const RETRY_AFTER_REJECTION_DAYS = 7;
const MANAGER_ROLES = ['creator', 'admin'];

export interface RuleCheck {
  key: keyof CircleJoinRules;
  label: string;
  ok: boolean | null; // null = non évalué (visiteur non connecté)
  detail?: string;
}

/** Âge en années à partir d'une date de naissance (null si absente ou illisible). */
export function ageFrom(dateOfBirth?: string | null, now = new Date()): number | null {
  if (!dateOfBirth) return null;
  const birth = new Date(dateOfBirth);
  if (isNaN(birth.getTime())) return null;
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age--;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Accès aux cercles privés : conditions d'accès vérifiées automatiquement,
 * demandes d'adhésion et validation par le fondateur / les admins.
 */
@Injectable()
export class CircleAccessService {
  private readonly logger = new Logger(CircleAccessService.name);

  constructor(
    @InjectModel(CommunityCircle.name, TENANT_DB_CONNECTION) private readonly circleModel: Model<CommunityCircleDocument>,
    @InjectModel(CommunityMember.name, TENANT_DB_CONNECTION) private readonly memberModel: Model<CommunityMemberDocument>,
    @InjectModel(CircleJoinRequest.name, TENANT_DB_CONNECTION)
    private readonly requestModel: Model<CircleJoinRequestDocument>,
    @InjectModel(UserBlock.name, TENANT_DB_CONNECTION) private readonly blockModel: Model<UserBlockDocument>,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    private readonly gamificationService: GamificationService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Conditions d'accès
  // ---------------------------------------------------------------------------

  /** Conditions réellement actives d'un cercle (les valeurs vides sont ignorées). */
  activeRules(circle: any): CircleJoinRules {
    const r: CircleJoinRules = circle?.join_rules || {};
    const rules: CircleJoinRules = {};
    if (r.min_level && r.min_level > 1) rules.min_level = r.min_level;
    if (r.min_age && r.min_age > 0) rules.min_age = r.min_age;
    if (r.pro_only) rules.pro_only = true;
    if (r.verified_email) rules.verified_email = true;
    if (r.max_members && r.max_members > 0) rules.max_members = r.max_members;
    return rules;
  }

  /**
   * Vérifie chaque condition pour un voyageur. Sans voyageur, renvoie seulement
   * les libellés (ok = null) pour les afficher sur la carte du cercle.
   */
  async evaluate(circle: any, userId?: string, membersCount?: number): Promise<{ eligible: boolean; checks: RuleCheck[] }> {
    const rules = this.activeRules(circle);
    const keys = Object.keys(rules) as (keyof CircleJoinRules)[];
    if (!keys.length) return { eligible: true, checks: [] };

    const user: any = userId ? await this.userModel.findOne({ user_id: userId }).lean().exec() : null;
    const level = user && rules.min_level ? await this.levelOf(userId!) : null;
    const count =
      rules.max_members !== undefined
        ? membersCount ?? (await this.memberModel.countDocuments({ circle_id: circle.id }).exec())
        : 0;

    const checks: RuleCheck[] = [];
    if (rules.min_level) {
      checks.push({
        key: 'min_level',
        label: `Niveau ${rules.min_level} minimum`,
        ok: user ? (level ?? 1) >= rules.min_level : null,
        detail: user ? `Ton niveau : ${level ?? 1}` : undefined,
      });
    }
    if (rules.min_age) {
      const age = user ? ageFrom(user.date_of_birth) : null;
      checks.push({
        key: 'min_age',
        label: `${rules.min_age} ans ou plus`,
        ok: user ? age !== null && age >= rules.min_age : null,
        detail: user ? (age === null ? 'Ajoute ta date de naissance dans ton profil' : `Tu as ${age} ans`) : undefined,
      });
    }
    if (rules.pro_only) {
      checks.push({
        key: 'pro_only',
        label: 'Membre Voyagooo Pro',
        ok: user ? isProActive(user) : null,
        detail: user && !isProActive(user) ? 'Réservé aux abonnés Pro' : undefined,
      });
    }
    if (rules.verified_email) {
      checks.push({
        key: 'verified_email',
        label: 'Adresse e-mail vérifiée',
        ok: user ? !!user.email_verified : null,
        detail: user && !user.email_verified ? 'Vérifie ton e-mail depuis ton profil' : undefined,
      });
    }
    if (rules.max_members) {
      const left = Math.max(0, rules.max_members - count);
      checks.push({
        key: 'max_members',
        label: `Places limitées (${count}/${rules.max_members})`,
        ok: left > 0,
        detail: left > 0 ? `${left} place${left > 1 ? 's' : ''} restante${left > 1 ? 's' : ''}` : 'Le cercle est complet',
      });
    }
    return { eligible: checks.every((c) => c.ok !== false), checks };
  }

  private async levelOf(userId: string): Promise<number> {
    try {
      const profile: any = await this.gamificationService.getProfile(userId);
      return profile?.level ?? 1;
    } catch {
      return 1;
    }
  }

  /** Refuse l'entrée si une condition n'est pas remplie (adhésion directe ou par code). */
  async assertCanJoin(circle: any, userId: string): Promise<void> {
    const { eligible, checks } = await this.evaluate(circle, userId);
    if (!eligible) {
      const failed = checks.filter((c) => c.ok === false);
      const underAge = failed.some((c) => c.key === 'min_age');
      // Corps structuré : l'app affiche une fenêtre claire (mineurs, places, niveau...)
      throw new ForbiddenException({
        statusCode: 403,
        code: 'JOIN_CONDITIONS',
        message: underAge
          ? `Ce cercle est réservé aux voyageurs de ${this.activeRules(circle).min_age} ans et plus`
          : `Conditions d'accès non remplies : ${failed.map((c) => c.detail || c.label).join(' · ')}`,
        circle_name: circle.name,
        under_age: underAge,
        join_checks: checks,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Membres (réservé aux membres) et gestion par le fondateur
  // ---------------------------------------------------------------------------

  /** Membres d'un cercle, page par page, avec leur niveau (le contenu reste réservé aux membres). */
  async listMembers(viewerId: string | undefined, circleId: string, skip = 0, limit = 30) {
    const circle: any = await this.circleModel.findOne({ $or: [{ id: circleId }, { slug: circleId }] }).lean().exec();
    if (!circle) throw new NotFoundException('Cercle introuvable');
    const viewer: any = viewerId
      ? await this.memberModel.findOne({ circle_id: circle.id, user_id: viewerId }).lean().exec()
      : null;
    if (!circle.is_public && !viewer) {
      throw new ForbiddenException('La liste des membres est réservée aux membres du cercle');
    }

    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const [members, total]: [any[], number] = await Promise.all([
      // Fondateur, puis admins, puis les arrivées les plus récentes
      this.memberModel
        .aggregate([
          { $match: { circle_id: circle.id } },
          {
            $addFields: {
              rank: { $switch: { branches: [{ case: { $eq: ['$role', 'creator'] }, then: 0 }, { case: { $eq: ['$role', 'admin'] }, then: 1 }], default: 2 } },
            },
          },
          { $sort: { rank: 1, joined_at: -1 } },
          { $skip: Math.max(skip, 0) },
          { $limit: safeLimit },
        ])
        .exec(),
      this.memberModel.countDocuments({ circle_id: circle.id }).exec(),
    ]);
    const hidden = new Set(
      viewerId
        ? (
            await this.blockModel
              .find({ $or: [{ blocker_id: viewerId }, { blocked_id: viewerId }] })
              .select('blocker_id blocked_id')
              .lean()
              .exec()
          ).map((b: any) => (b.blocker_id === viewerId ? b.blocked_id : b.blocker_id))
        : [],
    );
    const users: any[] = await this.userModel.find({ user_id: { $in: members.map((m) => m.user_id) } }).lean().exec();
    const userMap = new Map(users.map((u) => [u.user_id, u]));

    const items = await Promise.all(
      members
        .filter((m) => !hidden.has(m.user_id))
        .map(async (m) => {
          const u = userMap.get(m.user_id);
          return {
            user_id: m.user_id,
            role: m.role,
            joined_at: m.joined_at,
            name: u?.name || 'Voyageur',
            pseudo: u?.pseudo || null,
            avatar_emoji: u?.avatar_emoji || '🧭',
            picture: u?.picture || null,
            country: u?.country || null,
            is_pro: isProActive(u),
            email_verified: !!u?.email_verified,
            level: await this.levelOf(m.user_id),
          };
        }),
    );
    const rules = this.activeRules(circle);
    return {
      circle_id: circle.id,
      total,
      max_members: rules.max_members ?? null,
      my_role: viewer?.role ?? null,
      has_more: skip + members.length < total,
      members: items,
    };
  }

  /** Retirer un membre : le fondateur retire n'importe qui, un admin seulement les explorateurs. */
  async removeMember(managerId: string, circleId: string, memberId: string) {
    const circle = await this.assertManager(managerId, circleId);
    if (managerId === memberId) throw new BadRequestException('Pour partir, utilise « Quitter le cercle »');
    const [manager, target]: any[] = await Promise.all([
      this.memberModel.findOne({ circle_id: circle.id, user_id: managerId }).lean().exec(),
      this.memberModel.findOne({ circle_id: circle.id, user_id: memberId }).lean().exec(),
    ]);
    if (!target) throw new NotFoundException("Ce voyageur n'est pas membre du cercle");
    if (target.role === 'creator' || (manager.role === 'admin' && target.role === 'admin')) {
      throw new ForbiddenException('Tu ne peux pas retirer ce membre');
    }
    await this.memberModel.deleteOne({ circle_id: circle.id, user_id: memberId }).exec();
    const count = await this.memberModel.countDocuments({ circle_id: circle.id }).exec();
    await this.circleModel.updateOne({ id: circle.id }, { $set: { members_count: count } }).exec();
    return { removed: true, circle_id: circle.id, members_count: count };
  }

  /** Nommer ou retirer un admin (fondateur uniquement). */
  async setMemberRole(founderId: string, circleId: string, memberId: string, role: 'admin' | 'explorer') {
    const circle = await this.assertManager(founderId, circleId);
    const founder: any = await this.memberModel.findOne({ circle_id: circle.id, user_id: founderId }).lean().exec();
    if (founder?.role !== 'creator') throw new ForbiddenException('Seul le fondateur nomme les admins');
    if (founderId === memberId) throw new BadRequestException('Le fondateur reste fondateur');
    const res = await this.memberModel
      .updateOne({ circle_id: circle.id, user_id: memberId, role: { $ne: 'creator' } }, { $set: { role } })
      .exec();
    if (res.matchedCount === 0) throw new NotFoundException("Ce voyageur n'est pas membre du cercle");
    if (role === 'admin') {
      this.notificationsService.notifySafely(memberId, {
        type: 'circle_request',
        title: `⭐ Tu es maintenant admin de « ${circle.name} »`,
        body: "Tu peux accepter les demandes et gérer les conditions d'accès.",
        data: { circle_id: circle.id, circle_name: circle.name, kind: 'promoted' },
      });
    }
    return { user_id: memberId, role };
  }

  // ---------------------------------------------------------------------------
  // Informations affichées aux visiteurs
  // ---------------------------------------------------------------------------

  /** État de ma demande pour plusieurs cercles (liste des cercles). */
  async myRequestStatuses(userId: string | undefined, circleIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!userId || !circleIds.length) return map;
    const since = new Date(Date.now() - RETRY_AFTER_REJECTION_DAYS * 24 * 3600 * 1000);
    const requests: any[] = await this.requestModel
      .find({
        user_id: userId,
        circle_id: { $in: circleIds },
        $or: [{ status: 'pending' }, { status: 'rejected', decided_at: { $gte: since } }],
      })
      .sort({ created_at: -1 })
      .lean()
      .exec();
    for (const r of requests) {
      if (!map.has(r.circle_id)) map.set(r.circle_id, r.status);
    }
    return map;
  }

  /** Nombre de demandes en attente pour les cercles que je gère. */
  async pendingCounts(circleIds: string[]): Promise<Map<string, number>> {
    if (!circleIds.length) return new Map();
    const rows = await this.requestModel.aggregate([
      { $match: { circle_id: { $in: circleIds }, status: 'pending' } },
      { $group: { _id: '$circle_id', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r: any) => [r._id, r.count]));
  }

  /** Bloc « accès » d'un cercle : conditions, question et ma situation. */
  async accessInfo(circle: any, viewerId?: string, membersCount?: number) {
    const { eligible, checks } = await this.evaluate(circle, viewerId, membersCount);
    const status = viewerId ? (await this.myRequestStatuses(viewerId, [circle.id])).get(circle.id) || null : null;
    return {
      join_rules: this.activeRules(circle),
      join_checks: checks,
      eligible,
      auto_approve: !!circle.auto_approve,
      join_question: circle.join_question || '',
      my_request_status: status,
    };
  }

  // ---------------------------------------------------------------------------
  // Demandes d'adhésion
  // ---------------------------------------------------------------------------

  async requestJoin(userId: string, circleId: string, message?: string) {
    const circle: any = await this.circleModel.findOne({ id: circleId }).lean().exec();
    if (!circle || (!circle.is_public && circle.listed === false)) {
      throw new NotFoundException('Cercle introuvable');
    }
    if (circle.is_public) {
      throw new BadRequestException('Ce cercle est public : rejoins-le directement');
    }
    if (await this.memberModel.exists({ circle_id: circle.id, user_id: userId })) {
      return { status: 'member', circle_id: circle.id, message: 'Tu fais déjà partie de ce cercle' };
    }
    if (await isBlockedBetween(this.blockModel, userId, circle.creator_id)) {
      throw new ForbiddenException("Impossible de rejoindre ce cercle");
    }

    const pending = await this.requestModel.findOne({ circle_id: circle.id, user_id: userId, status: 'pending' }).lean().exec();
    if (pending) {
      return { status: 'pending', circle_id: circle.id, message: 'Ta demande est déjà en attente de réponse' };
    }

    const lastRejection: any = await this.requestModel
      .findOne({ circle_id: circle.id, user_id: userId, status: 'rejected' })
      .sort({ decided_at: -1 })
      .lean()
      .exec();
    if (lastRejection?.decided_at) {
      const retryAt = new Date(new Date(lastRejection.decided_at).getTime() + RETRY_AFTER_REJECTION_DAYS * 24 * 3600 * 1000);
      if (retryAt > new Date()) {
        return {
          status: 'rejected',
          circle_id: circle.id,
          retry_after: retryAt,
          message: `Ta demande n'a pas été retenue. Tu pourras redemander à partir du ${retryAt.toLocaleDateString('fr-FR')}.`,
        };
      }
    }

    // Conditions non remplies : refus automatique immédiat, avec les raisons
    const { eligible, checks } = await this.evaluate(circle, userId);
    if (!eligible) {
      return {
        status: 'refused',
        circle_id: circle.id,
        join_checks: checks,
        message: "Tu ne remplis pas encore les conditions d'accès de ce cercle",
      };
    }

    // Acceptation automatique choisie par le fondateur
    if (circle.auto_approve) {
      await this.addMember(circle, userId);
      this.notifyManagers(circle, userId, 'joined');
      return { status: 'joined', circle_id: circle.id, message: `Bienvenue dans « ${circle.name} » !` };
    }

    let request: any;
    try {
      request = await this.requestModel.create({
        id: crypto.randomUUID(),
        circle_id: circle.id,
        user_id: userId,
        status: 'pending',
        message: (message || '').trim().slice(0, 500),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        return { status: 'pending', circle_id: circle.id, message: 'Ta demande est déjà en attente de réponse' };
      }
      throw err;
    }
    this.notifyManagers(circle, userId, 'request', request.id);
    return {
      status: 'pending',
      circle_id: circle.id,
      request_id: request.id,
      message: 'Demande envoyée ! Tu seras prévenu dès que le fondateur aura répondu.',
    };
  }

  async cancelRequest(userId: string, circleId: string) {
    const res = await this.requestModel
      .updateOne({ circle_id: circleId, user_id: userId, status: 'pending' }, { $set: { status: 'cancelled' } })
      .exec();
    return { cancelled: res.modifiedCount > 0, circle_id: circleId };
  }

  /** Demandes d'un cercle, avec le profil de chaque voyageur (fondateur / admins). */
  async listRequests(managerId: string, circleId: string, status = 'pending') {
    const circle = await this.assertManager(managerId, circleId);
    const requests: any[] = await this.requestModel
      .find({ circle_id: circle.id, status: status === 'all' ? { $in: ['pending', 'accepted', 'rejected'] } : status })
      .sort({ created_at: -1 })
      .limit(100)
      .lean()
      .exec();
    if (!requests.length) return { circle_id: circle.id, join_question: circle.join_question || '', requests: [] };

    const userIds = requests.map((r) => r.user_id);
    const users: any[] = await this.userModel.find({ user_id: { $in: userIds } }).lean().exec();
    const userMap = new Map(users.map((u) => [u.user_id, u]));
    const membersCount = await this.memberModel.countDocuments({ circle_id: circle.id }).exec();

    const items = await Promise.all(
      requests.map(async (r) => {
        const u = userMap.get(r.user_id);
        let profile: any = null;
        try {
          profile = await this.gamificationService.getProfile(r.user_id);
        } catch {
          profile = null;
        }
        const { eligible, checks } = r.status === 'pending' ? await this.evaluate(circle, r.user_id, membersCount) : { eligible: true, checks: [] };
        return {
          id: r.id,
          status: r.status,
          message: r.message || '',
          created_at: r.created_at,
          decided_at: r.decided_at,
          eligible,
          join_checks: checks,
          user: {
            user_id: r.user_id,
            name: u?.name || 'Voyageur',
            pseudo: u?.pseudo || null,
            avatar_emoji: u?.avatar_emoji || '🧭',
            picture: u?.picture || null,
            country: u?.country || null,
            city: u?.city || null,
            age: ageFrom(u?.date_of_birth),
            is_pro: isProActive(u),
            email_verified: !!u?.email_verified,
            member_since: u?.created_at || null,
            level: profile?.level ?? 1,
            xp: profile?.xp ?? 0,
            trips_count: profile?.trips_count ?? 0,
            badges_count: Array.isArray(profile?.badges) ? profile.badges.length : 0,
          },
        };
      }),
    );
    return { circle_id: circle.id, join_question: circle.join_question || '', requests: items };
  }

  async decide(managerId: string, requestId: string, decision: 'accept' | 'reject') {
    const request: any = await this.requestModel.findOne({ id: requestId }).lean().exec();
    if (!request) throw new NotFoundException('Demande introuvable');
    const circle = await this.assertManager(managerId, request.circle_id);
    if (request.status !== 'pending') {
      return { id: request.id, status: request.status, message: 'Cette demande a déjà été traitée' };
    }

    if (decision === 'accept') {
      const rules = this.activeRules(circle);
      if (rules.max_members) {
        const count = await this.memberModel.countDocuments({ circle_id: circle.id }).exec();
        if (count >= rules.max_members) {
          throw new BadRequestException('Le cercle est complet : augmente le nombre de places pour accepter');
        }
      }
      await this.addMember(circle, request.user_id);
    }

    const status = decision === 'accept' ? 'accepted' : 'rejected';
    await this.requestModel
      .updateOne({ id: request.id, status: 'pending' }, { $set: { status, decided_by: managerId, decided_at: new Date() } })
      .exec();

    this.notificationsService.notifySafely(request.user_id, {
      type: 'circle_request',
      title:
        decision === 'accept'
          ? `🎉 Bienvenue dans « ${circle.name} » !`
          : `Ta demande pour « ${circle.name} » n'a pas été retenue`,
      body:
        decision === 'accept'
          ? 'Ta demande a été acceptée : découvre les voyages et les projets de la tribu.'
          : `Tu pourras retenter ta chance dans ${RETRY_AFTER_REJECTION_DAYS} jours, ou explorer d'autres cercles.`,
      data: { circle_id: circle.id, circle_name: circle.name, kind: status },
      dedupe_key: `circle_request_${status}:${request.id}`,
    });
    return { id: request.id, status, circle_id: circle.id };
  }

  /** Réglages d'accès : conditions, acceptation automatique, question, visibilité. */
  async updateSettings(managerId: string, circleId: string, dto: UpdateCircleAccessDto) {
    const circle = await this.assertManager(managerId, circleId);
    const set: Record<string, any> = {};
    if (dto.join_rules) {
      const rules: CircleJoinRules = { ...(circle.join_rules || {}) };
      for (const [key, value] of Object.entries(dto.join_rules)) {
        if (value === null || value === undefined || value === false || value === 0) delete (rules as any)[key];
        else (rules as any)[key] = value;
      }
      set.join_rules = rules;
    }
    if (dto.auto_approve !== undefined) set.auto_approve = dto.auto_approve;
    if (dto.join_question !== undefined) set.join_question = dto.join_question.trim();
    if (dto.listed !== undefined) set.listed = dto.listed;
    if (Object.keys(set).length) {
      await this.circleModel.updateOne({ id: circle.id }, { $set: set }).exec();
    }
    const updated: any = await this.circleModel.findOne({ id: circle.id }).lean().exec();
    return {
      circle_id: circle.id,
      join_rules: this.activeRules(updated),
      auto_approve: !!updated.auto_approve,
      join_question: updated.join_question || '',
      listed: updated.listed !== false,
    };
  }

  /** Après une entrée par code : une éventuelle demande en attente est close. */
  async resolvePendingOnJoin(circleId: string, userId: string) {
    await this.requestModel
      .updateOne(
        { circle_id: circleId, user_id: userId, status: 'pending' },
        { $set: { status: 'accepted', decided_at: new Date() } },
      )
      .exec()
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------

  private async assertManager(userId: string, circleId: string): Promise<any> {
    const circle: any = await this.circleModel.findOne({ id: circleId }).lean().exec();
    if (!circle) throw new NotFoundException('Cercle introuvable');
    const membership: any = await this.memberModel.findOne({ circle_id: circle.id, user_id: userId }).lean().exec();
    if (!MANAGER_ROLES.includes(membership?.role)) {
      throw new ForbiddenException('Seuls le fondateur et les admins gèrent les accès du cercle');
    }
    return circle;
  }

  private async addMember(circle: any, userId: string) {
    try {
      await this.memberModel.create({ circle_id: circle.id, user_id: userId, role: 'explorer', joined_at: new Date() });
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // déjà membre
    }
    const count = await this.memberModel.countDocuments({ circle_id: circle.id }).exec();
    await this.circleModel.updateOne({ id: circle.id }, { $set: { members_count: count } }).exec();
  }

  /** Prévient le fondateur et les admins (nouvelle demande, ou entrée automatique). */
  private notifyManagers(circle: any, requesterId: string, kind: 'request' | 'joined', requestId?: string) {
    (async () => {
      const [requester, managers]: [any, any[]] = await Promise.all([
        this.userModel.findOne({ user_id: requesterId }).lean().exec(),
        this.memberModel.find({ circle_id: circle.id, role: { $in: MANAGER_ROLES } }).lean().exec(),
      ]);
      const who = requester?.pseudo || requester?.name || 'Un voyageur';
      for (const m of managers) {
        if (m.user_id === requesterId) continue;
        this.notificationsService.notifySafely(m.user_id, {
          type: 'circle_request',
          title: kind === 'request' ? `🔐 ${who} demande à rejoindre « ${circle.name} »` : `👋 ${who} a rejoint « ${circle.name} »`,
          body:
            kind === 'request'
              ? 'Consulte son profil pour accepter ou refuser sa demande.'
              : "Il remplissait toutes les conditions d'accès : entrée automatique.",
          data: { circle_id: circle.id, circle_name: circle.name, kind, request_id: requestId || null, user_id: requesterId },
          dedupe_key: requestId ? `circle_request_new:${requestId}` : undefined,
        });
      }
    })().catch((err) => this.logger.warn(`Notification de demande non envoyée : ${err.message}`));
  }
}
