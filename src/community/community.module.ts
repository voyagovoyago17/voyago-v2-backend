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
      ],
      TENANT_DB_CONNECTION,
    ),
    MongooseModule.forFeature(
      [
        { name: User.name, schema: UserSchema },
        { name: UserSession.name, schema: UserSessionSchema },
      ],
      GLOBAL_DB_CONNECTION,
    ),
    TenancyModule,
    GamificationModule,
    TripsModule,
  ],
  controllers: [CommunityController],
  providers: [CommunityService, SessionAuthGuard],
  exports: [CommunityService],
})
export class CommunityModule {}
