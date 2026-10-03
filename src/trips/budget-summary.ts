/** Règles du budget d'un voyage, partagées par Réservations & Budget et le journal. */

/** Budget par personne et par jour quand le voyageur n'a pas annoncé de montant (EUR) */
export const DAILY_BUDGET_BY_LEVEL: Record<string, number> = { economique: 70, moyen: 140, luxe: 320 };

/** Répartition du budget selon le standing (hébergement, transports, activités, repas & extras) */
export const SPLIT_BY_LEVEL: Record<string, { lodging: number; transport: number; activities: number; meals: number }> = {
  economique: { lodging: 0.38, transport: 0.17, activities: 0.15, meals: 0.3 },
  moyen: { lodging: 0.45, transport: 0.15, activities: 0.15, meals: 0.25 },
  luxe: { lodging: 0.52, transport: 0.13, activities: 0.15, meals: 0.2 },
};

const BOOKING_KEYS = ['lodging', 'transport', 'activities', 'meals', 'other'] as const;

/**
 * Bilan budgétaire d'un voyage : budget (annoncé ou estimé), dépenses par poste, vols à part,
 * réservations. Calcul pur, sans IA : utilisable pour un voyage en cours comme pour le journal.
 */
export function computeBudgetSummary(trip: any) {
  const currency = trip.currency || 'EUR';
  const level = SPLIT_BY_LEVEL[trip.budget] ? trip.budget : 'moyen';
  const adults = Math.max(1, trip.travelers?.adults ?? 1);
  const kids: number[] = trip.travelers?.children_ages ?? [];
  const days = Math.max(1, trip.duration_days || 1);
  const shares = adults + kids.length * 0.5;
  const announced = !!(trip.budget_amount && trip.budget_amount > 0);
  const total = announced ? Math.round(trip.budget_amount) : Math.round(DAILY_BUDGET_BY_LEVEL[level] * days * shares);
  const split = SPLIT_BY_LEVEL[level];
  const allocation = {
    lodging: Math.round(total * split.lodging),
    transport: Math.round(total * split.transport),
    activities: Math.round(total * split.activities),
    meals: Math.round(total * split.meals),
  };
  const booked = ((trip.bookings || []) as any[])
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const sum = (list: any[]) => list.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const spentBy = Object.fromEntries(BOOKING_KEYS.map((k) => [k, sum(booked.filter((b) => b.category === k))])) as Record<
    (typeof BOOKING_KEYS)[number],
    number
  >;
  const spent = sum(booked.filter((b) => b.category !== 'flights'));
  const flightsSpent = sum(booked.filter((b) => b.category === 'flights'));
  return {
    currency,
    level,
    announced_budget: announced,
    total,
    allocation,
    spent,
    spent_by: spentBy,
    flights_spent: flightsSpent,
    available: total - spent,
    bookings: booked,
    has_data: booked.length > 0 || announced,
  };
}
