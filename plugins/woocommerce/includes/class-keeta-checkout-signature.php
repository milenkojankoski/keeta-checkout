<?php
/**
 * Verifying a webhook signature.
 *
 * This is the security boundary of the plugin: it is what stops anyone who knows
 * the webhook URL from marking orders paid. Like the amount helper, it is
 * dependency-free so it can be unit-tested without WordPress, and it is tested
 * against signatures produced by the server's own TypeScript implementation.
 *
 * Three things here are not negotiable:
 *
 * 1. **The raw body.** The signature covers the exact bytes that were sent. A body
 *    that has been JSON-decoded and re-encoded has different spacing and key order
 *    and will not verify. Callers must pass what arrived.
 * 2. **`hash_equals`.** A `===` comparison on an HMAC leaks, through timing, how
 *    many leading bytes were right.
 * 3. **The timestamp.** It is inside the signed value, so a captured delivery
 *    cannot be replayed with a fresh one, and the tolerance bounds how long a
 *    captured delivery stays useful.
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || defined( 'KEETA_CHECKOUT_TESTING' ) || exit;

/** Raised when a delivery's signature cannot be trusted. */
class Keeta_Checkout_Signature_Exception extends Exception {

	/**
	 * A short machine-readable reason, matching the server's own codes.
	 *
	 * @var string
	 */
	public string $reason;

	/**
	 * @param string $reason  One of MALFORMED_HEADER, NO_SIGNATURES,
	 *                        TIMESTAMP_OUT_OF_TOLERANCE, NO_MATCH.
	 * @param string $message A human-readable explanation.
	 */
	public function __construct( string $reason, string $message ) {
		parent::__construct( $message );
		$this->reason = $reason;
	}
}

/**
 * The `Keeta-Checkout-Signature` scheme.
 */
class Keeta_Checkout_Signature {

	const HEADER            = 'Keeta-Checkout-Signature';
	const SCHEME            = 'v1';
	const DEFAULT_TOLERANCE = 300;

	/**
	 * The exact bytes that are signed: the timestamp, a dot, then the body.
	 *
	 * @param int    $timestamp Unix seconds.
	 * @param string $raw_body  The body as received.
	 * @return string
	 */
	public static function signed_payload( int $timestamp, string $raw_body ): string {
		return $timestamp . '.' . $raw_body;
	}

	/**
	 * Produce a header value. Used by the tests; a plugin never signs anything.
	 *
	 * @param string $raw_body  Body to sign.
	 * @param string $secret    Signing secret.
	 * @param int    $timestamp Unix seconds.
	 * @return string
	 */
	public static function sign( string $raw_body, string $secret, int $timestamp ): string {
		$signature = hash_hmac( 'sha256', self::signed_payload( $timestamp, $raw_body ), $secret );
		return 't=' . $timestamp . ',' . self::SCHEME . '=' . $signature;
	}

	/**
	 * Verify a delivery.
	 *
	 * @param string          $raw_body  The body exactly as received.
	 * @param string|null     $header    The signature header value.
	 * @param string|string[] $secrets   One secret, or several during a rotation.
	 * @param int             $tolerance Seconds of clock difference allowed.
	 * @param int|null        $now       Current Unix seconds; defaults to time().
	 * @return int The signature's timestamp.
	 * @throws Keeta_Checkout_Signature_Exception If it cannot be trusted.
	 */
	public static function verify(
		string $raw_body,
		?string $header,
		$secrets,
		int $tolerance = self::DEFAULT_TOLERANCE,
		?int $now = null
	): int {
		if ( null === $header || '' === trim( $header ) ) {
			throw new Keeta_Checkout_Signature_Exception(
				'MALFORMED_HEADER',
				'the ' . self::HEADER . ' header is missing'
			);
		}

		$parsed     = self::parse_header( $header );
		$timestamp  = $parsed['timestamp'];
		$signatures = $parsed['signatures'];

		$now = null === $now ? time() : $now;
		if ( abs( $now - $timestamp ) > $tolerance ) {
			throw new Keeta_Checkout_Signature_Exception(
				'TIMESTAMP_OUT_OF_TOLERANCE',
				sprintf(
					'the delivery is timestamped %ds away, outside the %ds tolerance',
					abs( $now - $timestamp ),
					$tolerance
				)
			);
		}

		$expected_payload = self::signed_payload( $timestamp, $raw_body );
		$matched          = false;

		// Every candidate is compared even after a match, so the time taken does
		// not reveal which secret or which signature matched.
		foreach ( (array) $secrets as $secret ) {
			if ( ! is_string( $secret ) || '' === $secret ) {
				continue;
			}
			$expected = hash_hmac( 'sha256', $expected_payload, $secret );
			foreach ( $signatures as $candidate ) {
				if ( hash_equals( $expected, $candidate ) ) {
					$matched = true;
				}
			}
		}

		if ( ! $matched ) {
			throw new Keeta_Checkout_Signature_Exception(
				'NO_MATCH',
				'no signature in the header matches the body and secret'
			);
		}

		return $timestamp;
	}

	/**
	 * Split the header into its timestamp and its signatures.
	 *
	 * Unknown keys are ignored, so a future `v2=` scheme alongside `v1=` will not
	 * break a plugin written against v1.
	 *
	 * @param string $header Header value.
	 * @return array{timestamp:int,signatures:string[]}
	 * @throws Keeta_Checkout_Signature_Exception If the header is unusable.
	 */
	private static function parse_header( string $header ): array {
		$timestamp  = null;
		$signatures = array();

		foreach ( explode( ',', $header ) as $part ) {
			$separator = strpos( $part, '=' );
			if ( false === $separator ) {
				continue;
			}
			$key   = trim( substr( $part, 0, $separator ) );
			$value = trim( substr( $part, $separator + 1 ) );

			if ( 't' === $key ) {
				if ( 1 !== preg_match( '/^\d+$/', $value ) ) {
					throw new Keeta_Checkout_Signature_Exception(
						'MALFORMED_HEADER',
						sprintf( 'the timestamp "%s" is not a whole number of seconds', $value )
					);
				}
				$timestamp = (int) $value;
			} elseif ( self::SCHEME === $key ) {
				$signatures[] = $value;
			}
		}

		if ( null === $timestamp ) {
			throw new Keeta_Checkout_Signature_Exception(
				'MALFORMED_HEADER',
				'the ' . self::HEADER . ' header has no t= timestamp'
			);
		}
		if ( array() === $signatures ) {
			throw new Keeta_Checkout_Signature_Exception(
				'NO_SIGNATURES',
				'the ' . self::HEADER . ' header has no ' . self::SCHEME . '= signature'
			);
		}

		return array(
			'timestamp'  => $timestamp,
			'signatures' => $signatures,
		);
	}
}
