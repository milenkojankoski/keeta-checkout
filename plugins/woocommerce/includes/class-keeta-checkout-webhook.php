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

		switch ( $event_type ) {
			case 'checkout.session.paid':
				self::complete( $order, $session );
				break;

			case 'checkout.session.expired':
			case 'checkout.session.cancelled':
				// Only if it is still awaiting payment. A late `expired` for an
				// order already paid by another route must not cancel it.
				if ( ! $order->is_paid() ) {
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
						'Keeta reported money arriving that could not be matched to this order: a late or duplicate payment. Check /api/payments on the checkout server and refund it.',
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
							__( 'That money is sitting with you and should be refunded.', 'keeta-checkout' )
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

		if ( $order->is_paid() ) {
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
	 * The order id is matched first, then the stored session id is checked, so a
	 * forged `orderId` on a correctly signed event for a different session cannot
	 * complete the wrong order.
	 *
	 * @param array<string,mixed> $session The session view.
	 * @return WC_Order|null
	 */
	private static function find_order( array $session ) {
		$order_id   = (string) ( $session['orderId'] ?? '' );
		$session_id = (string) ( $session['id'] ?? '' );

		if ( '' === $order_id || ! function_exists( 'wc_get_order' ) ) {
			return null;
		}

		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			return null;
		}

		$stored = (string) $order->get_meta( WC_Gateway_Keeta_Checkout::SESSION_META );
		if ( '' !== $stored && $stored !== $session_id ) {
			return null;
		}

		return $order;
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
