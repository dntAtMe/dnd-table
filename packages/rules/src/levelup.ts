// What a character needs to decide when gaining a level, and applying those decisions.
import {
  computeCharacter,
  expertiseCount,
  featLevels,
  hasFightingStyle,
  subclassLevel,
  weaponMasteryCount,
  type AbilityScores,
  type Character,
} from './character';
import { ABILITIES, ABILITY_NAMES, CLASSES, FEATS, FEATURES, SUBCLASSES, type Ability, type FeatDef, type Skill } from './srd';

export interface LevelUpPlan {
  level: number;
  hitDie: number;
  hpAverage: number;
  /** Class and subclass features gained at this level. */
  features: { name: string; source: string; description: string; ref?: { kind: 'feature' | 'subclass'; id: string } }[];
  needsSubclass: boolean;
  subclassOptions: string[];
  /** 'asi' levels allow ASI or a general feat; 'boon' levels an Epic Boon. */
  featChoice: 'asi' | 'boon' | null;
  newExpertise: number;
  newMasteries: number;
  needsFightingStyle: boolean;
  spellcasting?: { cantrips: [number, number]; prepared: [number, number]; slots: number[] };
}

export interface LevelUpChoices {
  /** null = take the average. */
  hpRoll: number | null;
  subclassId: string | null;
  featId: string | null;
  increases: Partial<AbilityScores>;
  expertise: Skill[];
  weaponMasteries: string[];
  fightingStyle: string | null;
}

/** Abilities a feat's "Ability Score Increase" can raise, read from its text. */
export function featAbilityOptions(feat: FeatDef): Ability[] {
  if (feat.id === 'ability-score-improvement') return [...ABILITIES];
  const match = /Ability Score Increase\.\*\*\s*([^\n]*)/.exec(feat.description);
  if (!match) return [];
  const text = match[1]!;
  if (/of your choice/i.test(text)) return [...ABILITIES];
  return ABILITIES.filter((a) => new RegExp(`\\b${ABILITY_NAMES[a]}\\b`).test(text));
}

export function featsForLevel(kind: 'asi' | 'boon', level: number, taken: string[]): FeatDef[] {
  return Object.values(FEATS).filter(
    (f) =>
      (kind === 'boon' ? f.type === 'epic-boon' : f.type === 'general') &&
      (f.minLevel ?? 1) <= level &&
      (f.repeatable || !taken.includes(f.id)),
  );
}

export function levelUpPlan(c: Character): LevelUpPlan | null {
  const cls = CLASSES[c.classId];
  if (!cls || c.level >= 20) return null;
  const level = c.level + 1;
  const row = cls.levels[level - 1]!;
  const prev = cls.levels[level - 2]!;
  const subclassId = c.subclassId;
  const features = row.features
    .map((id) => FEATURES[id])
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .map((f): LevelUpPlan['features'][number] => ({ name: f.name, source: cls.name, description: f.description, ref: { kind: 'feature', id: f.id } }));
  if (subclassId) {
    for (const f of SUBCLASSES[subclassId]?.features ?? []) {
      if (f.level === level) features.push({ name: f.name, source: SUBCLASSES[subclassId]!.name, description: f.description, ref: { kind: 'subclass', id: subclassId } });
    }
  }
  const featChoice = featLevels(c.classId).find((f) => f.level === level)?.kind ?? null;
  return {
    level,
    hitDie: cls.hitDie,
    hpAverage: cls.hitDie / 2 + 1,
    features,
    needsSubclass: level === subclassLevel(c.classId) && !subclassId,
    subclassOptions: cls.subclasses,
    featChoice,
    newExpertise: expertiseCount(c.classId, level) - expertiseCount(c.classId, c.level),
    newMasteries: weaponMasteryCount(c.classId, level) - weaponMasteryCount(c.classId, c.level),
    needsFightingStyle: hasFightingStyle(c.classId, level) && !hasFightingStyle(c.classId, c.level),
    spellcasting:
      row.spellcasting && prev.spellcasting
        ? {
            cantrips: [prev.spellcasting.cantrips, row.spellcasting.cantrips],
            prepared: [prev.spellcasting.prepared, row.spellcasting.prepared],
            slots: row.spellcasting.slots,
          }
        : undefined,
  };
}

export function levelUpIssues(c: Character, plan: LevelUpPlan, ch: LevelUpChoices): string[] {
  const issues: string[] = [];
  if (ch.hpRoll !== null && (ch.hpRoll < 1 || ch.hpRoll > plan.hitDie)) issues.push(`HP roll must be 1–${plan.hitDie}`);
  if (plan.needsSubclass && !SUBCLASSES[ch.subclassId ?? '']) issues.push('Choose a subclass');
  if (plan.featChoice) {
    const feat = FEATS[ch.featId ?? ''];
    if (!feat) issues.push(plan.featChoice === 'boon' ? 'Choose an Epic Boon' : 'Choose Ability Score Improvement or a feat');
    else {
      const allowed = featAbilityOptions(feat);
      const entries = Object.entries(ch.increases).filter(([, v]) => v) as [Ability, number][];
      const total = entries.reduce((n, [, v]) => n + v, 0);
      const expected = feat.id === 'ability-score-improvement' ? 2 : allowed.length ? 1 : 0;
      if (total !== expected || entries.some(([a, v]) => !allowed.includes(a) || v > (feat.id === 'ability-score-improvement' ? 2 : 1))) {
        issues.push(expected === 2 ? 'Assign +2 to one ability or +1 to two' : expected === 1 ? 'Choose which ability to increase' : 'This feat has no ability increase');
      }
    }
  }
  if (ch.expertise.length !== plan.newExpertise) issues.push(`Choose ${plan.newExpertise} Expertise skills`);
  if (ch.weaponMasteries.length !== plan.newMasteries) issues.push(`Choose ${plan.newMasteries} more Weapon Masteries`);
  if (plan.needsFightingStyle && FEATS[ch.fightingStyle ?? '']?.type !== 'fighting-style') issues.push('Choose a Fighting Style');
  return issues;
}

export function applyLevelUp(c: Character, plan: LevelUpPlan, ch: LevelUpChoices): Character {
  const before = computeCharacter(c).hpMax;
  const next: Character = {
    ...c,
    level: plan.level,
    hpRolls: [...c.hpRolls.slice(0, plan.level - 2), ch.hpRoll],
    subclassId: plan.needsSubclass ? ch.subclassId : c.subclassId,
    advancements: plan.featChoice && ch.featId ? [...c.advancements, { level: plan.level, featId: ch.featId, increases: ch.increases }] : c.advancements,
    expertise: [...c.expertise, ...ch.expertise],
    weaponMasteries: [...c.weaponMasteries, ...ch.weaponMasteries],
    fightingStyle: plan.needsFightingStyle ? ch.fightingStyle : c.fightingStyle,
  };
  const after = computeCharacter(next).hpMax;
  // Gaining a level raises current HP by the same amount as the maximum.
  return { ...next, state: { ...next.state, hp: Math.max(0, Math.min(after, c.state.hp + after - before)) } };
}
