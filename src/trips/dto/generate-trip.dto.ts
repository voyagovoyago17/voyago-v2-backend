import {
  IsString,
  IsNumber,
  IsArray,
  IsOptional,
  IsIn,
  Min,
  Max,
  ArrayMinSize,
  ArrayMaxSize,
  IsInt,
  Matches,
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

  /** Usage des lieux générés : itinéraire classique (défaut) ou propositions soumises au vote d'une tribu */
  @IsOptional()
  @IsIn(['trip', 'tribe_vote'])
  purpose?: 'trip' | 'tribe_vote';

  /** Budget annoncé pour tout le voyage (facultatif), dans la devise `currency` */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  budget_amount?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  /** Qui part : solo, couple, amis, famille */
  @IsOptional()
  @IsIn(['solo', 'couple', 'amis', 'famille'])
  travel_party?: 'solo' | 'couple' | 'amis' | 'famille';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  adults?: number;

  /** Âge de chaque enfant (0 = bébé) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(17, { each: true })
  children_ages?: number[];

  /** Visibilité du voyage (privé par défaut) */
  @IsOptional()
  @IsIn(['private', 'tribe', 'public'])
  visibility?: 'private' | 'tribe' | 'public';
}
