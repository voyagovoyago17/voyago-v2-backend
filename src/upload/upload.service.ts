import { isProActive } from '../pro/pro-status';
import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UTApi, UTFile } from 'uploadthing/server';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { GLOBAL_DB_CONNECTION } from '../common/constants';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private utapi: UTApi;

  constructor(
    @InjectModel(User.name, GLOBAL_DB_CONNECTION)
    private readonly userModel: Model<UserDocument>,
    private readonly configService: ConfigService,
  ) {
    const token =
      this.configService.get<string>('UPLOADTHING_TOKEN') ||
      this.configService.get<string>('UPLOADTHING_SECRET');

    this.utapi = new UTApi(token ? { token } : undefined);
    this.logger.log('UploadThing client initialized successfully');
  }

  /**
   * Extrait la clé de fichier UploadThing (fileKey) à partir d'une URL ou d'une clé brute.
   * Gère les formats utfs.io/f/{key}, ufs.sh/f/{key}, etc.
   */
  extractFileKey(urlOrKey?: string | null): string | null {
    if (!urlOrKey || typeof urlOrKey !== 'string') return null;
    const trimmed = urlOrKey.trim();
    if (!trimmed) return null;

    // Si c'est déjà une clé sans URL (ex: "abc-123.jpg")
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return trimmed;
    }

    try {
      const url = new URL(trimmed);
      let key: string | null = null;
      // Format 1 : https://utfs.io/f/<key> ou https://ufs.sh/f/<key>
      if (url.pathname.startsWith('/f/')) {
        key = url.pathname.substring(3);
      } else {
        // Format 2 : https://<bucket>.ufs.sh/f/<key> ou direct key path
        const parts = url.pathname.split('/').filter(Boolean);
        key = parts.length > 0 ? parts[parts.length - 1] : null;
      }
      if (key) {
        return key.split('?')[0].split('#')[0];
      }
    } catch (_) {
      const parts = trimmed.split('/').filter(Boolean);
      return parts.length > 0
        ? parts[parts.length - 1].split('?')[0].split('#')[0]
        : trimmed;
    }

    return null;
  }

  /**
   * Supprime de façon sécurisée un fichier stocké sur UploadThing pour éviter les fichiers orphelins.
   */
  async deleteFileFromUploadThing(fileKeyOrUrl: string): Promise<boolean> {
    const key = this.extractFileKey(fileKeyOrUrl);
    if (!key) return false;

    try {
      await this.utapi.deleteFiles(key);
      this.logger.log(`Successfully deleted file from UploadThing: ${key}`);
      return true;
    } catch (err: any) {
      this.logger.warn(
        `Could not delete file ${key} from UploadThing (may already be deleted): ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Upload la nouvelle photo de profil de l'utilisateur :
   * 1. Valide le format et le poids de l'image (max 4MB).
   * 2. Écrase et supprime immédiatement l'ancienne photo sur UploadThing (anti-orphelins).
   * 3. Transfère le nouveau fichier sur UploadThing via UTApi.
   * 4. Écrase et met à jour la base de données (picture + picture_key).
   * 5. Conserve l'avatar emoji par défaut sélectionné.
   */
  /**
   * Upload générique d'une image (photos du journal de voyage…).
   * Mêmes formats et limite que la photo de profil.
   */
  async uploadImage(
    file: Express.Multer.File,
    fileNamePrefix: string,
  ): Promise<{ url: string; key: string }> {
    if (!file) {
      throw new BadRequestException('Aucun fichier fourni pour l\'upload');
    }
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (!allowedMimeTypes.includes(file.mimetype.toLowerCase())) {
      throw new BadRequestException(
        `Format d'image non supporté (${file.mimetype}). Formats acceptés : JPG, PNG, WEBP, HEIC.`,
      );
    }
    if (file.size > 4 * 1024 * 1024) {
      throw new BadRequestException('L\'image est trop volumineuse. Limite maximale : 4MB.');
    }

    try {
      const ext = file.originalname?.includes('.') ? file.originalname.split('.').pop() : 'jpg';
      const utFile = new UTFile([new Uint8Array(file.buffer)], `${fileNamePrefix}_${Date.now()}.${ext}`, {
        type: file.mimetype,
      });
      const res = await this.utapi.uploadFiles(utFile);
      if (res.error || !res.data) {
        throw new Error(res.error?.message || 'UploadThing rejected file');
      }
      return { url: res.data.ufsUrl || res.data.url, key: res.data.key };
    } catch (err: any) {
      this.logger.error(`Upload error (${fileNamePrefix}): ${err.message}`);
      throw new InternalServerErrorException(`Erreur lors du transfert vers UploadThing: ${err.message}`);
    }
  }

  async uploadProfilePicture(
    user: UserDocument,
    file: Express.Multer.File,
  ): Promise<{ picture: string; picture_key: string; user: object }> {
    if (!file) {
      throw new BadRequestException('Aucun fichier fourni pour l\'upload');
    }

    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/heic',
      'image/heif',
    ];

    if (!allowedMimeTypes.includes(file.mimetype.toLowerCase())) {
      throw new BadRequestException(
        `Format d'image non supporté (${file.mimetype}). Formats acceptés : JPG, PNG, WEBP, GIF, HEIC.`,
      );
    }

    const maxSizeBytes = 4 * 1024 * 1024; // 4MB
    if (file.size > maxSizeBytes) {
      throw new BadRequestException(
        `L'image est trop volumineuse (${(file.size / (1024 * 1024)).toFixed(1)}MB). Limite maximale : 4MB.`,
      );
    }

    // --- ÉTAPE ANTI-ORPHELIN : Récupération de l'état frais & suppression de l'ancien fichier sur UploadThing ---
    const freshUser = await this.userModel.findOne({ user_id: user.user_id }).exec();
    const oldKey =
      freshUser?.picture_key ||
      user.picture_key ||
      this.extractFileKey(freshUser?.picture) ||
      this.extractFileKey(user.picture);

    if (oldKey) {
      this.logger.log(`Overwriting profile picture: removing old UploadThing asset: ${oldKey}`);
      await this.deleteFileFromUploadThing(oldKey);
    }

    // --- ÉTAPE UPLOAD : Envoi sur UploadThing ---
    let newUrl: string;
    let newKey: string;

    try {
      const ext = file.originalname?.includes('.')
        ? file.originalname.split('.').pop()
        : 'jpg';
      const cleanFileName = `profile_${user.user_id}_${Date.now()}.${ext}`;

      // Conversion du Buffer en Uint8Array pour satisfaire BlobPart sans incompatibilité SharedArrayBuffer
      const uint8Array = new Uint8Array(file.buffer);
      const utFile = new UTFile([uint8Array], cleanFileName, {
        type: file.mimetype,
      });

      const res = await this.utapi.uploadFiles(utFile);

      if (res.error || !res.data) {
        throw new Error(res.error?.message || 'UploadThing rejected file');
      }

      newUrl = res.data.ufsUrl || res.data.url;
      newKey = res.data.key;
      this.logger.log(`Uploaded new profile picture for ${user.user_id}: ${newUrl}`);
    } catch (err: any) {
      this.logger.error(`Upload error for user ${user.user_id}: ${err.message}`);
      throw new InternalServerErrorException(
        `Erreur lors du transfert vers UploadThing: ${err.message}`,
      );
    }

    // --- ÉTAPE SAUVEGARDE BD : Écrasement propre des champs picture et picture_key ---
    const updatedUser = await this.userModel
      .findOneAndUpdate(
        { user_id: user.user_id },
        {
          $set: {
            picture: newUrl,
            picture_key: newKey,
          },
        },
        { new: true },
      )
      .exec();

    const sanitized = this.sanitizeUser(updatedUser || user);

    return {
      picture: newUrl,
      picture_key: newKey,
      user: sanitized,
    };
  }

  /**
   * Supprime la photo de profil personnalisée :
   * 1. Supprime le fichier d'UploadThing pour éviter les orphelins.
   * 2. Remet picture et picture_key à null dans la BD.
   * 3. L'avatar emoji par défaut redevient actif.
   */
  async deleteProfilePicture(
    user: UserDocument,
  ): Promise<{ message: string; user: object }> {
    const freshUser = await this.userModel.findOne({ user_id: user.user_id }).exec();
    const keyToDelete =
      freshUser?.picture_key ||
      user.picture_key ||
      this.extractFileKey(freshUser?.picture) ||
      this.extractFileKey(user.picture);

    if (keyToDelete) {
      await this.deleteFileFromUploadThing(keyToDelete);
    }

    const updatedUser = await this.userModel
      .findOneAndUpdate(
        { user_id: user.user_id },
        {
          $set: {
            picture: null,
            picture_key: null,
          },
        },
        { new: true },
      )
      .exec();

    const sanitized = this.sanitizeUser(updatedUser || user);

    return {
      message: 'Photo de profil supprimée avec succès. Avatar emoji actif.',
      user: sanitized,
    };
  }

  /**
   * Diagnostic de l'intégration UploadThing.
   */
  getStatus(): object {
    const hasToken = !!(
      this.configService.get<string>('UPLOADTHING_TOKEN') ||
      this.configService.get<string>('UPLOADTHING_SECRET')
    );
    const appId = this.configService.get<string>('UPLOADTHING_APP_ID') || null;

    return {
      service: 'UploadThing Media Storage',
      configured: hasToken,
      appId,
      maxFileSize: '4MB',
      supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'],
      defaultAvatarFallback: 'avatar_emoji',
    };
  }

  private sanitizeUser(user: any): object {
    const obj = user.toObject ? user.toObject() : { ...user };
    delete obj.password_hash;
    delete obj._id;
    delete obj.__v;
    obj.pro_active = isProActive(obj);
    return obj;
  }
}
