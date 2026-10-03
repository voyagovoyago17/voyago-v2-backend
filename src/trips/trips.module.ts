import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { TripGemsService } from './trip-gems.service';
import { TripScheduleService } from './trip-schedule.service';
import { TripPackingService } from './trip-packing.service';
import { TripBookingsService } from './trip-bookings.service';
import { TravelpayoutsService } from './travelpayouts.service';
import { PriceAlertService } from './price-alert.service';
import { PriceWatch, PriceWatchSchema } from './schemas/price-watch.schema';
import { TripSchedule, TripScheduleSchema } from './schemas/trip-schedule.schema';
import { Trip, TripSchema } from './schemas/trip.schema';
import { CommunityMember, CommunityMemberSchema } from '../community/schemas/community-member.schema';
import { UserBlock, UserBlockSchema } from '../community/schemas/user-block.schema';
import { GamificationModule } from '../gamification/gamification.module';
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
        // Blocages entre voyageurs : voyages masqués dans les deux sens
        { name: UserBlock.name, schema: UserBlockSchema },
      ],
      TENANT_DB_CONNECTION,
    ),
    MongooseModule.forFeature(
      [
        { name: User.name, schema: UserSchema },
        { name: UserSession.name, schema: UserSessionSchema },
        // Fins de voyage : clôture automatique vers le journal
        { name: TripSchedule.name, schema: TripScheduleSchema },
        // Alertes prix sur les vols des voyages
        { name: PriceWatch.name, schema: PriceWatchSchema },
      ],
      GLOBAL_DB_CONNECTION,
    ),
    AiModule,
    TenancyModule,
    NotificationsModule,
    GamificationModule,
  ],
  controllers: [TripsController],
  providers: [TripsService, TripGemsService, TripScheduleService, TripPackingService, TripBookingsService, TravelpayoutsService, PriceAlertService, SessionAuthGuard, OptionalSessionAuthGuard],
  exports: [
    TripsService,
    TripScheduleService,
    MongooseModule.forFeature([{ name: Trip.name, schema: TripSchema }], TENANT_DB_CONNECTION),
  ],
})
export class TripsModule {}
