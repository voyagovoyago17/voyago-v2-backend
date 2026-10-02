import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { Trip, TripDocument, TripSchema } from '../trips/schemas/trip.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { UserSession, UserSessionDocument } from '../auth/schemas/user-session.schema';
import { ProfileSchema } from '../gamification/schemas/profile.schema';
import { TenancyService } from '../tenancy/tenancy.service';
import { GamificationService } from '../gamification/gamification.service';
import { CommunityCircle, CommunityCircleDocument } from './schemas/community-circle.schema';
import { CommunityMember, CommunityMemberDocument } from './schemas/community-member.schema';
import { CommunityPost, CommunityPostDocument } from './schemas/community-post.schema';
import { CreateCircleDto } from './dto/create-circle.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { ShareTripToCircleDto } from './dto/share-trip.dto';

import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';
import { TripsService } from '../trips/trips.service';
import { canViewTrip, tribeMateIds, tripVisibility, widerVisibility } from '../trips/trip-visibility';

// Sans caractères ambigus (0/O, 1/I/L) pour un code facile à dicter
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LENGTH = 8;

@Injectable()
export class CommunityService {
  private readonly logger = new Logger(CommunityService.name);

  constructor(
    @InjectModel(Trip.name, TENANT_DB_CONNECTION) private readonly sharedTripModel: Model<TripDocument>,
    @InjectModel(CommunityCircle.name, TENANT_DB_CONNECTION) private readonly circleModel: Model<CommunityCircleDocument>,
    @InjectModel(CommunityMember.name, TENANT_DB_CONNECTION) private readonly memberModel: Model<CommunityMemberDocument>,
    @InjectModel(CommunityPost.name, TENANT_DB_CONNECTION) private readonly postModel: Model<CommunityPostDocument>,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    @InjectModel(UserSession.name, GLOBAL_DB_CONNECTION) private readonly sessionModel: Model<UserSessionDocument>,
    private readonly tenancyService: TenancyService,
    private readonly gamificationService: GamificationService,
    private readonly tripsService: TripsService,
  ) {}

  // =========================================================================
  // HELPER: RÉSOLUTION D'UTILISATEUR VIA HEADER D'AUTHENTIFICATION
  // =========================================================================

