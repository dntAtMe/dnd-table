import type { CameraRect, SceneView, Token } from '@dnd/protocol';
import { FogMask, gridGeometry } from '@dnd/rules';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useElementSize } from '../../lib/useElementSize';
import { fitRect, visibleRect, zoomAt, type Camera } from './camera';
import { fogPath } from './fogPath';

export interface MapViewProps {
  scene: SceneView;
  /** GMs see through fog (dimmed) and see hidden tokens. */
  isGm: boolean;
  /** Table screens are driven by the GM's camera instead of by input. */
  interactive?: boolean;
  /** External framing (table screens). Null/undefined fits the whole map. */
  camera?: CameraRect | null;
  /** Called with the visible map area whenever the view moves. */
  onViewChange?: (rect: CameraRect) => void;
}

type Gesture =
  | { kind: 'pan'; pointerId: number; sx: number; sy: number; cam: Camera }
  | { kind: 'pinch'; dist: number; cx: number; cy: number; cam: Camera };

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
}

function TokenShape({ token, cell, originX, originY }: { token: Token; cell: number; originX: number; originY: number }) {
  const d = token.size * cell;
  const r = d / 2 - Math.max(2, cell * 0.06);
  return (
    <g
      className={`token${token.hidden ? ' token--hidden' : ''}`}
      transform={`translate(${originX + token.col * cell} ${originY + token.row * cell})`}
      data-token-id={token.id}
    >
      <circle cx={d / 2} cy={d / 2} r={r} fill={token.color} className="token__disc" />
      <text x={d / 2} y={d / 2} className="token__initials" fontSize={r * 0.8}>
        {initials(token.name)}
      </text>
      <text x={d / 2} y={d + cell * 0.08} className="token__name" fontSize={Math.max(10, cell * 0.22)}>
        {token.name}
      </text>
    </g>
  );
}

export function MapView({ scene, isGm, interactive = true, camera, onViewChange }: MapViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const size = useElementSize(wrapRef);
  const [cam, setCam] = useState<Camera | null>(null);
  const camRef = useRef<Camera | null>(null);
  camRef.current = cam;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const fittedScene = useRef<string | null>(null);

  const { grid } = scene;
  const geo = useMemo(() => gridGeometry(grid, scene.width, scene.height), [grid, scene.width, scene.height]);
  const fog = useMemo(
    () => (scene.fogEnabled ? (scene.fog ? FogMask.decode(scene.fog, geo.cols, geo.rows) : new FogMask(geo.cols, geo.rows)) : null),
    [scene.fogEnabled, scene.fog, geo.cols, geo.rows],
  );
  const fogD = useMemo(() => (fog ? fogPath(fog, geo, grid.size) : ''), [fog, geo, grid.size]);

  const fullMap: CameraRect = { x: 0, y: 0, w: scene.width, h: scene.height };
  const minZoom = size ? Math.min(size.width / scene.width, size.height / scene.height) * 0.5 : 0.05;

  // Interactive views fit the map when a new scene opens; table screens follow the GM's framing.
  useEffect(() => {
    if (!size) return;
    if (!interactive) {
      setCam(fitRect(camera ?? fullMap, size.width, size.height, camera ? 0 : 24));
    } else if (fittedScene.current !== scene.id || !camRef.current) {
      fittedScene.current = scene.id;
      setCam(fitRect(fullMap, size.width, size.height, 24));
    }
  }, [size, scene.id, scene.width, scene.height, interactive, camera]);

  useEffect(() => {
    if (cam && size && onViewChange) onViewChange(visibleRect(cam, size.width, size.height));
  }, [cam, size, onViewChange]);

  // Wheel / trackpad zoom. Needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = camRef.current;
      if (!c) return;
      const rect = svg.getBoundingClientRect();
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setCam(zoomAt(c, factor, e.clientX - rect.left, e.clientY - rect.top, minZoom));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [interactive, minZoom]);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b || !camRef.current) return;
    gesture.current = {
      kind: 'pinch',
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      cam: camRef.current,
    };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive || !camRef.current) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) return startPinch();
    if (pointers.current.size > 2) return;
    gesture.current = { kind: 'pan', pointerId: e.pointerId, sx: p.x, sy: p.y, cam: camRef.current };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan' && g.pointerId === e.pointerId) {
      setCam({ ...g.cam, x: g.cam.x + p.x - g.sx, y: g.cam.y + p.y - g.sy });
    } else if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const cx = (a!.x + b!.x) / 2;
      const cy = (a!.y + b!.y) / 2;
      const zoomed = zoomAt(g.cam, dist / g.dist, g.cx, g.cy, minZoom);
      setCam({ ...zoomed, x: zoomed.x + cx - g.cx, y: zoomed.y + cy - g.cy });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // Lifting one finger of a pinch continues as a pan with the other.
      const [id, p] = [...pointers.current.entries()][0] ?? [];
      gesture.current = id !== undefined && p && camRef.current
        ? { kind: 'pan', pointerId: id, sx: p.x, sy: p.y, cam: camRef.current }
        : null;
      return;
    }
    if (pointers.current.size === 0) gesture.current = null;
  };

  const zoomBy = (factor: number) => {
    if (!cam || !size) return;
    setCam(zoomAt(cam, factor, size.width / 2, size.height / 2, minZoom));
  };

  const k = cam?.k ?? 1;
  const transform = cam ? `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` : undefined;

  return (
    <div className={`map${interactive ? '' : ' map--display'}${scene.imageUrl ? '' : ' map--blank'}`} ref={wrapRef}>
      <svg
        ref={svgRef}
        className="map__svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern
            id={`grid-${scene.id}`}
            x={geo.originX}
            y={geo.originY}
            width={grid.size}
            height={grid.size}
            patternUnits="userSpaceOnUse"
          >
            <path d={`M${grid.size} 0H0V${grid.size}`} className="map__grid-line" strokeWidth={Math.max(1 / k, grid.size / 60)} />
          </pattern>
        </defs>
        {cam && (
          <g className="map__world" style={{ transform, transformOrigin: '0 0' }}>
            {scene.imageUrl ? (
              <image href={scene.imageUrl} width={scene.width} height={scene.height} preserveAspectRatio="none" />
            ) : (
              <rect width={scene.width} height={scene.height} className="map__blank" />
            )}
            {grid.visible && <rect width={scene.width} height={scene.height} fill={`url(#grid-${scene.id})`} pointerEvents="none" />}
            {fog && <path d={fogD} className={`map__fog${isGm ? ' map__fog--gm' : ''}`} />}
            {scene.tokens.map((t) => (
              <TokenShape key={t.id} token={t} cell={grid.size} originX={geo.originX} originY={geo.originY} />
            ))}
            <rect width={scene.width} height={scene.height} className="map__frame" strokeWidth={2 / k} />
          </g>
        )}
      </svg>
      {interactive && (
        <div className="map__zoom">
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
            −
          </button>
          <button
            type="button"
            onClick={() => size && setCam(fitRect(fullMap, size.width, size.height, 24))}
            aria-label="Fit map"
            title="Fit map"
          >
            ⤢
          </button>
        </div>
      )}
    </div>
  );
}

