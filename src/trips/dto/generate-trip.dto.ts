import {
  IsString,
  IsNumber,
  IsArray,
  IsOptional,
  IsIn,
  Min,
  Max,
  ArrayMinSize,
} from 'class-validator';

export class GenerateTripDto {
  @IsString()
  destination: string;

  @IsNumber()
  @Min(1)
  @Max(30)
  duration_days: number;

  @IsString()
  @IsIn(['tranquille', 'equilibre', 'intensif'])
  pace: string;

  @IsArray()
  @IsString({ each: true })
  transports: string[];

  @IsString()
  @IsIn(['economique', 'moyen', 'luxe'])
  budget: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  interests: string[];

  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  end_date?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  country_code?: string;

  @IsOptional()
  @IsString()
  @IsIn(['cold', 'balanced', 'warm'])
  thermal_sensitivity?: string;

  /** Visibilité du voyage (privé par défaut) */
  @IsOptional()
  @IsIn(['private', 'tribe', 'public'])
  visibility?: 'private' | 'tribe' | 'public';
}
