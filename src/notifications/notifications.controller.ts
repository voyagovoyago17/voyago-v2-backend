import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ArrivalDto } from './dto/arrival.dto';
import { RegisterDeviceDto, UnregisterDeviceDto } from './dto/register-device.dto';
import { PushService } from './push/push.service';

@ApiTags('🔔 Notifications & Alertes')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(SessionAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
  ) {}

  /** Enregistre le jeton FCM de l'appareil (à chaque lancement et à chaque rotation du jeton). */
  @ApiOperation({ summary: 'Enregistrer le jeton push FCM d’un appareil mobile' })
  @Post('devices')
  async registerDevice(@CurrentUser() user: any, @Body() dto: RegisterDeviceDto) {
    return this.pushService.registerDevice(user.user_id, dto.token, dto.platform, dto.app_version, dto.utc_offset_minutes);
  }

  /** Oublie l'appareil (déconnexion) : il ne reçoit plus les push de ce compte. */
  @ApiOperation({ summary: 'Désenregistrer un appareil mobile lors de la déconnexion' })
  @Delete('devices')
  @HttpCode(200)
  async unregisterDevice(@CurrentUser() user: any, @Body() dto: UnregisterDeviceDto) {
    return this.pushService.unregisterDevice(user.user_id, dto.token);
  }

  @ApiOperation({ summary: 'Lister les notifications in-app reçues par l’utilisateur' })
  @Get()
  async list(@CurrentUser() user: any, @Query('limit') limit?: string) {
    return this.notificationsService.list(user.user_id, limit ? parseInt(limit, 10) : undefined);
  }

  @ApiOperation({ summary: 'Nombre de notifications non lues' })
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: any) {
    return this.notificationsService.unreadCount(user.user_id);
  }

  @ApiOperation({ summary: 'Marquer toutes les notifications comme lues' })
  @Post('read-all')
  async markAllRead(@CurrentUser() user: any) {
    return this.notificationsService.markAllRead(user.user_id);
  }

  /** Envoie une notification de test à mes appareils (diagnostic des push). */
  @Post('test')
  @HttpCode(200)
  async sendTest(@CurrentUser() user: any) {
    return this.notificationsService.sendTest(user.user_id);
  }

  @ApiOperation({ summary: 'Enregistrer l’arrivée GPS sur un lieu pour déclencher les alertes et XP' })
  @Post('arrival')
  async arrival(@CurrentUser() user: any, @Body() dto: ArrivalDto) {
    return this.notificationsService.recordArrival(user.user_id, dto);
  }

  @ApiOperation({ summary: 'Marquer une notification spécifique comme lue' })
  @Post(':id/read')
  async markRead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.notificationsService.markRead(user.user_id, id);
  }
}
