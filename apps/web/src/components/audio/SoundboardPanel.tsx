import { TRACK_KINDS, type AudioLayer, type AudioState, type ClientMessage, type Track, type TrackKind } from '@dnd/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../../lib/api';
import { AUDIO_ACCEPT, uploadFile } from '../../lib/uploads';
import './audio.css';

type Send = (msg: ClientMessage) => void;

const KIND_LABELS: Record<TrackKind, string> = { music: 'Music', ambience: 'Ambience', effect: 'Effects' };
const KIND_HINTS: Record<TrackKind, string> = {
  music: 'One at a time; starting another crossfades.',
  ambience: 'Layers that play together (rain, tavern chatter).',
  effect: 'One-shots (a door, thunder). Looping effects act like ambience.',
};

/** Sends at most every `ms` while a slider moves, always ending on the latest value. */
function useThrottle<T>(fn: (value: T) => void, ms: number): (value: T) => void {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef<T>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return (value: T) => {
    latest.current = value;
    const wait = ms - (Date.now() - last.current);
    if (wait <= 0) {
      last.current = Date.now();
      fnRef.current(value);
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        last.current = Date.now();
        fnRef.current(latest.current as T);
      }, wait);
    }
  };
}

/** A volume slider that follows the server value except while being dragged. */
function VolumeSlider({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  const send = useThrottle(onChange, 150);
  return (
    <input
      type="range"
      className="volume"
      min={0}
      max={1}
      step={0.01}
      value={local}
      aria-label={label}
      onPointerDown={() => (dragging.current = true)}
      onPointerUp={() => (dragging.current = false)}
      onChange={(e) => {
        const v = Number(e.target.value);
        setLocal(v);
        send(v);
      }}
    />
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 2.5h3v11H4zm5 0h3v11H9z" fill="currentColor" />
  </svg>
);
const StopIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 3.5h9v9h-9z" fill="currentColor" />
  </svg>
);

/** Reads a local audio file's duration so the server knows when one-shot layers end. */
function audioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    const done = (d: number | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      resolve(d && Number.isFinite(d) && d > 0 ? Math.round(d * 100) / 100 : null);
    };
    const timer = setTimeout(() => done(null), 5000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(null);
    el.src = url;
  });
}

interface SoundboardProps {
  campaignId: string;
  tracks: Track[];
  audio: AudioState;
  send: Send;
}

/** GM: the campaign's tracks, what's playing, and volume. */
export function SoundboardPanel({ campaignId, tracks, audio, send }: SoundboardProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const layers = new Map(audio.layers.map((l) => [l.trackId, l]));

  return (
    <div className="soundboard">
      <div className="soundboard__master">
        <span className="soundboard__label">Master</span>
        <VolumeSlider value={audio.volume} label="Master volume" onChange={(volume) => send({ type: 'audio:volume', trackId: null, volume })} />
        <button type="button" className="btn btn--sm" disabled={audio.layers.length === 0} onClick={() => send({ type: 'audio:stop-all' })}>
          Stop all
        </button>
      </div>

      {tracks.length === 0 && !adding && <p className="hint">Upload music, ambience and sound effects. Table screens play them; players can opt in.</p>}

      {TRACK_KINDS.map((kind) => {
        const list = tracks.filter((t) => t.kind === kind);
        if (list.length === 0) return null;
        return (
          <div key={kind} className="soundboard__group">
            <h3 className="soundboard__kind" title={KIND_HINTS[kind]}>
              {KIND_LABELS[kind]}
            </h3>
            <ul className="soundboard__list">
              {list.map((t) =>
                editing === t.id ? (
                  <li key={t.id}>
                    <TrackEditor track={t} send={send} onDone={() => setEditing(null)} />
                  </li>
                ) : (
                  <li key={t.id}>
                    <TrackRow track={t} layer={layers.get(t.id)} send={send} onEdit={() => setEditing(t.id)} />
                  </li>
                ),
              )}
            </ul>
          </div>
        );
      })}

      {adding ? (
        <AddTrack campaignId={campaignId} send={send} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn btn--sm soundboard__add" onClick={() => setAdding(true)}>
          Add track
        </button>
      )}
    </div>
  );
}

