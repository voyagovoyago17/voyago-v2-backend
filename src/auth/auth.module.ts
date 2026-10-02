import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserSchema } from './schemas/user.schema';
import { UserSession, UserSessionSchema } from './schemas/user-session.schema';
import { PasswordReset, PasswordResetSchema } from './schemas/password-reset.schema';
import { EmailVerification, EmailVerificationSchema } from './schemas/email-verification.schema';
import { MailModule } from '../mail/mail.module';
import { GamificationModule } from '../gamification/gamification.module';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { TenancyModule } from '../tenancy/tenancy.module';

import { GLOBAL_DB_CONNECTION } from '../common/constants';

@Module({
  imports: [
    MongooseModule.forFeature(
      [
        { name: User.name, schema: UserSchema },
        { name: UserSession.name, schema: UserSessionSchema },
        { name: PasswordReset.name, schema: PasswordResetSchema },
        { name: EmailVerification.name, schema: EmailVerificationSchema },
      ],
      GLOBAL_DB_CONNECTION,
    ),
    TenancyModule,
    MailModule,
    GamificationModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionAuthGuard],
  exports: [
    AuthService,
    SessionAuthGuard,
    MongooseModule.forFeature(
      [
        { name: User.name, schema: UserSchema },
        { name: UserSession.name, schema: UserSessionSchema },
      ],
      GLOBAL_DB_CONNECTION,
    ),
  ],
})
export class AuthModule {}
