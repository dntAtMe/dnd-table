import { describe, expect, it } from 'vitest';
import { blankChoices, buildCharacter, creatorIssues, equipmentFromChoices, masteryOptions, speciesSkillOptions, validBackgroundBonus, type CreatorChoices } from './builder';
import { computeCharacter } from './character';
import { BACKGROUNDS, CLASSES } from './srd';

function rogue(): CreatorChoices {
  return {
    ...blankChoices(),
    name: 'Nim',
    classId: 'rogue',
    backgroundId: 'criminal',
    backgroundBonus: { dex: 2, int: 1 },
    speciesId: 'halfling',
    size: 'Small',
    baseScores: { str: 8, dex: 15, con: 14, int: 12, wis: 13, cha: 10 },
    classSkills: ['acrobatics', 'perception', 'deception', 'investigation'],
    expertise: ['stealth', 'perception'],
    weaponMasteries: ['dagger', 'shortbow'],
    classEquipment: ['A'],
    backgroundEquipment: ['B'],
  };
}

describe('character creator', () => {
  it('reports what is missing, step by step', () => {
    const issues = creatorIssues(blankChoices());
    expect(issues.class).toEqual(['Choose a class']);
    expect(issues.background).toEqual(['Choose a background']);
    expect(issues.species).toEqual(['Choose a species']);
    expect(Object.values(creatorIssues(rogue())).flat()).toEqual([]);
  });

  it('validates background bonuses', () => {
    expect(validBackgroundBonus('soldier', { str: 2, con: 1 })).toBe(true);
    expect(validBackgroundBonus('soldier', { str: 1, dex: 1, con: 1 })).toBe(true);
    expect(validBackgroundBonus('soldier', { str: 2, int: 1 })).toBe(false);
    expect(validBackgroundBonus('soldier', { str: 3 })).toBe(false);
  });

  it('requires species picks, class skills that differ from background skills, and the standard array', () => {
    const c = { ...rogue(), speciesId: 'elf', subspeciesId: null, size: 'Medium', classSkills: ['stealth', 'perception', 'deception', 'investigation'] as CreatorChoices['classSkills'] };
    const issues = creatorIssues({ ...c, baseScores: { str: 15, dex: 15, con: 14, int: 12, wis: 13, cha: 10 } });
    expect(issues.species).toEqual(['Choose a lineage', 'Choose the species skill']);
    expect(issues.details).toContain('Class skills must differ from background and species skills');
    expect(issues.scores).toEqual(['Assign each standard array value once']);
    expect(speciesSkillOptions('elf')).toEqual(['insight', 'perception', 'survival']);
    expect(speciesSkillOptions('human')?.length).toBe(18);
  });

  it('builds a playable level 1 character with starting equipment', () => {
    const c = buildCharacter(rogue());
    const d = computeCharacter(c);
    expect(c.level).toBe(1);
    expect(c.state.hp).toBe(d.hpMax);
    expect(d.hpMax).toBe(8 + 2);
    expect(c.equipment.armorId).toBe('leather-armor');
    expect(c.equipment.weapons.map((w) => w.weaponId)).toEqual(['dagger', 'shortsword', 'shortbow']);
    expect(c.equipment.items).toEqual(expect.arrayContaining([{ name: 'Dagger', qty: 2 }, { name: 'Arrows', qty: 20 }]));
    expect(c.currency.gp).toBe(8 + 50);
    expect(d.ac).toBe(11 + 3);
    expect(d.initiative).toBe(3 + 2); // Criminal → Alert
    expect(d.skills.stealth.proficiency).toBe(2);
  });

  it('turns fractional coins into silver', () => {
    const choice = { desc: '', options: [{ label: 'A', items: [], gold: 2.5 }] };
    expect(equipmentFromChoices([choice], ['A']).currency).toMatchObject({ gp: 2, sp: 5 });
  });

  it('offers masteries only for proficient weapons', () => {
    expect(masteryOptions('rogue')).toContain('rapier');
    expect(masteryOptions('rogue')).not.toContain('greataxe');
    expect(masteryOptions('fighter').length).toBe(Object.keys(CLASSES).length > 0 ? 38 : 0);
    expect(BACKGROUNDS.soldier!.equipment[0]!.options).toHaveLength(2);
  });
});
