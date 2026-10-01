import type { ClientRole, GridPatch, SceneSummary, SceneView, Token } from '@dnd/protocol';
import { DEFAULT_GRID, DEFAULT_SCENE_VISION, FogMask, GRID_LIMITS, MapData, gridGeometry, type Grid, type SceneVision, type Sight } from '@dnd/rules';
import type { z } from 'zod';
import type { SceneRecord } from './store';

/** A rule violation reported back to the client that sent the action. */
export class GameError extends Error {}

export interface Viewer {
  role: ClientRole;
  userId?: string;
}

export function summary(scene: SceneRecord): SceneSummary {
  return { id: scene.id, name: scene.name, imageUrl: scene.imageUrl };
}

export function fogMask(scene: Pick<SceneRecord, 'grid' | 'width' | 'height' | 'fog'>): FogMask {
  const { cols, rows } = gridGeometry(scene.grid, scene.width, scene.height);
  return scene.fog ? FogMask.decode(scene.fog, cols, rows) : new FogMask(cols, rows);
}

export function mapData(scene: Pick<SceneRecord, 'grid' | 'width' | 'height' | 'map'>): MapData {
  const { cols, rows } = gridGeometry(scene.grid, scene.width, scene.height);
  return MapData.decode(scene.map, cols, rows);
}

/**
 * Can this viewer see the token? GMs see everything; owners always see their own tokens. With
 * vision on (`visible` given), others are seen only where the viewer's tokens see right now.
 */
export function tokenVisible(token: Token, viewer: Viewer, scene: SceneRecord, fog: FogMask | undefined, visible?: FogMask): boolean {
  if (viewer.role === 'gm') return true;
  if (viewer.userId && token.ownerUserId === viewer.userId) return true;
  if (token.hidden) return false;
  if (visible) return visible.anyRevealed(token.col, token.row, token.size);
  return !scene.fogEnabled || !fog || fog.anyRevealed(token.col, token.row, token.size);
}

/**
 * The scene as one viewer may see it. `sight` (vision on, players and table screens only) is what
 * their tokens see: it limits the tokens sent, and counts as explored on top of the fog, so map
 * data there is sent too.
 */
export function sceneView(scene: SceneRecord, tokens: Token[], viewer: Viewer, vision: SceneVision = DEFAULT_SCENE_VISION, sight?: Sight): SceneView {
  let fog = scene.fogEnabled ? fogMask(scene) : undefined;
  if (fog && sight) for (let i = 0; i < fog.bits.length; i++) fog.bits[i]! |= sight.visible.bits[i] ?? 0;
  return {
    ...summary(scene),
    width: scene.width,
    height: scene.height,
    grid: scene.grid,
    fogEnabled: scene.fogEnabled,
    fog: fog ? fog.encode() : '',
    map: viewer.role === 'gm' || !scene.map ? scene.map : mapData(scene).forPlayers(fog).encode(),
    tokens: tokens.filter((t) => tokenVisible(t, viewer, scene, fog, sight?.visible)),
    vision,
    ...(sight && { visible: sight.visible.encode(), dim: sight.dim.encode() }),
  };
}

export function applyGridPatch(base: Grid, patch: z.infer<typeof GridPatch> | undefined, width: number, height: number): Grid {
  const grid: Grid = { ...DEFAULT_GRID, ...base, ...patch };
  if (grid.size < GRID_LIMITS.minSize) throw new GameError('Grid cells are too small');
  grid.offsetX %= grid.size;
  grid.offsetY %= grid.size;
  const { cols, rows } = gridGeometry(grid, width, height);
  if (cols * rows > GRID_LIMITS.maxCells) throw new GameError(`Grid too fine: ${cols}×${rows} cells`);
  return grid;
}

/** Keeps a token of the given size fully inside the grid. */
export function clampToGrid(scene: SceneRecord, col: number, row: number, size: number): { col: number; row: number } {
  const { cols, rows } = gridGeometry(scene.grid, scene.width, scene.height);
  return {
    col: Math.max(0, Math.min(col, cols - size)),
    row: Math.max(0, Math.min(row, rows - size)),
  };
}
