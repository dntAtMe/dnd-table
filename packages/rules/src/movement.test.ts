import { describe, expect, it } from 'vitest';
import { MapData, edgeCode, terrainCode, type Edge } from './mapdata';
import { lineBlock, lineCells, measureMove, moveBlock, movementCost } from './movement';

const WALL = edgeCode({ kind: 'wall' });
const at = (col: number, row: number) => ({ col, row });

function mapWith(cols: number, rows: number, walls: Edge[] = [], code = WALL): MapData {
  const map = new MapData(cols, rows);
  for (const e of walls) map.setEdge(e, code);
  return map;
}

describe('lineBlock', () => {
  it('stops at walls and closed doors but not open ones', () => {
    const wall: Edge = { side: 'left', col: 3, row: 2 };
    expect(lineBlock(mapWith(6, 6, [wall]), at(1, 2), at(5, 2))).toBe('wall');
    expect(lineBlock(mapWith(6, 6, [wall]), at(5, 2), at(1, 2))).toBe('wall');
    expect(lineBlock(mapWith(6, 6, [wall]), at(1, 3), at(5, 3))).toBeNull();
    expect(lineBlock(mapWith(6, 6, [wall], edgeCode({ kind: 'door', state: 'locked', secret: true })), at(1, 2), at(5, 2))).toBe('wall');
    expect(lineBlock(mapWith(6, 6, [wall], edgeCode({ kind: 'door', state: 'open', secret: false })), at(1, 2), at(5, 2))).toBeNull();
    expect(lineBlock(mapWith(6, 6, [{ side: 'top', col: 2, row: 4 }]), at(2, 0), at(2, 5))).toBe('wall');
  });

  it('follows shallow diagonals through the cells they really cross', () => {
    // (0,0) → (3,1) crosses x=1 in row 0, passes exactly through the corner (2,1), then crosses x=3 in row 1.
    const throughRow0 = mapWith(4, 2, [{ side: 'left', col: 1, row: 0 }]);
    expect(lineBlock(throughRow0, at(0, 0), at(3, 1))).toBe('wall');
    const besideRow1 = mapWith(4, 2, [{ side: 'left', col: 1, row: 1 }]);
    expect(lineBlock(besideRow1, at(0, 0), at(3, 1))).toBeNull();
    const floor = mapWith(4, 2, [{ side: 'top', col: 1, row: 1 }]);
    expect(lineBlock(floor, at(0, 0), at(3, 1))).toBe('wall');
    expect(lineBlock(floor, at(3, 1), at(0, 0))).toBe('wall');
  });

  it('treats exact corner passes conservatively', () => {
    // A diagonal step from (0,0) to (1,1) passes the corner at (1,1); any of the four edges meeting there blocks it.
    const arms: Edge[] = [
      { side: 'left', col: 1, row: 0 },
      { side: 'left', col: 1, row: 1 },
      { side: 'top', col: 0, row: 1 },
      { side: 'top', col: 1, row: 1 },
    ];
    for (const arm of arms) {
      expect(lineBlock(mapWith(3, 3, [arm]), at(0, 0), at(1, 1))).toBe('wall');
      expect(lineBlock(mapWith(3, 3, [arm]), at(1, 1), at(0, 0))).toBe('wall');
    }
    // A wall touching a different corner doesn't matter.
    expect(lineBlock(mapWith(3, 3, [{ side: 'left', col: 2, row: 0 }]), at(0, 0), at(1, 1))).toBeNull();
    // Long diagonals hit every corner along the way, in either direction.
    const mid = mapWith(5, 5, [{ side: 'top', col: 3, row: 3 }]);
    expect(lineBlock(mid, at(0, 0), at(4, 4))).toBe('wall');
    expect(lineBlock(mid, at(4, 0), at(0, 4))).toBeNull();
    expect(lineBlock(mapWith(5, 5, [{ side: 'top', col: 2, row: 2 }]), at(4, 0), at(0, 4))).toBe('wall');
    // (0,0) → (1,3) passes the corner (1,2) between cells (0,1), (1,1), (0,2) and (1,2).
    expect(lineBlock(mapWith(3, 5, [{ side: 'left', col: 1, row: 1 }]), at(0, 0), at(1, 3))).toBe('wall');
    expect(lineBlock(mapWith(3, 5, [{ side: 'left', col: 1, row: 2 }]), at(0, 0), at(1, 3))).toBe('wall');
    expect(lineBlock(mapWith(3, 5, [{ side: 'left', col: 1, row: 0 }]), at(0, 0), at(1, 3))).toBeNull();
    // (0,0) → (2,4) never touches a corner: it crosses x=1 at y=1.5.
    expect(lineBlock(mapWith(3, 5, [{ side: 'left', col: 1, row: 2 }]), at(0, 0), at(2, 4))).toBeNull();
    expect(lineBlock(mapWith(3, 5, [{ side: 'left', col: 1, row: 1 }]), at(0, 0), at(2, 4))).toBe('wall');
  });

  it("won't enter or squeeze past impassable terrain, but lets a token leave it", () => {
    const map = new MapData(4, 4);
    map.setTerrain(2, 0, terrainCode('rock'));
    expect(lineBlock(map, at(0, 0), at(3, 0))).toBe('terrain');
    expect(lineBlock(map, at(0, 0), at(2, 0))).toBe('terrain');
    expect(lineBlock(map, at(0, 1), at(3, 1))).toBeNull();
    expect(lineBlock(map, at(2, 0), at(2, 3))).toBeNull();
    // Diagonal past the rock's corner.
    expect(lineBlock(map, at(1, 0), at(2, 1))).toBe('terrain');
    expect(lineBlock(map, at(3, 1), at(2, 2))).toBeNull();
  });

  it('allows staying put', () => {
    expect(lineBlock(mapWith(2, 2), at(1, 1), at(1, 1))).toBeNull();
  });
});

