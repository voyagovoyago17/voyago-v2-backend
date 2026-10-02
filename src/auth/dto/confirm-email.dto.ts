import { IsString, Matches } from 'class-validator';

export class ConfirmEmailDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Le code contient 6 chiffres' })
  code: string;
}
