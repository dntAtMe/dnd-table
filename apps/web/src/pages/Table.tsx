import type { LogEntry, NewDisplay } from '@dnd/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RollView } from '../components/RollView';
import { InitiativeStrip } from '../components/combat/InitiativeStrip';
import { tokenDecorations } from '../components/combat/TokenDecor';
import { ShowcaseOverlay } from '../components/handouts/Showcase';
import { MapView } from '../components/map/MapView';
import { api, errorMessage } from '../lib/api';
import { useGameSocket } from '../lib/useGameSocket';

const TOKEN_KEY = 'dnd-table.displayToken';
const SPOTLIGHT_MS = 7000;

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode: the display just re-pairs after a reload.
  }
}

/** A display identity survives reloads so the TV reconnects to its campaign by itself. */
function useDisplayToken() {
  const [token, setToken] = useState<string | null>(readToken);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (token) return;
    let cancelled = false;
    api<NewDisplay>('/api/displays', { method: 'POST' })
      .then((d) => {
        if (cancelled) return;
        writeToken(d.token);
        setToken(d.token);
      })
      .catch((err) => setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const reset = useCallback(() => {
    writeToken(null);
    setToken(null);
  }, []);
  return { token, error, reset };
}

function Spotlight({ entry }: { entry: Extract<LogEntry, { kind: 'roll' }> }) {
  return (
    <div className={`spotlight${entry.roll.natural ? ` spotlight--${entry.roll.natural}` : ''}`} key={entry.id}>
      <div className="spotlight__who">
        <span className="spotlight__name">{entry.author.name}</span>
        {entry.label && <span className="spotlight__label">{entry.label}</span>}
      </div>
      <div className="spotlight__expr">{entry.roll.expression}</div>
      <RollView roll={entry.roll} size="lg" />
    </div>
  );
}

export function Table() {
  const { token, error, reset } = useDisplayToken();
  const { state } = useGameSocket(token ? `display=${encodeURIComponent(token)}` : null);
  const [spotlight, setSpotlight] = useState<Extract<LogEntry, { kind: 'roll' }>>();
  const lastSeen = useRef<number | null>(null);
  const decorations = useMemo(() => tokenDecorations(state.combat, state.scene?.tokens ?? [], { isGm: false }), [state.combat, state.scene?.tokens]);

  // The server forgot this display (e.g. a fresh database): get a new identity.
  const failed = Boolean(state.failure);
  useEffect(() => {
    if (failed) reset();
  }, [failed, reset]);

  // Spotlight rolls that arrive live, not the history sent on connect.
  useEffect(() => {
    const latest = state.log.at(-1);
    if (lastSeen.current === null) {
      if (state.hello) lastSeen.current = latest?.id ?? 0;
      return;
    }
    if (!latest || latest.id <= lastSeen.current) return;
    lastSeen.current = latest.id;
    if (latest.kind === 'roll') setSpotlight(latest);
  }, [state.log, state.hello]);

  useEffect(() => {
    if (!spotlight) return;
    const t = setTimeout(() => setSpotlight(undefined), SPOTLIGHT_MS);
    return () => clearTimeout(t);
  }, [spotlight]);

  useEffect(() => {
    if (state.hello) document.title = `${state.hello.campaign.name} · Table`;
  }, [state.hello]);

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  if (error) {
    return (
      <div className="table table--center">
        <p className="form-error">Can't reach the server: {error}</p>
      </div>
    );
  }

  if (state.unpairedCode) {
    return (
      <div className="table table--center">
        <div className="pairing">
          <div className="brand brand--lg">
            <img src="/favicon.svg" alt="" width={48} height={48} />
            <h1>dnd-table</h1>
          </div>
          <p className="pairing__lead">Connect this screen to a campaign</p>
          <div className="pairing__code" aria-label={`Pairing code ${state.unpairedCode.split('').join(' ')}`}>
            {state.unpairedCode.split('').map((ch, i) => (
              <span key={i}>{ch}</span>
            ))}
          </div>
          <p className="pairing__hint">
            On the GM's screen, open the campaign and enter this code under <strong>Table displays</strong>.
          </p>
        </div>
      </div>
    );
  }

  if (!state.hello) {
    return (
      <div className="table table--center">
        <p className="muted">{state.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</p>
      </div>
    );
  }

  const recent = state.log.slice(-8).reverse();

  return (
    <div className="table">
      <header className="table__header">
        <h1>{state.hello.campaign.name}</h1>
        <ul className="table__party">
          {state.members
            .filter((m) => m.role === 'player')
            .map((m) => (
              <li key={m.userId} className={m.online ? 'is-online' : ''}>
                <span className="presence-dot" />
                {m.name}
              </li>
            ))}
        </ul>
        <button type="button" className="btn btn--ghost btn--sm table__fs" onClick={fullscreen}>
          Fullscreen
        </button>
      </header>

      <main className="table__stage">
        {state.scene ? (
          <MapView scene={state.scene} isGm={false} interactive={false} camera={state.camera?.rect} pings={state.pings} decorations={decorations} />
        ) : (
          !spotlight && (
            <div className="table__idle">
              <svg viewBox="0 0 64 64" className="table__idle-mark" aria-hidden="true">
                <path d="M32 3 57 17.5v29L32 61 7 46.5v-29z" />
                <path d="m32 14 15 26H17z" />
              </svg>
              <p>Waiting for the GM to show a map.</p>
            </div>
          )
        )}
        {state.combat && state.combat.combatants.length > 0 && (
          <div className="table__initiative">
            <InitiativeStrip combat={state.combat} size="lg" max={7} />
          </div>
        )}
        {state.showcase && <ShowcaseOverlay showcase={state.showcase} />}
        {spotlight && (
          <div className={`table__spotlight${state.scene || state.showcase ? ' table__spotlight--over-map' : ''}`}>
            <Spotlight entry={spotlight} />
          </div>
        )}
      </main>

      <aside className="table__log">
        <h2>Recent rolls</h2>
        <ol>
          {recent.map((e) => (
            <li key={e.id}>
              <span className="table__log-name">{e.author.name}</span>
              {e.kind === 'roll' ? (
                <>
                  <span className="table__log-label">{e.label ?? e.roll.expression}</span>
                  <span className={`table__log-total${e.roll.natural ? ` is-${e.roll.natural}` : ''}`}>{e.roll.total}</span>
                </>
              ) : (
                <span className="table__log-text">{e.text}</span>
              )}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
