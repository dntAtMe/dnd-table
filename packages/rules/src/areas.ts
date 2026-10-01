// Areas of effect (2024 rules) and the grid squares they cover.
//
// Positions are in grid units: (0, 0) is the top-left corner of cell (0, 0), (1, 0) the corner to
// its right, so whole numbers are grid intersections. Angles are degrees clockwise from east, as on
// screen (y grows downwards). Sizes are in feet and converted with the grid's feet per cell.
//
// Which squares an area covers ("Areas of Effect on a Grid"): a square is affected when the area
// covers at least half of it. Cones, Cubes and Lines are exact convex polygons; Spheres and
// Cylinders are circles, drawn as a 128-sided polygon with the circle's area (the error is far
// below anything that could tip a square). The covered fraction of each square is computed
// exactly by clipping the polygon to the square, so the result is deterministic and symmetric.
//
// Emanations are measured like movement instead: every square within the emanation's distance of
// the creature's space, counting squares the 2024 way (diagonals cost one square), which makes a
// square ring around the space. The creature's own space is not part of the area.

import type { CellPos } from './movement';

export const AREA_SHAPES = ['cone', 'cube', 'cylinder', 'emanation', 'line', 'sphere'] as const;
export type AreaShape = (typeof AREA_SHAPES)[number];

export const AREA_SHAPE_LABELS: Record<AreaShape, string> = {
  cone: 'Cone',
  cube: 'Cube',
  cylinder: 'Cylinder',
  emanation: 'Emanation',
  line: 'Line',
  sphere: 'Sphere',
};

/** What the size of each shape measures. */
export const AREA_SIZE_LABELS: Record<AreaShape, string> = {
  cone: 'length',
  cube: 'side',
  cylinder: 'radius',
  emanation: 'distance',
  line: 'length',
  sphere: 'radius',
};

export const DEFAULT_LINE_WIDTH = 5;

/** Less than this much of a square counts as "less than half" (guards float noise at exact halves). */
const EPS = 1e-9;
const CIRCLE_SIDES = 128;

export interface Point {
  x: number;
  y: number;
}

export interface Area {
  shape: AreaShape;
  /** Feet: radius (Sphere, Cylinder), distance (Emanation), length (Cone, Line) or side (Cube). */
  size: number;
  /** Line width in feet (default 5). */
  width?: number;
  /**
   * Point of origin in grid units: the centre of a Sphere or Cylinder, the tip of a Cone, the
   * middle of a Line's starting edge, a corner of a Cube. For an Emanation, the top-left corner of
   * the space it extends from.
   */
  x: number;
  y: number;
  /** Direction in degrees for Cones and Lines; a Cube's diagonal from its origin corner points this way. */
  angle: number;
  /** Emanation only: side of the creature's space in cells (default 1). */
  span?: number;
}

/** Something with a square footprint on the grid: a token. */
export interface Footprint {
  col: number;
  row: number;
  /** Side in cells. */
  size: number;
}

export function normalizeAngle(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a === 0 ? 0 : a; // folds -0 into 0
}

/** Rounds an angle to the nearest multiple of `step` degrees. */
export function snapAngle(deg: number, step = 45): number {
  return normalizeAngle(Math.round(deg / step) * step);
}

/** Unit vector for an angle, exact at multiples of 90°. */
function dir(deg: number): Point {
  const r = (normalizeAngle(deg) * Math.PI) / 180;
  const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return { x: clean(Math.cos(r)), y: clean(Math.sin(r)) };
}

/** Where a shape's point of origin may sit. */
export function originKind(shape: AreaShape): 'intersection' | 'edge' | 'space' {
  if (shape === 'emanation') return 'space';
  return shape === 'cone' || shape === 'line' ? 'edge' : 'intersection';
}

/**
 * Snaps a point (grid units) to a legal origin: Spheres, Cylinders and Cubes to the nearest grid
 * intersection; Cones and Lines also to the middle of a cell edge (so a 5-foot Line can run
 * straight down a row); an Emanation without a creature to the top-left of the cell it is in.
 */
export function snapOrigin(shape: AreaShape, x: number, y: number): Point {
  const kind = originKind(shape);
  if (kind === 'space') return { x: Math.floor(x), y: Math.floor(y) };
  const corner = { x: Math.round(x), y: Math.round(y) };
  if (kind === 'intersection') return corner;
  const candidates = [corner, { x: Math.round(x), y: Math.floor(y) + 0.5 }, { x: Math.floor(x) + 0.5, y: Math.round(y) }];
  let best = corner;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestD - EPS) [best, bestD] = [c, d];
  }
  return best;
}

