import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';
import { TripAutoCompleteService } from './trip-auto-complete.service';
import { Trip, TripSchema } from '../trips/schemas/trip.schema';
import { PlaceReview, PlaceReviewSchema } from '../places/schemas/place-review.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { UserSession, UserSessionSchema } from '../auth/schemas/user-session.schema';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { TenancyModule } from '../tenancy/tenancy.module';
import { GamificationModule } from '../gamification/gamification.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UploadModule } from '../upload/upload.module';
import { TripsModule } from '../trips/trips.module';
import { GLOBAL_DB_CONNECTION, TENANT_DB_CONNECTION } from '../common/constants';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Trip.name, schema: TripSchema }], TENANT_DB_CONNECTION),
    MongooseModule.forFeature(
      [
        { name: PlaceReview.name, schema: PlaceReviewSchema },
        { name: User.name, schema: UserSchema },
        { name: UserSession.name, schema: UserSessionSchema },
      ],
      GLOBAL_DB_CONNECTION,
    ),
    TenancyModule,
    GamificationModule,
    NotificationsModule,
    UploadModule,
    TripsModule,
  ],
  controllers: [JournalController],
  providers: [JournalService, TripAutoCompleteService, SessionAuthGuard],
})
export class JournalModule {}
