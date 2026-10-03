import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as admin from 'firebase-admin';
import { DeviceToken, DeviceTokenDocument, DevicePlatform } from '../schemas/device-token.schema';
import { User, UserDocument } from '../../auth/schemas/user.schema';
import { GLOBAL_DB_CONNECTION } from '../../common/constants';
import { ANDROID_QUIET_CHANNEL, ANDROID_SIGNATURE_CHANNEL, ANDROID_VIBRATE_CHANNEL, IOS_SIGNATURE_SOUND, SIGNATURE_SOUND } from '../notification-policy';

/** Nombre maximal d'appareils gardés par compte (les plus anciens sont oubliés). */
const MAX_DEVICES_PER_USER = 10;

/** Canal Android historique (anciennes versions de l'app) */
export const ANDROID_CHANNEL_ID = 'voyagooo_alerts';

/** Erreurs FCM signifiant que le jeton est mort : on le supprime. */
const DEAD_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export interface PushMessage {
  title: string;
  body?: string;
  /** Données transmises à l'app pour ouvrir le bon écran au tap */
  data?: Record<string, any>;
  /** Pastille de l'icône iOS (nombre de notifications non lues) */
  badge?: number;
  imageUrl?: string | null;
  /** Son signature Voyagooo (sinon notification silencieuse) */
  sound?: boolean;
  /** Sans son : vibrer quand même (canal Android dédié) */
  vibrate?: boolean;
  /** Les push de même clé se remplacent au lieu de s'empiler (ex. commentaires d'un même voyage) */
  collapseKey?: string;
  /** Regroupement iOS dans le centre de notifications */
  threadId?: string;
}

