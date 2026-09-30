import { describe, expect, it } from 'vitest';
import { blankChoices, buildCharacter } from './builder';
import { computeCharacter, type Character } from './character';
import { applyLevelUp, featAbilityOptions, featsForLevel, levelUpIssues, levelUpPlan, type LevelUpChoices } from './levelup';
import { FEATS } from './srd';

function fighter(): Character {
  return buildCharacter({
    ...blankChoices(),
    name: 'Brakka',
    classId: 'fighter',
    backgroundId: 'soldier',
    backgroundBonus: { str: 2, con: 1 },
    speciesId: 'orc',
    size: 'Medium',
    baseScores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
    classSkills: ['perception', 'survival'],
    fightingStyle: 'great-weapon-fighting',
    weaponMasteries: ['greatsword', 'javelin', 'flail'],
    classEquipment: ['A'],
    backgroundEquipment: ['B'],
  });
}

const none: LevelUpChoices = { hpRoll: null, subclassId: null, featId: null, increases: {}, expertise: [], weaponMasteries: [], fightingStyle: null };

function levelTo(c: Character, level: number, pick: (plan: NonNullable<ReturnType<typeof levelUpPlan>>) => Partial<LevelUpChoices> = () => ({})): Character {
  while (c.level < level) {
    const plan = levelUpPlan(c)!;
    const choices = { ...none, ...pick(plan) };
    expect(levelUpIssues(c, plan, choices)).toEqual([]);
    c = applyLevelUp(c, plan, choices);
  }
  return c;
}

describe('level up', () => {
  it('plans subclass, ASI and mastery choices at the right levels', () => {
    let c = fighter();
    expect(levelUpPlan(c)).toMatchObject({ level: 2, needsSubclass: false, featChoice: null });
    expect(levelUpPlan(c)!.features.map((f) => f.name)).toContain('Action Surge');
    c = levelTo(c, 2);
    const at3 = levelUpPlan(c)!;
    expect(at3).toMatchObject({ level: 3, needsSubclass: true, subclassOptions: ['champion'] });
    expect(levelUpIssues(c, at3, none)).toEqual(['Choose a subclass']);
    c = levelTo(c, 3, () => ({ subclassId: 'champion' }));
    const at4 = levelUpPlan(c)!;
    expect(at4).toMatchObject({ featChoice: 'asi', newMasteries: 1 });
  });

  it('applies HP, feats and ability increases', () => {
    let c = fighter();
    const hp1 = computeCharacter(c).hpMax;
    c = levelTo(c, 4, (plan) => ({
      subclassId: plan.needsSubclass ? 'champion' : null,
      hpRoll: plan.level === 2 ? 10 : null,
      featId: plan.featChoice ? 'ability-score-improvement' : null,
      increases: plan.featChoice ? { str: 1, con: 1 } : {},
      weaponMasteries: plan.newMasteries ? ['maul'] : [],
    }));
    const d = computeCharacter(c);
    expect(d.scores).toMatchObject({ str: 18, con: 16 });
    // L1 10+2; L2 rolled 10 (+2), L3 avg 6 (+2); CON 16 at L4 raises every level's bonus by 1.
    expect(d.hpMax).toBe(10 + 10 + 6 + 6 + 4 * 3);
    expect(c.state.hp).toBe(d.hpMax);
    expect(hp1).toBe(12);
    expect(c.weaponMasteries).toContain('maul');
  });

  it('rejects bad increases and knows which abilities a feat raises', () => {
    const c = levelTo(fighter(), 3, (plan) => ({ subclassId: plan.needsSubclass ? 'champion' : null }));
    const plan = levelUpPlan(c)!;
    const base = { ...none, weaponMasteries: ['maul'] };
    expect(levelUpIssues(c, plan, { ...base, featId: 'ability-score-improvement', increases: { str: 3 } })).toEqual(['Assign +2 to one ability or +1 to two']);
    expect(levelUpIssues(c, plan, { ...base, featId: 'grappler', increases: { int: 1 } })).toEqual(['Choose which ability to increase']);
    expect(levelUpIssues(c, plan, { ...base, featId: 'grappler', increases: { dex: 1 } })).toEqual([]);
    expect(featAbilityOptions(FEATS.grappler!)).toEqual(['str', 'dex']);
    expect(featAbilityOptions(FEATS['boon-of-fate']!)).toHaveLength(6);
    expect(featsForLevel('asi', 4, []).map((f) => f.id)).toEqual(['ability-score-improvement', 'grappler']);
    expect(featsForLevel('asi', 8, ['grappler']).map((f) => f.id)).toEqual(['ability-score-improvement']);
  });

  it('adds expertise for rogues and a fighting style for paladins', () => {
    const paladin = buildCharacter({
      ...blankChoices(),
      name: 'Sera',
      classId: 'paladin',
      backgroundId: 'acolyte',
      backgroundBonus: { cha: 2, wis: 1 },
      speciesId: 'human',
      size: 'Medium',
      speciesSkill: 'athletics',
      versatileFeat: 'alert',
      baseScores: { str: 15, dex: 10, con: 13, int: 8, wis: 12, cha: 14 },
      classSkills: ['persuasion', 'medicine'],
      weaponMasteries: ['longsword', 'javelin'],
      classEquipment: ['A'],
      backgroundEquipment: ['B'],
    });
    expect(levelUpPlan(paladin)).toMatchObject({ needsFightingStyle: true, spellcasting: { slots: [2, 0, 0, 0, 0, 0, 0, 0, 0] } });
    const lvl2 = levelTo(paladin, 2, () => ({ fightingStyle: 'defense' }));
    expect(lvl2.fightingStyle).toBe('defense');
  });
});