/**
 * The area's outline as a convex polygon in grid units (clockwise on screen). Emanations give the
 * outer edge of their ring of squares.
 */
export function areaPolygon(area: Area, feetPerCell: number): Point[] {
  const len = area.size / feetPerCell;
  const o = { x: area.x, y: area.y };
  const at = (p: Point, v: Point, k: number): Point => ({ x: p.x + v.x * k, y: p.y + v.y * k });
  switch (area.shape) {
    case 'cone': {
      // A Cone's width at any point equals that point's distance from the origin.
      const d = dir(area.angle);
      const n = dir(area.angle + 90);
      const end = at(o, d, len);
      return [o, at(end, n, -len / 2), at(end, n, len / 2)];
    }
    case 'line': {
      const half = (area.width ?? DEFAULT_LINE_WIDTH) / feetPerCell / 2;
      const d = dir(area.angle);
      const n = dir(area.angle + 90);
      const end = at(o, d, len);
      return [at(o, n, -half), at(end, n, -half), at(end, n, half), at(o, n, half)];
    }
    case 'cube': {
      const u = dir(area.angle - 45);
      const v = dir(area.angle + 45);
      return [o, at(o, u, len), at(at(o, u, len), v, len), at(o, v, len)];
    }
    case 'sphere':
    case 'cylinder': {
      // Same area as the circle, so coverage is as close to the true circle as possible.
      const step = (2 * Math.PI) / CIRCLE_SIDES;
      const r = len * Math.sqrt(step / Math.sin(step));
      const pts: Point[] = [];
      for (let i = 0; i < CIRCLE_SIDES; i++) {
        const t = (i + 0.5) * step;
        pts.push({ x: o.x + r * Math.cos(t), y: o.y + r * Math.sin(t) });
      }
      return pts;
    }
    case 'emanation': {
      const reach = emanationReach(area, feetPerCell);
      const span = area.span ?? 1;
      const x0 = area.x - reach;
      const y0 = area.y - reach;
      const x1 = area.x + span + reach;
      const y1 = area.y + span + reach;
      return [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
    }
  }
}

/** Whole squares an emanation reaches past the creature's space. */
function emanationReach(area: Area, feetPerCell: number): number {
  return Math.floor(area.size / feetPerCell + EPS);
}

function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Keeps the part of a polygon where `inside` holds, splitting edges at `cross` (Sutherland–Hodgman). */
function clip(pts: Point[], inside: (p: Point) => boolean, cross: (a: Point, b: Point) => Point): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const ain = inside(a);
    const bin = inside(b);
    if (ain) out.push(a);
    if (ain !== bin) out.push(cross(a, b));
  }
  return out;
}

const atX = (a: Point, b: Point, x: number): Point => ({ x, y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) });
const atY = (a: Point, b: Point, y: number): Point => ({ x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y), y });

/** Area of a convex polygon inside the unit square of cell (col, row). */
export function coveredFraction(poly: Point[], col: number, row: number): number {
  let p = poly;
  p = clip(p, (q) => q.x >= col, (a, b) => atX(a, b, col));
  if (p.length < 3) return 0;
  p = clip(p, (q) => q.x <= col + 1, (a, b) => atX(a, b, col + 1));
  if (p.length < 3) return 0;
  p = clip(p, (q) => q.y >= row, (a, b) => atY(a, b, row));
  if (p.length < 3) return 0;
  p = clip(p, (q) => q.y <= row + 1, (a, b) => atY(a, b, row + 1));
  return p.length < 3 ? 0 : polygonArea(p);
}

/**
 * Cells covered by an area, row by row, limited to a cols × rows grid (pass Infinity for no limit).
 * See the top of this file for the coverage rule.
 */
