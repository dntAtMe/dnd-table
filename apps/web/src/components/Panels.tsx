import type { DisplayInfo, Member } from '@dnd/protocol';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';

export function PartyList({ members }: { members: Member[] }) {
  return (
    <ul className="party">
      {members.map((m) => (
        <li key={m.userId} className={`party__member${m.online ? ' is-online' : ''}`}>
          <span className="presence-dot" aria-label={m.online ? 'online' : 'offline'} />
          <span className="party__name">{m.name}</span>
          {m.role === 'gm' && <span className="badge badge--gm">GM</span>}
        </li>
      ))}
    </ul>
  );
}

export function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard needs HTTPS or localhost; the code is on screen anyway.
    }
  };
  return (
    <div className="invite">
      <span className="code">{code}</span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function DisplaysPanel({ campaignId, displays }: { campaignId: string; displays: DisplayInfo[] }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const pair = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/campaigns/${campaignId}/displays`, { body: { code } });
      setCode('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const unpair = async (id: string) => {
    try {
      await api(`/api/campaigns/${campaignId}/displays/${id}`, { method: 'DELETE' });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="displays">
      {displays.length > 0 && (
        <ul className="displays__list">
          {displays.map((d) => (
            <li key={d.id} className={d.online ? 'is-online' : ''}>
              <span className="presence-dot" aria-label={d.online ? 'connected' : 'offline'} />
              <span>{d.name}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => unpair(d.id)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="inline-form" onSubmit={pair}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABC123"
          maxLength={8}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          aria-label="Display pairing code"
        />
        <button type="submit" className="btn" disabled={busy || code.trim().length < 4}>
          Connect
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <p className="hint">
        Open <strong>/table</strong> on the TV or shared screen, then enter the code it shows.
      </p>
    </div>
  );
}
