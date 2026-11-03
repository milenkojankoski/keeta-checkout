<?php
/**
 * Receiving webhooks from the checkout server.
 *
 * The route is public, because the checkout server has no WordPress credentials.
 * The signature is what authorises the request, so the first thing this file does
 * is verify it and the second is refuse anything that fails.
 *
 * Four rules the server's own documentation insists on, all honoured here:
 *
 * 1. Verify against the **raw** body. `WP_REST_Request::get_body()` returns what
 *    arrived; `get_json_params()` returns a re-decoded structure that cannot be
 *    verified.
 * 2. Dedupe on `event.id`. Delivery is at-least-once, so a retry after a timeout
 *    must not complete an order twice.
 * 3. Do not trust event order. Each handler decides from the session's own status
 *    in the body, never from what arrived before it.
 * 4. Answer 2xx quickly. Anything else is retried for about 24 hours. A bad
 *    signature answers 400, because retrying will not make it valid.
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * The `/wp-json/keeta-checkout/v1/webhook` endpoint.
 */
class Keeta_Checkout_Webhook {

	const NAMESPACE_V1 = 'keeta-checkout/v1';
	const ROUTE        = '/webhook';

	/** Order meta holding the event ids already handled, so retries are idempotent. */
	const HANDLED_META = '_keeta_checkout_handled_events';

	/** How many event ids to remember per order. Far more than an order will ever see. */
	const HANDLED_LIMIT = 50;

	/** Register the route. Hooked to `rest_api_init`. */
	public static function register_route(): void {
		register_rest_route(
			self::NAMESPACE_V1,
			self::ROUTE,
			array(
				'methods'  => 'POST',
				'callback' => array( __CLASS__, 'handle' ),
				// Public by design: the signature is the credential. WordPress
				// requires an explicit callback, and returning true here is the
				// honest way to say "authorised inside the handler".
				'permission_callback' => '__return_true',
			)
		);
	}

	/** The URL to paste into the checkout server's configuration. */
	public static function url(): string {
		return rest_url( self::NAMESPACE_V1 . self::ROUTE );
	}

	/**
	 * Handle one delivery.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response
	 */
	public static function handle( WP_REST_Request $request ): WP_REST_Response {
		$gateway = self::gateway();
		if ( null === $gateway ) {
			return new WP_REST_Response( array( 'error' => 'the gateway is not configured' ), 503 );
		}

		$secret = (string) $gateway->get_option( 'webhook_secret' );
		if ( '' === $secret ) {
			return new WP_REST_Response( array( 'error' => 'no webhook secret is configured' ), 503 );
		}

		// The body exactly as it arrived. Never `get_json_params()`.
		$raw_body = $request->get_body();

		try {
			Keeta_Checkout_Signature::verify(
				$raw_body,
				$request->get_header( 'keeta_checkout_signature' ),
				$secret
			);
		} catch ( Keeta_Checkout_Signature_Exception $error ) {
			// 400, not 500: a bad signature will never become good, so there is no
			// point in the server retrying it for a day.
			$gateway->log( sprintf( 'rejected a webhook: %s (%s)', $error->getMessage(), $error->reason ) );
			return new WP_REST_Response( array( 'error' => $error->reason ), 400 );
		}

		$event = json_decode( $raw_body, true );
		if ( ! is_array( $event ) || ! isset( $event['id'], $event['type'] ) ) {
			return new WP_REST_Response( array( 'error' => 'the event body is not usable' ), 400 );
		}

		$event_id   = (string) $event['id'];
		$event_type = (string) $event['type'];
		$session    = is_array( $event['data']['session'] ?? null ) ? $event['data']['session'] : null;
		$payment    = is_array( $event['data']['payment'] ?? null ) ? $event['data']['payment'] : null;
		$refund     = is_array( $event['data']['refund'] ?? null ) ? $event['data']['refund'] : null;

		// A refund of a payment on this shop's order: a note on that order, nothing more.
		if ( null !== $refund && 0 === strpos( $event_type, 'refund.' ) ) {
			return self::handle_refund( $gateway, $event_id, $event_type, $refund );
		}

		// A payment that names no session cannot be tied to an order. It still
		// needs a human, so it goes in the log and the server's own ledger holds it.
		if ( null === $session ) {
			if ( null !== $payment ) {
				$gateway->log(
					sprintf(
						'a payment of %s base units from %s was recorded as %s with no order attached; see /api/payments',
						(string) ( $payment['amount'] ?? '?' ),
						(string) ( $payment['from'] ?? '?' ),
						(string) ( $payment['disposition'] ?? '?' )
					)
				);
			}
			return new WP_REST_Response( array( 'received' => true ), 200 );
		}

		$order = self::find_order( $session );
		if ( ! $order instanceof WC_Order ) {
			// Not ours, or deleted. Accept it: retrying will not conjure the order,
			// and a 4xx would have the server retry for a day.
			$gateway->log( sprintf( 'no order matches session %s', (string) ( $session['id'] ?? '?' ) ) );
			return new WP_REST_Response( array( 'received' => true, 'matched' => false ), 200 );
		}

		if ( self::already_handled( $order, $event_id ) ) {
			return new WP_REST_Response( array( 'received' => true, 'duplicate' => true ), 200 );
		}

		self::apply( $gateway, $order, $event_type, $session, $payment );
		self::remember( $order, $event_id );

		return new WP_REST_Response( array( 'received' => true ), 200 );
	}

