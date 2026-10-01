import type { AudioState, ClientRole } from '@dnd/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from './engine';

export interface AudioPrefs {
  enabled: boolean;
  volume: number;
}

/**
 * Per-device audio preference. Table screens play by default; players opt in on phones and
 * tablets (on by default on desktops); the GM opts in to hear it too.
 */
function defaultPrefs(role: ClientRole): AudioPrefs {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return { enabled: role === 'display' || (role === 'player' && !coarse), volume: 1 };
}

function readPrefs(role: ClientRole): AudioPrefs {
  try {
    const raw = localStorage.getItem(`dnd-table.audio.${role}`);
    if (raw) {
      const p = JSON.parse(raw) as Partial<AudioPrefs>;
      if (typeof p.enabled === 'boolean' && typeof p.volume === 'number') return { enabled: p.enabled, volume: p.volume };
    }
  } catch {
    // Private mode or bad JSON: fall back to the defaults.
  }
  return defaultPrefs(role);
}

export function useAudioPrefs(role: ClientRole): [AudioPrefs, (patch: Partial<AudioPrefs>) => void] {
  const [prefs, setPrefs] = useState(() => readPrefs(role));
  useEffect(() => setPrefs(readPrefs(role)), [role]);
  const update = useCallback(
    (patch: Partial<AudioPrefs>) =>
      setPrefs((p) => {
        const next = { ...p, ...patch };
        try {
          localStorage.setItem(`dnd-table.audio.${role}`, JSON.stringify(next));
        } catch {
          // Not persisted; still applies for this visit.
        }
        return next;
      }),
    [role],
  );
  return [prefs, update];
}

interface Options {
  audio: AudioState;
  clockOffset: number;
  effect?: { url: string; volume: number; nonce: number };
  enabled: boolean;
  volume: number;
}

/**
 * Plays the shared audio on this device while enabled. `blocked` means the browser wants a tap
 * before it will play sound; call `unlock` from that tap's handler.
 */
export function useAmbientAudio({ audio, clockOffset, effect, enabled, volume }: Options) {
  const [blocked, setBlocked] = useState(false);
  const engine = useRef<AudioEngine | null>(null);
  if (!engine.current && typeof window !== 'undefined') engine.current = new AudioEngine(setBlocked);

  useEffect(() => () => engine.current?.destroy(), []);
  useEffect(() => engine.current?.setEnabled(enabled), [enabled]);
  useEffect(() => engine.current?.setLocalVolume(volume), [volume]);
  useEffect(() => engine.current?.update(audio, clockOffset), [audio, clockOffset]);

  const lastEffect = useRef(effect?.nonce);
  useEffect(() => {
    if (!effect || effect.nonce === lastEffect.current) return;
    lastEffect.current = effect.nonce;
    engine.current?.playEffect(effect.url, effect.volume);
  }, [effect]);

  /** Pass `enable` when the same tap also turns audio on, so playback starts inside the gesture. */
  const unlock = useCallback((enable?: boolean) => {
    if (enable) engine.current?.setEnabled(true);
    engine.current?.unlock();
  }, []);
  return { blocked: blocked && enabled, unlock };
}
