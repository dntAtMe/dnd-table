// A 2024-rules character: the choices a player makes (stored) and everything derived from them.
// Only choices and live state are persisted; numbers like AC or skill bonuses are always computed.
import {
  ABILITIES,
  ARMOR,
  BACKGROUNDS,
  CLASSES,
  CONDITIONS,
  FEATS,
  FEATURES,
  SKILL_IDS,
  SKILLS,
  SPECIES,
  SUBCLASSES,
  SUBSPECIES,
  TRAITS,
  WEAPONS,
  type Ability,
  type ClassDef,
  type ConditionId,
  type Skill,
  type WeaponDef,
} from './srd';
import { formatModifier, type D20Mode } from './dice';

export const CHARACTER_VERSION = 1;

export type AbilityScores = Record<Ability, number>;

/** A feat taken at an Ability Score Improvement or Epic Boon level. */
export interface Advancement {
  level: number;
  featId: string;
  /** Ability increases granted with it (ASI: +2/+1+1; most other feats +1). */
  increases: Partial<AbilityScores>;
}

export interface CharacterWeapon {
  weaponId: string;
  /** Optional custom name, e.g. "Grandfather's Longsword". */
  name?: string;
}

export interface CharacterItem {
  name: string;
  qty: number;
  notes?: string;
}

export interface CharacterSpell {
  /** SRD spell id, if picked from the list. */
  spellId?: string;
  name: string;
  level: number;
  prepared: boolean;
  notes?: string;
}

export interface CharacterState {
  hp: number;
  tempHp: number;
  deathSaves: { successes: number; failures: number };
  hitDiceSpent: number;
  /** Expended slots per spell level (index 0 = 1st level). Warlocks use this for Pact Magic slots. */
  slotsUsed: number[];
  /** Expended uses per resource id (see computeCharacter().resources). */
  resourcesUsed: Record<string, number>;
  conditions: ConditionId[];
  exhaustion: number;
  heroicInspiration: boolean;
}

export interface Character {
  version: typeof CHARACTER_VERSION;
  name: string;
  /** Token colour on the map. */
  color: string;
  classId: string;
  level: number;
  subclassId: string | null;
  speciesId: string;
  subspeciesId: string | null;
  size: string;
  backgroundId: string;
  /** Scores before background and feat increases. */
  baseScores: AbilityScores;
  /** Background increases: +2/+1 or +1/+1/+1 among the background's three abilities. */
  backgroundBonus: Partial<AbilityScores>;
  advancements: Advancement[];
  /** Fighting Style feat (Fighter 1, Paladin 2, Ranger 2). */
  fightingStyle: string | null;
  /** Other feats, e.g. the Human's Versatile origin feat. */
  extraFeats: { featId: string; note?: string }[];
  /** Chosen skill proficiencies (class, species, feats); background skills are added automatically. */
  skills: Skill[];
  expertise: Skill[];
  weaponMasteries: string[];
  /** Hit Point rolls for levels 2+ (index 0 = level 2); null means take the average. */
  hpRolls: (number | null)[];
  languages: string[];
  tools: string[];
  equipment: {
    armorId: string | null;
    shield: boolean;
    weapons: CharacterWeapon[];
    items: CharacterItem[];
  };
  currency: { cp: number; sp: number; ep: number; gp: number; pp: number };
  spells: CharacterSpell[];
  state: CharacterState;
  notes: string;
}

// ---------- basics ----------

export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);
export const proficiencyBonus = (level: number): number => 2 + Math.floor((Math.max(1, level) - 1) / 4);

export const POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUY_BUDGET = 27;
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

export function pointBuyCost(scores: AbilityScores): number | null {
  let total = 0;
  for (const a of ABILITIES) {
    const cost = POINT_BUY_COST[scores[a]];
    if (cost === undefined) return null;
    total += cost;
  }
  return total;
}

function classDef(c: Pick<Character, 'classId'>): ClassDef {
  const def = CLASSES[c.classId];
  if (!def) throw new Error(`Unknown class ${c.classId}`);
  return def;
}

