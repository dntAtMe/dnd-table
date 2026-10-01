import { edgeCode, type Edge, type GridGeometry, type MapData } from '@dnd/rules';

const WALL = edgeCode({ kind: 'wall' });

/** A grid line crossing, in cell units: (0, 0) is the top-left corner of cell (0, 0). */
export interface Vertex {
  x: number;
  y: number;
}

export function edgeKey(e: Edge): string {
  return `${e.side === 'top' ? 't' : 'l'}${e.col},${e.row}`;
}

export function parseEdgeKey(key: string): Edge | null {
  const m = /^([tl])(\d+),(\d+)$/.exec(key);
  return m ? { side: m[1] === 't' ? 'top' : 'left', col: Number(m[2]), row: Number(m[3]) } : null;
}

/** The edge closest to a map-pixel point (it may lie off the grid; check with MapData.edgeIndex). */
export function nearestEdge(geo: GridGeometry, size: number, x: number, y: number): Edge {
  const u = (x - geo.originX) / size;
  const v = (y - geo.originY) / size;
  return Math.abs(v - Math.round(v)) <= Math.abs(u - Math.round(u))
    ? { side: 'top', col: Math.floor(u), row: Math.round(v) }
    : { side: 'left', col: Math.round(u), row: Math.floor(v) };
}

/** The grid corner closest to a map-pixel point, and how far away it is in cells. */
export function nearestVertex(geo: GridGeometry, size: number, x: number, y: number): Vertex & { dist: number } {
  const u = (x - geo.originX) / size;
  const v = (y - geo.originY) / size;
  const vx = Math.round(u);
  const vy = Math.round(v);
  return { x: vx, y: vy, dist: Math.hypot(u - vx, v - vy) };
}

/** Edges along the grid lines from one corner to another: across first, then down. */
export function edgesBetween(a: Vertex, b: Vertex): Edge[] {
  const out: Edge[] = [];
  const sx = Math.sign(b.x - a.x);
  for (let x = a.x; x !== b.x; x += sx) out.push({ side: 'top', col: Math.min(x, x + sx), row: a.y });
  const sy = Math.sign(b.y - a.y);
  for (let y = a.y; y !== b.y; y += sy) out.push({ side: 'left', col: b.x, row: Math.min(y, y + sy) });
  return out;
}

/** One SVG path for every wall, with neighbouring walls on a line merged into one stroke. */
export function wallPath(map: MapData, geo: GridGeometry, size: number): string {
  const parts: string[] = [];
  for (let r = 0; r <= map.rows; r++) {
    for (let c = 0; c < map.cols; ) {
      if (map.top[r * map.cols + c] !== WALL) {
        c++;
        continue;
      }
      const start = c;
      while (c < map.cols && map.top[r * map.cols + c] === WALL) c++;
      parts.push(`M${geo.originX + start * size} ${geo.originY + r * size}H${geo.originX + c * size}`);
    }
  }
  const w = map.cols + 1;
  for (let c = 0; c <= map.cols; c++) {
    for (let r = 0; r < map.rows; ) {
      if (map.left[r * w + c] !== WALL) {
        r++;
        continue;
      }
      const start = r;
      while (r < map.rows && map.left[r * w + c] === WALL) r++;
      parts.push(`M${geo.originX + c * size} ${geo.originY + start * size}V${geo.originY + r * size}`);
    }
  }
  return parts.join('');
}

/** One SVG path per terrain code (clear cells omitted), merged into horizontal runs. */
export function terrainPaths(map: MapData, geo: GridGeometry, size: number): Map<number, string> {
  const parts = new Map<number, string[]>();
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; ) {
      const code = map.terrain[r * map.cols + c]!;
      const start = c;
      while (c < map.cols && map.terrain[r * map.cols + c] === code) c++;
      if (code === 0) continue;
      let list = parts.get(code);
      if (!list) parts.set(code, (list = []));
      // Tiny overlap hides hairline seams between rows at fractional zoom levels.
      list.push(`M${geo.originX + start * size} ${geo.originY + r * size}h${(c - start) * size}v${size + 0.5}h${-(c - start) * size}z`);
    }
  }
  return new Map([...parts].map(([code, list]) => [code, list.join('')]));
}
