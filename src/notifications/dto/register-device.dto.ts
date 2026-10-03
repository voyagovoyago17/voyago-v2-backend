import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DEVICE_PLATFORMS, DevicePlatform } from '../schemas/device-token.schema';

export class RegisterDeviceDto {
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  token: string;

  @IsIn(DEVICE_PLATFORMS as unknown as string[])
  platform: DevicePlatform;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  app_version?: string;

  /** Décalage horaire du téléphone en minutes (UTC+1 = 60) */
  @IsOptional()
  @IsInt()
  @Min(-720)
  @Max(840)
  utc_offset_minutes?: number;
}

export class UnregisterDeviceDto {
  @IsString()
  @MaxLength(4096)
  token: string;
}