const classSpecific = (def: ClassDef, level: number) => def.levels[level - 1]?.classSpecific ?? {};
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Class levels at which the character picks a feat (ASI levels, then the Epic Boon at 19). */
export function featLevels(classId: string): { level: number; kind: 'asi' | 'boon' }[] {
  const def = CLASSES[classId];
  if (!def) return [];
  return def.levels.flatMap((l): { level: number; kind: 'asi' | 'boon' }[] =>
    l.features.some((f) => f.endsWith('-ability-score-improvement'))
      ? [{ level: l.level, kind: 'asi' }]
      : l.features.some((f) => f.endsWith('-epic-boon'))
        ? [{ level: l.level, kind: 'boon' }]
        : [],
  );
}

function hasFeature(def: ClassDef, level: number, suffix: string): boolean {
  return def.levels.slice(0, level).some((l) => l.features.some((f) => f.endsWith(suffix)));
}

/** Level at which the class chooses its subclass (3 for every 2024 class). */
export function subclassLevel(classId: string): number {
  const def = CLASSES[classId];
  const l = def?.levels.find((x) => x.features.some((f) => f.endsWith('-subclass')));
  return l?.level ?? 3;
}

/** How many Expertise skills the class grants by this level (Rogue 1 & 6, Bard 2 & 9, Ranger 9). */
export function expertiseCount(classId: string, level: number): number {
  const def = CLASSES[classId];
  if (!def) return 0;
  return def.levels.slice(0, level).filter((l) => l.features.some((f) => f.endsWith('-expertise'))).length * 2;
}

export function weaponMasteryCount(classId: string, level: number): number {
  const def = CLASSES[classId];
  if (!def || !hasFeature(def, level, '-weapon-mastery')) return 0;
  return num(classSpecific(def, level).weapon_mastery) || 2;
}

export function hasFightingStyle(classId: string, level: number): boolean {
  const def = CLASSES[classId];
  return Boolean(def && hasFeature(def, level, '-fighting-style'));
}

// ---------- ability scores ----------

export function abilityScores(c: Character): AbilityScores {
  const scores = { ...c.baseScores };
  for (const a of ABILITIES) scores[a] += c.backgroundBonus[a] ?? 0;
  let boon: Partial<AbilityScores> = {};
  for (const adv of c.advancements) {
    if (adv.level > c.level) continue;
    if (FEATS[adv.featId]?.type === 'epic-boon') {
      boon = adv.increases;
      continue;
    }
    for (const a of ABILITIES) scores[a] += adv.increases[a] ?? 0;
  }
  // Increases can't raise a score above 20, except Epic Boons (up to 30).
  for (const a of ABILITIES) scores[a] = Math.min(scores[a], Math.max(20, c.baseScores[a]));
  for (const a of ABILITIES) if (boon[a]) scores[a] = Math.min(scores[a] + boon[a]!, 30);
  return scores;
}

// ---------- derived sheet ----------

export type Recharge = 'short' | 'long';

export interface Resource {
  id: string;
  name: string;
  max: number;
  /** When all uses come back. */
  recharge: Recharge;
  /** Uses regained on a Short Rest when recharge is 'long' (e.g. Rage regains one). */
  shortRestRegain?: number;
  /** Die shown next to the resource, e.g. "d8" for Bardic Inspiration. */
  die?: string;
}

export interface Attack {
  id: string;
  name: string;
  ability: Ability;
  proficient: boolean;
  attackBonus: number;
  damage: string;
  versatileDamage?: string;
  damageType: string;
  mastery?: string;
  properties: string[];
  range?: string;
  notes: string[];
}

export interface FeatureEntry {
  name: string;
  source: string;
  level?: number;
  description: string;
  /** The knowledge base entry this comes from (subclass features point at their subclass). */
  ref?: { kind: 'feature' | 'subclass' | 'trait' | 'feat'; id: string };
}

