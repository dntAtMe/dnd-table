import type { AudioLayer, AudioState } from '@dnd/protocol';

/** Re-seek a playing element when it drifts this far (seconds) from the shared position. */
const DRIFT_S = 0.75;
const MUSIC_FADE_S = 2;
const LAYER_FADE_S = 0.8;
const VOLUME_RAMP_S = 0.15;

interface Voice {
  el: HTMLAudioElement;
  gain: GainNode | null;
  layer: AudioLayer;
  /** Level the voice is at or fading towards. */
  target: number;
  fadeTimer?: ReturnType<typeof setInterval>;
}

type AudioContextCtor = typeof AudioContext;

function contextCtor(): AudioContextCtor | undefined {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Plays the shared audio state on this device. Each playing layer is an <audio> element routed
 * through Web Audio (for smooth fades and volume on iOS, where element volume is read-only),
 * seeked to the position implied by the server's start time and our clock offset.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly voices = new Map<string, Voice>();
  private state: AudioState = { layers: [], volume: 1, serverTime: 0 };
  private offset = 0;
  private enabled = false;
  private localVolume = 1;
  private blocked = false;

  constructor(private readonly onBlocked: (blocked: boolean) => void) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      for (const id of [...this.voices.keys()]) this.drop(id, 0);
      this.setBlocked(false);
    }
    this.sync();
  }

  setLocalVolume(volume: number): void {
    this.localVolume = clamp01(volume);
    this.sync();
  }

  update(state: AudioState, offset: number): void {
    this.state = state;
    this.offset = offset;
    this.sync();
  }

  /** Must run inside a user gesture: resumes the audio context and retries playback. */
  unlock(): void {
    this.ensureContext();
    void this.ctx?.resume().then(() => this.refreshBlocked());
    for (const v of this.voices.values()) {
      if (v.layer.playing) void v.el.play().then(() => this.refreshBlocked(), () => {});
    }
    // iOS unlocks media playback per gesture: play a silent blip if nothing else is queued.
    if (this.voices.size === 0) {
      const el = new Audio();
      el.muted = true;
      void el.play().catch(() => {});
    }
    this.setBlocked(false);
    this.sync();
  }

  playEffect(url: string, volume: number): void {
    if (!this.enabled) return;
    if (this.blocked) return;
    this.ensureContext();
    const el = new Audio(url);
    el.preload = 'auto';
    const gain = this.connect(el);
    const level = clamp01(volume * this.state.volume * this.localVolume);
    if (gain) gain.gain.value = level;
    else el.volume = level;
    el.onended = () => {
      gain?.disconnect();
      el.removeAttribute('src');
    };
    void el.play().catch((err: unknown) => this.playFailed(err));
  }

  destroy(): void {
    for (const id of [...this.voices.keys()]) this.drop(id, 0);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }

  // ---------- internals ----------

  private setBlocked(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    this.onBlocked(blocked);
  }

  private refreshBlocked(): void {
    if (this.ctx && this.ctx.state !== 'running') return;
    this.setBlocked(false);
  }

  private playFailed(err: unknown): void {
    if (err instanceof DOMException && err.name === 'NotAllowedError') this.setBlocked(true);
  }

  private ensureContext(): void {
    if (this.ctx) return;
    const Ctor = contextCtor();
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.ctx.onstatechange = () => {
        if (this.ctx?.state === 'running') this.setBlocked(false);
      };
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  private connect(el: HTMLAudioElement): GainNode | null {
    if (!this.ctx || !this.master) return null;
    try {
      const source = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      source.connect(gain).connect(this.master);
      return gain;
    } catch {
      return null;
    }
  }

  private level(layer: AudioLayer): number {
    return clamp01(layer.volume * this.state.volume * this.localVolume);
  }

  private fade(v: Voice, to: number, seconds: number, then?: () => void): void {
    clearInterval(v.fadeTimer);
    v.target = to;
    if (v.gain && this.ctx) {
      const g = v.gain.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(to, t + Math.max(seconds, 0.01));
      if (then) setTimeout(then, seconds * 1000 + 50);
      return;
    }
    // No Web Audio: step the element volume instead.
    const from = v.el.volume;
    const steps = Math.max(1, Math.round(seconds * 20));
    let i = 0;
    v.fadeTimer = setInterval(() => {
      i++;
      v.el.volume = clamp01(from + ((to - from) * i) / steps);
      if (i >= steps) {
        clearInterval(v.fadeTimer);
        then?.();
      }
    }, 50);
  }

  /** Where a playing layer should be now, or null if a non-looping track has already ended. */
  private targetPosition(v: Voice): number | null {
    const { layer } = v;
    if (!layer.playing) return layer.position;
    const duration = Number.isFinite(v.el.duration) && v.el.duration > 0 ? v.el.duration : layer.duration;
    const elapsed = Math.max(0, (Date.now() + this.offset - layer.startedAt) / 1000);
    if (!duration) return elapsed;
    if (layer.loop) return elapsed % duration;
    return elapsed < duration ? elapsed : null;
  }

  private seek(v: Voice): boolean {
    const pos = this.targetPosition(v);
    if (pos === null) return false;
    // Before metadata loads, seeking is unreliable; loadedmetadata re-syncs.
    if (v.el.readyState >= 1 && Math.abs(v.el.currentTime - pos) > DRIFT_S) {
      try {
        v.el.currentTime = pos;
      } catch {
        // Not seekable yet.
      }
    }
    return true;
  }

  private createVoice(layer: AudioLayer): Voice {
    const el = new Audio();
    el.preload = 'auto';
    el.src = layer.url;
    el.loop = layer.loop;
    const voice: Voice = { el, gain: this.connect(el), layer, target: 0 };
    if (voice.gain) voice.gain.gain.value = 0;
    else el.volume = 0;
    el.addEventListener('loadedmetadata', () => this.sync());
    return voice;
  }

  private drop(trackId: string, fadeSeconds: number): void {
    const v = this.voices.get(trackId);
    if (!v) return;
    this.voices.delete(trackId);
    const stop = () => {
      clearInterval(v.fadeTimer);
      v.el.pause();
      v.gain?.disconnect();
      v.el.removeAttribute('src');
      v.el.load();
    };
    if (fadeSeconds > 0) this.fade(v, 0, fadeSeconds, stop);
    else stop();
  }

  private sync(): void {
    if (!this.enabled) return;
    const live = new Set(this.state.layers.map((l) => l.trackId));
    for (const [id, v] of this.voices) {
      if (!live.has(id)) this.drop(id, v.layer.kind === 'music' ? MUSIC_FADE_S : LAYER_FADE_S);
    }
    if (this.state.layers.length === 0) return;
    this.ensureContext();
    if (this.ctx?.state === 'suspended') {
      void this.ctx.resume().then(() => this.refreshBlocked(), () => {});
      // Resuming without a gesture stays pending; only nag if something should be audible.
      if (this.state.layers.some((l) => l.playing)) this.setBlocked(this.ctx.state === 'suspended');
    }

    for (const layer of this.state.layers) {
      let v = this.voices.get(layer.trackId);
      const fresh = !v;
      if (v && v.el.src && !v.el.src.endsWith(layer.url)) {
        this.drop(layer.trackId, LAYER_FADE_S);
        v = undefined;
      }
      if (!v) {
        v = this.createVoice(layer);
        this.voices.set(layer.trackId, v);
      }
      const wasPlaying = v.layer.playing && !fresh;
      v.layer = layer;
      v.el.loop = layer.loop;
      if (!layer.playing) {
        v.el.pause();
        if (v.el.readyState >= 1) v.el.currentTime = layer.position;
        continue;
      }
      // A one-shot that already finished here stays finished (play() would restart it).
      if (!this.seek(v) || (v.el.ended && !layer.loop)) {
        v.el.pause();
        continue;
      }
      if (v.el.paused) void v.el.play().then(() => this.refreshBlocked(), (err: unknown) => this.playFailed(err));
      const level = this.level(layer);
      if (fresh || !wasPlaying) this.fade(v, level, layer.kind === 'music' ? MUSIC_FADE_S : LAYER_FADE_S);
      else if (Math.abs(level - v.target) > 0.001) this.fade(v, level, VOLUME_RAMP_S);
    }
  }
}
