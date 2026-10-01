// Lighting and vision on the server: scene lighting, token lights and senses, what each player's
// tokens can see, and dynamic fog. The maths is in @dnd/rules (vision.ts); this module stores the
// settings, works out who looks through which tokens, and caches the expensive steps per scene so
// re-sending views after every move stays cheap.
import type { ClientMessage, ClientRole, SceneView, Token, User, VisionMessage } from '@dnd/protocol';
import {
  MapData,
  SightMap,
  computeCharacter,
  gridGeometry,
  illuminate,
  mergeFields,
  viewField,
  type SceneVision,
  type Sight,
  type TokenSenses,
} from '@dnd/rules';
import { GameError, sceneView, type Viewer } from './scenes';
import type { SceneRecord, Store, TokenVision } from './store';

export function isVisionMessage(msg: ClientMessage): msg is VisionMessage {
  return msg.type.startsWith('vision:');
}

export interface VisionConn {
  role: ClientRole;
  campaignId: string;
  user?: User;
}

/** What the vision tracker needs from the hub. */
export interface VisionHost {
  sceneChanged(campaignId: string, sceneId: string): void;
}

/** Cached steps for one scene; each is rebuilt only when what it depends on changes. */
interface SceneCache {
  /** Grid size and encoded map the sight map was built from. */
  mapKey: string;
  sight: SightMap;
  /** Lighting, feet per cell and light sources the light levels were computed for. */
  lightKey: string;
  light: Uint8Array;
  /** View field per token id, keyed by its position and senses. */
  fields: Map<string, { key: string; field: Uint8Array }>;
}

/** Scenes whose caches are kept (the live one, plus a few the GM is preparing). */
const CACHED_SCENES = 8;

export class VisionTracker<C extends VisionConn> {
  private readonly cache = new Map<string, SceneCache>();

  constructor(
    private readonly store: Store,
    private readonly host: VisionHost,
  ) {}

  /** A scene's tokens with their light sources and senses. */
  tokens(sceneId: string): Token[] {
    const extra = this.store.tokenVision(sceneId);
    return this.store.tokens(sceneId).map((t) => {
      const v = extra.get(t.id);
      return v ? { ...t, ...v } : t;
    });
  }

  /**
   * The scene as one viewer may see it. With vision on, a player sees through their own tokens
   * and a table screen through every player's tokens (it is the party's shared screen); the GM
   * always sees everything.
   */
  view(scene: SceneRecord, tokens: Token[], viewer: Viewer): SceneView {
    const settings = this.store.sceneVision(scene.id);
    if (!settings.enabled || viewer.role === 'gm') return sceneView(scene, tokens, viewer, settings);
    const eyes = viewer.role === 'display' ? this.partyTokens(scene, tokens) : tokens.filter((t) => viewer.userId && t.ownerUserId === viewer.userId);
    return sceneView(scene, tokens, viewer, settings, this.sight(scene, settings, tokens, eyes));
  }

  handle(conn: C, msg: VisionMessage): void {
    if (msg.type === 'vision:scene') {
      if (conn.role !== 'gm') throw new GameError('Only the GM can do that');
      const scene = this.store.getScene(msg.sceneId);
      if (!scene || scene.campaignId !== conn.campaignId) throw new GameError('Scene not found');
      const prev = this.store.sceneVision(scene.id);
      this.store.setSceneVision(scene.id, {
        enabled: msg.enabled ?? prev.enabled,
        lighting: msg.lighting ?? prev.lighting,
        dynamicFog: msg.dynamicFog ?? prev.dynamicFog,
      });
      // Explored areas are remembered in the fog, so dynamic fog needs it on.
      if (msg.dynamicFog && !scene.fogEnabled) this.store.updateScene(scene.id, { fogEnabled: true });
      return this.host.sceneChanged(conn.campaignId, scene.id);
    }

    const token = this.store.getToken(msg.tokenId);
    const scene = token && this.store.getScene(token.sceneId);
    if (!token || !scene || scene.campaignId !== conn.campaignId) throw new GameError('Token not found');
    if (conn.role !== 'gm') {
      if (!conn.user || token.ownerUserId !== conn.user.id) throw new GameError("That's not your token");
      if (msg.senses !== undefined) throw new GameError('Only the GM can change senses');
    }
    const prev = this.store.tokenVision(scene.id).get(token.id) ?? {};
    const next: TokenVision = {
      light: msg.light === undefined ? prev.light : (msg.light ?? undefined),
      senses: msg.senses === undefined ? prev.senses : cleanSenses(msg.senses),
    };
    this.store.setTokenVision(token.id, next);
    this.host.sceneChanged(conn.campaignId, scene.id);
  }

