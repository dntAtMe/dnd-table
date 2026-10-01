import type { SceneView, Token } from '@dnd/protocol';
import { BRIGHT, DIM, FogMask, SightMap, illuminate, mergeFields, viewField, type GridGeometry, type MapData } from '@dnd/rules';
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
  /** GM only: show what this player's tokens see, as the server would. */
  preview?: VisionPreview | null;
}

export interface VisionPreview {
  userId: string;
  /** Darkvision a token gets from its character sheet. */
  darkvision: (token: Token) => number;
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
export function VisionLayer({ scene, map, geo, size, isGm, k, clipPath, preview }: Props) {
  const { vision, visible, dim } = scene;
  const fpc = scene.grid.feetPerCell;

  const lights = useMemo(() => (isGm ? scene.tokens.filter((t) => t.light && t.light.bright + t.light.dim > 0) : []), [isGm, scene.tokens]);
  /** GM: light levels worked out here with the same rules the server uses. */
  const gmLight = useMemo(() => {
    if (!isGm || !vision.enabled) return null;
    const sight = new SightMap(map);
    const emitters = lights.map((t) => ({ col: t.col, row: t.row, size: t.size, bright: t.light!.bright, dim: t.light!.dim }));
    return { sight, level: illuminate(sight, vision.lighting, emitters, fpc) };
  }, [isGm, vision.enabled, vision.lighting, map, lights, fpc]);

  const playerPaths = useMemo(() => {
    const bit = (m: FogMask, i: number) => (m.bits[i >> 3]! & (1 << (i & 7))) !== 0;
    const paths = (seen: FogMask, dimMask: FogMask) => ({
      unseen: cellsPath(geo, size, (i) => !bit(seen, i)),
      dim: cellsPath(geo, size, (i) => bit(dimMask, i)),
    });
    if (gmLight && preview) {
      const eyes = scene.tokens.filter((t) => t.ownerUserId === preview.userId);
      const fields = eyes.map((t) =>
        viewField(
          gmLight.sight,
          gmLight.level,
          {
            col: t.col,
            row: t.row,
            size: t.size,
            darkvision: t.senses?.darkvision ?? preview.darkvision(t),
            blindsight: t.senses?.blindsight ?? 0,
            truesight: t.senses?.truesight ?? 0,
          },
          fpc,
        ),
      );
      const merged = mergeFields(geo.cols, geo.rows, fields);
      return paths(merged.visible, merged.dim);
    }
    if (isGm || !vision.enabled || visible === undefined) return null;
    return paths(FogMask.decode(visible, geo.cols, geo.rows), FogMask.decode(dim ?? '', geo.cols, geo.rows));
  }, [isGm, vision.enabled, visible, dim, geo, size, gmLight, preview, scene.tokens, fpc]);

  const gmPaths = useMemo(() => {
    if (!gmLight || preview || vision.lighting === 'bright') return null;
    const { level } = gmLight;
    return {
      dark: cellsPath(geo, size, (i) => level[i]! < DIM),
      dim: cellsPath(geo, size, (i) => level[i] === DIM),
    };
  }, [gmLight, preview, vision.lighting, geo, size]);

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
