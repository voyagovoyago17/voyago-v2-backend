import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TripsService } from './trips.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { OptionalSessionAuthGuard } from '../common/guards/optional-session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GenerateTripDto } from './dto/generate-trip.dto';
import { UpdateTripVisibilityDto } from './dto/update-visibility.dto';
import { RemixTripDto } from './dto/remix-trip.dto';
import { CollectGemDto } from './dto/collect-gem.dto';
import { TripGemsService } from './trip-gems.service';
import { UpdateTripDatesDto } from './dto/update-trip-dates.dto';
import { TripPackingService } from './trip-packing.service';
import { AddPackingItemDto, TogglePackingItemDto } from './dto/packing.dto';
import { TripBookingsService } from './trip-bookings.service';
import { AddTripBookingDto } from './dto/bookings.dto';

@ApiTags('✈️ Voyages & Itinéraires IA')
@Controller()
export class TripsController {
  constructor(
    private readonly tripsService: TripsService,
    private readonly tripGemsService: TripGemsService,
    private readonly tripPackingService: TripPackingService,
    private readonly tripBookingsService: TripBookingsService,
  ) {}

  @ApiOperation({ summary: 'Obtenir tous les voyages d’un utilisateur (privés et/ou publics)' })
  @ApiBearerAuth()
  @Get('trips/:user_id')
  @UseGuards(OptionalSessionAuthGuard)
  async getUserTrips(
    @Param('user_id') user_id: string,
    @CurrentUser() user: any,
  ) {
    // Owners see all their trips; others see public ones (and tribe ones if they share a circle)
    return this.tripsService.getUserTrips(user_id, { viewerId: user?.user_id });
  }

  @ApiOperation({ summary: 'Obtenir le détail d’un voyage par son ID (avec POIs, météo et coordonnées)' })
  @ApiBearerAuth()
  @Get('trip/:trip_id')
  @UseGuards(OptionalSessionAuthGuard)
  async getTrip(@Param('trip_id') trip_id: string, @CurrentUser() user: any) {
    // Authenticated owners are looked up in their tenant DB first;
    // otherwise the public lookup falls through to the shared DB
    return this.tripsService.getTripById(trip_id, user?.user_id);
  }

  /** Valise : liste sur mesure (générée au premier appel) et objets cochés */
  @ApiOperation({ summary: 'Valise du voyage : liste à préparer générée par l’IA' })
  @ApiBearerAuth()
  @Get('trip/:trip_id/packing')
  @UseGuards(SessionAuthGuard)
  async getPacking(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripPackingService.get(user.user_id, trip_id);
  }

  @Patch('trip/:trip_id/packing/items/:item_id')
  @UseGuards(SessionAuthGuard)
  async togglePackingItem(
    @CurrentUser() user: any,
    @Param('trip_id') trip_id: string,
    @Param('item_id') item_id: string,
    @Body() dto: TogglePackingItemDto,
  ) {
    return this.tripPackingService.toggle(user.user_id, trip_id, item_id, dto.packed);
  }

  @Post('trip/:trip_id/packing/items')
  @UseGuards(SessionAuthGuard)
  async addPackingItem(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Body() dto: AddPackingItemDto) {
    return this.tripPackingService.addItem(user.user_id, trip_id, dto.label, dto.category);
  }

  @Delete('trip/:trip_id/packing/items/:item_id')
  @UseGuards(SessionAuthGuard)
  async removePackingItem(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Param('item_id') item_id: string) {
    return this.tripPackingService.removeItem(user.user_id, trip_id, item_id);
  }

  /** Réservations & Budget : hébergements, transports et activités selon le budget, et suivi des dépenses */
  @ApiOperation({ summary: 'Réservations & Budget du voyage : propositions selon le budget et prestations réservées' })
  @ApiBearerAuth()
  @Get('trip/:trip_id/bookings')
  @UseGuards(SessionAuthGuard)
  async getBookings(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripBookingsService.get(user.user_id, trip_id);
  }

  @Post('trip/:trip_id/bookings')
  @UseGuards(SessionAuthGuard)
  async addBooking(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Body() dto: AddTripBookingDto) {
    return this.tripBookingsService.add(user.user_id, trip_id, dto);
  }

  @Delete('trip/:trip_id/bookings/:item_id')
  @UseGuards(SessionAuthGuard)
  async removeBooking(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Param('item_id') item_id: string) {
    return this.tripBookingsService.remove(user.user_id, trip_id, item_id);
  }

  /** Ajouter ou changer les dates d'un voyage (la fin découle de la durée) */
  @ApiOperation({ summary: "Ajouter ou modifier les dates d'un voyage (météo et clôture automatique mises à jour)" })
  @ApiBearerAuth()
  @Patch('trip/:trip_id/dates')
  @UseGuards(SessionAuthGuard)
  async updateDates(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Body() dto: UpdateTripDatesDto) {
    return this.tripsService.updateDates(user.user_id, trip_id, dto);
  }

  /** Rendre un voyage privé, visible par sa tribu ou public */
  @ApiOperation({ summary: 'Modifier la visibilité d’un voyage (privé, tribu, public)' })
  @ApiBearerAuth()
  @Patch('trip/:trip_id/visibility')
  @UseGuards(SessionAuthGuard)
  async updateVisibility(
    @CurrentUser() user: any,
    @Param('trip_id') trip_id: string,
    @Body() dto: UpdateTripVisibilityDto,
  ) {
    return this.tripsService.updateVisibility(user.user_id, trip_id, dto.visibility);
  }

  /** « Refaire ce voyage » : copie un itinéraire visible dans mes voyages (privé) */
  @ApiOperation({ summary: '« Refaire ce voyage » : cloner un itinéraire public dans mes voyages' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/remix')
  @UseGuards(SessionAuthGuard)
  async remixTrip(
    @CurrentUser() user: any,
    @Param('trip_id') trip_id: string,
    @Body() dto: RemixTripDto,
  ) {
    return this.tripsService.remixTrip(user, trip_id, dto.start_date);
  }

  // Radar des pépites : lieux secrets à ramasser sur place pendant le voyage

  @ApiOperation({ summary: 'Radar des pépites : lister les lieux secrets à collecter sur place' })
  @ApiBearerAuth()
  @Get('trip/:trip_id/gems')
  @UseGuards(SessionAuthGuard)
  async getGems(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripGemsService.getGems(user.user_id, trip_id);
  }

  /** Voyage sans dates : démarre le radar pour la durée du voyage */
  @ApiOperation({ summary: 'Démarrer le radar des pépites pour un voyage sans dates fixées' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/gems/start')
  @UseGuards(SessionAuthGuard)
  async startGems(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripGemsService.start(user.user_id, trip_id);
  }

  @ApiOperation({ summary: 'Collecter une pépite secrète avec validation GPS géolocalisée' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/gems/:gem_id/collect')
  @UseGuards(SessionAuthGuard)
  async collectGem(
    @CurrentUser() user: any,
    @Param('trip_id') trip_id: string,
    @Param('gem_id') gem_id: string,
    @Body() dto: CollectGemDto,
  ) {
    return this.tripGemsService.collect(user.user_id, trip_id, gem_id, dto.lat, dto.lng);
  }

  @ApiOperation({ summary: 'Génération IA complète d’un voyage (Claude 3.5 Sonnet / Gemini Flash)' })
  @ApiBearerAuth()
  @Post('trips/generate')
  @UseGuards(SessionAuthGuard)
  async generateTrip(
    @CurrentUser() user: any,
    @Body() dto: GenerateTripDto,
  ) {
    return this.tripsService.generateTrip(user, dto);
  }
}
