import { GEM_XP } from './trip-gems.service';

/**
 * Éclats 💎 : monnaie gagnée uniquement en ramassant des pépites pendant les voyages.
 * Ils s'échangent contre des modifications sans jamais toucher aux XP de niveau.
 */
export const SHARDS_PER_CREDIT = 25;
/** Toutes les pépites d'une journée ramassées */
export const PERFECT_DAY_BONUS = 5;
/** Modifications payables en Éclats par voyage */
export const SHARD_CREDITS_PER_TRIP = { free: 1, pro: 3 };

export function gemShards(gem: any): number {
  return GEM_XP[gem?.rarity] ?? GEM_XP.commune;
}

/** Éclats gagnés sur un voyage : valeur des pépites ramassées + bonus des journées parfaites */
export function shardsOfTrip(trip: any): { earned: number; gems: number; perfect_days: number[] } {
  const gems: any[] = trip?.gems || [];
  const collected = gems.filter((g) => g.collected_at);
  const byDay = new Map<number, { total: number; done: number }>();
  for (const g of gems) {
    const day = Number(g.day) || 0;
    if (!day) continue;
    const e = byDay.get(day) || { total: 0, done: 0 };
    e.total++;
    if (g.collected_at) e.done++;
    byDay.set(day, e);
  }
  const perfect = [...byDay.entries()].filter(([, e]) => e.total > 0 && e.done === e.total).map(([d]) => d).sort((a, b) => a - b);
  return {
    earned: collected.reduce((s, g) => s + gemShards(g), 0) + perfect.length * PERFECT_DAY_BONUS,
    gems: collected.length,
    perfect_days: perfect,
  };
}

/** La journée de cette pépite devient-elle parfaite en la ramassant ? */
export function completesPerfectDay(trip: any, gemId: string): boolean {
  const gem = (trip?.gems || []).find((g: any) => g.id === gemId);
  if (!gem?.day) return false;
  return (trip.gems || []).filter((g: any) => g.day === gem.day).every((g: any) => g.id === gemId || g.collected_at);
}
