import { describe, expect, it } from 'vitest';
import { monsterCrText, monsterSenses, monsterSensesText, monsterSpeedText } from './monsters';
import { MONSTERS } from './srd/monsters';
import { MONSTERS_BY_ID } from './srd/monsters';

describe('stat block lines', () => {
  const goblin = MONSTERS_BY_ID['goblin-warrior']!;
  const dragon = MONSTERS_BY_ID['adult-red-dragon']!;

  it('formats speeds, walking first and without a label', () => {
    expect(monsterSpeedText(goblin)).toBe('30 ft.');
    expect(monsterSpeedText(dragon)).toBe('40 ft., Climb 40 ft., Fly 80 ft.');
    expect(monsterSpeedText({ speed: { walk: 0, fly: 30 }, hover: true })).toBe('0 ft., Fly 30 ft. (hover)');
  });

  it('formats senses with passive Perception last', () => {
    expect(monsterSensesText(goblin)).toBe('Darkvision 60 ft., Passive Perception 9');
    expect(monsterSensesText({ senses: {}, passivePerception: 10 })).toBe('Passive Perception 10');
  });

  it('formats challenge rating, XP and proficiency bonus', () => {
    expect(monsterCrText(goblin)).toBe('1/4 (XP 50; PB +2)');
    expect(monsterCrText(dragon)).toBe('17 (XP 18,000, or 20,000 in lair; PB +6)');
  });
});

describe('monster senses for token vision', () => {
  it('reads darkvision, blindsight and truesight in feet, ignoring notes and tremorsense', () => {
    expect(monsterSenses(MONSTERS_BY_ID['goblin-warrior']!)).toEqual({ darkvision: 60 });
    expect(monsterSenses(MONSTERS_BY_ID['adult-red-dragon']!)).toEqual({ blindsight: 60, darkvision: 120 });
    expect(monsterSenses({ senses: { blindsight: '30 ft. (blind beyond this radius)', tremorsense: '60 ft.' } })).toEqual({ blindsight: 30 });
    expect(monsterSenses({ senses: {} })).toEqual({});
  });

  it('understands every sense in the bestiary', () => {
    for (const m of MONSTERS) {
      for (const sense of ['darkvision', 'blindsight', 'truesight'] as const) {
        if (m.senses[sense]) expect(monsterSenses(m)[sense], `${m.name} ${sense}`).toBeGreaterThan(0);
      }
    }
  });
});
