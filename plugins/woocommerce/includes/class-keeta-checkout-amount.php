<?php
/**
 * Turning a WooCommerce total into the string the checkout server expects.
 *
 * Deliberately dependency-free: no WordPress, no WooCommerce, nothing to mock. It
 * is unit-tested on its own, because this is the one place in the plugin where a
 * mistake changes what a customer is charged.
 *
 * Nothing here rounds. WooCommerce's own formatting helpers take a decimal-places
 * argument and will happily round to it, and rounding the amount somebody owes is
 * not a formatting decision. If a total cannot be represented exactly, the server
 * refuses it and the customer sees an error, which is the correct outcome.
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || defined( 'KEETA_CHECKOUT_TESTING' ) || exit;

/** Raised when a total cannot be expressed as a plain decimal amount. */
class Keeta_Checkout_Amount_Exception extends Exception {}

/**
 * Normalises an amount into the exact grammar the checkout API accepts.
 */
class Keeta_Checkout_Amount {

	/**
	 * What the server's parser accepts: digits, optionally a dot and more digits.
	 * No sign, no exponent, no thousands separator.
	 */
	const PATTERN = '/^\d+(\.\d+)?$/';

	/**
	 * Normalise a WooCommerce total for `POST /api/sessions`.
	 *
	 * Handles the shapes a WooCommerce install actually produces:
	 *
	 * - `"12.50"`, the ordinary case, passed through unchanged.
	 * - `"12,50"`, from a store configured with a comma decimal separator.
	 * - `"1 234.50"` or `"1,234.50"`, with a thousands separator. Both separators
	 *   present means the last one is the decimal point.
	 * - `12.5` as a float, which PHP may hand over; rendered without an exponent.
	 * - `".5"` and `"12."`, which the server's grammar rejects, so they are
	 *   completed to `"0.5"` and `"12"` here.
	 *
	 * @param string|int|float $total The order total.
	 * @return string A plain decimal string.
	 * @throws Keeta_Checkout_Amount_Exception If the value is not a usable amount.
	 */
	public static function normalise( $total ): string {
		if ( is_int( $total ) ) {
			// Through the same checks as everything else, so a zero total is
			// rejected here too rather than slipping past on its type.
			$total = (string) $total;
		}

		if ( is_float( $total ) ) {
			if ( ! is_finite( $total ) ) {
				throw new Keeta_Checkout_Amount_Exception( 'the total is not a finite number' );
			}
			// `%.10F` avoids scientific notation, which the server's grammar rejects.
			$total = rtrim( rtrim( sprintf( '%.10F', $total ), '0' ), '.' );
			if ( '' === $total || '-' === $total ) {
				$total = '0';
			}
		}

		if ( ! is_string( $total ) ) {
			throw new Keeta_Checkout_Amount_Exception( 'the total must be a string or a number' );
		}

		$value = trim( $total );
		if ( '' === $value ) {
			throw new Keeta_Checkout_Amount_Exception( 'the total is empty' );
		}

		// Currency symbols and every kind of space, in case a formatted value arrives.
		$value = preg_replace( '/[\s\x{00A0}\x{202F}]/u', '', $value ) ?? '';
		$value = str_replace( array( '€', '$', '£' ), '', $value );

		if ( '' === $value ) {
			throw new Keeta_Checkout_Amount_Exception( 'the total has no digits' );
		}

		// A leading `+` is harmless; a negative total is not an amount to charge.
		if ( str_starts_with( $value, '+' ) ) {
			$value = substr( $value, 1 );
		}
		if ( str_starts_with( $value, '-' ) ) {
			throw new Keeta_Checkout_Amount_Exception( 'the total is negative' );
		}

		$resolved = self::resolve_separators( $value );
		if ( null === $resolved ) {
			throw new Keeta_Checkout_Amount_Exception(
				sprintf( 'the total %s is not an unambiguous decimal amount', wp_json_encode_safe( $total ) )
			);
		}
		$value = $resolved;

		if ( 1 !== preg_match( self::PATTERN, $value ) ) {
			throw new Keeta_Checkout_Amount_Exception(
				sprintf( 'the total %s is not a plain decimal amount', wp_json_encode_safe( $total ) )
			);
		}

		if ( ! self::has_nonzero_digit( $value ) ) {
			throw new Keeta_Checkout_Amount_Exception( 'the total is zero' );
		}

		return $value;
	}

	/**
	 * Work out which of `.` and `,` is the decimal point, and drop the other.
	 *
	 * Returns `null` rather than guessing whenever the answer is not certain, which
	 * matters more than convenience here. An earlier version stripped any repeated
	 * separator as grouping, which turned the nonsense `1.2.3` into `123` and would
	 * have charged a customer a hundred times the right amount. Grouping now has to
	 * be shaped like grouping, and a genuinely ambiguous value is refused.
	 *
	 * @param string $value A numeric string with no spaces or symbols.
	 * @return string|null The amount using `.` only, or null if it cannot be trusted.
	 */
	private static function resolve_separators( string $value ): ?string {
		$has_dot   = str_contains( $value, '.' );
		$has_comma = str_contains( $value, ',' );

		if ( ! $has_dot && ! $has_comma ) {
			return 1 === preg_match( '/^\d+$/', $value ) ? $value : null;
		}

		// Both present: the rightmost is the decimal point, and the other has to
		// form well-shaped grouping. `1,234.50` and `1.234,50` are one amount.
		if ( $has_dot && $has_comma ) {
			$decimal = strrpos( $value, '.' ) > strrpos( $value, ',' ) ? '.' : ',';
			$group   = '.' === $decimal ? ',' : '.';
			return self::join( $value, $decimal, $group );
		}

		$separator = $has_dot ? '.' : ',';

		// More than one of a single kind can only be grouping.
		if ( substr_count( $value, $separator ) > 1 ) {
			return self::strip_grouping( $value, $separator );
		}

		// Exactly one separator. A comma with exactly three digits after it is
		// genuinely ambiguous: `1,234` is either one thousand two hundred and
		// thirty-four, or one and two hundred thirty-four thousandths. Refusing is
		// the only safe answer.
		$position = (int) strpos( $value, $separator );
		$integer  = substr( $value, 0, $position );
		$fraction = substr( $value, $position + 1 );

		if ( ',' === $separator && 3 === strlen( $fraction ) && '' !== $integer ) {
			return null;
		}

		return self::join( $value, $separator, null );
	}

