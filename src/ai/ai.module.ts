import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AiService } from './ai.service';
import { PlaceGroundingService } from './place-grounding.service';
import { CatalogPlaceIndex, CatalogPlaceIndexSchema } from '../catalog/schemas/catalog-place-index.schema';
import { CatalogImage, CatalogImageSchema } from '../catalog/schemas/catalog-image.schema';
import { GLOBAL_DB_CONNECTION } from '../common/constants';

@Module({
  imports: [
    ConfigModule,
    // Catalogue partagé des images : chaque lieu n'est cherché qu'une fois
    MongooseModule.forFeature(
      [
        { name: CatalogImage.name, schema: CatalogImageSchema },
        // Lieux réels des destinations (OpenStreetMap + Wikipédia), pour ancrer l'IA dans le réel
        { name: CatalogPlaceIndex.name, schema: CatalogPlaceIndexSchema },
      ],
      GLOBAL_DB_CONNECTION,
    ),
  ],
  providers: [AiService, PlaceGroundingService],
  exports: [AiService, PlaceGroundingService],
})
export class AiModule {}