export function areaCells(area: Area, feetPerCell: number, cols = Infinity, rows = Infinity): CellPos[] {
  const out: CellPos[] = [];
  if (!(area.size > 0) || !(feetPerCell > 0)) return out;
  const inGrid = (col: number, row: number) => col >= 0 && row >= 0 && col < cols && row < rows;
  if (area.shape === 'emanation') {
    const reach = emanationReach(area, feetPerCell);
    const span = Math.max(1, Math.round(area.span ?? 1));
    const x = Math.round(area.x);
    const y = Math.round(area.y);
    for (let row = y - reach; row < y + span + reach; row++) {
      for (let col = x - reach; col < x + span + reach; col++) {
        const own = col >= x && col < x + span && row >= y && row < y + span;
        if (!own && inGrid(col, row)) out.push({ col, row });
      }
    }
    return out;
  }
  const poly = areaPolygon(area, feetPerCell);
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const c0 = Math.max(Math.floor(Math.min(...xs)), 0);
  const c1 = Math.min(Math.ceil(Math.max(...xs)), cols);
  const r0 = Math.max(Math.floor(Math.min(...ys)), 0);
  const r1 = Math.min(Math.ceil(Math.max(...ys)), rows);
  for (let row = r0; row < r1; row++) {
    for (let col = c0; col < c1; col++) {
      if (coveredFraction(poly, col, row) >= 0.5 - EPS) out.push({ col, row });
    }
  }
  return out;
}

/**
 * Tokens caught in an area: any token with at least one of its squares covered. `originId` is the
 * creature an Emanation extends from, which isn't caught by its own emanation.
 */
export function tokensInArea<T extends Footprint & { id: string }>(cells: CellPos[], tokens: T[], originId?: string | null): T[] {
  if (cells.length === 0) return [];
  const covered = new Set(cells.map((c) => `${c.col},${c.row}`));
  return tokens.filter((t) => {
    if (originId && t.id === originId) return false;
    for (let r = t.row; r < t.row + t.size; r++) {
      for (let c = t.col; c < t.col + t.size; c++) if (covered.has(`${c},${r}`)) return true;
    }
    return false;
  });
}

/** An area's shape and size as a spell describes it. */
export interface SpellArea {
  shape: AreaShape;
  size: number;
  /** Line width in feet. */
  width?: number;
  /** Cylinder height in feet. */
  height?: number;
}

const FT = String.raw`(\d+)[- ]?(?:foot|feet)`;
const AREA_PATTERNS: [RegExp, (m: RegExpMatchArray) => SpellArea][] = [
  [new RegExp(`${FT}-radius, ${FT}[- ]?(?:high|tall) Cylinder`, 'i'), (m) => ({ shape: 'cylinder', size: +m[1]!, height: +m[2]! })],
  [new RegExp(`${FT}[- ](?:high|tall), ${FT}-radius Cylinder`, 'i'), (m) => ({ shape: 'cylinder', size: +m[2]!, height: +m[1]! })],
  [new RegExp(`Cylinder that is ${FT} (?:high|tall) with a ${FT} radius`, 'i'), (m) => ({ shape: 'cylinder', size: +m[2]!, height: +m[1]! })],
  [new RegExp(`${FT}-radius Sphere`, 'i'), (m) => ({ shape: 'sphere', size: +m[1]! })],
  [new RegExp(`${FT}-long, ${FT}-wide Line`, 'i'), (m) => ({ shape: 'line', size: +m[1]!, width: +m[2]! })],
  [new RegExp(`${FT}-wide, ${FT}-long Line`, 'i'), (m) => ({ shape: 'line', size: +m[2]!, width: +m[1]! })],
  [new RegExp(`Line [^.]*?${FT} long and ${FT} wide`, 'i'), (m) => ({ shape: 'line', size: +m[1]!, width: +m[2]! })],
  [new RegExp(`${FT} Cone`, 'i'), (m) => ({ shape: 'cone', size: +m[1]! })],
  [new RegExp(`${FT} Emanation`, 'i'), (m) => ({ shape: 'emanation', size: +m[1]! })],
  [new RegExp(`(?<!no larger than |fit in |within |contained within )an? ${FT} Cube`, 'i'), (m) => ({ shape: 'cube', size: +m[1]! })],
];

/**
 * Reads a spell's area of effect from its rules text ("a 20-foot-radius Sphere", "a 15-foot
 * Cone", "a 100-foot-long, 5-foot-wide Line"). Takes the earliest phrase in the text; returns
 * null when there isn't one (size limits like "no larger than a 10-foot Cube" don't count).
 */
export function parseSpellArea(text: string): SpellArea | null {
  let best: { index: number; area: SpellArea } | null = null;
  for (const [re, build] of AREA_PATTERNS) {
    const m = text.match(re);
    if (m && m.index !== undefined && (!best || m.index < best.index)) best = { index: m.index, area: build(m) };
  }
  return best?.area ?? null;
}
