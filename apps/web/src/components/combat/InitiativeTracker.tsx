import type { ClientMessage, CombatView, CombatantView } from '@dnd/protocol';
import { CONDITIONS, CONDITION_IDS, type ConditionId } from '@dnd/rules';
import { useEffect, useState, type FormEvent } from 'react';
import { EntityLink, MaybeLink } from '../knowledge/EntityLink';
import { STATUS_LABEL } from './InitiativeStrip';
import './combat.css';

type Send = (msg: ClientMessage) => void;

interface Props {
  combat: CombatView;
  isGm: boolean;
  userId?: string;
  send: Send;
  /** GM: the combatant whose details (e.g. stat block) are shown beside the tracker. */
  selectedId?: string | null;
  onSelect?: (c: CombatantView) => void;
}

/** The turn order with full controls for the GM and own-character controls for players. */
export function InitiativeTracker({ combat, isGm, userId, send, selectedId, onSelect }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const active = combat.combatants.find((c) => c.id === combat.activeId);
  const myTurn = !isGm && active !== undefined && active.ownerUserId === userId;
  const pending = combat.combatants.filter((c) => c.kind !== 'character' && c.initiative === null).length;

  const end = () => {
    if (confirm('End combat? The turn order is cleared for everyone.')) send({ type: 'combat:end' });
  };

  return (
    <div className="tracker">
      <div className="tracker__bar">
        <div className="tracker__round">
          <span className="stat-label">Round</span>
          <strong>{combat.round}</strong>
        </div>
        {isGm ? (
          <>
            <button type="button" className="btn btn--sm" onClick={() => send({ type: 'combat:turn', dir: 'prev' })} disabled={!combat.activeId} aria-label="Previous turn">
              ‹ Prev
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => send({ type: 'combat:turn', dir: 'next' })} disabled={combat.combatants.length === 0}>
              {combat.activeId ? 'Next turn ›' : 'Start round 1'}
            </button>
            {pending > 0 && (
              <button type="button" className="btn btn--sm" onClick={() => send({ type: 'combat:roll-initiative' })}>
                Roll for creatures ({pending})
              </button>
            )}
            <button type="button" className="btn btn--sm btn--ghost btn--danger tracker__end" onClick={end}>
              End combat
            </button>
          </>
        ) : myTurn ? (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => send({ type: 'combat:turn', dir: 'next' })}>
            End my turn
          </button>
        ) : (
          <span className="muted tracker__whose">{active ? `${active.name}'s turn` : combat.activeId === null && combat.round === 1 ? 'Rolling initiative' : '…'}</span>
        )}
      </div>

      {combat.combatants.length === 0 ? (
        <p className="hint tracker__empty">{isGm ? 'Add party members, tokens or monsters to the fight.' : 'Waiting for the GM to set up the fight.'}</p>
      ) : (
        <ol className="tracker__list">
          {combat.combatants.map((c) => {
            const canControl = isGm || (c.kind === 'character' && c.ownerUserId === userId);
            const expanded = expandedId === c.id && canControl;
            return (
              <li
                key={c.id}
                className={`combatant${c.id === combat.activeId ? ' is-active' : ''}${c.id === selectedId ? ' is-selected' : ''}${c.hidden ? ' is-hidden' : ''}${c.status === 'down' ? ' is-down' : ''}`}
              >
                <div className="combatant__row">
                  <InitiativeCell combatant={c} editable={canControl} send={send} />
                  <button
                    type="button"
                    className="combatant__main"
                    onClick={() => {
                      if (canControl) setExpandedId(expanded ? null : c.id);
                      onSelect?.(c);
                    }}
                    aria-expanded={canControl ? expanded : undefined}
                  >
                    <span className="combatant__name">
                      <MaybeLink entry={c.monsterId ? { kind: 'monster', id: c.monsterId } : null} hoverOnly>
                        {c.name}
                      </MaybeLink>
                      {c.hidden && <span className="badge badge--hidden">Hidden</span>}
                    </span>
                    {c.conditions.length > 0 && (
                      <span className="combatant__conditions">
                        {c.conditions.map((id) => (
                          <span key={id} className="combatant__condition">
                            <MaybeLink entry={{ kind: 'condition', id }} hoverOnly>
                              {CONDITIONS[id as ConditionId]?.name ?? id}
                            </MaybeLink>
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                  {c.ac != null && (
                    <span className="combatant__ac" title="Armor Class">
                      <span className="stat-label">AC</span>
                      {c.ac}
                    </span>
                  )}
                  <HealthCell combatant={c} />
                </div>
                {expanded && <CombatantControls combatant={c} isGm={isGm} send={send} />}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function InitiativeCell({ combatant: c, editable, send }: { combatant: CombatantView; editable: boolean; send: Send }) {
  const [value, setValue] = useState(c.initiative?.toString() ?? '');
  useEffect(() => setValue(c.initiative?.toString() ?? ''), [c.initiative]);
  if (!editable) return <span className="combatant__init">{c.initiative ?? '–'}</span>;

  const commit = () => {
    const n = Math.round(Number(value));
    if (value.trim() === '' || !Number.isFinite(n)) return setValue(c.initiative?.toString() ?? '');
    if (n !== c.initiative) send({ type: 'combat:initiative', combatantId: c.id, value: Math.max(-10, Math.min(60, n)) });
  };
  return (
    <span className="combatant__init combatant__init--edit">
      <input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        placeholder="–"
        aria-label={`Initiative for ${c.name}`}
      />
      {c.initiative === null && (
        <button type="button" className="combatant__roll" onClick={() => send({ type: 'combat:initiative', combatantId: c.id })} title="Roll initiative">
          Roll
        </button>
      )}
    </span>
  );
}

function HealthCell({ combatant: c }: { combatant: CombatantView }) {
  if (c.hp != null && c.hpMax != null) {
    const pct = Math.max(0, Math.min(100, (c.hp / c.hpMax) * 100));
    return (
      <span className={`combatant__hp combatant__hp--${c.status ?? 'healthy'}`}>
        <span className="combatant__hp-value">
          {c.hp}
          <span className="muted">/{c.hpMax}</span>
          {(c.tempHp ?? 0) > 0 && <span className="combatant__temp"> +{c.tempHp}</span>}
        </span>
        <span className="combatant__hp-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </span>
    );
  }
  if (c.status) return <span className={`combatant__status combatant__status--${c.status}`}>{STATUS_LABEL[c.status]}</span>;
  return <span className="combatant__hp muted">–</span>;
}

/** Quick combat controls for a selected map token (GM sidebar). */
export function CombatantCard({ combatant: c, send }: { combatant: CombatantView; send: Send }) {
  return (
    <div className="combatant combatant--card">
      <div className="combatant__row">
        <span className="combatant__init">{c.initiative ?? '–'}</span>
        <span className="combatant__main">
          <span className="combatant__name">
            <MaybeLink entry={c.monsterId ? { kind: 'monster', id: c.monsterId } : null}>{c.name}</MaybeLink>
          </span>
        </span>
        {c.ac != null && (
          <span className="combatant__ac" title="Armor Class">
            <span className="stat-label">AC</span>
            {c.ac}
          </span>
        )}
        <HealthCell combatant={c} />
      </div>
      <CombatantControls combatant={c} isGm send={send} />
    </div>
  );
}

function CombatantControls({ combatant: c, isGm, send }: { combatant: CombatantView; isGm: boolean; send: Send }) {
  const [amount, setAmount] = useState('');
  const tracksHp = c.hpMax != null;

  const apply = (op: 'damage' | 'heal' | 'temp') => {
    const n = Math.abs(Math.round(Number(amount)));
    if (!n) return;
    send({ type: 'combat:hp', combatantId: c.id, op, amount: Math.min(9999, n) });
    setAmount('');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    apply('damage');
  };

  return (
    <div className="combatant__controls">
      {tracksHp ? (
        <form className="combatant__hp-form" onSubmit={submit}>
          <input type="number" inputMode="numeric" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" aria-label="Hit point amount" />
          <button type="submit" className="btn btn--sm btn--danger" disabled={!amount}>
            Damage
          </button>
          <button type="button" className="btn btn--sm" disabled={!amount} onClick={() => apply('heal')}>
            Heal
          </button>
          <button type="button" className="btn btn--sm btn--ghost" disabled={!amount} onClick={() => apply('temp')}>
            Temp
          </button>
        </form>
      ) : null}
      {isGm && c.kind !== 'character' && <StatsEditor combatant={c} send={send} />}
      <div className="chips" role="group" aria-label="Conditions">
        {CONDITION_IDS.map((id) => {
          const on = c.conditions.includes(id);
          return (
            <button
              key={id}
              type="button"
              className={`chip${on ? ' chip--on' : ''}`}
              aria-pressed={on}
              title={CONDITIONS[id].summary}
              onClick={() => send({ type: 'combat:condition', combatantId: c.id, condition: id, on: !on })}
            >
              <EntityLink entry={{ kind: 'condition', id }} hoverOnly>
                {CONDITIONS[id].name}
              </EntityLink>
            </button>
          );
        })}
      </div>
      {isGm && (
        <div className="combatant__gm">
          <button type="button" className={`toggle toggle--sm${c.hidden ? ' toggle--on' : ''}`} aria-pressed={c.hidden} onClick={() => send({ type: 'combat:update', combatantId: c.id, hidden: !c.hidden })}>
            {c.hidden ? 'Hidden from players' : 'Visible to players'}
          </button>
          <button type="button" className="btn btn--sm btn--ghost btn--danger" onClick={() => send({ type: 'combat:remove', combatantId: c.id })}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

/** GM: AC and maximum HP for creatures that aren't SRD monsters or characters (e.g. plain tokens). */
function StatsEditor({ combatant: c, send }: { combatant: CombatantView; send: Send }) {
  const [ac, setAc] = useState(c.ac?.toString() ?? '');
  const [hpMax, setHpMax] = useState(c.hpMax?.toString() ?? '');
  useEffect(() => setAc(c.ac?.toString() ?? ''), [c.ac]);
  useEffect(() => setHpMax(c.hpMax?.toString() ?? ''), [c.hpMax]);
  const num = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.round(Number(s))));

  return (
    <div className="combatant__stats">
      <label className="field-row">
        <span>AC</span>
        <input
          type="number"
          inputMode="numeric"
          value={ac}
          onChange={(e) => setAc(e.target.value)}
          onBlur={() => num(ac) !== c.ac && send({ type: 'combat:update', combatantId: c.id, ac: num(ac) === null ? null : Math.min(50, num(ac)!) })}
        />
      </label>
      <label className="field-row">
        <span>Max HP</span>
        <input
          type="number"
          inputMode="numeric"
          value={hpMax}
          onChange={(e) => setHpMax(e.target.value)}
          onBlur={() => {
            const n = num(hpMax);
            if (n !== c.hpMax) send({ type: 'combat:update', combatantId: c.id, hpMax: n ? Math.min(9999, n) : null });
          }}
        />
      </label>
    </div>
  );
}