export interface DerivedCharacter {
  scores: AbilityScores;
  mods: AbilityScores;
  profBonus: number;
  saves: Record<Ability, { bonus: number; proficient: boolean }>;
  skills: Record<Skill, { bonus: number; proficiency: 0 | 0.5 | 1 | 2 }>;
  passivePerception: number;
  initiative: number;
  ac: number;
  acSource: string;
  speed: number;
  darkvision: number;
  hpMax: number;
  hitDie: number;
  spellcasting?: {
    ability: Ability;
    attackBonus: number;
    saveDc: number;
    slots: number[];
    pact: boolean;
    cantrips: number;
    prepared: number;
  };
  attacks: Attack[];
  resources: Resource[];
  features: FeatureEntry[];
  proficiencies: { armor: string[]; weapons: string[]; tools: string[]; languages: string[] };
  warnings: string[];
}

function featEntries(c: Character): { featId: string; source: string; note?: string }[] {
  const background = BACKGROUNDS[c.backgroundId];
  const out: { featId: string; source: string; note?: string }[] = [];
  if (background) out.push({ featId: background.feat.id, source: background.name, note: background.feat.note });
  if (c.fightingStyle) out.push({ featId: c.fightingStyle, source: 'Fighting Style' });
  for (const f of c.extraFeats) out.push({ featId: f.featId, source: 'Feat', note: f.note });
  for (const a of c.advancements) if (a.level <= c.level && a.featId !== 'ability-score-improvement') out.push({ featId: a.featId, source: `Level ${a.level}` });
  return out;
}

export function hasFeat(c: Character, featId: string): boolean {
  return featEntries(c).some((f) => f.featId === featId);
}

function speciesTraitIds(c: Character): string[] {
  const species = SPECIES[c.speciesId];
  const sub = c.subspeciesId ? SUBSPECIES[c.subspeciesId] : undefined;
  return [
    ...(species?.traits ?? []),
    ...(sub?.traits.filter((t) => (t.level ?? 1) <= c.level).map((t) => t.id) ?? []),
  ];
}

export function isWeaponProficient(def: ClassDef, weapon: WeaponDef): boolean {
  return def.weaponTraining.categories.includes(weapon.category) || def.weaponTraining.weapons.includes(weapon.id);
}

export function hpMax(c: Character, mods = abilityScores(c)): number {
  const def = classDef(c);
  const con = abilityMod(mods.con);
  const average = def.hitDie / 2 + 1;
  let hp = Math.max(1, def.hitDie + con);
  for (let lvl = 2; lvl <= c.level; lvl++) hp += Math.max(1, (c.hpRolls[lvl - 2] ?? average) + con);
  const traits = speciesTraitIds(c);
  if (traits.includes('dwarven-toughness')) hp += c.level;
  if (c.subclassId === 'draconic-sorcery' && c.level >= 3) hp += c.level;
  return hp;
}

