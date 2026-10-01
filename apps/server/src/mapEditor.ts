// Map editing on the server: walls, doors, terrain and resizing blank grids. The hub looks up
// the scene and stores what these functions return.
import type { ClientRole, MapMessage, Token } from '@dnd/protocol';
import {
  GRID_LIMITS,
  edgeCode,
  gridGeometry,
  resizeFog,
  terrainCode,
  type Edge,
  type GridGeometry,
  type GridResize,
} from '@dnd/rules';
import { GameError, fogMask, mapData } from './scenes';
import type { SceneRecord } from './store';

const WALL = edgeCode({ kind: 'wall' });
/** Same cap as scene:create, so a grown map can always be re-created. */
const MAX_SIDE_PX = 20_000;

export interface MapActor {
  role: ClientRole;
  userId?: string;
  /** Whether the scene is the one players currently see. */
  inPlay: boolean;
}

export interface MapChange {
  scene: Partial<Pick<SceneRecord, 'map' | 'fog' | 'width' | 'height'>>;
  /** Tokens whose position changed. */
  tokens?: Token[];
}

/** Applies one editor message to a scene. Throws GameError for anything the actor may not do. */
export function applyMapEdit(scene: SceneRecord, tokens: Token[], msg: MapMessage, actor: MapActor): MapChange {
  if (msg.type === 'door:toggle') return { scene: { map: toggleDoor(scene, tokens, msg.edge, actor) } };
  if (actor.role !== 'gm') throw new GameError('Only the GM can do that');
  if (msg.type === 'map:resize') return resizeScene(scene, tokens, msg);

  const map = mapData(scene);
  switch (msg.type) {
    case 'map:walls':
      for (const edge of msg.edges) map.setEdge(edge, msg.wall ? WALL : 0);
      break;
    case 'map:door':
      if (map.edgeIndex(msg.edge) < 0) throw new GameError('That edge is off the map');
      map.setEdge(msg.edge, edgeCode({ kind: 'door', state: msg.state, secret: msg.secret }));
      break;
    case 'map:terrain': {
      const code = terrainCode(msg.terrain);
      for (const i of msg.cells) if (i < map.terrain.length) map.terrain[i] = code;
      break;
    }
    case 'map:fill':
      map.terrain.fill(terrainCode(msg.terrain));
      break;
    case 'map:clear-walls':
      map.top.fill(0);
      map.left.fill(0);
      break;
  }
  return { scene: { map: map.encode() } };
}

/** Is any cell of the token next to this edge (on either side of it)? */
function touches(token: Token, edge: Edge): boolean {
  const sides =
    edge.side === 'top'
      ? [{ col: edge.col, row: edge.row - 1 }, edge]
      : [{ col: edge.col - 1, row: edge.row }, edge];
  return sides.some((c) => c.col >= token.col && c.col < token.col + token.size && c.row >= token.row && c.row < token.row + token.size);
}

function toggleDoor(scene: SceneRecord, tokens: Token[], edge: Edge, actor: MapActor): string {
  const map = mapData(scene);
  const f = map.feature(edge);
  // Players see closed secret doors as walls, so answer exactly as if it were one.
  if (f?.kind !== 'door' || (actor.role !== 'gm' && f.secret && f.state !== 'open')) throw new GameError("There's no door there");
  if (actor.role !== 'gm') {
    if (!actor.inPlay) throw new GameError('That scene is not in play');
    if (f.state === 'locked') throw new GameError('The door is locked');
    if (!tokens.some((t) => t.ownerUserId === actor.userId && touches(t, edge))) {
      throw new GameError('Move your token next to the door first');
    }
  }
  map.setEdge(edge, edgeCode({ ...f, state: f.state === 'open' ? 'closed' : 'open' }));
  return map.encode();
}

function resizeScene(scene: SceneRecord, tokens: Token[], d: GridResize): MapChange {
  if (scene.imageUrl) throw new GameError('Only blank maps can be resized');
  if (!d.top && !d.right && !d.bottom && !d.left) return { scene: {} };
  const { size } = scene.grid;
  const geo = gridGeometry(scene.grid, scene.width, scene.height);
  const cols = geo.cols + d.left + d.right;
  const rows = geo.rows + d.top + d.bottom;
  // The narrowest whole-pixel size that still holds exactly `n` cells.
  const span = (n: number, origin: number, current: number, old: number) => (n === old ? current : Math.floor(origin + n * size));
  const width = span(cols, geo.originX, scene.width, geo.cols);
  const height = span(rows, geo.originY, scene.height, geo.rows);
  if (cols < 1 || rows < 1 || width < 1 || height < 1) throw new GameError('The map needs at least one row and one column');
  if (cols * rows > GRID_LIMITS.maxCells || width > MAX_SIDE_PX || height > MAX_SIDE_PX) throw new GameError('The map is too big to grow further');

  const moved: Token[] = [];
  for (const t of tokens) {
    const col = t.col + d.left;
    const row = t.row + d.top;
    if (col < 0 || row < 0 || col + t.size > cols || row + t.size > rows) {
      throw new GameError(`${t.name} is in the way: move it off that edge first`);
    }
    if (col !== t.col || row !== t.row) moved.push({ ...t, col, row });
  }
  return {
    scene: {
      width,
      height,
      map: mapData(scene).resized(d).encode(),
      fog: scene.fog && resizeFog(fogMask(scene), d).encode(),
    },
    tokens: moved,
  };
}

/** When grid calibration changes the cell count, keep map data anchored at the top-left cell. */
export function remapForGrid(scene: SceneRecord, before: GridGeometry, after: GridGeometry): string {
  if (!scene.map) return '';
  return mapData(scene)
    .resized({ top: 0, left: 0, right: after.cols - before.cols, bottom: after.rows - before.rows })
    .encode();
}
