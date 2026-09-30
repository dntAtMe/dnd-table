// Turns character-creator choices into a level 1 Character (2024 rules).
import {
  CHARACTER_VERSION,
  computeCharacter,
  emptyState,
  expertiseCount,
  hasFightingStyle,
  isWeaponProficient,
  pointBuyCost,
  POINT_BUY_BUDGET,
  weaponMasteryCount,
  type AbilityScores,
  type Character,
} from './character';
import {
  ABILITIES,
  ARMOR,
  BACKGROUNDS,
  CLASSES,
  FEATS,
  GEAR,
  SKILL_IDS,
  SPECIES,
  SUBSPECIES,
  TRAITS,
  WEAPONS,
  type Ability,
  type EquipmentChoice,
  type Skill,
} from './srd';

export type ScoreMethod = 'standard' | 'pointBuy' | 'rolled';

export interface CreatorChoices {
  name: string;
  color: string;
  classId: string;
  backgroundId: string;
  /** '+2/+1' or '+1/+1/+1' spread over the background's abilities. */
  backgroundBonus: Partial<AbilityScores>;
  speciesId: string;
  subspeciesId: string | null;
  size: string;
  /** Skill picked through a species trait (Elf Keen Senses, Human Skillful). */
  speciesSkill: Skill | null;
  /** Origin feat from the Human's Versatile trait. */
  versatileFeat: string | null;
  scoreMethod: ScoreMethod;
  baseScores: AbilityScores;
  classSkills: Skill[];
  expertise: Skill[];
  fightingStyle: string | null;
  weaponMasteries: string[];
  /** Chosen option label per class / background equipment choice ("A", "B"…). */
  classEquipment: string[];
  backgroundEquipment: string[];
  languages: string[];
}

export function blankChoices(): CreatorChoices {
  return {
    name: '',
    color: '#2e86de',
    classId: '',
    backgroundId: '',
    backgroundBonus: {},
    speciesId: '',
    subspeciesId: null,
    size: '',
    speciesSkill: null,
    versatileFeat: null,
    scoreMethod: 'standard',
    baseScores: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
    classSkills: [],
    expertise: [],
    fightingStyle: null,
    weaponMasteries: [],
    classEquipment: [],
    backgroundEquipment: [],
    languages: [],
  };
}

/** Species trait that lets the player pick a skill, if any. */
export function speciesSkillOptions(speciesId: string): Skill[] | null {
  for (const id of SPECIES[speciesId]?.traits ?? []) {
    const choice = TRAITS[id]?.skillChoice;
    if (choice) return choice.from.length ? choice.from : SKILL_IDS;
  }
  return null;
}

export function speciesGrantsOriginFeat(speciesId: string): boolean {
  return SPECIES[speciesId]?.traits.includes('versatile') ?? false;
}

export function backgroundSkills(backgroundId: string): Skill[] {
  return BACKGROUNDS[backgroundId]?.skills ?? [];
}

/** Every skill the character is proficient in from these choices. */
export function chosenSkills(c: CreatorChoices): Skill[] {
  return [...new Set([...backgroundSkills(c.backgroundId), ...(c.speciesSkill ? [c.speciesSkill] : []), ...c.classSkills])];
}

export function validBackgroundBonus(backgroundId: string, bonus: Partial<AbilityScores>): boolean {
  const allowed = BACKGROUNDS[backgroundId]?.abilities ?? [];
  const entries = Object.entries(bonus).filter(([, v]) => v) as [Ability, number][];
  if (entries.some(([a]) => !allowed.includes(a))) return false;
  const values = entries.map(([, v]) => v).sort();
  return (values.length === 2 && values[0] === 1 && values[1] === 2) || (values.length === 3 && values.every((v) => v === 1));
}

