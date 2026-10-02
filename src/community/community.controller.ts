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
import { TribeTripsService } from './tribe-trips.service';
import { CircleChallengesService } from './circle-challenges.service';
import { CreateTripPlanDto, JoinTripPlanDto, VoteTripPlanDto } from './dto/create-trip-plan.dto';
import { COMMENT_TARGET_TYPES, CommentTargetType } from './schemas/community-comment.schema';

@Controller('community')
export class CommunityController {
  constructor(
    private readonly communityService: CommunityService,
    private readonly socialService: CommunitySocialService,
    private readonly tribeTripsService: TribeTripsService,
    private readonly challengesService: CircleChallengesService,
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
  async getUserPublicProfile(
    @Param('id') id: string,
    @Headers('authorization') authHeader?: string,
  ) {
    return this.communityService.getUserPublicProfile(id, authHeader);
  }

  // Blocage : les contenus des deux voyageurs sont masqués l'un pour l'autre
  @Get('blocks')
  @UseGuards(SessionAuthGuard)
  async listBlockedUsers(@CurrentUser() user: any) {
    return this.communityService.listBlockedUsers(user.user_id);
  }

  @Post('users/:id/block')
  @UseGuards(SessionAuthGuard)
  async blockUser(@CurrentUser() user: any, @Param('id') id: string) {
    return this.communityService.blockUser(user.user_id, id);
  }

  @Delete('users/:id/block')
  @UseGuards(SessionAuthGuard)
  async unblockUser(@CurrentUser() user: any, @Param('id') id: string) {
    return this.communityService.unblockUser(user.user_id, id);
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

  // =========================================================================
  // 5. VOYAGES DE TRIBU & DÉFIS DE CERCLE
  // =========================================================================

  /** Défis du mois de la tribu et progression */
  @Get('circles/:id/challenges')
  async getChallenges(@Param('id') id: string, @Headers('authorization') authHeader?: string) {
    return this.challengesService.getChallenges(id, authHeader);
  }

  @Get('circles/:id/trip-plans')
  async listTripPlans(@Param('id') id: string, @Headers('authorization') authHeader?: string) {
    return this.tribeTripsService.listPlans(id, authHeader);
  }

  /** Lancer un voyage de tribu : l'IA propose des lieux soumis au vote des membres */
  @Post('circles/:id/trip-plans')
  @UseGuards(SessionAuthGuard)
  async createTripPlan(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: CreateTripPlanDto) {
    return this.tribeTripsService.createPlan(user, id, dto);
  }

  @Get('trip-plans/:planId')
  async getTripPlan(@Param('planId') planId: string, @Headers('authorization') authHeader?: string) {
    return this.tribeTripsService.getPlan(planId, authHeader);
  }

  @Post('trip-plans/:planId/votes')
  @UseGuards(SessionAuthGuard)
  async voteTripPlan(@CurrentUser() user: any, @Param('planId') planId: string, @Body() dto: VoteTripPlanDto) {
    return this.tribeTripsService.vote(user.user_id, planId, dto.poi_key, dto.vote);
  }

  @Post('trip-plans/:planId/finalize')
  @UseGuards(SessionAuthGuard)
  async finalizeTripPlan(@CurrentUser() user: any, @Param('planId') planId: string) {
    return this.tribeTripsService.finalize(user.user_id, planId);
  }

  /** Ajouter le voyage de tribu finalisé à mes voyages */
  @Post('trip-plans/:planId/join')
  @UseGuards(SessionAuthGuard)
  async joinTripPlan(@CurrentUser() user: any, @Param('planId') planId: string, @Body() dto: JoinTripPlanDto) {
    return this.tribeTripsService.join(user, planId, dto.start_date);
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
