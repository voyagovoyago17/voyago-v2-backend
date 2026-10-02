import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserBlockDocument = UserBlock & Document;

/** `blocker_id` a bloqué `blocked_id` : leurs contenus sont masqués dans les deux sens. */
@Schema({ timestamps: { createdAt: 'created_at', updatedAt: false } })
export class UserBlock {
  @Prop({ required: true, index: true })
  blocker_id: string;

  @Prop({ required: true, index: true })
  blocked_id: string;

  @Prop()
  created_at: Date;
}

export const UserBlockSchema = SchemaFactory.createForClass(UserBlock);
UserBlockSchema.index({ blocker_id: 1, blocked_id: 1 }, { unique: true });
