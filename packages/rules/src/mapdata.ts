// Walls, doors and terrain drawn on a scene's grid. Walls and doors sit on cell edges, terrain
// fills whole cells. Everything is stored as dense byte layers and serialised as run-length text.

import { FogMask } from './grid';

/**
 * A cell edge, named after the cell it belongs to: the top or the left side of (col, row).
 * The bottom border of the map is the top side of row = rows, the right border the left side
 * of col = cols, so every edge has exactly one name.
 */
export interface Edge {
  side: 'top' | 'left';
  col: number;
  row: number;
}

export const DOOR_STATES = ['open', 'closed', 'locked'] as const;
export type DoorState = (typeof DOOR_STATES)[number];

export type EdgeFeature = { kind: 'wall' } | { kind: 'door'; state: DoorState; secret: boolean };

// Edge codes: 0 nothing, 1 wall, 2–4 door (open, closed, locked), 5–7 the same as secret doors.
const WALL = 1;
const DOOR = 2;
const SECRET_DOOR = 5;

export function edgeCode(feature: EdgeFeature | null): number {
  if (!feature) return 0;
  if (feature.kind === 'wall') return WALL;
  return (feature.secret ? SECRET_DOOR : DOOR) + DOOR_STATES.indexOf(feature.state);
}

export function edgeFeature(code: number): EdgeFeature | null {
  if (code === WALL) return { kind: 'wall' };
  if (code >= DOOR && code < SECRET_DOOR + DOOR_STATES.length) {
    const secret = code >= SECRET_DOOR;
    return { kind: 'door', state: DOOR_STATES[code - (secret ? SECRET_DOOR : DOOR)]!, secret };
  }
  return null;
}

/** Walls and closed or locked doors stop movement; open doors don't. */
export function edgeBlocks(code: number): boolean {
  const f = edgeFeature(code);
  return f !== null && (f.kind === 'wall' || f.state !== 'open');
}

/**
 * Terrain types. The index is the stored code, so only ever append to this list.
 * Difficult terrain costs one extra square of movement per square entered (2024 rules); water
 * counts as difficult because swimming without a Swim Speed costs the same extra movement.
 */
export const TERRAINS = [
  { id: 'none', label: 'Clear', passable: true, difficult: false },
  { id: 'floor', label: 'Floor', passable: true, difficult: false },
  { id: 'rock', label: 'Solid rock', passable: false, difficult: false },
  { id: 'difficult', label: 'Difficult', passable: true, difficult: true },
  { id: 'water', label: 'Water', passable: true, difficult: true },
] as const;
export type TerrainId = (typeof TERRAINS)[number]['id'];
export const TERRAIN_IDS = TERRAINS.map((t) => t.id) as [TerrainId, ...TerrainId[]];

export function terrainCode(id: TerrainId): number {
  return TERRAIN_IDS.indexOf(id);
}

export function terrainInfo(code: number): (typeof TERRAINS)[number] {
  return TERRAINS[code] ?? TERRAINS[0];
}

/** Rows/columns to add (positive) or remove (negative) on each side of a grid. */
export interface GridResize {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const FORMAT = '1';

/** Run-length text for a byte layer: `<value><count>` runs in base 36, trailing zeros dropped. */
function encodeLayer(layer: Uint8Array): string {
  let end = layer.length;
  while (end > 0 && layer[end - 1] === 0) end--;
  const runs: string[] = [];
  for (let i = 0; i < end; ) {
    const v = layer[i]!;
    let j = i + 1;
    while (j < end && layer[j] === v) j++;
    const n = j - i;
    runs.push(v.toString(36) + (n > 1 ? n.toString(36) : ''));
    i = j;
  }
  return runs.join('.');
}

/** Inverse of encodeLayer; anything malformed or the wrong size decodes as an empty layer. */
function decodeLayer(text: string | undefined, length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (!text) return out;
  let i = 0;
  for (const run of text.split('.')) {
    const v = parseInt(run[0] ?? '', 36);
    const n = run.length > 1 ? parseInt(run.slice(1), 36) : 1;
    if (!(v >= 0 && n > 0 && i + n <= length)) return new Uint8Array(length);
    out.fill(v, i, i + n);
    i += n;
  }
  return out;
}

/** Walls, doors and terrain for a cols × rows grid. */
export class MapData {
  /** Top edges, row-major: (rows + 1) × cols. */
  readonly top: Uint8Array;
  /** Left edges, row-major: rows × (cols + 1). */
  readonly left: Uint8Array;
  /** Terrain code per cell, row-major. */
  readonly terrain: Uint8Array;

  constructor(
    readonly cols: number,
    readonly rows: number,
    layers?: { top: Uint8Array; left: Uint8Array; terrain: Uint8Array },
  ) {
    const sized = (a: Uint8Array | undefined, n: number) => (a && a.length === n ? a : new Uint8Array(n));
    this.top = sized(layers?.top, (rows + 1) * cols);
    this.left = sized(layers?.left, rows * (cols + 1));
    this.terrain = sized(layers?.terrain, rows * cols);
  }