	/**
	 * Decide what an event means for an order.
	 *
	 * Each case reads the session's own status rather than assuming the event
	 * arrived in order, because retries interleave.
	 *
	 * @param WC_Gateway_Keeta_Checkout $gateway    The gateway, for settings and logging.
	 * @param WC_Order                  $order      The order.
	 * @param string                    $event_type The event type.
	 * @param array<string,mixed>       $session    The session view.
	 * @param array<string,mixed>|null  $payment    The payment view, when present.
	 */
	private static function apply(
		WC_Gateway_Keeta_Checkout $gateway,
		WC_Order $order,
		string $event_type,
		array $session,
		?array $payment
	): void {
		$status = (string) ( $session['status'] ?? '' );

		$current = (string) $order->get_meta( WC_Gateway_Keeta_Checkout::SESSION_META );

		switch ( $event_type ) {
			case 'checkout.session.paid':
				// The type says paid; the session must say so too. Rule 3 above, and
				// a cheap second lock on the one event that moves an order forward.
				if ( 'paid' === $status ) {
					self::complete( $order, $session );
				}
				break;

			case 'checkout.session.expired':
			case 'checkout.session.cancelled':
				// Three things must all be true before an order is cancelled for a
				// request that went unpaid: the request is the one the order
				// currently points at (an older, superseded one expiring says
				// nothing about the newer one), the shopper has not since switched
				// to another payment method, and the order is still waiting.
				if ( $current !== (string) ( $session['id'] ?? '' ) ) {
					break;
				}
				if ( WC_Gateway_Keeta_Checkout::ID !== $order->get_payment_method() ) {
					break;
				}
				if ( ! $order->is_paid() && $order->has_status( array( 'pending', 'on-hold', 'failed' ) ) ) {
					$order->update_status(
						'cancelled',
						sprintf(
							/* translators: %s: the session status. */
							__( 'Keeta payment %s; the request was not paid.', 'keeta-checkout' ),
							$status
						)
					);
				}
				break;

			case 'checkout.session.unmatched':
				$order->add_order_note(
					__(
						'Keeta reported money arriving that could not be matched to this order: a late or duplicate payment. Refund it from the Keeta panel on this order.',
						'keeta-checkout'
					)
				);
				$order->save();
				break;

			case 'checkout.payment.recorded':
				if ( null !== $payment ) {
					$order->add_order_note(
						sprintf(
							/* translators: 1: disposition, 2: amount in base units, 3: payer address, 4: explorer URL. */
							__( 'Keeta recorded a payment as %1$s: %2$s base units from %3$s. %4$s', 'keeta-checkout' ),
							(string) ( $payment['disposition'] ?? '?' ),
							(string) ( $payment['amount'] ?? '?' ),
							(string) ( $payment['from'] ?? '?' ),
							(string) ( $payment['explorerUrl'] ?? '' )
						)
					);
					if ( true === ( $payment['refundable'] ?? false ) ) {
						$order->add_order_note(
							__( 'That money is sitting with you and should go back: use the Keeta panel on this order.', 'keeta-checkout' )
						);
					}
					$order->save();
				}
				break;

			default:
				// An unknown type is a newer checkout server, not an error.
				$gateway->log( sprintf( 'ignoring unknown event type %s', $event_type ) );
		}
	}

