import { describe, expect, it } from 'vitest';
import { AmountError, MAX_DECIMALS, assertDecimals, formatBaseUnits, parseDecimalAmount } from '../src/amounts.ts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AmountError) return error.code;
    throw error;
  }
  return undefined;
}

describe('assertDecimals', () => {
  it('accepts whole numbers from 0 to the anchor SDK maximum', () => {
    for (const ok of [0, 1, 2, 6, 18, MAX_DECIMALS]) expect(() => assertDecimals(ok)).not.toThrow();
  });

  it('rejects everything else', () => {
    for (const bad of [-1, 1.5, MAX_DECIMALS + 1, NaN, Infinity, '6', null, undefined, 6n]) {
      expect(codeOf(() => assertDecimals(bad))).toBe('INVALID_DECIMALS');
    }
  });
});

describe('parseDecimalAmount', () => {
  it('converts whole and fractional amounts exactly', () => {
    expect(parseDecimalAmount('0', 2)).toBe(0n);
    expect(parseDecimalAmount('1', 2)).toBe(100n);
    expect(parseDecimalAmount('12.50', 2)).toBe(1250n);
    expect(parseDecimalAmount('12.5', 2)).toBe(1250n);
    expect(parseDecimalAmount('0.01', 2)).toBe(1n);
    expect(parseDecimalAmount('12.50', 6)).toBe(12_500_000n);
    expect(parseDecimalAmount('0.000001', 6)).toBe(1n);
  });

  it('handles zero decimals', () => {
    expect(parseDecimalAmount('42', 0)).toBe(42n);
    expect(parseDecimalAmount('42.0', 0)).toBe(42n);
    expect(codeOf(() => parseDecimalAmount('42.5', 0))).toBe('TOO_MANY_DECIMALS');
  });

  it('is exact far beyond Number precision (18 decimals, as KTA has)', () => {
    expect(parseDecimalAmount('1', 18)).toBe(1_000_000_000_000_000_000n);
    expect(parseDecimalAmount('10', 18)).toBe(10_000_000_000_000_000_000n);
    expect(parseDecimalAmount('123456789.123456789123456789', 18)).toBe(123_456_789_123_456_789_123_456_789n);
    expect(parseDecimalAmount('0.000000000000000001', 18)).toBe(1n);
    // The classic float trap: 0.1 + 0.2. Here it is just digits.
    expect(parseDecimalAmount('0.1', 18) + parseDecimalAmount('0.2', 18)).toBe(parseDecimalAmount('0.3', 18));
  });

  it('tolerates leading zeros', () => {
    expect(parseDecimalAmount('007.5', 2)).toBe(750n);
    expect(parseDecimalAmount('000', 2)).toBe(0n);
    expect(parseDecimalAmount('0.50', 2)).toBe(50n);
  });

  it('allows excess fraction digits only when they are zeros', () => {
    expect(parseDecimalAmount('1.500', 2)).toBe(150n);
    expect(parseDecimalAmount('1.5000000', 2)).toBe(150n);
    expect(parseDecimalAmount('1.000', 0)).toBe(1n);
    expect(codeOf(() => parseDecimalAmount('1.505', 2))).toBe('TOO_MANY_DECIMALS');
    expect(codeOf(() => parseDecimalAmount('1.001', 2))).toBe('TOO_MANY_DECIMALS');
    expect(codeOf(() => parseDecimalAmount('0.0000001', 6))).toBe('TOO_MANY_DECIMALS');
  });

  it('never rounds', () => {
    // 1.005 in 2 decimals: a rounding implementation would give 100 or 101. We refuse.
    expect(codeOf(() => parseDecimalAmount('1.005', 2))).toBe('TOO_MANY_DECIMALS');
    expect(codeOf(() => parseDecimalAmount('1.999', 2))).toBe('TOO_MANY_DECIMALS');
  });

  it('rejects anything that is not a plain decimal string', () => {
    const bad = [
      '', ' ', '1 ', ' 1', '1 000',
      '-1', '+1', '-0',
      '.5', '5.', '.',
      '1e3', '1E3', '1e-3',
      '1,000', '1,5', '1_000',
      '0x10', '0b1', '0o7',
      'NaN', 'Infinity', 'abc', '1abc',
      '1.2.3', '1..2',
      '١٢', '１２', '1٫5'
    ];
    for (const input of bad) {
      expect(codeOf(() => parseDecimalAmount(input, 6)), JSON.stringify(input)).toBe('INVALID_FORMAT');
    }
  });

  it('rejects non-string input at runtime', () => {
    const inputs: unknown[] = [12.5, 12n, null, undefined, {}, []];
    for (const input of inputs) {
      expect(codeOf(() => parseDecimalAmount(input as string, 2))).toBe('INVALID_FORMAT');
    }
  });

  it('validates decimals before looking at the amount', () => {
    expect(codeOf(() => parseDecimalAmount('1', -1))).toBe('INVALID_DECIMALS');
    expect(codeOf(() => parseDecimalAmount('1', 2.5))).toBe('INVALID_DECIMALS');
  });
});

