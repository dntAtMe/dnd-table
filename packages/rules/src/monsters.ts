// Stat-block maths for SRD monsters. The monster data itself is in @dnd/rules/monsters (loaded lazily).
import { abilityMod } from './character';
import { SKILLS, type Ability, type MonsterDamage, type MonsterDef, type MonsterSize, type Skill } from './srd';
import type { TokenSenses } from './vision';

/** Saving throw bonus: the listed bonus for proficient saves, otherwise the ability modifier. */
export function monsterSave(m: Pick<MonsterDef, 'saves' | 'scores'>, ability: Ability): number {
  return m.saves[ability] ?? abilityMod(m.scores[ability]);
}

/** Skill bonus: the listed bonus, otherwise the ability modifier. */
export function monsterSkill(m: Pick<MonsterDef, 'skills' | 'scores'>, skill: Skill): number {
  return m.skills[skill] ?? abilityMod(m.scores[SKILLS[skill].ability]);
}

/**
 * Initiative bonus. SRD 5.2 stat blocks print an Initiative value that can include proficiency,
 * but the source data doesn't carry it, so this is the DEX modifier.
 */
export function monsterInitiative(m: Pick<MonsterDef, 'scores'>): number {
  return abilityMod(m.scores.dex);
}

/** Token side length in grid cells for a creature size. */
export const SIZE_CELLS: Record<MonsterSize, number> = {
  Tiny: 1,
  Small: 1,
  Medium: 1,
  'Medium or Small': 1,
  Large: 2,
  Huge: 3,
  Gargantuan: 4,
};

const CR_FRACTIONS: Record<number, string> = { 0.125: '1/8', 0.25: '1/4', 0.5: '1/2' };

export function formatCr(cr: number): string {
  return CR_FRACTIONS[cr] ?? String(cr);
}

/** One roll expression for all of an attack's damage, e.g. "1d10 + 8 + 2d4". */
export function damageExpression(damage: readonly MonsterDamage[]): string {
  return damage.map((d) => d.dice).join(' + ');
}

/** "13 (1d10 + 8) Slashing plus 5 (2d4) Fire" */
export function describeDamage(damage: readonly MonsterDamage[]): string {
  return damage
    .map((d) => `${d.average}${d.dice === String(d.average) ? '' : ` (${d.dice})`} ${d.type[0]!.toUpperCase()}${d.type.slice(1)}`)
    .join(' plus ');
}

const capWord = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "30 ft., Climb 40 ft., Fly 80 ft. (hover)" */
export function monsterSpeedText(m: Pick<MonsterDef, 'speed' | 'hover'>): string {
  return Object.entries(m.speed)
    .map(([k, v]) => (k === 'walk' ? `${v} ft.` : `${capWord(k)} ${v} ft.${k === 'fly' && m.hover ? ' (hover)' : ''}`))
    .join(', ');
}

/** "Darkvision 60 ft., Passive Perception 9" */
export function monsterSensesText(m: Pick<MonsterDef, 'senses' | 'passivePerception'>): string {
  return [...Object.entries(m.senses).map(([k, v]) => `${capWord(k)} ${v}`), `Passive Perception ${m.passivePerception}`].join(', ');
}

/**
 * A monster's darkvision, blindsight and truesight in feet, for its token's vision ("60 ft.",
 * "30 ft. (blind beyond this radius)"). Tremorsense doesn't see, so it's left out.
 */
export function monsterSenses(m: Pick<MonsterDef, 'senses'>): TokenSenses {
  const out: TokenSenses = {};
  for (const sense of ['darkvision', 'blindsight', 'truesight'] as const) {
    const feet = Number(/^(\d+)/.exec(m.senses[sense] ?? '')?.[1]);
    if (feet > 0) out[sense] = feet;
  }
  return out;
}

/** "1/4 (XP 50; PB +2)", "17 (XP 18,000, or 20,000 in lair; PB +6)" */
export function monsterCrText(m: Pick<MonsterDef, 'cr' | 'xp' | 'xpInLair' | 'profBonus'>): string {
  const lair = m.xpInLair ? `, or ${m.xpInLair.toLocaleString('en-US')} in lair` : '';
  return `${formatCr(m.cr)} (XP ${m.xp.toLocaleString('en-US')}${lair}; PB +${m.profBonus})`;
}
