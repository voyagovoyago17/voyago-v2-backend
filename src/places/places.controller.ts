import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PlacesService } from './places.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { OptionalSessionAuthGuard } from '../common/guards/optional-session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReviewPlaceDto } from './dto/review-place.dto';
import { PlaceStatsDto } from './dto/place-stats.dto';

@ApiTags('⭐ Lieux & Avis')
@Controller('places')
export class PlacesController {
  constructor(private readonly placesService: PlacesService) {}

  /** Noter / liker / commenter un lieu visité */
  @ApiOperation({ summary: 'Publier un avis, note (étoiles) ou conseil sur un lieu visité' })
  @ApiBearerAuth()
  @Post('reviews')
  @UseGuards(SessionAuthGuard)
  async review(@CurrentUser() user: any, @Body() dto: ReviewPlaceDto) {
    return this.placesService.review(user.user_id, dto);
  }

  /** Étoiles agrégées de plusieurs lieux (+ l'avis de l'appelant s'il est connecté) */
  @ApiOperation({ summary: 'Statistiques et notes agrégées pour une liste de lieux (POI)' })
  @ApiBearerAuth()
  @Post('stats')
  @UseGuards(OptionalSessionAuthGuard)
  async stats(@CurrentUser() user: any, @Body() dto: PlaceStatsDto) {
    return this.placesService.statsForPlaces(dto.places, user?.user_id);
  }

  /** Derniers avis d'un lieu, pour les autres voyageurs */
  @ApiOperation({ summary: 'Consulter les derniers avis de voyageurs sur un lieu précis' })
  @Get('reviews')
  async latestReviews(
    @Query('name') name: string,
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('limit') limit?: string,
  ) {
    return this.placesService.latestReviews(
      name,
      parseFloat(lat),
      parseFloat(lng),
      limit ? parseInt(limit, 10) : undefined,
    );
  }
}
