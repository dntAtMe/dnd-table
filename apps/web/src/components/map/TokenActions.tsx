import type { CharacterRecord, ClientMessage, CombatView, CombatantView, Member, Token } from '@dnd/protocol';
import {
  ABILITIES,
  ABILITY_NAMES,
  CONDITIONS,
  CONDITION_IDS,
  SKILL_IDS,
  SKILLS,
  abilityMod,
  applyHpChange,
  computeCharacter,
  healthStatus,
  formatCr,
  monsterSave,
  monsterSkill,
  type ConditionId,
  type D20Mode,
  type MonsterDef,
  type Skill,
} from '@dnd/rules';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useKnowledge } from '../../lib/knowledge';
import { characterSubtitle } from '../character/CharacterSheet';
import { signed, useCharacter, type CharacterActions } from '../character/useCharacter';
import { StatsEditor } from '../combat/InitiativeTracker';
import { STATUS_LABEL } from '../combat/InitiativeStrip';
import { monsterIdForName } from '../combat/monsterForToken';
import { ActionEntry, useMonsterRolls } from '../combat/StatBlock';
import { useMonsters } from '../combat/useMonsters';
import { EntityLink, MaybeLink } from '../knowledge/EntityLink';
import { TokenInspector } from '../TokenPanels';
import { LightPicker } from '../TokenVision';
import './tokenActions.css';

type Send = (msg: ClientMessage) => void;
type Pane = 'actions' | 'checks' | 'conditions';

const PANE_LABELS: Record<Pane, string> = { actions: 'Actions', checks: 'Checks', conditions: 'Conditions' };
/** The pane last picked, so clicking from token to token keeps you where you were. */
let lastPane: Pane = 'actions';

export interface TokenActionsProps {
  token: Token;
  combat: CombatView | null;
  characters: CharacterRecord[];
  /** For the GM's "Controlled by" setting. */
  members: Member[];
  isGm: boolean;
  userId?: string;
  send: Send;
  onClose: () => void;
  /** Shows the token's character sheet. */
  onOpenSheet?: (characterId: string) => void;
}

/** The combatant a token stands for: by token, or by the character it represents. */
export function combatantFor(combat: CombatView | null, token: Token): CombatantView | undefined {
  return combat?.combatants.find((c) => c.tokenId === token.id || (c.characterId !== null && c.characterId === token.characterId));
}

/**
 * Quick actions for a token, shown beside it on the map so nobody has to switch to the combat
 * tracker or the sheet mid-fight: hit points, conditions, turn and initiative, attack and save
 * rolls (a character's from its sheet, a monster's from its stat block), and GM token controls.
 * Players see a read-only card for creatures they don't control.
 */
