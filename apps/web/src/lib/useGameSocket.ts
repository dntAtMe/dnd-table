import {
  CloseCode,
  type AudioState,
  type CameraRect,
  type CharacterRecord,
  type ClientMessage,
  type CombatView,
  type ClientRole,
  type DisplayInfo,
  type HandoutView,
  type Hello,
  type LogEntry,
  type Member,
  type SceneSummary,
  type SceneView,
  type ServerMessage,
  type Showcase,
  type Track,
  type WikiPageView,
} from '@dnd/protocol';
import { useCallback, useEffect, useReducer, useRef } from 'react';

const MAX_LOG = 300;
const PING_MS = 2500;

export interface Ping {
  id: number;
  sceneId: string;
  x: number;
  y: number;
  name: string;
  role: ClientRole;
}

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'failed';

export interface GameState {
  status: SocketStatus;
  hello?: Hello;
  members: Member[];
  displays: DisplayInfo[];
  log: LogEntry[];
  activeSceneId: string | null;
  /** The scene this client is looking at. */
  scene: SceneView | null;
  /** GM only: every scene in the campaign. */
  scenes: SceneSummary[];
  pings: Ping[];
  characters: CharacterRecord[];
  /** The running encounter, filtered for this client. */
  combat: CombatView | null;
  /** GMs: every handout; players: those shared with them, newest first. */
  handouts: HandoutView[];
  /** A handout or image the GM is showing over the map. */
  showcase: Showcase | null;
  /** Shared playback state. */
  audio: AudioState;
  /** Server clock minus ours (ms), estimated from the last audio state, for seeking in sync. */
  clockOffset: number;
  /** GM only: the soundboard. */
  tracks: Track[];
  /** Campaign wiki pages this client may see (GMs: all, with secret notes). */
  wiki: WikiPageView[];
  /** The latest one-shot sound effect, with a nonce so repeats re-trigger. */
  effect?: { url: string; volume: number; nonce: number };
  /** Latest GM framing (table displays only). */
  camera?: { sceneId: string; rect: CameraRect };
  /** Set for table displays that still need pairing. */
  unpairedCode?: string;
  /** Last error sent by the server (e.g. a bad dice formula), with a nonce so repeats re-trigger. */
  error?: { message: string; nonce: number };
  /** Why the socket gave up for good (auth or membership problems). */
  failure?: { code: number; reason: string };
}

type Action =
  | { type: 'reset' }
  | { type: 'status'; status: SocketStatus }
  | { type: 'failed'; code: number; reason: string }
  | { type: 'message'; msg: ServerMessage }
  | { type: 'ping:add'; ping: Ping }
  | { type: 'ping:expire'; id: number };

const initial: GameState = {
  status: 'connecting',
  members: [],
  displays: [],
  log: [],
  activeSceneId: null,
  scene: null,
  scenes: [],
  pings: [],
  characters: [],
  combat: null,
  handouts: [],
  showcase: null,
  audio: { layers: [], volume: 1, serverTime: 0 },
  clockOffset: 0,
  tracks: [],
  wiki: [],
};

let effectSeq = 0;

let pingSeq = 0;

function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'status':
      return { ...state, status: action.status };
    case 'failed':
      return { ...state, status: 'failed', failure: { code: action.code, reason: action.reason } };
    case 'ping:add':
      return { ...state, pings: [...state.pings, action.ping].slice(-20) };
    case 'ping:expire':
      return { ...state, pings: state.pings.filter((p) => p.id !== action.id) };
    case 'message': {
      const msg = action.msg;
      switch (msg.type) {
        case 'hello':
          return {
            ...state,
            status: 'open',
            hello: msg,
            members: msg.members,
            displays: msg.displays ?? [],
            log: msg.log,
            activeSceneId: msg.activeSceneId,
            scene: msg.scene,
            scenes: msg.scenes ?? [],
            pings: [],
            characters: msg.characters,
            combat: msg.combat,
            handouts: msg.handouts,
            showcase: msg.showcase,
            audio: msg.audio,
            clockOffset: msg.audio.serverTime - Date.now(),
            tracks: msg.tracks ?? [],
            wiki: msg.wiki ?? [],
            effect: undefined,
            camera: undefined,
            unpairedCode: undefined,
          };
        case 'members':
          return { ...state, members: msg.members };
        case 'displays':
          return { ...state, displays: msg.displays };
        case 'log':
          return { ...state, log: [...state.log, msg.entry].slice(-MAX_LOG) };
        case 'error':
          return { ...state, error: { message: msg.message, nonce: Date.now() } };
        case 'scene':
          return {
            ...state,
            scene: msg.scene,
            // A different scene means the old framing no longer applies.
            camera: msg.scene && state.camera?.sceneId === msg.scene.id ? state.camera : undefined,
          };
        case 'scenes':
          return { ...state, scenes: msg.scenes, activeSceneId: msg.activeSceneId };
        case 'ping':
          return state; // handled as 'ping:add' so ids are assigned outside the reducer
        case 'camera':
          return { ...state, camera: { sceneId: msg.sceneId, rect: msg.rect } };
        case 'characters':
          return { ...state, characters: msg.characters };
        case 'combat':
          return { ...state, combat: msg.combat };
        case 'handouts':
          return { ...state, handouts: msg.handouts };
        case 'showcase':
          return { ...state, showcase: msg.showcase };
        case 'audio':
          return { ...state, audio: msg.audio, clockOffset: msg.audio.serverTime - Date.now() };
        case 'tracks':
          return { ...state, tracks: msg.tracks };
        case 'wiki':
          return { ...state, wiki: msg.pages };
        case 'audio:effect':
          return { ...state, effect: { url: msg.url, volume: msg.volume, nonce: ++effectSeq } };
        case 'display:unpaired':
          return { ...initial, status: 'open', unpairedCode: msg.code };
      }
    }
  }
}

const FATAL_CODES = new Set<number>([CloseCode.Unauthorized, CloseCode.Forbidden, CloseCode.NotFound]);

/**
 * Keeps a WebSocket to the game server open (reconnecting with backoff) and folds
 * server messages into state. Pass null to stay disconnected.
 */
export function useGameSocket(query: string | null) {
  const [state, dispatch] = useReducer(reducer, initial);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!query) return;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?${query}`);
      socketRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type === 'ping') {
          const { type: _, ...ping } = msg;
          const id = ++pingSeq;
          dispatch({ type: 'ping:add', ping: { ...ping, id } });
          setTimeout(() => dispatch({ type: 'ping:expire', id }), PING_MS);
        } else {
          dispatch({ type: 'message', msg });
        }
      };
      ws.onclose = (ev) => {
        if (socketRef.current === ws) socketRef.current = null;
        if (stopped) return;
        if (FATAL_CODES.has(ev.code)) {
          dispatch({ type: 'failed', code: ev.code, reason: ev.reason });
          return;
        }
        dispatch({ type: 'status', status: 'reconnecting' });
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        retryTimer = setTimeout(connect, delay);
      };
    };

    dispatch({ type: 'reset' });
    connect();

    // Phones suspend sockets in the background; reconnect right away when the tab comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !socketRef.current && retryTimer) {
        clearTimeout(retryTimer);
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [query]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { state, send };
}
