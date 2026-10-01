import type { MonsterDef } from '@dnd/rules';
import { useEffect, useState } from 'react';

let loading: Promise<Record<string, MonsterDef>> | undefined;

/** The SRD bestiary, fetched on first use (it's a separate ~550 KB chunk). Null while loading. */
export function useMonsters(enabled = true): Record<string, MonsterDef> | null {
  const [monsters, setMonsters] = useState<Record<string, MonsterDef> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loading ??= import('@dnd/rules/monsters').then((m) => m.MONSTERS_BY_ID);
    void loading.then((m) => alive && setMonsters(m));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return monsters;
}
