import type { ClientMessage, Member, SceneView, Token } from '@dnd/protocol';
import { useEffect, useState } from 'react';

type Send = (msg: ClientMessage) => void;

export const TOKEN_COLORS = ['#c0392b', '#d35400', '#c9a227', '#27ae60', '#16a085', '#2e86de', '#8e44ad', '#7f8c8d'];

export const TOKEN_SIZES = [
  { size: 1, label: 'Medium or smaller' },
  { size: 2, label: 'Large' },
  { size: 3, label: 'Huge' },
  { size: 4, label: 'Gargantuan' },
];

interface InspectorProps {
  token: Token;
  members: Member[];
  send: Send;
}

export function TokenInspector({ token, members, send }: InspectorProps) {
  const [name, setName] = useState(token.name);
  useEffect(() => setName(token.name), [token.name]);

  const update = (patch: Partial<Omit<Token, 'id' | 'sceneId' | 'col' | 'row'>>) =>
    send({ type: 'token:update', tokenId: token.id, ...patch });

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== token.name) update({ name: trimmed });
    else setName(token.name);
  };

  return (
    <div className="inspector">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        maxLength={40}
        aria-label="Token name"
        className="plain"
      />
      <div className="swatches" role="radiogroup" aria-label="Colour">
        {TOKEN_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={token.color === c}
            aria-label={c}
            className={`swatch${token.color === c ? ' is-active' : ''}`}
            style={{ background: c }}
            onClick={() => update({ color: c })}
          />
        ))}
      </div>
      <label className="field-row">
        <span>Size</span>
        <select value={token.size} onChange={(e) => update({ size: Number(e.target.value) })}>
          {TOKEN_SIZES.map((s) => (
            <option key={s.size} value={s.size}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>Controlled by</span>
        <select value={token.ownerUserId ?? ''} onChange={(e) => update({ ownerUserId: e.target.value || null })}>
          <option value="">GM only</option>
          {members
            .filter((m) => m.role === 'player')
            .map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={token.hidden} onChange={(e) => update({ hidden: e.target.checked })} />
        Hidden from players
      </label>
      <button type="button" className="btn btn--sm btn--danger" onClick={() => send({ type: 'token:delete', tokenId: token.id })}>
        Remove token
      </button>
    </div>
  );
}

interface AddTokenProps {
  scene: SceneView;
  members: Member[];
  /** Where to drop the new token (usually the centre of the view). */
  at: () => { col: number; row: number };
  send: Send;
}

/** "Add token" menu: a generic creature, or a token for each player who doesn't have one here yet. */
export function AddTokenMenu({ scene, members, at, send }: AddTokenProps) {
  const [open, setOpen] = useState(false);
  const playersWithout = members.filter((m) => m.role === 'player' && !scene.tokens.some((t) => t.ownerUserId === m.userId));

  const add = (name: string, ownerUserId: string | null, hidden: boolean) => {
    const color = TOKEN_COLORS[scene.tokens.length % TOKEN_COLORS.length]!;
    send({ type: 'token:create', sceneId: scene.id, name, color, ownerUserId, hidden, ...at() });
    setOpen(false);
  };

  return (
    <div className="menu">
      <button type="button" className="btn btn--sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        + Token
      </button>
      {open && (
        <div className="menu__list" role="menu">
          <button type="button" role="menuitem" onClick={() => add(`Creature ${scene.tokens.length + 1}`, null, false)}>
            Creature
          </button>
          <button type="button" role="menuitem" onClick={() => add(`Hidden ${scene.tokens.length + 1}`, null, true)}>
            Hidden creature
          </button>
          {playersWithout.map((m) => (
            <button key={m.userId} type="button" role="menuitem" onClick={() => add(m.name, m.userId, false)}>
              {m.name}'s token
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
