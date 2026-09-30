import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID, FogMask, brushCells, gridDistanceFeet, gridGeometry, pointToCell } from './grid';

describe('gridGeometry', () => {
  it('covers the whole map with whole cells', () => {
    expect(gridGeometry(DEFAULT_GRID, 700, 350)).toEqual({ originX: 0, originY: 0, cols: 10, rows: 5 });
    expect(gridGeometry(DEFAULT_GRID, 701, 350)).toMatchObject({ cols: 11, rows: 5 });
  });

  it('shifts the origin left/up when the grid is offset', () => {
    const geo = gridGeometry({ ...DEFAULT_GRID, offsetX: 20, offsetY: 70 }, 700, 350);
    expect(geo).toEqual({ originX: -50, originY: 0, cols: 11, rows: 5 });
    expect(pointToCell(geo, 70, 19, 0)).toEqual({ col: 0, row: 0 });
    expect(pointToCell(geo, 70, 20, 0)).toEqual({ col: 1, row: 0 });
  });
});

describe('gridDistanceFeet', () => {
  it('counts diagonals as one square (2024 rules)', () => {
    expect(gridDistanceFeet({ col: 0, row: 0 }, { col: 3, row: 3 }, 5)).toBe(15);
    expect(gridDistanceFeet({ col: 2, row: 1 }, { col: 0, row: 6 }, 5)).toBe(25);
  });
});

describe('FogMask', () => {
  it('sets, reads and round-trips through base64', () => {
    const fog = new FogMask(13, 7);
    fog.set(0, 0, true);
    fog.set(12, 6, true);
    fog.set(5, 3, true);
    fog.set(5, 3, false);
    const copy = FogMask.decode(fog.encode(), 13, 7);
    expect(copy.isRevealed(0, 0)).toBe(true);
    expect(copy.isRevealed(12, 6)).toBe(true);
    expect(copy.isRevealed(5, 3)).toBe(false);
    expect(copy.isRevealed(13, 0)).toBe(false);
  });

  it('checks n×n blocks for large tokens', () => {
    const fog = new FogMask(10, 10);
    fog.set(3, 3, true);
    expect(fog.anyRevealed(2, 2, 2)).toBe(true);
    expect(fog.anyRevealed(0, 0, 2)).toBe(false);
  });

  it('ignores a mask of the wrong size', () => {
    const encoded = new FogMask(4, 4).encode();
    expect(FogMask.decode(encoded, 100, 100).bits.length).toBe(1250);
  });
});

describe('brushCells', () => {
  it('returns a single cell for diameter 1 and clips to the grid', () => {
    expect(brushCells(10, 10, 4, 4, 1)).toEqual([44]);
    expect(brushCells(10, 10, 0, 0, 3).sort((a, b) => a - b)).toEqual([0, 1, 10, 11]);
    expect(brushCells(10, 10, 5, 5, 3)).toHaveLength(9);
  });
});
