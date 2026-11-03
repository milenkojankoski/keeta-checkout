<?php
/**
 * What the Keeta panel on an order shows, decided without WordPress.
 *
 * Given the order's sessions, the payments the checkout server recorded against
 * them, and any refunds, this works out one row per payment: how much it was, what
 * it was, and whether a refund can be requested for it and for how much. The money
 * decisions live here, apart from the screen, so they can be tested without a
 * WordPress install and so the panel and the request handler cannot disagree.
 *
 * The rules mirror the checkout server's own (docs/decisions/0014): a payment that
 * paid the order is not refunded from here; an underpaid, late, duplicate or
 * after-cancelling payment is refunded in full; an overpayment is refunded only by
 * its excess; a payment in a token other than the order's is left for the merchant
 * to return by hand, because the refund float holds only the order's token. One
 * refund per payment: once one exists, its state is shown instead of a button.
 *
 * Labels are returned as codes. The panel translates them.
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || defined( 'KEETA_CHECKOUT_TESTING' ) || exit;

/**
 * Builds the rows of the Keeta panel.
 */
final class Keeta_Checkout_Refund_Rows {

	/** Dispositions refunded in full. The ones an order's session can carry. */
	const REFUNDABLE_IN_FULL = array( 'underpaid', 'late', 'duplicate', 'cancelled' );

	/** Refund states that are still moving, so the panel keeps checking. */
	const PENDING = array( 'requested', 'publishing' );

	/**
	 * One row per payment, oldest first.
	 *
	 * @param array<string,array<string,mixed>> $sessions Merchant session views, keyed by session id.
	 * @param array<int,mixed>                  $payments Payment views from `GET /api/payments`.
	 * @param array<int,mixed>                  $refunds  Refund views from `GET /api/refunds`.
	 * @return array<int,array<string,mixed>>
	 */
	public static function build( array $sessions, array $payments, array $refunds ): array {
		$refund_for = array();
		foreach ( $refunds as $refund ) {
			if ( ! is_array( $refund ) ) {
				continue;
			}
			$key                = self::key( (string) ( $refund['paymentBlockHash'] ?? '' ), (int) ( $refund['paymentOperationIndex'] ?? 0 ) );
			$refund_for[ $key ] = $refund;
		}

		$rows = array();
		$seen = array();
		foreach ( $payments as $payment ) {
			if ( ! is_array( $payment ) ) {
				continue;
			}
			$session_id = (string) ( $payment['sessionId'] ?? '' );
			$session    = $sessions[ $session_id ] ?? null;
			$block_hash = (string) ( $payment['blockHash'] ?? '' );
			$index      = (int) ( $payment['operationIndex'] ?? 0 );
			$key        = self::key( $block_hash, $index );

			// A payment that names none of this order's sessions is not this order's.
			if ( '' === $session_id || ! is_array( $session ) || '' === $block_hash || isset( $seen[ $key ] ) ) {
				continue;
			}
			$seen[ $key ] = true;

			$disposition = (string) ( $payment['disposition'] ?? '' );
			$amount      = (string) ( $payment['amount'] ?? '0' );
			$same_token  = (string) ( $payment['tokenAddress'] ?? '' ) === (string) ( $session['tokenAddress'] ?? '' );

			$row = array(
				'key'               => $key,
				'block_hash'        => $block_hash,
				'operation_index'   => $index,
				'disposition'       => $disposition,
				// Decimals are known only for the session's own token.
				'amount_label'      => $same_token ? self::label( $amount, $session ) : null,
				'amount_base_units' => $amount,
				'payer'             => (string) ( $payment['from'] ?? '' ),
				'explorer_url'      => (string) ( $payment['explorerUrl'] ?? '' ),
				'block_date'        => (string) ( $payment['blockDate'] ?? '' ),
				'refund'            => null,
				'action'            => null,
				'blocked'           => null,
			);

			$refund = $refund_for[ $key ] ?? null;
			if ( is_array( $refund ) ) {
				$row['refund'] = array(
					'id'           => (string) ( $refund['id'] ?? '' ),
					'status'       => (string) ( $refund['status'] ?? '' ),
					'amount_label' => self::refund_label( $refund, $session ),
					'error'        => is_string( $refund['lastError'] ?? null ) ? $refund['lastError'] : null,
					'explorer_url' => is_string( $refund['explorerUrl'] ?? null ) ? $refund['explorerUrl'] : null,
				);
			} elseif ( ! $same_token ) {
				$row['blocked'] = 'other_token';
			} elseif ( 'overpaid' === $disposition ) {
				$excess = (string) ( $session['overpaidBy'] ?? '' );
				if ( 1 === preg_match( '/^\d+$/', $excess ) && '' !== ltrim( $excess, '0' ) ) {
					$row['action'] = array(
						'kind'         => 'excess',
						'amount_label' => self::label( $excess, $session ),
					);
				}
			} elseif ( in_array( $disposition, self::REFUNDABLE_IN_FULL, true ) ) {
				$row['action'] = array(
					'kind'         => 'full',
					'amount_label' => self::label( $amount, $session ),
				);
			} elseif ( 'matched' === $disposition ) {
				$row['blocked'] = 'paid';
			}

			$rows[] = $row;
		}

		// ISO-8601 dates from one source sort correctly as strings.
		usort(
			$rows,
			static fn( array $a, array $b ): int => strcmp( (string) $a['block_date'], (string) $b['block_date'] )
		);

		return $rows;
	}

