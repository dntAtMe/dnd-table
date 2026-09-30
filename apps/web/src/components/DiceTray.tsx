import type { ClientMessage, Visibility } from '@dnd/protocol';
import { DiceError, formatModifier, parseDice, type D20Mode } from '@dnd/rules';
import { useMemo, useState, type FormEvent } from 'react';

const DICE = [20, 12, 10, 8, 6, 4, 100] as const;

type Pool = Partial<Record<(typeof DICE)[number], number>>;

function poolExpression(pool: Pool, modifier: number, mode: D20Mode): string {
  const parts: string[] = [];
  for (const sides of DICE) {
    const count = pool[sides] ?? 0;
    if (!count) continue;
    if (sides === 20 && count === 1 && mode !== 'normal') parts.push(mode === 'advantage' ? '2d20kh1' : '2d20kl1');
    else parts.push(`${count}d${sides}`);
  }
  if (parts.length === 0) parts.push(mode === 'advantage' ? '2d20kh1' : mode === 'disadvantage' ? '2d20kl1' : '1d20');
  let expr = parts.join(' + ');
  if (modifier) expr += ` ${formatModifier(modifier)}`;
  return expr;
}

function DieIcon({ sides }: { sides: number }) {
  // Simple silhouettes so each die is recognisable at a glance.
  const shapes: Record<number, string> = {
    4: 'M12 2 22 20H2z',
    6: 'M4 4h16v16H4z',
    8: 'M12 1 22 12 12 23 2 12z',
    10: 'M12 1 22 10 12 23 2 10z',
    12: 'M12 1.5 21.5 8.4 17.9 19.6H6.1L2.5 8.4z',
    20: 'M12 1 21.5 6.5v11L12 23l-9.5-5.5v-11z',
    100: 'M12 1 22 10 12 23 2 10z',
  };
  return (
    <svg viewBox="0 0 24 24" className="die-icon" aria-hidden="true">
      <path d={shapes[sides]} />
    </svg>
  );
}

interface Props {
  isGm: boolean;
  disabled?: boolean;
  onRoll: (msg: Extract<ClientMessage, { type: 'roll' }>) => void;
}

export function DiceTray({ isGm, disabled, onRoll }: Props) {
  const [pool, setPool] = useState<Pool>({});
  const [modifier, setModifier] = useState(0);
  const [mode, setMode] = useState<D20Mode>('normal');
  const [label, setLabel] = useState('');
  const [custom, setCustom] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');

  const advantageApplies = (pool[20] ?? 0) <= 1 && Object.entries(pool).every(([s, n]) => s === '20' || !n);
  const effectiveMode = advantageApplies ? mode : 'normal';
  const expression = custom.trim() || poolExpression(pool, modifier, effectiveMode);

  const customError = useMemo(() => {
    if (!custom.trim()) return undefined;
    try {
      parseDice(custom);
      return undefined;
    } catch (err) {
      return err instanceof DiceError ? err.message : 'Invalid formula';
    }
  }, [custom]);

  const reset = () => {
    setPool({});
    setModifier(0);
    setMode('normal');
    setLabel('');
    setCustom('');
    // Secret rolls are one-off so the next roll isn't hidden by accident.
    setVisibility('public');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (customError) return;
    onRoll({ type: 'roll', expr: expression, label: label.trim() || undefined, visibility });
    reset();
  };

  const add = (sides: (typeof DICE)[number]) => {
    setCustom('');
    setPool((p) => ({ ...p, [sides]: Math.min(20, (p[sides] ?? 0) + 1) }));
  };

  const isEmpty = !Object.values(pool).some(Boolean) && !modifier && !custom && !label;

  return (
    <form className="tray" onSubmit={submit}>
      <div className="tray__dice" role="group" aria-label="Add dice">
        {DICE.map((sides) => (
          <button
            key={sides}
            type="button"
            className={`die-btn${pool[sides] ? ' die-btn--active' : ''}`}
            onClick={() => add(sides)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPool((p) => ({ ...p, [sides]: Math.max(0, (p[sides] ?? 0) - 1) }));
            }}
            aria-label={`Add a d${sides}`}
          >
            <DieIcon sides={sides} />
            <span className="die-btn__label">d{sides}</span>
            {pool[sides] ? <span className="die-btn__count">{pool[sides]}</span> : null}
          </button>
        ))}
      </div>

      <div className="tray__row">
        <div className="stepper" role="group" aria-label="Modifier">
          <button type="button" onClick={() => setModifier((m) => m - 1)} aria-label="Decrease modifier">
            −
          </button>
          <output>{modifier >= 0 ? `+${modifier}` : modifier}</output>
          <button type="button" onClick={() => setModifier((m) => m + 1)} aria-label="Increase modifier">
            +
          </button>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Advantage">
          {(['disadvantage', 'normal', 'advantage'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? 'is-active' : ''}
              disabled={!advantageApplies}
              onClick={() => setMode(m)}
            >
              {m === 'normal' ? 'Normal' : m === 'advantage' ? 'Adv' : 'Dis'}
            </button>
          ))}
        </div>
      </div>

      <div className="tray__row">
        <input
          className="tray__label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="What for? (e.g. Stealth)"
          maxLength={80}
          aria-label="Roll label"
        />
        <input
          className={`tray__custom${customError ? ' is-invalid' : ''}`}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="or type: 4d6dl1"
          maxLength={200}
          aria-label="Custom formula"
          aria-invalid={Boolean(customError)}
          title={customError}
        />
      </div>
      {customError && <p className="tray__error">{customError}</p>}

      <div className="tray__row">
        <button
          type="button"
          className={`toggle${visibility === 'gm' ? ' toggle--on' : ''}`}
          onClick={() => setVisibility((v) => (v === 'gm' ? 'public' : 'gm'))}
          aria-pressed={visibility === 'gm'}
          title={isGm ? 'Only you will see the result' : 'Only you and the GM will see the result'}
        >
          {isGm ? 'Hidden roll' : 'To GM only'}
        </button>
        {!isEmpty && (
          <button type="button" className="btn btn--ghost" onClick={reset}>
            Clear
          </button>
        )}
        <button type="submit" className="btn btn--primary tray__roll" disabled={disabled || Boolean(customError)}>
          Roll <span className="tray__expr">{expression}</span>
        </button>
      </div>
    </form>
  );
}
