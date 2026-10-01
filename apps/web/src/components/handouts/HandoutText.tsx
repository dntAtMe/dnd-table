import { RichText } from '../knowledge/RichText';
import './handouts.css';

/**
 * Plain handout text: blank lines start a new paragraph, single line breaks are kept, names of
 * knowledge base entries become links. Never parsed as HTML.
 */
export function HandoutText({ text, className = '' }: { text: string; className?: string }) {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim());
  if (paragraphs.length === 0) return null;
  return (
    <div className={`handout-text ${className}`}>
      {paragraphs.map((p, i) => (
        <p key={i}>
          <RichText text={p} inline />
        </p>
      ))}
    </div>
  );
}
