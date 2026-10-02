import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { REPORT_TARGET_TYPES, ReportTargetType } from '../schemas/community-report.schema';

export class ReportContentDto {
  @IsIn([...REPORT_TARGET_TYPES])
  target_type: ReportTargetType;

  @IsString()
  @IsNotEmpty()
  target_id: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