function classResources(def: ClassDef, level: number, mods: AbilityScores): Resource[] {
  const cs = classSpecific(def, level);
  const at = (min: number) => level >= min;
  switch (def.id) {
    case 'barbarian':
      return [{ id: 'rage', name: 'Rage', max: num(cs.rage_count), recharge: 'long', shortRestRegain: 1 }];
    case 'bard':
      return [
        {
          id: 'bardic-inspiration',
          name: 'Bardic Inspiration',
          max: Math.max(1, mods.cha),
          recharge: at(5) ? 'short' : 'long',
          die: `d${num(cs.bardic_inspiration_die) || 6}`,
        },
      ];
    case 'cleric':
      return [
        ...(at(2) ? [{ id: 'channel-divinity', name: 'Channel Divinity', max: num(cs.channel_divinity_charges), recharge: 'long' as const, shortRestRegain: 1 }] : []),
        ...(at(10) ? [{ id: 'divine-intervention', name: 'Divine Intervention', max: 1, recharge: 'long' as const }] : []),
      ];
    case 'druid':
      return at(2) ? [{ id: 'wild-shape', name: 'Wild Shape', max: num(cs.wild_shape_uses), recharge: 'long', shortRestRegain: 1 }] : [];
    case 'fighter':
      return [
        { id: 'second-wind', name: 'Second Wind', max: num(cs.second_wind_uses), recharge: 'long', shortRestRegain: 1 },
        ...(at(2) ? [{ id: 'action-surge', name: 'Action Surge', max: at(17) ? 2 : 1, recharge: 'short' as const }] : []),
        ...(at(9) ? [{ id: 'indomitable', name: 'Indomitable', max: at(17) ? 3 : at(13) ? 2 : 1, recharge: 'long' as const }] : []),
      ];
    case 'monk':
      return at(2)
        ? [
            { id: 'focus', name: 'Focus Points', max: num(cs.focus_points), recharge: 'short' },
            { id: 'uncanny-metabolism', name: 'Uncanny Metabolism', max: 1, recharge: 'long' },
          ]
        : [];
    case 'paladin':
      return [
        { id: 'lay-on-hands', name: 'Lay on Hands (HP pool)', max: 5 * level, recharge: 'long' },
        ...(at(3) ? [{ id: 'channel-divinity', name: 'Channel Divinity', max: num(cs.channel_divinity_charges), recharge: 'long' as const, shortRestRegain: 1 }] : []),
      ];
    case 'ranger':
      return [{ id: 'favored-enemy', name: "Favored Enemy (free Hunter's Mark)", max: num(cs.favored_enemies), recharge: 'long' }];
    case 'rogue':
      return at(20) ? [{ id: 'stroke-of-luck', name: 'Stroke of Luck', max: 1, recharge: 'short' }] : [];
    case 'sorcerer':
      return [
        { id: 'innate-sorcery', name: 'Innate Sorcery', max: 2, recharge: 'long' },
        ...(at(2) ? [{ id: 'sorcery-points', name: 'Sorcery Points', max: num(cs.sorcery_points), recharge: 'long' as const }] : []),
      ];
    case 'warlock':
      return at(2) ? [{ id: 'magical-cunning', name: 'Magical Cunning', max: 1, recharge: 'long' }] : [];
    case 'wizard':
      return [{ id: 'arcane-recovery', name: 'Arcane Recovery', max: 1, recharge: 'long' }];
    default:
      return [];
  }
}

function speciesResources(traits: string[], level: number, pb: number): Resource[] {
  const out: Resource[] = [];
  if (traits.some((t) => t.startsWith('draconic-breath-weapon'))) out.push({ id: 'breath-weapon', name: 'Breath Weapon', max: pb, recharge: 'long' });
  if (traits.includes('draconic-flight') && level >= 5) out.push({ id: 'draconic-flight', name: 'Draconic Flight', max: 1, recharge: 'long' });
  if (traits.includes('stonecunning')) out.push({ id: 'stonecunning', name: 'Stonecunning', max: pb, recharge: 'long' });
  if (traits.includes('giant-ancestry')) out.push({ id: 'giant-ancestry', name: 'Giant Ancestry', max: pb, recharge: 'long' });
  if (traits.includes('large-form') && level >= 5) out.push({ id: 'large-form', name: 'Large Form', max: 1, recharge: 'long' });
  if (traits.includes('adrenaline-rush')) out.push({ id: 'adrenaline-rush', name: 'Adrenaline Rush', max: pb, recharge: 'short' });
  if (traits.includes('relentless-endurance')) out.push({ id: 'relentless-endurance', name: 'Relentless Endurance', max: 1, recharge: 'long' });
  return out;
}

