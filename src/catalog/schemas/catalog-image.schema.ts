import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CatalogImageDocument = CatalogImage & Document;

/** Catalogue partagé des images : une recherche par lieu, servie à tous les voyageurs */
@Schema({ collection: 'catalog_images', timestamps: true })
export class CatalogImage {
  /** Recherche normalisée (« colisee rome ») */
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  query: string;

  /** null : aucune image trouvée (nouvel essai après 7 jours) */
  @Prop({ type: String, default: null })
  url: string | null;

  @Prop({ type: Date, default: Date.now })
  checked_at: Date;

  @Prop({ default: 0 })
  hits: number;
}

export const CatalogImageSchema = SchemaFactory.createForClass(CatalogImage);
