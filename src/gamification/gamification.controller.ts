import { Controller, Get, Post, Body, Param, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { GamificationService, SERVER_ONLY_XP_ACTIONS } from './gamification.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { IsString } from 'class-validator';

class AwardXpDto {
  @IsString()
  user_id: string;

  @IsString()
  action: string;
}

@ApiTags('🏆 Gamification & XP')
@Controller()
export class GamificationController {
  constructor(private readonly gamificationService: GamificationService) {}

  @ApiOperation({ summary: 'Obtenir le profil complet de gamification (XP, niveau, rang, stats)' })
  @Get('profile/:user_id')
  async getProfile(@Param('user_id') user_id: string) {
    return this.gamificationService.getProfile(user_id);
  }

  @ApiOperation({ summary: 'Attribuer de l’XP pour une action accomplie dans l’application' })
  @ApiBearerAuth()
  @Post(['profile/xp', 'profile/award-xp'])
  @UseGuards(SessionAuthGuard)
  async awardXP(@Body() body: AwardXpDto, @Req() req: any) {
    const authUserId = req.user?.user_id;
    if (authUserId && body.user_id && authUserId !== body.user_id) {
      throw new ForbiddenException('Anti-cheat: Cannot award XP to another user account');
    }
    if (SERVER_ONLY_XP_ACTIONS.includes(body.action)) {
      throw new ForbiddenException('Anti-cheat: this XP action is awarded by the server only');
    }
    const targetUserId = authUserId || body.user_id;
    return this.gamificationService.awardXP(targetUserId, body.action);
  }

  @ApiOperation({ summary: 'Liste des paliers de niveaux et récompenses XP globales' })
  @Get(['xp/rewards', 'xp-rewards'])
  async getXpRewards() {
    return this.gamificationService.getXpRewards();
  }

  @ApiOperation({ summary: 'Statut des récompenses XP et progression pour un utilisateur' })
  @Get(['xp/rewards/:user_id', 'xp-rewards/:user_id'])
  async getXpRewardsForUser(@Param('user_id') user_id: string) {
    return this.gamificationService.getXpRewards(user_id);
  }

  @ApiOperation({ summary: 'Catalogue complet des badges disponibles à débloquer' })
  @Get('badges')
  getBadges() {
    return this.gamificationService.getBadges();
  }
}
