// Core 5e (2024) vocabulary: abilities, skills and conditions. From SRD 5.2 (CC-BY-4.0).

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];

export const ABILITY_NAMES: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

export const SKILLS = {
  acrobatics: { name: 'Acrobatics', ability: 'dex' },
  animalHandling: { name: 'Animal Handling', ability: 'wis' },
  arcana: { name: 'Arcana', ability: 'int' },
  athletics: { name: 'Athletics', ability: 'str' },
  deception: { name: 'Deception', ability: 'cha' },
  history: { name: 'History', ability: 'int' },
  insight: { name: 'Insight', ability: 'wis' },
  intimidation: { name: 'Intimidation', ability: 'cha' },
  investigation: { name: 'Investigation', ability: 'int' },
  medicine: { name: 'Medicine', ability: 'wis' },
  nature: { name: 'Nature', ability: 'int' },
  perception: { name: 'Perception', ability: 'wis' },
  performance: { name: 'Performance', ability: 'cha' },
  persuasion: { name: 'Persuasion', ability: 'cha' },
  religion: { name: 'Religion', ability: 'int' },
  sleightOfHand: { name: 'Sleight of Hand', ability: 'dex' },
  stealth: { name: 'Stealth', ability: 'dex' },
  survival: { name: 'Survival', ability: 'wis' },
} as const satisfies Record<string, { name: string; ability: Ability }>;
export type Skill = keyof typeof SKILLS;
export const SKILL_IDS = Object.keys(SKILLS) as Skill[];

/** What a condition does to the character's own d20 tests, where the sheet can apply it automatically. */
export interface ConditionEffects {
  attackDisadvantage?: boolean;
  checkDisadvantage?: boolean;
  /** Saving throws with these abilities have disadvantage. */
  saveDisadvantage?: Ability[];
  /** Saving throws with these abilities fail automatically. */
  saveAutoFail?: Ability[];
  speedZero?: boolean;
}

export interface Condition {
  name: string;
  summary: string;
  effects: ConditionEffects;
}

export const CONDITIONS = {
  blinded: {
    name: 'Blinded',
    summary: "Can't see; attacks against you have advantage, your attacks have disadvantage.",
    effects: { attackDisadvantage: true },
  },
  charmed: {
    name: 'Charmed',
    summary: "Can't attack the charmer; the charmer has advantage on social checks against you.",
    effects: {},
  },
  deafened: { name: 'Deafened', summary: "Can't hear.", effects: {} },
  frightened: {
    name: 'Frightened',
    summary: "Disadvantage on ability checks and attacks while the source is in sight; can't move closer to it.",
    effects: { attackDisadvantage: true, checkDisadvantage: true },
  },
  grappled: {
    name: 'Grappled',
    summary: 'Speed 0; disadvantage on attacks against anyone other than the grappler.',
    effects: { speedZero: true },
  },
  incapacitated: {
    name: 'Incapacitated',
    summary: "No actions, bonus actions or reactions; concentration breaks; can't speak.",
    effects: {},
  },
  invisible: {
    name: 'Invisible',
    summary: 'Attacks against you have disadvantage, your attacks have advantage.',
    effects: {},
  },
  paralyzed: {
    name: 'Paralyzed',
    summary: 'Incapacitated, speed 0; fail STR and DEX saves; hits from within 5 ft are critical.',
    effects: { speedZero: true, saveAutoFail: ['str', 'dex'] },
  },
  petrified: {
    name: 'Petrified',
    summary: 'Turned to stone: incapacitated, speed 0, resistance to all damage; fail STR and DEX saves.',
    effects: { speedZero: true, saveAutoFail: ['str', 'dex'] },
  },
  poisoned: {
    name: 'Poisoned',
    summary: 'Disadvantage on attack rolls and ability checks.',
    effects: { attackDisadvantage: true, checkDisadvantage: true },
  },
  prone: {
    name: 'Prone',
    summary: 'Crawl or spend half your speed to stand; your attacks have disadvantage.',
    effects: { attackDisadvantage: true },
  },
  restrained: {
    name: 'Restrained',
    summary: 'Speed 0; your attacks and DEX saves have disadvantage.',
    effects: { speedZero: true, attackDisadvantage: true, saveDisadvantage: ['dex'] },
  },
  stunned: {
    name: 'Stunned',
    summary: 'Incapacitated; fail STR and DEX saves; attacks against you have advantage.',
    effects: { saveAutoFail: ['str', 'dex'] },
  },
  unconscious: {
    name: 'Unconscious',
    summary: 'Incapacitated and prone; fail STR and DEX saves; hits from within 5 ft are critical.',
    effects: { speedZero: true, saveAutoFail: ['str', 'dex'] },
  },
} as const satisfies Record<string, Condition>;
export type ConditionId = keyof typeof CONDITIONS;
export const CONDITION_IDS = Object.keys(CONDITIONS) as ConditionId[];

/** Exhaustion (2024): each level gives −2 to d20 tests and −5 ft speed; level 6 is death. */
export const MAX_EXHAUSTION = 6;

export const DAMAGE_TYPES = [
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];
