// Shapes of the generated SRD data in ./data (see scripts/import-srd.mjs).
import type { Ability, DamageType, Skill } from './core';

export type ArmorTraining = 'light' | 'medium' | 'heavy' | 'shield';

/** "Choose A or B" starting equipment; item ids refer to weapons, armor or gear. */
export interface EquipmentChoice {
  desc: string;
  options: { label: string; items: { id: string; name: string; count: number }[]; gold: number }[];
}

export interface ClassLevel {
  level: number;
  profBonus: number;
  features: string[];
  /** Class table columns, e.g. rage_count, sneak_attack ({dice_count, dice_value}), martial_arts_die. */
  classSpecific?: Record<string, unknown>;
  spellcasting?: { cantrips: number; prepared: number; slots: number[] };
}

export interface ClassDef {
  id: string;
  name: string;
  hitDie: number;
  primaryAbilities: Ability[];
  /** True when the primary ability is a choice (Fighter: STR or DEX). */
  primaryAbilityChoice?: boolean;
  savingThrows: Ability[];
  skillChoice?: { choose: number; from: Skill[] | 'any' };
  otherProficiencyChoices?: string[];
  armorTraining: ArmorTraining[];
  weaponTraining: { categories: WeaponCategory[]; weapons: string[] };
  tools?: string[];
  spellcasting?: { ability: Ability; pact: boolean };
  startingEquipment: EquipmentChoice[];
  subclasses: string[];
  multiclassPrerequisites?: { ability: Ability; minimum: number }[];
  levels: ClassLevel[];
}

export interface FeatureDef {
  id: string;
  classId: string;
  level: number;
  name: string;
  description: string;
}

export interface SubclassDef {
  id: string;
  classId: string;
  name: string;
  summary: string;
  description: string;
  features: { level: number; name: string; description: string }[];
}

export interface SpeciesDef {
  id: string;
  name: string;
  sizes: string[];
  speed: number;
  traits: string[];
  subspecies?: string[];
}

export interface SubspeciesDef {
  id: string;
  speciesId: string;
  name: string;
  damageType?: DamageType;
  traits: { id: string; level?: number }[];
}

export interface TraitDef {
  id: string;
  name: string;
  description: string;
  speed?: number;
  skillChoice?: { choose: number; from: Skill[] };
  spells?: string[];
}

export interface BackgroundDef {
  id: string;
  name: string;
  abilities: Ability[];
  feat: { id: string; note?: string };
  skills: Skill[];
  tools?: string[];
  toolChoice?: string;
  equipment: EquipmentChoice[];
}

export type FeatType = 'origin' | 'general' | 'fighting-style' | 'epic-boon';

export interface FeatDef {
  id: string;
  name: string;
  type: FeatType;
  description: string;
  repeatable?: boolean;
  minLevel?: number;
  prerequisite?: string;
}

export type WeaponCategory = 'simple' | 'martial';
export type Mastery = 'cleave' | 'graze' | 'nick' | 'push' | 'sap' | 'slow' | 'topple' | 'vex';

export interface WeaponDef {
  id: string;
  name: string;
  category: WeaponCategory;
  ranged: boolean;
  damage: string;
  damageType: DamageType;
  properties: string[];
  versatile?: string;
  range?: [number, number];
  mastery: Mastery;
  weight?: number;
  cost?: string;
}

export interface ArmorDef {
  id: string;
  name: string;
  category: 'light' | 'medium' | 'heavy' | 'shield';
  baseAc: number;
  dexBonus: boolean;
  maxDex?: number;
  strength?: number;
  stealthDisadvantage?: boolean;
  weight?: number;
  cost?: string;
}

export interface GearDef {
  id: string;
  name: string;
  category?: string;
  weight?: number;
  cost?: string;
  description?: string;
}

export interface SpellDef {
  id: string;
  name: string;
  level: number;
  school: string;
  classes: string[];
  castingTime: string;
  ritual?: boolean;
  range: string;
  components: string[];
  material?: string;
  duration: string;
  concentration?: boolean;
  attack?: 'melee' | 'ranged';
  damageType?: DamageType;
  damageAtSlot?: Record<string, string>;
  damageAtCharacterLevel?: Record<string, string>;
  description: string;
  higherLevel?: string;
}

