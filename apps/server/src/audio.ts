import type { AudioLayer, AudioMessage, AudioState, ClientMessage, ClientRole, ServerMessage, Track, User } from '@dnd/protocol';
import { GameError } from './scenes';
import type { Store } from './store';

export interface AudioConn {
  role: ClientRole;
  campaignId: string;
  user?: User;
}

/** What the soundboard needs from the hub. */
export interface AudioHost<C extends AudioConn> {
  connections(campaignId: string): Iterable<C>;
  send(conn: C, msg: ServerMessage): void;
}

type Msg<T extends AudioMessage['type']> = Extract<AudioMessage, { type: T }>;

export function isAudioMessage(msg: ClientMessage): msg is AudioMessage {
  return msg.type.startsWith('audio:') || msg.type.startsWith('track:');
}

/** A playing or paused track; name, URL, loop etc. are read from the track so edits apply live. */
interface Layer {
  trackId: string;
  volume: number;
  playing: boolean;
  startedAt: number;
  position: number;
}

interface Playback {
  layers: Map<string, Layer>;
  volume: number;
}

/** Non-looping tracks drop out of the shared state a little after they end. */
const END_GRACE_MS = 2000;

/** Seconds into a track for a layer at `now`, wrapping looping tracks. */
export function layerPosition(layer: Pick<AudioLayer, 'playing' | 'startedAt' | 'position' | 'loop' | 'duration'>, now: number): number {
  if (!layer.playing) return layer.position;
  const elapsed = Math.max(0, (now - layer.startedAt) / 1000);
  return layer.loop && layer.duration ? elapsed % layer.duration : elapsed;
}

/**
 * The soundboard: tracks are stored per campaign; what's playing is kept in memory and sent to
 * every screen with a server timestamp, so each can seek to the shared position.
 */
export class Soundboard<C extends AudioConn> {
  private readonly playback = new Map<string, Playback>();

  constructor(
    private readonly store: Store,
    private readonly host: AudioHost<C>,
    private readonly now: () => number = Date.now,
  ) {}

  tracks(campaignId: string): Track[] {
    return this.store.tracks(campaignId).map(({ campaignId: _, ...t }) => t);
  }

  stateFor(campaignId: string): AudioState {
    const now = this.now();
    const pb = this.playback.get(campaignId);
    const tracks = new Map(this.store.tracks(campaignId).map((t) => [t.id, t]));
    const layers: AudioLayer[] = [];
    for (const layer of pb?.layers.values() ?? []) {
      const track = tracks.get(layer.trackId);
      const ended =
        track && !track.loop && track.duration !== null && layer.playing && now - layer.startedAt > track.duration * 1000 + END_GRACE_MS;
      if (!track || ended) {
        pb!.layers.delete(layer.trackId);
        continue;
      }
      layers.push({
        trackId: track.id,
        name: track.name,
        url: track.url,
        kind: track.kind,
        loop: track.loop,
        duration: track.duration,
        volume: layer.volume,
        playing: layer.playing,
        startedAt: layer.startedAt,
        position: layer.position,
      });
    }
    return { layers, volume: pb?.volume ?? 1, serverTime: now };
  }