  private async resolveUserId(currentUserId?: string, authHeader?: string): Promise<string | undefined> {
    if (currentUserId && currentUserId.trim().length > 0) {
      return currentUserId.trim();
    }
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        const session = await this.sessionModel.findOne({ session_token: token }).lean().exec();
        if (session && session.expires_at > new Date()) {
          return session.user_id;
        }
      }
    }
    return undefined;
  }

  /** Utilisateur authentifié par son jeton uniquement (jamais par un paramètre de requête). */
  authUserId(authHeader?: string): Promise<string | undefined> {
    return this.resolveUserId(undefined, authHeader);
  }

  /**
   * Un cercle privé n'existe que pour ses membres : les autres reçoivent un 404,
   * pour ne pas révéler son existence.
   */
  async assertCircleAccess(circle: any, userId?: string): Promise<any | null> {
    const membership = userId
      ? await this.memberModel.findOne({ circle_id: circle.id, user_id: userId }).lean().exec()
      : null;
    if (!circle.is_public && !membership) {
      throw new NotFoundException('Cercle introuvable');
    }
    return membership;
  }

  private async generateInviteCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = crypto.randomBytes(INVITE_CODE_LENGTH);
      const code = Array.from(bytes, (b) => INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length]).join('');
      if (!(await this.circleModel.exists({ invite_code: code }))) {
        return code;
      }
    }
    throw new BadRequestException("Impossible de générer un code d'invitation, réessaie");
  }

  private withoutInviteCode<T extends { invite_code?: string | null }>(circle: T): Omit<T, 'invite_code'> {
    const { invite_code, ...rest } = circle;
    return rest;
  }

  // =========================================================================
  // 1. PUBLIC FEED & PUBLIC PROFILES (LOGIQUE EXISTANTE PRÉSERVÉE)
  // =========================================================================

  /** Voyages publics, plus ceux « tribu » des membres de mes cercles si je suis connecté. */
  async getPublicFeed(authHeader?: string): Promise<object[]> {
    const viewerId = await this.authUserId(authHeader);
    const filter: any = viewerId
      ? {
          $or: [
            { is_public: true },
            { visibility: 'tribe', user_id: { $in: await tribeMateIds(this.memberModel, viewerId) } },
          ],
        }
      : { is_public: true };

    const trips = await this.sharedTripModel
      .find(filter)
      .sort({ created_at: -1 })
      .limit(50)
      .lean()
      .exec();

    const userIds = [...new Set(trips.map((t) => t.user_id))];
    const users = await this.userModel
      .find({ user_id: { $in: userIds } })
      .lean()
      .exec();

    const userMap = new Map(users.map((u) => [u.user_id, u]));

    return trips.map((trip: any) => {
      const author = userMap.get(trip.user_id);
      const cover = trip.cover_image_url || trip.pois?.[0]?.image_url || null;
      return {
        ...trip,
        visibility: tripVisibility(trip),
        cover_image_url: cover,
        author: author
          ? {
              user_id: author.user_id,
              name: author.name,
              pseudo: author.pseudo || null,
              avatar_emoji: author.avatar_emoji || null,
              picture: author.picture || null,
              is_pro: author.is_pro || false,
            }
          : null,
      };
    });
  }

  /**
   * Fil d'actualité façon réseau social, du plus récent au plus ancien :
   * - voyages publics, et ceux « tribu » des membres de mes cercles
   * - publications de tous les cercles dont je suis membre
   * Pagination par curseur : `before` = created_at du dernier élément reçu.
   */
  async getHomeFeed(authHeader?: string, before?: string, limit = 20): Promise<object> {
    const viewerId = await this.authUserId(authHeader);
    const pageSize = Math.min(Math.max(limit || 20, 1), 50);
    const parsedBefore = before ? new Date(before) : null;
    const beforeDate = parsedBefore && !isNaN(parsedBefore.getTime()) ? parsedBefore : new Date();

    const [mates, myCircleIds] = viewerId
      ? await Promise.all([
          tribeMateIds(this.memberModel, viewerId),
          this.memberModel.distinct('circle_id', { user_id: viewerId }).exec() as Promise<string[]>,
        ])
      : [[] as string[], [] as string[]];

    const tripFilter: any = {
      created_at: { $lt: beforeDate },
      $or: [{ is_public: true }, ...(viewerId ? [{ visibility: 'tribe', user_id: { $in: mates } }] : [])],
    };

    const [trips, posts]: [any[], any[]] = await Promise.all([
      this.sharedTripModel.find(tripFilter).select('-weather').sort({ created_at: -1 }).limit(pageSize).lean().exec(),
      myCircleIds.length
        ? this.postModel
            .find({ circle_id: { $in: myCircleIds }, created_at: { $lt: beforeDate } })
            .sort({ created_at: -1 })
            .limit(pageSize)
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    const merged = [
      ...trips.map((t) => ({ kind: 'trip' as const, doc: t, at: new Date(t.created_at) })),
      ...posts.map((p) => ({ kind: 'post' as const, doc: p, at: new Date(p.created_at) })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, pageSize);

    // Données liées : auteurs, cercles, voyages joints aux publications (si visibles)
    const pagePosts = merged.filter((m) => m.kind === 'post').map((m) => m.doc);
    const linkedTripIds = [...new Set(pagePosts.map((p) => p.trip_id).filter(Boolean))];
    const [users, circles, linkedTrips]: [any[], any[], any[]] = await Promise.all([
      this.userModel
        .find({ user_id: { $in: [...new Set(merged.map((m) => m.doc.user_id))] } })
        .lean()
        .exec(),
      this.circleModel
        .find({ id: { $in: [...new Set(pagePosts.map((p) => p.circle_id))] } })
        .select('id name slug avatar_emoji is_public')
        .lean()
        .exec(),
      linkedTripIds.length
        ? this.sharedTripModel.find({ id: { $in: linkedTripIds } }).select('-weather').lean().exec()
        : Promise.resolve([]),
    ]);
    const userMap = new Map(users.map((u) => [u.user_id, u]));
    const circleMap = new Map(circles.map((c) => [c.id, c]));
    const mateSet = new Set(mates);
    const tripMap = new Map(
      linkedTrips
        .filter((t) => {
          const visibility = tripVisibility(t);
          return visibility === 'public' || t.user_id === viewerId || (visibility === 'tribe' && mateSet.has(t.user_id));
        })
        .map((t) => [t.id, t]),
    );

    const authorOf = (userId: string) => {
      const u = userMap.get(userId);
      return u
        ? {
            user_id: u.user_id,
            name: u.name,
            pseudo: u.pseudo || null,
            avatar_emoji: u.avatar_emoji || null,
            picture: u.picture || null,
            is_pro: u.is_pro || false,
          }
        : null;
    };
    const publicTrip = (t: any) => {
      const { liked_by, ...rest } = t;
      return {
        ...rest,
        visibility: tripVisibility(t),
        cover_image_url: t.cover_image_url || t.pois?.[0]?.image_url || null,
      };
    };

    const items = merged.map(({ kind, doc }) => {
      const liked = !!viewerId && (doc.liked_by || []).includes(viewerId);
      if (kind === 'trip') {
        return {
          type: 'trip',
          id: doc.id,
          created_at: doc.created_at,
          author: authorOf(doc.user_id),
          trip: publicTrip(doc),
          liked_by_me: liked,
          likes: Math.max(0, doc.likes || 0),
          comments_count: Math.max(0, doc.comments_count || 0),
        };
      }
      const { liked_by, ...post } = doc;
      const linked = doc.trip_id ? tripMap.get(doc.trip_id) : null;
      return {
        type: 'post',
        id: doc.id,
        created_at: doc.created_at,
        author: authorOf(doc.user_id),
        post: { ...post, trip: linked ? publicTrip(linked) : null },
        circle: circleMap.get(doc.circle_id) || null,
        liked_by_me: liked,
        likes: Math.max(0, doc.likes_count || 0),
        comments_count: Math.max(0, doc.comments_count || 0),
      };
    });

    return {
      items,
      next_before: items.length === pageSize ? items[items.length - 1].created_at : null,
    };
  }

  async getUserPublicProfile(user_id: string): Promise<object> {
    const user = await this.userModel.findOne({ user_id }).lean().exec();
    if (!user) {
      throw new NotFoundException(`User ${user_id} not found`);
    }

    let profile: any = null;
    try {
      const ProfileModel = await this.tenancyService.getTenantModel<any>(
        user_id,
        'Profile',
        ProfileSchema,
      );
      profile = await ProfileModel.findOne({ user_id }).lean().exec();
    } catch (err: any) {
      this.logger.warn(`Could not fetch profile for ${user_id}: ${err.message}`);
    }

    const trips = await this.sharedTripModel
      .find({ user_id, is_public: true })
      .sort({ created_at: -1 })
      .lean()
      .exec();

    return {
      user: {
        user_id: user.user_id,
        name: user.name,
        pseudo: user.pseudo || null,
        avatar_emoji: user.avatar_emoji || null,
        picture: user.picture || null,
        is_pro: user.is_pro || false,
        created_at: user.created_at,
      },
      profile: profile
        ? {
            xp: profile.xp,
            level: profile.level,
            streak: profile.streak,
            badges: profile.badges,
            trips_count: profile.trips_count,
          }
        : null,
      trips,
    };
  }

  // =========================================================================
  // 2. GESTION DES CERCLES / COMMUNAUTÉS (CHIFFRES RÉELS ET NON INVENTÉS)
  // =========================================================================

  private slugify(text: string): string {
    return text
      .toString()
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\-]+/g, '')
      .replace(/\-\-+/g, '-');
  }

  async getCircles(
    query: {
      category?: string;
      destination?: string;
      search?: string;
      my_user_id?: string;
      limit?: number;
    },
    authHeader?: string,
  ): Promise<object[]> {
    await this.seedDefaultCirclesIfNeeded();

    const effectiveUserId = await this.resolveUserId(query.my_user_id, authHeader);
    const viewerId = await this.authUserId(authHeader);

    // Cercles publics + cercles privés dont le voyageur connecté est membre
    const myPrivateCircleIds: string[] = viewerId
      ? await this.memberModel.distinct('circle_id', { user_id: viewerId }).exec()
      : [];
    const filter: any = {
      $and: [{ $or: [{ is_public: true }, { id: { $in: myPrivateCircleIds } }] }],
    };

    if (query.category && query.category !== 'all') {
      filter.category = query.category;
    }

    if (query.destination) {
      filter.$or = [
        { destination_city: new RegExp(query.destination, 'i') },
        { destination_country: new RegExp(query.destination, 'i') },
      ];
    }

    if (query.search) {
      filter.$or = [
        { name: new RegExp(query.search, 'i') },
        { description: new RegExp(query.search, 'i') },
        { destination_city: new RegExp(query.search, 'i') },
        { destination_country: new RegExp(query.search, 'i') },
        { tags: { $in: [new RegExp(query.search, 'i')] } },
      ];
    }

    let myJoinedCircleIds = new Set<string>();
    if (effectiveUserId) {
      const myMemberships: any[] = await this.memberModel
        .find({ user_id: effectiveUserId })
        .lean()
        .exec();
      myJoinedCircleIds = new Set(myMemberships.map((m: any) => m.circle_id));
    }

    const circles: any[] = await this.circleModel
      .find(filter)
      .sort({ created_at: -1 })
      .limit(query.limit || 30)
      .lean()
      .exec();

    const circleIds = circles.map((c) => c.id);

    // Calculer dynamiquement les CHIFFRES RÉELS depuis les collections
    const [memberCounts, postCounts, tripCounts] = await Promise.all([
      this.memberModel.aggregate([
        { $match: { circle_id: { $in: circleIds } } },
        { $group: { _id: '$circle_id', count: { $sum: 1 } } },
      ]),
      this.postModel.aggregate([
        { $match: { circle_id: { $in: circleIds } } },
        { $group: { _id: '$circle_id', count: { $sum: 1 } } },
      ]),
      this.postModel.aggregate([
        { $match: { circle_id: { $in: circleIds }, trip_id: { $ne: null } } },
        { $group: { _id: '$circle_id', count: { $sum: 1 } } },
      ]),
    ]);

    const memberCountMap = new Map(memberCounts.map((m: any) => [m._id, m.count]));
    const postCountMap = new Map(postCounts.map((p: any) => [p._id, p.count]));
    const tripCountMap = new Map(tripCounts.map((t: any) => [t._id, t.count]));

    const creatorIds = [...new Set(circles.map((c) => c.creator_id))];
    const creators: any[] = await this.userModel
      .find({ user_id: { $in: creatorIds } })
      .lean()
      .exec();
    const creatorMap = new Map(creators.map((u) => [u.user_id, u]));

    return circles.map((circle) => {
      const creator = creatorMap.get(circle.creator_id);
      const realMembersCount = memberCountMap.get(circle.id) || 0;
      const realPostsCount = postCountMap.get(circle.id) || 0;
      const realTripsCount = tripCountMap.get(circle.id) || 0;

      // Resynchroniser le document en base si décalage
      if (
        circle.members_count !== realMembersCount ||
        circle.posts_count !== realPostsCount ||
        circle.trips_count !== realTripsCount
      ) {
        this.circleModel
          .updateOne(
            { id: circle.id },
            {
              members_count: realMembersCount,
              posts_count: realPostsCount,
              trips_count: realTripsCount,
            },
          )
          .exec()
          .catch(() => {});
      }

      return {
        ...this.withoutInviteCode(circle),
        members_count: realMembersCount,
        posts_count: realPostsCount,
        trips_count: realTripsCount,
        is_member: myJoinedCircleIds.has(circle.id),
        creator: creator
          ? {
              user_id: creator.user_id,
              name: creator.name,
              pseudo: creator.pseudo || null,
              avatar_emoji: creator.avatar_emoji || null,
              picture: creator.picture || null,
              is_pro: creator.is_pro || false,
            }
          : null,
      };
    });
  }

  async getCircleById(
    circleIdOrSlug: string,
    currentUserId?: string,
    authHeader?: string,
  ): Promise<object> {
    const circle: any = await this.circleModel
      .findOne({
        $or: [{ id: circleIdOrSlug }, { slug: circleIdOrSlug }],
      })
      .lean()
      .exec();

    if (!circle) {
      throw new NotFoundException(`Circle "${circleIdOrSlug}" introuvable`);
    }

    const viewerId = await this.authUserId(authHeader);
    const viewerMembership: any = await this.assertCircleAccess(circle, viewerId);
    const canManageInvites = ['creator', 'admin'].includes(viewerMembership?.role);

    const effectiveUserId = await this.resolveUserId(currentUserId, authHeader);

    // Calculer les CHIFFRES RÉELS et EXACTS à la volée
    const [realMembersCount, realPostsCount, realTripsCount] = await Promise.all([
      this.memberModel.countDocuments({ circle_id: circle.id }).exec(),
      this.postModel.countDocuments({ circle_id: circle.id }).exec(),
      this.postModel.countDocuments({ circle_id: circle.id, trip_id: { $ne: null } }).exec(),
    ]);

    // Resynchroniser le document pour la cohérence globale
    await this.circleModel.updateOne(
      { id: circle.id },
      {
        members_count: realMembersCount,
        posts_count: realPostsCount,
        trips_count: realTripsCount,
      },
    ).exec();

    const creator: any = await this.userModel
      .findOne({ user_id: circle.creator_id })
      .lean()
      .exec();

    let isMember = false;
    let myRole: string | null = null;

    if (effectiveUserId) {
      const membership: any = await this.memberModel
        .findOne({ circle_id: circle.id, user_id: effectiveUserId })
        .lean()
        .exec();
      if (membership) {
        isMember = true;
        myRole = membership.role;
      }
    }

    // Récupérer les VRAIS membres ayant rejoint
    const recentMembers: any[] = await this.memberModel
      .find({ circle_id: circle.id })
      .sort({ joined_at: -1 })
      .limit(30)
      .lean()
      .exec();

    const memberUserIds = recentMembers.map((m) => m.user_id);
    const memberUsers: any[] = await this.userModel
      .find({ user_id: { $in: memberUserIds } })
      .lean()
      .exec();
    const memberMap = new Map(memberUsers.map((u) => [u.user_id, u]));

    return {
      ...this.withoutInviteCode(circle),
      // Code d'invitation réservé au créateur et aux admins du cercle privé
      invite_code: canManageInvites && !circle.is_public ? circle.invite_code || null : null,
      members_count: realMembersCount,
      posts_count: realPostsCount,
      trips_count: realTripsCount,
      is_member: isMember,
      my_role: myRole,
      creator: creator
        ? {
            user_id: creator.user_id,
            name: creator.name,
            pseudo: creator.pseudo || null,
            avatar_emoji: creator.avatar_emoji || null,
            picture: creator.picture || null,
            is_pro: creator.is_pro || false,
          }
        : null,
      members_sample: recentMembers.map((m) => {
        const u = memberMap.get(m.user_id);
        return {
          user_id: m.user_id,
          role: m.role,
          name: u?.name || 'Voyageur',
          pseudo: u?.pseudo || null,
          avatar_emoji: u?.avatar_emoji || '🧭',
          picture: u?.picture || null,
          is_pro: u?.is_pro || false,
          joined_at: m.joined_at,
        };
      }),
    };
  }

  async createCircle(userId: string, dto: CreateCircleDto): Promise<object> {
    if (!dto.name || dto.name.trim().length < 3) {
      throw new BadRequestException('Le nom du cercle doit comporter au moins 3 caractères');
    }

    const circleId = crypto.randomUUID();
    const isPublic = dto.is_public !== undefined ? dto.is_public : true;
    let baseSlug = this.slugify(dto.name);
    let slug = baseSlug;
    let suffix = 1;

    while (await this.circleModel.findOne({ slug }).exec()) {
      slug = `${baseSlug}-${suffix++}`;
    }

    const circleData = {
      id: circleId,
      name: dto.name.trim(),
      slug,
      description: dto.description?.trim() || '',
      avatar_emoji: dto.avatar_emoji || '🧭',
      cover_image_url:
        dto.cover_image_url ||
        'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=1200&q=80',
      category: dto.category || 'general',
      destination_city: dto.destination_city || null,
      destination_country: dto.destination_country || null,
      creator_id: userId,
      members_count: 1, // Créateur initial
      trips_count: 0,
      posts_count: 0,
      is_public: isPublic,
      ...(isPublic ? {} : { invite_code: await this.generateInviteCode() }),
      tags: dto.tags || [],
      created_at: new Date(),
      updated_at: new Date(),
    };

    const circle = await this.circleModel.create(circleData);

    // Ajouter automatiquement le créateur comme membre 'creator'
    await this.memberModel.create({
      circle_id: circleId,
      user_id: userId,
      role: 'creator',
      joined_at: new Date(),
    });

    this.logger.log(`Created community circle "${circle.name}" (${circleId}) by user ${userId}`);
    return circle;
  }

  async joinCircle(userId: string, circleId: string): Promise<object> {
    const circle = await this.circleModel.findOne({ id: circleId }).exec();
    if (!circle) {
      throw new NotFoundException(`Cercle ${circleId} introuvable`);
    }
    if (!circle.is_public) {
      const member = await this.memberModel.exists({ circle_id: circleId, user_id: userId });
      if (!member) {
        throw new ForbiddenException("Ce cercle est privé : rejoins-le avec son code d'invitation");
      }
    }
    return this.addMember(userId, circle);
  }

  /** Rejoindre un cercle (privé ou public) grâce à son code d'invitation. */
  async joinCircleByCode(userId: string, code: string): Promise<object> {
    const normalized = code.trim().toUpperCase();
    const circle = normalized ? await this.circleModel.findOne({ invite_code: normalized }).exec() : null;
    if (!circle) {
      throw new NotFoundException("Code d'invitation invalide");
    }
    return { ...(await this.addMember(userId, circle)), slug: circle.slug, name: circle.name };
  }

  /** Nouveau code d'invitation : l'ancien ne fonctionne plus (créateur / admin uniquement). */
  async regenerateInviteCode(userId: string, circleId: string): Promise<object> {
    const circle = await this.circleModel.findOne({ id: circleId }).exec();
    if (!circle) {
      throw new NotFoundException(`Cercle ${circleId} introuvable`);
    }
    const membership: any = await this.assertCircleAccess(circle, userId);
    if (!['creator', 'admin'].includes(membership?.role)) {
      throw new ForbiddenException("Seuls le créateur et les admins gèrent les invitations");
    }
    if (circle.is_public) {
      throw new BadRequestException("Un cercle public n'a pas besoin de code d'invitation");
    }
    circle.invite_code = await this.generateInviteCode();
    await circle.save();
    return { circle_id: circle.id, invite_code: circle.invite_code };
  }

  private async addMember(userId: string, circle: CommunityCircleDocument): Promise<object> {
    const circleId = circle.id;
    const existing = await this.memberModel.findOne({ circle_id: circleId, user_id: userId }).exec();
    if (existing) {
      const realCount = await this.memberModel.countDocuments({ circle_id: circleId }).exec();
      return {
        success: true,
        message: 'Déjà membre de cette communauté',
        circle_id: circleId,
        members_count: realCount,
      };
    }

    await this.memberModel.create({
      circle_id: circleId,
      user_id: userId,
      role: 'explorer',
      joined_at: new Date(),
    });

    // Mettre à jour avec le compte réel
    const realCount = await this.memberModel.countDocuments({ circle_id: circleId }).exec();
    circle.members_count = realCount;
    await circle.save();

    return {
      success: true,
      message: `Bienvenue dans la tribu "${circle.name}" !`,
      circle_id: circleId,
      members_count: realCount,
    };
  }

  async leaveCircle(userId: string, circleId: string): Promise<object> {
    const circle = await this.circleModel.findOne({ id: circleId }).exec();
    if (!circle) {
      throw new NotFoundException(`Cercle ${circleId} introuvable`);
    }

    await this.memberModel.deleteOne({ circle_id: circleId, user_id: userId }).exec();

    // Mettre à jour avec le compte réel
    const realCount = await this.memberModel.countDocuments({ circle_id: circleId }).exec();
    circle.members_count = realCount;
    await circle.save();

    return {
      success: true,
      message: `Vous avez quitté le cercle "${circle.name}"`,
      circle_id: circleId,
      members_count: realCount,
    };
  }

  // =========================================================================
  // 3. POSTS, MOMENTS & PARTAGES DE VOYAGES DANS LE CERCLE
  // =========================================================================

  async getCirclePosts(circleIdOrSlug: string, authHeader?: string): Promise<object[]> {
    const circle: any = await this.circleModel
      .findOne({ $or: [{ id: circleIdOrSlug }, { slug: circleIdOrSlug }] })
      .lean()
      .exec();
    if (!circle) {
      throw new NotFoundException(`Cercle ${circleIdOrSlug} introuvable`);
    }
    const viewerId = await this.authUserId(authHeader);
    await this.assertCircleAccess(circle, viewerId);
    const circleId = circle.id;

    const posts: any[] = await this.postModel
      .find({ circle_id: circleId })
      .sort({ created_at: -1 })
      .limit(50)
      .lean()
      .exec();

    const userIds = [...new Set(posts.map((p) => p.user_id))];
    const users: any[] = await this.userModel
      .find({ user_id: { $in: userIds } })
      .lean()
      .exec();
    const userMap = new Map(users.map((u) => [u.user_id, u]));

    const tripIds = [...new Set(posts.map((p) => p.trip_id).filter(Boolean))];
    const trips: any[] = await this.sharedTripModel
      .find({ id: { $in: tripIds } })
      .lean()
      .exec();
    // Le voyage lié n'est joint que si le lecteur a le droit de le voir
    const mates = new Set(viewerId ? await tribeMateIds(this.memberModel, viewerId) : []);
    const visibleTrips = trips.filter((t) => {
      const visibility = tripVisibility(t);
      return (
        visibility === 'public' ||
        t.user_id === viewerId ||
        (visibility === 'tribe' && mates.has(t.user_id))
      );
    });
    const tripMap = new Map(visibleTrips.map((t) => [t.id, { ...t, visibility: tripVisibility(t) }]));

    return posts.map((post) => {
      const author = userMap.get(post.user_id);
      const linkedTrip = post.trip_id ? tripMap.get(post.trip_id) : null;

      return {
        ...post,
        author: author
          ? {
              user_id: author.user_id,
              name: author.name,
              pseudo: author.pseudo || null,
              avatar_emoji: author.avatar_emoji || null,
              picture: author.picture || null,
              is_pro: author.is_pro || false,
            }
          : null,
        trip: linkedTrip || null,
      };
    });
  }

  async createPost(userId: string, circleId: string, dto: CreatePostDto): Promise<object> {
    const circle = await this.circleModel.findOne({ id: circleId }).exec();
    if (!circle) {
      throw new NotFoundException(`Cercle ${circleId} introuvable`);
    }
    await this.assertCircleAccess(circle, userId);

    const postId = crypto.randomUUID();
    const postData = {
      id: postId,
      circle_id: circleId,
      user_id: userId,
      content: dto.content.trim(),
      trip_id: dto.trip_id || null,
      poi_title: dto.poi_title || null,
      poi_city: dto.poi_city || null,
      poi_country: dto.poi_country || null,
      image_urls: dto.image_urls || [],
      likes_count: 0,
      liked_by: [],
      created_at: new Date(),
      updated_at: new Date(),
    };

    const post = await this.postModel.create(postData);

    // Mettre à jour avec le compte réel
    const [realPostsCount, realTripsCount] = await Promise.all([
      this.postModel.countDocuments({ circle_id: circleId }).exec(),
      this.postModel.countDocuments({ circle_id: circleId, trip_id: { $ne: null } }).exec(),
    ]);
    circle.posts_count = realPostsCount;
    circle.trips_count = realTripsCount;
    await circle.save();

    const author: any = await this.userModel.findOne({ user_id: userId }).lean().exec();

    return {
      ...post.toObject(),
      author: author
        ? {
            user_id: author.user_id,
            name: author.name,
            pseudo: author.pseudo || null,
            avatar_emoji: author.avatar_emoji || null,
            picture: author.picture || null,
            is_pro: author.is_pro || false,
          }
        : null,
    };
  }

  async shareTripToCircle(userId: string, circleId: string, dto: ShareTripToCircleDto): Promise<object> {
    const circle = await this.circleModel.findOne({ id: circleId }).exec();
    if (!circle) {
      throw new NotFoundException(`Cercle ${circleId} introuvable`);
    }
    await this.assertCircleAccess(circle, userId);

    // On ne partage que ses propres voyages
    const TripModel = await this.tenancyService.getTenantModel<any>(userId, 'Trip', TripSchema);
    let trip: any = await TripModel.findOne({ id: dto.trip_id, user_id: userId }).lean().exec();
    const inTenant = !!trip;
    if (!trip) {
      trip = await this.sharedTripModel.findOne({ id: dto.trip_id, user_id: userId }).lean().exec();
    }

    if (!trip) {
      throw new NotFoundException(`Itinéraire ${dto.trip_id} introuvable`);
    }

    // Partager dans un cercle ouvre le voyage à son audience, sans jamais le restreindre :
    // cercle public → public, cercle privé → au moins « tribu »
    const visibility = widerVisibility(tripVisibility(trip), circle.is_public ? 'public' : 'tribe');
    if (inTenant) {
      await this.tripsService.updateVisibility(userId, trip.id, visibility);
    } else {
      await this.sharedTripModel
        .updateOne({ id: trip.id }, { $set: { visibility, is_public: visibility === 'public' } })
        .exec();
    }
    trip = { ...trip, visibility, is_public: visibility === 'public' };

    const cover = trip.cover_image_url || trip.pois?.[0]?.image_url || null;
    const postId = crypto.randomUUID();

    const postData = {
      id: postId,
      circle_id: circleId,
      user_id: userId,
      content: dto.comment?.trim() || `J'ai partagé mon aventure "${trip.destination}" avec la tribu !`,
      trip_id: trip.id,
      poi_title: trip.destination,
      poi_city: trip.destination,
      poi_country: trip.country || null,
      image_urls: cover ? [cover] : [],
      likes_count: 0,
      liked_by: [],
      created_at: new Date(),
      updated_at: new Date(),
    };

    const post = await this.postModel.create(postData);

    // Mettre à jour avec le compte réel
    const [realPostsCount, realTripsCount] = await Promise.all([
      this.postModel.countDocuments({ circle_id: circleId }).exec(),
      this.postModel.countDocuments({ circle_id: circleId, trip_id: { $ne: null } }).exec(),
    ]);
    circle.posts_count = realPostsCount;
    circle.trips_count = realTripsCount;
    await circle.save();

    // Octroyer les points d'XP pour le partage de voyage (Gamification)
    let xpResult: any = null;
    try {
      xpResult = await this.gamificationService.awardXP(userId, 'share_trip');
    } catch (err: any) {
      this.logger.warn(`Could not award share_trip XP to ${userId}: ${err.message}`);
    }

    return {
      success: true,
      message: 'Itinéraire partagé avec succès dans la communauté !',
      post,
      trip,
      gamification: xpResult,
    };
  }

  async toggleLikeTrip(userId: string, tripId: string): Promise<object> {
    const trip = await this.sharedTripModel
      .findOne({ id: tripId })
      .select('liked_by user_id visibility is_public')
      .lean()
      .exec();
    if (!trip || !(await canViewTrip(this.memberModel, trip, userId))) {
      throw new NotFoundException(`Voyage ${tripId} introuvable`);
    }

    // Conditional atomic updates so concurrent toggles can't double-count
    const liked = (trip.liked_by || []).includes(userId);
    if (liked) {
      await this.sharedTripModel
        .updateOne(
          { id: tripId, liked_by: userId },
          { $pull: { liked_by: userId }, $inc: { likes: -1 } },
        )
        .exec();
    } else {
      await this.sharedTripModel
        .updateOne(
          { id: tripId, liked_by: { $ne: userId } },
          { $addToSet: { liked_by: userId }, $inc: { likes: 1 } },
        )
        .exec();
    }

    const current: any = await this.sharedTripModel
      .findOne({ id: tripId })
      .select('liked_by likes')
      .lean()
      .exec();

    return {
      trip_id: tripId,
      liked: (current?.liked_by || []).includes(userId),
      likes: Math.max(0, current?.likes || 0),
    };
  }

  async toggleLikePost(userId: string, postId: string): Promise<object> {
    const post = await this.postModel.findOne({ id: postId }).exec();
    if (!post) {
      throw new NotFoundException(`Post ${postId} introuvable`);
    }
    const circle = await this.circleModel.findOne({ id: post.circle_id }).lean().exec();
    if (circle) {
      await this.assertCircleAccess(circle, userId);
    }

    const liked = post.liked_by.includes(userId);
    if (liked) {
      post.liked_by = post.liked_by.filter((id) => id !== userId);
      post.likes_count = Math.max(0, post.likes_count - 1);
    } else {
      post.liked_by.push(userId);
      post.likes_count = (post.likes_count || 0) + 1;
    }

    await post.save();

    return {
      post_id: postId,
      liked: !liked,
      likes_count: post.likes_count,
    };
  }

  // =========================================================================
  // 4. AUTO-SEEDING & SYNCHRONISATION DES COMPTEURS RÉELS
  // =========================================================================

  private async seedDefaultCirclesIfNeeded(): Promise<void> {
    const count = await this.circleModel.countDocuments().exec();
    if (count === 0) {
      const defaultCircles = [
        {
          id: 'circle_italy_secrets',
          name: 'Secrets de Rome & Toscane',
          slug: 'secrets-de-rome-et-toscane',
          description: 'Bons plans de ruelles, trattorias authentiques et couchers de soleil cachés en Italie.',
          avatar_emoji: '🏛️',
          cover_image_url: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=1200&q=80',
          category: 'culture',
          destination_city: 'Rome',
          destination_country: 'Italie',
          creator_id: 'user_voyago_team',
          members_count: 0,
          trips_count: 0,
          posts_count: 0,
          is_public: true,
          tags: ['rome', 'toscane', 'gastronomie', 'culture'],
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'circle_japan_adventures',
          name: 'Aventuriers du Japon',
          slug: 'aventuriers-du-japon',
          description: 'Temples sacrés de Kyoto, nuits électriques à Tokyo et randonnées au Mont Fuji.',
          avatar_emoji: '⛩️',
          cover_image_url: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?auto=format&fit=crop&w=1200&q=80',
          category: 'adventure',
          destination_city: 'Tokyo',
          destination_country: 'Japon',
          creator_id: 'user_voyago_team',
          members_count: 0,
          trips_count: 0,
          posts_count: 0,
          is_public: true,
          tags: ['japon', 'tokyo', 'kyoto', 'aventure'],
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'circle_nature_treks',
          name: 'Vanlife & Bivouac Sauvage',
          slug: 'vanlife-et-bivouac-sauvage',
          description: 'Spots de campings étoilés, sentiers côtiers et roadtrips en totale liberté.',
          avatar_emoji: '🚐',
          cover_image_url: 'https://images.unsplash.com/photo-1523987355523-c7b5b0dd90a7?auto=format&fit=crop&w=1200&q=80',
          category: 'nature',
          destination_city: 'Alpes & Fjords',
          destination_country: 'Europe',
          creator_id: 'user_voyago_team',
          members_count: 0,
          trips_count: 0,
          posts_count: 0,
          is_public: true,
          tags: ['vanlife', 'nature', 'roadtrip', 'bivouac'],
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      try {
        await this.circleModel.insertMany(defaultCircles);
        this.logger.log('Seeded initial community circles with real zero-counts');
      } catch (err: any) {
        this.logger.warn(`Could not seed default circles: ${err.message}`);
      }
    }

    // Synchroniser immédiatement TOUS les cercles existants avec leurs VRAIS chiffres
    try {
      const allCircles = await this.circleModel.find().lean().exec();
      for (const c of allCircles) {
        const realMembers = await this.memberModel.countDocuments({ circle_id: c.id }).exec();
        const realPosts = await this.postModel.countDocuments({ circle_id: c.id }).exec();
        const realTrips = await this.postModel.countDocuments({ circle_id: c.id, trip_id: { $ne: null } }).exec();

        if (
          c.members_count !== realMembers ||
          c.posts_count !== realPosts ||
          c.trips_count !== realTrips
        ) {
          await this.circleModel.updateOne(
            { id: c.id },
            {
              members_count: realMembers,
              posts_count: realPosts,
              trips_count: realTrips,
            },
          ).exec();
        }
      }
    } catch (_) {}
  }
}
