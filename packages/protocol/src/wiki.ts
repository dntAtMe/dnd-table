// Campaign wiki pages: GM-written notes on NPCs, places, factions, lore, items and sessions,
// linked with [[Title]] and shared with nobody, everyone, or chosen players.
import { z } from 'zod';

const Id = z.string().min(1).max(64);

export const WIKI_CATEGORIES = ['npc', 'location', 'faction', 'item', 'lore', 'session', 'other'] as const;
export type WikiCategory = (typeof WIKI_CATEGORIES)[number];

export const WIKI_CATEGORY_LABELS: Record<WikiCategory, string> = {
  npc: 'NPC',
  location: 'Location',
  faction: 'Faction',
  item: 'Item',
  lore: 'Lore',
  session: 'Session',
  other: 'Other',
};

/** Who sees a page: only the GM, every player, or the listed players. */
export const WIKI_AUDIENCES = ['gm', 'all', 'players'] as const;
export type WikiAudience = (typeof WIKI_AUDIENCES)[number];

export const WIKI_TITLE_MAX = 120;
export const WIKI_BODY_MAX = 50_000;
export const WIKI_SECRET_MAX = 20_000;
export const WIKI_ALIASES_MAX = 10;
export const WIKI_TAGS_MAX = 20;

/** A page as one client may see it. Players only ever receive pages shared with them. */
export interface WikiPageView {
  id: string;
  title: string;
  /** Other names that also link to the page ("Gundren" for "Gundren Rockseeker"). */
  aliases: string[];
  category: WikiCategory;
  tags: string[];
  imageUrl: string | null;
  /** Plain text with [[links]]: blank lines separate paragraphs. Never HTML. */
  body: string;
  /** Display name of the GM who wrote it. */
  authorName: string;
  createdAt: string;
  /** Last change to what players can see (secret notes don't count). */
  updatedAt: string;
  /** GM only. */
  fileId?: string | null;
  audience?: WikiAudience;
  /** GM only: who it is shared with when audience is 'players'. */
  userIds?: string[];
  /** GM only: notes never sent to players. */
  secret?: string;
}

// [ ] | would break [[Title]] links; titles and aliases can't contain them.
const Name = z
  .string()
  .trim()
  .min(1)
  .max(WIKI_TITLE_MAX)
  .regex(/^[^[\]|]*$/, 'Names cannot contain [ ] or |');
const Aliases = z.array(Name).max(WIKI_ALIASES_MAX);
const Tags = z.array(z.string().trim().min(1).max(40)).max(WIKI_TAGS_MAX);
const Category = z.enum(WIKI_CATEGORIES);
const Body = z.string().max(WIKI_BODY_MAX);
const Secret = z.string().max(WIKI_SECRET_MAX);
const Audience = z.enum(WIKI_AUDIENCES);
const UserIds = z.array(Id).max(50);

export const WikiMessages = [
  /** GM only. Titles (and aliases) must be unique in the campaign, ignoring case. */
  z.object({
    type: z.literal('wiki:create'),
    title: Name,
    aliases: Aliases.optional(),
    category: Category,
    tags: Tags.optional(),
    fileId: Id.nullable().optional(),
    body: Body,
    secret: Secret.optional(),
    audience: Audience,
    userIds: UserIds.optional(),
  }),
  /** GM only. Omitted fields stay as they are; fileId null removes the image. */
  z.object({
    type: z.literal('wiki:update'),
    pageId: Id,
    title: Name.optional(),
    aliases: Aliases.optional(),
    category: Category.optional(),
    tags: Tags.optional(),
    fileId: Id.nullable().optional(),
    body: Body.optional(),
    secret: Secret.optional(),
    audience: Audience.optional(),
    userIds: UserIds.optional(),
  }),
  /** GM only. */
  z.object({ type: z.literal('wiki:delete'), pageId: Id }),
] as const;

export type WikiMessage = z.infer<(typeof WikiMessages)[number]>;

export type WikiServerMessage = { type: 'wiki'; pages: WikiPageView[] };
