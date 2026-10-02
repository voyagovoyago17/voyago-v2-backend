import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleSessionDto } from './dto/google-session.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ConfirmEmailDto } from './dto/confirm-email.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { GuestLoginDto } from './dto/guest-login.dto';
import { randomUUID } from 'crypto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  @Get('options')
  getOptions() {
    return this.authService.getAuthOptions();
  }

  @Post('email/signup')
  async emailSignup(@Body() dto: SignupDto) {
    return this.authService.emailSignup(dto);
  }

  @Post('email/login')
  @HttpCode(HttpStatus.OK)
  async emailLogin(@Body() dto: LoginDto) {
    return this.authService.emailLogin(dto);
  }

  @Post('google/session')
  @HttpCode(HttpStatus.OK)
  async googleSession(@Body() dto: GoogleSessionDto) {
    return this.authService.googleSession(dto);
  }

  @Post('guest')
  @HttpCode(HttpStatus.OK)
  async guestLogin(@Body() dto?: GuestLoginDto) {
    const rawId = dto?.user_id || dto?.guest_id;
    const guestId = (rawId && rawId.startsWith('guest_')) ? rawId : `guest_${randomUUID()}`;
    return this.authService.guestLogin(guestId);
  }

  /** Envoie (ou renvoie) le code de vérification de l'adresse e-mail du compte */
  @Post('email/verification/send')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async sendEmailVerification(@CurrentUser() user: any) {
    return this.authService.sendEmailVerification(user);
  }

  /** Confirme l'adresse e-mail avec le code reçu */
  @Post('email/verification/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async confirmEmailVerification(@CurrentUser() user: any, @Body() dto: ConfirmEmailDto) {
    return this.authService.confirmEmailVerification(user, dto.code);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  async getMe(@CurrentUser() user: any) {
    return this.authService.getMe(user);
  }

  @Put('me')
  @UseGuards(SessionAuthGuard)
  async updateMe(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMe(user, dto);
  }

  @Patch('me')
  @UseGuards(SessionAuthGuard)
  async patchMe(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMe(user, dto);
  }

  @Put('profile')
  @UseGuards(SessionAuthGuard)
  async updateProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMe(user, dto);
  }

  @Patch('profile')
  @UseGuards(SessionAuthGuard)
  async patchProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMe(user, dto);
  }

  @Post('logout')
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: any) {
    return this.authService.logout(req.session_token);
  }
}
