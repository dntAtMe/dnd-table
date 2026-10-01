// Area-of-effect templates on a scene: a Fireball's Sphere, a Cone of Cold, Spirit Guardians.
import { AREA_SHAPES, type Area } from '@dnd/rules';
import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Color = z.string().regex(/^#[0-9a-f]{6}$/i);
/** Grid units (see Area in @dnd/rules); the server clamps them to the map. */
const Coord = z.number().finite().min(-1000).max(11_000);
const Feet = z.number().int().min(1).max(1000);

/** A template as clients see it. Geometry fields are an Area (see @dnd/rules) in the scene's grid. */
export interface MapTemplate extends Area {
  id: string;
  sceneId: string;
  /** Cylinder height in feet (shown only; the footprint is the circle). */
  height?: number;
  color: string;
  /** Usually the spell's name. */
  label: string;
  /** Who placed it; they and the GM may move or remove it. */
  ownerUserId: string | null;
  /**
   * The creature an Emanation extends from. It follows the token: the server fills in x, y and
   * span from the token's current space.
   */
  tokenId: string | null;
  /** Only the GM sees hidden templates. */
  hidden: boolean;
  /**
   * Lingering areas (a Cloudkill, Spirit Guardians) stay until removed. Others (a Fireball) are
   * cleared at the next turn in combat, or when their owner places another template.
   */
  linger: boolean;
}

/** Most templates a scene keeps at once. */
export const MAX_TEMPLATES = 60;

const Fields = z.object({
  size: Feet,
  width: Feet.optional(),
  height: Feet.optional(),
  x: Coord,
  y: Coord,
  angle: z.number().finite(),
  color: Color,
  label: z.string().trim().max(60),
  hidden: z.boolean(),
  linger: z.boolean(),
});

export const TemplateMessages = [
  /** Places a template. Players may place them on the scene in play, attached only to their own tokens. */
  Fields.partial({ label: true, hidden: true, linger: true }).extend({
    type: z.literal('template:place'),
    sceneId: Id,
    shape: z.enum(AREA_SHAPES),
    tokenId: Id.optional(),
  }),
  /** Moves, turns or edits a template. Its owner or the GM; only the GM may hide it. */
  Fields.partial().extend({ type: z.literal('template:update'), templateId: Id }),
  /** Removes a template (its owner or the GM). */
  z.object({ type: z.literal('template:delete'), templateId: Id }),
  /** Removes every template on a scene. GM only. */
  z.object({ type: z.literal('template:clear'), sceneId: Id }),
] as const;

export type TemplateMessage = z.infer<(typeof TemplateMessages)[number]>;