describe('moveBlock', () => {
  it('moves the whole footprint of large tokens', () => {
    // A one-square doorway: a wall across row line 2 except at column 2.
    const walls: Edge[] = [0, 1, 3, 4, 5].map((col) => ({ side: 'top', col, row: 2 }));
    const map = mapWith(6, 6, walls);
    expect(moveBlock(map, at(2, 0), at(2, 4))).toBeNull();
    expect(moveBlock(map, at(2, 0), at(2, 4), 2)).toBe('wall');
    expect(moveBlock(map, at(1, 0), at(1, 4), 2)).toBe('wall');

    const rock = new MapData(6, 6);
    rock.setTerrain(4, 4, terrainCode('rock'));
    expect(moveBlock(rock, at(0, 3), at(3, 3), 2)).toBe('terrain');
    expect(moveBlock(rock, at(0, 0), at(2, 0), 2)).toBeNull();
  });
});

describe('movement cost', () => {
  it('steps one square at a time like a king', () => {
    expect(lineCells(at(0, 0), at(3, 1))).toEqual([at(0, 0), at(1, 0), at(2, 1), at(3, 1)]);
    expect(lineCells(at(2, 2), at(2, 2))).toEqual([at(2, 2)]);
    expect(lineCells(at(4, 4), at(0, 2))).toHaveLength(5);
  });

  it('charges an extra square for each difficult square entered', () => {
    const map = new MapData(6, 6);
    map.setTerrain(1, 0, terrainCode('difficult'));
    map.setTerrain(2, 0, terrainCode('water'));
    map.setTerrain(0, 0, terrainCode('difficult')); // leaving it is free
    expect(movementCost(map, lineCells(at(0, 0), at(4, 0)), 5)).toBe(30);
    expect(measureMove(map, at(0, 0), at(4, 0), 5)).toEqual({ feet: 20, cost: 30, block: null });
    expect(measureMove(map, at(0, 1), at(4, 1), 5)).toEqual({ feet: 20, cost: 20, block: null });
    // A Large token along row 1 drags its top half through the difficult squares.
    expect(movementCost(map, lineCells(at(0, 1), at(3, 1)), 5, 2)).toBe(15);
    expect(movementCost(map, lineCells(at(0, 0), at(3, 0)), 5, 2)).toBe(25);
  });
});
