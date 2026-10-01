// Light and sight on the battle grid, following the 2024 rules (PHB "Vision and Light"):
//
// - Bright light: creatures see normally. Dim light (twilight, the edge of a torch's glow) makes an
//   area Lightly Obscured. Darkness makes it Heavily Obscured: a creature trying to see something
//   there has the Blinded condition, so for the map it simply can't see it. (The Disadvantage on
//   Wisdom (Perception) checks that dim light brings is out of scope here.)
// - Darkvision: within its range a creature sees in dim light as if it were bright light, and in
//   darkness as if it were dim light (so darkness becomes visible, but only as dim).
// - Blindsight: within its range a creature perceives its surroundings without relying on sight,
//   so light doesn't matter (we show those cells as dim). Truesight: within its range a creature
//   sees normally in normal and magical darkness (shown as bright).
// - Light sources shed bright light in a radius and dim light for a further distance; walls,
//   closed doors and solid rock stop light just like they stop sight.
//
// Line of sight runs between cell centres through `SightMap.lineOfSight`, the same exact grid walk
// that movement uses (see lineBlock in movement.ts), with the same conservative corner rule.
// Distances are grid distances as for the ruler (2024: every square, diagonal or not, counts one
// cell's worth of feet), so radii are squares on the grid.

import { FogMask } from './grid';
import { edgeBlocks, terrainInfo, type MapData } from './mapdata';
import type { Footprint } from './areas';

export const LIGHTING_LEVELS = ['bright', 'dim', 'dark'] as const;
/** Ambient light over a whole scene: daylight, twilight or moonlight, darkness (night, dungeons). */
export type Lighting = (typeof LIGHTING_LEVELS)[number];

export const LIGHTING_LABELS: Record<Lighting, string> = {
  bright: 'Bright (daylight)',
  dim: 'Dim (twilight, moonlight)',
  dark: 'Darkness (night, dungeon)',
};

/** Illumination of a cell, and how well a viewer sees it. Order matters: higher is better. */
export const DARK = 0;
export const DIM = 1;
export const BRIGHT = 2;
export type LightLevel = typeof DARK | typeof DIM | typeof BRIGHT;

/** Common light sources (2024 PHB equipment and spells). `dim` is the extra distance beyond `bright`. */
export const LIGHT_PRESETS = [
  { id: 'candle', label: 'Candle', bright: 5, dim: 5 },
  { id: 'torch', label: 'Torch', bright: 20, dim: 20 },
  { id: 'lamp', label: 'Lamp', bright: 15, dim: 30 },
  { id: 'lantern', label: 'Lantern (hooded)', bright: 30, dim: 30 },
  { id: 'light', label: 'Light (cantrip)', bright: 20, dim: 20 },
  { id: 'daylight', label: 'Daylight (spell)', bright: 60, dim: 60 },
] as const;
export const LIGHT_PRESET_IDS: [LightPresetId, ...LightPresetId[]] = ['custom', ...LIGHT_PRESETS.map((p) => p.id)];
export type LightPresetId = (typeof LIGHT_PRESETS)[number]['id'] | 'custom';

/** A light carried by a token: bright light out to `bright` feet, dim light for `dim` feet more. */
export interface LightSource {
  preset: LightPresetId;
  bright: number;
  dim: number;
}

/** Special senses of a token, in feet. A missing darkvision means "from the character sheet, if any". */
export interface TokenSenses {
  darkvision?: number;
  blindsight?: number;
  truesight?: number;
}

/** Per-scene lighting and vision settings. */
export interface SceneVision {
  /** Players see only what their tokens can see. */
  enabled: boolean;
  lighting: Lighting;
  /** Cells players see are revealed in the fog for good, so explored areas stay mapped. */
  dynamicFog: boolean;
}

export const DEFAULT_SCENE_VISION: SceneVision = { enabled: false, lighting: 'bright', dynamicFog: false };

export function lightPreset(id: LightPresetId): LightSource | null {
  const p = LIGHT_PRESETS.find((l) => l.id === id);
  return p ? { preset: p.id, bright: p.bright, dim: p.dim } : null;
}


export interface Emitter extends Footprint {
  bright: number;
  dim: number;
}

export interface Viewer extends Footprint {
  darkvision: number;
  blindsight: number;
  truesight: number;
}

/**
 * Walls, doors and solid rock reduced to what blocks sight, with a summed-area table of
 * "anything blocking here" so lines across open floor need no walk at all.
 */
