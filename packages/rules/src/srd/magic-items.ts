// SRD 5.2 magic items: a separate entry point (@dnd/rules/magic-items) so clients load them lazily.
import magicItemsJson from './data/magic-items.json';
import type { MagicItemDef } from './types';

export const MAGIC_ITEMS: MagicItemDef[] = magicItemsJson as MagicItemDef[];
export const MAGIC_ITEMS_BY_ID: Record<string, MagicItemDef> = Object.fromEntries(MAGIC_ITEMS.map((m) => [m.id, m]));