	/**
	 * Mark an order paid.
	 *
	 * `payment_complete()` is WooCommerce's own entry point for this: it reduces
	 * stock, empties the cart, moves the order to processing or completed per the
	 * product type, and is itself guarded against running twice.
	 *
	 * @param WC_Order            $order   The order.
	 * @param array<string,mixed> $session The session view.
	 */
	public static function complete( WC_Order $order, array $session ): void {
		$block_hash = (string) ( $session['blockHash'] ?? '' );
		$session_id = (string) ( $session['id'] ?? '' );

		if ( $order->is_paid() ) {
			// Paid already. If this is a different block, the shopper has paid twice
			// (two requests for one order, both settled) and one of them must go back.
			if ( '' !== $block_hash && $block_hash !== (string) $order->get_transaction_id() ) {
				$order->add_order_note(
					sprintf(
						/* translators: 1: session id, 2: amount, 3: token, 4: explorer URL. */
						__( 'A second Keeta payment settled for this order (session %1$s): %2$s %3$s. The customer paid twice; refund one. %4$s', 'keeta-checkout' ),
						$session_id,
						(string) ( $session['amountDecimal'] ?? '?' ),
						(string) ( $session['tokenTicker'] ?? '' ),
						(string) ( $session['explorerUrl'] ?? '' )
					)
				);
				$order->save();
			}
			return;
		}

		// The request was priced from the order total when it was created. If the
		// total has changed since (an edit in the admin, a coupon, a superseded
		// request that could not be cancelled), the old amount is not payment in
		// full, and the order waits for a person rather than completing.
		$requested = (string) ( $session['amountDecimal'] ?? '' );
		try {
			$total = Keeta_Checkout_Amount::normalise( $order->get_total() );
		} catch ( Keeta_Checkout_Amount_Exception $error ) {
			$total = '';
		}
		if ( '' === $requested || '' === $total || ! Keeta_Checkout_Amount::equal( $requested, $total ) ) {
			$order->update_status(
				'on-hold',
				sprintf(
					/* translators: 1: paid amount, 2: token, 3: order total, 4: session id, 5: explorer URL. */
					__( 'A Keeta payment of %1$s %2$s settled, but the order total is now %3$s (session %4$s). Not marked paid; please review. %5$s', 'keeta-checkout' ),
					$requested,
					(string) ( $session['tokenTicker'] ?? '' ),
					$total,
					$session_id,
					(string) ( $session['explorerUrl'] ?? '' )
				)
			);
			return;
		}

		$order->add_order_note(
			sprintf(
				/* translators: 1: amount, 2: token, 3: payer, 4: explorer URL. */
				__( 'Keeta payment settled: %1$s %2$s from %3$s. %4$s', 'keeta-checkout' ),
				(string) ( $session['amountDecimal'] ?? '?' ),
				(string) ( $session['tokenTicker'] ?? '' ),
				(string) ( $session['paidBy'] ?? '?' ),
				(string) ( $session['explorerUrl'] ?? '' )
			)
		);

		$overpaid = $session['overpaidBy'] ?? null;
		if ( null !== $overpaid && '0' !== (string) $overpaid ) {
			$order->add_order_note(
				sprintf(
					/* translators: %s: the excess in base units. */
					__( 'The customer overpaid by %s base units. Consider refunding the difference.', 'keeta-checkout' ),
					(string) $overpaid
				)
			);
		}

		// The block hash is the on-chain transaction, and what a merchant would
		// paste into an explorer to audit this order.
		$order->payment_complete( $block_hash );
	}

