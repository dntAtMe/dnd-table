import type { CameraRect, SceneView, Token } from '@dnd/protocol';
import { FogMask, brushCells, gridDistanceFeet, gridGeometry, pointToCell } from '@dnd/rules';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useElementSize } from '../../lib/useElementSize';
import type { Ping } from '../../lib/useGameSocket';
import { fitRect, screenToMap, visibleRect, zoomAt, type Camera } from './camera';
import { fogPath } from './fogPath';

export type MapTool = 'move' | 'reveal' | 'hide' | 'ruler' | 'ping';

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
  userId?: string;
  selectedTokenId?: string | null;
  onSelectToken?: (id: string | null) => void;
  onMoveToken?: (id: string, col: number, row: number) => void;
  tool?: MapTool;
  /** Fog brush diameter in cells. */
  brush?: number;
  onPaintFog?: (cells: number[], reveal: boolean) => void;
  pings?: Ping[];
  onPing?: (x: number, y: number) => void;
  /** Overlay controls drawn above the map (toolbars). */
  children?: ReactNode;
}

/** Pointer travel (px) before a press on a token becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** How long to show a moved token at its new spot before trusting the server's copy again. */
const PENDING_MOVE_MS = 1500;
/** Fog strokes are sent in batches while painting so others see them appear. */
const FOG_FLUSH_MS = 150;

type Gesture =
  | { kind: 'pan'; pointerId: number; sx: number; sy: number; cam: Camera; moved: boolean }
  | {
      kind: 'token';
      pointerId: number;
      tokenId: string;
      movable: boolean;
      /** Grab point relative to the token's top-left, in map pixels. */
      dx: number;
      dy: number;
      sx: number;
      sy: number;
      moved: boolean;
    }
  | { kind: 'paint'; pointerId: number; last: { col: number; row: number }; unsent: Set<number>; sentAt: number }
  | { kind: 'ruler'; pointerId: number }
  | { kind: 'pinch'; dist: number; cx: number; cy: number; cam: Camera };

type CellPos = { col: number; row: number };

