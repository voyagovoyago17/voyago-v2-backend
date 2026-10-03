import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class TogglePackingItemDto {
  @IsBoolean()
  packed: boolean;
}

export class AddPackingItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label: string;

  @IsOptional()
  @IsString()
  category?: string;
}
