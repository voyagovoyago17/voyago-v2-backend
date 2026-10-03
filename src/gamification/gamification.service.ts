import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ProfileSchema } from './schemas/profile.schema';
import { UserXpActionSchema } from './schemas/user-xp-action.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { TenancyService } from '../tenancy/tenancy.service';

const XP_ACTIONS: Record<string, number> = {
  generate_trip: 3,
  first_trip: 7,
  complete_profile: 1,
  select_interests: 1,
  thermal_setup: 1,
  share_trip: 1,
  daily_login: 1,
  first_swipe: 1,
  review_place: 2,
  share_journal: 5,
  // Engagement communautaire
  comment: 1,
  first_comment: 2,
  trip_popular: 5,
  populaire: 10,
  trip_remixed: 3,
  eclaireur: 10,
  // Tribus
  tribe_vote: 2,
  circle_challenge: 10,
  esprit_tribu: 15,
  // Radar des pépites (XP selon la rareté)
  gem_commune: 5,
  gem_rare: 10,
  gem_legendaire: 20,
  chasseur_pepites: 5,
  compte_verifie: 5,
  // Fondateurs de tribus
  fondateur_reactif: 2,
  fondateur_actif: 15,
};

/** Actions attribuées uniquement par le serveur (jamais via POST /profile/xp). */
export const SERVER_ONLY_XP_ACTIONS = [
  'review_place',
  'share_journal',
  'comment',
  'first_comment',
  'trip_popular',
  'populaire',
  'trip_remixed',
  'eclaireur',
  'tribe_vote',
  'circle_challenge',
  'esprit_tribu',
  'gem_commune',
  'gem_rare',
  'gem_legendaire',
  'chasseur_pepites',
  'compte_verifie',
  'fondateur_reactif',
  'fondateur_actif',
];

const ONE_TIME_ACTIONS = [
  'first_swipe',
  'first_trip',
  'complete_profile',
  'select_interests',
  'thermal_setup',
  // Badges d'engagement (l'action porte le nom du badge)
  'first_comment',
  'populaire',
  'eclaireur',
  'esprit_tribu',
  'chasseur_pepites',
  'compte_verifie',
  'fondateur_actif',
];

/** Nombre maximum d'attributions par jour (UTC) pour les actions répétables. */
const DAILY_CAPS: Record<string, number> = {
  comment: 5,
  fondateur_reactif: 10,
};

import { GLOBAL_DB_CONNECTION } from '../common/constants';