	/**
	 * Find the order an event is about.
	 *
	 * The order id names the candidate; the session id has to be one the order
	 * actually created. Any of them, not only the current one: a request the order
	 * no longer points at can still be paid by a shopper who kept the first tab
	 * open, and that payment is this order's money. An order with no Keeta session
	 * at all is never matched, however it is named, so a signed event can never
	 * touch an order that went through another gateway.
	 *
	 * @param array<string,mixed> $session The session view.
	 * @return WC_Order|null
	 */
	private static function find_order( array $session ) {
		$order_id   = (string) ( $session['orderId'] ?? '' );
		$session_id = (string) ( $session['id'] ?? '' );

		if ( '' === $order_id || '' === $session_id || ! function_exists( 'wc_get_order' ) ) {
			return null;
		}

		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			return null;
		}

		return in_array( $session_id, self::order_session_ids( $order ), true ) ? $order : null;
	}

	/**
	 * Every Keeta session an order has had, current one included.
	 *
	 * @param WC_Order $order The order.
	 * @return string[]
	 */
	public static function order_session_ids( WC_Order $order ): array {
		$known   = $order->get_meta( WC_Gateway_Keeta_Checkout::SESSIONS_META );
		$known   = is_array( $known ) ? $known : array();
		$current = (string) $order->get_meta( WC_Gateway_Keeta_Checkout::SESSION_META );
		if ( '' !== $current ) {
			$known[] = $current;
		}
		$ids = array();
		foreach ( $known as $id ) {
			if ( is_string( $id ) && '' !== $id && ! in_array( $id, $ids, true ) ) {
				$ids[] = $id;
			}
		}
		return $ids;
	}

	/**
	 * A `refund.*` event: a note on the order the refunded payment belongs to.
	 *
	 * Never changes the order's status or records a WooCommerce refund. The money
	 * going back is a second payment, a shortfall, or an excess, none of which was
	 * part of the order total; booking it against the order would make a paid order
	 * look partly refunded.
	 *
	 * @param WC_Gateway_Keeta_Checkout $gateway    The gateway, for logging.
	 * @param string                    $event_id   The event id.
	 * @param string                    $event_type The event type.
	 * @param array<string,mixed>       $refund     The refund view.
	 * @return WP_REST_Response
	 */
	private static function handle_refund( WC_Gateway_Keeta_Checkout $gateway, string $event_id, string $event_type, array $refund ): WP_REST_Response {
		$order_id   = (string) ( $refund['orderId'] ?? '' );
		$session_id = (string) ( $refund['sessionId'] ?? '' );
		$refund_id  = (string) ( $refund['id'] ?? '?' );

		if ( '' === $order_id || '' === $session_id || ! function_exists( 'wc_get_order' ) ) {
			$gateway->log( sprintf( 'refund %s is not for a payment on an order; nothing to note', $refund_id ) );
			return new WP_REST_Response( array( 'received' => true ), 200 );
		}

		// As with payments: only an order that created this session may be written to.
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || ! in_array( $session_id, self::order_session_ids( $order ), true ) ) {
			$gateway->log( sprintf( 'refund %s names order %s, which did not create session %s', $refund_id, $order_id, $session_id ) );
			return new WP_REST_Response( array( 'received' => true, 'matched' => false ), 200 );
		}

		if ( self::already_handled( $order, $event_id ) ) {
			return new WP_REST_Response( array( 'received' => true, 'duplicate' => true ), 200 );
		}

		$amount = self::refund_amount( $refund );
		$to     = (string) ( $refund['to'] ?? '?' );
		$error  = is_string( $refund['lastError'] ?? null ) ? $refund['lastError'] : '';
		$note   = null;

		switch ( $event_type ) {
			case 'refund.requested':
				$note = 'auto' === ( $refund['origin'] ?? '' )
					/* translators: 1: amount, 2: payer address. */
					? sprintf( __( 'Keeta is refunding %1$s to %2$s automatically: it was paid twice.', 'keeta-checkout' ), $amount, $to )
					/* translators: 1: amount, 2: payer address. */
					: sprintf( __( 'Keeta refund of %1$s to %2$s requested.', 'keeta-checkout' ), $amount, $to );
				break;
			case 'refund.published':
				/* translators: 1: amount, 2: payer address, 3: explorer URL. */
				$note = sprintf( __( 'Keeta refund sent: %1$s back to %2$s. %3$s', 'keeta-checkout' ), $amount, $to, (string) ( $refund['explorerUrl'] ?? '' ) );
				break;
			case 'refund.failed':
				/* translators: 1: amount, 2: reason. */
				$note = sprintf( __( 'Keeta refund of %1$s failed: %2$s. The money is still in your refund float; return it from your wallet.', 'keeta-checkout' ), $amount, $error );
				break;
			case 'refund.refused':
				/* translators: 1: amount, 2: reason. */
				$note = sprintf( __( 'Keeta refund of %1$s was not sent: %2$s. Return it from your wallet.', 'keeta-checkout' ), $amount, $error );
				break;
			default:
				$gateway->log( sprintf( 'ignoring unknown refund event %s', $event_type ) );
		}

		if ( null !== $note ) {
			$order->add_order_note( trim( $note ) );
		}
		self::remember( $order, $event_id );

		return new WP_REST_Response( array( 'received' => true ), 200 );
	}

	/**
	 * `0.8 USDC`, or base units when the server could not say what the token is.
	 *
	 * @param array<string,mixed> $refund The refund view.
	 * @return string
	 */
	private static function refund_amount( array $refund ): string {
		$decimal = $refund['amountDecimal'] ?? null;
		if ( is_string( $decimal ) && '' !== $decimal ) {
			$ticker = is_string( $refund['tokenTicker'] ?? null ) ? ltrim( $refund['tokenTicker'], '$' ) : '';
			return trim( $decimal . ' ' . $ticker );
		}
		/* translators: %s: an amount in base units. */
		return sprintf( __( '%s base units', 'keeta-checkout' ), (string) ( $refund['amount'] ?? '?' ) );
	}

	/**
	 * Has this event already been applied to this order?
	 *
	 * @param WC_Order $order    The order.
	 * @param string   $event_id The event id.
	 * @return bool
	 */
	private static function already_handled( WC_Order $order, string $event_id ): bool {
		$handled = $order->get_meta( self::HANDLED_META );
		return is_array( $handled ) && in_array( $event_id, $handled, true );
	}

	/**
	 * Record that an event has been applied.
	 *
	 * @param WC_Order $order    The order.
	 * @param string   $event_id The event id.
	 */
	private static function remember( WC_Order $order, string $event_id ): void {
		$handled = $order->get_meta( self::HANDLED_META );
		$handled = is_array( $handled ) ? $handled : array();

		$handled[] = $event_id;
		if ( count( $handled ) > self::HANDLED_LIMIT ) {
			$handled = array_slice( $handled, -self::HANDLED_LIMIT );
		}

		$order->update_meta_data( self::HANDLED_META, $handled );
		$order->save();
	}

	/**
	 * The configured gateway instance, or null when it is unavailable.
	 *
	 * @return WC_Gateway_Keeta_Checkout|null
	 */
	private static function gateway() {
		if ( ! function_exists( 'WC' ) || null === WC()->payment_gateways() ) {
			return null;
		}
		$gateways = WC()->payment_gateways()->payment_gateways();
		$gateway  = $gateways[ WC_Gateway_Keeta_Checkout::ID ] ?? null;

		return $gateway instanceof WC_Gateway_Keeta_Checkout ? $gateway : null;
	}
}
