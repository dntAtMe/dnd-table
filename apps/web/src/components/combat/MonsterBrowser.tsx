import { formatCr, type MonsterDef } from '@dnd/rules';
import { useMemo, useState } from 'react';
import './combat.css';

const MAX_RESULTS = 60;

interface Props {
  monsters: Record<string, MonsterDef>;
  selectedId: string | null;
  onSelect: (m: MonsterDef) => void;
}

/** Searchable SRD bestiary with a challenge rating range. */
export function MonsterBrowser({ monsters, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [crMin, setCrMin] = useState(0);
  const [crMax, setCrMax] = useState(30);
  const list = useMemo(() => Object.values(monsters), [monsters]);
  const crs = useMemo(() => [...new Set(list.map((m) => m.cr))].sort((a, b) => a - b), [list]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((m) => m.cr >= crMin && m.cr <= crMax && (!q || m.name.toLowerCase().includes(q) || m.type.includes(q)));
  }, [list, query, crMin, crMax]);

  return (
    <div className="monster-browser">
      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search monsters or types (e.g. goblin, undead)" aria-label="Search monsters" />
      <div className="monster-browser__filters">
        <label className="field-row">
          <span>CR from</span>
          <select value={crMin} onChange={(e) => setCrMin(Number(e.target.value))}>
            {crs.map((cr) => (
              <option key={cr} value={cr}>
                {formatCr(cr)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span>to</span>
          <select value={crMax} onChange={(e) => setCrMax(Number(e.target.value))}>
            {crs.map((cr) => (
              <option key={cr} value={cr}>
                {formatCr(cr)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">{results.length} found</span>
      </div>
      <ul className="monster-browser__list">
        {results.slice(0, MAX_RESULTS).map((m) => (
          <li key={m.id}>
            <button type="button" className={m.id === selectedId ? 'is-active' : ''} onClick={() => onSelect(m)}>
              <span className="monster-browser__name">{m.name}</span>
              <span className="muted">
                CR {formatCr(m.cr)} · {m.size} {m.type}
              </span>
              <span className="monster-browser__stats">
                AC {m.ac} · HP {m.hp}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {results.length > MAX_RESULTS && <p className="hint">{results.length - MAX_RESULTS} more: refine the search.</p>}
    </div>
  );
}