@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
    private readonly tenancyService: TenancyService,
  ) {}

  /**
   * Calcul autoritaire du niveau à partir de l'XP (anti-triche serveur)
   * Chaque palier de 100 XP débloque un niveau :
   * [0-99 XP] = Niv 1 (Explorateur)
   * [100-199 XP] = Niv 2 (Voyageur)
   * [200-299 XP] = Niv 3 (Aventurier)
   * [400-499 XP] = Niv 5 (Globe-trotteur)
   * [900+ XP] = Niv 10 (Légende)
   */
  calculateLevel(xp: number): number {
    const safeXp = Math.max(0, Math.floor(xp || 0));
    return Math.floor(safeXp / 100) + 1;
  }

  async getProfile(user_id: string): Promise<object> {
    // Get profile from user's own tenant DB
    const ProfileModel = await this.tenancyService.getTenantModel<any>(
      user_id,
      'Profile',
      ProfileSchema,
    );

    let profile: any = await ProfileModel.findOne({ user_id }).lean().exec();
    const user: any = await this.userModel.findOne({ user_id }).lean().exec();

    // 1. If not found in user's tenant DB, check legacy shared DB
    if (!profile) {
      try {
        const LegacyProfileModel = await this.tenancyService.getTenantModel<any>(
          'default',
          'Profile',
          ProfileSchema,
        );
        const legacyProfile: any = await LegacyProfileModel.findOne({ user_id }).lean().exec();
        if (legacyProfile) {
          const newDoc = await ProfileModel.create({
            user_id,
            tenant_id: user_id,
            xp: legacyProfile.xp || 0,
            level: legacyProfile.level || 1,
            streak: legacyProfile.streak || 0,
            badges: legacyProfile.badges || [],
            trips_count: legacyProfile.trips_count || 0,
            last_active: legacyProfile.last_active || new Date(),
          });
          profile = newDoc.toObject ? newDoc.toObject() : newDoc;
          this.logger.log(`Migrated legacy profile to tenant DB for user: ${user_id}`);
        }
      } catch (err) {
        this.logger.warn(`Could not check legacy profile for ${user_id}: ${err.message}`);
      }
    }

    // 2. If still no profile, auto-create initial profile in user's tenant DB
    if (!profile) {
      const created = await ProfileModel.create({
        user_id,
        tenant_id: user_id,
        xp: 0,
        level: 1,
        streak: 0,
        badges: [],
        trips_count: 0,
        last_active: new Date(),
      });
      profile = created.toObject ? created.toObject() : created;
      this.logger.log(`Auto-created initial profile in tenant DB for user: ${user_id}`);
    }

    // Anti-triche : calcul autoritaire du niveau à partir de l'XP
    const authoritativeLevel = this.calculateLevel(profile.xp ?? 0);
    if (profile.level !== authoritativeLevel) {
      profile.level = authoritativeLevel;
      ProfileModel.updateOne(
        { user_id },
        { $set: { level: authoritativeLevel } },
      ).exec().catch(() => {});
    }

    return {
      user_id,
      name: user?.name || 'Voyageur',
      pseudo: user?.pseudo || null,
      avatar_emoji: user?.avatar_emoji || null,
      country: user?.country || null,
      city: user?.city || null,
      is_pro: user?.is_pro || false,
      pro_tier: user?.pro_tier || null,
      xp: profile.xp ?? 0,
      level: authoritativeLevel,
      streak: profile.streak ?? 0,
      badges: profile.badges ?? [],
      trips_count: profile.trips_count ?? 0,
      last_active: profile.last_active ?? new Date(),
      user: user
        ? {
            name: user.name,
            pseudo: user.pseudo || null,
            avatar_emoji: user.avatar_emoji || null,
            picture: user.picture || null,
            is_pro: user.is_pro || false,
          }
        : null,
    };
  }

  async awardXP(user_id: string, action: string): Promise<object> {
    const xpAmount = XP_ACTIONS[action];
    if (xpAmount === undefined) {
      throw new BadRequestException(`Unknown XP action: ${action}`);
    }

    // Get profile model from user's tenant DB
    const ProfileModel = await this.tenancyService.getTenantModel<any>(
      user_id,
      'Profile',
      ProfileSchema,
    );

    let profile: any = await ProfileModel.findOne({ user_id }).exec();
    if (!profile) {
      profile = await ProfileModel.create({
        user_id,
        tenant_id: user_id,
        xp: 0,
        level: 1,
        streak: 0,
        badges: [],
        trips_count: 0,
        last_active: new Date(),
      });
    }

    const ActionModel = await this.tenancyService.getTenantModel<any>(
      user_id,
      'UserXpAction',
      UserXpActionSchema,
    );

    // 1. Anti-triche : Actions à récompense unique (One-time)
    if (ONE_TIME_ACTIONS.includes(action)) {
      const alreadyHasBadge = profile.badges && profile.badges.includes(action);
      const alreadyLoggedAction: any = await ActionModel.findOne({ user_id, action, completed: true }).lean().exec();
      if (alreadyHasBadge || alreadyLoggedAction) {
        return {
          user_id,
          xp: profile.xp,
          level: this.calculateLevel(profile.xp),
          streak: profile.streak,
          badges: profile.badges,
          trips_count: profile.trips_count,
          message: 'XP already awarded for this one-time action (anti-cheat)',
        };
      }
    }

    // 2. Anti-triche : Connexion quotidienne (max 1 attribution par jour calendaire UTC)
    if (action === 'daily_login') {
      const lastDaily: any = await ActionModel.findOne({ user_id, action: 'daily_login' }).lean().exec();
      if (lastDaily && lastDaily.completed_at) {
        const lastDate = new Date(lastDaily.completed_at);
        const now = new Date();
        const isSameDay = lastDate.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
        if (isSameDay) {
          return {
            user_id,
            xp: profile.xp,
            level: this.calculateLevel(profile.xp),
            streak: profile.streak,
            badges: profile.badges,
            trips_count: profile.trips_count,
            message: 'Daily login XP already claimed today (anti-cheat)',
          };
        }
      }
    }

    // 3. Anti-triche : Génération d'itinéraire (les récompenses ne peuvent excéder le nombre réel de voyages)
    if (action === 'generate_trip') {
      const existingTripAction: any = await ActionModel.findOne({ user_id, action: 'generate_trip' }).lean().exec();
      const currentClaims = existingTripAction?.count ?? 0;
      if ((profile.trips_count || 0) <= currentClaims) {
        return {
          user_id,
          xp: profile.xp,
          level: this.calculateLevel(profile.xp),
          streak: profile.streak,
          badges: profile.badges,
          trips_count: profile.trips_count,
          message: 'Generate trip XP already claimed for all existing trips (anti-cheat)',
        };
      }
    }

    // 4. Anti-triche : Partage d'itinéraire (cooldown minimum 10 secondes)
    if (action === 'share_trip') {
      const lastShare: any = await ActionModel.findOne({ user_id, action: 'share_trip' }).lean().exec();
      if (lastShare && lastShare.completed_at) {
        const elapsedSec = (Date.now() - new Date(lastShare.completed_at).getTime()) / 1000;
        if (elapsedSec < 10) {
          return {
            user_id,
            xp: profile.xp,
            level: this.calculateLevel(profile.xp),
            streak: profile.streak,
            badges: profile.badges,
            trips_count: profile.trips_count,
            message: 'Please wait before sharing another trip (anti-cheat)',
          };
        }
      }
    }

    // 5. Anti-triche : plafond quotidien (ex. 5 commentaires récompensés par jour)
    const dailyCap = DAILY_CAPS[action];
    const today = new Date().toISOString().slice(0, 10);
    let dayCount = 1;
    if (dailyCap !== undefined) {
      const existing: any = await ActionModel.findOne({ user_id, action }).lean().exec();
      if (existing?.day === today) {
        if ((existing.day_count || 0) >= dailyCap) {
          return {
            user_id,
            xp: profile.xp,
            level: this.calculateLevel(profile.xp),
            streak: profile.streak,
            badges: profile.badges,
            trips_count: profile.trips_count,
            message: 'Daily XP cap reached for this action (anti-cheat)',
          };
        }
        dayCount = (existing.day_count || 0) + 1;
      }
    }

    const newXp = profile.xp + xpAmount;
    const newLevel = this.calculateLevel(newXp);

    const updateFields: any = {
      xp: newXp,
      level: newLevel,
      last_active: new Date(),
    };

    // Award badge for one-time actions
    if (ONE_TIME_ACTIONS.includes(action) && !profile.badges.includes(action)) {
      await ProfileModel.updateOne(
        { user_id },
        {
          $set: updateFields,
          $addToSet: { badges: action },
        },
      ).exec();
    } else {
      await ProfileModel.updateOne({ user_id }, { $set: updateFields }).exec();
    }

    // Enregistrer l'action dans la collection dédiée user_xp_actions
    try {
      await ActionModel.findOneAndUpdate(
        { user_id, action },
        {
          $set: {
            user_id,
            tenant_id: user_id,
            action,
            xp: xpAmount,
            completed: true,
            completed_at: new Date(),
            ...(dailyCap !== undefined ? { day: today, day_count: dayCount } : {}),
          },
          $inc: { count: 1 },
        },
        { upsert: true, new: true },
      ).exec();
    } catch (err: any) {
      this.logger.warn(`Could not save user_xp_actions for ${user_id}: ${err.message}`);
    }

    const updated: any = await ProfileModel.findOne({ user_id }).lean().exec();
    return {
      user_id,
      xp: updated.xp,
      level: updated.level,
      streak: updated.streak,
      badges: updated.badges,
      trips_count: updated.trips_count,
      xp_awarded: xpAmount,
    };
  }

  async getXpRewards(userId?: string): Promise<object> {
    let userXp = 0;
    let userLevel = 1;
    let userStreak = 0;
    let userBadges: string[] = [];
    let tripsCount = 0;
    let isProfileComplete = false;
    let hasInterests = false;
    let hasThermalSetup = false;
    let ActionModel: any = null;
    let completedActionMap = new Map<string, any>();

    if (userId) {
      try {
        const ProfileModel = await this.tenancyService.getTenantModel<any>(
          userId,
          'Profile',
          ProfileSchema,
        );
        ActionModel = await this.tenancyService.getTenantModel<any>(
          userId,
          'UserXpAction',
          UserXpActionSchema,
        );

        const profile: any = await ProfileModel.findOne({ user_id: userId }).lean().exec();
        const user: any = await this.userModel.findOne({ user_id: userId }).lean().exec();
        const dbActions: any[] = await ActionModel.find({ user_id: userId }).lean().exec();
        completedActionMap = new Map(dbActions.map((a: any) => [a.action, a]));

        if (profile) {
          userXp = profile.xp ?? 0;
          userLevel = this.calculateLevel(userXp);
          userStreak = profile.streak ?? 0;
          userBadges = profile.badges ?? [];
          tripsCount = profile.trips_count ?? 0;
        }

        if (user) {
          isProfileComplete = Boolean(
            (user.name && (user.country || user.city || user.pseudo)) ||
            userBadges.includes('complete_profile') ||
            completedActionMap.has('complete_profile')
          );
          hasInterests = Boolean(
            user.onboarding_completed ||
            userBadges.includes('select_interests') ||
            completedActionMap.has('select_interests')
          );
          hasThermalSetup = Boolean(
            user.onboarding_completed ||
            (user.thermal_sensitivity && user.thermal_sensitivity !== 'balanced') ||
            userBadges.includes('thermal_setup') ||
            completedActionMap.has('thermal_setup')
          );
        }
      } catch (err: any) {
        this.logger.warn(`Could not load user data for XP rewards (${userId}): ${err.message}`);
      }
    }

    const levels = [
      { level: 1, min_xp: 0, title: 'Explorateur', reward: 'Badge Débutant' },
      { level: 2, min_xp: 100, title: 'Voyageur', reward: 'Badge Voyageur' },
      { level: 3, min_xp: 200, title: 'Aventurier', reward: 'Badge Aventurier' },
      { level: 5, min_xp: 400, title: 'Globe-trotteur', reward: 'Badge Globe-trotteur' },
      { level: 10, min_xp: 900, title: 'Légende', reward: 'Badge Légendaire + Pro 1 mois' },
    ];

    // Trouver le palier actuel et le palier suivant dynamiquement
    const currentLevelObj = [...levels].reverse().find(l => userXp >= l.min_xp) || levels[0];
    const nextLevelObj = levels.find(l => l.min_xp > userXp) || {
      level: currentLevelObj.level + 1,
      min_xp: currentLevelObj.min_xp + 100,
      title: `Niveau ${currentLevelObj.level + 1}`,
      reward: 'Prochain palier',
    };

    const tierRange = Math.max(1, nextLevelObj.min_xp - currentLevelObj.min_xp);
    const currentLevelXp = Math.max(0, userXp - currentLevelObj.min_xp);
    const xpToNextLevel = Math.max(0, nextLevelObj.min_xp - userXp);
    const progressRatio = Math.min(1.0, Math.max(0.0, currentLevelXp / tierRange));

    const enrichedLevels = levels.map((lvl) => ({
      ...lvl,
      is_reached: userXp >= lvl.min_xp,
      is_current: currentLevelObj.level === lvl.level,
      status: currentLevelObj.level === lvl.level ? 'current' : (userXp >= lvl.min_xp ? 'reached' : 'locked'),
    }));

    const isGenerateCompleted = tripsCount > 0 || completedActionMap.has('generate_trip');
    const isFirstTripCompleted = tripsCount >= 1 || userBadges.includes('first_trip') || completedActionMap.has('first_trip');
    const isShareCompleted = userBadges.includes('share_trip') || completedActionMap.has('share_trip');
    const isDailyCompleted = userStreak > 0 || completedActionMap.has('daily_login');
    const isFirstSwipeCompleted = userBadges.includes('first_swipe') || completedActionMap.has('first_swipe');

    // Synchronisation automatique dans la collection user_xp_actions si validé par l'activité réelle
    if (userId && ActionModel) {
      const toSync: Array<{ action: string; xp: number; count?: number }> = [];
      if (isGenerateCompleted && !completedActionMap.has('generate_trip')) {
        toSync.push({ action: 'generate_trip', xp: XP_ACTIONS.generate_trip, count: tripsCount });
      }
      if (isFirstTripCompleted && !completedActionMap.has('first_trip')) {
        toSync.push({ action: 'first_trip', xp: XP_ACTIONS.first_trip });
      }
      if (isProfileComplete && !completedActionMap.has('complete_profile')) {
        toSync.push({ action: 'complete_profile', xp: XP_ACTIONS.complete_profile });
      }
      if (hasInterests && !completedActionMap.has('select_interests')) {
        toSync.push({ action: 'select_interests', xp: XP_ACTIONS.select_interests });
      }
      if (hasThermalSetup && !completedActionMap.has('thermal_setup')) {
        toSync.push({ action: 'thermal_setup', xp: XP_ACTIONS.thermal_setup });
      }
      if (isFirstSwipeCompleted && !completedActionMap.has('first_swipe')) {
        toSync.push({ action: 'first_swipe', xp: XP_ACTIONS.first_swipe });
      }
      if (isDailyCompleted && !completedActionMap.has('daily_login')) {
        toSync.push({ action: 'daily_login', xp: XP_ACTIONS.daily_login });
      }

      if (toSync.length > 0) {
        Promise.all(
          toSync.map((s) =>
            ActionModel.updateOne(
              { user_id: userId, action: s.action },
              {
                $setOnInsert: {
                  user_id: userId,
                  tenant_id: userId,
                  action: s.action,
                  xp: s.xp,
                  count: s.count || 1,
                  completed: true,
                  completed_at: new Date(),
                },
              },
              { upsert: true },
            ).exec(),
          ),
        ).catch(() => {});
      }
    }

    const actions = [
      {
        action: 'generate_trip',
        xp: XP_ACTIONS.generate_trip,
        emoji: '✈️',
        icon_name: 'flight',
        label: 'Générer un itinéraire',
        completed: isGenerateCompleted,
        progress_label: tripsCount > 0 ? `${tripsCount} voyage${tripsCount > 1 ? 's' : ''}` : null,
      },
      {
        action: 'first_trip',
        xp: XP_ACTIONS.first_trip,
        emoji: '🎉',
        icon_name: 'celebration',
        label: 'Premier voyage',
        completed: isFirstTripCompleted,
        progress_label: isFirstTripCompleted ? 'Accompli' : null,
      },
      {
        action: 'complete_profile',
        xp: XP_ACTIONS.complete_profile,
        emoji: '👤',
        icon_name: 'person',
        label: 'Compléter son profil',
        completed: isProfileComplete,
        progress_label: isProfileComplete ? 'Profil validé' : null,
      },
      {
        action: 'select_interests',
        xp: XP_ACTIONS.select_interests,
        emoji: '🎯',
        icon_name: 'interests',
        label: 'Sélectionner ses envies',
        completed: hasInterests,
        progress_label: hasInterests ? 'Envies définies' : null,
      },
      {
        action: 'thermal_setup',
        xp: XP_ACTIONS.thermal_setup,
        emoji: '🌡️',
        icon_name: 'thermostat',
        label: 'Sensibilité thermique',
        completed: hasThermalSetup,
        progress_label: hasThermalSetup ? 'Configurée' : null,
      },
      {
        action: 'share_trip',
        xp: XP_ACTIONS.share_trip,
        emoji: '📤',
        icon_name: 'share',
        label: 'Partager un voyage',
        completed: isShareCompleted,
        progress_label: isShareCompleted ? 'Partagé' : null,
      },
      {
        action: 'daily_login',
        xp: XP_ACTIONS.daily_login,
        emoji: '🔥',
        icon_name: 'local_fire_department',
        label: 'Connexion quotidienne',
        completed: isDailyCompleted,
        progress_label: isDailyCompleted ? `${userStreak} j streak` : null,
      },
      {
        action: 'first_swipe',
        xp: XP_ACTIONS.first_swipe,
        emoji: '👆',
        icon_name: 'touch_app',
        label: 'Premier swipe découverte',
        completed: isFirstSwipeCompleted,
        progress_label: isFirstSwipeCompleted ? 'Découvert' : null,
      },
    ];

    return {
      total_xp: userXp,
      level: userLevel,
      current_level_xp: currentLevelXp,
      next_level_xp: tierRange,
      xp_to_next_level: xpToNextLevel,
      progress_ratio: progressRatio,
      current_level_title: currentLevelObj.title,
      next_level_title: nextLevelObj.title,
      actions,
      levels: enrichedLevels,
    };
  }

  /**
   * Attribue l'XP d'une action une seule fois pour une clé donnée
   * (ex. un voyage qui atteint 10 likes, un voyageur qui refait un voyage).
   * Renvoie null si la récompense a déjà été donnée.
   */
  async awardXpOnce(user_id: string, action: string, uniqueKey: string): Promise<object | null> {
    const ActionModel = await this.tenancyService.getTenantModel<any>(user_id, 'UserXpAction', UserXpActionSchema);
    // Marqueur posé atomiquement (index unique user_id + action) : pas de double attribution
    const res = await ActionModel.updateOne(
      { user_id, action: `${action}@${uniqueKey}` },
      {
        $setOnInsert: {
          user_id,
          tenant_id: user_id,
          action: `${action}@${uniqueKey}`,
          xp: 0,
          completed: true,
          completed_at: new Date(),
        },
      },
      { upsert: true },
    ).exec();
    if (!res.upsertedCount) return null;
    return this.awardXP(user_id, action);
  }

  getBadges(): object[] {
    return [
      { id: 'first_swipe', title: 'Premier Swipe', description: "Tu as sélectionné tes premières envies de voyage", emoji: '👆', xp_reward: 10 },
      { id: 'first_trip', title: 'Premier Voyage', description: "Tu as généré ton premier itinéraire", emoji: '✈️', xp_reward: 25 },
      { id: 'globe_trotter', title: 'Globe-trotter', description: '5 voyages générés', emoji: '🌍', xp_reward: 50 },
      { id: 'explorateur', title: 'Explorateur', description: '10 voyages générés', emoji: '🗺️', xp_reward: 100 },
      { id: 'en_feu', title: 'En Feu', description: '3 jours de streak', emoji: '🔥', xp_reward: 30 },
      { id: 'first_comment', title: 'Bavard', description: 'Premier commentaire dans la communauté', emoji: '💬', xp_reward: 2 },
      { id: 'populaire', title: 'Populaire', description: 'Un de tes voyages a reçu 10 likes', emoji: '❤️', xp_reward: 10 },
      { id: 'eclaireur', title: 'Éclaireur', description: 'Un voyageur a refait ton voyage', emoji: '🧭', xp_reward: 10 },
      { id: 'compte_verifie', title: 'Compte Vérifié', description: 'Adresse e-mail confirmée', emoji: '✅', xp_reward: 5 },
      { id: 'chasseur_pepites', title: 'Chasseur de Pépites', description: 'Première pépite ramassée sur le terrain', emoji: '💎', xp_reward: 5 },
      { id: 'esprit_tribu', title: 'Esprit de Tribu', description: 'Premier défi de cercle réussi avec ta tribu', emoji: '🏕️', xp_reward: 15 },
      { id: 'fondateur_actif', title: 'Fondateur Actif', description: '5 demandes de tribu traitées en moins de 24 h', emoji: '⚡', xp_reward: 15 },
      { id: 'voyago_pro', title: 'Voyago Pro', description: 'Membre Pro Voyago', emoji: '💎', xp_reward: 0 },
    ];
  }
}
