import { Model } from 'mongoose';

/** Voyageurs masqués pour `userId` : ceux qu'il a bloqués et ceux qui l'ont bloqué. */
export async function hiddenUserIds(blockModel: Model<any>, userId?: string): Promise<string[]> {
  if (!userId) return [];
  const blocks: any[] = await blockModel
    .find({ $or: [{ blocker_id: userId }, { blocked_id: userId }] })
    .select('blocker_id blocked_id')
    .lean()
    .exec();
  return [...new Set(blocks.map((b) => (b.blocker_id === userId ? b.blocked_id : b.blocker_id)))];
}

/** L'un des deux voyageurs a-t-il bloqué l'autre ? */
export async function isBlockedBetween(blockModel: Model<any>, userA?: string, userB?: string): Promise<boolean> {
  if (!userA || !userB || userA === userB) return false;
  const block = await blockModel.exists({
    $or: [
      { blocker_id: userA, blocked_id: userB },
      { blocker_id: userB, blocked_id: userA },
    ],
  });
  return !!block;
}
