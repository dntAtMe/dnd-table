import type { CharacterRecord, ClientMessage, Visibility } from '@dnd/protocol';
import {
  computeCharacter,
  criticalDamage,
  d20Test,
  type Ability,
  type Character,
  type CharacterState,
  type D20Mode,
  type D20TestKind,
  type DerivedCharacter,
} from '@dnd/rules';
import { useCallback, useMemo, useRef, useState } from 'react';

type Send = (msg: ClientMessage) => void;

export interface CharacterActions {
  data: Character;
  derived: DerivedCharacter;
  canEdit: boolean;
  /** Advantage mode for the next d20 roll; resets after rolling. */
  mode: D20Mode;
  setMode: (mode: D20Mode) => void;
  visibility: Visibility;
  setVisibility: (v: Visibility) => void;
  rollD20: (kind: D20TestKind, label: string, bonus: number, ability?: Ability) => void;
  rollDamage: (label: string, expr: string, crit?: boolean) => void;
  roll: (label: string, expr: string) => void;
  patchState: (patch: Partial<CharacterState>) => void;
  update: (fn: (c: Character) => Character) => void;
  /** Transient message to show (e.g. an automatic save failure). */
  notice?: string;
}

export function useCharacter(record: CharacterRecord, canEdit: boolean, send: Send): CharacterActions {
  const data = record.data;
  const derived = useMemo(() => computeCharacter(data), [data]);
  const [mode, setMode] = useState<D20Mode>('normal');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [notice, setNotice] = useState<string>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash = (text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(undefined), 3500);
  };

  const roll = useCallback(
    (label: string, expr: string) => send({ type: 'roll', expr, label: `${data.name}: ${label}`.slice(0, 80), visibility }),
    [send, data.name, visibility],
  );

  const rollD20 = useCallback(
    (kind: D20TestKind, label: string, bonus: number, ability?: Ability) => {
      const test = d20Test(data, kind, bonus, ability, mode);
      setMode('normal');
      if (test.autoFail) {
        send({ type: 'chat', text: `${data.name} automatically fails: ${label} (${test.notes.join(', ')})`, visibility });
        return;
      }
      if (test.notes.length) flash(test.notes.join(' · '));
      roll(test.notes.length ? `${label} (${test.notes.join(', ')})` : label, test.expr);
    },
    [data, mode, roll, send, visibility],
  );

  const rollDamage = useCallback(
    (label: string, expr: string, crit = false) => roll(crit ? `${label} (critical)` : label, crit ? criticalDamage(expr) : expr),
    [roll],
  );

  const patchState = useCallback(
    (patch: Partial<CharacterState>) => canEdit && send({ type: 'character:state', characterId: record.id, patch }),
    [canEdit, send, record.id],
  );

  const update = useCallback(
    (fn: (c: Character) => Character) => canEdit && send({ type: 'character:update', characterId: record.id, data: fn(data) }),
    [canEdit, send, record.id, data],
  );

  return { data, derived, canEdit, mode, setMode, visibility, setVisibility, rollD20, rollDamage, roll, patchState, update, notice };
}

export const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