export function computeCharacter(c: Character): DerivedCharacter {
  const def = classDef(c);
  const level = Math.min(20, Math.max(1, c.level));
  const pb = proficiencyBonus(level);
  const scores = abilityScores(c);
  const mods = Object.fromEntries(ABILITIES.map((a) => [a, abilityMod(scores[a])])) as AbilityScores;
  const cs = classSpecific(def, level);
  const background = BACKGROUNDS[c.backgroundId];
  const species = SPECIES[c.speciesId];
  const traits = speciesTraitIds(c);
  const warnings: string[] = [];

  // Saving throws
  const auraOfProtection = def.id === 'paladin' && level >= 6 ? Math.max(1, mods.cha) : 0;
  const saves = Object.fromEntries(
    ABILITIES.map((a) => {
      const proficient = def.savingThrows.includes(a);
      return [a, { proficient, bonus: mods[a] + (proficient ? pb : 0) + auraOfProtection }];
    }),
  ) as DerivedCharacter['saves'];

  // Skills
  const proficientSkills = new Set<Skill>([...(background?.skills ?? []), ...c.skills]);
  const jackOfAllTrades = def.id === 'bard' && level >= 2;
  const skills = Object.fromEntries(
    SKILL_IDS.map((s) => {
      const proficiency: 0 | 0.5 | 1 | 2 = c.expertise.includes(s) && proficientSkills.has(s)
        ? 2
        : proficientSkills.has(s)
          ? 1
          : jackOfAllTrades
            ? 0.5
            : 0;
      return [s, { proficiency, bonus: mods[SKILLS[s].ability] + Math.floor(pb * proficiency) }];
    }),
  ) as DerivedCharacter['skills'];

  // Armor & AC
  const armor = c.equipment.armorId ? ARMOR[c.equipment.armorId] : undefined;
  const shield = c.equipment.shield ? 2 : 0;
  const candidates: { ac: number; source: string }[] = [];
  if (armor && armor.category !== 'shield') {
    const dex = armor.dexBonus ? (armor.maxDex !== undefined ? Math.min(mods.dex, armor.maxDex) : mods.dex) : 0;
    const defense = c.fightingStyle === 'defense' ? 1 : 0;
    candidates.push({ ac: armor.baseAc + dex + shield + defense, source: armor.name + (shield ? ' + Shield' : '') + (defense ? ' + Defense' : '') });
    if (!def.armorTraining.includes(armor.category)) warnings.push(`Not trained in ${armor.category} armor: disadvantage on STR/DEX d20 tests and no spellcasting.`);
    if (armor.strength && scores.str < armor.strength) warnings.push(`${armor.name} needs STR ${armor.strength}: speed −10 ft.`);
  } else {
    candidates.push({ ac: 10 + mods.dex + shield, source: shield ? 'Unarmored + Shield' : 'Unarmored' });
    if (def.id === 'barbarian') candidates.push({ ac: 10 + mods.dex + mods.con + shield, source: 'Unarmored Defense (DEX + CON)' });
    if (def.id === 'monk' && !shield) candidates.push({ ac: 10 + mods.dex + mods.wis, source: 'Unarmored Defense (DEX + WIS)' });
    if (c.subclassId === 'draconic-sorcery' && level >= 3) candidates.push({ ac: 10 + mods.dex + mods.cha + shield, source: 'Draconic Resilience (DEX + CHA)' });
  }
  if (shield && !def.armorTraining.includes('shield')) warnings.push('Not trained with shields.');
  const bestAc = candidates.reduce((a, b) => (b.ac > a.ac ? b : a));

  // Speed
  const subspeciesSpeed = c.subspeciesId
    ? SUBSPECIES[c.subspeciesId]?.traits.map((t) => TRAITS[t.id]?.speed).find((s) => s !== undefined)
    : undefined;
  let speed = subspeciesSpeed ?? species?.speed ?? 30;
  const unarmored = !armor || armor.category === 'shield';
  if (def.id === 'monk' && unarmored && !c.equipment.shield) speed += num(cs.unarmored_movement_bonus);
  if (def.id === 'barbarian' && level >= 5 && armor?.category !== 'heavy') speed += 10;
  if (armor?.strength && scores.str < armor.strength) speed -= 10;
  speed = Math.max(0, speed - 5 * c.state.exhaustion);
  if (c.state.conditions.some((id) => (CONDITIONS[id]?.effects as { speedZero?: boolean }).speedZero)) speed = 0;

  const alert = hasFeat(c, 'alert');
  const initiative = mods.dex + (alert ? pb : jackOfAllTrades ? Math.floor(pb / 2) : 0);
  const darkvision = traits.includes('darkvision-120') ? 120 : traits.includes('darkvision-60') ? 60 : 0;

  // Attacks
  const masteryActive = weaponMasteryCount(def.id, level) > 0;
  const attacks: Attack[] = c.equipment.weapons.flatMap((w, i) => {
    const weapon = WEAPONS[w.weaponId];
    if (!weapon) return [];
    const proficient = isWeaponProficient(def, weapon);
    const monkWeapon = def.id === 'monk' && level >= 1 && (weapon.category === 'simple' || weapon.properties.includes('light')) && !weapon.ranged;
    const finesse = weapon.properties.includes('finesse') || monkWeapon;
    const ability: Ability = finesse ? (mods.dex > mods.str ? 'dex' : 'str') : weapon.ranged ? 'dex' : 'str';
    const archery = c.fightingStyle === 'archery' && weapon.ranged ? 2 : 0;
    const mod = mods[ability];
    const die = monkWeapon && num(cs.martial_arts_die) ? higherDie(weapon.damage, `1d${num(cs.martial_arts_die)}`) : weapon.damage;
    const notes: string[] = [];
    if (def.id === 'barbarian') notes.push(`Rage: +${num(cs.rage_damage_bonus)} damage (STR)`);
    if (def.id === 'rogue' && (weapon.properties.includes('finesse') || weapon.ranged)) {
      const sa = cs.sneak_attack as { dice_count?: number; dice_value?: number } | undefined;
      if (sa?.dice_count) notes.push(`Sneak Attack: ${sa.dice_count}d${sa.dice_value ?? 6}`);
    }
    if (c.fightingStyle === 'great-weapon-fighting' && (weapon.properties.includes('two-handed') || weapon.properties.includes('versatile')) && !weapon.ranged) {
      notes.push('Great Weapon Fighting: treat 1s and 2s on damage dice as 3s');
    }
    return [
      {
        id: `${i}:${weapon.id}`,
        name: w.name || weapon.name,
        ability,
        proficient,
        attackBonus: mod + (proficient ? pb : 0) + archery,
        damage: withMod(die, mod),
        versatileDamage: weapon.versatile ? withMod(weapon.versatile, mod) : undefined,
        damageType: weapon.damageType,
        mastery: masteryActive && c.weaponMasteries.includes(weapon.id) ? weapon.mastery : undefined,
        properties: weapon.properties,
        range: weapon.range ? `${weapon.range[0]}/${weapon.range[1]} ft` : weapon.properties.includes('reach') ? '10 ft' : '5 ft',
        notes,
      },
    ];
  });
  const unarmedDie = def.id === 'monk' ? `1d${num(cs.martial_arts_die) || 6}` : '1';
  const unarmedAbility: Ability = def.id === 'monk' && mods.dex > mods.str ? 'dex' : 'str';
  attacks.push({
    id: 'unarmed',
    name: 'Unarmed Strike',
    ability: unarmedAbility,
    proficient: true,
    attackBonus: mods[unarmedAbility] + pb,
    // Without Martial Arts an Unarmed Strike deals a flat 1 + STR modifier.
    damage: def.id === 'monk' ? withMod(unarmedDie, mods[unarmedAbility]) : String(Math.max(0, 1 + mods.str)),
    damageType: 'bludgeoning',
    properties: [],
    range: '5 ft',
    notes: [],
  });

  // Spellcasting
  const table = def.levels[level - 1]?.spellcasting;
  const spellcasting = def.spellcasting && table
    ? {
        ability: def.spellcasting.ability,
        attackBonus: pb + mods[def.spellcasting.ability],
        saveDc: 8 + pb + mods[def.spellcasting.ability],
        slots: table.slots,
        pact: def.spellcasting.pact,
        cantrips: table.cantrips,
        prepared: table.prepared,
      }
    : undefined;

  // Features
  const features: FeatureEntry[] = [];
  for (const l of def.levels.slice(0, level)) {
    for (const id of l.features) {
      const f = FEATURES[id];
      if (f) features.push({ name: f.name, source: def.name, level: l.level, description: f.description, ref: { kind: 'feature', id: f.id } });
    }
  }
  const subclass = c.subclassId ? SUBCLASSES[c.subclassId] : undefined;
  if (subclass) for (const f of subclass.features) if (f.level <= level) features.push({ name: f.name, source: subclass.name, level: f.level, description: f.description, ref: { kind: 'subclass', id: subclass.id } });
  for (const id of traits) {
    const t = TRAITS[id];
    if (t) features.push({ name: t.name, source: species?.name ?? 'Species', description: t.description, ref: { kind: 'trait', id: t.id } });
  }
  for (const f of featEntries(c)) {
    const feat = FEATS[f.featId];
    if (feat) features.push({ name: feat.name + (f.note ? ` (${f.note})` : ''), source: f.source, description: feat.description, ref: { kind: 'feat', id: feat.id } });
  }

  const armorNames = def.armorTraining.map((a) => (a === 'shield' ? 'Shields' : `${a[0]!.toUpperCase()}${a.slice(1)} armor`));
  const weaponNames = [
    ...def.weaponTraining.categories.map((w) => `${w[0]!.toUpperCase()}${w.slice(1)} weapons`),
    ...def.weaponTraining.weapons.map((w) => WEAPONS[w]?.name ?? w),
  ];

  return {
    scores,
    mods,
    profBonus: pb,
    saves,
    skills,
    passivePerception: 10 + skills.perception.bonus,
    initiative,
    ac: bestAc.ac,
    acSource: bestAc.source,
    speed,
    darkvision,
    hpMax: hpMax(c, scores),
    hitDie: def.hitDie,
    spellcasting,
    attacks,
    resources: [...classResources(def, level, mods), ...speciesResources(traits, level, pb)],
    features,
    proficiencies: {
      armor: armorNames,
      weapons: weaponNames,
      tools: [...new Set([...(def.tools ?? []), ...(background?.tools ?? []), ...c.tools])],
      languages: ['Common', ...c.languages],
    },
    warnings,
  };
}