	/**
	 * The row a refund may be requested for, or null when it may not.
	 *
	 * The request handler rebuilds the rows from the server and asks this, so a
	 * request is honoured only for a payment that is this order's and still shows a
	 * button: not one that was refunded meanwhile, not one from another order.
	 *
	 * @param array<int,array<string,mixed>> $rows            The order's rows.
	 * @param string                         $block_hash      The payment's block.
	 * @param int                            $operation_index Its operation in that block.
	 * @return array<string,mixed>|null
	 */
	public static function find_actionable( array $rows, string $block_hash, int $operation_index ): ?array {
		$key = self::key( $block_hash, $operation_index );
		foreach ( $rows as $row ) {
			if ( ( $row['key'] ?? null ) === $key && null !== ( $row['action'] ?? null ) ) {
				return $row;
			}
		}
		return null;
	}

	/**
	 * Whether any refund on these rows is still on its way.
	 *
	 * @param array<int,array<string,mixed>> $rows The rows.
	 * @return bool
	 */
	public static function has_pending( array $rows ): bool {
		foreach ( $rows as $row ) {
			$status = is_array( $row['refund'] ?? null ) ? (string) ( $row['refund']['status'] ?? '' ) : '';
			if ( in_array( $status, self::PENDING, true ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The network the order was paid on, from its sessions.
	 *
	 * @param array<string,array<string,mixed>> $sessions Session views.
	 * @return string `test`, `main`, or empty.
	 */
	public static function network( array $sessions ): string {
		foreach ( $sessions as $session ) {
			return (string) ( $session['network'] ?? '' );
		}
		return '';
	}

	/**
	 * `0.8 USDC` from base units and the session's token.
	 *
	 * @param string              $base_units Base units.
	 * @param array<string,mixed> $session    The session view.
	 * @return string
	 */
	private static function label( string $base_units, array $session ): string {
		try {
			$amount = Keeta_Checkout_Amount::format_base_units( $base_units, (int) ( $session['tokenDecimals'] ?? 0 ) );
		} catch ( Keeta_Checkout_Amount_Exception $error ) {
			return $base_units;
		}
		return $amount . ' ' . self::ticker( $session['tokenTicker'] ?? null );
	}

	/**
	 * A refund's amount, as the server worded it, or from the session.
	 *
	 * @param array<string,mixed> $refund  The refund view.
	 * @param array<string,mixed> $session The session view.
	 * @return string
	 */
	private static function refund_label( array $refund, array $session ): string {
		$decimal = $refund['amountDecimal'] ?? null;
		if ( is_string( $decimal ) && '' !== $decimal ) {
			return $decimal . ' ' . self::ticker( $refund['tokenTicker'] ?? ( $session['tokenTicker'] ?? null ) );
		}
		return self::label( (string) ( $refund['amount'] ?? '0' ), $session );
	}

	/**
	 * `$USDC` reads as `USDC` beside an amount.
	 *
	 * @param mixed $ticker The resolver's ticker, or null.
	 * @return string
	 */
	private static function ticker( $ticker ): string {
		$plain = is_string( $ticker ) ? ltrim( $ticker, '$' ) : '';
		return '' === $plain ? 'tokens' : $plain;
	}

	/**
	 * The ledger's key for a payment.
	 *
	 * @param string $block_hash      Block hash.
	 * @param int    $operation_index Operation index.
	 * @return string
	 */
	private static function key( string $block_hash, int $operation_index ): string {
		return $block_hash . ':' . $operation_index;
	}
}
