import { IsDateString, IsOptional } from 'class-validator';

/** « Refaire ce voyage » : dates optionnelles du nouveau voyage (AAAA-MM-JJ). */
export class RemixTripDto {
  @IsOptional()
  @IsDateString()
  start_date?: string;
}
