import { KIND_LABELS, completeLink, linkMarkup, linkQueryAt, linkSuggestions, type IndexEntry } from '@dnd/rules';
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useKnowledge } from '../../lib/knowledge';
import './wiki.css';

interface LinkTextareaProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  'aria-label'?: string;
  id?: string;
  /** Left out of the suggestions (the page being edited). */
  exclude?: { kind: string; id: string };
}

/**
 * A textarea that suggests knowledge base entries (campaign pages first) while a [[link]] is being
 * typed. Arrow keys pick, Enter or Tab inserts, Escape dismisses.
 */
export function LinkTextarea({ value, onChange, rows = 10, maxLength, placeholder, id, exclude, ...rest }: LinkTextareaProps) {
  const { compendium } = useKnowledge();
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  /** Start of a [[ the user dismissed with Escape; stays closed until another [[. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const query = caret === null ? null : linkQueryAt(value, caret);
  const open = query !== null && query.start !== dismissed;
  const typed = open ? query.query : null;
  const excludeKey = exclude ? `${exclude.kind}:${exclude.id}` : '';
  const suggestions = useMemo<IndexEntry[]>(() => {
    if (typed === null) return [];
    return linkSuggestions(compendium, typed, 9)
      .filter((e) => `${e.kind}:${e.id}` !== excludeKey)
      .slice(0, 8);
  }, [typed, compendium, excludeKey]);
  const shown = open && suggestions.length > 0;

  // Put the caret after an inserted link once React has rendered the new text.
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !ref.current) return;
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  const syncCaret = () => {
    const el = ref.current;
    if (el) setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };

  const choose = (entry: IndexEntry) => {
    if (!query || caret === null) return;
    const next = completeLink(value, caret, query, linkMarkup(compendium, entry));
    pendingCaret.current = next.caret;
    onChange(next.text);
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shown) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      choose(suggestions[Math.min(active, suggestions.length - 1)]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(query!.start);
    }
  };

  return (
    <div className="link-textarea">
      <textarea
        ref={ref}
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={rest['aria-label']}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          const el = e.target;
          setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
          if (dismissed !== null && linkQueryAt(e.target.value, el.selectionStart)?.start !== dismissed) setDismissed(null);
        }}
        onSelect={syncCaret}
        onKeyDown={onKeyDown}
        onBlur={() => setCaret(null)}
        onFocus={syncCaret}
      />
      {shown && (
        <ul className="link-suggest" id={listId} role="listbox" aria-label="Link to">
          {suggestions.map((entry, i) => (
            <li
              key={`${entry.kind}:${entry.id}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`link-suggest__item${i === active ? ' is-active' : ''}`}
              // Keep focus (and the caret) in the textarea.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(entry)}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`link-suggest__name entity-link--${entry.kind}`}>{entry.name}</span>
              <span className="link-suggest__kind">{KIND_LABELS[entry.kind]}</span>
              <span className="link-suggest__summary">{entry.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
