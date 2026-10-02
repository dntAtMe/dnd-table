// The tokens on the scene this screen is looking at, for parts of the UI away from the map (e.g. a
// character sheet lighting its token when a light spell is cast).
import type { ClientMessage, Token } from '@dnd/protocol';
import { createContext, useContext, type ReactNode } from 'react';

interface SceneTokens {
  tokens: Token[];
  send: (msg: ClientMessage) => void;
}

const SceneTokensContext = createContext<SceneTokens | null>(null);

export function SceneTokensProvider({ tokens, send, children }: SceneTokens & { children: ReactNode }) {
  return <SceneTokensContext.Provider value={{ tokens, send }}>{children}</SceneTokensContext.Provider>;
}

/** A character's token on the current scene, and the way to change it; undefined when it has none there. */
export function useCharacterToken(characterId: string): { token: Token; send: SceneTokens['send'] } | undefined {
  const ctx = useContext(SceneTokensContext);
  const token = ctx?.tokens.find((t) => t.characterId === characterId);
  return ctx && token ? { token, send: ctx.send } : undefined;
}
