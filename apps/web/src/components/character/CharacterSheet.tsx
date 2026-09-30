import type { CharacterRecord, ClientMessage, Member } from '@dnd/protocol';
import { BACKGROUNDS, CLASSES, SPECIES, SRD_ATTRIBUTION, SUBCLASSES, SUBSPECIES } from '@dnd/rules';
import { useEffect, useState } from 'react';
import { AbilitiesTab, CombatTab, RollControls, Vitals } from './SheetCore';
import { FeaturesTab, InventoryTab, NotesTab, SpellsTab } from './SheetMore';
import { useCharacter } from './useCharacter';

type Send = (msg: ClientMessage) => void;
type SheetTab = 'abilities' | 'combat' | 'spells' | 'features' | 'inventory' | 'notes';

const TABS: { id: SheetTab; label: string }[] = [
  { id: 'abilities', label: 'Abilities' },
  { id: 'combat', label: 'Combat' },
  { id: 'spells', label: 'Spells' },
  { id: 'features', label: 'Features' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'notes', label: 'Notes' },
];

export function characterSubtitle(record: CharacterRecord): string {
  const c = record.data;
  const species = (c.subspeciesId && SUBSPECIES[c.subspeciesId]?.name.split(': ').pop()) || SPECIES[c.speciesId]?.name;
  const subclass = c.subclassId ? SUBCLASSES[c.subclassId]?.name : undefined;
  return `Level ${c.level} ${species ?? ''} ${CLASSES[c.classId]?.name ?? c.classId}${subclass ? ` · ${subclass}` : ''}`;
}

interface SheetProps {
  record: CharacterRecord;
  canEdit: boolean;
  send: Send;
  onLevelUp?: () => void;
}

export function CharacterSheet({ record, canEdit, send, onLevelUp }: SheetProps) {
  const a = useCharacter(record, canEdit, send);
  const [tab, setTab] = useState<SheetTab>('abilities');
  const [resting, setResting] = useState<'short' | 'long' | null>(null);
  const [hitDice, setHitDice] = useState(1);
  const hitDiceLeft = a.data.level - a.data.state.hitDiceSpent;

  useEffect(() => setResting(null), [record.id]);

  const remove = () => {
    if (confirm(`Delete ${a.data.name}? This can't be undone.`)) send({ type: 'character:delete', characterId: record.id });
  };

  return (
    <article className="sheet">
      <header className="sheet__header">
        <span className="sheet__swatch" style={{ background: a.data.color }} aria-hidden="true" />
        <div className="sheet__title">
          <h2>{a.data.name}</h2>
          <p className="muted">
            {characterSubtitle(record)} · {BACKGROUNDS[a.data.backgroundId]?.name}
          </p>
        </div>
        {canEdit && (
          <div className="sheet__actions">
            <button type="button" className="btn btn--sm" onClick={() => setResting(resting ? null : 'short')}>
              Rest
            </button>
            {onLevelUp && a.data.level < 20 && (
              <button type="button" className="btn btn--sm btn--primary" onClick={onLevelUp}>
                Level up
              </button>
            )}
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => send({ type: 'character:token', characterId: record.id })} title="Put this character's token on the current map">
              Place on map
            </button>
            <button type="button" className="btn btn--sm btn--ghost btn--danger" onClick={remove} aria-label={`Delete ${a.data.name}`}>
              Delete
            </button>
          </div>
        )}
      </header>

      {resting && (
        <div className="rest-panel">
          <div className="segmented">
            <button type="button" className={resting === 'short' ? 'is-active' : ''} onClick={() => setResting('short')}>
              Short Rest
            </button>
            <button type="button" className={resting === 'long' ? 'is-active' : ''} onClick={() => setResting('long')}>
              Long Rest
            </button>
          </div>
          {resting === 'short' ? (
            <div className="rest-panel__body">
              <p className="hint">
                Spend Hit Dice to heal (d{a.derived.hitDie} + CON each). Short-rest features recharge
                {a.derived.spellcasting?.pact ? ', including Pact Magic slots' : ''}.
              </p>
              <label className="field-row">
                <span>Hit Dice to spend ({hitDiceLeft} left)</span>
                <input type="number" min={0} max={hitDiceLeft} value={Math.min(hitDice, hitDiceLeft)} onChange={(e) => setHitDice(Number(e.target.value))} />
              </label>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  send({ type: 'character:rest', characterId: record.id, kind: 'short', hitDice: Math.max(0, Math.min(hitDice, hitDiceLeft)) });
                  setResting(null);
                }}
              >
                Take Short Rest
              </button>
            </div>
          ) : (
            <div className="rest-panel__body">
              <p className="hint">Regain all HP, Hit Dice, spell slots and features; reduce Exhaustion by 1.</p>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  send({ type: 'character:rest', characterId: record.id, kind: 'long' });
                  setResting(null);
                }}
              >
                Take Long Rest
              </button>
            </div>
          )}
        </div>
      )}

      <Vitals a={a} />
      <RollControls a={a} />
      {a.notice && (
        <p className="sheet__notice" role="status">
          {a.notice}
        </p>
      )}

      <nav className="sheet__tabs" aria-label="Sheet sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'is-active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="sheet__body">
        {tab === 'abilities' && <AbilitiesTab a={a} />}
        {tab === 'combat' && <CombatTab a={a} />}
        {tab === 'spells' && <SpellsTab a={a} />}
        {tab === 'features' && <FeaturesTab a={a} />}
        {tab === 'inventory' && <InventoryTab a={a} />}
        {tab === 'notes' && <NotesTab a={a} />}
      </div>
      <p className="srd-note">{SRD_ATTRIBUTION}</p>
    </article>
  );
}

interface PanelProps {
  characters: CharacterRecord[];
  members: Member[];
  userId?: string;
  isGm: boolean;
  send: Send;
  onCreate?: () => void;
  onLevelUp?: (record: CharacterRecord) => void;
}

/** Switches between the party's characters; players start on their own. */
export function CharacterPanel({ characters, members, userId, isGm, send, onCreate, onLevelUp }: PanelProps) {
  const mine = characters.filter((c) => c.ownerUserId === userId);
  const ordered = [...mine, ...characters.filter((c) => c.ownerUserId !== userId)];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ordered.find((c) => c.id === selectedId) ?? ordered[0];
  const ownerName = (id: string) => members.find((m) => m.userId === id)?.name ?? 'Unknown';

  if (!selected) {
    return (
      <div className="map-empty">
        <p>{isGm ? 'No characters yet. Players create theirs from this tab.' : "You don't have a character in this campaign yet."}</p>
        {onCreate && (
          <button type="button" className="btn btn--primary" onClick={onCreate}>
            Create a character
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="character-panel">
      <div className="character-switcher" role="tablist" aria-label="Characters">
        {ordered.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === selected.id}
            className={`character-chip${c.id === selected.id ? ' is-active' : ''}`}
            onClick={() => setSelectedId(c.id)}
          >
            <span className="character-chip__dot" style={{ background: c.data.color }} />
            <span>{c.data.name}</span>
            {c.ownerUserId !== userId && <span className="muted">{ownerName(c.ownerUserId)}</span>}
          </button>
        ))}
        {onCreate && (
          <button type="button" className="character-chip character-chip--new" onClick={onCreate}>
            + New
          </button>
        )}
      </div>
      <CharacterSheet
        key={selected.id}
        record={selected}
        canEdit={isGm || selected.ownerUserId === userId}
        send={send}
        onLevelUp={onLevelUp && (isGm || selected.ownerUserId === userId) ? () => onLevelUp(selected) : undefined}
      />
    </div>
  );
}
