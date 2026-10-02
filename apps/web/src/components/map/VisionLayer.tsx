import type { SceneView, Token } from '@dnd/protocol';
import { BRIGHT, DIM, FogMask, SightMap, illuminate, mergeFields, viewField, type GridGeometry, type MapData } from '@dnd/rules';
import { useMemo } from 'react';

interface Props {
  scene: SceneView;
  geo: GridGeometry;
  size: number;
  isGm: boolean;
  /** Current zoom, for constant-width outlines. */
  k: number;
  clipPath: string;
  /** GM: light levels over the scene (see useGmLight). */
  gmLight: GmLight | null;
  /** GM: what the previewed player or token sees (see usePreviewSight). */
  previewSight?: PreviewSight | null;
}

/**
 * GM only: see the scene through someone else's eyes, as the server would show it. A player's
 * view uses all their tokens and hides what players can't see; a token's view is that one
 * creature's sight (any token, e.g. to check what a goblin can see).
 */
export type VisionPreview = { kind: 'player'; userId: string; darkvision: (token: Token) => number } | { kind: 'token'; tokenId: string; darkvision: (token: Token) => number };

export interface GmLight {
  sight: SightMap;
  level: Uint8Array;
}

export interface PreviewSight {
  visible: FogMask;
  dim: FogMask;
}

/** GM: light levels worked out with the same rules the server uses, from the map as drawn. */
export function useGmLight(scene: SceneView, map: MapData, isGm: boolean): GmLight | null {
  const { vision } = scene;
  const fpc = scene.grid.feetPerCell;
  const lights = useMemo(() => (isGm ? scene.tokens.filter((t) => t.light && t.light.bright + t.light.dim > 0) : []), [isGm, scene.tokens]);
  return useMemo(() => {
    if (!isGm || !vision.enabled) return null;
    const sight = new SightMap(map);
    const emitters = lights.map((t) => ({ col: t.col, row: t.row, size: t.size, bright: t.light!.bright, dim: t.light!.dim }));
    return { sight, level: illuminate(sight, vision.lighting, emitters, fpc) };
  }, [isGm, vision.enabled, vision.lighting, map, lights, fpc]);
}

/** The tokens a preview looks through. */
export function previewEyes(tokens: Token[], preview: VisionPreview): Token[] {
  return preview.kind === 'player' ? tokens.filter((t) => t.ownerUserId === preview.userId) : tokens.filter((t) => t.id === preview.tokenId);
}

/** What the previewed player's tokens (or the one token) see together. */
export function usePreviewSight(scene: SceneView, geo: GridGeometry, gmLight: GmLight | null, preview: VisionPreview | null | undefined): PreviewSight | null {
  const fpc = scene.grid.feetPerCell;
  return useMemo(() => {
    if (!gmLight || !preview) return null;
    const fields = previewEyes(scene.tokens, preview).map((t) =>
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
    return mergeFields(geo.cols, geo.rows, fields);
  }, [gmLight, preview, scene.tokens, geo.cols, geo.rows, fpc]);
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
export function VisionLayer({ scene, geo, size, isGm, k, clipPath, gmLight, previewSight }: Props) {
  const { vision, visible, dim } = scene;
  const fpc = scene.grid.feetPerCell;
  // Light reach outlines are a GM aid; a preview shows the scene as the player gets it.
  const lights = useMemo(
    () => (isGm && !previewSight ? scene.tokens.filter((t) => t.light && t.light.bright + t.light.dim > 0) : []),
    [isGm, previewSight, scene.tokens],
  );

  const playerPaths = useMemo(() => {
    const bit = (m: FogMask, i: number) => (m.bits[i >> 3]! & (1 << (i & 7))) !== 0;
    const paths = (seen: FogMask, dimMask: FogMask) => ({
      unseen: cellsPath(geo, size, (i) => !bit(seen, i)),
      dim: cellsPath(geo, size, (i) => bit(dimMask, i)),
    });
    if (previewSight) return paths(previewSight.visible, previewSight.dim);
    if (isGm || !vision.enabled || visible === undefined) return null;
    return paths(FogMask.decode(visible, geo.cols, geo.rows), FogMask.decode(dim ?? '', geo.cols, geo.rows));
  }, [isGm, vision.enabled, visible, dim, geo, size, previewSight]);

  const gmPaths = useMemo(() => {
    if (!gmLight || previewSight || vision.lighting === 'bright') return null;
    const { level } = gmLight;
    return {
      dark: cellsPath(geo, size, (i) => level[i]! < DIM),
      dim: cellsPath(geo, size, (i) => level[i] === DIM),
    };
  }, [gmLight, previewSight, vision.lighting, geo, size]);

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
