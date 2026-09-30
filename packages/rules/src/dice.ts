// Dice notation: terms joined by + or -, e.g. "1d20+5", "2d20kh1 + 1d4 - 1", "4d6dl1", "d%".
// Keep/drop modifiers: kh (keep highest), kl (keep lowest), dh (drop highest), dl (drop lowest),
// each followed by an optional count (default 1).

export type KeepMode = 'kh' | 'kl' | 'dh' | 'dl';

export interface DieRoll {
  value: number;
  dropped: boolean;
}

export interface DiceTerm {
  kind: 'dice';
  sign: 1 | -1;
  count: number;
  sides: number;
  keep?: { mode: KeepMode; n: number };
  rolls: DieRoll[];
  subtotal: number;
}

export interface ConstTerm {
  kind: 'const';
  sign: 1 | -1;
  value: number;
}

export type RollTerm = DiceTerm | ConstTerm;

export interface RollResult {
  /** Normalised expression, e.g. "2d20kh1 + 5". */
  expression: string;
  terms: RollTerm[];
  total: number;
  /** Set when the roll is a single kept d20 that came up 20 or 1. */
  natural?: 'crit' | 'fumble';
}

export type ParsedTerm = Omit<DiceTerm, 'rolls' | 'subtotal'> | ConstTerm;

/** Returns an integer in [1, sides]. */
export type Rng = (sides: number) => number;

export class DiceError extends Error {}

export const DICE_LIMITS = { maxTerms: 20, maxDice: 100, maxSides: 1000, maxConst: 1000 };

declare const crypto: { getRandomValues<T extends Uint32Array>(array: T): T };

/** Unbiased uniform die roll using the platform CSPRNG (works in Node and browsers). */
export const cryptoRng: Rng = (sides) => {
  const limit = Math.floor(0x1_0000_0000 / sides) * sides;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const x = buf[0]!;
    if (x < limit) return (x % sides) + 1;
  }
};

const TERM_RE = /([+-]?)([^+-]+)/g;
const DICE_RE = /^(\d*)d(\d+|%)(?:(kh|kl|dh|dl)(\d*))?$/;
const CONST_RE = /^\d+$/;

export function parseDice(input: string): ParsedTerm[] {
  const expr = input.replace(/\s+/g, '').toLowerCase();
  if (!expr) throw new DiceError('Empty expression');

  const terms: ParsedTerm[] = [];
  let consumed = 0;
  for (const match of expr.matchAll(TERM_RE)) {
    if (match.index !== consumed) throw new DiceError(`Unexpected "${expr.slice(consumed)}"`);
    consumed += match[0].length;
    const sign = match[1] === '-' ? -1 : 1;
    const body = match[2]!;

    if (CONST_RE.test(body)) {
      const value = Number(body);
      if (value > DICE_LIMITS.maxConst) throw new DiceError(`Modifier ${value} is too large`);
      terms.push({ kind: 'const', sign, value });
      continue;
    }

    const dice = DICE_RE.exec(body);
    if (!dice) throw new DiceError(`Can't read "${body}"`);
    const count = dice[1] ? Number(dice[1]) : 1;
    const sides = dice[2] === '%' ? 100 : Number(dice[2]);
    if (count < 1) throw new DiceError('Roll at least one die');
    if (sides < 2) throw new DiceError('Dice need at least 2 sides');
    if (sides > DICE_LIMITS.maxSides) throw new DiceError(`d${sides} has too many sides`);

    const term: ParsedTerm = { kind: 'dice', sign, count, sides };
    if (dice[3]) {
      const n = dice[4] ? Number(dice[4]) : 1;
      if (n < 1 || n > count) throw new DiceError(`Can't ${dice[3]}${n} from ${count} dice`);
      term.keep = { mode: dice[3] as KeepMode, n };
    }
    terms.push(term);
  }
  if (consumed !== expr.length) throw new DiceError(`Unexpected "${expr.slice(consumed)}"`);
  if (terms.length > DICE_LIMITS.maxTerms) throw new DiceError('Too many terms');
  const totalDice = terms.reduce((n, t) => n + (t.kind === 'dice' ? t.count : 0), 0);
  if (totalDice > DICE_LIMITS.maxDice) throw new DiceError(`Too many dice (max ${DICE_LIMITS.maxDice})`);
  return terms;
}

export function formatTerms(terms: readonly ParsedTerm[]): string {
  return terms
    .map((t, i) => {
      const body =
        t.kind === 'const' ? String(t.value) : `${t.count}d${t.sides}${t.keep ? t.keep.mode + t.keep.n : ''}`;
      if (i === 0) return t.sign < 0 ? `-${body}` : body;
      return `${t.sign < 0 ? '-' : '+'} ${body}`;
    })
    .join(' ');
}

function applyKeep(values: number[], keep: DiceTerm['keep']): DieRoll[] {
  const rolls = values.map((value) => ({ value, dropped: false }));
  if (!keep) return rolls;
  // Sort indices by value; ties resolved by roll order so the result is deterministic.
  const order = rolls.map((_, i) => i).sort((a, b) => rolls[a]!.value - rolls[b]!.value || a - b);
  const count = rolls.length;
  let dropIdx: number[];
  switch (keep.mode) {
    case 'kh':
      dropIdx = order.slice(0, count - keep.n);
      break;
    case 'kl':
      dropIdx = order.slice(keep.n);
      break;
    case 'dh':
      dropIdx = order.slice(count - keep.n);
      break;
    case 'dl':
      dropIdx = order.slice(0, keep.n);
      break;
  }
  for (const i of dropIdx) rolls[i]!.dropped = true;
  return rolls;
}

export function rollParsed(parsed: readonly ParsedTerm[], rng: Rng = cryptoRng): RollResult {
  const terms: RollTerm[] = parsed.map((t) => {
    if (t.kind === 'const') return { ...t };
    const values = Array.from({ length: t.count }, () => rng(t.sides));
    const rolls = applyKeep(values, t.keep);
    const subtotal = rolls.reduce((sum, r) => sum + (r.dropped ? 0 : r.value), 0);
    return { ...t, rolls, subtotal };
  });

  const total = terms.reduce((sum, t) => sum + t.sign * (t.kind === 'const' ? t.value : t.subtotal), 0);

  const result: RollResult = { expression: formatTerms(parsed), terms, total };
  const diceTerms = terms.filter((t): t is DiceTerm => t.kind === 'dice');
  if (diceTerms.length === 1 && diceTerms[0]!.sides === 20) {
    const kept = diceTerms[0]!.rolls.filter((r) => !r.dropped);
    if (kept.length === 1) {
      if (kept[0]!.value === 20) result.natural = 'crit';
      else if (kept[0]!.value === 1) result.natural = 'fumble';
    }
  }
  return result;
}

export function rollDice(expr: string, rng: Rng = cryptoRng): RollResult {
  return rollParsed(parseDice(expr), rng);
}

export type D20Mode = 'normal' | 'advantage' | 'disadvantage';

export function formatModifier(n: number): string {
  return n < 0 ? `- ${-n}` : `+ ${n}`;
}

/** Builds a d20 check expression, e.g. d20Expression(5, 'advantage') → "2d20kh1 + 5". */
export function d20Expression(modifier: number, mode: D20Mode = 'normal'): string {
  const die = mode === 'advantage' ? '2d20kh1' : mode === 'disadvantage' ? '2d20kl1' : '1d20';
  return modifier === 0 ? die : `${die} ${formatModifier(modifier)}`;
}