function withMod(dice: string, mod: number): string {
  return mod === 0 ? dice : `${dice} ${formatModifier(mod)}`;
}

/** The bigger of two single-die expressions ("1d6" vs "1d8"), for Martial Arts. */
function higherDie(a: string, b: string): string {
  const sides = (x: string) => Number(/d(\d+)/.exec(x)?.[1] ?? 0);
  return sides(b) > sides(a) ? b : a;
}

// ---------- rolls ----------

export type D20TestKind = 'attack' | 'check' | 'save';

export interface D20Test {
  expr: string;
  mode: D20Mode;
  notes: string[];
  autoFail: boolean;
}

/**
 * Builds a d20 test with conditions and exhaustion applied: advantage and disadvantage cancel out,
 * exhaustion subtracts 2 per level, and some conditions make STR/DEX saves fail automatically.
 */
export function d20Test(c: Character, kind: D20TestKind, bonus: number, ability?: Ability, requested: D20Mode = 'normal'): D20Test {
  const notes: string[] = [];
  let adv = requested === 'advantage';
  let dis = requested === 'disadvantage';
  let autoFail = false;
  for (const id of c.state.conditions) {
    const cond = CONDITIONS[id];
    if (!cond) continue;
    const e = cond.effects as { attackDisadvantage?: boolean; checkDisadvantage?: boolean; saveDisadvantage?: Ability[]; saveAutoFail?: Ability[] };
    if ((kind === 'attack' && e.attackDisadvantage) || (kind === 'check' && e.checkDisadvantage) || (kind === 'save' && ability && e.saveDisadvantage?.includes(ability))) {
      dis = true;
      notes.push(`${cond.name}: disadvantage`);
    }
    if (kind === 'save' && ability && e.saveAutoFail?.includes(ability)) {
      autoFail = true;
      notes.push(`${cond.name}: automatic failure`);
    }
  }
  const exhaustion = 2 * c.state.exhaustion;
  if (exhaustion) notes.push(`Exhaustion ${c.state.exhaustion}: −${exhaustion}`);
  const mode: D20Mode = adv && !dis ? 'advantage' : dis && !adv ? 'disadvantage' : 'normal';
  const die = mode === 'advantage' ? '2d20kh1' : mode === 'disadvantage' ? '2d20kl1' : '1d20';
  const total = bonus - exhaustion;
  return { expr: total === 0 ? die : `${die} ${formatModifier(total)}`, mode, notes, autoFail };
}

