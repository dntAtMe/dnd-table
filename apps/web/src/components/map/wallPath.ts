import { edgeCode, type Edge, type GridGeometry, type MapData } from '@dnd/rules';

const WALL = edgeCode({ kind: 'wall' });

export function edgeKey(e: Edge): string {
  return `${e.side === 'top' ? 't' : 'l'}${e.col},${e.row}`;
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
