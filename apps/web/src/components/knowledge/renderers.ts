// Extension point for entry cards: a feature (e.g. campaign wiki pages) registers how the body of
// its entries renders in popups and the Compendium view. Built-in SRD kinds have their own bodies
// in EntryBodies.tsx; a registered renderer takes precedence over them.
import type { EntryKind, IndexEntry } from '@dnd/rules';
import { useSyncExternalStore, type ComponentType } from 'react';

export interface EntryRendererProps {
  entry: IndexEntry;
  /** 'popup' for hover/pinned popups (compact), 'full' for the Compendium view. */
  size: 'popup' | 'full';
}

export type EntryRenderer = ComponentType<EntryRendererProps>;

const renderers = new Map<EntryKind, EntryRenderer>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * Renders the body of every entry of `kind` with `Component` (the card header with name, kind and
 * summary, and the popup chrome, stay). Returns a function that removes the registration. Call it
 * at module load or in an effect; cards re-render when registrations change.
 */
export function registerEntryRenderer(kind: EntryKind, Component: EntryRenderer): () => void {
  renderers.set(kind, Component);
  version++;
  listeners.forEach((l) => l());
  return () => {
    if (renderers.get(kind) !== Component) return;
    renderers.delete(kind);
    version++;
    listeners.forEach((l) => l());
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The registered renderer for a kind, if any (re-renders when registrations change). */
export function useEntryRenderer(kind: EntryKind): EntryRenderer | undefined {
  useSyncExternalStore(subscribe, () => version);
  return renderers.get(kind);
}
