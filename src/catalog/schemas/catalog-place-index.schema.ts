import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CatalogPlaceIndexDocument = CatalogPlaceIndex & Document;

/** Lieux réels d'une destination (OpenStreetMap + Wikipédia), partagés par tous les voyages */
@Schema({ collection: 'catalog_place_index', timestamps: true })
export class CatalogPlaceIndex {
  /** « abidjan|5.32|-4.02 » */
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  destination: string;

  @Prop({ type: [Object], default: [] })
  places: { name: string; lat: number; lng: number; source: string; kind?: string; wiki?: { lang: string; title: string }; food?: boolean }[];

  @Prop({ type: Date, default: Date.now })
  fetched_at: Date;
}

export const CatalogPlaceIndexSchema = SchemaFactory.createForClass(CatalogPlaceIndex);
