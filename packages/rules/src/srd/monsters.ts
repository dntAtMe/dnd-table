// SRD 5.2 monsters: a separate entry point (@dnd/rules/monsters) so clients load them lazily.
// (Cast via unknown: TypeScript infers optional speeds in the JSON as possibly undefined.)
import monstersJson from './data/monsters.json';
import type { MonsterDef } from './types';

export const MONSTERS: MonsterDef[] = monstersJson as unknown as MonsterDef[];
export const MONSTERS_BY_ID: Record<string, MonsterDef> = Object.fromEntries(MONSTERS.map((m) => [m.id, m]));
