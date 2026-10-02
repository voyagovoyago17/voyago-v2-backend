import { IsLatitude, IsLongitude } from 'class-validator';

/** Position GPS du voyageur au moment du ramassage */
export class CollectGemDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;
}
