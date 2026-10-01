// Moving across a drawn map: what a straight line crosses, and what the walk costs.

import type { Edge, MapData } from './mapdata';

export interface CellPos {
  col: number;
  row: number;
}

/** Why a move is not allowed: a wall or closed door in the way, or impassable terrain. */
export type MoveBlock = 'wall' | 'terrain';

/**
 * Walks the straight line between two cell centres through every grid line it crosses, using
 * exact integer comparisons. A line that passes exactly through a grid corner is treated
 * conservatively: it is blocked if any of the four edges meeting at that corner blocks, or if
 * any of the three cells it squeezes between and into is impassable (no cutting corners).
 * The starting cell itself is never checked, so a token can always leave where it stands.
 */
export function lineBlock(map: MapData, from: CellPos, to: CellPos): MoveBlock | null {
  const sx = Math.sign(to.col - from.col);
  const sy = Math.sign(to.row - from.row);
  const nx = Math.abs(to.col - from.col);
  const ny = Math.abs(to.row - from.row);
  // The grid line between column c and c + sx, and between row r and r + sy.
  const vertical = (c: number, r: number): Edge => ({ side: 'left', col: sx > 0 ? c + 1 : c, row: r });
  const horizontal = (c: number, r: number): Edge => ({ side: 'top', col: c, row: sy > 0 ? r + 1 : r });
  let c = from.col;
  let r = from.row;
  let ix = 0;
  let iy = 0;
  while (ix < nx || iy < ny) {
    // The k-th vertical line is crossed at t = (2k + 1) / 2nx, the k-th horizontal at (2k + 1) / 2ny.
    const cmp = ix >= nx ? 1 : iy >= ny ? -1 : (2 * ix + 1) * ny - (2 * iy + 1) * nx;
    if (cmp < 0) {
      if (map.blocks(vertical(c, r))) return 'wall';
      c += sx;
      ix++;
    } else if (cmp > 0) {
      if (map.blocks(horizontal(c, r))) return 'wall';
      r += sy;
      iy++;
    } else {
      const arms = [vertical(c, r), vertical(c, r + sy), horizontal(c, r), horizontal(c + sx, r)];
      if (arms.some((e) => map.blocks(e))) return 'wall';
      if (!map.passable(c + sx, r) || !map.passable(c, r + sy)) return 'terrain';
      c += sx;
      r += sy;
      ix++;
      iy++;
    }
    if (!map.passable(c, r)) return 'terrain';
  }
  return null;
}

/**
 * Whether a token of `size` × `size` cells may slide from its top-left cell to `to` in a straight
 * line: every cell of its footprint must make the same move without crossing a wall, closed door
 * or impassable cell, so a Large creature can't slip through a one-square doorway.
 */
export function moveBlock(map: MapData, from: CellPos, to: CellPos, size = 1): MoveBlock | null {
  let found: MoveBlock | null = null;
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const block = lineBlock(map, { col: from.col + dc, row: from.row + dr }, { col: to.col + dc, row: to.row + dr });
      if (block === 'wall') return block;
      found ??= block;
    }
  }
  return found;
}

/** The squares a straight move steps through, one king's move at a time, both ends included. */
export function lineCells(from: CellPos, to: CellPos): CellPos[] {
  const dx = to.col - from.col;
  const dy = to.row - from.row;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  const out: CellPos[] = [];
  for (let i = 0; i <= n; i++) {
    out.push({ col: from.col + (n && Math.round((dx * i) / n)), row: from.row + (n && Math.round((dy * i) / n)) });
  }
  return out;
}

/**
 * Feet of movement spent walking a path of adjacent squares (2024 rules: every square costs
 * `feetPerCell`, diagonals included, plus the same again when entering difficult terrain). For a
 * token bigger than one square, a step is difficult if any square of its footprint lands in it.
 */
export function movementCost(map: MapData, path: CellPos[], feetPerCell: number, size = 1): number {
  let feet = 0;
  for (let i = 1; i < path.length; i++) {
    const { col, row } = path[i]!;
    let difficult = false;
    for (let dr = 0; dr < size && !difficult; dr++) for (let dc = 0; dc < size && !difficult; dc++) difficult = map.difficult(col + dc, row + dr);
    feet += difficult ? feetPerCell * 2 : feetPerCell;
  }
  return feet;
}

export interface MoveMeasure {
  /** Straight-line distance (every square, diagonal or not, is one cell's worth of feet). */
  feet: number;
  /** Movement it costs, counting difficult terrain. */
  cost: number;
  block: MoveBlock | null;
}

/** Distance, movement cost and blockers for a straight move, as shown by the ruler and token drags. */
export function measureMove(map: MapData, from: CellPos, to: CellPos, feetPerCell: number, size = 1): MoveMeasure {
  const path = lineCells(from, to);
  return {
    feet: (path.length - 1) * feetPerCell,
    cost: movementCost(map, path, feetPerCell, size),
    block: moveBlock(map, from, to, size),
  };
}
