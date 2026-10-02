import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateTripPlanDto {
  /**
   * fresh : nouvel itinéraire généré par l'IA (compte dans le plafond mensuel)
   * reuse : parcours déjà connu pour cette destination, instantané et sans IA
   *         (si aucun n'existe, un nouvel itinéraire est généré)
   */
  @IsOptional()
  @IsIn(['fresh', 'reuse'])
  mode?: 'fresh' | 'reuse';

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  destination: string;

  @IsInt()
  @Min(1)
  @Max(7)
  duration_days: number;

  @IsOptional()
  @IsDateString()
  start_date?: string;

  @IsOptional()
  @IsIn(['tranquille', 'equilibre', 'intensif'])
  pace?: string;

  @IsOptional()
  @IsIn(['economique', 'moyen', 'luxe'])
  budget?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  interests?: string[];

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  country_code?: string;
}

export class VoteTripPlanDto {
  @IsString()
  @IsNotEmpty()
  poi_key: string;

  @IsIn(['up', 'down'])
  vote: 'up' | 'down';
}

export class JoinTripPlanDto {
  @IsOptional()
  @IsDateString()
  start_date?: string;
}
