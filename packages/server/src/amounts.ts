/**
 * Money math for Keeta Checkout.
 *
 * Every amount inside the server is a `bigint` in a token's base units. Decimal
 * strings exist only at the API boundary, and this module is the only place they
 * are converted. Nothing here uses `Number` for a value: a token with 18 decimals
 * (KTA) overflows `Number.MAX_SAFE_INTEGER` at about 0.009 whole units.
 *
 * Conversion is exact or it fails. There is no rounding anywhere in this file, so a
 * price that cannot be represented in a token's base units is rejected rather than
 * silently changed.
 */

export type AmountErrorCode =
  | 'INVALID_DECIMALS'
  | 'INVALID_FORMAT'
  | 'TOO_MANY_DECIMALS';

export class AmountError extends Error {
  override readonly name = 'AmountError';

  constructor(
    readonly code: AmountErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * The widest `decimalPlaces` Keeta's anchor SDK accepts in token metadata.
 * Mirrors `parseDecimalPlaces` in `@keetanetwork/anchor/lib/token-metadata`.
 */
export const MAX_DECIMALS = 1024;

/** Reject anything that is not a whole number of decimal places in Keeta's range. */
export function assertDecimals(decimals: unknown): asserts decimals is number {
  if (
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_DECIMALS
  ) {
    throw new AmountError(
      'INVALID_DECIMALS',
      `decimals must be an integer from 0 to ${MAX_DECIMALS}, got ${String(decimals)}`
    );
  }
}

/**
 * Exactly what a decimal amount may look like: ASCII digits, optionally one dot
 * and more ASCII digits. No sign, no exponent, no separators, no whitespace, and
 * digits on both sides of the dot. Unicode digits are not digits here.
 */
const DECIMAL_AMOUNT = /^([0-9]+)(?:\.([0-9]+))?$/;

/**
 * Convert a decimal string such as `"12.50"` into base units for a token with the
 * given number of decimals.
 *
 * - `"12.50"` with 2 decimals is `1250n`; with 6 decimals it is `12_500_000n`.
 * - Leading zeros are fine: `"007.5"` is `7.5`.
 * - Excess fraction digits are allowed only when they are all zeros, because the
 *   value is still exact: `"1.500"` with 2 decimals is `150n`, but `"1.505"` is an
 *   error. Nothing is ever rounded.
 * - `"0"` and `"0.00"` return `0n`. Whether zero is an acceptable amount is the
 *   caller's decision, not this function's.
 *
 * Throws {@link AmountError} with `INVALID_FORMAT` or `TOO_MANY_DECIMALS`.
 */
export function parseDecimalAmount(input: string, decimals: number): bigint {
  assertDecimals(decimals);

  if (typeof input !== 'string') {
    throw new AmountError('INVALID_FORMAT', `amount must be a string, got ${typeof input}`);
  }

  const match = DECIMAL_AMOUNT.exec(input);
  if (match === null) {
    throw new AmountError(
      'INVALID_FORMAT',
      `amount "${input}" is not a plain decimal number (digits, optionally a dot and more digits)`
    );
  }

  const whole = match[1] ?? '';
  let fraction = match[2] ?? '';

  if (fraction.length > decimals) {
    const excess = fraction.slice(decimals);
    if (/[^0]/.test(excess)) {
      throw new AmountError(
        'TOO_MANY_DECIMALS',
        `amount "${input}" has ${fraction.length} decimal places but the token allows ${decimals}`
      );
    }
    fraction = fraction.slice(0, decimals);
  }

  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

export interface FormatOptions {
  /**
   * Always show every decimal place, so `1n` with 6 decimals is `"0.000001"` and
   * `1_000_000n` is `"1.000000"`. Default: trailing zeros are trimmed and a whole
   * number has no dot, so the same values are `"0.000001"` and `"1"`.
   */
  fixed?: boolean;
}

/**
 * Render base units as a decimal string. The inverse of {@link parseDecimalAmount}:
 * `parseDecimalAmount(formatBaseUnits(v, d), d) === v` for every `v` and `d`.
 *
 * Negative values are supported, for differences and refunds. The result is always
 * parseable by `parseDecimalAmount` once a leading `-` is removed.
 */
export function formatBaseUnits(value: bigint, decimals: number, options: FormatOptions = {}): string {
  assertDecimals(decimals);

  if (typeof value !== 'bigint') {
    throw new AmountError('INVALID_FORMAT', `value must be a bigint, got ${typeof value}`);
  }

  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);

  if (!options.fixed) {
    fraction = fraction.replace(/0+$/, '');
  }

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