/** Doubles the dice of a damage expression for a critical hit ("1d8 + 3" → "2d8 + 3"). */
export function criticalDamage(expr: string): string {
  return expr.replace(/(\d*)d(\d+)/g, (_, n, s) => `${(Number(n) || 1) * 2}d${s}`);
}

// ---------- rests & state ----------

export function emptyState(c: Pick<Character, 'classId' | 'level'> & Partial<Character>, hp: number): CharacterState {
  return {
    hp,
    tempHp: 0,
    deathSaves: { successes: 0, failures: 0 },
    hitDiceSpent: 0,
    slotsUsed: Array(9).fill(0),
    resourcesUsed: {},
    conditions: [],
    exhaustion: 0,
    heroicInspiration: false,
  };
}

/** Short Rest: spend Hit Dice (healing is rolled separately), recharge short-rest resources and Pact Magic. */
export function shortRest(c: Character, derived: DerivedCharacter, hitDiceSpent: number, healing: number): CharacterState {
  const s = c.state;
  const resourcesUsed: Record<string, number> = { ...s.resourcesUsed };
  for (const r of derived.resources) {
    const used = resourcesUsed[r.id] ?? 0;
    if (r.recharge === 'short') resourcesUsed[r.id] = 0;
    else if (r.shortRestRegain) resourcesUsed[r.id] = Math.max(0, used - r.shortRestRegain);
  }
  return {
    ...s,
    hp: Math.min(derived.hpMax, s.hp + Math.max(0, healing)),
    hitDiceSpent: Math.min(c.level, s.hitDiceSpent + hitDiceSpent),
    slotsUsed: derived.spellcasting?.pact ? Array(9).fill(0) : s.slotsUsed,
    resourcesUsed,
  };
}

