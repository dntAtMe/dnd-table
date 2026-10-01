import { describe, expect, it } from 'vitest';
import { monsterCrText, monsterSensesText, monsterSpeedText } from './monsters';
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
