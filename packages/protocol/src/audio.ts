// Ambient audio: the GM's soundboard and the shared playback state every screen follows.
import { z } from 'zod';

const Id = z.string().min(1).max(64);

/** Music: one track at a time (starting another crossfades). Ambience: any number of layers. Effects: one-shots. */
export const TRACK_KINDS = ['music', 'ambience', 'effect'] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

/** A soundboard entry (GM only). */
export interface Track {
  id: string;
  name: string;
  fileId: string;
  url: string;
  kind: TrackKind;
  loop: boolean;
  /** Default volume, 0–1. */
  volume: number;
  /** Seconds, measured by the GM's browser on upload; null if unknown. */
  duration: number | null;
}

/** A track that is playing or paused right now. */
export interface AudioLayer {
  trackId: string;
  name: string;
  url: string;
  kind: TrackKind;
  loop: boolean;
  volume: number;
  duration: number | null;
  playing: boolean;
  /** While playing: server time (ms since epoch) at which the track was at 0:00. */
  startedAt: number;
  /** While paused: where it was paused, in seconds. */
  position: number;
}

/**
 * Shared playback state. Clients estimate their clock offset from `serverTime`
 * and seek late-joining or drifting players to the right position.
 */
export interface AudioState {
  layers: AudioLayer[];
  /** Master volume, 0–1. */
  volume: number;
  /** Server clock (ms since epoch) when this state was sent. */
  serverTime: number;
}

const Volume = z.number().min(0).max(1);
const Name = z.string().trim().min(1).max(80);

/** GM only. */
export const AudioMessages = [
  z.object({
    type: z.literal('track:create'),
    name: Name,
    fileId: Id,
    kind: z.enum(TRACK_KINDS),
    loop: z.boolean(),
    volume: Volume,
    duration: z.number().positive().max(86_400).nullable().optional(),
  }),
  z.object({
    type: z.literal('track:update'),
    trackId: Id,
    name: Name.optional(),
    kind: z.enum(TRACK_KINDS).optional(),
    loop: z.boolean().optional(),
    volume: Volume.optional(),
  }),
  z.object({ type: z.literal('track:delete'), trackId: Id }),
  /** Starts a track from the top (or resumes it if paused). One-shot effects play once for everyone. */
  z.object({ type: z.literal('audio:play'), trackId: Id }),
  z.object({ type: z.literal('audio:pause'), trackId: Id }),
  z.object({ type: z.literal('audio:stop'), trackId: Id }),
  z.object({ type: z.literal('audio:stop-all') }),
  /** A playing layer's volume, or the master volume when trackId is null. */
  z.object({ type: z.literal('audio:volume'), trackId: Id.nullable(), volume: Volume }),
] as const;

export type AudioMessage = z.infer<(typeof AudioMessages)[number]>;

export type AudioServerMessage =
  | { type: 'audio'; audio: AudioState }
  /** GM only. */
  | { type: 'tracks'; tracks: Track[] }
  /** A one-shot sound effect to play now. */
  | { type: 'audio:effect'; trackId: string; url: string; volume: number; serverTime: number };
