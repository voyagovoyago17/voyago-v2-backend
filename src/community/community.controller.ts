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
  BadRequestException,
} from '@nestjs/common';
import { CommunityService } from './community.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateCircleDto } from './dto/create-circle.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { ShareTripToCircleDto } from './dto/share-trip.dto';
import { JoinCircleByCodeDto } from './dto/join-by-code.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ReportContentDto } from './dto/report.dto';
import { CommunitySocialService } from './community-social.service';
import { COMMENT_TARGET_TYPES, CommentTargetType } from './schemas/community-comment.schema';

@Controller('community')
export class CommunityController {
  constructor(
    private readonly communityService: CommunityService,
    private readonly socialService: CommunitySocialService,
  ) {}

  // =========================================================================
  // 1. PUBLIC FEED & USER PUBLIC PROFILE (LOGIQUE EXISTANTE CONSERVÉE)
  // =========================================================================

  @Get('feed')
  async getPublicFeed(@Headers('authorization') authHeader?: string) {
    return this.communityService.getPublicFeed(authHeader);
  }

  /** Fil d'actualité : voyages visibles + publications de mes cercles (pagination par curseur) */
  @Get('home-feed')
  async getHomeFeed(
    @Headers('authorization') authHeader?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.communityService.getHomeFeed(authHeader, before, limit ? parseInt(limit, 10) : undefined);
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

  @Delete('posts/:id')
  @UseGuards(SessionAuthGuard)
  async deletePost(@CurrentUser() user: any, @Param('id') id: string) {
    return this.socialService.deletePost(user.user_id, id);
  }

  // =========================================================================
  // 4. COMMENTAIRES & SIGNALEMENTS
  // =========================================================================

  @Get('comments')
  async getComments(
    @Query('target_type') targetType: string,
    @Query('target_id') targetId: string,
    @Headers('authorization') authHeader?: string,
  ) {
    if (!(COMMENT_TARGET_TYPES as readonly string[]).includes(targetType) || !targetId) {
      throw new BadRequestException('target_type (trip | post) et target_id sont requis');
    }
    return this.socialService.listComments(targetType as CommentTargetType, targetId, authHeader);
  }

  @Post('comments')
  @UseGuards(SessionAuthGuard)
  async addComment(@CurrentUser() user: any, @Body() dto: CreateCommentDto) {
    return this.socialService.addComment(user.user_id, dto);
  }

  @Delete('comments/:id')
  @UseGuards(SessionAuthGuard)
  async deleteComment(@CurrentUser() user: any, @Param('id') id: string) {
    return this.socialService.deleteComment(user.user_id, id);
  }

  @Post('reports')
  @UseGuards(SessionAuthGuard)
  async report(@CurrentUser() user: any, @Body() dto: ReportContentDto) {
    return this.socialService.report(user.user_id, dto.target_type, dto.target_id, dto.reason);
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
