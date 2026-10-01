import type { CharacterRecord, ClientMessage, CombatView, CombatantView, SceneView } from '@dnd/protocol';
import { SRD_ATTRIBUTION, encounterBudget, encounterDifficulty, type MonsterDef } from '@dnd/rules';
import { useState, type FormEvent } from 'react';
import { InitiativeTracker } from './InitiativeTracker';
import { MonsterBrowser } from './MonsterBrowser';
import { StatBlock } from './StatBlock';
import { useMonsters } from './useMonsters';
import './combat.css';

type Send = (msg: ClientMessage) => void;
type SideTab = 'monsters' | 'add' | 'stats';

interface Props {
  combat: CombatView | null;
  isGm: boolean;
  userId?: string;
  characters: CharacterRecord[];
  /** The scene the GM is looking at, for adding its tokens. */
  scene: SceneView | null;
  send: Send;
}

/** The combat view: initiative tracker, plus monster browser, stat blocks and party/token adders for the GM. */
export function CombatPanel({ combat, isGm, userId, characters, scene, send }: Props) {
  if (!combat) {
    return (
      <div className="combat-panel combat-panel--idle">
        <div className="map-empty">
          <p>{isGm ? 'No combat running.' : 'No combat right now.'}</p>
          {isGm && (
            <div className="combat-panel__start">
              <button type="button" className="btn btn--primary" onClick={() => send({ type: 'combat:start', fromScene: true })} disabled={!scene || scene.tokens.length === 0}>
                Start with this map's tokens{scene ? ` (${scene.tokens.length})` : ''}
              </button>
              <button type="button" className="btn" onClick={() => send({ type: 'combat:start' })}>
                Start empty
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (!isGm) {
    return (
      <div className="combat-panel combat-panel--player">
        <InitiativeTracker combat={combat} isGm={false} userId={userId} send={send} />
      </div>
    );
  }
  return <GmCombat combat={combat} characters={characters} scene={scene} send={send} />;
}

function GmCombat({ combat, characters, scene, send }: { combat: CombatView; characters: CharacterRecord[]; scene: SceneView | null; send: Send }) {
  const monsters = useMonsters();
  const [tab, setTab] = useState<SideTab>('monsters');
  const [selected, setSelected] = useState<CombatantView | null>(null);
  const [browsing, setBrowsing] = useState<MonsterDef | null>(null);
  const selectedMonster = selected?.monsterId && monsters ? monsters[selected.monsterId] : undefined;

  const select = (c: CombatantView) => {
    setSelected(c);
    if (c.monsterId) setTab('stats');
  };

  return (
    <div className="combat-panel">
      <div className="combat-panel__main">
        <InitiativeTracker combat={combat} isGm send={send} selectedId={selected?.id} onSelect={select} />
        <Difficulty combat={combat} characters={characters} monsters={monsters} />
      </div>
      <aside className="combat-panel__side">
        <div className="segmented segmented--full" role="tablist" aria-label="Combat tools">
          <button type="button" role="tab" aria-selected={tab === 'monsters'} className={tab === 'monsters' ? 'is-active' : ''} onClick={() => setTab('monsters')}>
            Monsters
          </button>
          <button type="button" role="tab" aria-selected={tab === 'add'} className={tab === 'add' ? 'is-active' : ''} onClick={() => setTab('add')}>
            Party
          </button>
          <button type="button" role="tab" aria-selected={tab === 'stats'} className={tab === 'stats' ? 'is-active' : ''} onClick={() => setTab('stats')} disabled={!selectedMonster}>
            Stat block
          </button>
        </div>
        {tab === 'monsters' &&
          (monsters ? (
            <>
              <MonsterBrowser monsters={monsters} selectedId={browsing?.id ?? null} onSelect={setBrowsing} />
              {browsing && <AddMonster key={browsing.id} monster={browsing} hasMap={Boolean(scene)} send={send} />}
            </>
          ) : (
            <p className="muted">Loading monsters…</p>
          ))}
        {tab === 'add' && <AddOthers combat={combat} characters={characters} scene={scene} send={send} />}
        {tab === 'stats' && selectedMonster && selected && <StatBlock key={selected.id} monster={selectedMonster} name={selected.name} send={send} />}
        <p className="srd-note">{SRD_ATTRIBUTION}</p>
      </aside>
    </div>
  );
}

function AddMonster({ monster, hasMap, send }: { monster: MonsterDef; hasMap: boolean; send: Send }) {
  const [count, setCount] = useState(1);
  const [hidden, setHidden] = useState(false);
  const [placeToken, setPlaceToken] = useState(hasMap);
  const [rollHp, setRollHp] = useState(false);

  const add = (e: FormEvent) => {
    e.preventDefault();
    send({ type: 'combat:add', source: { kind: 'monster', monsterId: monster.id, count, hidden, placeToken: placeToken && hasMap, rollHp } });
  };

  return (
    <div className="add-monster">
      <form className="add-monster__form" onSubmit={add}>
        <div className="stepper" aria-label="How many">
          <button type="button" onClick={() => setCount((n) => Math.max(1, n - 1))} aria-label="Fewer">
            −
          </button>
          <output>{count}</output>
          <button type="button" onClick={() => setCount((n) => Math.min(20, n + 1))} aria-label="More">
            +
          </button>
        </div>
        <button type="submit" className="btn btn--primary btn--sm">
          Add {count > 1 ? `${count} × ` : ''}
          {monster.name}
        </button>
      </form>
      <div className="add-monster__options">
        <label className="check">
          <input type="checkbox" checked={placeToken && hasMap} disabled={!hasMap} onChange={(e) => setPlaceToken(e.target.checked)} />
          Place tokens on the map
        </label>
        <label className="check">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Hidden from players
        </label>
        <label className="check">
          <input type="checkbox" checked={rollHp} onChange={(e) => setRollHp(e.target.checked)} />
          Roll HP ({monster.hpFormula}) instead of {monster.hp}
        </label>
      </div>
      <StatBlock monster={monster} send={send} />
    </div>
  );
}

function AddOthers({ combat, characters, scene, send }: { combat: CombatView; characters: CharacterRecord[]; scene: SceneView | null; send: Send }) {
  const [name, setName] = useState('');
  const inFight = (pred: (c: CombatantView) => boolean) => combat.combatants.some(pred);
  const party = characters.filter((ch) => !inFight((c) => c.characterId === ch.id));
  const tokens = (scene?.tokens ?? []).filter((t) => !inFight((c) => c.tokenId === t.id || (t.characterId !== null && c.characterId === t.characterId)));
  const add = (source: Extract<ClientMessage, { type: 'combat:add' }>['source']) => send({ type: 'combat:add', source });

  return (
    <div className="add-others">
      <h4 className="panel__title">Party</h4>
      {party.length ? (
        <div className="add-others__list">
          {party.map((ch) => (
            <button key={ch.id} type="button" className="btn btn--sm" onClick={() => add({ kind: 'character', characterId: ch.id })}>
              <span className="character-chip__dot" style={{ background: ch.data.color }} />
              {ch.data.name}
            </button>
          ))}
          {party.length > 1 && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => party.forEach((ch) => add({ kind: 'character', characterId: ch.id }))}>
              Add everyone
            </button>
          )}
        </div>
      ) : (
        <p className="hint">Every character is in the fight.</p>
      )}

      <h4 className="panel__title">Tokens on this map</h4>
      {tokens.length ? (
        <div className="add-others__list">
          {tokens.map((t) => (
            <button key={t.id} type="button" className="btn btn--sm" onClick={() => add({ kind: 'token', tokenId: t.id })}>
              <span className="character-chip__dot" style={{ background: t.color }} />
              {t.name}
              {t.hidden && <span className="badge badge--hidden">Hidden</span>}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">{scene ? 'Every token on this map is in the fight.' : 'Open a scene to add its tokens.'}</p>
      )}

      <h4 className="panel__title">Other</h4>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          add({ kind: 'custom', name: name.trim() });
          setName('');
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Lair action" aria-label="Combatant name" />
        <button type="submit" className="btn" disabled={!name.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

/** 2024 encounter difficulty: monster XP against the party's XP budget. */
function Difficulty({ combat, characters, monsters }: { combat: CombatView; characters: CharacterRecord[]; monsters: Record<string, MonsterDef> | null }) {
  const levels = combat.combatants.flatMap((c) => {
    const ch = c.characterId ? characters.find((x) => x.id === c.characterId) : undefined;
    return ch ? [ch.data.level] : [];
  });
  const xp = monsters ? combat.combatants.reduce((sum, c) => sum + (c.monsterId ? (monsters[c.monsterId]?.xp ?? 0) : 0), 0) : 0;
  if (levels.length === 0 || xp === 0) return null;
  const budget = encounterBudget(levels);
  const difficulty = encounterDifficulty(levels, xp);
  return (
    <div className={`difficulty difficulty--${difficulty.replace(' ', '-')}`}>
      <span className="stat-label">Encounter</span>
      <strong>{difficulty === 'beyond high' ? 'Beyond High' : difficulty[0]!.toUpperCase() + difficulty.slice(1)}</strong>
      <span className="muted">
        {xp.toLocaleString()} XP vs. budget Low {budget.low.toLocaleString()} · Moderate {budget.moderate.toLocaleString()} · High {budget.high.toLocaleString()} (
        {levels.length} {levels.length === 1 ? 'character' : 'characters'})
      </span>
    </div>
  );
}