/** Text drawn at a constant on-screen size regardless of zoom. */
function MapLabel({ x, y, k, text, className = '' }: { x: number; y: number; k: number; text: string; className?: string }) {
  const w = text.length * 8 + 16;
  return (
    <g transform={`translate(${x} ${y}) scale(${1 / k})`} className={`map-label ${className}`} pointerEvents="none">
      <rect x={-w / 2} y={-30} width={w} height={22} rx={11} />
      <text x={0} y={-19}>
        {text}
      </text>
    </g>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
}

interface TokenShapeProps {
  token: Token;
  cell: number;
  x: number;
  y: number;
  selected?: boolean;
  mine?: boolean;
  movable?: boolean;
  dragging?: boolean;
}

function TokenShape({ token, cell, x, y, selected, mine, movable, dragging }: TokenShapeProps) {
  const d = token.size * cell;
  const r = d / 2 - Math.max(2, cell * 0.06);
  const classes = ['token'];
  if (token.hidden) classes.push('token--hidden');
  if (selected) classes.push('token--selected');
  if (mine) classes.push('token--mine');
  if (movable) classes.push('token--movable');
  if (dragging) classes.push('token--dragging');
  return (
    <g className={classes.join(' ')} transform={`translate(${x} ${y})`} data-token-id={token.id}>
      {(selected || mine) && <circle cx={d / 2} cy={d / 2} r={r + Math.max(3, cell * 0.07)} className="token__ring" />}
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

export function MapView({
  scene,
  isGm,
  interactive = true,
  camera,
  onViewChange,
  userId,
  selectedTokenId,
  onSelectToken,
  onMoveToken,
  tool = 'move',
  brush = 1,
  onPaintFog,
  pings = [],
  onPing,
  children,
}: MapViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const size = useElementSize(wrapRef);
  const [cam, setCam] = useState<Camera | null>(null);
  const camRef = useRef<Camera | null>(null);
  camRef.current = cam;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const fittedScene = useRef<string | null>(null);
  /** Token being dragged, at its unsnapped top-left in map pixels. */
  const [drag, setDrag] = useState<{ tokenId: string; x: number; y: number } | null>(null);
  /** Moves sent but not yet confirmed, so the token doesn't snap back while the server replies. */
  const [pending, setPending] = useState<Record<string, { col: number; row: number }>>({});

  useEffect(() => setPending({}), [scene.tokens]);
  const [ruler, setRuler] = useState<{ from: CellPos; to: CellPos } | null>(null);
  /** Cells painted in the current stroke, shown before the server echoes them back. */
  const [stroke, setStroke] = useState<{ reveal: boolean; cells: Set<number> } | null>(null);
  useEffect(() => {
    if (gesture.current?.kind !== 'paint') setStroke(null);
  }, [scene.fog]);
  useEffect(() => {
    if (Object.keys(pending).length === 0) return;
    const t = setTimeout(() => setPending({}), PENDING_MOVE_MS);
    return () => clearTimeout(t);
  }, [pending]);

  const { grid } = scene;
  const geo = useMemo(() => gridGeometry(grid, scene.width, scene.height), [grid, scene.width, scene.height]);
  const serverFog = useMemo(
    () => (scene.fogEnabled ? (scene.fog ? FogMask.decode(scene.fog, geo.cols, geo.rows) : new FogMask(geo.cols, geo.rows)) : null),
    [scene.fogEnabled, scene.fog, geo.cols, geo.rows],
  );
  const fog = useMemo(() => {
    if (!serverFog || !stroke) return serverFog;
    const copy = new FogMask(serverFog.cols, serverFog.rows, serverFog.bits.slice());
    for (const i of stroke.cells) copy.setIndex(i, stroke.reveal);
    return copy;
  }, [serverFog, stroke]);
  const fogD = useMemo(() => (fog ? fogPath(fog, geo, grid.size) : ''), [fog, geo, grid.size]);

  const fullMap: CameraRect = { x: 0, y: 0, w: scene.width, h: scene.height };
  const minZoom = size ? Math.min(size.width / scene.width, size.height / scene.height) * 0.5 : 0.05;

  // Interactive views fit the map when a new scene opens; table screens follow the GM's framing.
  useEffect(() => {
    if (!size) return;
    if (!interactive) {
      setCam(camera ? fitRect(camera, size.width, size.height, 0, 'area') : fitRect(fullMap, size.width, size.height, 24));
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

  const painting = isGm && (tool === 'reveal' || tool === 'hide') && Boolean(serverFog);

  /** Paints the brush along the line from the last cell to this one, so fast strokes leave no gaps. */
  const paintTo = (g: Extract<Gesture, { kind: 'paint' }>, to: { col: number; row: number }, first = false) => {
    const steps = first ? 0 : Math.max(Math.abs(to.col - g.last.col), Math.abs(to.row - g.last.row));
    const added: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 1 : i / steps;
      const col = Math.round(g.last.col + (to.col - g.last.col) * t);
      const row = Math.round(g.last.row + (to.row - g.last.row) * t);
      for (const idx of brushCells(geo.cols, geo.rows, col, row, brush)) {
        g.unsent.add(idx);
        added.push(idx);
      }
    }
    g.last = to;
    setStroke((prev) => {
      const cells = new Set(prev?.cells);
      for (const idx of added) cells.add(idx);
      return { reveal: tool === 'reveal', cells };
    });
  };

  const flushPaint = (g: Extract<Gesture, { kind: 'paint' }>) => {
    if (g.unsent.size === 0) return;
    onPaintFog?.([...g.unsent], tool === 'reveal');
    g.unsent = new Set();
    g.sentAt = Date.now();
  };

  const canMove = (t: Token) => isGm || (userId !== undefined && t.ownerUserId === userId);

  const cellOf = (x: number, y: number) => ({
    col: Math.round((x - geo.originX) / grid.size),
    row: Math.round((y - geo.originY) / grid.size),
  });

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive || !camRef.current) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      const g = gesture.current;
      if (g?.kind === 'paint') flushPaint(g);
      setDrag(null);
      return startPinch();
    }
    if (pointers.current.size > 2) return;

    if (painting && e.button === 0) {
      const m = screenToMap(camRef.current, p.x, p.y);
      const cell = pointToCell(geo, grid.size, m.x, m.y);
      const g: Gesture = { kind: 'paint', pointerId: e.pointerId, last: cell, unsent: new Set(), sentAt: Date.now() };
      gesture.current = g;
      setStroke(null);
      paintTo(g, cell, true);
      return;
    }

    if ((tool === 'ruler' || tool === 'ping') && e.button === 0) {
      const m = screenToMap(camRef.current, p.x, p.y);
      if (tool === 'ping') {
        onPing?.(m.x, m.y);
        gesture.current = null;
        return;
      }
      const cell = pointToCell(geo, grid.size, m.x, m.y);
      setRuler({ from: cell, to: cell });
      gesture.current = { kind: 'ruler', pointerId: e.pointerId };
      return;
    }

    const tokenId = (e.target as Element).closest('[data-token-id]')?.getAttribute('data-token-id');
    const token = tokenId ? scene.tokens.find((t) => t.id === tokenId) : undefined;
    if (token && e.button === 0) {
      const m = screenToMap(camRef.current, p.x, p.y);
      const pos = pending[token.id] ?? token;
      gesture.current = {
        kind: 'token',
        pointerId: e.pointerId,
        tokenId: token.id,
        movable: canMove(token),
        dx: m.x - (geo.originX + pos.col * grid.size),
        dy: m.y - (geo.originY + pos.row * grid.size),
        sx: p.x,
        sy: p.y,
        moved: false,
      };
      return;
    }
    gesture.current = { kind: 'pan', pointerId: e.pointerId, sx: p.x, sy: p.y, cam: camRef.current, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan' && g.pointerId === e.pointerId) {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) > DRAG_THRESHOLD) g.moved = true;
      setCam({ ...g.cam, x: g.cam.x + p.x - g.sx, y: g.cam.y + p.y - g.sy });
    } else if (g.kind === 'ruler' && g.pointerId === e.pointerId) {
      const m = screenToMap(camRef.current!, p.x, p.y);
      const to = pointToCell(geo, grid.size, m.x, m.y);
      setRuler((r) => (r && (r.to.col !== to.col || r.to.row !== to.row) ? { ...r, to } : r));
    } else if (g.kind === 'paint' && g.pointerId === e.pointerId) {
      const m = screenToMap(camRef.current!, p.x, p.y);
      const cell = pointToCell(geo, grid.size, m.x, m.y);
      if (cell.col !== g.last.col || cell.row !== g.last.row) paintTo(g, cell);
      if (Date.now() - g.sentAt > FOG_FLUSH_MS) flushPaint(g);
    } else if (g.kind === 'token' && g.pointerId === e.pointerId) {
      if (!g.movable) return;
      if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) <= DRAG_THRESHOLD) return;
      g.moved = true;
      const m = screenToMap(camRef.current!, p.x, p.y);
      setDrag({ tokenId: g.tokenId, x: m.x - g.dx, y: m.y - g.dy });
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
        ? { kind: 'pan', pointerId: id, sx: p.x, sy: p.y, cam: camRef.current, moved: true }
        : null;
      return;
    }
    if (g?.kind === 'paint' && g.pointerId === e.pointerId) {
      flushPaint(g);
    } else if (g?.kind === 'token' && g.pointerId === e.pointerId) {
      if (g.moved && drag) {
        const { col, row } = cellOf(drag.x, drag.y);
        const token = scene.tokens.find((t) => t.id === g.tokenId);
        if (token && (col !== token.col || row !== token.row)) {
          setPending((prev) => ({ ...prev, [g.tokenId]: { col, row } }));
          onMoveToken?.(g.tokenId, col, row);
        }
      } else if (!g.moved) {
        onSelectToken?.(isGm || g.movable ? g.tokenId : null);
      }
      setDrag(null);
    } else if (g?.kind === 'pan' && !g.moved && g.pointerId === e.pointerId) {
      onSelectToken?.(null);
    }
    if (pointers.current.size === 0) gesture.current = null;
  };

  const zoomBy = (factor: number) => {
    if (!cam || !size) return;
    setCam(zoomAt(cam, factor, size.width / 2, size.height / 2, minZoom));
  };

  const k = cam?.k ?? 1;
  const cellCentre = (c: CellPos) => ({
    x: geo.originX + (c.col + 0.5) * grid.size,
    y: geo.originY + (c.row + 0.5) * grid.size,
  });
  const dragToken = drag ? scene.tokens.find((t) => t.id === drag.tokenId) : undefined;
  const dragCell = drag ? cellOf(drag.x, drag.y) : undefined;
  const transform = cam ? `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` : undefined;

  return (
    <div className={`map${interactive ? '' : ' map--display'}${scene.imageUrl ? '' : ' map--blank'}`} ref={wrapRef}>
      <svg
        ref={svgRef}
        className={`map__svg${painting ? ' map__svg--paint' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={(e) => {
          if (!interactive || !camRef.current || tool !== 'move') return;
          if ((e.target as Element).closest('[data-token-id]')) return;
          const p = local(e);
          const m = screenToMap(camRef.current, p.x, p.y);
          onPing?.(m.x, m.y);
        }}
      >
        <defs>
          <clipPath id={`clip-${scene.id}`}>
            <rect width={scene.width} height={scene.height} />
          </clipPath>
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
            {fog && <path d={fogD} className={`map__fog${isGm ? ' map__fog--gm' : ''}`} clipPath={`url(#clip-${scene.id})`} />}
            {drag && (
              <rect
                className="map__drop"
                x={geo.originX + cellOf(drag.x, drag.y).col * grid.size}
                y={geo.originY + cellOf(drag.x, drag.y).row * grid.size}
                width={(scene.tokens.find((t) => t.id === drag.tokenId)?.size ?? 1) * grid.size}
                height={(scene.tokens.find((t) => t.id === drag.tokenId)?.size ?? 1) * grid.size}
                strokeWidth={2 / k}
              />
            )}
            {scene.tokens.map((t) => {
              const dragging = drag?.tokenId === t.id;
              const pos = pending[t.id] ?? t;
              return (
                <TokenShape
                  key={t.id}
                  token={t}
                  cell={grid.size}
                  x={dragging ? drag.x : geo.originX + pos.col * grid.size}
                  y={dragging ? drag.y : geo.originY + pos.row * grid.size}
                  selected={t.id === selectedTokenId}
                  mine={!isGm && userId !== undefined && t.ownerUserId === userId}
                  movable={interactive && canMove(t)}
                  dragging={dragging}
                />
              );
            })}
            <rect width={scene.width} height={scene.height} className="map__frame" strokeWidth={2 / k} />
            {dragToken && dragCell && drag && (dragCell.col !== dragToken.col || dragCell.row !== dragToken.row) && (
              <MapLabel
                x={geo.originX + (dragCell.col + dragToken.size / 2) * grid.size}
                y={geo.originY + dragCell.row * grid.size}
                k={k}
                text={`${gridDistanceFeet(dragToken, dragCell, grid.feetPerCell)} ft`}
              />
            )}
            {ruler && (
              <g className="ruler" pointerEvents="none">
                <line
                  x1={cellCentre(ruler.from).x}
                  y1={cellCentre(ruler.from).y}
                  x2={cellCentre(ruler.to).x}
                  y2={cellCentre(ruler.to).y}
                  strokeWidth={3 / k}
                />
                <circle cx={cellCentre(ruler.from).x} cy={cellCentre(ruler.from).y} r={5 / k} />
                <circle cx={cellCentre(ruler.to).x} cy={cellCentre(ruler.to).y} r={5 / k} />
                <MapLabel
                  x={cellCentre(ruler.to).x}
                  y={cellCentre(ruler.to).y - 6 / k}
                  k={k}
                  text={`${gridDistanceFeet(ruler.from, ruler.to, grid.feetPerCell)} ft`}
                />
              </g>
            )}
            {pings
              .filter((p) => p.sceneId === scene.id)
              .map((p) => (
                <g key={p.id} transform={`translate(${p.x} ${p.y}) scale(${1 / k})`} className={`ping ping--${p.role}`} pointerEvents="none">
                  <circle r={10} className="ping__dot" />
                  <circle r={10} className="ping__wave" />
                  <circle r={10} className="ping__wave ping__wave--late" />
                  <text y={-22}>{p.name}</text>
                </g>
              ))}
          </g>
        )}
      </svg>
      {children}
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

