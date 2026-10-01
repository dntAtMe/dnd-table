// Stat-block maths for SRD monsters. The monster data itself is in @dnd/rules/monsters (loaded lazily).
import { abilityMod } from './character';
import { SKILLS, type Ability, type MonsterDamage, type MonsterDef, type MonsterSize, type Skill } from './srd';

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