  handle(conn: C & { user: User }, msg: AudioMessage): void {
    if (conn.role !== 'gm') throw new GameError('Only the GM can do that');
    switch (msg.type) {
      case 'track:create':
        return this.createTrack(conn, msg);
      case 'track:update': {
        const track = this.trackOf(conn, msg.trackId);
        this.store.updateTrack({
          id: track.id,
          name: msg.name ?? track.name,
          kind: msg.kind ?? track.kind,
          loop: msg.loop ?? track.loop,
          volume: msg.volume ?? track.volume,
        });
        this.tracksChanged(conn.campaignId);
        if (this.playback.get(conn.campaignId)?.layers.has(track.id)) this.changed(conn.campaignId);
        return;
      }
      case 'track:delete': {
        const track = this.trackOf(conn, msg.trackId);
        this.store.deleteTrack(track.id);
        this.tracksChanged(conn.campaignId);
        if (this.playback.get(conn.campaignId)?.layers.delete(track.id)) this.changed(conn.campaignId);
        return;
      }
      case 'audio:play':
        return this.play(conn, msg.trackId);
      case 'audio:pause': {
        const pb = this.playbackOf(conn.campaignId);
        const layer = pb.layers.get(msg.trackId);
        if (!layer?.playing) return;
        const track = this.trackOf(conn, msg.trackId);
        layer.position = layerPosition({ ...layer, loop: track.loop, duration: track.duration }, this.now());
        layer.playing = false;
        return this.changed(conn.campaignId);
      }
      case 'audio:stop':
        if (this.playback.get(conn.campaignId)?.layers.delete(msg.trackId)) this.changed(conn.campaignId);
        return;
      case 'audio:stop-all':
        this.playbackOf(conn.campaignId).layers.clear();
        return this.changed(conn.campaignId);
      case 'audio:volume': {
        const pb = this.playbackOf(conn.campaignId);
        if (msg.trackId === null) pb.volume = msg.volume;
        else {
          const layer = pb.layers.get(msg.trackId);
          if (!layer) throw new GameError("That track isn't playing");
          layer.volume = msg.volume;
        }
        return this.changed(conn.campaignId);
      }
    }
  }

  private trackOf(conn: C, trackId: string): Track {
    const track = this.store.getTrack(trackId);
    if (!track || track.campaignId !== conn.campaignId) throw new GameError('Track not found');
    return track;
  }

  private playbackOf(campaignId: string): Playback {
    let pb = this.playback.get(campaignId);
    if (!pb) this.playback.set(campaignId, (pb = { layers: new Map(), volume: 1 }));
    return pb;
  }

  private createTrack(conn: C, msg: Msg<'track:create'>): void {
    const file = this.store.getFile(msg.fileId);
    if (file?.campaignId !== conn.campaignId || !file.mime.startsWith('audio/')) throw new GameError('Audio file not found');
    this.store.createTrack({
      campaignId: conn.campaignId,
      name: msg.name,
      fileId: file.id,
      kind: msg.kind,
      loop: msg.loop,
      volume: msg.volume,
      duration: msg.duration ?? null,
    });
    this.tracksChanged(conn.campaignId);
  }

  private play(conn: C, trackId: string): void {
    const track = this.trackOf(conn, trackId);
    const now = this.now();
    // One-shot effects aren't part of the shared state: whoever is connected hears them once.
    if (track.kind === 'effect' && !track.loop) {
      const msg: ServerMessage = { type: 'audio:effect', trackId: track.id, url: track.url, volume: track.volume, serverTime: now };
      for (const other of this.host.connections(conn.campaignId)) this.host.send(other, msg);
      return;
    }
    const pb = this.playbackOf(conn.campaignId);
    const existing = pb.layers.get(track.id);
    if (existing && !existing.playing) {
      existing.playing = true;
      existing.startedAt = now - existing.position * 1000;
    } else {
      // Only one music track at a time: clients crossfade from the old one.
      if (track.kind === 'music') {
        const music = new Set(this.store.tracks(conn.campaignId).filter((t) => t.kind === 'music').map((t) => t.id));
        for (const id of pb.layers.keys()) if (music.has(id)) pb.layers.delete(id);
      }
      pb.layers.set(track.id, { trackId: track.id, volume: existing?.volume ?? track.volume, playing: true, startedAt: now, position: 0 });
    }
    this.changed(conn.campaignId);
  }

  /** Everyone hears the same thing, so every screen gets the same state. */
  private changed(campaignId: string): void {
    const msg: ServerMessage = { type: 'audio', audio: this.stateFor(campaignId) };
    for (const conn of this.host.connections(campaignId)) this.host.send(conn, msg);
  }

  private tracksChanged(campaignId: string): void {
    const msg: ServerMessage = { type: 'tracks', tracks: this.tracks(campaignId) };
    for (const conn of this.host.connections(campaignId)) if (conn.role === 'gm') this.host.send(conn, msg);
  }
}
