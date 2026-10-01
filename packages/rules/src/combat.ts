// Combat bookkeeping shared by the server and clients: initiative order, turns, hit points
// and encounter difficulty (2024 rules).

export type HealthStatus = 'healthy' | 'bloodied' | 'down';

/** 2024: a creature is Bloodied at half its Hit Points or fewer. */
export function healthStatus(hp: number, hpMax: number): HealthStatus {
  if (hp <= 0) return 'down';
  return hp <= hpMax / 2 ? 'bloodied' : 'healthy';
}

export interface InitiativeEntry {
  /** Null until rolled; those go last. */
  initiative: number | null;
  initiativeBonus: number;
  /** DEX score, the final tiebreaker. */
  dex: number;
  /** Order the combatant joined, so remaining ties stay stable. */
  seq: number;
}

/** Highest initiative first; ties go to the higher bonus, then the higher DEX score. */
export function compareInitiative(a: InitiativeEntry, b: InitiativeEntry): number {
  if (a.initiative !== b.initiative) {
    if (a.initiative === null) return 1;
    if (b.initiative === null) return -1;
    return b.initiative - a.initiative;
  }
  return b.initiativeBonus - a.initiativeBonus || b.dex - a.dex || a.seq - b.seq;
}

export interface TurnState {
  round: number;
  /** Whose turn it is; null before the first turn. */
  activeId: string | null;
}

/** Moves to the next or previous combatant in `order`, changing round at either end. */
export function advanceTurn(order: readonly string[], state: TurnState, dir: 'next' | 'prev'): TurnState {
  if (order.length === 0) return { round: state.round, activeId: null };
  const i = state.activeId ? order.indexOf(state.activeId) : -1;
  if (dir === 'next') {
    if (i < 0) return { round: state.round, activeId: order[0]! };
    if (i === order.length - 1) return { round: state.round + 1, activeId: order[0]! };
    return { round: state.round, activeId: order[i + 1]! };
  }
  if (i < 0) return state;
  if (i === 0) return state.round > 1 ? { round: state.round - 1, activeId: order.at(-1)! } : state;
  return { round: state.round, activeId: order[i - 1]! };
}

/** Damage (negative) comes off temporary HP first; healing (positive) is capped at the maximum. */
export function applyHp(cur: { hp: number; tempHp: number }, hpMax: number, amount: number): { hp: number; tempHp: number } {
  if (amount >= 0) return { hp: Math.min(hpMax, cur.hp + amount), tempHp: cur.tempHp };
  let damage = -amount;
  const fromTemp = Math.min(cur.tempHp, damage);
  damage -= fromTemp;
  return { hp: Math.max(0, cur.hp - damage), tempHp: cur.tempHp - fromTemp };
}

// ---------- encounter difficulty ----------

export interface XpBudget {
  low: number;
  moderate: number;
  high: number;
}

/** XP Budget per Character by level (SRD 5.2, Combat Encounter Difficulty). */
export const XP_BUDGET: readonly XpBudget[] = [
  { low: 50, moderate: 75, high: 100 },
  { low: 100, moderate: 150, high: 200 },
  { low: 150, moderate: 225, high: 400 },
  { low: 250, moderate: 375, high: 500 },
  { low: 500, moderate: 750, high: 1100 },
  { low: 600, moderate: 1000, high: 1400 },
  { low: 750, moderate: 1300, high: 1700 },
  { low: 1000, moderate: 1700, high: 2100 },
  { low: 1300, moderate: 2000, high: 2600 },
  { low: 1600, moderate: 2300, high: 3100 },
  { low: 1900, moderate: 2900, high: 4100 },
  { low: 2200, moderate: 3700, high: 4700 },
  { low: 2600, moderate: 4200, high: 5400 },
  { low: 2900, moderate: 4900, high: 6200 },
  { low: 3300, moderate: 5400, high: 7800 },
  { low: 3800, moderate: 6100, high: 9800 },
  { low: 4500, moderate: 7200, high: 11700 },
  { low: 5000, moderate: 8700, high: 14200 },
  { low: 5500, moderate: 10700, high: 17200 },
  { low: 6400, moderate: 13200, high: 22000 },
];

/** The party's total budget: the sum of each character's budget. */
export function encounterBudget(levels: readonly number[]): XpBudget {
  const total: XpBudget = { low: 0, moderate: 0, high: 0 };
  for (const level of levels) {
    const b = XP_BUDGET[Math.min(20, Math.max(1, Math.round(level))) - 1]!;
    total.low += b.low;
    total.moderate += b.moderate;
    total.high += b.high;
  }
  return total;
}

export type Difficulty = 'low' | 'moderate' | 'high' | 'beyond high';

/** The lowest difficulty whose budget covers the monsters' XP (the DMG builds encounters by spending up to a budget). */
export function encounterDifficulty(levels: readonly number[], xp: number): Difficulty {
  const b = encounterBudget(levels);
  if (xp <= b.low) return 'low';
  if (xp <= b.moderate) return 'moderate';
  if (xp <= b.high) return 'high';
  return 'beyond high';
}
