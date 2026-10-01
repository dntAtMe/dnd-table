import type { EntryRef } from '@dnd/rules';
import { Fragment } from 'react';
import { useLinkedText } from '../../lib/knowledge';
import { EntityLink } from './EntityLink';

interface Props {
  text: string;
  /** The entry this text describes: not linked to itself. */
  self?: EntryRef;
  className?: string;
  /** A span instead of a div, for text inside a line. */
  inline?: boolean;
  /** For text inside a button or label: links preview on hover and pin on Ctrl/Cmd-click only. */
  hoverOnly?: boolean;
}

/**
 * Plain text with knowledge base links: names found automatically and explicit [[links]].
 * Blank lines become paragraphs, single newlines line breaks, **bold** runs bold. Never renders
 * HTML from the text.
 */
export function RichText({ text, self, className = '', inline = false, hoverOnly = false }: Props) {
  const segments = useLinkedText(text, self);
  const content = segments.map((seg, i) =>
    seg.ref ? (
      <EntityLink key={i} entry={seg.ref} hoverOnly={hoverOnly}>
        {seg.text}
      </EntityLink>
    ) : seg.broken ? (
      <span key={i} className="entity-link entity-link--broken" title="No page with this name">
        {seg.text}
      </span>
    ) : (
      <Fragment key={i}>{formatPlain(seg.text, i)}</Fragment>
    ),
  );
  if (inline) return <span className={`rich-text ${className}`}>{content}</span>;
  return <div className={`rich-text ${className}`}>{content}</div>;
}

/** Newlines and **bold** inside a plain run. Paragraph spacing comes from CSS (white-space: pre-line). */
function formatPlain(text: string, key: number) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, j) =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={`${key}-${j}`}>{p.slice(2, -2)}</strong> : <Fragment key={`${key}-${j}`}>{p}</Fragment>,
  );
}
