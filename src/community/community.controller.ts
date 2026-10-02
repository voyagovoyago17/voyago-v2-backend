import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Headers,
} from '@nestjs/common';
import { CommunityService } from './community.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateCircleDto } from './dto/create-circle.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { ShareTripToCircleDto } from './dto/share-trip.dto';
import { JoinCircleByCodeDto } from './dto/join-by-code.dto';

@Controller('community')
export class CommunityController {
  constructor(private readonly communityService: CommunityService) {}

  // =========================================================================
  // 1. PUBLIC FEED & USER PUBLIC PROFILE (LOGIQUE EXISTANTE CONSERVÉE)
  // =========================================================================

  @Get('feed')
  async getPublicFeed(@Headers('authorization') authHeader?: string) {
    return this.communityService.getPublicFeed(authHeader);
  }

  @Get('user/:id')
  async getUserPublicProfile(@Param('id') id: string) {
    return this.communityService.getUserPublicProfile(id);
  }

  @Post('trip/:id/like')
  @UseGuards(SessionAuthGuard)
  async toggleLikeTrip(@CurrentUser() user: any, @Param('id') id: string) {
    return this.communityService.toggleLikeTrip(user.user_id, id);
  }

  // =========================================================================
  // 2. CERCLES & TRIBUS COMMUNAUTAIRES
  // =========================================================================

  @Get('circles')
  async getCircles(
    @Query('category') category?: string,
    @Query('destination') destination?: string,
    @Query('search') search?: string,
    @Query('my_user_id') my_user_id?: string,
    @Query('limit') limit?: string,
    @Headers('authorization') authHeader?: string,
  ) {
    return this.communityService.getCircles(
      {
        category,
        destination,
        search,
        my_user_id,
        limit: limit ? parseInt(limit, 10) : undefined,
      },
      authHeader,
    );
  }

  @Post('circles')
  @UseGuards(SessionAuthGuard)
  async createCircle(
    @CurrentUser() user: any,
    @Body() dto: CreateCircleDto,
  ) {
    return this.communityService.createCircle(user.user_id, dto);
  }

  /** Rejoindre un cercle privé avec son code d'invitation */
  @Post('circles/join-by-code')
  @UseGuards(SessionAuthGuard)
  async joinCircleByCode(
    @CurrentUser() user: any,
    @Body() dto: JoinCircleByCodeDto,
  ) {
    return this.communityService.joinCircleByCode(user.user_id, dto.code);
  }

  @Get('circles/:id')
  async getCircleById(
    @Param('id') id: string,
    @Query('user_id') userId?: string,
    @Headers('authorization') authHeader?: string,
  ) {
    return this.communityService.getCircleById(id, userId, authHeader);
  }

  @Post('circles/:id/join')
  @UseGuards(SessionAuthGuard)
  async joinCircle(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.communityService.joinCircle(user.user_id, id);
  }

  /** Générer un nouveau code d'invitation (créateur / admin d'un cercle privé) */
  @Post('circles/:id/invite-code')
  @UseGuards(SessionAuthGuard)
  async regenerateInviteCode(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.communityService.regenerateInviteCode(user.user_id, id);
  }

  @Post('circles/:id/leave')
  @UseGuards(SessionAuthGuard)
  async leaveCircle(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.communityService.leaveCircle(user.user_id, id);
  }

  @Delete('circles/:id/leave')
  @UseGuards(SessionAuthGuard)
  async leaveCircleDelete(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.communityService.leaveCircle(user.user_id, id);
  }

  // =========================================================================
  // 3. POSTS, MOMENTS & PARTAGES DE VOYAGES
  // =========================================================================

  @Get('circles/:id/posts')
  async getCirclePosts(
    @Param('id') id: string,
    @Headers('authorization') authHeader?: string,
  ) {
    return this.communityService.getCirclePosts(id, authHeader);
  }

  @Post('circles/:id/posts')
  @UseGuards(SessionAuthGuard)
  async createPost(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: CreatePostDto,
  ) {
    return this.communityService.createPost(user.user_id, id, dto);
  }

  @Post('circles/:id/share-trip')
  @UseGuards(SessionAuthGuard)
  async shareTripToCircle(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: ShareTripToCircleDto,
  ) {
    return this.communityService.shareTripToCircle(user.user_id, id, dto);
  }

  @Post('posts/:id/like')
  @UseGuards(SessionAuthGuard)
  async toggleLikePost(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.communityService.toggleLikePost(user.user_id, id);
  }
}