	/**
	 * Split on the decimal separator, strip grouping from the integer part, and
	 * reassemble with a dot.
	 *
	 * @param string      $value   The numeric string.
	 * @param string      $decimal The decimal separator.
	 * @param string|null $group   The grouping separator, if there is one.
	 * @return string|null
	 */
	private static function join( string $value, string $decimal, ?string $group ): ?string {
		$position = (int) strrpos( $value, $decimal );
		$integer  = substr( $value, 0, $position );
		$fraction = substr( $value, $position + 1 );

		if ( '' !== $fraction && 1 !== preg_match( '/^\d+$/', $fraction ) ) {
			return null;
		}

		if ( null !== $group ) {
			$integer = self::strip_grouping( $integer, $group );
			if ( null === $integer ) {
				return null;
			}
		} elseif ( '' !== $integer && 1 !== preg_match( '/^\d+$/', $integer ) ) {
			return null;
		}

		// A leading or trailing separator is meaningful to a human but not to the
		// server's grammar, so complete it here.
		if ( '' === $integer ) {
			$integer = '0';
		}
		if ( '' === $fraction ) {
			return $integer;
		}

		return $integer . '.' . $fraction;
	}

	/**
	 * Remove a grouping separator, but only from something actually shaped like a
	 * grouped number: one to three digits, then groups of exactly three.
	 *
	 * @param string $integer The integer part.
	 * @param string $group   The grouping separator.
	 * @return string|null The digits, or null if the shape is wrong.
	 */
	private static function strip_grouping( string $integer, string $group ): ?string {
		if ( ! str_contains( $integer, $group ) ) {
			return 1 === preg_match( '/^\d+$/', $integer ) ? $integer : null;
		}

		$pattern = '/^\d{1,3}(' . preg_quote( $group, '/' ) . '\d{3})+$/';
		return 1 === preg_match( $pattern, $integer ) ? str_replace( $group, '', $integer ) : null;
	}

	/**
	 * Whether the amount is more than zero.
	 *
	 * @param string $value A validated decimal string.
	 * @return bool
	 */
	private static function has_nonzero_digit( string $value ): bool {
		return 1 === preg_match( '/[1-9]/', $value );
	}

	/**
	 * Tokens that are plausibly worth the same as a given store currency.
	 *
	 * The checkout server performs **no** conversion: it charges the number given
	 * in the token given. Pricing a EUR order in a dollar token would undercharge
	 * or overcharge by the exchange rate, so the gateway warns when the pairing
	 * looks wrong. It warns rather than blocks, because a merchant may genuinely
	 * intend to treat a stablecoin as 1:1 with their currency.
	 *
	 * @param string $currency A three-letter store currency code.
	 * @return string[] Token identifiers that match it.
	 */
	public static function tokens_for_currency( string $currency ): array {
		$map = array(
			'EUR' => array( '$EURC', '$KEUR', '$KBEUR', 'EUR' ),
			'USD' => array( '$USDC', '$KUSD', '$KBUSD', '$RUSD', 'USD' ),
			'GBP' => array( '$KGBP', '$KBGBP', 'GBP' ),
			'JPY' => array( '$KJPY', '$KBJPY', 'JPY' ),
			'CAD' => array( '$KCAD', '$KBCAD', 'CAD' ),
			'MXN' => array( '$KMXN', '$KBMXN', 'MXN' ),
			'AED' => array( '$KAED', '$KBAED', 'AED' ),
			'HKD' => array( '$KHKD', 'HKD' ),
			'CNY' => array( '$KCNY', 'CNY' ),
		);

		return $map[ strtoupper( $currency ) ] ?? array();
	}

	/**
	 * Whether a token is a plausible pairing for a store currency.
	 *
	 * An unknown currency returns true: there is nothing to compare against, and a
	 * warning the merchant cannot act on is just noise.
	 *
	 * @param string $currency Store currency code.
	 * @param string $token    Configured Keeta token.
	 * @return bool
	 */
	public static function currency_matches_token( string $currency, string $token ): bool {
		$known = self::tokens_for_currency( $currency );
		if ( array() === $known ) {
			return true;
		}

		$wanted = strtoupper( ltrim( trim( $token ), '$' ) );
		foreach ( $known as $candidate ) {
			if ( strtoupper( ltrim( $candidate, '$' ) ) === $wanted ) {
				return true;
			}
		}
		return false;
	}
}

/**
 * `wp_json_encode` is unavailable outside WordPress, and this file is unit-tested
 * without it. Only ever used to quote a value into an error message.
 *
 * @param mixed $value Anything.
 * @return string
 */
function wp_json_encode_safe( $value ): string {
	if ( function_exists( 'wp_json_encode' ) ) {
		$encoded = wp_json_encode( $value );
		return false === $encoded ? '(unencodable)' : $encoded;
	}
	$encoded = json_encode( $value );
	return false === $encoded ? '(unencodable)' : $encoded;
}