export function TokenActions({ token, combat, characters, members, isGm, userId, send, onClose, onOpenSheet }: TokenActionsProps) {
  const { compendium } = useKnowledge();
  /** GM: showing the token's settings (name, colour, size, owner, vision) instead of its actions. */
  const [editing, setEditing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Switching between actions and settings starts the new view at its top.
  useEffect(() => {
    rootRef.current?.closest('.token-popup')?.scrollTo({ top: 0 });
  }, [editing]);
  const combatant = combatantFor(combat, token);
  const character = token.characterId ? characters.find((c) => c.id === token.characterId) : undefined;
  const canControl = isGm || (userId !== undefined && (token.ownerUserId === userId || character?.ownerUserId === userId));
  const monsterId = isGm && !character ? (combatant?.monsterId ?? monsterIdForName(compendium, token.name)) : undefined;
  const monsters = useMonsters(Boolean(monsterId));
  const monster = monsterId ? monsters?.[monsterId] : undefined;
  const derived = useMemo(() => (character ? computeCharacter(character.data) : undefined), [character]);

  // Combat numbers win (they're what the tracker shows); a character outside combat uses its sheet.
  const hp =
    combatant?.hp != null && combatant.hpMax != null
      ? { value: combatant.hp, max: combatant.hpMax, temp: combatant.tempHp ?? 0 }
      : character && derived
        ? { value: character.data.state.hp, max: derived.hpMax, temp: character.data.state.tempHp }
        : null;
  const status = combatant?.status ?? (hp ? healthStatus(hp.value, hp.max) : null);
  const ac = combatant?.ac ?? derived?.ac ?? monster?.ac ?? null;
  const conditions: string[] | null = combatant?.conditions ?? character?.data.state.conditions ?? null;

  const changeHp = (op: 'damage' | 'heal' | 'temp', amount: number) => {
    if (combatant && (combatant.hpMax != null || combatant.kind === 'character')) {
      send({ type: 'combat:hp', combatantId: combatant.id, op, amount });
    } else if (character && derived) {
      const s = character.data.state;
      const next = op === 'temp' ? { ...s, tempHp: Math.max(s.tempHp, amount) } : applyHpChange(s, derived.hpMax, op === 'damage' ? -amount : amount);
      send({ type: 'character:state', characterId: character.id, patch: { hp: next.hp, tempHp: next.tempHp, deathSaves: next.deathSaves } });
    }
  };
  const toggleCondition = (id: ConditionId, on: boolean) => {
    if (combatant) send({ type: 'combat:condition', combatantId: combatant.id, condition: id, on });
    else if (character) {
      const without = character.data.state.conditions.filter((c) => c !== id);
      send({ type: 'character:state', characterId: character.id, patch: { conditions: on ? [...without, id] : without } });
    }
  };

  const rolls = canControl && (character || monster);
  const panes: Pane[] = [...(rolls ? (['actions', 'checks'] as const) : []), ...(canControl && conditions ? (['conditions'] as const) : [])];
  const [picked, setPicked] = useState<Pane>(lastPane);
  const pane = panes.includes(picked) ? picked : panes[0];
  const pick = (p: Pane) => {
    lastPane = p;
    setPicked(p);
  };

  const active = Boolean(combatant && combat?.activeId === combatant.id);
  const mine = userId !== undefined && (combatant?.ownerUserId === userId || token.ownerUserId === userId);
  const subtitle = character ? characterSubtitle(character) : monster ? `CR ${formatCr(monster.cr)} · ${monster.size} ${monster.type}` : null;

  return (
    <div ref={rootRef} className="token-actions" style={{ '--token-color': token.color } as CSSProperties} role="dialog" aria-label={`${token.name}: quick actions`}>
      <header className="token-actions__head">
        <span className="token-actions__dot" aria-hidden="true" />
        <div className="token-actions__title">
          <strong>
            <MaybeLink entry={monsterId ? { kind: 'monster', id: monsterId } : null}>{token.name}</MaybeLink>
          </strong>
          {subtitle && <span className="token-actions__sub">{subtitle}</span>}
        </div>
        {token.hidden && <span className="badge badge--hidden">Hidden</span>}
        <button type="button" className="token-actions__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {editing ? (
        <>
          <div className="token-actions__settings">
            <TokenInspector token={token} members={members} characters={characters} send={send} />
          </div>
          <footer className="token-actions__foot">
            <button type="button" className="btn btn--sm" onClick={() => setEditing(false)}>
              ← Back to actions
            </button>
          </footer>
        </>
      ) : (
        <>

      <div className="token-actions__vitals">
        {ac != null && (
          <span className="token-actions__stat" title="Armor Class">
            <span className="stat-label">AC</span>
            <strong>{ac}</strong>
          </span>
        )}
        {hp ? (
          <span className={`token-actions__hp token-actions__hp--${status ?? 'healthy'}`}>
            <span className="stat-label">HP</span>
            <strong>
              {hp.value}
              <span className="muted">/{hp.max}</span>
              {hp.temp > 0 && <span className="token-actions__temp"> +{hp.temp}</span>}
            </strong>
            <span className="token-actions__bar" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, (hp.value / Math.max(1, hp.max)) * 100))}%` }} />
            </span>
          </span>
        ) : (
          status && <span className={`combatant__status combatant__status--${status}`}>{STATUS_LABEL[status]}</span>
        )}
        {derived && (
          <span className="token-actions__stat" title="Speed">
            <span className="stat-label">Speed</span>
            <strong>{derived.speed}</strong>
          </span>
        )}
        {combatant && (
          <span className="token-actions__stat" title="Initiative">
            <span className="stat-label">Init</span>
            {combatant.initiative !== null ? (
              <strong>{combatant.initiative}</strong>
            ) : canControl ? (
              <button type="button" className="roll-btn roll-btn--inline" onClick={() => send({ type: 'combat:initiative', combatantId: combatant.id })}>
                Roll
              </button>
            ) : (
              <strong>–</strong>
            )}
          </span>
        )}
      </div>

      {active && (
        <div className="token-actions__turn">
          <span>{mine && !isGm ? 'Your turn' : 'Their turn'}</span>
          {(isGm || mine) && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => send({ type: 'combat:turn', dir: 'next' })}>
              {isGm ? 'Next turn' : 'End turn'}
            </button>
          )}
        </div>
      )}

      {canControl && hp && <HpForm onApply={changeHp} />}
      {isGm && combatant && combatant.kind !== 'character' && combatant.hpMax == null && (
        <div className="token-actions__stats">
          <p className="hint">Give it hit points to track damage:</p>
          <StatsEditor combatant={combatant} send={send} />
        </div>
      )}

      {conditions && conditions.length > 0 && (
        <div className="token-actions__conditions" aria-label="Conditions">
          {conditions.map((id) => (
            <span key={id} className="chip chip--on token-actions__condition">
              <EntityLink entry={{ kind: 'condition', id }} hoverOnly>
                {CONDITIONS[id as ConditionId]?.name ?? id}
              </EntityLink>
              {canControl && (
                <button type="button" onClick={() => toggleCondition(id as ConditionId, false)} aria-label={`Remove ${CONDITIONS[id as ConditionId]?.name ?? id}`}>
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {panes.length > 1 && (
        <div className="segmented segmented--full token-actions__panes" role="tablist" aria-label="Quick actions">
          {panes.map((p) => (
            <button key={p} type="button" role="tab" aria-selected={pane === p} className={pane === p ? 'is-active' : ''} onClick={() => pick(p)}>
              {PANE_LABELS[p]}
            </button>
          ))}
        </div>
      )}
      <div className="token-actions__body">
        {pane === 'conditions' && conditions && <ConditionPicker active={conditions} onToggle={toggleCondition} />}
        {(pane === 'actions' || pane === 'checks') && character && <CharacterQuick record={character} canEdit={canControl} send={send} pane={pane} />}
        {(pane === 'actions' || pane === 'checks') && !character && monster && <MonsterQuick monster={monster} name={token.name} send={send} pane={pane} />}
        {isGm && monsterId && !monsters && <p className="hint">Loading stat block…</p>}
      </div>

      <footer className="token-actions__foot">
        {character && onOpenSheet && (
          <button type="button" className="btn btn--sm" onClick={() => onOpenSheet(character.id)}>
            Sheet
          </button>
        )}
        {monsterId && (
          <EntityLink entry={{ kind: 'monster', id: monsterId }} className="btn btn--sm token-actions__statblock">
            Stat block
          </EntityLink>
        )}
        {isGm && <CombatButton combat={combat} combatant={combatant} token={token} send={send} />}
        {isGm && (
          <button type="button" className={`toggle toggle--sm${token.hidden ? ' toggle--on' : ''}`} aria-pressed={token.hidden} onClick={() => send({ type: 'token:update', tokenId: token.id, hidden: !token.hidden })}>
            {token.hidden ? 'Hidden' : 'Hide'}
          </button>
        )}
        {isGm && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(true)} title="Name, colour, size, owner, light and vision">
            Edit token
          </button>
        )}
        {canControl && !isGm && (
          <details className="token-actions__more">
            <summary>Light</summary>
            <LightPicker token={token} send={send} />
          </details>
        )}
      </footer>
      {!canControl && !combatant && !character && <p className="hint">You don't control this creature.</p>}
        </>
      )}
    </div>
  );
}

/** GM: puts the token into the fight, takes it out, or starts one. */
function CombatButton({ combat, combatant, token, send }: { combat: CombatView | null; combatant?: CombatantView; token: Token; send: Send }) {
  if (!combat) {
    return (
      <button type="button" className="btn btn--sm" onClick={() => send({ type: 'combat:start', fromScene: true })} title="Start combat with every token on this map">
        Start combat
      </button>
    );
  }
  if (!combatant) {
    return (
      <button type="button" className="btn btn--sm" onClick={() => send({ type: 'combat:add', source: { kind: 'token', tokenId: token.id } })}>
        Add to combat
      </button>
    );
  }
  return (
    <button type="button" className="btn btn--sm btn--ghost" onClick={() => send({ type: 'combat:remove', combatantId: combatant.id })}>
      Leave combat
    </button>
  );
}

function HpForm({ onApply }: { onApply: (op: 'damage' | 'heal' | 'temp', amount: number) => void }) {
  const [amount, setAmount] = useState('');
  const apply = (op: 'damage' | 'heal' | 'temp') => {
    const n = Math.min(9999, Math.abs(Math.round(Number(amount))));
    if (!n) return;
    onApply(op, n);
    setAmount('');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    apply('damage');
  };
  return (
    <form className="token-actions__hp-form" onSubmit={submit}>
      <input type="number" inputMode="numeric" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="HP" aria-label="Hit point amount" />
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
  );
}

function ConditionPicker({ active, onToggle }: { active: string[]; onToggle: (id: ConditionId, on: boolean) => void }) {
  return (
    <div className="chips token-actions__chips" role="group" aria-label="Conditions">
      {CONDITION_IDS.map((id) => {
        const on = active.includes(id);
        return (
          <button key={id} type="button" className={`chip${on ? ' chip--on' : ''}`} aria-pressed={on} title={CONDITIONS[id].summary} onClick={() => onToggle(id, !on)}>
            <EntityLink entry={{ kind: 'condition', id }} hoverOnly>
              {CONDITIONS[id].name}
            </EntityLink>
          </button>
        );
      })}
    </div>
  );
}

/** Advantage for the next d20 roll and who sees the result. */
function RollMode({ mode, setMode, hidden, toggleHidden, hiddenLabel }: { mode: D20Mode; setMode: (m: D20Mode) => void; hidden: boolean; toggleHidden: () => void; hiddenLabel: string }) {
  return (
    <div className="token-actions__mode">
      <div className="segmented" role="radiogroup" aria-label="Next d20 roll">
        {(['disadvantage', 'normal', 'advantage'] as const).map((x) => (
          <button key={x} type="button" role="radio" aria-checked={mode === x} className={mode === x ? 'is-active' : ''} onClick={() => setMode(x)}>
            {x === 'normal' ? 'Normal' : x === 'advantage' ? 'Adv.' : 'Dis.'}
          </button>
        ))}
      </div>
      <button type="button" className={`toggle toggle--sm${hidden ? ' toggle--on' : ''}`} onClick={toggleHidden} aria-pressed={hidden}>
        {hiddenLabel}
      </button>
    </div>
  );
}

/** A grid of ability checks and saving throws, then skills. */
function ChecksGrid({ check, save, saveProficient, skills }: {
  check: (a: (typeof ABILITIES)[number]) => { bonus: number; roll: () => void };
  save: (a: (typeof ABILITIES)[number]) => { bonus: number; roll: () => void };
  saveProficient: (a: (typeof ABILITIES)[number]) => boolean;
  skills: { id: Skill; bonus: number; roll: () => void }[];
}) {
  return (
    <>
      <table className="token-actions__abilities">
        <thead>
          <tr>
            <th />
            <th>Check</th>
            <th>Save</th>
          </tr>
        </thead>
        <tbody>
          {ABILITIES.map((a) => {
            const c = check(a);
            const s = save(a);
            return (
              <tr key={a}>
                <th scope="row" title={ABILITY_NAMES[a]}>
                  {a.toUpperCase()}
                </th>
                <td>
                  <button type="button" className="roll-btn" onClick={c.roll} aria-label={`${ABILITY_NAMES[a]} check`}>
                    {signed(c.bonus)}
                  </button>
                </td>
                <td>
                  <button type="button" className={`roll-btn${saveProficient(a) ? ' roll-btn--proficient' : ''}`} onClick={s.roll} aria-label={`${ABILITY_NAMES[a]} save`}>
                    {signed(s.bonus)}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {skills.length > 0 && (
        <div className="token-actions__skills">
          {skills.map((s) => (
            <button key={s.id} type="button" className="roll-btn roll-btn--inline" onClick={s.roll}>
              <MaybeLink entry={{ kind: 'skill', id: s.id }} hoverOnly>
                {SKILLS[s.id].name}
              </MaybeLink>{' '}
              {signed(s.bonus)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** A character's attacks, spell attack and checks, rolled exactly as from the sheet. */
function CharacterQuick({ record, canEdit, send, pane }: { record: CharacterRecord; canEdit: boolean; send: Send; pane: 'actions' | 'checks' }) {
  const a = useCharacter(record, canEdit, send);
  return (
    <>
      <RollMode mode={a.mode} setMode={a.setMode} hidden={a.visibility === 'gm'} toggleHidden={() => a.setVisibility(a.visibility === 'gm' ? 'public' : 'gm')} hiddenLabel="To GM only" />
      {a.notice && <p className="hint token-actions__notice">{a.notice}</p>}
      {pane === 'actions' ? <CharacterActionsList a={a} /> : <CharacterChecks a={a} />}
    </>
  );
}

function CharacterActionsList({ a }: { a: CharacterActions }) {
  const { derived, data } = a;
  const sc = derived.spellcasting;
  return (
    <>
      {data.state.hp === 0 && (
        <button type="button" className="btn btn--sm btn--danger" onClick={() => a.roll('Death saving throw', '1d20')}>
          Roll death save ({data.state.deathSaves.successes}✓ {data.state.deathSaves.failures}✗)
        </button>
      )}
      <ul className="token-actions__list">
        {derived.attacks.map((atk) => (
          <li key={atk.id} className="token-actions__row">
            <span className="token-actions__name">
              <MaybeLink entry={atk.id.includes(':') ? { kind: 'weapon', id: atk.id.split(':')[1]! } : null}>{atk.name}</MaybeLink>
              <span className="muted"> {atk.range}</span>
            </span>
            <span className="token-actions__rolls">
              <button type="button" className="roll-btn" onClick={() => a.rollD20('attack', `${atk.name} attack`, atk.attackBonus, atk.ability)} title="Attack roll">
                {signed(atk.attackBonus)}
              </button>
              <button type="button" className="roll-btn roll-btn--damage" onClick={() => a.rollDamage(`${atk.name} damage`, atk.damage)} title={`${atk.damageType} damage`}>
                {atk.damage}
              </button>
              <button type="button" className="roll-btn roll-btn--crit" onClick={() => a.rollDamage(`${atk.name} damage`, atk.damage, true)} title="Critical hit damage">
                Crit
              </button>
            </span>
          </li>
        ))}
        {sc && (
          <li className="token-actions__row">
            <span className="token-actions__name">
              Spells <span className="muted">save DC {sc.saveDc}</span>
            </span>
            <span className="token-actions__rolls">
              <button type="button" className="roll-btn" onClick={() => a.rollD20('attack', 'Spell attack', sc.attackBonus, sc.ability)} title="Spell attack roll">
                {signed(sc.attackBonus)}
              </button>
            </span>
          </li>
        )}
      </ul>
      {derived.attacks.length === 0 && !sc && <p className="hint">No attacks on the sheet.</p>}
    </>
  );
}

function CharacterChecks({ a }: { a: CharacterActions }) {
  const { derived } = a;
  return (
    <ChecksGrid
      check={(ab) => ({ bonus: derived.mods[ab], roll: () => a.rollD20('check', `${ABILITY_NAMES[ab]} check`, derived.mods[ab], ab) })}
      save={(ab) => ({ bonus: derived.saves[ab].bonus, roll: () => a.rollD20('save', `${ab.toUpperCase()} save`, derived.saves[ab].bonus, ab) })}
      saveProficient={(ab) => derived.saves[ab].proficient}
      skills={SKILL_IDS.map((s) => ({
        id: s,
        bonus: derived.skills[s].bonus,
        roll: () => a.rollD20('check', `${SKILLS[s].name} check`, derived.skills[s].bonus, SKILLS[s].ability),
      }))}
    />
  );
}

const MONSTER_SECTIONS = [
  { key: 'actions', title: 'Actions' },
  { key: 'bonusActions', title: 'Bonus Actions' },
  { key: 'reactions', title: 'Reactions' },
  { key: 'legendaryActions', title: 'Legendary Actions' },
] as const;

/** A monster's actions and checks from its stat block (GM). */
function MonsterQuick({ monster: m, name, send, pane }: { monster: MonsterDef; name: string; send: Send; pane: 'actions' | 'checks' }) {
  const r = useMonsterRolls(name, send);
  return (
    <>
      <RollMode mode={r.mode} setMode={r.setMode} hidden={r.visibility === 'gm'} toggleHidden={() => r.setVisibility(r.visibility === 'gm' ? 'public' : 'gm')} hiddenLabel="Hidden rolls" />
      {pane === 'actions' ? (
        MONSTER_SECTIONS.map(({ key, title }) =>
          m[key].length ? (
            <section key={key} className="token-actions__section">
              {key !== 'actions' && <h4>{title}</h4>}
              {m[key].map((action) => (
                <ActionEntry key={action.name} action={action} monsterId={m.id} compact onD20={r.rollD20} onDamage={r.rollDamage} />
              ))}
            </section>
          ) : null,
        )
      ) : (
        <ChecksGrid
          check={(ab) => ({ bonus: abilityMod(m.scores[ab]), roll: () => r.rollD20(`${ABILITY_NAMES[ab]} check`, abilityMod(m.scores[ab])) })}
          save={(ab) => ({ bonus: monsterSave(m, ab), roll: () => r.rollD20(`${ABILITY_NAMES[ab]} save`, monsterSave(m, ab)) })}
          saveProficient={(ab) => m.saves[ab] !== undefined}
          skills={(Object.keys(m.skills) as Skill[]).map((s) => ({ id: s, bonus: monsterSkill(m, s), roll: () => r.rollD20(SKILLS[s].name, monsterSkill(m, s)) }))}
        />
      )}
    </>
  );
}
