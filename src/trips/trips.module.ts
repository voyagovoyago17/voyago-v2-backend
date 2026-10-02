import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { Trip, TripSchema } from './schemas/trip.schema';
import { CommunityMember, CommunityMemberSchema } from '../community/schemas/community-member.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { UserSession, UserSessionSchema } from '../auth/schemas/user-session.schema';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { OptionalSessionAuthGuard } from '../common/guards/optional-session-auth.guard';
import { AiModule } from '../ai/ai.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';

@Module({
  imports: [
    // Shared/community trip mirror in static TENANT_DB
    MongooseModule.forFeature(
      [
        { name: Trip.name, schema: TripSchema },
        // Appartenance aux cercles : visibilité « tribu » des voyages
        { name: CommunityMember.name, schema: CommunityMemberSchema },
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
    AiModule,
    TenancyModule,
    NotificationsModule,
  ],
  controllers: [TripsController],
  providers: [TripsService, SessionAuthGuard, OptionalSessionAuthGuard],
  exports: [
    TripsService,
    MongooseModule.forFeature([{ name: Trip.name, schema: TripSchema }], TENANT_DB_CONNECTION),
  ],
})
export class TripsModule {}