/** Long Rest (2024): full HP, all Hit Dice, all slots and resources, −1 Exhaustion, death saves reset. */
export function longRest(c: Character, derived: DerivedCharacter): CharacterState {
  const traits = speciesTraitIds(c);
  return {
    ...c.state,
    hp: derived.hpMax,
    tempHp: 0,
    deathSaves: { successes: 0, failures: 0 },
    hitDiceSpent: 0,
    slotsUsed: Array(9).fill(0),
    resourcesUsed: {},
    exhaustion: Math.max(0, c.state.exhaustion - 1),
    heroicInspiration: traits.includes('resourceful') ? true : c.state.heroicInspiration,
  };
}

/** Applies damage (temp HP first) or healing, and resets death saves when healed above 0. */
export function applyHpChange(state: CharacterState, hpMaxValue: number, amount: number): CharacterState {
  if (amount === 0) return state;
  if (amount > 0) {
    const hp = Math.min(hpMaxValue, state.hp + amount);
    return { ...state, hp, deathSaves: hp > 0 ? { successes: 0, failures: 0 } : state.deathSaves };
  }
  let damage = -amount;
  const fromTemp = Math.min(state.tempHp, damage);
  damage -= fromTemp;
  return { ...state, tempHp: state.tempHp - fromTemp, hp: Math.max(0, state.hp - damage) };
}