function TrackRow({ track, layer, send, onEdit }: { track: Track; layer?: AudioLayer; send: Send; onEdit: () => void }) {
  const playing = layer?.playing ?? false;
  const oneShot = track.kind === 'effect' && !track.loop;
  return (
    <div className={`track${layer ? ' track--active' : ''}${playing ? ' track--playing' : ''}`}>
      <div className="track__main">
        <button
          type="button"
          className="track__play"
          onClick={() => send({ type: playing ? 'audio:pause' : 'audio:play', trackId: track.id })}
          aria-label={`${playing ? 'Pause' : 'Play'} ${track.name}`}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button type="button" className="track__name" onClick={onEdit} title="Edit track">
          {track.name}
          {track.loop && !oneShot && (
            <span className="track__loop" aria-label="loops">
              ↻
            </span>
          )}
        </button>
        {playing && <span className="track__bars" aria-hidden="true"><i /><i /><i /></span>}
        {layer && (
          <button type="button" className="track__stop" onClick={() => send({ type: 'audio:stop', trackId: track.id })} aria-label={`Stop ${track.name}`}>
            <StopIcon />
          </button>
        )}
      </div>
      {layer && (
        <VolumeSlider
          value={layer.volume}
          label={`${track.name} volume`}
          onChange={(volume) => send({ type: 'audio:volume', trackId: track.id, volume })}
        />
      )}
    </div>
  );
}

function TrackEditor({ track, send, onDone }: { track: Track; send: Send; onDone: () => void }) {
  const [name, setName] = useState(track.name);
  const [kind, setKind] = useState<TrackKind>(track.kind);
  const [loop, setLoop] = useState(track.loop);
  const [volume, setVolume] = useState(track.volume);

  const save = (e: FormEvent) => {
    e.preventDefault();
    send({ type: 'track:update', trackId: track.id, name: name.trim() || track.name, kind, loop, volume });
    onDone();
  };

  return (
    <form className="track-form" onSubmit={save}>
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Track name" />
      <TrackFields kind={kind} setKind={setKind} loop={loop} setLoop={setLoop} volume={volume} setVolume={setVolume} />
      <div className="button-row">
        <button type="submit" className="btn btn--sm btn--primary">
          Save
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost track-form__delete"
          onClick={() => {
            if (confirm(`Remove "${track.name}" from the soundboard?`)) {
              send({ type: 'track:delete', trackId: track.id });
              onDone();
            }
          }}
        >
          Delete
        </button>
      </div>
    </form>
  );
}

interface FieldsProps {
  kind: TrackKind;
  setKind: (k: TrackKind) => void;
  loop: boolean;
  setLoop: (l: boolean) => void;
  volume: number;
  setVolume: (v: number) => void;
}

function TrackFields({ kind, setKind, loop, setLoop, volume, setVolume }: FieldsProps) {
  return (
    <>
      <div className="segmented segmented--full" role="radiogroup" aria-label="Kind">
        {TRACK_KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'is-active' : ''} onClick={() => setKind(k)}>
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <p className="hint">{KIND_HINTS[kind]}</p>
      <div className="track-form__row">
        <label className="check">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          Loop
        </label>
        <label className="track-form__volume">
          <span>Volume</span>
          <input type="range" className="volume" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
        </label>
      </div>
    </>
  );
}

function AddTrack({ campaignId, send, onDone }: { campaignId: string; send: Send; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [kind, setKindState] = useState<TrackKind>('music');
  const [loop, setLoop] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Effects usually play once; music and ambience usually loop.
  const setKind = (k: TrackKind) => {
    setKindState(k);
    setLoop(k !== 'effect');
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const [up, duration] = await Promise.all([uploadFile(campaignId, file), audioDuration(file)]);
      if (up.kind !== 'audio') throw new Error('Choose an audio file (MP3, OGG, WAV, M4A or FLAC)');
      const fallback = file.name.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 80) || 'Track';
      send({ type: 'track:create', name: name.trim() || fallback, fileId: up.id, kind, loop, volume, duration });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="track-form track-form--new" onSubmit={add}>
      <label className="file-input">
        <input type="file" accept={AUDIO_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <span>{file ? file.name : 'Choose an audio file (up to 50 MB)'}</span>
      </label>
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Name (defaults to the file name)" aria-label="Track name" />
      <TrackFields kind={kind} setKind={setKind} loop={loop} setLoop={setLoop} volume={volume} setVolume={setVolume} />
      {error && <p className="form-error">{error}</p>}
      <div className="button-row">
        <button type="submit" className="btn btn--sm btn--primary" disabled={!file || busy}>
          {busy ? 'Uploading…' : 'Add to soundboard'}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