  /** Tokens controlled by players: the party's eyes for table screens and dynamic fog. */
  private partyTokens(scene: SceneRecord, tokens: Token[]): Token[] {
    const players = new Set(
      this.store
        .members(scene.campaignId)
        .filter((m) => m.role === 'player')
        .map((m) => m.userId),
    );
    return tokens.filter((t) => t.ownerUserId !== null && players.has(t.ownerUserId));
  }

  /** Senses in feet; darkvision comes from the token's character unless set on the token. */
  private senses(token: Token): Required<TokenSenses> {
    let darkvision = token.senses?.darkvision;
    if (darkvision === undefined && token.characterId) {
      const rec = this.store.getCharacter(token.characterId);
      try {
        darkvision = rec ? computeCharacter(rec.data).darkvision : 0;
      } catch {
        darkvision = 0;
      }
    }
    return { darkvision: darkvision ?? 0, blindsight: token.senses?.blindsight ?? 0, truesight: token.senses?.truesight ?? 0 };
  }

  /** What the given tokens see together, reusing cached sight maps, light levels and view fields. */
  private sight(scene: SceneRecord, settings: SceneVision, tokens: Token[], eyes: Token[]): Sight {
    const { cols, rows } = gridGeometry(scene.grid, scene.width, scene.height);
    const { feetPerCell } = scene.grid;
    const mapKey = `${cols}x${rows}|${scene.map}`;
    let c = this.cache.get(scene.id);
    if (!c || c.mapKey !== mapKey) {
      c = { mapKey, sight: new SightMap(MapData.decode(scene.map, cols, rows)), lightKey: '', light: new Uint8Array(0), fields: new Map() };
    }
    // Most recently used last, so the oldest scene is dropped first.
    this.cache.delete(scene.id);
    this.cache.set(scene.id, c);
    if (this.cache.size > CACHED_SCENES) this.cache.delete(this.cache.keys().next().value!);

    const lights = tokens.filter((t) => t.light && t.light.bright + t.light.dim > 0);
    const lightKey = [settings.lighting, feetPerCell, ...lights.map((t) => `${t.col},${t.row},${t.size},${t.light!.bright},${t.light!.dim}`)].join('|');
    if (c.lightKey !== lightKey) {
      c.light = illuminate(
        c.sight,
        settings.lighting,
        lights.map((t) => ({ col: t.col, row: t.row, size: t.size, bright: t.light!.bright, dim: t.light!.dim })),
        feetPerCell,
      );
      c.lightKey = lightKey;
      c.fields.clear();
    }

    const ids = new Set(tokens.map((t) => t.id));
    for (const id of c.fields.keys()) if (!ids.has(id)) c.fields.delete(id);
    const fields = eyes.map((t) => {
      const s = this.senses(t);
      const key = `${t.col},${t.row},${t.size},${s.darkvision},${s.blindsight},${s.truesight}`;
      const hit = c.fields.get(t.id);
      if (hit?.key === key) return hit.field;
      const field = viewField(c.sight, c.light, { col: t.col, row: t.row, size: t.size, ...s }, feetPerCell);
      c.fields.set(t.id, { key, field });
      return field;
    });
    return mergeFields(cols, rows, fields);
  }
}

/** Drops empty senses; an explicit darkvision of 0 stays (it overrides the character's). */
function cleanSenses(s: TokenSenses): TokenSenses | undefined {
  const out: TokenSenses = {};
  if (s.darkvision !== undefined) out.darkvision = s.darkvision;
  if (s.blindsight) out.blindsight = s.blindsight;
  if (s.truesight) out.truesight = s.truesight;
  return Object.keys(out).length ? out : undefined;
}
