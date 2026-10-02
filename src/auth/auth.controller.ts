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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('🔐 Authentification & Profil')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  @ApiOperation({ summary: 'Options d’authentification actives (Google, email, invité)' })
  @Get('options')
  getOptions() {
    return this.authService.getAuthOptions();
  }

  @ApiOperation({ summary: 'Inscription classique par email et mot de passe' })
  @Post('email/signup')
  async emailSignup(@Body() dto: SignupDto) {
    return this.authService.emailSignup(dto);
  }

  @ApiOperation({ summary: 'Connexion par email et mot de passe' })
  @Post('email/login')
  @HttpCode(HttpStatus.OK)
  async emailLogin(@Body() dto: LoginDto) {
    return this.authService.emailLogin(dto);
  }

  @ApiOperation({ summary: 'Connexion ou inscription via Google OAuth' })
  @Post('google/session')
  @HttpCode(HttpStatus.OK)
  async googleSession(@Body() dto: GoogleSessionDto) {
    return this.authService.googleSession(dto);
  }

  @ApiOperation({ summary: 'Connexion en tant qu’invité (Guest mode)' })
  @Post('guest')
  @HttpCode(HttpStatus.OK)
  async guestLogin(@Body() dto?: GuestLoginDto) {
    const rawId = dto?.user_id || dto?.guest_id;
    const guestId = (rawId && rawId.startsWith('guest_')) ? rawId : `guest_${randomUUID()}`;
    return this.authService.guestLogin(guestId);
  }

  /** Envoie (ou renvoie) le code de vérification de l'adresse e-mail du compte */
  @ApiOperation({ summary: 'Envoyer un code de vérification email' })
  @ApiBearerAuth()
  @Post('email/verification/send')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async sendEmailVerification(@CurrentUser() user: any) {
    return this.authService.sendEmailVerification(user);
  }

  /** Confirme l'adresse e-mail avec le code reçu */
  @ApiOperation({ summary: 'Confirmer l’adresse email avec le code à 6 chiffres' })
  @ApiBearerAuth()
  @Post('email/verification/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async confirmEmailVerification(@CurrentUser() user: any, @Body() dto: ConfirmEmailDto) {
    return this.authService.confirmEmailVerification(user, dto.code);
  }

  @ApiOperation({ summary: 'Demande de réinitialisation de mot de passe par email' })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @ApiOperation({ summary: 'Validation du nouveau mot de passe avec le token' })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @ApiOperation({ summary: 'Obtenir les données du profil utilisateur connecté' })
  @ApiBearerAuth()
  @Get('me')
  @UseGuards(SessionAuthGuard)
  async getMe(@CurrentUser() user: any) {
    return this.authService.getMe(user);
  }

  @ApiOperation({ summary: 'Mettre à jour le profil utilisateur (nom, avatar, préférences)' })
  @ApiBearerAuth()
  @Put('me')
  @UseGuards(SessionAuthGuard)
  async updateMe(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMe(user, dto);
  }

  @ApiOperation({ summary: 'Mise à jour partielle du profil utilisateur' })
  @ApiBearerAuth()
  @Patch('me')
  @UseGuards(SessionAuthGuard)
  async patchMe(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMe(user, dto);
  }

  @ApiOperation({ summary: 'Mettre à jour le profil (alias /profile)' })
  @ApiBearerAuth()
  @Put('profile')
  @UseGuards(SessionAuthGuard)
  async updateProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMe(user, dto);
  }

  @ApiOperation({ summary: 'Mise à jour partielle du profil (alias /profile)' })
  @ApiBearerAuth()
  @Patch('profile')
  @UseGuards(SessionAuthGuard)
  async patchProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMe(user, dto);
  }

  @ApiOperation({ summary: 'Déconnexion et révocation du token de session' })
  @ApiBearerAuth()
  @Post('logout')
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: any) {
    return this.authService.logout(req.session_token);
  }
}
