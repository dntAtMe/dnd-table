import type { HandoutView, Showcase } from '@dnd/protocol';
import { useEffect, useRef, useState } from 'react';
import { HandoutText } from './HandoutText';
import './handouts.css';

/**
 * A handout or image shown over the map: full-bleed on table screens, a dismissable popup on
 * players' screens.
 */
export function ShowcaseOverlay({ showcase, onClose }: { showcase: Showcase; onClose?: () => void }) {
  const popup = Boolean(onClose);
  const hasText = Boolean(showcase.text.trim());

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={`showcase${popup ? ' showcase--popup' : ''}${showcase.imageUrl ? '' : ' showcase--text-only'}`}
      role={popup ? 'dialog' : undefined}
      aria-modal={popup || undefined}
      aria-label={showcase.title || 'Handout'}
      key={showcase.id}
    >
      <div className={`showcase__frame${hasText && showcase.imageUrl ? ' showcase__frame--split' : ''}`}>
        {showcase.imageUrl && <img src={showcase.imageUrl} alt={showcase.title} className="showcase__image" />}
        {(showcase.title || hasText) && (
          <div className="showcase__body">
            {showcase.title && <h2 className="showcase__title">{showcase.title}</h2>}
            <HandoutText text={showcase.text} className="showcase__text" />
          </div>
        )}
      </div>
      {onClose && (
        <button type="button" className="btn showcase__close" onClick={onClose}>
          Close
        </button>
      )}
    </div>
  );
}

/** Players: the showcase popup unless they've closed this particular one. */
export function usePlayerShowcase(showcase: Showcase | null): [Showcase | null, () => void] {
  const [closedId, setClosedId] = useState<string | null>(null);
  const visible = showcase && showcase.toPlayers && showcase.id !== closedId ? showcase : null;
  return [visible, () => setClosedId(showcase?.id ?? null)];
}

export interface HandoutNotice {
  id: string;
  title: string;
  updated: boolean;
}

/**
 * Players: a notice when a handout is newly shared with them (or changes) while they're
 * connected. The list sent on connect doesn't count.
 */
export function useHandoutNotice(handouts: HandoutView[], enabled: boolean): [HandoutNotice | null, () => void] {
  const seen = useRef<Map<string, string | null> | null>(null);
  const [notice, setNotice] = useState<HandoutNotice | null>(null);

  useEffect(() => {
    if (!enabled) {
      seen.current = null;
      return;
    }
    const before = seen.current;
    seen.current = new Map(handouts.map((h) => [h.id, h.sharedAt]));
    if (!before) return;
    const fresh = handouts.find((h) => h.unread && before.get(h.id) !== h.sharedAt);
    if (fresh) setNotice({ id: fresh.id, title: fresh.title, updated: before.has(fresh.id) });
  }, [handouts, enabled]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  return [notice, () => setNotice(null)];
}
