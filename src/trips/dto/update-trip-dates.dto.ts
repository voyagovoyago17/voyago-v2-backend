import { Matches } from 'class-validator';

export class UpdateTripDatesDto {
  /** Premier jour du voyage (AAAA-MM-JJ) ; la fin découle de la durée */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date de début invalide (format AAAA-MM-JJ)' })
  start_date: string;
}
