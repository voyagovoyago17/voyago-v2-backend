import { IsIn } from 'class-validator';
import { TRIP_VISIBILITIES, TripVisibility } from '../trip-visibility';

export class UpdateTripVisibilityDto {
  @IsIn([...TRIP_VISIBILITIES])
  visibility: TripVisibility;
}
