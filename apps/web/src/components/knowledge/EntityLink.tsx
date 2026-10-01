import { KIND_LABELS, type EntryKind, type EntryRef } from '@dnd/rules';
import { useRef, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { useKnowledge } from '../../lib/knowledge';

/** Kinds that only exist once the lazily loaded data (spells, monsters, magic items) is in. */
const LAZY_KINDS = new Set<EntryKind>(['spell', 'monster', 'magic-item']);

interface Props {
  entry: EntryRef;
  children: ReactNode;
  className?: string;
  /**
   * For names inside another control (a toggle row, a choice card): renders a plain span that
   * previews on hover and pins on Ctrl/Cmd-click, but lets plain clicks through to the control.
   */
  hoverOnly?: boolean;
}

/**
 * A reference to a knowledge base entry.
 * - Mouse: resting on it previews the entry; a click (plain or Ctrl/Cmd) pins a popup next to it;
 *   Shift-click opens it in the Compendium view.
 * - Keyboard: focusing it previews; Enter pins; Shift+Enter opens it in the Compendium view.
 * - Touch: a tap pins a popup (a bottom sheet on phones).
 * The popup layer decides how those look. Clicks never reach the surrounding row or card.
 */
export function EntityLink({ entry, children, className = '', hoverOnly = false }: Props) {
  const k = useKnowledge();
  const ref = useRef<HTMLElement>(null);
  const known = k.compendium.get(entry);
  const pending = !known && k.loading && LAZY_KINDS.has(entry.kind);
  const missing = !known && !pending;

  const onPointerEnter = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && ref.current && !missing) k.hover(entry, ref.current);
  };
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && ref.current) k.unhover(entry, ref.current);
  };
  const onFocus = () => {
    const el = ref.current;
    // Keyboard focus only: a mouse click also focuses the button, but hover already handles that.
    if (el && !missing && safeMatches(el, ':focus-visible')) k.hover(entry, el);
  };
  const onBlur = () => ref.current && k.unhover(entry, ref.current);
  const onClick = (e: MouseEvent) => {
    const modified = e.ctrlKey || e.metaKey || e.shiftKey;
    if (hoverOnly && !modified) return;
    e.preventDefault();
    e.stopPropagation();
    if (missing) return;
    if (e.shiftKey) k.show(entry);
    else k.open(entry, ref.current ?? undefined);
  };

  const classes = `entity-link entity-link--${entry.kind}${missing ? ' entity-link--missing' : ''}${hoverOnly ? ' entity-link--quiet' : ''} ${className}`;
  const common = {
    className: classes,
    'data-entry': `${entry.kind}:${entry.id}`,
    title: missing ? `${KIND_LABELS[entry.kind]} not found` : undefined,
    onPointerEnter,
    onPointerLeave,
    onClick,
  };

  if (hoverOnly) {
    return (
      <span ref={ref as RefObject<HTMLSpanElement>} {...common}>
        {children}
      </span>
    );
  }
  return (
    <button ref={ref as RefObject<HTMLButtonElement>} type="button" {...common} onFocus={onFocus} onBlur={onBlur}>
      {children}
    </button>
  );
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** A link when the entry exists in the knowledge base, plain text otherwise. */
export function MaybeLink({ entry, children, hoverOnly }: { entry: EntryRef | null | undefined; children: ReactNode; hoverOnly?: boolean }) {
  const { compendium } = useKnowledge();
  if (!entry || !compendium.get(entry)) return <>{children}</>;
  return (
    <EntityLink entry={entry} hoverOnly={hoverOnly}>
      {children}
    </EntityLink>
  );
}
