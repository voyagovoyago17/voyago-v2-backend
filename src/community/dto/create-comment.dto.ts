import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { COMMENT_TARGET_TYPES, CommentTargetType } from '../schemas/community-comment.schema';

export class CreateCommentDto {
  @IsIn([...COMMENT_TARGET_TYPES])
  target_type: CommentTargetType;

  @IsString()
  @IsNotEmpty()
  target_id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  content: string;

  /** Répondre à un commentaire */
  @IsString()
  @IsOptional()
  parent_id?: string;
}
