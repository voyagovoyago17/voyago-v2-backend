import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SwapPoiDto {
  @IsInt()
  @Min(1)
  day: number;

  @IsInt()
  @Min(1)
  order: number;

  /** Nom exact d'un lieu de la liste vérifiée proposée */
  @IsString()
  @MaxLength(200)
  name: string;
}

export class RegenerateTripDto {
  @IsOptional()
  @IsIn(['tranquille', 'equilibre', 'intensif'])
  pace?: string;

  @IsOptional()
  @IsIn(['economique', 'moyen', 'luxe'])
  budget?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  interests?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  transports?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  duration_days?: number;
}