  static decode(encoded: string, cols: number, rows: number): MapData {
    const [format, top, left, terrain] = encoded.split('|');
    if (format !== FORMAT) return new MapData(cols, rows);
    return new MapData(cols, rows, {
      top: decodeLayer(top, (rows + 1) * cols),
      left: decodeLayer(left, rows * (cols + 1)),
      terrain: decodeLayer(terrain, rows * cols),
    });
  }

  /** Deterministic: equal maps always encode to the same string, and an empty map to ''. */
  encode(): string {
    const layers = [this.top, this.left, this.terrain].map(encodeLayer);
    return layers.every((l) => l === '') ? '' : [FORMAT, ...layers].join('|');
  }

  clone(): MapData {
    return new MapData(this.cols, this.rows, { top: this.top.slice(), left: this.left.slice(), terrain: this.terrain.slice() });
  }

  /** Index into `top` or `left`, or -1 if the edge isn't on this grid. */
  edgeIndex(e: Edge): number {
    if (e.side === 'top') {
      return e.col >= 0 && e.col < this.cols && e.row >= 0 && e.row <= this.rows ? e.row * this.cols + e.col : -1;
    }
    return e.col >= 0 && e.col <= this.cols && e.row >= 0 && e.row < this.rows ? e.row * (this.cols + 1) + e.col : -1;
  }

  edge(e: Edge): number {
    const i = this.edgeIndex(e);
    return i < 0 ? 0 : (e.side === 'top' ? this.top : this.left)[i]!;
  }

  setEdge(e: Edge, code: number): void {
    const i = this.edgeIndex(e);
    if (i >= 0) (e.side === 'top' ? this.top : this.left)[i] = code;
  }

  feature(e: Edge): EdgeFeature | null {
    return edgeFeature(this.edge(e));
  }

  blocks(e: Edge): boolean {
    return edgeBlocks(this.edge(e));
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  /** Terrain code of a cell; outside the grid counts as clear. */
  terrainAt(col: number, row: number): number {
    return this.inBounds(col, row) ? this.terrain[row * this.cols + col]! : 0;
  }

  setTerrain(col: number, row: number, code: number): void {
    if (this.inBounds(col, row)) this.terrain[row * this.cols + col] = code;
  }

  passable(col: number, row: number): boolean {
    return terrainInfo(this.terrainAt(col, row)).passable;
  }

  difficult(col: number, row: number): boolean {
    return terrainInfo(this.terrainAt(col, row)).difficult;
  }

  /** Every edge with something on it, top edges first, each in row-major order. */
  *edges(): Generator<{ edge: Edge; code: number }> {
    for (let i = 0; i < this.top.length; i++) {
      if (this.top[i]) yield { edge: { side: 'top', col: i % this.cols, row: Math.floor(i / this.cols) }, code: this.top[i]! };
    }
    const w = this.cols + 1;
    for (let i = 0; i < this.left.length; i++) {
      if (this.left[i]) yield { edge: { side: 'left', col: i % w, row: Math.floor(i / w) }, code: this.left[i]! };
    }
  }

  /**
   * The map as players and table screens may see it: closed secret doors look like plain walls
   * (an open one is plainly a door), and with fog on, nothing behind the fog is sent.
   */
  forPlayers(fog?: FogMask): MapData {
    const out = this.clone();
    const visible = (c1: number, r1: number, c2: number, r2: number) => !fog || fog.isRevealed(c1, r1) || fog.isRevealed(c2, r2);
    for (const { edge, code } of this.edges()) {
      const { col: c, row: r } = edge;
      const seen = edge.side === 'top' ? visible(c, r - 1, c, r) : visible(c - 1, r, c, r);
      const f = edgeFeature(code);
      let next = code;
      if (!seen) next = 0;
      else if (f?.kind === 'door' && f.secret) next = f.state === 'open' ? edgeCode({ ...f, secret: false }) : WALL;
      if (next !== code) out.setEdge(edge, next);
    }
    if (fog) {
      for (let i = 0; i < out.terrain.length; i++) if (!fog.isRevealed(i % this.cols, Math.floor(i / this.cols))) out.terrain[i] = 0;
    }
    return out;
  }

  /** A copy with rows/columns added or removed on each side; what remains keeps its place on the map. */
  resized(d: GridResize): MapData {
    const cols = this.cols + d.left + d.right;
    const rows = this.rows + d.top + d.bottom;
    const out = new MapData(cols, rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) out.setTerrain(c + d.left, r + d.top, this.terrainAt(c, r));
    }
    for (const { edge, code } of this.edges()) out.setEdge({ ...edge, col: edge.col + d.left, row: edge.row + d.top }, code);
    return out;
  }
}

/** Fog for a resized grid: revealed cells stay revealed where they still exist, new cells start fogged. */
export function resizeFog(fog: FogMask, d: GridResize): FogMask {
  const out = new FogMask(fog.cols + d.left + d.right, fog.rows + d.top + d.bottom);
  for (let r = 0; r < fog.rows; r++) {
    for (let c = 0; c < fog.cols; c++) if (fog.isRevealed(c, r)) out.set(c + d.left, r + d.top, true);
  }
  return out;
}
