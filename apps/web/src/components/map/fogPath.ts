import type { FogMask, GridGeometry } from '@dnd/rules';

/** SVG path covering every fogged cell, merged into horizontal runs to keep it small. */
export function fogPath(fog: FogMask, geo: GridGeometry, size: number): string {
  const parts: string[] = [];
  for (let r = 0; r < fog.rows; r++) {
    let c = 0;
    while (c < fog.cols) {
      if (fog.isRevealed(c, r)) {
        c++;
        continue;
      }
      const start = c;
      while (c < fog.cols && !fog.isRevealed(c, r)) c++;
      const x = geo.originX + start * size;
      const y = geo.originY + r * size;
      const w = (c - start) * size;
      // Tiny overlap hides hairline seams between rows at fractional zoom levels.
      parts.push(`M${x} ${y}h${w}v${size + 0.5}h${-w}z`);
    }
  }
  return parts.join('');
}
