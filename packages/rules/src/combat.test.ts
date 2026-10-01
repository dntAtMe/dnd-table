import { describe, expect, it } from 'vitest';
import { advanceTurn, applyHp, compareInitiative, encounterBudget, encounterDifficulty, healthStatus, type InitiativeEntry } from './combat';

describe('combat', () => {
  it('reports health the way players see it', () => {
    expect(healthStatus(10, 10)).toBe('healthy');
    expect(healthStatus(6, 11)).toBe('healthy');
    expect(healthStatus(5, 10)).toBe('bloodied');
    expect(healthStatus(0, 10)).toBe('down');
  });

  it('orders initiative with ties broken by bonus, DEX, then join order', () => {
    const e = (id: string, initiative: number | null, initiativeBonus = 0, dex = 10, seq = 0) => ({ id, initiative, initiativeBonus, dex, seq });
    const list: (InitiativeEntry & { id: string })[] = [
      e('unrolled', null, 5, 20, 0),
      e('slow', 8, 0, 10, 1),
      e('tieLowBonus', 15, 1, 12, 2),
      e('tieHighBonus', 15, 3, 16, 3),
      e('tieSameDexLater', 15, 1, 12, 5),
      e('tieHighDex', 15, 1, 14, 4),
    ];
    expect([...list].sort(compareInitiative).map((x) => x.id)).toEqual([
      'tieHighBonus',
      'tieHighDex',
      'tieLowBonus',
      'tieSameDexLater',
      'slow',
      'unrolled',
    ]);
  });

  it('advances turns and rounds in both directions', () => {
    const order = ['a', 'b', 'c'];
    expect(advanceTurn(order, { round: 1, activeId: null }, 'next')).toEqual({ round: 1, activeId: 'a' });
    expect(advanceTurn(order, { round: 1, activeId: 'b' }, 'next')).toEqual({ round: 1, activeId: 'c' });
    expect(advanceTurn(order, { round: 1, activeId: 'c' }, 'next')).toEqual({ round: 2, activeId: 'a' });
    expect(advanceTurn(order, { round: 2, activeId: 'a' }, 'prev')).toEqual({ round: 1, activeId: 'c' });
    expect(advanceTurn(order, { round: 1, activeId: 'a' }, 'prev')).toEqual({ round: 1, activeId: 'a' });
    expect(advanceTurn([], { round: 3, activeId: 'a' }, 'next')).toEqual({ round: 3, activeId: null });
  });

  it('takes damage from temporary hit points first and caps healing', () => {
    expect(applyHp({ hp: 10, tempHp: 5 }, 20, -7)).toEqual({ hp: 8, tempHp: 0 });
    expect(applyHp({ hp: 3, tempHp: 0 }, 20, -10)).toEqual({ hp: 0, tempHp: 0 });
    expect(applyHp({ hp: 15, tempHp: 2 }, 20, 10)).toEqual({ hp: 20, tempHp: 2 });
  });

  it('rates encounters against the 2024 XP budget', () => {
    // Four level 1 characters: Low 200, Moderate 300, High 400.
    const party = [1, 1, 1, 1];
    expect(encounterBudget(party)).toEqual({ low: 200, moderate: 300, high: 400 });
    expect(encounterDifficulty(party, 150)).toBe('low');
    expect(encounterDifficulty(party, 250)).toBe('moderate');
    expect(encounterDifficulty(party, 400)).toBe('high');
    expect(encounterDifficulty(party, 450)).toBe('beyond high');
    expect(encounterBudget([5, 3]).high).toBe(1500);
  });
});
