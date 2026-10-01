import type { SceneView } from '@dnd/protocol';
import { BRIGHT, DIM, FogMask, SightMap, illuminate, type GridGeometry, type MapData } from '@dnd/rules';
import { useMemo } from 'react';

interface Props {
  scene: SceneView;
  /** The map as drawn (with the GM's unsent edits), so lighting follows walls straight away. */
  map: MapData;
  geo: GridGeometry;
  size: number;
  isGm: boolean;
  /** Current zoom, for constant-width outlines. */
  k: number;
  clipPath: string;
}

/** SVG path covering every cell for which `test(index)` holds, merged into horizontal runs. */
function cellsPath(geo: GridGeometry, size: number, test: (i: number) => boolean): string {
  const parts: string[] = [];
  for (let r = 0; r < geo.rows; r++) {
    let c = 0;
    while (c < geo.cols) {
      if (!test(r * geo.cols + c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < geo.cols && test(r * geo.cols + c)) c++;
      const w = (c - start) * size;
      parts.push(`M${geo.originX + start * size} ${geo.originY + r * size}h${w}v${size + 0.5}h${-w}z`);
    }
  }
  return parts.join('');
}

/**
 * Lighting and vision over the map, below the tokens. Players and table screens get what their
 * tokens see from the server: cells out of sight are darkened (never-explored ones are already
 * black under the fog), cells seen only in dim light slightly. The GM sees everything, with the
 * light levels lightly shaded and each light's bright and dim reach outlined.
 */
export function VisionLayer({ scene, map, geo, size, isGm, k, clipPath }: Props) {
  const { vision, visible, dim } = scene;
  const fpc = scene.grid.feetPerCell;

  const playerPaths = useMemo(() => {
    if (isGm || !vision.enabled || visible === undefined) return null;
    const seen = FogMask.decode(visible, geo.cols, geo.rows);
    const dimMask = FogMask.decode(dim ?? '', geo.cols, geo.rows);
    const bit = (m: FogMask, i: number) => (m.bits[i >> 3]! & (1 << (i & 7))) !== 0;
    return {
      unseen: cellsPath(geo, size, (i) => !bit(seen, i)),
      dim: cellsPath(geo, size, (i) => bit(dimMask, i)),
    };
  }, [isGm, vision.enabled, visible, dim, geo, size]);

  const lights = useMemo(() => (isGm ? scene.tokens.filter((t) => t.light && t.light.bright + t.light.dim > 0) : []), [isGm, scene.tokens]);
  const gmPaths = useMemo(() => {
    if (!isGm || !vision.enabled || vision.lighting === 'bright') return null;
    const level = illuminate(
      new SightMap(map),
      vision.lighting,
      lights.map((t) => ({ col: t.col, row: t.row, size: t.size, bright: t.light!.bright, dim: t.light!.dim })),
      fpc,
    );
    return {
      dark: cellsPath(geo, size, (i) => level[i]! < DIM),
      dim: cellsPath(geo, size, (i) => level[i] === DIM),
    };
  }, [isGm, vision.enabled, vision.lighting, map, lights, fpc, geo, size]);

  if (!playerPaths && !gmPaths && lights.length === 0) return null;
  return (
    <g className="vision" pointerEvents="none" clipPath={clipPath}>
      {playerPaths && (
        <>
          <path d={playerPaths.dim} className="vision__dim" />
          <path d={playerPaths.unseen} className="vision__unseen" />
        </>
      )}
      {gmPaths && (
        <>
          <path d={gmPaths.dim} className="vision__dim vision__dim--gm" />
          <path d={gmPaths.dark} className="vision__dark--gm" />
        </>
      )}
      {lights.map((t) => {
        // Grid distance (as for the ruler): a light's reach is a square around the token.
        const reach = (feet: number) => Math.floor(feet / fpc + 1e-9);
        const ring = (cells: number, kind: typeof BRIGHT | typeof DIM) => (
          <rect
            key={kind}
            x={geo.originX + (t.col - cells) * size}
            y={geo.originY + (t.row - cells) * size}
            width={(t.size + 2 * cells) * size}
            height={(t.size + 2 * cells) * size}
            rx={size * 0.3}
            className={`vision__reach vision__reach--${kind === BRIGHT ? 'bright' : 'dim'}`}
            strokeWidth={1.5 / k}
            strokeDasharray={`${6 / k} ${5 / k}`}
          />
        );
        const bright = reach(t.light!.bright);
        const outer = reach(t.light!.bright + t.light!.dim);
        return (
          <g key={t.id}>
            {t.light!.bright > 0 && ring(bright, BRIGHT)}
            {outer > bright && ring(outer, DIM)}
          </g>
        );
      })}
    </g>
  );
}
