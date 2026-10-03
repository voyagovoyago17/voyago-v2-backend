import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class JoinRulesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  min_level?: number | null;

  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(99)
  min_age?: number | null;

  @IsOptional()
  @IsBoolean()
  pro_only?: boolean;

  @IsOptional()
  @IsBoolean()
  verified_email?: boolean;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(10000)
  max_members?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  countries?: string[] | null;
}

/** Réglages d'accès d'un cercle (fondateur / admins). */
export class UpdateCircleAccessDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => JoinRulesDto)
  join_rules?: JoinRulesDto;

  @IsOptional()
  @IsBoolean()
  auto_approve?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  join_question?: string;

  @IsOptional()
  @IsBoolean()
  listed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  trial_days?: number;
}

export class JoinRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class SetMemberRoleDto {
  @IsIn(['admin', 'explorer'])
  role: 'admin' | 'explorer';
}

export class CreateInviteDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  /** null / absent = illimité */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  max_uses?: number | null;

  /** null / absent = sans expiration */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 90)
  expires_in_hours?: number | null;
}
