import { describe, expect, it } from 'vitest';
import {
  CHARACTER_VERSION,
  applyHpChange,
  computeCharacter,
  criticalDamage,
  d20Test,
  emptyState,
  expertiseCount,
  featLevels,
  longRest,
  pointBuyCost,
  shortRest,
  subclassLevel,
  weaponMasteryCount,
  type Character,
} from './character';

function make(overrides: Partial<Character> = {}): Character {
  const c: Character = {
    version: CHARACTER_VERSION,
    name: 'Test',
    color: '#c0392b',
    classId: 'fighter',
    level: 1,
    subclassId: null,
    speciesId: 'human',
    subspeciesId: null,
    size: 'Medium',
    backgroundId: 'soldier',
    baseScores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
    backgroundBonus: { str: 2, con: 1 },
    advancements: [],
    fightingStyle: null,
    extraFeats: [],
    skills: ['perception', 'intimidation'],
    expertise: [],
    weaponMasteries: [],
    hpRolls: [],
    languages: [],
    tools: [],
    equipment: { armorId: null, shield: false, weapons: [], items: [] },
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    spells: [],
    state: emptyState({ classId: 'fighter', level: 1 }, 0),
    notes: '',
    ...overrides,
  };
  return c;
}

describe('computeCharacter', () => {
  it('derives a level 1 fighter in chain mail', () => {
    const c = make({
      fightingStyle: 'defense',
      weaponMasteries: ['longsword'],
      equipment: { armorId: 'chain-mail', shield: true, weapons: [{ weaponId: 'longsword' }], items: [] },
    });
    const d = computeCharacter(c);
    expect(d.scores).toMatchObject({ str: 17, con: 15 });
    expect(d.profBonus).toBe(2);
    expect(d.hpMax).toBe(12); // d10 + CON 2
    expect(d.ac).toBe(16 + 2 + 1); // chain mail + shield + Defense
    expect(d.saves.str).toEqual({ proficient: true, bonus: 5 });
    expect(d.saves.dex).toEqual({ proficient: false, bonus: 1 });
    // Soldier gives Athletics + Intimidation; chosen Perception + Intimidation.
    expect(d.skills.athletics).toEqual({ proficiency: 1, bonus: 5 });
    expect(d.skills.perception.bonus).toBe(3);
    expect(d.passivePerception).toBe(13);
    const sword = d.attacks.find((a) => a.name === 'Longsword')!;
    expect(sword).toMatchObject({ attackBonus: 5, damage: '1d8 + 3', versatileDamage: '1d10 + 3', mastery: 'sap', proficient: true });
    expect(d.resources.map((r) => [r.id, r.max])).toEqual([['second-wind', 2]]);
    expect(d.warnings).toEqual([]);
    // Soldier's origin feat is Savage Attacker; Defense is listed too.
    expect(d.features.map((f) => f.name)).toEqual(expect.arrayContaining(['Second Wind', 'Savage Attacker', 'Defense']));
  });

  it('uses average HP, dwarven toughness and ASIs as the character levels up', () => {
    const c = make({
      speciesId: 'dwarf',
      level: 5,
      hpRolls: [null, 8, null, null],
      advancements: [{ level: 4, featId: 'ability-score-improvement', increases: { con: 2 } }],
    });
    const d = computeCharacter(c);
    expect(d.scores.con).toBe(17);
    // L1 10+3, L2 6+3, L3 8+3, L4 6+3, L5 6+3, +5 dwarven toughness
    expect(d.hpMax).toBe(13 + 9 + 11 + 9 + 9 + 5);
    expect(d.profBonus).toBe(3);
    expect(d.darkvision).toBe(120);
  });

  it('caps ability increases at 20', () => {
    const c = make({ level: 8, advancements: [4, 8].map((level) => ({ level, featId: 'ability-score-improvement', increases: { str: 2 } })) });
    expect(computeCharacter(c).scores.str).toBe(20);
  });

  it('computes unarmored defense, martial arts and monk speed', () => {
    const c = make({
      classId: 'monk',
      level: 5,
      baseScores: { str: 10, dex: 15, con: 13, int: 8, wis: 14, cha: 12 },
      backgroundBonus: { dex: 2, wis: 1 },
      equipment: { armorId: null, shield: false, weapons: [{ weaponId: 'shortsword' }], items: [] },
    });
    const d = computeCharacter(c);
    expect(d.ac).toBe(10 + 3 + 2);
    expect(d.speed).toBe(40);
    expect(d.attacks[0]).toMatchObject({ ability: 'dex', damage: '1d8 + 3' }); // martial arts d8 beats d6
    expect(d.attacks.find((a) => a.id === 'unarmed')).toMatchObject({ damage: '1d8 + 3' });
    expect(d.resources.find((r) => r.id === 'focus')?.max).toBe(5);
  });

  it('handles spellcasters, including Warlock pact magic', () => {
    const wizard = computeCharacter(make({ classId: 'wizard', level: 5, baseScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, backgroundBonus: { int: 2, con: 1 } }));
    expect(wizard.spellcasting).toMatchObject({ ability: 'int', attackBonus: 6, saveDc: 14, slots: [4, 3, 2, 0, 0, 0, 0, 0, 0], pact: false });
    const warlock = computeCharacter(make({ classId: 'warlock', level: 3 }));
    expect(warlock.spellcasting).toMatchObject({ pact: true, slots: [0, 2, 0, 0, 0, 0, 0, 0, 0] });
    expect(computeCharacter(make()).spellcasting).toBeUndefined();
  });

  it('applies expertise, jack of all trades and alert', () => {
    const rogue = computeCharacter(make({ classId: 'rogue', skills: ['stealth', 'perception'], expertise: ['stealth'], backgroundId: 'criminal', backgroundBonus: { dex: 2, int: 1 } }));
    expect(rogue.skills.stealth).toMatchObject({ proficiency: 2, bonus: 1 + 1 + 4 });
    expect(rogue.initiative).toBe(2 + 2); // Criminal gives Alert
    const bard = computeCharacter(make({ classId: 'bard', level: 2 }));
    expect(bard.skills.arcana).toMatchObject({ proficiency: 0.5, bonus: -1 + 1 });
  });

  it('warns about untrained armor and strength requirements', () => {
    const d = computeCharacter(make({ classId: 'wizard', baseScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, backgroundBonus: {}, equipment: { armorId: 'plate-armor', shield: false, weapons: [], items: [] } }));
    expect(d.warnings).toHaveLength(2);
    expect(d.speed).toBe(20);
  });
});