/**
 * Notifications push via Firebase Cloud Messaging.
 * Sans identifiants Firebase, le service est inactif : les notifications in-app continuent de fonctionner.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private messaging: admin.messaging.Messaging | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(DeviceToken.name, GLOBAL_DB_CONNECTION)
    private readonly deviceModel: Model<DeviceTokenDocument>,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION)
    private readonly userModel: Model<UserDocument>,
  ) {}

  onModuleInit() {
    const credentials = this.loadServiceAccount();
    if (!credentials) {
      this.logger.warn('FCM désactivé : FIREBASE_SERVICE_ACCOUNT absent (les notifications restent in-app)');
      return;
    }
    try {
      const app =
        admin.apps.find((a) => a?.name === 'voyagooo') ||
        admin.initializeApp({ credential: admin.credential.cert(credentials) }, 'voyagooo');
      this.messaging = app.messaging();
      this.logger.log(`FCM prêt : projet ${credentials.projectId || (credentials as any).project_id}`);
    } catch (err: any) {
      this.logger.error(`FCM non initialisé : ${err.message}`);
    }
  }

  get enabled(): boolean {
    return !!this.messaging;
  }

  /**
   * Compte de service Firebase, au choix :
   * - FIREBASE_SERVICE_ACCOUNT : le JSON brut ou encodé en base64 ;
   * - FIREBASE_SERVICE_ACCOUNT_PATH : chemin du fichier JSON sur le serveur.
   */
  private loadServiceAccount(): admin.ServiceAccount | null {
    try {
      const path = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH');
      let raw = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT')?.trim();
      if (!raw && path) raw = fs.readFileSync(path, 'utf8');
      if (!raw) return null;
      if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
      const json = JSON.parse(raw);
      // Clé privée collée dans un .env : les retours à la ligne arrivent souvent échappés
      if (typeof json.private_key === 'string') json.private_key = json.private_key.replace(/\\n/g, '\n');
      return {
        projectId: json.project_id,
        clientEmail: json.client_email,
        privateKey: json.private_key,
      };
    } catch (err: any) {
      this.logger.error(`Compte de service Firebase illisible : ${err.message}`);
      return null;
    }
  }

  /** Enregistre (ou rattache au compte courant) le jeton FCM d'un appareil. */
  async registerDevice(
    userId: string,
    token: string,
    platform: DevicePlatform,
    appVersion?: string,
    utcOffsetMinutes?: number,
  ) {
    // Heure locale du voyageur : rappels de départ envoyés au bon moment
    if (typeof utcOffsetMinutes === 'number') {
      this.userModel.updateOne({ user_id: userId }, { $set: { utc_offset_minutes: utcOffsetMinutes } }).exec().catch(() => undefined);
    }
    await this.deviceModel
      .updateOne(
        { token },
        { $set: { user_id: userId, platform, app_version: appVersion, last_seen_at: new Date() } },
        { upsert: true },
      )
      .exec();

    // Au-delà de MAX_DEVICES_PER_USER, on oublie les appareils les plus anciens
    const stale = await this.deviceModel
      .find({ user_id: userId })
      .sort({ last_seen_at: -1 })
      .skip(MAX_DEVICES_PER_USER)
      .select('_id')
      .lean()
      .exec();
    if (stale.length) {
      await this.deviceModel.deleteMany({ _id: { $in: stale.map((d) => d._id) } }).exec();
    }
    return { registered: true, push_enabled: this.enabled };
  }

  /** Oublie un appareil (déconnexion, notifications désactivées). */
  async unregisterDevice(userId: string, token: string) {
    const res = await this.deviceModel.deleteOne({ token, user_id: userId }).exec();
    return { removed: res.deletedCount > 0 };
  }

  async deviceCount(userId: string): Promise<number> {
    return this.deviceModel.countDocuments({ user_id: userId }).exec();
  }

  /** Appareils d'un compte, sans le jeton complet (diagnostic). */
  async describeDevices(userId: string) {
    const devices = await this.deviceModel.find({ user_id: userId }).sort({ last_seen_at: -1 }).lean().exec();
    return devices.map((d) => ({
      platform: d.platform,
      token_end: d.token.slice(-8),
      app_version: d.app_version || null,
      last_seen_at: d.last_seen_at,
    }));
  }

  /** Envoie une notification push à tous les appareils d'un utilisateur. Ne lève jamais d'erreur. */
  async sendToUser(userId: string, message: PushMessage): Promise<{ sent: number; failed: number; results?: any[] }> {
    if (!this.messaging) return { sent: 0, failed: 0 };
    const devices = await this.deviceModel.find({ user_id: userId }).select('token').lean().exec();
    if (!devices.length) return { sent: 0, failed: 0 };

    const tokens = devices.map((d) => d.token);
    const data = this.stringifyData(message.data);
    const image = message.imageUrl && /^https:\/\//.test(message.imageUrl) ? message.imageUrl : undefined;

    const withSound = message.sound !== false;
    const aps: Record<string, any> = withSound ? { sound: IOS_SIGNATURE_SOUND } : {};
    if (message.threadId) aps['thread-id'] = message.threadId;
    if (typeof message.badge === 'number') aps.badge = message.badge;
    if (image) aps['mutable-content'] = 1;

    try {
      const res = await this.messaging.sendEachForMulticast({
        tokens,
        notification: { title: message.title, ...(message.body ? { body: message.body } : {}), ...(image ? { imageUrl: image } : {}) },
        data,
        android: {
          priority: 'high',
          ...(message.collapseKey ? { collapseKey: message.collapseKey } : {}),
          notification: {
            channelId: withSound ? ANDROID_SIGNATURE_CHANNEL : message.vibrate ? ANDROID_VIBRATE_CHANNEL : ANDROID_QUIET_CHANNEL,
            ...(withSound ? { sound: SIGNATURE_SOUND } : {}),
            ...(message.collapseKey ? { tag: message.collapseKey } : {}),
          },
        },
        apns: {
          headers: {
            'apns-priority': '10',
            ...(message.collapseKey ? { 'apns-collapse-id': message.collapseKey } : {}),
          },
          payload: { aps },
          ...(image ? { fcmOptions: { imageUrl: image } } : {}),
        },
      });

      const dead: string[] = [];
      res.responses.forEach((r, i) => {
        if (!r.success && r.error && DEAD_TOKEN_ERRORS.has(r.error.code)) dead.push(tokens[i]);
        else if (!r.success) this.logger.warn(`Push non délivré à ${userId}: ${r.error?.code} ${r.error?.message}`);
      });
      if (dead.length) {
        await this.deviceModel.deleteMany({ token: { $in: dead } }).exec();
      }
      const results = res.responses.map((r, i) => ({
        token_end: tokens[i].slice(-8),
        ok: r.success,
        message_id: r.messageId?.split('/').pop() || null,
        error: r.error ? `${r.error.code}: ${r.error.message}` : null,
      }));
      return { sent: res.successCount, failed: res.failureCount, results };
    } catch (err: any) {
      this.logger.warn(`Push en échec pour ${userId}: ${err.message}`);
      return { sent: 0, failed: tokens.length };
    }
  }

  /** FCM n'accepte que des chaînes dans « data ». */
  private stringifyData(data?: Record<string, any>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (value === null || value === undefined) continue;
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
  }
}
