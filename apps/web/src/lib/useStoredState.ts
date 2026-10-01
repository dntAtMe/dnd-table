import { useCallback, useState } from 'react';

/**
 * State remembered in this browser (e.g. which sidebar tab was open). Falls back to the default
 * when storage is unavailable or holds a value that's no longer allowed.
 */
export function useStoredState<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(`dnd-table.${key}`) as T | null;
      return stored && allowed.includes(stored) ? stored : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(`dnd-table.${key}`, next);
      } catch {
        // Not remembered; still works for this visit.
      }
    },
    [key],
  );
  return [value, set];
}