describe('class progression helpers', () => {
  it('knows feat, subclass, expertise and mastery levels', () => {
    expect(featLevels('fighter')).toEqual([
      ...[4, 6, 8, 12, 14, 16].map((level) => ({ level, kind: 'asi' })),
      { level: 19, kind: 'boon' },
    ]);
    expect(featLevels('rogue').map((f) => f.level)).toContain(10);
    expect(subclassLevel('cleric')).toBe(3);
    expect(expertiseCount('rogue', 6)).toBe(4);
    expect(expertiseCount('bard', 1)).toBe(0);
    expect(weaponMasteryCount('fighter', 1)).toBe(3);
    expect(weaponMasteryCount('rogue', 1)).toBe(2);
    expect(weaponMasteryCount('wizard', 20)).toBe(0);
  });

  it('prices point buy', () => {
    expect(pointBuyCost({ str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 })).toBe(27);
    expect(pointBuyCost({ str: 16, dex: 8, con: 8, int: 8, wis: 8, cha: 8 })).toBeNull();
  });
});

describe('d20 tests and damage', () => {
  it('applies conditions and exhaustion, cancelling advantage with disadvantage', () => {
    const poisoned = make({ state: { ...emptyState({ classId: 'fighter', level: 1 }, 10), conditions: ['poisoned'], exhaustion: 1 } });
    expect(d20Test(poisoned, 'attack', 5)).toMatchObject({ expr: '2d20kl1 + 3', mode: 'disadvantage' });
    expect(d20Test(poisoned, 'attack', 5, 'str', 'advantage')).toMatchObject({ expr: '1d20 + 3', mode: 'normal' });
    expect(d20Test(poisoned, 'save', 2, 'con').mode).toBe('normal');
    const stunned = make({ state: { ...emptyState({ classId: 'fighter', level: 1 }, 10), conditions: ['stunned'] } });
    expect(d20Test(stunned, 'save', 2, 'dex').autoFail).toBe(true);
  });

  it('doubles damage dice on a critical', () => {
    expect(criticalDamage('1d8 + 3')).toBe('2d8 + 3');
    expect(criticalDamage('2d6 - 1')).toBe('4d6 - 1');
  });
});

describe('rests and HP', () => {
  it('takes damage from temporary HP first and resets death saves on healing', () => {
    let s = { ...emptyState({ classId: 'fighter', level: 1 }, 10), tempHp: 3 };
    s = applyHpChange(s, 12, -5);
    expect(s).toMatchObject({ tempHp: 0, hp: 8 });
    s = applyHpChange({ ...s, hp: 0, deathSaves: { successes: 1, failures: 2 } }, 12, 20);
    expect(s).toMatchObject({ hp: 12, deathSaves: { successes: 0, failures: 0 } });
  });

  it('recharges resources on short and long rests', () => {
    const c = make({ classId: 'fighter', level: 2 });
    const d = computeCharacter(c);
    c.state = { ...c.state, hp: 3, resourcesUsed: { 'second-wind': 2, 'action-surge': 1 }, exhaustion: 2 };
    const afterShort = shortRest(c, d, 1, 7);
    expect(afterShort).toMatchObject({ hp: 10, hitDiceSpent: 1, resourcesUsed: { 'second-wind': 1, 'action-surge': 0 } });
    const afterLong = longRest({ ...c, state: afterShort }, d);
    expect(afterLong).toMatchObject({ hp: d.hpMax, hitDiceSpent: 0, resourcesUsed: {}, exhaustion: 1, heroicInspiration: true });
  });
});
