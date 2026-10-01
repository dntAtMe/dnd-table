import type { CombatView, CombatantView } from '@dnd/protocol';
import type { ReactNode } from 'react';
import './combat.css';

export const STATUS_LABEL = { healthy: 'Healthy', bloodied: 'Bloodied', down: 'Down' } as const;

/** Combatants starting from whoever's turn it is, wrapping round. */
function fromActive(combat: CombatView): CombatantView[] {
  const i = combat.combatants.findIndex((c) => c.id === combat.activeId);
  return i < 0 ? combat.combatants : [...combat.combatants.slice(i), ...combat.combatants.slice(0, i)];
}

interface Props {
  combat: CombatView;
  /** How many combatants to show (current + upcoming). */
  max?: number;
  size?: 'sm' | 'lg';
  /** Tapping the strip (e.g. to open the full tracker). */
  onOpen?: () => void;
  /** Extra control at the end, e.g. "End turn". */
  action?: ReactNode;
}

/** Compact turn order: round, whose turn it is and who's next. Public information only. */
export function InitiativeStrip({ combat, max = 6, size = 'sm', onOpen, action }: Props) {
  const order = fromActive(combat);
  const shown = order.slice(0, max);
  const started = combat.activeId !== null;
  const body = (
    <>
      <span className="init-strip__round">{started || combat.round > 1 ? `Round ${combat.round}` : 'Initiative'}</span>
      <ol className="init-strip__list">
        {shown.map((c) => (
          <li key={c.id} className={`init-strip__item${c.id === combat.activeId ? ' is-active' : ''}${c.status === 'down' ? ' is-down' : ''}`}>
            <span className="init-strip__name">{c.name}</span>
            {c.status && c.status !== 'healthy' && (
              <span className={`init-strip__status init-strip__status--${c.status}`} title={STATUS_LABEL[c.status]}>
                {STATUS_LABEL[c.status]}
              </span>
            )}
          </li>
        ))}
        {order.length > shown.length && <li className="init-strip__more">+{order.length - shown.length}</li>}
      </ol>
    </>
  );
  return (
    <div className={`init-strip init-strip--${size}`}>
      {onOpen ? (
        <button type="button" className="init-strip__open" onClick={onOpen} title="Open the initiative tracker">
          {body}
        </button>
      ) : (
        <div className="init-strip__open">{body}</div>
      )}
      {action}
    </div>
  );
}
