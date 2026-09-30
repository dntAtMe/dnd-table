import { describe, expect, it } from 'vitest';
import {
  ARMOR,
  BACKGROUNDS,
  CLASSES,
  CONDITION_IDS,
  FEATS,
  FEATURES,
  RULES_TEXT,
  SKILL_IDS,
  SKILLS,
  SPECIES,
  SUBCLASSES,
  TRAITS,
  WEAPONS,
} from './index';
import { SPELLS } from './spells';

// Guards the hand-written vocabulary (core.ts) and the generated data against drifting apart.
describe('SRD data', () => {
  it('matches the core skill and condition lists', () => {
    expect(Object.keys(RULES_TEXT.skills).sort()).toEqual([...SKILL_IDS].sort());
    for (const id of SKILL_IDS) expect(RULES_TEXT.skills[id]!.ability).toBe(SKILLS[id].ability);
    for (const id of CONDITION_IDS) expect(RULES_TEXT.conditions[id], id).toBeDefined();
  });

  it('has complete classes with 20 levels and resolvable references', () => {
    expect(Object.keys(CLASSES)).toHaveLength(12);
    for (const c of Object.values(CLASSES)) {
      expect(c.levels.map((l) => l.level)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      for (const l of c.levels) for (const f of l.features) expect(FEATURES[f], f).toBeDefined();
      for (const s of c.subclasses) expect(SUBCLASSES[s], s).toBeDefined();
      for (const w of c.weaponTraining.weapons) expect(WEAPONS[w], w).toBeDefined();
      if (c.skillChoice && c.skillChoice.from !== 'any') for (const s of c.skillChoice.from) expect(SKILL_IDS).toContain(s);
    }
  });

  it('has the SRD species, backgrounds and feats', () => {
    expect(Object.keys(SPECIES).sort()).toEqual(['dragonborn', 'dwarf', 'elf', 'gnome', 'goliath', 'halfling', 'human', 'orc', 'tiefling']);
    for (const s of Object.values(SPECIES)) for (const t of s.traits) expect(TRAITS[t], t).toBeDefined();
    for (const b of Object.values(BACKGROUNDS)) {
      expect(FEATS[b.feat.id], b.feat.id).toBeDefined();
      expect(b.abilities).toHaveLength(3);
    }
  });

  it('has weapons with masteries, armor and spells', () => {
    for (const w of Object.values(WEAPONS)) expect(RULES_TEXT.masteries[w.mastery], w.id).toBeDefined();
    expect(ARMOR['plate-armor']).toMatchObject({ baseAc: 18, category: 'heavy', strength: 15 });
    expect(ARMOR['hide-armor']).toMatchObject({ baseAc: 12, maxDex: 2 });
    expect(SPELLS.length).toBeGreaterThan(300);
    expect(SPELLS.find((s) => s.id === 'fireball')).toMatchObject({ level: 3, school: 'evocation' });
  });

  it('keeps spell slot tables consistent with 2024 progressions', () => {
    const slots = (cls: string, level: number) => CLASSES[cls]!.levels[level - 1]!.spellcasting!.slots;
    expect(slots('wizard', 5)).toEqual([4, 3, 2, 0, 0, 0, 0, 0, 0]);
    expect(slots('paladin', 1)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(slots('warlock', 3)).toEqual([0, 2, 0, 0, 0, 0, 0, 0, 0]);
  });
});
