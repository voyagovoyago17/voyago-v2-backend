import { NotificationType } from './schemas/notification.schema';

/** Son signature Voyagooo (fichier embarqué dans l'app : res/raw sur Android, bundle sur iOS) */
export const SIGNATURE_SOUND = 'voyagooo';
export const IOS_SIGNATURE_SOUND = 'voyagooo.wav';

/** Canaux Android : le son d'un canal ne peut plus changer une fois créé, d'où des canaux dédiés */
export const ANDROID_SIGNATURE_CHANNEL = 'voyagooo_signature';
export const ANDROID_QUIET_CHANNEL = 'voyagooo_quiet';
/** Vibration seule, sans son */
export const ANDROID_VIBRATE_CHANNEL = 'voyagooo_vibrate';

/** Comment le téléphone se manifeste : son + vibration, vibration seule ou silencieux */
export type NotificationMode = 'sound' | 'vibrate' | 'silent';
export const NOTIFICATION_MODES: NotificationMode[] = ['sound', 'vibrate', 'silent'];

/** Interactions sociales : discrètes, regroupées, coupées en rafale */
export const SOCIAL_TYPES: NotificationType[] = ['comment', 'trip_remixed', 'review_thanks'];

/** Heures calmes (heure locale du voyageur) : notifications sans son */
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 8;
/** Au-delà de ce nombre de notifications sociales en 10 minutes, elles arrivent sans son */
export const SOCIAL_BURST_LIMIT = 3;
export const SOCIAL_BURST_WINDOW_MS = 10 * 60 * 1000;

export interface NotificationPrefs {
  /** Son + vibration, vibration seule ou silencieux */
  mode: NotificationMode;
  /** Son signature Voyagooo (déduit du mode, gardé pour les anciennes versions de l'app) */
  sound: boolean;
  /** Push des interactions sociales (commentaires, voyages refaits…) */
  social: boolean;
  /** Pas de son de 22 h à 8 h */
  quiet_hours: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = { mode: 'sound', sound: true, social: true, quiet_hours: true };

export function prefsOf(user: any): NotificationPrefs {
  const saved = user?.notification_prefs || {};
  // Anciennes préférences sans mode : « son coupé » = vibration seule
  const mode: NotificationMode = NOTIFICATION_MODES.includes(saved.mode) ? saved.mode : saved.sound === false ? 'vibrate' : 'sound';
  return { ...DEFAULT_PREFS, ...saved, mode, sound: mode === 'sound' };
}

export function isQuietHour(utcOffsetMinutes: number | null | undefined, at = Date.now()): boolean {
  const local = new Date(at + (utcOffsetMinutes ?? 60) * 60000).getUTCHours();
  return local >= QUIET_START_HOUR || local < QUIET_END_HOUR;
}

export interface Delivery {
  /** Envoyer un push FCM */
  push: boolean;
  /** Jouer le son signature (push et bandeau dans l'app) */
  sound: boolean;
  /** Faire vibrer le téléphone */
  vibrate: boolean;
  priority: 'important' | 'social';
  /** Les notifications de même clé se remplacent sur le téléphone au lieu de s'empiler */
  collapse_key?: string;
}

/** Décide comment livrer une notification : son, silence, regroupement */
export function decideDelivery(
  n: { type: NotificationType; data?: Record<string, any> },
  ctx: { prefs: NotificationPrefs; utcOffsetMinutes?: number | null; recentSocial: number; now?: number },
): Delivery {
  const social = SOCIAL_TYPES.includes(n.type);
  const quiet = ctx.prefs.quiet_hours && isQuietHour(ctx.utcOffsetMinutes, ctx.now);
  const burst = social && ctx.recentSocial >= SOCIAL_BURST_LIMIT;
  const target = n.data?.trip_id || n.data?.target_id || n.data?.circle_id || '';
  const mode = ctx.prefs.mode;
  return {
    push: !(social && !ctx.prefs.social),
    sound: mode === 'sound' && !quiet && !burst,
    vibrate: mode !== 'silent' && !quiet && !burst,
    priority: social ? 'social' : 'important',
    collapse_key: social ? `${n.type}:${target}`.slice(0, 60) : undefined,
  };
}
