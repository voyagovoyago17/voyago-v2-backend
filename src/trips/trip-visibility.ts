import { Model } from 'mongoose';

/**
 * Visibilité d'un voyage :
 * - private : visible uniquement par son auteur
 * - tribe   : visible par les membres des cercles de l'auteur
 * - public  : visible par toute la communauté
 */
export const TRIP_VISIBILITIES = ['private', 'tribe', 'public'] as const;
export type TripVisibility = (typeof TRIP_VISIBILITIES)[number];

/** Les anciens voyages n'ont que `is_public` : on en déduit leur visibilité. */
export function tripVisibility(trip: { visibility?: string | null; is_public?: boolean }): TripVisibility {
  if (trip.visibility && (TRIP_VISIBILITIES as readonly string[]).includes(trip.visibility)) {
    return trip.visibility as TripVisibility;
  }
  return trip.is_public === false ? 'private' : 'public';
}

/** Champs à écrire pour garder `is_public` cohérent (le fil public filtre dessus). */
export function visibilityFields(visibility: TripVisibility) {
  return { visibility, is_public: visibility === 'public' };
}

/** Ordre croissant d'ouverture, pour ne jamais restreindre un voyage lors d'un partage. */
export function widerVisibility(a: TripVisibility, b: TripVisibility): TripVisibility {
  return TRIP_VISIBILITIES.indexOf(a) >= TRIP_VISIBILITIES.indexOf(b) ? a : b;
}

/** Identifiants des voyageurs qui partagent au moins un cercle avec `userId` (lui inclus). */
export async function tribeMateIds(memberModel: Model<any>, userId: string): Promise<string[]> {
  const myCircleIds: string[] = await memberModel.distinct('circle_id', { user_id: userId }).exec();
  if (myCircleIds.length === 0) return [userId];
  const mates: string[] = await memberModel.distinct('user_id', { circle_id: { $in: myCircleIds } }).exec();
  return [...new Set([userId, ...mates])];
}

/** Deux voyageurs partagent-ils au moins un cercle ? */
export async function sharesCircle(memberModel: Model<any>, userA: string, userB: string): Promise<boolean> {
  if (userA === userB) return true;
  const circlesA: string[] = await memberModel.distinct('circle_id', { user_id: userA }).exec();
  if (circlesA.length === 0) return false;
  const shared = await memberModel.exists({ user_id: userB, circle_id: { $in: circlesA } });
  return !!shared;
}

/** Le voyageur `viewerId` (anonyme si absent) peut-il voir ce voyage ? */
export async function canViewTrip(
  memberModel: Model<any>,
  trip: { user_id: string; visibility?: string | null; is_public?: boolean },
  viewerId?: string,
): Promise<boolean> {
  if (viewerId && viewerId === trip.user_id) return true;
  const visibility = tripVisibility(trip);
  if (visibility === 'public') return true;
  if (visibility === 'tribe' && viewerId) {
    return sharesCircle(memberModel, viewerId, trip.user_id);
  }
  return false;
}
