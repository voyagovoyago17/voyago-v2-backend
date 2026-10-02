import {
  Controller,
  Post,
  Delete,
  Get,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBearerAuth } from '@nestjs/swagger';
import { UploadService } from './upload.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from '../auth/schemas/user.schema';

@ApiTags('📷 Médias & Uploads')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('profile-picture')
  @UseGuards(SessionAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Uploader une photo de profil via UploadThing (anti-orphelins automatique)' })
  @ApiConsumes('multipart/form-data')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 4 * 1024 * 1024, // 4 MB
      },
    }),
  )
  async uploadProfilePicture(
    @CurrentUser() user: UserDocument,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Fichier image manquant (champ: "file")');
    }
    return this.uploadService.uploadProfilePicture(user, file);
  }

  @Delete('profile-picture')
  @UseGuards(SessionAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer la photo de profil et restaurer l\'avatar emoji par défaut' })
  @HttpCode(HttpStatus.OK)
  async deleteProfilePicture(@CurrentUser() user: UserDocument) {
    return this.uploadService.deleteProfilePicture(user);
  }

  @Get('status')
  @ApiOperation({ summary: 'Vérifier la configuration du service UploadThing' })
  getStatus() {
    return this.uploadService.getStatus();
  }
}
