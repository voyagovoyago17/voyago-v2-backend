import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserXpActionDocument = UserXpAction & Document;

@Schema({ collection: 'user_xp_actions', timestamps: true })
export class UserXpAction {
  @Prop({ required: true, index: true })
  user_id: string;

  @Prop({ default: 'default' })
  tenant_id: string;

  @Prop({ required: true, index: true })
  action: string;

  @Prop({ required: true, default: 0 })
  xp: number;

  @Prop({ default: 1 })
  count: number;

  @Prop({ default: true })
  completed: boolean;

  @Prop({ default: Date.now })
  completed_at: Date;

  /** Plafond quotidien : jour (AAAA-MM-JJ, UTC) et nombre d'attributions ce jour-là */
  @Prop({ type: String, required: false })
  day?: string;

  @Prop({ default: 0 })
  day_count: number;
}

export const UserXpActionSchema = SchemaFactory.createForClass(UserXpAction);
UserXpActionSchema.index({ user_id: 1, action: 1 }, { unique: true });
UserXpActionSchema.index({ tenant_id: 1 });
