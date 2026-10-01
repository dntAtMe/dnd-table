// Back/forward history for the Compendium view (pure functions plus a small hook).
import { refKey, type EntryRef } from '@dnd/rules';
import { useCallback, useMemo, useState } from 'react';

export interface EntryHistory {
  entries: readonly EntryRef[];
  /** Index of the current entry, -1 when nothing is selected. */
  index: number;
}

export const EMPTY_HISTORY: EntryHistory = { entries: [], index: -1 };
const MAX_HISTORY = 100;

/** Visits an entry: drops anything ahead of the current one (like a browser), ignores repeats. */
export function visit(h: EntryHistory, ref: EntryRef): EntryHistory {
  const cur = h.entries[h.index];
  if (cur && refKey(cur) === refKey(ref)) return h;
  const entries = [...h.entries.slice(0, h.index + 1), ref].slice(-MAX_HISTORY);
  return { entries, index: entries.length - 1 };
}

export const back = (h: EntryHistory): EntryHistory => (h.index > 0 ? { ...h, index: h.index - 1 } : h);
export const forward = (h: EntryHistory): EntryHistory => (h.index < h.entries.length - 1 ? { ...h, index: h.index + 1 } : h);

export interface EntryHistoryApi {
  current: EntryRef | null;
  canBack: boolean;
  canForward: boolean;
  go: (ref: EntryRef) => void;
  back: () => void;
  forward: () => void;
}

export function useEntryHistory(): EntryHistoryApi {
  const [h, setH] = useState<EntryHistory>(EMPTY_HISTORY);
  const go = useCallback((ref: EntryRef) => setH((prev) => visit(prev, ref)), []);
  const goBack = useCallback(() => setH(back), []);
  const goForward = useCallback(() => setH(forward), []);
  return useMemo(
    () => ({
      current: h.entries[h.index] ?? null,
      canBack: h.index > 0,
      canForward: h.index < h.entries.length - 1,
      go,
      back: goBack,
      forward: goForward,
    }),
    [h, go, goBack, goForward],
  );
}
