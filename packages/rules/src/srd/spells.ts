import spellsJson from './data/spells.json';
import type { SpellDef } from './types';

export const SPELLS: SpellDef[] = spellsJson as SpellDef[];
export const SPELLS_BY_ID: Record<string, SpellDef> = Object.fromEntries(SPELLS.map((s) => [s.id, s]));
