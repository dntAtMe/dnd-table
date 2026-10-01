import { KIND_LABELS, type EntryKind, type EntryRef } from '@dnd/rules';
import type { ReactNode } from 'react';
import { useKnowledge } from '../../lib/knowledge';
import { BUILTIN_BODIES, SUMMARY_IN_BODY, SummaryBody } from './EntryBodies';
import { useEntryRenderer } from './renderers';
import './knowledge.css';

const LAZY_KINDS = new Set<EntryKind>(['spell', 'monster', 'magic-item']);

interface Props {
  entryRef: EntryRef;
  /** 'popup' is compact; 'full' is the Compendium view's detail pane. */
  size?: 'popup' | 'full';
  /** Extra controls in the header (pin and close in popups, history in the Compendium view). */
  actions?: ReactNode;
  /** Hide the "Open in Compendium" button (e.g. already in the Compendium view). */
  hideOpen?: boolean;
}

/** One knowledge base entry: a header (kind, name, summary) and a body that depends on the kind. */
export function EntryCard({ entryRef, size = 'popup', actions, hideOpen = size === 'full' }: Props) {
  const k = useKnowledge();
  const entry = k.compendium.get(entryRef);
  const Registered = useEntryRenderer(entryRef.kind);

  if (!entry) {
    const pending = k.loading && LAZY_KINDS.has(entryRef.kind);
    return (
      <article className={`kb-card kb-card--${size} kb-card--${entryRef.kind}`}>
        <header className="kb-card__head">
          <div className="kb-card__titles">
            <span className="kb-card__kind">{KIND_LABELS[entryRef.kind]}</span>
            <h3 className="kb-card__name">{pending ? 'Loading…' : 'Not found'}</h3>
          </div>
          {actions && <div className="kb-card__actions">{actions}</div>}
        </header>
        <div className="kb-card__body">
          <p className={pending ? 'kb-loading' : 'kb-muted'}>{pending ? 'Fetching the SRD reference…' : 'This entry is not in the knowledge base (it may have been removed).'}</p>
        </div>
      </article>
    );
  }

  const Body = Registered ?? BUILTIN_BODIES[entry.kind] ?? SummaryBody;
  const summaryInBody = Body === SummaryBody || (!Registered && SUMMARY_IN_BODY.has(entry.kind));

  return (
    <article className={`kb-card kb-card--${size} kb-card--${entry.kind}`}>
      <header className="kb-card__head">
        <div className="kb-card__titles">
          <span className="kb-card__kind">{KIND_LABELS[entry.kind]}</span>
          <h3 className="kb-card__name">{entry.name}</h3>
          {!summaryInBody && entry.summary && <p className="kb-card__summary">{entry.summary}</p>}
        </div>
        {actions && <div className="kb-card__actions">{actions}</div>}
      </header>
      <div className="kb-card__body">
        <Body entry={entry} size={size} />
      </div>
      {!hideOpen && (
        <footer className="kb-card__foot">
          <button type="button" className="kb-card__open" onClick={() => k.show(entryRef)} title="Shift-click a link to go straight there">
            Open in Compendium
          </button>
        </footer>
      )}
    </article>
  );
}
