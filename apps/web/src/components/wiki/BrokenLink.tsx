import { useEffect, useRef, useState } from 'react';
import { useCreatePageFromLink } from './wikiStore';
import './wiki.css';

/**
 * A [[link]] to a page that doesn't exist. For the GM it's a button offering to create the page;
 * for everyone else plain "missing" text. Drop-in for the broken-link span in RichText.
 */
export function BrokenLink({ name, children }: { name: string; children?: React.ReactNode }) {
  const create = useCreatePageFromLink();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!create) {
    return (
      <span className="entity-link entity-link--broken" title="No page with this name">
        {children ?? name}
      </span>
    );
  }
  return (
    <span ref={ref} className="broken-link">
      <button
        type="button"
        className="entity-link entity-link--broken broken-link__button"
        title={`No page called "${name}" yet`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {children ?? name}
      </button>
      {open && (
        <span className="broken-link__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="btn btn--sm btn--primary"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              create(name);
            }}
          >
            Create page "{name}"
          </button>
        </span>
      )}
    </span>
  );
}
