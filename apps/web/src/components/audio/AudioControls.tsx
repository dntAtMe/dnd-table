import type { AudioState } from '@dnd/protocol';
import { useEffect, useRef, useState } from 'react';
import type { AudioPrefs } from './useAmbientAudio';
import './audio.css';

export function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="speaker-icon">
      <path d="M3 7.5h3l4-3.5v12l-4-3.5H3z" fill="currentColor" />
      {on ? (
        <path d="M13 7a4 4 0 0 1 0 6M15.5 4.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <path d="m13 8 4 4m0-4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="note-icon">
      <path d="M6 12.5a2 2 0 1 1-1-1.73V3l8-1.5v9a2 2 0 1 1-1-1.73V4.2L6 5.3z" fill="currentColor" />
    </svg>
  );
}

/** "Tavern · Rain" for whatever is playing (paused layers excluded). */
export function playingNames(audio: AudioState): string[] {
  return audio.layers.filter((l) => l.playing).map((l) => l.name);
}

/** Small "now playing" chip, e.g. for the table screen header. */
export function NowPlaying({ audio, muted, onToggle }: { audio: AudioState; muted: boolean; onToggle?: () => void }) {
  const names = playingNames(audio);
  if (names.length === 0) return null;
  const Tag = onToggle ? 'button' : 'span';
  return (
    <Tag
      {...(onToggle && { type: 'button' as const, onClick: onToggle, title: muted ? 'Sound is off on this screen. Click to turn it on.' : 'Click to mute this screen' })}
      className={`now-playing${muted ? ' now-playing--muted' : ''}`}
    >
      <NoteIcon />
      <span className="now-playing__names">{names.join(' · ')}</span>
      {muted && <SpeakerIcon on={false} />}
    </Tag>
  );
}

/** The browser blocked autoplay: one tap fixes it. */
export function AudioUnlockPrompt({ onUnlock, className = '' }: { onUnlock: () => void; className?: string }) {
  return (
    <button type="button" className={`audio-unlock ${className}`} onClick={() => onUnlock()}>
      <SpeakerIcon on />
      Tap to enable audio
    </button>
  );
}

interface AudioControlProps {
  audio: AudioState;
  prefs: AudioPrefs;
  setPrefs: (patch: Partial<AudioPrefs>) => void;
  /** Call from a click so the browser allows playback (`enable` also switches it on). */
  unlock: (enable?: boolean) => void;
  /** What turning it on means here, e.g. "Hear table audio on this device". */
  label: string;
}

/** Topbar speaker button with a popover: opt in/out on this device, volume and what's playing. */
export function AudioControl({ audio, prefs, setPrefs, unlock, label }: AudioControlProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const names = playingNames(audio);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="audio-control" ref={ref}>
      <button
        type="button"
        className={`audio-control__button${prefs.enabled ? ' is-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Audio: ${prefs.enabled ? 'on' : 'off'}${names.length ? `, playing ${names.join(', ')}` : ''}`}
      >
        <SpeakerIcon on={prefs.enabled} />
        {names.length > 0 && <span className="audio-control__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="audio-control__panel" role="dialog" aria-label="Audio">
          <label className="check">
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(e) => {
                setPrefs({ enabled: e.target.checked });
                if (e.target.checked) unlock(true);
              }}
            />
            {label}
          </label>
          <label className="audio-control__volume">
            <span>Volume</span>
            <input
              type="range"
              className="volume"
              min={0}
              max={1}
              step={0.01}
              value={prefs.volume}
              disabled={!prefs.enabled}
              onChange={(e) => setPrefs({ volume: Number(e.target.value) })}
            />
          </label>
          <p className="hint">{names.length ? `Now playing: ${names.join(' · ')}` : 'Nothing is playing right now.'}</p>
        </div>
      )}
    </div>
  );
}
