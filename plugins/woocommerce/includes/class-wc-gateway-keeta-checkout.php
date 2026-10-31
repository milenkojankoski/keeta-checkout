<?php
/**
 * The WooCommerce payment gateway.
 *
 * The flow is a redirect: `process_payment()` creates a session on the checkout
 * server and sends the customer to its hosted pay page, and the webhook completes
 * the order. The customer's browser is never trusted to confirm a payment, because
 * a browser can be closed, scripted, or lied to.
 *
 * One trap this gateway guards against: the checkout server performs **no**
 * currency conversion. It charges the number it is given, in the token it is given.
 * Pricing a EUR order in a dollar token would charge the wrong amount by the
 * exchange rate, so the settings screen checks the pairing and says so.
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * Keeta Checkout, as a WooCommerce gateway.
 */
class WC_Gateway_Keeta_Checkout extends WC_Payment_Gateway {

	const ID = 'keeta_checkout';

	/** Order meta: the checkout session this order belongs to. */
	const SESSION_META = '_keeta_checkout_session_id';

	/** Order meta: the pay page the customer was sent to. */
	const PAY_URL_META = '_keeta_checkout_pay_url';

	/** @var WC_Logger|null Lazily created. */
	private $logger = null;

	public function __construct() {
		$this->id                 = self::ID;
		$this->method_title       = __( 'Keeta Checkout', 'keeta-checkout' );
		$this->method_description = __(
			'Accept Keeta payments. Money settles directly to your own Keeta account in about 400 ms, with no processor fee. The checkout server holds no key and cannot move your funds.',
			'keeta-checkout'
		);
		$this->has_fields         = false;
		$this->supports           = array( 'products' );
		$this->icon               = '';

		$this->init_form_fields();
		$this->init_settings();

		$this->title       = (string) $this->get_option( 'title' );
		$this->description = (string) $this->get_option( 'description' );
		$this->enabled     = (string) $this->get_option( 'enabled' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		add_action( 'woocommerce_thankyou_' . $this->id, array( $this, 'maybe_sync_on_return' ) );
	}

	/** The settings screen. */
	public function init_form_fields(): void {
		$this->form_fields = array(
			'enabled'        => array(
				'title'   => __( 'Enable/Disable', 'keeta-checkout' ),
				'type'    => 'checkbox',
				'label'   => __( 'Enable Keeta Checkout', 'keeta-checkout' ),
				'default' => 'no',
			),
			'title'          => array(
				'title'       => __( 'Title', 'keeta-checkout' ),
				'type'        => 'text',
				'description' => __( 'What the customer sees at checkout.', 'keeta-checkout' ),
				'default'     => __( 'Pay with Keeta', 'keeta-checkout' ),
				'desc_tip'    => true,
			),
			'description'    => array(
				'title'       => __( 'Description', 'keeta-checkout' ),
				'type'        => 'textarea',
				'default'     => __( 'Pay from your Keeta wallet. Settles in about a second.', 'keeta-checkout' ),
			),
			'server_section' => array(
				'title'       => __( 'Your checkout server', 'keeta-checkout' ),
				'type'        => 'title',
				'description' => sprintf(
					/* translators: %s: the webhook URL for this site. */
					__( 'Run the server with <code>keeta-checkout serve</code>, then point it back here. Its webhook URL for this site is <code>%s</code>', 'keeta-checkout' ),
					esc_html( Keeta_Checkout_Webhook::url() )
				),
			),
			'server_url'     => array(
				'title'       => __( 'Server URL', 'keeta-checkout' ),
				'type'        => 'text',
				'placeholder' => 'https://pay.your-shop.example',
				'description' => __( 'Where your Keeta Checkout server is reachable from this site.', 'keeta-checkout' ),
				'desc_tip'    => true,
			),
			'api_key'        => array(
				'title'       => __( 'API key', 'keeta-checkout' ),
				'type'        => 'password',
				'description' => __( 'From KEETA_CHECKOUT_API_KEYS. It can create and read sessions; it cannot move money.', 'keeta-checkout' ),
				'desc_tip'    => true,
			),
			'webhook_secret' => array(
				'title'       => __( 'Webhook signing secret', 'keeta-checkout' ),
				'type'        => 'password',
				'description' => __( 'The secret you configured for this endpoint, starting whsec_. Without it, webhooks are rejected.', 'keeta-checkout' ),
				'desc_tip'    => true,
			),
			'token'          => array(
				'title'       => __( 'Token', 'keeta-checkout' ),
				'type'        => 'text',
				'default'     => '$USDC',
				'description' => sprintf(
					/* translators: %s: the store's currency code. */
					__( 'The Keeta token to charge in. No conversion is performed: an order of 12.50 %s is charged as 12.50 of this token, so it must be worth the same.', 'keeta-checkout' ),
					esc_html( get_woocommerce_currency() )
				),
			),
			'expires_in'     => array(
				'title'             => __( 'Session lifetime, in seconds', 'keeta-checkout' ),
				'type'              => 'number',
				'default'           => '1800',
				'description'       => __( 'How long the customer has to pay before the request expires.', 'keeta-checkout' ),
				'desc_tip'          => true,
				'custom_attributes' => array(
					'min' => '60',
					'max' => '86400',
				),
			),
			'debug'          => array(
				'title'       => __( 'Logging', 'keeta-checkout' ),
				'type'        => 'checkbox',
				'label'       => __( 'Log to WooCommerce → Status → Logs', 'keeta-checkout' ),
				'default'     => 'no',
				'description' => __( 'Records requests and rejected webhooks. Never records your keys.', 'keeta-checkout' ),
				'desc_tip'    => true,
			),
		);
	}

	/**
	 * Offer the method only when it can actually work.
	 *
	 * A payment method that appears at checkout and then errors is worse than one
	 * that is not offered.
	 */
	public function is_available(): bool {
		if ( 'yes' !== $this->enabled ) {
			return false;
		}
		return '' !== trim( (string) $this->get_option( 'server_url' ) )
			&& '' !== trim( (string) $this->get_option( 'api_key' ) );
	}

	/**
	 * Warn about a configuration that will take the wrong amount, or no amount.
	 *
	 * Shown above the settings, where a merchant can act on it.
	 */
	public function admin_options(): void {
		$currency = get_woocommerce_currency();
		$token    = (string) $this->get_option( 'token' );

		if ( '' !== $token && ! Keeta_Checkout_Amount::currency_matches_token( $currency, $token ) ) {
			$expected = Keeta_Checkout_Amount::tokens_for_currency( $currency );
			echo '<div class="notice notice-warning inline"><p><strong>';
			esc_html_e( 'The token and your store currency do not match.', 'keeta-checkout' );
			echo '</strong> ';
			printf(
				/* translators: 1: store currency, 2: configured token, 3: suggested tokens. */
				esc_html__( 'Your store prices in %1$s but this gateway charges in %2$s, and no conversion is performed, so customers would be charged the wrong amount. For %1$s, use one of: %3$s.', 'keeta-checkout' ),
				esc_html( $currency ),
				esc_html( $token ),
				esc_html( implode( ', ', $expected ) )
			);
			echo '</p></div>';
		}

		if ( '' === trim( (string) $this->get_option( 'webhook_secret' ) ) ) {
			echo '<div class="notice notice-warning inline"><p><strong>';
			esc_html_e( 'No webhook secret is set.', 'keeta-checkout' );
			echo '</strong> ';
			esc_html_e( 'Orders will not be marked paid automatically until you add it.', 'keeta-checkout' );
			echo '</p></div>';
		}

		parent::admin_options();
	}

	/**
	 * Create a session and send the customer to it.
	 *
	 * @param int $order_id The order.
	 * @return array<string,string>|void A WooCommerce redirect result.
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			wc_add_notice( __( 'That order could not be found.', 'keeta-checkout' ), 'error' );
			return;
		}

		try {
			$amount = Keeta_Checkout_Amount::normalise( $order->get_total() );
		} catch ( Keeta_Checkout_Amount_Exception $error ) {
			$this->log( sprintf( 'order %d: %s', $order->get_id(), $error->getMessage() ) );
			wc_add_notice( __( 'This order total cannot be paid with Keeta. Please choose another payment method.', 'keeta-checkout' ), 'error' );
			return;
		}

		$client = $this->client();

		try {
			$session = $client->create_session(
				array(
					'amount'     => $amount,
					'currency'   => (string) $this->get_option( 'token' ),
					'orderId'    => (string) $order->get_id(),
					'successUrl' => $this->get_return_url( $order ),
					'cancelUrl'  => $order->get_cancel_order_url_raw(),
					'expiresIn'  => (int) $this->get_option( 'expires_in', 1800 ),
				)
			);
		} catch ( Keeta_Checkout_Client_Exception $error ) {
			$this->log( sprintf( 'order %d: could not create a session: %s', $order->get_id(), $error->getMessage() ) );
			wc_add_notice(
				sprintf(
					/* translators: %s: the reason from the checkout server. */
					__( 'Keeta payment is unavailable: %s', 'keeta-checkout' ),
					$error->getMessage()
				),
				'error'
			);
			return;
		}

		$session_id = (string) ( $session['id'] ?? '' );
		$pay_url    = (string) ( $session['hostedUrl'] ?? '' );

		if ( '' === $session_id || '' === $pay_url ) {
			// `hostedUrl` is null when the server has no KEETA_CHECKOUT_PUBLIC_URL
			// set, so there is nowhere to send the customer.
			$this->log( sprintf( 'order %d: the session has no hostedUrl; set KEETA_CHECKOUT_PUBLIC_URL on the server', $order->get_id() ) );
			wc_add_notice( __( 'Keeta payment is not configured correctly. Please choose another payment method.', 'keeta-checkout' ), 'error' );
			return;
		}

		$order->update_meta_data( self::SESSION_META, $session_id );
		$order->update_meta_data( self::PAY_URL_META, $pay_url );
		$order->add_order_note(
			sprintf(
				/* translators: 1: amount, 2: token, 3: session id. */
				__( 'Keeta payment request created for %1$s %2$s (session %3$s).', 'keeta-checkout' ),
				$amount,
				(string) $this->get_option( 'token' ),
				$session_id
			)
		);
		// `on-hold` rather than `pending`: the customer has committed to a payment
		// method and the stock should be held while they pay.
		$order->update_status( 'on-hold', __( 'Awaiting a Keeta payment.', 'keeta-checkout' ) );
		$order->save();

		return array(
			'result'   => 'success',
			'redirect' => $pay_url,
		);
	}

	/**
	 * When a customer lands back on the thank-you page, confirm from the server.
	 *
	 * The webhook is the authority and usually arrives first, but a customer can
	 * return before it does. Reading the session back closes that window without
	 * ever trusting the browser: the decision comes from the checkout server, not
	 * from the fact that someone loaded a URL.
	 *
	 * @param int $order_id The order.
	 */
	public function maybe_sync_on_return( $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || $order->is_paid() ) {
			return;
		}

		$session_id = (string) $order->get_meta( self::SESSION_META );
		if ( '' === $session_id ) {
			return;
		}

		try {
			$session = $this->client()->get_session( $session_id );
		} catch ( Keeta_Checkout_Client_Exception $error ) {
			$this->log( sprintf( 'order %d: could not read session %s: %s', $order->get_id(), $session_id, $error->getMessage() ) );
			return;
		}

		if ( 'paid' === ( $session['status'] ?? '' ) ) {
			Keeta_Checkout_Webhook::complete( $order, $session );
		}
	}

	/** A configured API client. */
	private function client(): Keeta_Checkout_Client {
		return new Keeta_Checkout_Client(
			(string) $this->get_option( 'server_url' ),
			(string) $this->get_option( 'api_key' )
		);
	}

	/**
	 * Write a line to the WooCommerce log, when logging is on.
	 *
	 * Never pass a key or a secret to this.
	 *
	 * @param string $message What happened.
	 */
	public function log( string $message ): void {
		if ( 'yes' !== $this->get_option( 'debug' ) ) {
			return;
		}
		if ( null === $this->logger && function_exists( 'wc_get_logger' ) ) {
			$this->logger = wc_get_logger();
		}
		$this->logger?->info( $message, array( 'source' => self::ID ) );
	}
}
