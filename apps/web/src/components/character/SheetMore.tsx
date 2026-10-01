import { ARMOR, WEAPONS, type CharacterSpell, type EntryKind, type SpellDef } from '@dnd/rules';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useKnowledge } from '../../lib/knowledge';
import { MaybeLink } from '../knowledge/EntityLink';
import { RichText } from '../knowledge/RichText';
import { Pips } from './SheetCore';
import { signed, type CharacterActions } from './useCharacter';

const ORDINAL = ['Cantrips', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/** Loads the SRD spell list on first use (it's the biggest chunk of reference data). */
function useSpells(): Record<string, SpellDef> | null {
  const [spells, setSpells] = useState<Record<string, SpellDef> | null>(null);
  useEffect(() => {
    let alive = true;
    void import('@dnd/rules/spells').then((m) => alive && setSpells(m.SPELLS_BY_ID));
    return () => {
      alive = false;
    };
  }, []);
  return spells;
}

/** Damage for a spell cast at a slot level (or a cantrip at the character's level), from the SRD tables. */
function spellDamage(spell: SpellDef, slot: number, characterLevel: number): string | undefined {
  if (spell.damageAtCharacterLevel) {
    const levels = Object.keys(spell.damageAtCharacterLevel).map(Number).sort((x, y) => x - y);
    const at = levels.filter((l) => l <= characterLevel).pop() ?? levels[0]!;
    return spell.damageAtCharacterLevel[String(at)];
  }
  if (spell.damageAtSlot) return spell.damageAtSlot[String(slot)] ?? spell.damageAtSlot[String(spell.level)];
  return undefined;
}

export function SpellsTab({ a }: { a: CharacterActions }) {
  const { data, derived, canEdit } = a;
  const sc = derived.spellcasting;
  const spells = useSpells();
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const setSlotsLeft = (level: number, left: number) => {
    const max = sc?.slots[level - 1] ?? 0;
    const slotsUsed = [...data.state.slotsUsed];
    slotsUsed[level - 1] = max - left;
    a.patchState({ slotsUsed });
  };

  const updateSpell = (index: number, patch: Partial<CharacterSpell> | null) =>
    a.update((c) => ({
      ...c,
      spells: patch === null ? c.spells.filter((_, i) => i !== index) : c.spells.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));

  const byLevel = useMemo(() => {
    const groups = new Map<number, { spell: CharacterSpell; index: number }[]>();
    data.spells.forEach((spell, index) => groups.set(spell.level, [...(groups.get(spell.level) ?? []), { spell, index }]));
    return [...groups.entries()].sort(([x], [y]) => x - y);
  }, [data.spells]);

  const prepared = data.spells.filter((s) => s.level > 0 && s.prepared).length;
  const cantrips = data.spells.filter((s) => s.level === 0).length;

  return (
    <div className="spells">
      {sc ? (
        <section className="sheet-card spell-stats">
          <div className="stat">
            <span className="stat-label">Ability</span>
            <strong>{sc.ability.toUpperCase()}</strong>
          </div>
          <div className="stat">
            <span className="stat-label">Save DC</span>
            <strong>{sc.saveDc}</strong>
          </div>
          <button type="button" className="stat stat--roll" onClick={() => a.rollD20('attack', 'Spell attack', sc.attackBonus)}>
            <span className="stat-label">Spell attack</span>
            <strong>{signed(sc.attackBonus)}</strong>
          </button>
          <div className="stat">
            <span className="stat-label">Prepared</span>
            <strong>
              {prepared}/{sc.prepared}
            </strong>
          </div>
          <div className="stat">
            <span className="stat-label">Cantrips</span>
            <strong>
              {cantrips}/{sc.cantrips}
            </strong>
          </div>
        </section>
      ) : (
        <p className="hint">This class doesn't cast spells, but you can still track spells from feats or species traits.</p>
      )}

      {sc && sc.slots.some(Boolean) && (
        <section className="sheet-card">
          <h3>{sc.pact ? 'Pact Magic slots (Short Rest)' : 'Spell slots'}</h3>
          {sc.slots.map((max, i) =>
            max ? (
              <div key={i} className="pips-row">
                <span>{ORDINAL[i + 1]} level</span>
                <Pips count={max} used={max - (data.state.slotsUsed[i] ?? 0)} disabled={!canEdit} onChange={(left) => setSlotsLeft(i + 1, left)} />
              </div>
            ) : null,
          )}
        </section>
      )}

      <section className="sheet-card">
        <div className="sheet-card__head">
          <h3>Spells</h3>
          {canEdit && (
            <button type="button" className="btn btn--sm" onClick={() => setPicking((p) => !p)}>
              {picking ? 'Done' : '+ Add spell'}
            </button>
          )}
        </div>
        {picking && <SpellPicker a={a} spells={spells} onClose={() => setPicking(false)} />}
        {data.spells.length === 0 && !picking && <p className="hint">No spells yet.</p>}
        {byLevel.map(([level, list]) => (
          <div key={level} className="spell-group">
            <h4>{ORDINAL[level]}</h4>
            <ul>
              {list.map(({ spell, index }) => {
                const def = spell.spellId ? spells?.[spell.spellId] : undefined;
                const damage = def ? spellDamage(def, Math.max(level, 1), data.level) : undefined;
                return (
                  <li key={index} className="spell">
                    <div className="spell__row">
                      {level > 0 && (
                        <input
                          type="checkbox"
                          checked={spell.prepared}
                          disabled={!canEdit}
                          onChange={(e) => updateSpell(index, { prepared: e.target.checked })}
                          aria-label={`${spell.name} prepared`}
                          title="Prepared"
                        />
                      )}
                      <button type="button" className="spell__name" onClick={() => setOpen(open === index ? null : index)}>
                        <MaybeLink entry={spell.spellId ? { kind: 'spell', id: spell.spellId } : null} hoverOnly>
                          {spell.name}
                        </MaybeLink>
                        {def?.concentration && <span className="badge">C</span>}
                        {def?.ritual && <span className="badge">R</span>}
                      </button>
                      {def?.attack && sc && (
                        <button type="button" className="roll-btn" onClick={() => a.rollD20('attack', `${spell.name} attack`, sc.attackBonus)}>
                          {signed(sc.attackBonus)}
                        </button>
                      )}
                      {damage && (
                        <button type="button" className="roll-btn roll-btn--damage" onClick={() => a.rollDamage(`${spell.name} damage`, damage)}>
                          {damage}
                        </button>
                      )}
                    </div>
                    {open === index && (
                      <div className="spell__detail">
                        {def && (
                          <p className="muted">
                            {def.castingTime} · {def.range} · {def.components.join(', ')}
                            {def.material ? ` (${def.material})` : ''} · {def.duration}
                          </p>
                        )}
                        {def && <RichText text={def.description} self={{ kind: 'spell', id: def.id }} className="prose" />}
                        {def?.higherLevel && <RichText text={def.higherLevel} self={{ kind: 'spell', id: def.id }} className="prose" />}
                        {spell.notes && <RichText text={spell.notes} className="prose" />}
                        {canEdit && (
                          <button type="button" className="btn btn--sm btn--danger" onClick={() => updateSpell(index, null)}>
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

function SpellPicker({ a, spells, onClose }: { a: CharacterActions; spells: Record<string, SpellDef> | null; onClose: () => void }) {
  const { data, derived } = a;
  const [query, setQuery] = useState('');
  const [classOnly, setClassOnly] = useState(true);
  const [custom, setCustom] = useState({ name: '', level: 0 });
  const maxLevel = derived.spellcasting ? derived.spellcasting.slots.reduce((m, n, i) => (n ? i + 1 : m), 0) : 9;
  const known = new Set(data.spells.map((s) => s.spellId).filter(Boolean));

  const results = useMemo(() => {
    if (!spells) return [];
    const q = query.trim().toLowerCase();
    return Object.values(spells)
      .filter((s) => !known.has(s.id))
      .filter((s) => !classOnly || (s.classes.includes(data.classId) && s.level <= maxLevel))
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .slice(0, 40);
  }, [spells, query, classOnly, data.classId, maxLevel, known]);

  const add = (spell: CharacterSpell) => a.update((c) => ({ ...c, spells: [...c.spells, spell] }));

  return (
    <div className="picker">
      <div className="picker__controls">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SRD spells" autoFocus />
        <label className="check">
          <input type="checkbox" checked={classOnly} onChange={(e) => setClassOnly(e.target.checked)} />
          My class, up to level {maxLevel}
        </label>
      </div>
      {!spells ? (
        <p className="hint">Loading spells…</p>
      ) : (
        <ul className="picker__list">
          {results.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => add({ spellId: s.id, name: s.name, level: s.level, prepared: s.level > 0 })}>
                <span>{s.name}</span>
                <span className="muted">
                  {ORDINAL[s.level]} · {s.school}
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="hint">No matches.</li>}
        </ul>
      )}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!custom.name.trim()) return;
          add({ name: custom.name.trim(), level: custom.level, prepared: custom.level > 0 });
          setCustom({ name: '', level: 0 });
        }}
      >
        <input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="Or a custom spell" maxLength={80} />
        <select value={custom.level} onChange={(e) => setCustom({ ...custom, level: Number(e.target.value) })} aria-label="Spell level">
          {ORDINAL.map((o, i) => (
            <option key={i} value={i}>
              {i === 0 ? 'Cantrip' : o}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn--sm">
          Add
        </button>
      </form>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export function FeaturesTab({ a }: { a: CharacterActions }) {
  const { data, derived, canEdit } = a;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="features">
      {derived.resources.length > 0 && (
        <section className="sheet-card">
          <h3>Resources</h3>
          {derived.resources.map((r) => {
            const used = data.state.resourcesUsed[r.id] ?? 0;
            return (
              <div key={r.id} className="pips-row">
                <span>
                  {r.name}
                  {r.die && <span className="muted"> ({r.die})</span>}
                  <span className="muted resource-recharge">{r.recharge === 'short' ? 'Short Rest' : r.shortRestRegain ? 'Long Rest (1 on Short)' : 'Long Rest'}</span>
                </span>
                <Pips
                  count={r.max}
                  used={r.max - used}
                  disabled={!canEdit}
                  onChange={(left) => a.patchState({ resourcesUsed: { ...data.state.resourcesUsed, [r.id]: r.max - left } })}
                />
              </div>
            );
          })}
        </section>
      )}
      <section className="sheet-card">
        <h3>Features &amp; traits</h3>
        <ul className="feature-list">
          {derived.features.map((f, i) => {
            const key = `${f.source}:${f.name}:${i}`;
            return (
              <li key={key}>
                <button type="button" className="feature__head" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                  <span className="feature__name">
                    {/* Subclass features have no entry of their own; the name would preview the whole subclass. */}
                    <MaybeLink entry={f.ref?.kind === 'subclass' ? null : f.ref} hoverOnly>
                      {f.name}
                    </MaybeLink>
                  </span>
                  <span className="muted">
                    {f.source}
                    {f.level ? ` ${f.level}` : ''}
                  </span>
                </button>
                {open === key && <RichText text={f.description} self={f.ref} className="prose feature__desc" />}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

export function InventoryTab({ a }: { a: CharacterActions }) {
  const { data, derived, canEdit } = a;
  const [weaponId, setWeaponId] = useState('');
  const [item, setItem] = useState({ name: '', qty: 1 });
  const eq = data.equipment;
  const setEquipment = (patch: Partial<typeof eq>) => a.update((c) => ({ ...c, equipment: { ...c.equipment, ...patch } }));

  return (
    <div className="inventory">
      <section className="sheet-card">
        <h3>Armor</h3>
        <div className="field-row">
          <span>Armor</span>
          <select value={eq.armorId ?? ''} disabled={!canEdit} onChange={(e) => setEquipment({ armorId: e.target.value || null })}>
            <option value="">None</option>
            {Object.values(ARMOR)
              .filter((x) => x.category !== 'shield')
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.category}, AC {x.baseAc}
                  {x.dexBonus ? (x.maxDex !== undefined ? ` + DEX max ${x.maxDex}` : ' + DEX') : ''})
                </option>
              ))}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={eq.shield} disabled={!canEdit} onChange={(e) => setEquipment({ shield: e.target.checked })} />
          Shield (+2 AC)
        </label>
        <p className="hint">
          AC {derived.ac}: <RichText text={derived.acSource} inline />
        </p>
        {derived.warnings.map((w) => (
          <p key={w} className="form-error">
            {w}
          </p>
        ))}
      </section>

      <section className="sheet-card">
        <h3>Weapons</h3>
        <ul className="item-list">
          {eq.weapons.map((w, i) => (
            <li key={i}>
              <span>
                <MaybeLink entry={WEAPONS[w.weaponId] ? { kind: 'weapon', id: w.weaponId } : null}>{w.name || WEAPONS[w.weaponId]?.name || w.weaponId}</MaybeLink>
              </span>
              <span className="muted">
                {WEAPONS[w.weaponId]?.damage} {WEAPONS[w.weaponId]?.damageType}
              </span>
              {canEdit && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEquipment({ weapons: eq.weapons.filter((_, j) => j !== i) })} aria-label="Remove">
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (weaponId) setEquipment({ weapons: [...eq.weapons, { weaponId }] });
              setWeaponId('');
            }}
          >
            <select value={weaponId} onChange={(e) => setWeaponId(e.target.value)} aria-label="Weapon">
              <option value="">Add a weapon…</option>
              {Object.values(WEAPONS).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.category})
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn--sm" disabled={!weaponId}>
              Add
            </button>
          </form>
        )}
      </section>

      <section className="sheet-card">
        <h3>Items</h3>
        <ul className="item-list">
          {eq.items.map((it, i) => (
            <li key={i}>
              <span>
                <ItemName name={it.name} />
              </span>
              <span className="muted">×{it.qty}</span>
              {canEdit && (
                <span className="item-list__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setEquipment({ items: eq.items.map((x, j) => (j === i ? { ...x, qty: Math.max(0, x.qty - 1) } : x)) })}
                    aria-label="Use one"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setEquipment({ items: eq.items.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)) })}
                    aria-label="Add one"
                  >
                    +
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEquipment({ items: eq.items.filter((_, j) => j !== i) })} aria-label="Remove">
                    ✕
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!item.name.trim()) return;
              setEquipment({ items: [...eq.items, { name: item.name.trim(), qty: Math.max(1, item.qty) }] });
              setItem({ name: '', qty: 1 });
            }}
          >
            <input value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} placeholder="Item (e.g. Rope, 50 ft)" maxLength={80} />
            <input type="number" min={1} value={item.qty} onChange={(e) => setItem({ ...item, qty: Number(e.target.value) })} aria-label="Quantity" className="qty" />
            <button type="submit" className="btn btn--sm" disabled={!item.name.trim()}>
              Add
            </button>
          </form>
        )}
      </section>

      <section className="sheet-card">
        <h3>Coins</h3>
        <div className="coins">
          {(['pp', 'gp', 'ep', 'sp', 'cp'] as const).map((k) => (
            <label key={k} className="coin">
              <span>{k.toUpperCase()}</span>
              <input
                type="number"
                min={0}
                value={data.currency[k]}
                disabled={!canEdit}
                onChange={(e) => a.update((c) => ({ ...c, currency: { ...c.currency, [k]: Math.max(0, Math.round(Number(e.target.value) || 0)) } }))}
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

const ITEM_KINDS: EntryKind[] = ['gear', 'magic-item', 'weapon', 'armor', 'poison'];

/** An inventory item's name, linked when it names SRD gear or a magic item ("Rope", "Bag of Holding"). */
function ItemName({ name }: { name: string }) {
  const { compendium } = useKnowledge();
  const entry = ITEM_KINDS.map((kind) => compendium.byName(name, kind)).find((e) => e && ITEM_KINDS.includes(e.kind));
  return <MaybeLink entry={entry ? { kind: entry.kind, id: entry.id } : null}>{name}</MaybeLink>;
}

export function NotesTab({ a }: { a: CharacterActions }) {
  const { data, derived, canEdit } = a;
  const [notes, setNotes] = useState(data.notes);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setNotes(data.notes);
  }, [data.notes]);

  const onChange = (value: string) => {
    setNotes(value);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dirty.current = false;
      a.update((c) => ({ ...c, notes: value }));
    }, 600);
  };

  const p = derived.proficiencies;
  return (
    <div className="notes">
      <section className="sheet-card">
        <h3>Proficiencies</h3>
        <dl className="prof-list">
          <dt>Armor</dt>
          <dd>{p.armor.join(', ') || 'None'}</dd>
          <dt>Weapons</dt>
          <dd>{p.weapons.length ? <RichText text={p.weapons.join(', ')} inline /> : 'None'}</dd>
          <dt>Tools</dt>
          <dd>{p.tools.join(', ') || 'None'}</dd>
          <dt>Languages</dt>
          <dd>{p.languages.join(', ')}</dd>
          {derived.darkvision > 0 && (
            <>
              <dt>Senses</dt>
              <dd>Darkvision {derived.darkvision} ft</dd>
            </>
          )}
        </dl>
      </section>
      <section className="sheet-card">
        <h3>Notes</h3>
        <textarea
          value={notes}
          onChange={(e) => onChange(e.target.value)}
          disabled={!canEdit}
          placeholder={canEdit ? 'Backstory, allies, quests… Only you and the GM can see these.' : 'Private'}
          rows={10}
        />
      </section>
    </div>
  );
}
