import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { Trip, TripSchema } from '../trips/schemas/trip.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { UserSession, UserSessionSchema } from '../auth/schemas/user-session.schema';
import { CommunityCircle, CommunityCircleSchema } from './schemas/community-circle.schema';
import { CommunityMember, CommunityMemberSchema } from './schemas/community-member.schema';
import { CommunityPost, CommunityPostSchema } from './schemas/community-post.schema';
import { CommunityComment, CommunityCommentSchema } from './schemas/community-comment.schema';
import { CommunityReport, CommunityReportSchema } from './schemas/community-report.schema';
import { CommunitySocialService } from './community-social.service';
import { UserBlock, UserBlockSchema } from './schemas/user-block.schema';
import { CircleTripPlan, CircleTripPlanSchema } from './schemas/circle-trip-plan.schema';
import { CircleTripVote, CircleTripVoteSchema } from './schemas/circle-trip-vote.schema';
import {
  CircleChallengeCompletion,
  CircleChallengeCompletionSchema,
} from './schemas/circle-challenge-completion.schema';
import { PlaceReview, PlaceReviewSchema } from '../places/schemas/place-review.schema';
import { TribeTripsService } from './tribe-trips.service';
import { CircleAccessService } from './circle-access.service';
import { CircleJoinRequest, CircleJoinRequestSchema } from './schemas/circle-join-request.schema';
import { CircleChallengesService } from './circle-challenges.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { TenancyModule } from '../tenancy/tenancy.module';
import { GamificationModule } from '../gamification/gamification.module';
import { TripsModule } from '../trips/trips.module';

import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';

@Module({
  imports: [
    // Shared community data in voyago_tenants
    MongooseModule.forFeature(
      [
        { name: Trip.name, schema: TripSchema },
        { name: CommunityCircle.name, schema: CommunityCircleSchema },
        { name: CommunityMember.name, schema: CommunityMemberSchema },
        { name: CommunityPost.name, schema: CommunityPostSchema },
        { name: CommunityComment.name, schema: CommunityCommentSchema },
        { name: CommunityReport.name, schema: CommunityReportSchema },
        { name: UserBlock.name, schema: UserBlockSchema },
        { name: CircleTripPlan.name, schema: CircleTripPlanSchema },
        { name: CircleTripVote.name, schema: CircleTripVoteSchema },
        { name: CircleChallengeCompletion.name, schema: CircleChallengeCompletionSchema },
        { name: CircleJoinRequest.name, schema: CircleJoinRequestSchema },
      ],
      TENANT_DB_CONNECTION,
    ),
    MongooseModule.forFeature(
      [
        { name: User.name, schema: UserSchema },
        { name: UserSession.name, schema: UserSessionSchema },
        // Avis de lieux : défi « Explorer le terrain »
        { name: PlaceReview.name, schema: PlaceReviewSchema },
      ],
      GLOBAL_DB_CONNECTION,
    ),
    TenancyModule,
    GamificationModule,
    TripsModule,
    NotificationsModule,
  ],
  controllers: [CommunityController],
  providers: [
    CommunityService,
    CommunitySocialService,
    TribeTripsService,
    CircleChallengesService,
    CircleAccessService,
    SessionAuthGuard,
  ],
  exports: [CommunityService],
})
export class CommunityModule {}
