import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class JoinCircleByCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code: string;
}
