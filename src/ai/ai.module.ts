import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AiService } from './ai.service';
import { CatalogImage, CatalogImageSchema } from '../catalog/schemas/catalog-image.schema';
import { GLOBAL_DB_CONNECTION } from '../common/constants';

@Module({
  imports: [
    ConfigModule,
    // Catalogue partagé des images : chaque lieu n'est cherché qu'une fois
    MongooseModule.forFeature([{ name: CatalogImage.name, schema: CatalogImageSchema }], GLOBAL_DB_CONNECTION),
  ],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
