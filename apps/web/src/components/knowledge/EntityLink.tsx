import { KIND_LABELS, type EntryRef } from '@dnd/rules';
import { useRef, type MouseEvent, type ReactNode } from 'react';
import { useKnowledge } from '../../lib/knowledge';

/**
 * A reference to a knowledge base entry. Hover previews it, Ctrl/Cmd-click (or a tap on touch
 * screens) opens a pinned popup; the popup layer decides how those look.
 */
export function EntityLink({ entry, children, className = '' }: { entry: EntryRef; children: ReactNode; className?: string }) {
  const k = useKnowledge();
  const ref = useRef<HTMLButtonElement>(null);
  const known = k.compendium.get(entry);

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    // Plain click on touch screens opens; on desktop, plain click opens too unless something
    // else handles it — Ctrl/Cmd-click always pins.
    k.open(entry, ref.current ?? undefined);
  };

  return (
    <button
      ref={ref}
      type="button"
      className={`entity-link entity-link--${entry.kind}${known ? '' : ' entity-link--missing'} ${className}`}
      data-entry={`${entry.kind}:${entry.id}`}
      title={known ? undefined : `${KIND_LABELS[entry.kind]} not found`}
      onMouseEnter={() => ref.current && k.hover(entry, ref.current)}
      onMouseLeave={() => ref.current && k.unhover(entry, ref.current)}
      onFocus={() => ref.current && k.hover(entry, ref.current)}
      onBlur={() => ref.current && k.unhover(entry, ref.current)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
