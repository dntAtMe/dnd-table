// Square battle-map grid laid over a map image, plus the fog-of-war mask that goes with it.

export interface Grid {
  /** Cell size in map pixels (may be fractional to match a scanned map). */
  size: number;
  /** Shift of the grid lines in map pixels, 0 ≤ offset < size. */
  offsetX: number;
  offsetY: number;
  visible: boolean;
  feetPerCell: number;
}

export interface GridGeometry {
  /** Map-pixel position of cell (0, 0)'s top-left corner; ≤ 0 so the grid covers the whole map. */
  originX: number;
  originY: number;
  cols: number;
  rows: number;
}

export const DEFAULT_GRID: Grid = { size: 70, offsetX: 0, offsetY: 0, visible: true, feetPerCell: 5 };

/** Keeps grids sane: a 1px grid on an 8k map would be millions of cells. */
export const GRID_LIMITS = { minSize: 8, maxCells: 250 * 250 };

function origin(offset: number, size: number): number {
  const o = ((offset % size) + size) % size;
  return o === 0 ? 0 : o - size;
}

export function gridGeometry(grid: Grid, width: number, height: number): GridGeometry {
  const originX = origin(grid.offsetX, grid.size);
  const originY = origin(grid.offsetY, grid.size);
  return {
    originX,
    originY,
    cols: Math.max(1, Math.ceil((width - originX) / grid.size)),
    rows: Math.max(1, Math.ceil((height - originY) / grid.size)),
  };
}

/** Top-left corner of a cell in map pixels. */
export function cellToPoint(geo: GridGeometry, size: number, col: number, row: number): { x: number; y: number } {
  return { x: geo.originX + col * size, y: geo.originY + row * size };
}

/** The cell containing a map-pixel point (may be outside the grid). */
export function pointToCell(geo: GridGeometry, size: number, x: number, y: number): { col: number; row: number } {
  return { col: Math.floor((x - geo.originX) / size), row: Math.floor((y - geo.originY) / size) };
}

/**
 * Distance between two cells under the 2024 rules: every square, diagonal or not, costs
 * one cell's worth of feet (so it's the Chebyshev distance).
 */
export function gridDistanceFeet(
  a: { col: number; row: number },
  b: { col: number; row: number },
  feetPerCell: number,
): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row)) * feetPerCell;
}

declare function btoa(data: string): string;
declare function atob(data: string): string;

/** One bit per cell, 1 = revealed to players. Serialised as base64 for storage and the wire. */
export class FogMask {
  readonly bits: Uint8Array;

  constructor(
    readonly cols: number,
    readonly rows: number,
    bits?: Uint8Array,
  ) {
    const bytes = Math.ceil((cols * rows) / 8);
    this.bits = bits && bits.length === bytes ? bits : new Uint8Array(bytes);
  }

  static decode(encoded: string, cols: number, rows: number): FogMask {
    const bin = atob(encoded);
    const bits = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bits[i] = bin.charCodeAt(i);
    return new FogMask(cols, rows, bits);
  }

  encode(): string {
    let bin = '';
    for (const b of this.bits) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  get size(): number {
    return this.cols * this.rows;
  }

  index(col: number, row: number): number {
    return row * this.cols + col;
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  isRevealed(col: number, row: number): boolean {
    if (!this.inBounds(col, row)) return false;
    const i = this.index(col, row);
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  setIndex(i: number, revealed: boolean): void {
    if (i < 0 || i >= this.size) return;
    if (revealed) this.bits[i >> 3]! |= 1 << (i & 7);
    else this.bits[i >> 3]! &= ~(1 << (i & 7));
  }

  set(col: number, row: number, revealed: boolean): void {
    if (this.inBounds(col, row)) this.setIndex(this.index(col, row), revealed);
  }

  fill(revealed: boolean): void {
    this.bits.fill(revealed ? 0xff : 0);
  }

  /** True if any cell of an n×n block whose top-left is (col, row) is revealed. */
  anyRevealed(col: number, row: number, n: number): boolean {
    for (let r = row; r < row + n; r++) for (let c = col; c < col + n; c++) if (this.isRevealed(c, r)) return true;
    return false;
  }
}

/** Cell indices covered by a round brush of the given diameter centred on a cell. */
export function brushCells(cols: number, rows: number, col: number, row: number, diameter: number): number[] {
  const out: number[] = [];
  const r = (diameter - 1) / 2;
  for (let dr = -Math.ceil(r); dr <= Math.ceil(r); dr++) {
    for (let dc = -Math.ceil(r); dc <= Math.ceil(r); dc++) {
      if (dc * dc + dr * dr > r * r + r) continue;
      const c = col + dc;
      const rr = row + dr;
      if (c >= 0 && rr >= 0 && c < cols && rr < rows) out.push(rr * cols + c);
    }
  }
  return out;
}