/** Missing or invalid choices, per creator step. Empty means ready to create. */
export function creatorIssues(c: CreatorChoices): Record<'class' | 'background' | 'species' | 'scores' | 'details' | 'equipment', string[]> {
  const cls = CLASSES[c.classId];
  const issues = { class: [] as string[], background: [] as string[], species: [] as string[], scores: [] as string[], details: [] as string[], equipment: [] as string[] };
  if (!cls) issues.class.push('Choose a class');
  if (!BACKGROUNDS[c.backgroundId]) issues.background.push('Choose a background');
  else if (!validBackgroundBonus(c.backgroundId, c.backgroundBonus)) issues.background.push('Assign +2/+1 or +1/+1/+1 to the background abilities');
  const species = SPECIES[c.speciesId];
  if (!species) issues.species.push('Choose a species');
  else {
    if (species.subspecies?.length && !c.subspeciesId) issues.species.push('Choose a lineage');
    if (c.subspeciesId && SUBSPECIES[c.subspeciesId]?.speciesId !== c.speciesId) issues.species.push('Choose a lineage');
    if (!species.sizes.includes(c.size)) issues.species.push('Choose a size');
    if (speciesSkillOptions(c.speciesId) && !c.speciesSkill) issues.species.push('Choose the species skill');
    if (speciesGrantsOriginFeat(c.speciesId) && FEATS[c.versatileFeat ?? '']?.type !== 'origin') issues.species.push('Choose an origin feat');
  }
  if (c.scoreMethod === 'pointBuy') {
    const cost = pointBuyCost(c.baseScores);
    if (cost === null || cost > POINT_BUY_BUDGET) issues.scores.push(`Point buy must stay within ${POINT_BUY_BUDGET} points`);
  }
  if (c.scoreMethod === 'standard') {
    const values = ABILITIES.map((a) => c.baseScores[a]).sort((x, y) => y - x);
    if (values.join() !== '15,14,13,12,10,8') issues.scores.push('Assign each standard array value once');
  }
  if (cls) {
    const choice = cls.skillChoice;
    if (choice && c.classSkills.length !== choice.choose) issues.details.push(`Choose ${choice.choose} class skills`);
    const bg = new Set([...backgroundSkills(c.backgroundId), ...(c.speciesSkill ? [c.speciesSkill] : [])]);
    if (c.classSkills.some((s) => bg.has(s))) issues.details.push('Class skills must differ from background and species skills');
    const exp = expertiseCount(c.classId, 1);
    if (c.expertise.length !== exp) {
      if (exp) issues.details.push(`Choose ${exp} skills for Expertise`);
    } else if (c.expertise.some((s) => !chosenSkills(c).includes(s))) issues.details.push('Expertise needs skills you are proficient in');
    if (hasFightingStyle(c.classId, 1) && FEATS[c.fightingStyle ?? '']?.type !== 'fighting-style') issues.details.push('Choose a Fighting Style');
    const masteries = weaponMasteryCount(c.classId, 1);
    if (c.weaponMasteries.length !== masteries && masteries) issues.details.push(`Choose ${masteries} Weapon Masteries`);
    if (cls.startingEquipment.length !== c.classEquipment.filter(Boolean).length) issues.equipment.push('Choose class equipment');
  }
  if (!c.name.trim()) issues.details.push('Name your character');
  const bg = BACKGROUNDS[c.backgroundId];
  if (bg && bg.equipment.length !== c.backgroundEquipment.filter(Boolean).length) issues.equipment.push('Choose background equipment');
  return issues;
}

/** Folds chosen equipment options into armor, shield, weapons, items and coins. */
export function equipmentFromChoices(choices: EquipmentChoice[], labels: string[]): Pick<Character, 'equipment' | 'currency'> {
  const equipment: Character['equipment'] = { armorId: null, shield: false, weapons: [], items: [] };
  let gold = 0;
  choices.forEach((choice, i) => {
    const option = choice.options.find((o) => o.label === labels[i]);
    if (!option) return;
    gold += option.gold;
    for (const item of option.items) {
      const armor = ARMOR[item.id];
      if (armor?.category === 'shield') equipment.shield = true;
      else if (armor) equipment.armorId ??= armor.id;
      else if (WEAPONS[item.id]) {
        if (!equipment.weapons.some((w) => w.weaponId === item.id)) equipment.weapons.push({ weaponId: item.id });
        // Keep a count of throwables like javelins so they can be tracked.
        if (item.count > 1) equipment.items.push({ name: WEAPONS[item.id]!.name, qty: item.count });
      } else {
        equipment.items.push({ name: GEAR[item.id]?.name ?? item.name, qty: item.count });
      }
    }
  });
  const gp = Math.floor(gold);
  const sp = Math.round((gold - gp) * 10);
  return { equipment, currency: { cp: 0, sp, ep: 0, gp, pp: 0 } };
}

export function buildCharacter(c: CreatorChoices): Character {
  const cls = CLASSES[c.classId];
  const bg = BACKGROUNDS[c.backgroundId];
  if (!cls || !bg) throw new Error('Choose a class and background first');
  const { equipment, currency } = equipmentFromChoices([...cls.startingEquipment, ...bg.equipment], [...c.classEquipment, ...c.backgroundEquipment]);
  const character: Character = {
    version: CHARACTER_VERSION,
    name: c.name.trim(),
    color: c.color,
    classId: c.classId,
    level: 1,
    subclassId: null,
    speciesId: c.speciesId,
    subspeciesId: c.subspeciesId,
    size: c.size,
    backgroundId: c.backgroundId,
    baseScores: c.baseScores,
    backgroundBonus: c.backgroundBonus,
    advancements: [],
    fightingStyle: hasFightingStyle(c.classId, 1) ? c.fightingStyle : null,
    extraFeats: c.versatileFeat ? [{ featId: c.versatileFeat }] : [],
    skills: [...new Set([...(c.speciesSkill ? [c.speciesSkill] : []), ...c.classSkills])],
    expertise: c.expertise,
    weaponMasteries: c.weaponMasteries,
    hpRolls: [],
    languages: c.languages,
    tools: [],
    equipment,
    currency,
    spells: [],
    state: emptyState({ classId: c.classId, level: 1 }, 1),
    notes: '',
  };
  const hp = computeCharacter(character).hpMax;
  return { ...character, state: { ...character.state, hp } };
}

/** Weapons this class can pick masteries for: ones it's proficient with. */
export function masteryOptions(classId: string): string[] {
  const cls = CLASSES[classId];
  if (!cls) return [];
  return Object.values(WEAPONS)
    .filter((w) => isWeaponProficient(cls, w))
    .map((w) => w.id);
}

/** The 2024 standard languages a character can pick (two, plus Common). */
export const STANDARD_LANGUAGES = [
  'Common Sign Language',
  'Draconic',
  'Dwarvish',
  'Elvish',
  'Giant',
  'Gnomish',
  'Goblin',
  'Halfling',
  'Orc',
];
