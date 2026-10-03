import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsArray, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JoinRulesDto } from './circle-access.dto';

export class CreateCircleDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  avatar_emoji?: string;

  @IsString()
  @IsOptional()
  cover_image_url?: string;

  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  destination_city?: string;

  @IsString()
  @IsOptional()
  destination_country?: string;

  @IsBoolean()
  @IsOptional()
  is_public?: boolean;

  @IsArray()
  @IsOptional()
  tags?: string[];

  /** Cercle privé visible dans la liste (false = cercle secret, accessible par code) */
  @IsBoolean()
  @IsOptional()
  listed?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => JoinRulesDto)
  join_rules?: JoinRulesDto;

  @IsBoolean()
  @IsOptional()
  auto_approve?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  join_question?: string;
}
