import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CommunityCircleDocument = CommunityCircle & Document;

/** Conditions d'accès d'un cercle : chaque champ absent = pas de condition. */
export interface CircleJoinRules {
  /** Niveau d'explorateur minimum */
  min_level?: number;
  /** Âge minimum (d'après la date de naissance du profil) */
  min_age?: number;
  /** Abonnement Pro actif obligatoire */
  pro_only?: boolean;
  /** Adresse e-mail vérifiée obligatoire */
  verified_email?: boolean;
  /** Nombre maximum de membres (places limitées) */
  max_members?: number;
}

@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
export class CommunityCircle {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, index: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ default: '🧭' })
  avatar_emoji: string;

  @Prop({ default: '' })
  cover_image_url: string;

  @Prop({ default: 'general', index: true })
  category: string; // 'culture', 'nature', 'roadtrip', 'food', 'relax', 'adventure', 'solo', 'general'

  @Prop({ default: null })
  destination_city: string;

  @Prop({ default: null })
  destination_country: string;

  @Prop({ required: true, index: true })
  creator_id: string;

  @Prop({ default: 1 })
  members_count: number;

  @Prop({ default: 0 })
  trips_count: number;

  @Prop({ default: 0 })
  posts_count: number;

  @Prop({ default: true })
  is_public: boolean;

  /** Code d'invitation des cercles privés (seul moyen de les rejoindre) */
  @Prop({ type: String, required: false })
  invite_code?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  /**
   * Cercle privé visible dans la liste (cadenas + demande d'adhésion).
   * false = cercle secret : invisible, accessible uniquement par code.
   */
  @Prop({ default: true })
  listed: boolean;

  /** Conditions d'accès (facultatives) vérifiées automatiquement par le système */
  @Prop({ type: Object, default: {} })
  join_rules: CircleJoinRules;

  /** Demande acceptée automatiquement quand toutes les conditions sont remplies */
  @Prop({ default: false })
  auto_approve: boolean;

  /** Question posée aux voyageurs qui demandent à rejoindre (facultative) */
  @Prop({ default: '' })
  join_question: string;

  @Prop()
  created_at: Date;

  @Prop()
  updated_at: Date;
}

export const CommunityCircleSchema = SchemaFactory.createForClass(CommunityCircle);

// Unicité des codes d'invitation, en ignorant les cercles qui n'en ont pas
CommunityCircleSchema.index(
  { invite_code: 1 },
  { unique: true, partialFilterExpression: { invite_code: { $type: 'string' } } },
);