export class SightMap {
  readonly cols: number;
  readonly rows: number;
  /** Blocking left edges, rows × (cols + 1), as in MapData.left. */
  private readonly vEdge: Uint8Array;
  /** Blocking top edges, (rows + 1) × cols, as in MapData.top. */
  private readonly hEdge: Uint8Array;
  /** Cells that block sight (solid rock). */
  readonly opaque: Uint8Array;
  /** sum[(r) * (cols + 1) + c] = blocker flags in cells [0, c) × [0, r). */
  private readonly sum: Int32Array;

  constructor(map: MapData) {
    const { cols, rows } = map;
    this.cols = cols;
    this.rows = rows;
    const blocks = new Uint8Array(16);
    for (let code = 0; code < blocks.length; code++) blocks[code] = edgeBlocks(code) ? 1 : 0;
    this.vEdge = map.left.map((code) => blocks[code] ?? 0);
    this.hEdge = map.top.map((code) => blocks[code] ?? 0);
    this.opaque = map.terrain.map((code) => (terrainInfo(code).passable ? 0 : 1));
    const W = cols + 1;
    this.sum = new Int32Array(W * (rows + 1));
    for (let r = 0; r < rows; r++) {
      let run = 0;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        run += this.opaque[i]! | this.hEdge[i]! | this.vEdge[r * W + c]!;
        this.sum[(r + 1) * W + c + 1] = this.sum[r * W + c + 1]! + run;
      }
    }
  }

  /** True if no cell in [c0, c1] × [r0, r1] is opaque or has a blocking top or left edge. */
  private clear(c0: number, r0: number, c1: number, r1: number): boolean {
    const W = this.cols + 1;
    const s = this.sum;
    return s[(r1 + 1) * W + c1 + 1]! - s[r0 * W + c1 + 1]! - s[(r1 + 1) * W + c0]! + s[r0 * W + c0]! === 0;
  }

  /**
   * Can a creature in cell (fc, fr) see cell (tc, tr)? Walks the line between the two centres
   * exactly like lineBlock: it is blocked by a wall or closed door on any grid line it crosses, and
   * by solid rock in any cell it passes through on the way (the target itself may be rock: you see
   * the rock face). A line through a grid corner is blocked if any of the four edges meeting there
   * blocks, or if either cell it squeezes between is rock, unless the target is rock itself (you
   * see the corner of a rock face, not past it).
   */
  lineOfSight(fc: number, fr: number, tc: number, tr: number): boolean {
    if (fc === tc && fr === tr) return true;
    const c0 = Math.min(fc, tc);
    const r0 = Math.min(fr, tr);
    // The line never leaves this box, and only crosses edges inside it: open floor needs no walk.
    if (this.clear(c0, r0, Math.max(fc, tc), Math.max(fr, tr))) return true;
    const { cols, vEdge, hEdge, opaque } = this;
    const W = cols + 1;
    const sx = Math.sign(tc - fc);
    const sy = Math.sign(tr - fr);
    const nx = Math.abs(tc - fc);
    const ny = Math.abs(tr - fr);
    const vOff = sx > 0 ? 1 : 0;
    const hOff = sy > 0 ? 1 : 0;
    let c = fc;
    let r = fr;
    let ix = 0;
    let iy = 0;
    while (ix < nx || iy < ny) {
      const cmp = ix >= nx ? 1 : iy >= ny ? -1 : (2 * ix + 1) * ny - (2 * iy + 1) * nx;
      if (cmp < 0) {
        if (vEdge[r * W + c + vOff]) return false;
        c += sx;
        ix++;
      } else if (cmp > 0) {
        if (hEdge[(r + hOff) * cols + c]) return false;
        r += sy;
        iy++;
      } else {
        const vc = c + vOff;
        const hr = r + hOff;
        if (vEdge[r * W + vc] || vEdge[(r + sy) * W + vc] || hEdge[hr * cols + c] || hEdge[hr * cols + c + sx]) return false;
        const last = ix + 1 >= nx && iy + 1 >= ny;
        if ((!last || !opaque[(r + sy) * cols + c + sx]) && (opaque[r * cols + c + sx] || opaque[(r + sy) * cols + c])) return false;
        c += sx;
        r += sy;
        ix++;
        iy++;
      }
      if ((ix < nx || iy < ny) && opaque[r * cols + c]) return false;
    }
    return true;
  }
}

/** Grid distance in cells from a footprint to a cell (0 inside it), and the footprint cell nearest it. */
function nearest(f: Footprint, col: number, row: number): { dist: number; col: number; row: number } {
  const c = Math.max(f.col, Math.min(col, f.col + f.size - 1));
  const r = Math.max(f.row, Math.min(row, f.row + f.size - 1));
  return { dist: Math.max(Math.abs(col - c), Math.abs(row - r)), col: c, row: r };
}

