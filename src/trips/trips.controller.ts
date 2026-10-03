import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
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
import { PriceAlertService } from './price-alert.service';
import { TravelpayoutsService } from './travelpayouts.service';
import { TripEditsService } from './trip-edits.service';
import { RegenerateTripDto, SwapPoiDto } from './dto/trip-edits.dto';

@ApiTags('✈️ Voyages & Itinéraires IA')
@Controller()
export class TripsController {
  constructor(
    private readonly tripsService: TripsService,
    private readonly tripGemsService: TripGemsService,
    private readonly tripPackingService: TripPackingService,
    private readonly tripBookingsService: TripBookingsService,
    private readonly priceAlertService: PriceAlertService,
    private readonly travelpayouts: TravelpayoutsService,
    private readonly tripEdits: TripEditsService,
  ) {}

  /** Inspiration budget : destinations les moins chères en avion depuis la ville du voyageur */
  @ApiOperation({ summary: 'Inspiration : vols aller-retour les moins chers depuis ma ville (Aviasales)' })
  @ApiBearerAuth()
  @Get('flights/inspiration')
  @UseGuards(SessionAuthGuard)
  async flightInspiration(
    @CurrentUser() user: any,
    @Query('max_price') maxPrice?: string,
    @Query('currency') currency?: string,
    @Query('adults') adults?: string,
    @Query('children_ages') childrenAges?: string,
  ) {
    const profile = await this.tripBookingsService.homeOf(user.user_id);
    const empty = { origin: null, currency: currency || 'EUR', items: [] as any[], needs_city: !profile };
    if (!profile) return empty;
    const max = Number(maxPrice);
    const kids = (childrenAges || '')
      .split(',')
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x >= 0 && x < 18);
    const res = await this.travelpayouts.inspiration({
      from: profile,
      currency: /^[A-Z]{3}$/.test(currency || '') ? currency! : 'EUR',
      maxPrice: Number.isFinite(max) && max > 0 ? max : undefined,
      adults: Math.min(9, Math.max(1, Number(adults) || 1)),
      kids,
    });
    return res ? { ...res, needs_city: false } : empty;
  }

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
  async getBookings(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Query('retry') retry?: string) {
    return this.tripBookingsService.get(user.user_id, trip_id, { retry: retry === '1' || retry === 'true' });
  }

  @Post('trip/:trip_id/bookings')
  @UseGuards(SessionAuthGuard)
  async addBooking(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Body() dto: AddTripBookingDto) {
    return this.tripBookingsService.add(user.user_id, trip_id, dto);
  }

  /** « Prix incorrect ? » : le prix de cette visite sera revérifié pour tous */
  @Post('trip/:trip_id/bookings/price-report')
  @UseGuards(SessionAuthGuard)
  async reportPrice(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Body() body: { name?: string }) {
    const name = String(body?.name || '').trim().slice(0, 100);
    if (!name) return { flagged: false };
    return this.tripBookingsService.flagPrice(user.user_id, trip_id, name);
  }

  @Delete('trip/:trip_id/bookings/:item_id')
  @UseGuards(SessionAuthGuard)
  async removeBooking(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Param('item_id') item_id: string) {
    return this.tripBookingsService.remove(user.user_id, trip_id, item_id);
  }

  /** Alerte prix sur le vol du voyage */
  @ApiOperation({ summary: 'Alerte prix du vol : état' })
  @ApiBearerAuth()
  @Get('trip/:trip_id/price-alert')
  @UseGuards(SessionAuthGuard)
  async getPriceAlert(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.priceAlertService.status(user.user_id, trip_id);
  }

  @Post('trip/:trip_id/price-alert')
  @UseGuards(SessionAuthGuard)
  async enablePriceAlert(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.priceAlertService.enable(user.user_id, trip_id);
  }

  @Delete('trip/:trip_id/price-alert')
  @UseGuards(SessionAuthGuard)
  async disablePriceAlert(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.priceAlertService.disable(user.user_id, trip_id);
  }

  /** Jours déjà pris par des voyages programmés (grisés dans le calendrier) */
  @ApiOperation({ summary: 'Dates déjà prises par mes voyages programmés' })
  @ApiBearerAuth()
  @Get('me/busy-dates')
  @UseGuards(SessionAuthGuard)
  async busyDates(@CurrentUser() user: any, @Query('exclude') exclude?: string) {
    return this.tripsService.busyDates(user.user_id, exclude || undefined);
  }

  /** Annuler un voyage pas encore commencé : il redevient une idée sans dates (gratuit) */
  @ApiOperation({ summary: 'Annuler un voyage programmé (il rejoint « Mes idées »)' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/cancel')
  @UseGuards(SessionAuthGuard)
  async cancelTrip(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripsService.cancelTrip(user.user_id, trip_id);
  }

  /** Ce que le voyageur peut encore modifier sur ce voyage, selon sa formule */
  @ApiOperation({ summary: 'Droits et compteurs de modification du voyage' })
  @ApiBearerAuth()
  @Get('trip/:trip_id/edit-options')
  @UseGuards(SessionAuthGuard)
  async editOptions(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripEdits.options(user.user_id, trip_id);
  }

  /** Lieux réels vérifiés proches, pour remplacer un lieu du programme */
  @ApiOperation({ summary: 'Lieux de remplacement (réels, vérifiés)' })
  @ApiBearerAuth()
  @Get('trip/:trip_id/pois/alternatives')
  @UseGuards(SessionAuthGuard)
  async poiAlternatives(
    @CurrentUser() user: any,
    @Param('trip_id') trip_id: string,
    @Query('day') day: string,
    @Query('order') order: string,
  ) {
    return this.tripEdits.alternatives(user.user_id, trip_id, Number(day), Number(order));
  }

  @ApiOperation({ summary: 'Remplacer un lieu par un lieu vérifié' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/pois/swap')
  @UseGuards(SessionAuthGuard)
  async swapPoi(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Body() dto: SwapPoiDto) {
    return this.tripEdits.swap(user.user_id, trip_id, dto);
  }

  @ApiOperation({ summary: 'Refaire une journée (compte dans le quota de modifications)' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/days/:day/redo')
  @UseGuards(SessionAuthGuard)
  async redoDay(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Param('day') day: string) {
    return this.tripEdits.redoDay(user.user_id, trip_id, Number(day));
  }

  @ApiOperation({ summary: 'Plan B pluie : programme à l’abri pour une journée (Pro)' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/days/:day/plan-b')
  @UseGuards(SessionAuthGuard)
  async planB(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Param('day') day: string) {
    return this.tripEdits.redoDay(user.user_id, trip_id, Number(day), { planB: true });
  }

  @ApiOperation({ summary: 'Tout refaire avant le départ (compte dans le quota de modifications)' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/regenerate')
  @UseGuards(SessionAuthGuard)
  async regenerate(@CurrentUser() user: any, @Param('trip_id') trip_id: string, @Body() dto: RegenerateTripDto) {
    return this.tripEdits.regenerate(user.user_id, trip_id, dto);
  }

  @ApiOperation({ summary: 'Échanger des XP contre une modification en plus' })
  @ApiBearerAuth()
  @Post('trip/:trip_id/edit-credits/xp')
  @UseGuards(SessionAuthGuard)
  async creditWithXp(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripEdits.creditWithXp(user.user_id, trip_id);
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