export interface RulesText {
  conditions: Record<string, { name: string; description: string }>;
  masteries: Record<string, { name: string; description: string }>;
  weaponProperties: Record<string, { name: string; description: string }>;
  skills: Record<string, { name: string; ability: Ability; description: string }>;
  damageTypes: Record<string, { name: string; description: string }>;
  schools: Record<string, { name: string; description: string }>;
  alignments: Record<string, { name: string; abbreviation: string; description: string }>;
  languages: Record<string, { name: string; rare?: boolean; note?: string }>;
  poisons: Record<string, { name: string; type: string; cost: number; description: string }>;
  /** SRD 5.2.1 Rules Glossary, without the conditions (those are in `conditions`). */
  glossary: GlossaryEntry[];
}

export interface GlossaryEntry {
  id: string;
  name: string;
  /** "Action", "Area of Effect", "Attitude" or "Hazard". */
  tag?: string;
  description: string;
}

export interface MagicItemDef {
  id: string;
  name: string;
  category?: string;
  /** Item type line, e.g. "Wondrous Item" or "Armor (Any Medium or Heavy, Except Hide Armor)". */
  type: string;
  rarity?: string;
  attunement?: boolean;
  /** Who can attune, e.g. "Paladin" or "Spellcaster". */
  limitedTo?: string;
  /** A +1/+2/+3 version of a base item. */
  variant?: boolean;
  variants?: string[];
  description: string;
}

export interface MonsterDamage {
  /** Average damage as printed in the stat block. */
  average: number;
  /** Roll expression, e.g. "2d6 + 3", or a flat number ("1"). */
  dice: string;
  type: DamageType;
}

export interface MonsterAttack {
  kind: 'melee' | 'ranged' | 'melee or ranged';
  bonus: number;
  reach?: string;
  range?: string;
  /** Damage on a hit (several entries for "… plus 7 (2d6) Fire damage"). */
  damage: MonsterDamage[];
  /** Conditional damage, e.g. "if the attack roll had Advantage", or "instead if the swarm is Bloodied". */
  riders?: (MonsterDamage & { note: string })[];
}

export interface MonsterSave {
  ability: Ability;
  dc: number;
  /** Damage on a failed save. */
  damage?: MonsterDamage[];
  /** Half damage on a success. */
  half?: boolean;
}

export interface MonsterAction {
  name: string;
  description: string;
  /** "Recharge 5–6", "3/Day", … */
  usage?: string;
  attack?: MonsterAttack;
  save?: MonsterSave;
  /** SRD spell ids, for spellcasting entries. */
  spells?: string[];
}

export type MonsterSize = 'Tiny' | 'Small' | 'Medium' | 'Large' | 'Huge' | 'Gargantuan' | 'Medium or Small';

export interface MonsterDef {
  id: string;
  name: string;
  size: MonsterSize;
  type: string;
  alignment: string;
  ac: number;
  /** Armor worn, if the stat block names it. */
  acNote?: string;
  /** Average hit points. */
  hp: number;
  hpFormula: string;
  /** Speeds in feet: walk, fly, swim, climb, burrow. */
  speed: Record<string, number>;
  hover?: boolean;
  scores: Record<Ability, number>;
  /** Saving throw bonuses that differ from the plain modifier (proficient saves). */
  saves: Partial<Record<Ability, number>>;
  skills: Partial<Record<Skill, number>>;
  vulnerabilities: string[];
  resistances: string[];
  immunities: string[];
  conditionImmunities: string[];
  /** e.g. { darkvision: "60 ft." } */
  senses: Record<string, string>;
  passivePerception: number;
  languages: string;
  /** Challenge rating: 0.125, 0.25, 0.5, 1, 2, … */
  cr: number;
  xp: number;
  xpInLair?: number;
  profBonus: number;
  gear?: string;
  traits: MonsterAction[];
  actions: MonsterAction[];
  bonusActions: MonsterAction[];
  reactions: MonsterAction[];
  legendaryActions: MonsterAction[];
}
