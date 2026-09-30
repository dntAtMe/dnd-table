import { describe, expect, it } from 'vitest';
import { DiceError, cryptoRng, d20Expression, parseDice, rollDice, type Rng } from './dice';

/** Rng that returns the given values in order (ignores sides). */
function fixed(...values: number[]): Rng {
  let i = 0;
  return () => {
    const v = values[i++];
    if (v === undefined) throw new Error('fixed rng exhausted');
    return v;
  };
}

describe('parseDice', () => {
  it('parses dice, constants and signs', () => {
    expect(parseDice('2d6 + 1d8 - 3')).toEqual([
      { kind: 'dice', sign: 1, count: 2, sides: 6 },
      { kind: 'dice', sign: 1, count: 1, sides: 8 },
      { kind: 'const', sign: -1, value: 3 },
    ]);
  });

  it('defaults the count to one and reads d%', () => {
    expect(parseDice('d20')).toEqual([{ kind: 'dice', sign: 1, count: 1, sides: 20 }]);
    expect(parseDice('d%')).toEqual([{ kind: 'dice', sign: 1, count: 1, sides: 100 }]);
  });

  it('parses keep/drop modifiers with default count', () => {
    expect(parseDice('2d20kh')).toEqual([{ kind: 'dice', sign: 1, count: 2, sides: 20, keep: { mode: 'kh', n: 1 } }]);
    expect(parseDice('4D6DL1')[0]).toMatchObject({ keep: { mode: 'dl', n: 1 } });
  });

  it.each(['', '1d', 'd1', '2x6', '1d20++2', '3d6kh4', '0d6', '101d6', '1d1001', 'abc'])(
    'rejects %j',
    (expr) => {
      expect(() => parseDice(expr)).toThrow(DiceError);
    },
  );
});

describe('rollDice', () => {
  it('sums dice and modifiers', () => {
    const r = rollDice('2d6+1d4-1', fixed(3, 5, 2));
    expect(r.total).toBe(9);
    expect(r.expression).toBe('2d6 + 1d4 - 1');
  });

  it('keeps the highest for advantage', () => {
    const r = rollDice('2d20kh1+5', fixed(7, 15));
    expect(r.total).toBe(20);
    expect(r.terms[0]).toMatchObject({ rolls: [{ value: 7, dropped: true }, { value: 15, dropped: false }] });
  });

  it('drops the lowest for ability scores', () => {
    const r = rollDice('4d6dl1', fixed(4, 1, 6, 1));
    expect(r.total).toBe(11);
    // Ties drop the earliest roll.
    expect(r.terms[0]).toMatchObject({ rolls: [{ dropped: false }, { dropped: true }, { dropped: false }, { dropped: false }] });
  });

  it('flags natural 20 and natural 1 on a single kept d20', () => {
    expect(rollDice('1d20+3', fixed(20)).natural).toBe('crit');
    expect(rollDice('2d20kl1', fixed(1, 20)).natural).toBe('fumble');
    expect(rollDice('2d20kh1', fixed(1, 20)).natural).toBe('crit');
    expect(rollDice('1d20+1d4', fixed(20, 2)).natural).toBeUndefined();
    expect(rollDice('2d20', fixed(20, 20)).natural).toBeUndefined();
  });
});

describe('cryptoRng', () => {
  it('stays in range and hits every face', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = cryptoRng(6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });
});

describe('d20Expression', () => {
  it('builds check expressions', () => {
    expect(d20Expression(0)).toBe('1d20');
    expect(d20Expression(5, 'advantage')).toBe('2d20kh1 + 5');
    expect(d20Expression(-1, 'disadvantage')).toBe('2d20kl1 - 1');
  });
});
