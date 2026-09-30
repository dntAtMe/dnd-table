import {
  CloseCode,
  type ClientMessage,
  type DisplayInfo,
  type Hello,
  type LogEntry,
  type Member,
  type ServerMessage,
} from '@dnd/protocol';
import { useCallback, useEffect, useReducer, useRef } from 'react';

const MAX_LOG = 300;

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'failed';

export interface GameState {
  status: SocketStatus;
  hello?: Hello;
  members: Member[];
  displays: DisplayInfo[];
  log: LogEntry[];
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
  | { type: 'message'; msg: ServerMessage };

const initial: GameState = { status: 'connecting', members: [], displays: [], log: [] };

function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'status':
      return { ...state, status: action.status };
    case 'failed':
      return { ...state, status: 'failed', failure: { code: action.code, reason: action.reason } };
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
        case 'display:unpaired':
          return { ...initial, status: 'open', unpairedCode: msg.code };
        default:
          return state;
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
      ws.onmessage = (ev) => dispatch({ type: 'message', msg: JSON.parse(ev.data as string) as ServerMessage });
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
