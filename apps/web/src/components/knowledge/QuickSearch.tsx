import type { IndexEntry } from '@dnd/rules';
import { refKey } from '@dnd/rules';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useKnowledge } from '../../lib/knowledge';
import { KindBadge } from './KindBadge';
import './compendium.css';

const MAX_RESULTS = 30;

/** Ctrl/Cmd+K toggles the palette (also from inside text fields). */
export function useQuickSearchShortcut(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

/**
 * Command-palette search over the whole knowledge base. ↑/↓ move, Enter pins a popup for the
 * entry, Shift+Enter (or Shift-click) opens it in the Compendium view, Escape closes.
 */
export function QuickSearch({ onClose }: { onClose: () => void }) {
  const k = useKnowledge();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const results = useMemo(() => (query.trim() ? k.compendium.search(query, { limit: MAX_RESULTS }) : []), [k.compendium, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (entry: IndexEntry, inCompendium: boolean) => {
    const ref = { kind: entry.kind, id: entry.id };
    if (inCompendium) {
      onClose();
      k.show(ref);
    } else {
      // Pin a popup under the search box (measured now, before the palette goes away).
      k.open(ref, input.current ?? undefined);
      onClose();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % results.length : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = results[active];
      if (entry) choose(entry, e.shiftKey);
    }
  };

  return createPortal(
    <div data-kb-modal>
      <div className="qs-backdrop" onPointerDown={onClose} />
      <div className="qs" role="dialog" aria-modal="true" aria-label="Search the compendium">
        <input
          ref={input}
          className="qs__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search spells, monsters, rules, items, pages…"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
        />
        {query.trim() && (
          <ul className="qs__list" id={listId} role="listbox" ref={list}>
            {results.map((e, i) => (
              <li
                key={refKey(e)}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="qs__item"
                onPointerMove={() => setActive(i)}
                onClick={(ev) => choose(e, ev.shiftKey)}
              >
                <span className="qs__name">{e.name}</span>
                <KindBadge kind={e.kind} />
                <span className="qs__summary">{e.summary}</span>
              </li>
            ))}
            {results.length === 0 && <li className="qs__empty">{k.loading ? 'Nothing yet: spells, monsters and items are still loading.' : 'No matches.'}</li>}
          </ul>
        )}
        <p className="qs__hint">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> pin a popup · <kbd>Shift</kbd>+<kbd>Enter</kbd> open in the Compendium · <kbd>Esc</kbd> close
        </p>
      </div>
    </div>,
    document.body,
  );
}
