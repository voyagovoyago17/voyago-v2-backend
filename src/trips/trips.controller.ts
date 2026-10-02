import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { TripsService } from './trips.service';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { OptionalSessionAuthGuard } from '../common/guards/optional-session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GenerateTripDto } from './dto/generate-trip.dto';
import { UpdateTripVisibilityDto } from './dto/update-visibility.dto';
import { RemixTripDto } from './dto/remix-trip.dto';
import { CollectGemDto } from './dto/collect-gem.dto';
import { TripGemsService } from './trip-gems.service';

@Controller()
export class TripsController {
  constructor(
    private readonly tripsService: TripsService,
    private readonly tripGemsService: TripGemsService,
  ) {}

  @Get('trips/:user_id')
  @UseGuards(OptionalSessionAuthGuard)
  async getUserTrips(
    @Param('user_id') user_id: string,
    @CurrentUser() user: any,
  ) {
    // Owners see all their trips; others see public ones (and tribe ones if they share a circle)
    return this.tripsService.getUserTrips(user_id, { viewerId: user?.user_id });
  }

  @Get('trip/:trip_id')
  @UseGuards(OptionalSessionAuthGuard)
  async getTrip(@Param('trip_id') trip_id: string, @CurrentUser() user: any) {
    // Authenticated owners are looked up in their tenant DB first;
    // otherwise the public lookup falls through to the shared DB
    return this.tripsService.getTripById(trip_id, user?.user_id);
  }

  /** Rendre un voyage privé, visible par sa tribu ou public */
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

  @Get('trip/:trip_id/gems')
  @UseGuards(SessionAuthGuard)
  async getGems(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripGemsService.getGems(user.user_id, trip_id);
  }

  /** Voyage sans dates : démarre le radar pour la durée du voyage */
  @Post('trip/:trip_id/gems/start')
  @UseGuards(SessionAuthGuard)
  async startGems(@CurrentUser() user: any, @Param('trip_id') trip_id: string) {
    return this.tripGemsService.start(user.user_id, trip_id);
  }

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

  @Post('trips/generate')
  @UseGuards(SessionAuthGuard)
  async generateTrip(
    @CurrentUser() user: any,
    @Body() dto: GenerateTripDto,
  ) {
    return this.tripsService.generateTrip(user, dto);
  }
}