/** Whole cells covered by a range in feet (a 5 ft range reaches the adjacent squares). */
function cellsIn(feet: number, feetPerCell: number): number {
  return Math.floor(feet / feetPerCell + 1e-9);
}

/**
 * Light level of every cell (DARK, DIM or BRIGHT, row-major): the scene's ambient light, raised by
 * every light source whose light reaches the cell. Light spreads from the footprint cell nearest
 * the target and needs a clear line, like sight.
 */
export function illuminate(sight: SightMap, lighting: Lighting, lights: readonly Emitter[], feetPerCell: number): Uint8Array {
  const { cols, rows } = sight;
  const out = new Uint8Array(cols * rows).fill(lighting === 'bright' ? BRIGHT : lighting === 'dim' ? DIM : DARK);
  if (lighting === 'bright') return out;
  for (const light of lights) {
    const bright = cellsIn(light.bright, feetPerCell);
    const reach = cellsIn(light.bright + light.dim, feetPerCell);
    if (light.bright + light.dim <= 0) continue;
    const r0 = Math.max(0, light.row - reach);
    const r1 = Math.min(rows - 1, light.row + light.size - 1 + reach);
    const c0 = Math.max(0, light.col - reach);
    const c1 = Math.min(cols - 1, light.col + light.size - 1 + reach);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (out[i] === BRIGHT) continue;
        const n = nearest(light, c, r);
        const level = n.dist <= bright && light.bright > 0 ? BRIGHT : DIM;
        if (out[i]! >= level || !sight.lineOfSight(n.col, n.row, c, r)) continue;
        out[i] = level;
      }
    }
  }
  return out;
}

/**
 * How well one viewer sees every cell (row-major): 0 = not at all, DIM, or BRIGHT. A cell is seen
 * if it is in line of sight and lit, or close enough for darkvision (dim becomes bright, darkness
 * dim), blindsight or truesight. Sight is traced from the viewer's footprint cell nearest the target.
 */
export function viewField(sight: SightMap, light: Uint8Array, viewer: Viewer, feetPerCell: number): Uint8Array {
  const { cols, rows } = sight;
  const out = new Uint8Array(cols * rows);
  const dv = viewer.darkvision > 0 ? cellsIn(viewer.darkvision, feetPerCell) : -1;
  const bs = viewer.blindsight > 0 ? cellsIn(viewer.blindsight, feetPerCell) : -1;
  const ts = viewer.truesight > 0 ? cellsIn(viewer.truesight, feetPerCell) : -1;
  const range = Math.max(dv, bs, ts);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let level = light[i]!;
      const n = nearest(viewer, c, r);
      if (level === DARK && n.dist > range) continue;
      if (n.dist <= ts) level = BRIGHT;
      else if (n.dist <= dv) level = Math.min(BRIGHT, level + 1);
      if (level === DARK && n.dist <= bs) level = DIM;
      if (level === DARK || !sight.lineOfSight(n.col, n.row, c, r)) continue;
      out[i] = level;
    }
  }
  return out;
}

/** What a group of viewers sees together: `visible` cells, and those of them seen only in dim light. */
export interface Sight {
  visible: FogMask;
  dim: FogMask;
}

/** Merges view fields: each cell is seen as well as the best viewer sees it. */
export function mergeFields(cols: number, rows: number, fields: readonly Uint8Array[]): Sight {
  const visible = new FogMask(cols, rows);
  const dim = new FogMask(cols, rows);
  const n = cols * rows;
  for (let i = 0; i < n; i++) {
    let best = 0;
    for (const f of fields) if (f[i]! > best) best = f[i]!;
    if (best) visible.setIndex(i, true);
    if (best === DIM) dim.setIndex(i, true);
  }
  return { visible, dim };
}

export interface VisionInput {
  map: MapData;
  feetPerCell: number;
  lighting: Lighting;
  lights: readonly Emitter[];
  viewers: readonly Viewer[];
}

/** Everything the viewers see together, in one call (servers cache the steps separately). */
export function computeSight({ map, feetPerCell, lighting, lights, viewers }: VisionInput): Sight {
  const sight = new SightMap(map);
  const light = illuminate(sight, lighting, lights, feetPerCell);
  return mergeFields(map.cols, map.rows, viewers.map((v) => viewField(sight, light, v, feetPerCell)));
}
