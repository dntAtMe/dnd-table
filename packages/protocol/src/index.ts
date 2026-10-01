// Shapes shared by the server and the web client: REST payloads and WebSocket messages.
import { z } from 'zod';
import { AudioMessages, type AudioServerMessage, type AudioState, type Track } from './audio';
import { HandoutMessages, type HandoutServerMessage, type HandoutView, type Showcase } from './handouts';
import { MapMessages } from './map';
import { TemplateMessages, type MapTemplate } from './templates';
import { VisionMessages } from './vision';

export * from './audio';
export * from './handouts';
export * from './map';
export * from './templates';
export * from './vision';
import { ABILITIES, CHARACTER_VERSION, CONDITION_IDS, MAX_EXHAUSTION, SKILL_IDS, type Character, type Grid, type HealthStatus, type LightSource, type RollResult, type SceneVision, type TokenSenses } from '@dnd/rules';

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
  /** Character this token represents, if any. */
  characterId: string | null;
  /** Light the token carries (torch, lantern, spell…), if any. */
  light?: LightSource;
  /** Darkvision, blindsight and truesight; darkvision defaults to the character's. */
  senses?: TokenSenses;
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
  /** Encoded MapData: walls, doors and terrain. Players get closed secret doors as walls. */
  map: string;
  tokens: Token[];
  /** Lighting and vision settings. */
  vision: SceneVision;
  /**
   * With vision on, players and table screens get the cells their tokens see right now (a base64
   * FogMask), and those of them seen only in dim light. Their `fog` then also counts what they see.
   */
  visible?: string;
  dim?: string;
  /** Area-of-effect templates; hidden ones and ones on tokens this client can't see are left out. */
  templates: MapTemplate[];
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

// ---------- characters ----------

const Score = z.number().int().min(1).max(30);
const Scores = z.object(Object.fromEntries(ABILITIES.map((a) => [a, Score])) as Record<(typeof ABILITIES)[number], typeof Score>);
const PartialScores = z
  .object(Object.fromEntries(ABILITIES.map((a) => [a, z.number().int().min(-4).max(10)])) as Record<(typeof ABILITIES)[number], z.ZodNumber>)
  .partial();
const SkillId = z.enum(SKILL_IDS as [string, ...string[]]);
const ShortText = z.string().max(80);
const Count = z.number().int().min(0).max(999_999);

export const CharacterState = z.object({
  hp: z.number().int().min(0).max(9999),
  tempHp: z.number().int().min(0).max(9999),
  deathSaves: z.object({ successes: z.number().int().min(0).max(3), failures: z.number().int().min(0).max(3) }),
  hitDiceSpent: z.number().int().min(0).max(20),
  slotsUsed: z.array(z.number().int().min(0).max(9)).length(9),
  resourcesUsed: z.record(z.string().max(40), z.number().int().min(0).max(999)),
  conditions: z.array(z.enum(CONDITION_IDS as [string, ...string[]])).max(15),
  exhaustion: z.number().int().min(0).max(MAX_EXHAUSTION),
  heroicInspiration: z.boolean(),
});

/** Validates a stored character document (see Character in @dnd/rules). */
export const CharacterData = z.object({
  version: z.literal(CHARACTER_VERSION),
  name: z.string().trim().min(1).max(60),
  color: Color,
  classId: ShortText,
  level: z.number().int().min(1).max(20),
  subclassId: ShortText.nullable(),
  speciesId: ShortText,
  subspeciesId: ShortText.nullable(),
  size: z.string().max(20),
  backgroundId: ShortText,
  baseScores: Scores,
  backgroundBonus: PartialScores,
  advancements: z.array(z.object({ level: z.number().int().min(1).max(20), featId: ShortText, increases: PartialScores })).max(20),
  fightingStyle: ShortText.nullable(),
  extraFeats: z.array(z.object({ featId: ShortText, note: ShortText.optional() })).max(10),
  skills: z.array(SkillId).max(18),
  expertise: z.array(SkillId).max(18),
  weaponMasteries: z.array(ShortText).max(10),
  hpRolls: z.array(z.number().int().min(1).max(12).nullable()).max(19),
  languages: z.array(ShortText).max(20),
  tools: z.array(ShortText).max(20),
  equipment: z.object({
    armorId: ShortText.nullable(),
    shield: z.boolean(),
    weapons: z.array(z.object({ weaponId: ShortText, name: ShortText.optional() })).max(30),
    items: z.array(z.object({ name: ShortText, qty: z.number().int().min(0).max(9999), notes: z.string().max(500).optional() })).max(200),
  }),
  currency: z.object({ cp: Count, sp: Count, ep: Count, gp: Count, pp: Count }),
  spells: z
    .array(
      z.object({
        spellId: ShortText.optional(),
        name: ShortText,
        level: z.number().int().min(0).max(9),
        prepared: z.boolean(),
        notes: z.string().max(500).optional(),
      }),
    )
    .max(200),
  state: CharacterState,
  notes: z.string().max(20_000),
});

export interface CharacterRecord {
  id: string;
  ownerUserId: string;
  data: Character;
  updatedAt: string;
}

// ---------- combat ----------

export type CombatantKind = 'character' | 'monster' | 'npc';

/**
 * A combatant as one client may see it. Players and table screens never receive hidden combatants
 * (except their own), and see other creatures' health only as a status, never as numbers.
 */
