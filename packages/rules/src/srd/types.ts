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
}
