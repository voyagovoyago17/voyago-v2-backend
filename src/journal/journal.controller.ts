import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JournalService } from './journal.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpsertJournalEntryDto } from './dto/upsert-entry.dto';

@ApiTags('📖 Journal de Voyage')
@ApiBearerAuth()
@Controller('journal')
@UseGuards(SessionAuthGuard)
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  /** Voyages passés (journal) */
  @ApiOperation({ summary: 'Lister les carnets de voyage passés ou en cours de l’utilisateur' })
  @Get()
  async list(@CurrentUser() user: any) {
    return this.journalService.list(user.user_id);
  }

  /** Journal détaillé d'un voyage */
  @ApiOperation({ summary: 'Obtenir les détails complets du carnet de bord d’un voyage' })
  @Get(':tripId')
  async detail(@CurrentUser() user: any, @Param('tripId') tripId: string) {
    return this.journalService.detail(user.user_id, tripId);
  }

  /** Souvenir d'un lieu : note, humeurs, visité */
  @ApiOperation({ summary: 'Enregistrer une note de souvenir, ressenti ou humeur sur un lieu' })
  @Put(':tripId/entries')
  async upsertEntry(@CurrentUser() user: any, @Param('tripId') tripId: string, @Body() dto: UpsertJournalEntryDto) {
    return this.journalService.upsertEntry(user.user_id, tripId, dto);
  }

  /** Ajout d'une photo souvenir (multipart : file, poi_name, day) */
  @ApiOperation({ summary: 'Ajouter une photo souvenir à un lieu du carnet de bord' })
  @Post(':tripId/photos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 4 * 1024 * 1024 } }))
  async addPhoto(
    @CurrentUser() user: any,
    @Param('tripId') tripId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('poi_name') poiName: string,
    @Body('day', new ParseIntPipe({ optional: true })) day?: number,
  ) {
    return this.journalService.addPhoto(user.user_id, tripId, poiName, day || 1, file);
  }

  @ApiOperation({ summary: 'Supprimer une photo souvenir du carnet de voyage' })
  @Delete(':tripId/photos/:key')
  async removePhoto(@CurrentUser() user: any, @Param('tripId') tripId: string, @Param('key') key: string) {
    return this.journalService.removePhoto(user.user_id, tripId, key);
  }

  /** Terminer le voyage : il quitte la carte et rejoint le journal */
  @ApiOperation({ summary: 'Clôturer le voyage : l’archive dans le journal et libère la carte' })
  @Post(':tripId/complete')
  async complete(@CurrentUser() user: any, @Param('tripId') tripId: string) {
    return this.journalService.complete(user.user_id, tripId);
  }

  /** Remettre le voyage sur la carte */
  @ApiOperation({ summary: 'Réouvrir un voyage archivé pour le remettre en cours sur la carte' })
  @Post(':tripId/reopen')
  async reopen(@CurrentUser() user: any, @Param('tripId') tripId: string) {
    return this.journalService.reopen(user.user_id, tripId);
  }

  /** Partager le journal à la communauté (+5 XP la première fois) */
  @ApiOperation({ summary: 'Partager le carnet de voyage avec la communauté Voyagooo (+5 XP)' })
  @Post(':tripId/share')
  async share(@CurrentUser() user: any, @Param('tripId') tripId: string) {
    return this.journalService.share(user.user_id, tripId);
  }
}
