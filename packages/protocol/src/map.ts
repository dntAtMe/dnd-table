// Map editor messages: walls, doors, terrain and resizing blank grids.
import { DOOR_STATES, TERRAIN_IDS } from '@dnd/rules';
import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Cell = z.number().int().min(0).max(10_000);
const Terrain = z.enum(TERRAIN_IDS);
const Resize = z.number().int().min(-50).max(50);

/** A cell edge: the top or left side of a cell (see Edge in @dnd/rules). */
export const EdgeRef = z.object({ side: z.enum(['top', 'left']), col: Cell, row: Cell });

export const MapMessages = [
  /** Draws walls on a run of edges, or (wall: false) clears walls and doors from them. GM only. */
  z.object({ type: z.literal('map:walls'), sceneId: Id, edges: z.array(EdgeRef).min(1).max(2000), wall: z.boolean() }),
  /** Puts a door on an edge, replacing whatever is there. GM only. */
  z.object({ type: z.literal('map:door'), sceneId: Id, edge: EdgeRef, state: z.enum(DOOR_STATES), secret: z.boolean() }),
  /**
   * Opens a closed door or closes an open one. The GM may also open locked doors; players may
   * open and close unlocked doors next to one of their tokens on the scene in play.
   */
  z.object({ type: z.literal('door:toggle'), sceneId: Id, edge: EdgeRef }),
  /** Paints terrain on cells (row-major indices). GM only. */
  z.object({ type: z.literal('map:terrain'), sceneId: Id, cells: z.array(z.number().int().min(0)).max(62_500), terrain: Terrain }),
  /** Paints the whole map with one terrain ('none' clears it). GM only. */
  z.object({ type: z.literal('map:fill'), sceneId: Id, terrain: Terrain }),
  /** Removes every wall and door. GM only. */
  z.object({ type: z.literal('map:clear-walls'), sceneId: Id }),
  /** Adds (positive) or removes (negative) rows/columns on each side of a blank scene. GM only. */
  z.object({ type: z.literal('map:resize'), sceneId: Id, top: Resize, right: Resize, bottom: Resize, left: Resize }),
] as const;

export type MapMessage = z.infer<(typeof MapMessages)[number]>;
