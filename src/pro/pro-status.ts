/** Jours de tolérance après l'échéance, le temps que le renouvellement Stripe arrive */
export const PRO_GRACE_DAYS = 3;

/**
 * Abonnement Pro réellement valide : actif et non expiré (pas d'échéance = à vie).
 * `is_pro` seul ne suffit pas : il n'est jamais remis à false à l'échéance.
 */
export function isProActive(user?: { is_pro?: boolean; pro_expires_at?: Date | string | null } | null): boolean {
  if (!user?.is_pro) return false;
  if (!user.pro_expires_at) return true;
  const expiresAt = new Date(user.pro_expires_at).getTime();
  return expiresAt + PRO_GRACE_DAYS * 24 * 3600 * 1000 > Date.now();
}
