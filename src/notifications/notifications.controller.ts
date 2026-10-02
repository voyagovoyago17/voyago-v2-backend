import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ArrivalDto } from './dto/arrival.dto';
import { RegisterDeviceDto, UnregisterDeviceDto } from './dto/register-device.dto';
import { PushService } from './push/push.service';

@Controller('notifications')
@UseGuards(SessionAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
  ) {}

  /** Enregistre le jeton FCM de l'appareil (à chaque lancement et à chaque rotation du jeton). */
  @Post('devices')
  async registerDevice(@CurrentUser() user: any, @Body() dto: RegisterDeviceDto) {
    return this.pushService.registerDevice(user.user_id, dto.token, dto.platform, dto.app_version);
  }

  /** Oublie l'appareil (déconnexion) : il ne reçoit plus les push de ce compte. */
  @Delete('devices')
  @HttpCode(200)
  async unregisterDevice(@CurrentUser() user: any, @Body() dto: UnregisterDeviceDto) {
    return this.pushService.unregisterDevice(user.user_id, dto.token);
  }

  @Get()
  async list(@CurrentUser() user: any, @Query('limit') limit?: string) {
    return this.notificationsService.list(user.user_id, limit ? parseInt(limit, 10) : undefined);
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: any) {
    return this.notificationsService.unreadCount(user.user_id);
  }

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

  @Post('arrival')
  async arrival(@CurrentUser() user: any, @Body() dto: ArrivalDto) {
    return this.notificationsService.recordArrival(user.user_id, dto);
  }

  @Post(':id/read')
  async markRead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.notificationsService.markRead(user.user_id, id);
  }
}
