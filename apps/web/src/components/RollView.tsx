import type { RollResult } from '@dnd/rules';

function dieClass(value: number, sides: number, dropped: boolean): string {
  const classes = ['die'];
  if (dropped) classes.push('die--dropped');
  else if (value === sides) classes.push('die--max');
  else if (value === 1) classes.push('die--min');
  return classes.join(' ');
}

/** Shows each die (dropped dice struck through), modifiers, and the total. */
export function RollView({ roll, size = 'md' }: { roll: RollResult; size?: 'md' | 'lg' }) {
  return (
    <div className={`roll roll--${size}${roll.natural ? ` roll--${roll.natural}` : ''}`}>
      <div className="roll__breakdown">
        {roll.terms.map((term, i) => (
          <span key={i} className="roll__term">
            {(i > 0 || term.sign < 0) && <span className="roll__op">{term.sign < 0 ? '−' : '+'}</span>}
            {term.kind === 'const' ? (
              <span className="roll__const">{term.value}</span>
            ) : (
              <span className="roll__dice" title={`${term.count}d${term.sides}${term.keep ? term.keep.mode + term.keep.n : ''}`}>
                {term.rolls.map((r, j) => (
                  <span key={j} className={dieClass(r.value, term.sides, r.dropped)} data-sides={term.sides}>
                    {r.value}
                  </span>
                ))}
              </span>
            )}
          </span>
        ))}
        <span className="roll__eq">=</span>
      </div>
      <div className="roll__total">{roll.total}</div>
      {roll.natural && <div className="roll__natural">{roll.natural === 'crit' ? 'Natural 20!' : 'Natural 1'}</div>}
    </div>
  );
}