export interface CombatantView {
  id: string;
  name: string;
  kind: CombatantKind;
  tokenId: string | null;
  characterId: string | null;
  /** SRD monster id (GM only). */
  monsterId?: string;
  ownerUserId: string | null;
  initiative: number | null;
  /** Numbers below are sent to the GM, the owner, and to players for party characters. */
  initiativeBonus?: number;
  ac?: number | null;
  hp?: number | null;
  hpMax?: number | null;
  tempHp?: number;
  /** Null when hit points aren't tracked for this combatant. */
  status: HealthStatus | null;
  conditions: string[];
  hidden: boolean;
}

/** The running encounter; combatants are in initiative order. */
export interface CombatView {
  round: number;
  /** Whose turn it is; null before the first turn (or, for players, while a hidden creature acts). */
  activeId: string | null;
  combatants: CombatantView[];
}

const ConditionId = z.enum(CONDITION_IDS as [string, ...string[]]);
const Hp = z.number().int().min(0).max(9999);

export const CombatantSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('token'), tokenId: Id }),
  z.object({ kind: z.literal('character'), characterId: Id }),
  z.object({
    kind: z.literal('monster'),
    monsterId: Id,
    count: z.number().int().min(1).max(20).optional(),
    hidden: z.boolean().optional(),
    /** Also put a token on the scene the GM is looking at. */
    placeToken: z.boolean().optional(),
    /** Roll hit points from the hit dice instead of taking the average. */
    rollHp: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('custom'),
    name: z.string().trim().min(1).max(40),
    initiativeBonus: z.number().int().min(-10).max(30).optional(),
    hidden: z.boolean().optional(),
  }),
]);

// ---------- WebSocket ----------

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('roll'),
    expr: z.string().min(1).max(200),
    label: z.string().trim().max(80).optional(),
    visibility: z.enum(['public', 'gm']),
    /** An initiative roll for this character: also sets its initiative in the running combat. */
    initiativeFor: Id.optional(),
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

  // Characters (owner or GM)
  z.object({ type: z.literal('character:create'), data: CharacterData }),
  z.object({ type: z.literal('character:update'), characterId: Id, data: CharacterData }),
  /** Merges into the live state only, so quick HP/slot changes don't overwrite other edits. */
  z.object({ type: z.literal('character:state'), characterId: Id, patch: CharacterState.partial() }),
  z.object({ type: z.literal('character:delete'), characterId: Id }),
  z.object({
    type: z.literal('character:rest'),
    characterId: Id,
    kind: z.enum(['short', 'long']),
    hitDice: z.number().int().min(0).max(20).optional(),
  }),
  /** Puts the character's token on the scene the sender is looking at. */
  z.object({ type: z.literal('character:token'), characterId: Id }),

  // Combat (GM, except where noted)
  /** Starts an encounter, optionally with every token on the scene the GM is looking at. */
  z.object({ type: z.literal('combat:start'), fromScene: z.boolean().optional() }),
  z.object({ type: z.literal('combat:end') }),
  z.object({ type: z.literal('combat:add'), source: CombatantSource }),
  z.object({ type: z.literal('combat:remove'), combatantId: Id }),
  /** Sets (value) or rolls initiative. Players may do this for their own character. */
  z.object({ type: z.literal('combat:initiative'), combatantId: Id, value: z.number().int().min(-10).max(60).optional() }),
  /** Rolls initiative for every non-character combatant that hasn't rolled yet. */
  z.object({ type: z.literal('combat:roll-initiative') }),
  /** Players may end their own turn ('next' while it's their turn). */
  z.object({ type: z.literal('combat:turn'), dir: z.enum(['next', 'prev']) }),
  /** Damage, healing or temporary HP (owners may adjust their own character). */
  z.object({ type: z.literal('combat:hp'), combatantId: Id, op: z.enum(['damage', 'heal', 'temp']), amount: Hp }),
  /** Owners may toggle conditions on their own character. */
  z.object({ type: z.literal('combat:condition'), combatantId: Id, condition: ConditionId, on: z.boolean() }),
  z.object({
    type: z.literal('combat:update'),
    combatantId: Id,
    name: z.string().trim().min(1).max(40).optional(),
    ac: z.number().int().min(0).max(50).nullable().optional(),
    hp: Hp.optional(),
    hpMax: Hp.min(1).nullable().optional(),
    initiativeBonus: z.number().int().min(-10).max(30).optional(),
    hidden: z.boolean().optional(),
  }),

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

  ...MapMessages,
  ...VisionMessages,
  ...TemplateMessages,
  ...HandoutMessages,
  ...AudioMessages,
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
  /** Party characters (not sent to table screens). Other players' private notes are removed. */
  characters: CharacterRecord[];
  /** The running encounter, filtered for this client. */
  combat: CombatView | null;
  /** GMs get every handout; players those shared with them; table screens none. */
  handouts: HandoutView[];
  /** What is shown over the map (players only get it when it's shown to them too). */
  showcase: Showcase | null;
  /** What's playing. */
  audio: AudioState;
  /** Only sent to GMs: the soundboard. */
  tracks?: Track[];
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
  | { type: 'characters'; characters: CharacterRecord[] }
  | { type: 'combat'; combat: CombatView | null }
  /** Sent to a table display that is not (or no longer) paired with a campaign. */
  | { type: 'display:unpaired'; code: string }
  | HandoutServerMessage
  | AudioServerMessage;

/** WebSocket close codes used by the server. */
export const CloseCode = {
  Unauthorized: 4401,
  Forbidden: 4403,
  NotFound: 4404,
} as const;