describe('formatBaseUnits', () => {
  it('renders whole and fractional values, trimming trailing zeros by default', () => {
    expect(formatBaseUnits(0n, 2)).toBe('0');
    expect(formatBaseUnits(100n, 2)).toBe('1');
    expect(formatBaseUnits(1250n, 2)).toBe('12.5');
    expect(formatBaseUnits(1n, 2)).toBe('0.01');
    expect(formatBaseUnits(12_500_000n, 6)).toBe('12.5');
    expect(formatBaseUnits(1n, 6)).toBe('0.000001');
    expect(formatBaseUnits(10_000_000_000_000_000_000n, 18)).toBe('10');
  });

  it('pads every place with fixed: true', () => {
    expect(formatBaseUnits(0n, 2, { fixed: true })).toBe('0.00');
    expect(formatBaseUnits(100n, 2, { fixed: true })).toBe('1.00');
    expect(formatBaseUnits(1250n, 2, { fixed: true })).toBe('12.50');
    expect(formatBaseUnits(1n, 6, { fixed: true })).toBe('0.000001');
    expect(formatBaseUnits(1_000_000n, 6, { fixed: true })).toBe('1.000000');
    expect(formatBaseUnits(7n, 0, { fixed: true })).toBe('7');
  });

  it('handles zero decimals', () => {
    expect(formatBaseUnits(0n, 0)).toBe('0');
    expect(formatBaseUnits(42n, 0)).toBe('42');
  });

  it('handles negative values for differences and refunds', () => {
    expect(formatBaseUnits(-1n, 2)).toBe('-0.01');
    expect(formatBaseUnits(-1250n, 2)).toBe('-12.5');
    expect(formatBaseUnits(-100n, 2, { fixed: true })).toBe('-1.00');
  });

  it('rejects a non-bigint value', () => {
    const values: unknown[] = [1, '1', null, undefined];
    for (const value of values) {
      expect(codeOf(() => formatBaseUnits(value as bigint, 2))).toBe('INVALID_FORMAT');
    }
  });

  it('round-trips with parseDecimalAmount for every value and decimals', () => {
    const decimalsList = [0, 1, 2, 6, 8, 18, 30];
    const values = [
      0n, 1n, 9n, 10n, 99n, 100n, 101n, 999_999n, 1_000_000n,
      123_456_789_123_456_789_123_456_789n,
      BigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      2n ** 128n
    ];
    for (const decimals of decimalsList) {
      for (const value of values) {
        expect(parseDecimalAmount(formatBaseUnits(value, decimals), decimals), `${value} @ ${decimals}`).toBe(value);
        expect(parseDecimalAmount(formatBaseUnits(value, decimals, { fixed: true }), decimals), `${value} @ ${decimals} fixed`).toBe(value);
      }
    }
  });

  it('round-trips pseudo-random values', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x9e3779b9n;
    const next = (): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return seed;
    };
    for (let i = 0; i < 500; i++) {
      const decimals = Number(next() % 25n);
      const value = (next() << 64n) | next();
      expect(parseDecimalAmount(formatBaseUnits(value, decimals), decimals)).toBe(value);
    }
  });
});
