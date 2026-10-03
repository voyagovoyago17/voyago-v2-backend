import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { DEDUPE_INDEX_NAME, Notification, NotificationDocument, NotificationType } from './schemas/notification.schema';
import { ArrivalDto } from './dto/arrival.dto';
import { placeKey } from '../places/place-key';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { PushService } from './push/push.service';

/** Types déjà affichés à l'écran par l'app au moment où ils naissent : pas de push en double. */
const IN_APP_ONLY_TYPES: NotificationType[] = ['arrival'];

export interface CreateNotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  data?: Record<string, any>;
  dedupe_key?: string;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name, GLOBAL_DB_CONNECTION)
    private readonly notificationModel: Model<NotificationDocument>,
    private readonly pushService: PushService,
  ) {}

  /**
   * Remplace l'ancien index unique « sparse » (user_id, dedupe_key), qui n'autorisait
   * qu'une seule notification sans clé par utilisateur, par l'index partiel du schéma.
   */
  async onModuleInit() {
    try {
      const indexes = await this.notificationModel.collection.indexes();
      const legacy = indexes.find((i) => i.name === 'user_id_1_dedupe_key_1');
      if (legacy) {
        await this.notificationModel.collection.dropIndex('user_id_1_dedupe_key_1');
        this.logger.log('Ancien index unique des notifications supprimé');
      }
      if (!indexes.some((i) => i.name === DEDUPE_INDEX_NAME)) {
        await this.notificationModel.collection.createIndex(
          { user_id: 1, dedupe_key: 1 },
          { name: DEDUPE_INDEX_NAME, unique: true, partialFilterExpression: { dedupe_key: { $type: 'string' } } },
        );
      }
    } catch (err: any) {
      this.logger.warn(`Index des notifications non migré : ${err.message}`);
    }
  }

  /** Crée une notification ; avec dedupe_key, renvoie l'existante au lieu d'un doublon. */
  async create(userId: string, input: CreateNotificationInput): Promise<any> {
    if (input.dedupe_key) {
      const existing = await this.notificationModel
        .findOne({ user_id: userId, dedupe_key: input.dedupe_key })
        .lean()
        .exec();
      if (existing) return this.toDto(existing);
    }

    try {
      const doc = await this.notificationModel.create({
        id: uuidv4(),
        user_id: userId,
        type: input.type,
        title: input.title,
        body: input.body || '',
        data: input.data || {},
        read: false,
        dedupe_key: input.dedupe_key,
      });
      const dto = this.toDto(doc.toObject());
      this.pushSafely(userId, dto);
      return dto;
    } catch (err: any) {
      // Course entre deux requêtes simultanées : l'index unique a gagné
      if (err?.code === 11000 && input.dedupe_key) {
        const existing = await this.notificationModel
          .findOne({ user_id: userId, dedupe_key: input.dedupe_key })
          .lean()
          .exec();
        if (existing) return this.toDto(existing);
      }
      throw err;
    }
  }

  /** Version « fire and forget » pour ne jamais bloquer le flux appelant. */
  notifySafely(userId: string, input: CreateNotificationInput): void {
    this.create(userId, input).catch((err) =>
      this.logger.warn(`Notification non créée pour ${userId}: ${err.message}`),
    );
  }

  /** Relaie une notification fraîchement créée en push FCM, sans jamais bloquer ni échouer. */
  private pushSafely(userId: string, n: ReturnType<NotificationsService['toDto']>): void {
    if (!this.pushService.enabled || IN_APP_ONLY_TYPES.includes(n.type)) return;
    (async () => {
      await this.pushService.sendToUser(userId, {
        title: n.title,
        body: n.body,
        imageUrl: n.data?.image_url,
        // L'app lit « payload » pour ouvrir le bon écran, comme depuis la cloche
        data: { notification_id: n.id, type: n.type, payload: n.data },
      });
    })().catch((err) => this.logger.warn(`Push non envoyé à ${userId}: ${err.message}`));
  }

  /**
   * Notification de test (cloche + push), envoyée tout de suite :
   * renvoie le nombre d'appareils enregistrés et le résultat de l'envoi FCM.
   */
  async sendTest(userId: string) {
    const doc = await this.notificationModel.create({
      id: uuidv4(),
      user_id: userId,
      type: 'system',
      title: '🔔 Notifications activées',
      body: 'Tu recevras ici tes itinéraires prêts, commentaires et votes de tribu.',
      data: { test: true },
      read: false,
    });
    const n = this.toDto(doc.toObject());
    const deviceList = await this.pushService.describeDevices(userId);
    const devices = deviceList.length;
    const push = await this.pushService.sendToUser(userId, {
      title: n.title,
      body: n.body,
      data: { notification_id: n.id, type: n.type, payload: n.data },
    });
    return { notification: n, push_enabled: this.pushService.enabled, devices, device_list: deviceList, ...push };
  }

  async list(userId: string, limit = 30): Promise<{ notifications: any[]; unread_count: number }> {
    const safeLimit = Math.min(Math.max(limit || 30, 1), 100);
    const [items, unread] = await Promise.all([
      this.notificationModel.find({ user_id: userId }).sort({ created_at: -1 }).limit(safeLimit).lean().exec(),
      this.notificationModel.countDocuments({ user_id: userId, read: false }).exec(),
    ]);
    return { notifications: items.map((n) => this.toDto(n)), unread_count: unread };
  }

  async unreadCount(userId: string): Promise<{ unread_count: number }> {
    const unread = await this.notificationModel.countDocuments({ user_id: userId, read: false }).exec();
    return { unread_count: unread };
  }

  async markRead(userId: string, id: string): Promise<{ id: string; read: boolean }> {
    const res = await this.notificationModel.updateOne({ id, user_id: userId }, { $set: { read: true } }).exec();
    if (res.matchedCount === 0) throw new NotFoundException(`Notification ${id} introuvable`);
    return { id, read: true };
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.notificationModel
      .updateMany({ user_id: userId, read: false }, { $set: { read: true } })
      .exec();
    return { updated: res.modifiedCount };
  }

  /** Marque comme lues les demandes d'avis d'un lieu (appelé après dépôt de l'avis). */
  async resolveArrivalForPlace(userId: string, key: string): Promise<void> {
    await this.notificationModel
      .updateMany(
        { user_id: userId, type: 'arrival', 'data.place_key': key },
        { $set: { read: true, 'data.reviewed': true } },
      )
      .exec();
  }

  /** Arrivée détectée sur un lieu de l'itinéraire : demande d'avis, une seule fois par lieu et par voyage. */
  async recordArrival(userId: string, dto: ArrivalDto): Promise<any> {
    const key = placeKey(dto.place_name, dto.lat, dto.lng);
    return this.create(userId, {
      type: 'arrival',
      title: `Bienvenue à ${dto.place_name} 📍`,
      body: 'Comment se passe ta visite ? Note ce lieu pour guider les prochains voyageurs.',
      data: {
        place_key: key,
        place_name: dto.place_name,
        lat: dto.lat,
        lng: dto.lng,
        trip_id: dto.trip_id || null,
        destination: dto.destination || null,
        day: dto.day ?? null,
        image_url: dto.image_url || null,
        reviewed: false,
      },
      dedupe_key: `arrival:${dto.trip_id || 'none'}:${key}`,
    });
  }

  private toDto(n: any) {
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: n.data || {},
      read: !!n.read,
      created_at: n.created_at,
    };
  }
}
