import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
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
}

export class UnregisterDeviceDto {
  @IsString()
  @MaxLength(4096)
  token: string;
}
