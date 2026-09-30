// Shapes shared by the server and the web client: REST payloads and WebSocket messages.
import { z } from 'zod';
import type { Grid, RollResult } from '@dnd/rules';

export type Role = 'gm' | 'player';
/** Who is on the other end of a socket. Displays are paired table screens with no user. */
export type ClientRole = Role | 'display';
/** public: everyone, including table displays. gm: the author and the GM(s) only. */
export type Visibility = 'public' | 'gm';

// ---------- REST ----------

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/i;

export const RegisterBody = z.object({
  username: z.string().regex(USERNAME_RE, 'Username: 3–32 letters, digits, dots, dashes or underscores'),
  displayName: z.string().trim().min(1).max(40),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  signupCode: z.string().optional(),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(200),
});

export const CreateCampaignBody = z.object({ name: z.string().trim().min(1).max(80) });
export const JoinCampaignBody = z.object({ inviteCode: z.string().trim().min(4).max(12) });
export const PairDisplayBody = z.object({ code: z.string().trim().min(4).max(12) });

export interface User {
  id: string;
  username: string;
  displayName: string;
}

export interface ServerConfig {
  signupCodeRequired: boolean;
}

export interface CampaignSummary {
  id: string;
  name: string;
  role: Role;
  memberCount: number;
}

export interface NewDisplay {
  id: string;
  token: string;
  code: string;
}

// ---------- maps ----------

export interface Token {
  id: string;
  sceneId: string;
  name: string;
  color: string;
  /** Top-left cell of the token. */
  col: number;
  row: number;
  /** Side length in cells: 1 = Medium or smaller, 2 = Large, 3 = Huge, 4 = Gargantuan. */
  size: number;
  /** Hidden tokens are only sent to the GM. */
  hidden: boolean;
  /** The player who may move this token, if any. */
  ownerUserId: string | null;
}

export interface SceneSummary {
  id: string;
  name: string;
  imageUrl: string | null;
}

/** A scene as one client may see it: players never receive hidden or fogged tokens. */
export interface SceneView extends SceneSummary {
  /** Map size in map pixels (the image's natural size, or grid-sized for blank scenes). */
  width: number;
  height: number;
  grid: Grid;
  fogEnabled: boolean;
  /** Base64 FogMask of revealed cells (see @dnd/rules). */
  fog: string;
  tokens: Token[];
}

/** A rectangle of the map in map pixels, used to point table screens at part of the map. */
export interface CameraRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const Id = z.string().min(1).max(64);
const Color = z.string().regex(/^#[0-9a-f]{6}$/i);
const Cell = z.number().int().min(0).max(10_000);

export const GridPatch = z
  .object({
    size: z.number().min(8).max(2000),
    offsetX: z.number().min(0).max(2000),
    offsetY: z.number().min(0).max(2000),
    visible: z.boolean(),
    feetPerCell: z.number().int().min(1).max(100),
  })
  .partial();

const TokenFields = z.object({
  name: z.string().trim().min(1).max(40),
  color: Color,
  size: z.number().int().min(1).max(6),
  hidden: z.boolean(),
  ownerUserId: Id.nullable(),
});

// ---------- WebSocket ----------

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('roll'),
    expr: z.string().min(1).max(200),
    label: z.string().trim().max(80).optional(),
    visibility: z.enum(['public', 'gm']),
  }),
  z.object({
    type: z.literal('chat'),
    text: z.string().trim().min(1).max(1000),
    visibility: z.enum(['public', 'gm']),
  }),

  // Scenes (GM only)
  z.object({
    type: z.literal('scene:create'),
    name: z.string().trim().min(1).max(80),
    fileId: Id.nullable(),
    width: z.number().int().min(64).max(20_000),
    height: z.number().int().min(64).max(20_000),
    grid: GridPatch.optional(),
  }),
  z.object({
    type: z.literal('scene:update'),
    sceneId: Id,
    name: z.string().trim().min(1).max(80).optional(),
    grid: GridPatch.optional(),
    fogEnabled: z.boolean().optional(),
  }),
  z.object({ type: z.literal('scene:delete'), sceneId: Id }),
  /** Shows a scene to players and table screens (null hides the map). */
  z.object({ type: z.literal('scene:activate'), sceneId: Id.nullable() }),
  /** Which scene the GM is looking at / preparing; doesn't affect players. */
  z.object({ type: z.literal('scene:view'), sceneId: Id }),
  z.object({
    type: z.literal('fog:paint'),
    sceneId: Id,
    cells: z.array(z.number().int().min(0)).max(62_500),
    reveal: z.boolean(),
  }),
  z.object({ type: z.literal('fog:fill'), sceneId: Id, reveal: z.boolean() }),

  // Tokens (GM; players may move their own)
  TokenFields.partial({ size: true, hidden: true, ownerUserId: true }).extend({
    type: z.literal('token:create'),
    sceneId: Id,
    col: Cell,
    row: Cell,
  }),
  TokenFields.partial().extend({ type: z.literal('token:update'), tokenId: Id }),
  z.object({ type: z.literal('token:move'), tokenId: Id, col: Cell, row: Cell }),
  z.object({ type: z.literal('token:delete'), tokenId: Id }),

  // Pointers
  z.object({ type: z.literal('ping'), sceneId: Id, x: z.number().finite(), y: z.number().finite() }),
  /** GM's view, relayed to table screens so they show what the GM frames. */
  z.object({
    type: z.literal('camera'),
    sceneId: Id,
    rect: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      w: z.number().positive().finite(),
      h: z.number().positive().finite(),
    }),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export interface Member {
  userId: string;
  name: string;
  role: Role;
  online: boolean;
}

export interface DisplayInfo {
  id: string;
  name: string;
  online: boolean;
}

export interface LogAuthor {
  userId: string;
  name: string;
  role: Role;
}

interface LogBase {
  id: number;
  at: string;
  author: LogAuthor;
  visibility: Visibility;
}

export type LogEntry =
  | (LogBase & { kind: 'roll'; label?: string; roll: RollResult })
  | (LogBase & { kind: 'chat'; text: string });

export interface Hello {
  type: 'hello';
  you: { role: ClientRole; userId?: string; name?: string };
  campaign: { id: string; name: string; inviteCode?: string };
  members: Member[];
  /** Only sent to GMs. */
  displays?: DisplayInfo[];
  log: LogEntry[];
  activeSceneId: string | null;
  /** The scene this client is looking at: the active one, or for the GM whichever they opened. */
  scene: SceneView | null;
  /** Only sent to GMs. */
  scenes?: SceneSummary[];
}

export type ServerMessage =
  | Hello
  | { type: 'members'; members: Member[] }
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'log'; entry: LogEntry }
  | { type: 'error'; message: string }
  | { type: 'scene'; scene: SceneView | null }
  | { type: 'scenes'; scenes: SceneSummary[]; activeSceneId: string | null }
  | { type: 'ping'; sceneId: string; x: number; y: number; name: string; role: ClientRole }
  | { type: 'camera'; sceneId: string; rect: CameraRect }
  /** Sent to a table display that is not (or no longer) paired with a campaign. */
  | { type: 'display:unpaired'; code: string };

/** WebSocket close codes used by the server. */
export const CloseCode = {
  Unauthorized: 4401,
  Forbidden: 4403,
  NotFound: 4404,
} as const;
