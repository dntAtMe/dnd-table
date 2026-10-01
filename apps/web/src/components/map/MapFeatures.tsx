import { TERRAINS, terrainInfo, type DoorState, type GridGeometry, type MapData } from '@dnd/rules';
import { useMemo } from 'react';
import { edgeKey, terrainPaths, wallPath } from './wallPath';

interface Props {
  map: MapData;
  geo: GridGeometry;
  size: number;
  /** Prefix for pattern ids, so several maps on a page don't clash. */
  id: string;
}

/** SVG patterns for terrain; render inside the map's <defs>. */
export function TerrainPatterns({ id, size }: { id: string; size: number }) {
  const s = size / 4;
  return (
    <>
      <pattern id={`${id}-difficult`} width={s} height={s} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width={s} height={s} className="terrain__difficult-bg" />
        <line x1={s / 2} y1={0} x2={s / 2} y2={s} className="terrain__hatch" strokeWidth={s * 0.28} />
      </pattern>
      <pattern id={`${id}-rock`} width={s * 2} height={s * 2} patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
        <rect width={s * 2} height={s * 2} className="terrain__rock-bg" />
        <line x1={0} y1={s} x2={s * 2} y2={s} className="terrain__rock-line" strokeWidth={s * 0.12} />
      </pattern>
      <pattern id={`${id}-water`} width={s * 3} height={s * 1.5} patternUnits="userSpaceOnUse">
        <rect width={s * 3} height={s * 1.5} className="terrain__water-bg" />
        <path d={`M0 ${s * 0.75}q${s * 0.75} ${-s * 0.5} ${s * 1.5} 0t${s * 1.5} 0`} className="terrain__water-line" strokeWidth={s * 0.1} />
      </pattern>
    </>
  );
}

const PATTERNED = new Set(['difficult', 'rock', 'water']);

/** Terrain fills, below the grid lines. */
export function TerrainLayer({ map, geo, size, id }: Props) {
  const paths = useMemo(() => terrainPaths(map, geo, size), [map, geo, size]);
  return (
    <g className="terrain" pointerEvents="none">
      {[...paths].map(([code, d]) => {
        const t = terrainInfo(code).id;
        return <path key={code} d={d} className={`terrain--${t}`} fill={PATTERNED.has(t) ? `url(#${id}-${t})` : undefined} />;
      })}
    </g>
  );
}

function DoorGlyph({ state, secret, length }: { state: DoorState; secret: boolean; length: number }) {
  const L = length;
  const t = L * 0.16;
  return (
    <>
      <path d={`M0 0H${L * 0.2}M${L * 0.8} 0H${L}`} className="door__jamb" strokeWidth={L * 0.12} />
      {state === 'open' ? (
        <>
          <path d={`M${L * 0.8} 0A${L * 0.6} ${L * 0.6} 0 0 1 ${L * 0.2} ${L * 0.6}`} className="door__swing" strokeWidth={L * 0.025} />
          <rect x={L * 0.2 - t / 4} y={0} width={t / 2} height={L * 0.6} className="door__leaf" />
        </>
      ) : (
        <rect x={L * 0.2} y={-t / 2} width={L * 0.6} height={t} className="door__leaf" />
      )}
      {state === 'locked' && <circle cx={L / 2} cy={0} r={t * 0.32} className="door__lock" />}
      {secret && <rect x={L * 0.12} y={-L * 0.2} width={L * 0.76} height={L * 0.4} rx={L * 0.06} className="door__secret" strokeWidth={L * 0.03} />}
      <rect x={0} y={-L * 0.25} width={L} height={L * 0.5} className="door__hit" />
    </>
  );
}

/** Walls and doors, drawn above the grid. Doors carry data-door so the map can tell clicks on them. */
export function WallLayer({ map, geo, size }: Omit<Props, 'id'>) {
  const walls = useMemo(() => wallPath(map, geo, size), [map, geo, size]);
  const doors = useMemo(() => {
    const out: { key: string; x: number; y: number; vertical: boolean; state: DoorState; secret: boolean }[] = [];
    for (const { edge } of map.edges()) {
      const f = map.feature(edge);
      if (f?.kind !== 'door') continue;
      out.push({
        key: edgeKey(edge),
        x: geo.originX + edge.col * size,
        y: geo.originY + edge.row * size,
        vertical: edge.side === 'left',
        state: f.state,
        secret: f.secret,
      });
    }
    return out;
  }, [map, geo, size]);
  return (
    <g className="walls">
      <path d={walls} className="walls__outline" strokeWidth={size * 0.2} pointerEvents="none" />
      <path d={walls} className="walls__core" strokeWidth={size * 0.12} pointerEvents="none" />
      {doors.map((d) => (
        <g
          key={d.key}
          data-door={d.key}
          className={`door door--${d.state}${d.secret ? ' door--secret' : ''}`}
          transform={`translate(${d.x} ${d.y})${d.vertical ? ' rotate(90)' : ''}`}
        >
          <DoorGlyph state={d.state} secret={d.secret} length={size} />
        </g>
      ))}
    </g>
  );
}

/** Swatch colours for the terrain picker, matching the map fills. */
export const TERRAIN_SWATCH: Record<(typeof TERRAINS)[number]['id'], string> = {
  none: 'transparent',
  floor: '#6b5c4c',
  rock: '#181412',
  difficult: '#b98a3e',
  water: '#2f6f96',
};
