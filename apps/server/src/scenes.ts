import type { ClientRole, GridPatch, MapTemplate, SceneSummary, SceneView, Token } from '@dnd/protocol';
import { DEFAULT_GRID, FogMask, GRID_LIMITS, MapData, gridGeometry, type Grid } from '@dnd/rules';
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

/** Can this viewer see the token? GMs see everything; owners always see their own tokens. */
export function tokenVisible(token: Token, viewer: Viewer, scene: SceneRecord, fog: FogMask | undefined): boolean {
  if (viewer.role === 'gm') return true;
  if (viewer.userId && token.ownerUserId === viewer.userId) return true;
  if (token.hidden) return false;
  return !scene.fogEnabled || !fog || fog.anyRevealed(token.col, token.row, token.size);
}

export function sceneView(scene: SceneRecord, tokens: Token[], viewer: Viewer, templates: MapTemplate[] = []): SceneView {
  const fog = scene.fogEnabled ? fogMask(scene) : undefined;
  const visible = tokens.filter((t) => tokenVisible(t, viewer, scene, fog));
  return {
    ...summary(scene),
    width: scene.width,
    height: scene.height,
    grid: scene.grid,
    fogEnabled: scene.fogEnabled,
    fog: fog ? fog.encode() : '',
    map: viewer.role === 'gm' || !scene.map ? scene.map : mapData(scene).forPlayers(fog).encode(),
    tokens: visible,
    templates: templateViews(templates, visible, viewer),
  };
}

/**
 * Templates this viewer may see: hidden ones are GM-only, and one following a token is only shown
 * when the token is, at the token's current space (so an Emanation moves with its creature).
 */
export function templateViews(templates: MapTemplate[], visibleTokens: Token[], viewer: Viewer): MapTemplate[] {
  const out: MapTemplate[] = [];
  for (const t of templates) {
    if (t.hidden && viewer.role !== 'gm') continue;
    if (!t.tokenId) {
      out.push(t);
      continue;
    }
    const token = visibleTokens.find((k) => k.id === t.tokenId);
    if (token) out.push({ ...t, x: token.col, y: token.row, span: token.size });
  }
  return out;
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
