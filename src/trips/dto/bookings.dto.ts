import { IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { BOOKING_CATEGORIES } from '../trip-bookings.service';

export class AddTripBookingDto {
  @IsIn(BOOKING_CATEGORIES as unknown as string[])
  category: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}
