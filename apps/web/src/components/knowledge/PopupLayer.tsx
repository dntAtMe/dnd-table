import { KIND_LABELS, type EntryRef } from '@dnd/rules';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useKnowledge, useKnowledgeHandlers, useStableHandlers } from '../../lib/knowledge';
import { EntryCard } from './EntryCard';
import {
  EMPTY_STACK,
  closePopup,
  closeTop,
  depth,
  openPopup,
  pinPopup,
  placePopup,
  pruneHover,
  raisePopup,
  topPreview,
  type Box,
  type Placement,
  type Popup,
  type PopupStack,
} from './popupStack';
import './knowledge.css';

/** How long the pointer rests on a link before its preview shows. */
const HOVER_DELAY = 350;
/** Grace period for moving the pointer from a link into its preview (or between popups). */
const LEAVE_GRACE = 250;
/** Phones: popups become bottom sheets. */
const SHEET_QUERY = '(max-width: 640px)';

const toBox = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height });

function popupIdOf(el: Element | null | undefined): number | null {
  const host = el?.closest?.<HTMLElement>('[data-popup-id]');
  return host ? Number(host.dataset.popupId) : null;
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}

interface Props {
  /** Opens an entry in the Compendium view; without it, "open in Compendium" pins a popup instead. */
  onShow?: (ref: EntryRef) => void;
}

/**
 * Knowledge base popups, Hearts of Iron IV style. Install once per page; it provides the link
 * behaviour for every EntityLink below the KnowledgeProvider.
 *
 * - Hover (mouse): resting on a link for 350 ms previews it beside the link. Moving into the
 *   preview keeps it open; leaving both closes it after a short grace period.
 * - Pin: clicking a link (plain or Ctrl/Cmd), clicking inside a preview, its pin button or Space
 *   while a preview shows pins it. Pinned popups stay until closed (×, Escape for the topmost).
 *   A click elsewhere closes unpinned previews only.
 * - Nesting: links inside a popup open popups beside it (preview or pinned, same rules). Pinning a
 *   nested popup pins the chain it came from; closing a popup closes the ones opened from it.
 *   Six levels deep, a link replaces the deepest popup's content instead.
 * - Touch / phones: a tap pins; on narrow screens popups are bottom sheets over a backdrop.
 * - Shift-click (Shift+Enter) on a link, or "Open in Compendium", goes to the Compendium view.
 */
export function PopupLayer({ onShow }: Props) {
  const [stack, setStack] = useState<PopupStack>(EMPTY_STACK);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const sheet = useMediaQuery(SHEET_QUERY);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pruneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The popup under the mouse, kept open (with the chain it came from) when previews prune. */
  const pointerIn = useRef<number | null>(null);

  const openAt = (ref: EntryRef, anchor: HTMLElement | undefined, pinned: boolean) => {
    const parentId = popupIdOf(anchor);
    const anchorBox = anchor?.isConnected ? toBox(anchor.getBoundingClientRect()) : null;
    const parentEl = parentId !== null ? document.querySelector(`[data-popup-id="${parentId}"]`) : null;
    const beside = parentEl ? toBox(parentEl.getBoundingClientRect()) : null;
    setStack((s) => openPopup(s, { ref, parentId, pinned, anchor: anchorBox, beside }).stack);
  };
  const cancelPrune = () => clearTimeout(pruneTimer.current);
  const schedulePrune = () => {
    clearTimeout(pruneTimer.current);
    pruneTimer.current = setTimeout(() => setStack((s) => pruneHover(s, pointerIn.current)), LEAVE_GRACE);
  };

  const handlers = useStableHandlers({
    hover(ref, anchor) {
      cancelPrune();
      clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => anchor.isConnected && openAt(ref, anchor, false), HOVER_DELAY);
    },
    unhover() {
      clearTimeout(hoverTimer.current);
      schedulePrune();
    },
    open(ref, anchor) {
      clearTimeout(hoverTimer.current);
      cancelPrune();
      openAt(ref, anchor, true);
    },
    show(ref) {
      clearTimeout(hoverTimer.current);
      setStack(EMPTY_STACK);
      if (onShow) onShow(ref);
      else openAt(ref, undefined, true);
    },
  });
  useKnowledgeHandlers(handlers);

  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current);
      clearTimeout(pruneTimer.current);
    },
    [],
  );

  // Escape closes the topmost popup; Space pins the preview that's showing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stackRef.current;
      if (!s.items.length) return;
      const target = e.target as Element | null;
      if (target?.closest?.('[data-kb-modal]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setStack(closeTop);
        return;
      }
      if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const preview = topPreview(s);
        const neutral = !target || target === document.body || popupIdOf(target) !== null || target.closest?.('.entity-link');
        if (!preview || !neutral) return;
        e.preventDefault();
        setStack((st) => pinPopup(st, preview.id));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Pointer down: inside a popup pins it and brings it to the front; elsewhere closes previews
  // (on phones, the backdrop closes the top sheet). The wheel outside popups closes previews too.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!stackRef.current.items.length) return;
      const target = e.target as Element | null;
      const pid = popupIdOf(target);
      if (pid !== null) {
        setStack((s) => raisePopup(pinPopup(s, pid), pid));
        return;
      }
      if (target?.closest?.('.entity-link, [data-kb-modal]')) return;
      if (sheetRef.current) setStack(closeTop);
      else setStack((s) => pruneHover(s, null));
    };
    const onWheel = (e: WheelEvent) => {
      if (!stackRef.current.items.some((p) => !p.pinned)) return;
      if (popupIdOf(e.target as Element) === null) setStack((s) => pruneHover(s, null));
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('wheel', onWheel, true);
    };
  }, []);

  if (!stack.items.length) return null;
  return createPortal(
    <div className={`kb-layer${sheet ? ' kb-layer--sheet' : ''}`}>
      {sheet && <div className="kb-backdrop" aria-hidden="true" />}
      {stack.items.map((p, i) => (
        <PopupFrame
          key={p.id}
          popup={p}
          index={i}
          level={depth(stack, p.id)}
          sheet={sheet}
          onClose={() => setStack((s) => closePopup(s, p.id))}
          onPin={() => setStack((s) => pinPopup(s, p.id))}
          onEnter={() => {
            pointerIn.current = p.id;
            cancelPrune();
          }}
          onLeave={() => {
            if (pointerIn.current === p.id) pointerIn.current = null;
            schedulePrune();
          }}
        />
      ))}
    </div>,
    document.body,
  );
}

