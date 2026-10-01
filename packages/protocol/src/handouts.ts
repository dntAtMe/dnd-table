// Handouts (letters, maps, portraits the GM shares) and the table showcase (an image or handout
// pushed full-screen over the map on table displays and, optionally, players' screens).
import { z } from 'zod';

const Id = z.string().min(1).max(64);

/** Who sees a handout: nobody but the GM (a draft), every player, or the listed players. */
export const HANDOUT_AUDIENCES = ['gm', 'all', 'players'] as const;
export type HandoutAudience = (typeof HANDOUT_AUDIENCES)[number];

export const HANDOUT_TEXT_MAX = 20_000;

/** A handout as one client may see it. Players only ever receive handouts shared with them. */
export interface HandoutView {
  id: string;
  title: string;
  /** Plain text: blank lines separate paragraphs. Never HTML. */
  text: string;
  imageUrl: string | null;
  /** When it was (re)shared or last changed while shared; null for drafts. */
  sharedAt: string | null;
  /** Players only: not opened since it was shared or last changed. */
  unread?: boolean;
  /** GM only. */
  fileId?: string | null;
  audience?: HandoutAudience;
  /** GM only: the players it is shared with when audience is 'players'. */
  userIds?: string[];
  createdAt?: string;
}

/** What table displays (and players, when the GM includes them) show over the map. */
export interface Showcase {
  /** Changes every time something is shown, so clients can tell a re-show apart. */
  id: string;
  handoutId: string | null;
  title: string;
  text: string;
  imageUrl: string | null;
  /** Also shown on players' screens. */
  toPlayers: boolean;
}

const Title = z.string().trim().min(1).max(120);
const Text = z.string().max(HANDOUT_TEXT_MAX);
const Audience = z.enum(HANDOUT_AUDIENCES);
const UserIds = z.array(Id).max(50);

export const HandoutMessages = [
  /** GM only. */
  z.object({
    type: z.literal('handout:create'),
    title: Title,
    text: Text,
    fileId: Id.nullable(),
    audience: Audience,
    userIds: UserIds.optional(),
  }),
  /** GM only. Omitted fields stay as they are; fileId null removes the image. */
  z.object({
    type: z.literal('handout:update'),
    handoutId: Id,
    title: Title.optional(),
    text: Text.optional(),
    fileId: Id.nullable().optional(),
    audience: Audience.optional(),
    userIds: UserIds.optional(),
  }),
  /** GM only. */
  z.object({ type: z.literal('handout:delete'), handoutId: Id }),
  /** A player opened a handout shared with them. */
  z.object({ type: z.literal('handout:read'), handoutId: Id }),
  /** GM only: shows a handout, or any uploaded image, on table displays (and players' screens). */
  z.object({
    type: z.literal('showcase:show'),
    handoutId: Id.optional(),
    fileId: Id.optional(),
    title: z.string().trim().max(120).optional(),
    toPlayers: z.boolean(),
  }),
  /** GM only: back to the map. */
  z.object({ type: z.literal('showcase:clear') }),
] as const;

export type HandoutMessage = z.infer<(typeof HandoutMessages)[number]>;

export type HandoutServerMessage =
  | { type: 'handouts'; handouts: HandoutView[] }
  | { type: 'showcase'; showcase: Showcase | null };
