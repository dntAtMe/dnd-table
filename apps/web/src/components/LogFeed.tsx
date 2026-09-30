import type { ClientMessage, LogEntry, Visibility } from '@dnd/protocol';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { RollView } from './RollView';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function Entry({ entry, mine }: { entry: LogEntry; mine: boolean }) {
  return (
    <li className={`entry entry--${entry.kind}${entry.visibility === 'gm' ? ' entry--hidden' : ''}${mine ? ' entry--mine' : ''}`}>
      <div className="entry__meta">
        <span className={`entry__author${entry.author.role === 'gm' ? ' entry__author--gm' : ''}`}>{entry.author.name}</span>
        {entry.kind === 'roll' && entry.label && <span className="entry__label">{entry.label}</span>}
        {entry.visibility === 'gm' && (
          <span className="badge badge--hidden" title="Only the author and the GM can see this">
            {entry.author.role === 'gm' ? 'Hidden' : 'To GM'}
          </span>
        )}
        <time className="entry__time" dateTime={entry.at}>
          {timeFormat.format(new Date(entry.at))}
        </time>
      </div>
      {entry.kind === 'roll' ? (
        <>
          <div className="entry__expr">{entry.roll.expression}</div>
          <RollView roll={entry.roll} />
        </>
      ) : (
        <p className="entry__text">{entry.text}</p>
      )}
    </li>
  );
}

interface Props {
  log: LogEntry[];
  myUserId?: string;
  isGm: boolean;
  onSend?: (msg: ClientMessage) => void;
}

/** Scrolling roll & chat log. Sticks to the bottom unless the reader has scrolled up. */
export function LogFeed({ log, myUserId, isGm, onSend }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !onSend) return;
    onSend({ type: 'chat', text: text.trim(), visibility });
    setText('');
    stick.current = true;
  };

  return (
    <div className="log">
      <ol className="log__list" ref={listRef}>
        {log.length === 0 && <li className="log__empty">No rolls yet. Pick up the dice!</li>}
        {log.map((entry) => (
          <Entry key={entry.id} entry={entry} mine={entry.author.userId === myUserId} />
        ))}
      </ol>
      {onSend && (
        <form className="log__chat" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={visibility === 'gm' ? (isGm ? 'Private note…' : 'Whisper to the GM…') : 'Say something…'}
            maxLength={1000}
            aria-label="Message"
          />
          <button
            type="button"
            className={`toggle${visibility === 'gm' ? ' toggle--on' : ''}`}
            onClick={() => setVisibility((v) => (v === 'gm' ? 'public' : 'gm'))}
            title={isGm ? 'Only you will see it' : 'Only you and the GM will see it'}
            aria-pressed={visibility === 'gm'}
          >
            {isGm ? 'Hidden' : 'To GM'}
          </button>
          <button type="submit" className="btn btn--primary" disabled={!text.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}
