import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProService } from './pro.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsString } from 'class-validator';

class CreateCheckoutDto {
  @IsString()
  tier: string;
}

class EditPackCheckoutDto {
  @IsString()
  trip_id: string;
}

@ApiTags('💎 Voyagooo Pro & Abonnements')
@Controller('pro')
export class ProController {
  constructor(private readonly proService: ProService) {}

  @ApiOperation({ summary: 'Liste des formules d’abonnement Voyagooo Pro (tarifs et avantages)' })
  @Get('tiers')
  getTiers() {
    return this.proService.getTiers();
  }

  @ApiOperation({ summary: 'Formule gratuite : ce qui est inclus et ce qui manque' })
  @Get('free-plan')
  getFreePlan() {
    return this.proService.getFreePlan();
  }

  @ApiOperation({ summary: 'Acheter un pack de 3 modifications pour un voyage (0,99 €)' })
  @ApiBearerAuth()
  @Post('edit-pack')
  @UseGuards(SessionAuthGuard)
  async createEditPackCheckout(@CurrentUser() user: any, @Body() body: EditPackCheckoutDto) {
    return this.proService.createEditPackCheckout(user, body.trip_id);
  }

  @ApiOperation({ summary: 'Créer une session de paiement Stripe Checkout' })
  @ApiBearerAuth()
  @Post('checkout')
  @UseGuards(SessionAuthGuard)
  async createCheckout(@CurrentUser() user: any, @Body() body: CreateCheckoutDto) {
    return this.proService.createCheckout(user, body.tier);
  }

  @ApiOperation({ summary: 'Vérifier le statut d’une session de paiement Stripe' })
  @Get('status/:session_id')
  async pollStatus(@Param('session_id') session_id: string) {
    return this.proService.pollPaymentStatus(session_id);
  }

  @ApiOperation({ summary: 'Obtenir le statut d’abonnement Pro de l’utilisateur connecté' })
  @ApiBearerAuth()
  @Get('me')
  @UseGuards(SessionAuthGuard)
  async getProStatus(@CurrentUser() user: any) {
    return this.proService.getProStatus(user);
  }
}
