import type { Compendium } from '@dnd/rules';

/** The SRD monster a token is named after ("Goblin Warrior 2" → goblin-warrior). */
export function monsterIdForName(compendium: Compendium, name: string): string | undefined {
  const entry = compendium.byName(name.replace(/\s*#?\d+$/, '').trim(), 'monster');
  return entry?.kind === 'monster' ? entry.id : undefined;
}