interface FrameProps {
  popup: Popup;
  index: number;
  level: number;
  sheet: boolean;
  onClose: () => void;
  onPin: () => void;
  onEnter: () => void;
  onLeave: () => void;
}

function PopupFrame({ popup, index, level, sheet, onClose, onPin, onEnter, onLeave }: FrameProps) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  const { compendium } = useKnowledge();
  const name = compendium.get(popup.ref)?.name ?? KIND_LABELS[popup.ref.kind];

  // Measure, then place beside the link or parent popup; again whenever the content resizes
  // (e.g. spell details arriving) or the window does.
  useLayoutEffect(() => {
    const node = el.current;
    if (!node || sheet) return;
    const place = () => {
      const next = placePopup({
        size: { width: node.offsetWidth, height: node.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        anchor: popup.anchor,
        beside: popup.beside,
      });
      setPos((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.side === next.side ? prev : next));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(node);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [popup.anchor, popup.beside, sheet]);

  const style = sheet
    ? { zIndex: 81 + index, ['--kb-level' as string]: level }
    : { zIndex: 81 + index, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? undefined : ('hidden' as const) };

  return (
    <div
      ref={el}
      className={`kb-popup${popup.pinned ? ' is-pinned' : ''}${level > 1 ? ' is-nested' : ''}${pos ? ` kb-popup--${pos.side}` : ''}`}
      data-popup-id={popup.id}
      role="dialog"
      aria-label={name}
      style={style}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onEnter()}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onLeave()}
    >
      <EntryCard
        key={`${popup.ref.kind}:${popup.ref.id}`}
        entryRef={popup.ref}
        size="popup"
        actions={
          <>
            {popup.pinned ? (
              <span className="kb-icon-btn kb-icon-btn--static is-on" title="Pinned: stays until you close it" aria-label="Pinned">
                <PinIcon />
              </span>
            ) : (
              <button type="button" className="kb-icon-btn" onClick={onPin} title="Pin (Space or click inside)" aria-label="Pin">
                <PinIcon />
              </button>
            )}
            <button type="button" className="kb-icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
              ×
            </button>
          </>
        }
      />
    </div>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M10.5 1.5 14.5 5.5 12 6.5 9.5 9 10 12.5 8.5 14 6 11.5 2.5 15 1 13.5 4.5 10 2 7.5 3.5 6 7 6.5 9.5 4z" fill="currentColor" />
    </svg>
  );
}
