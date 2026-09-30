// Shapes shared by the server and the web client: REST payloads and WebSocket messages.
import { z } from 'zod';
import type { RollResult } from '@dnd/rules';

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
}

export type ServerMessage =
  | Hello
  | { type: 'members'; members: Member[] }
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'log'; entry: LogEntry }
  | { type: 'error'; message: string }
  /** Sent to a table display that is not (or no longer) paired with a campaign. */
  | { type: 'display:unpaired'; code: string };

/** WebSocket close codes used by the server. */
export const CloseCode = {
  Unauthorized: 4401,
  Forbidden: 4403,
  NotFound: 4404,
} as const;
