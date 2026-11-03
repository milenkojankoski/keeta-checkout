<?php
/**
 * The Keeta panel on a WooCommerce order.
 *
 * Lists every Keeta payment the order received, what each one was, and where any
 * refund of it stands, with a button to send back the ones that should go back: a
 * second payment, a short one, a late one, or the excess of an overpayment.
 *
 * The button asks the checkout server to refund one payment, by its block and
 * operation, and nothing else. It cannot name an amount or an address: the server
 * refunds the payer, in the token they paid, for what they paid or the excess
 * (docs/decisions/0014). The refund process then sends it from the refund float.
 *
 * The panel loads after the page, so an order screen opens at its usual speed even
 * when the checkout server is slow or down.
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * Registers and renders the Keeta panel, and answers its two requests.
 */
final class Keeta_Checkout_Admin_Refunds {

	const NONCE      = 'keeta_checkout_refunds';
	const BOX_ID     = 'keeta-checkout-payments';
	const CAPABILITY = 'edit_shop_orders';

	/** Seconds to wait on the checkout server from an admin screen. */
	const TIMEOUT = 8;

	/** Hooked from the plugin's main file, in the admin only. */
	public static function register(): void {
		add_action( 'add_meta_boxes', array( __CLASS__, 'add_meta_box' ), 10, 2 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'wp_ajax_keeta_checkout_refund_panel', array( __CLASS__, 'ajax_panel' ) );
		add_action( 'wp_ajax_keeta_checkout_request_refund', array( __CLASS__, 'ajax_request_refund' ) );
	}

	/** The order edit screen, under either order storage. */
	public static function screen_id(): string {
		return function_exists( 'wc_get_page_screen_id' ) ? (string) wc_get_page_screen_id( 'shop-order' ) : 'shop_order';
	}

	/**
	 * Add the panel to an order that was paid, or offered payment, through Keeta.
	 *
	 * @param string $screen_or_type The screen id (order tables) or post type (posts).
	 * @param mixed  $object         The order, or its post.
	 */
	public static function add_meta_box( $screen_or_type, $object = null ): void {
		$order = self::order_from( $object );
		if ( null === $order || array() === self::session_ids( $order ) ) {
			return;
		}
		add_meta_box(
			self::BOX_ID,
			__( 'Keeta', 'keeta-checkout' ),
			array( __CLASS__, 'render' ),
			self::screen_id(),
			'normal',
			'default'
		);
	}

	/** Styles and script, on the order screen only. */
	public static function enqueue(): void {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( null === $screen || self::screen_id() !== $screen->id ) {
			return;
		}
		$base = KEETA_CHECKOUT_PATH . 'keeta-checkout.php';
		wp_enqueue_style( 'keeta-checkout-admin-refunds', plugins_url( 'assets/admin-refunds.css', $base ), array(), KEETA_CHECKOUT_VERSION );
		wp_enqueue_script( 'keeta-checkout-admin-refunds', plugins_url( 'assets/admin-refunds.js', $base ), array(), KEETA_CHECKOUT_VERSION, true );
		wp_localize_script(
			'keeta-checkout-admin-refunds',
			'keetaCheckoutRefunds',
			array(
				'loadFailed'    => __( 'Could not load the Keeta payments for this order. Reload the page to try again.', 'keeta-checkout' ),
				'requesting'    => __( 'Requesting…', 'keeta-checkout' ),
				'requestFailed' => __( 'The refund could not be requested.', 'keeta-checkout' ),
			)
		);
	}

	/**
	 * The panel's frame. Its contents arrive from `ajax_panel`.
	 *
	 * @param mixed $object The order, or its post.
	 */
	public static function render( $object ): void {
		$order = self::order_from( $object );
		if ( null === $order ) {
			return;
		}

		printf(
			'<div class="keeta-refunds" data-order="%1$d" data-nonce="%2$s" data-ajax="%3$s">',
			(int) $order->get_id(),
			esc_attr( wp_create_nonce( self::NONCE ) ),
			esc_url( admin_url( 'admin-ajax.php' ) )
		);
		echo '<div class="keeta-refunds__head">';
		// A static SVG read from the plugin's own assets.
		echo '<span class="keeta-refunds__mark">' . self::mark( 'full' ) . '</span>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<span class="keeta-refunds__title">' . esc_html__( 'Payments and refunds', 'keeta-checkout' ) . '</span>';
		echo '<span class="keeta-refunds__net"></span>';
		echo '</div>';
		echo '<div class="keeta-refunds__body" aria-live="polite" aria-busy="true">' . self::loading_html() . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<p class="keeta-refunds__foot">';
		esc_html_e( 'Refunds go back to the payer’s own Keeta account, in the token they paid, from your refund float. Nothing is ever sent from your main account.', 'keeta-checkout' );
		echo '</p></div>';
	}

	/** `admin-ajax.php?action=keeta_checkout_refund_panel` */
	public static function ajax_panel(): void {
		check_ajax_referer( self::NONCE, 'nonce' );
		$order = self::authorised_order();
		wp_send_json_success( self::panel( $order ) );
	}

	/** `admin-ajax.php?action=keeta_checkout_request_refund` */
	public static function ajax_request_refund(): void {
		check_ajax_referer( self::NONCE, 'nonce' );
		$order = self::authorised_order();

		$block_hash = isset( $_POST['block_hash'] ) ? sanitize_text_field( wp_unslash( $_POST['block_hash'] ) ) : '';
		$index      = isset( $_POST['operation_index'] ) ? absint( wp_unslash( $_POST['operation_index'] ) ) : 0;
		if ( 1 !== preg_match( '/^[A-Za-z0-9]{1,128}$/', $block_hash ) ) {
			wp_send_json_error( array( 'message' => __( 'That payment reference is not valid.', 'keeta-checkout' ) ), 400 );
		}

		try {
			// Rebuilt from the server rather than trusted from the page: the payment
			// must be this order's, and still refundable now, not when the page loaded.
			$row = Keeta_Checkout_Refund_Rows::find_actionable( self::state( $order )['rows'], $block_hash, $index );
			if ( null === $row ) {
				wp_send_json_error(
					array( 'message' => __( 'That payment cannot be refunded from this order, or a refund for it already exists.', 'keeta-checkout' ) ),
					409
				);
			}
			$refund = self::client()->request_refund( $block_hash, $index );
		} catch ( Keeta_Checkout_Client_Exception $error ) {
			wp_send_json_error(
				/* translators: %s: the reason from the checkout server. */
				array( 'message' => sprintf( __( 'The refund could not be requested: %s', 'keeta-checkout' ), $error->getMessage() ) ),
				502
			);
		}

		$user = wp_get_current_user();
		$order->add_order_note(
			sprintf(
				/* translators: 1: amount, 2: payer address, 3: staff member, 4: refund id. */
				__( 'Keeta refund of %1$s to %2$s requested by %3$s (refund %4$s).', 'keeta-checkout' ),
				(string) $row['action']['amount_label'],
				(string) $row['payer'],
				'' !== $user->display_name ? $user->display_name : $user->user_login,
				(string) ( $refund['id'] ?? '?' )
			)
		);

		wp_send_json_success( self::panel( $order ) );
	}

	/**
	 * What the panel shows now.
	 *
	 * @param WC_Order $order The order.
	 * @return array{html:string,pending:bool,network_html:string}
	 */
	private static function panel( WC_Order $order ): array {
		try {
			$state = self::state( $order );
		} catch ( Keeta_Checkout_Client_Exception $error ) {
			return array(
				'html'         => self::notice(
					'bad',
					/* translators: %s: the reason. */
					sprintf( __( 'Could not reach your Keeta Checkout server: %s', 'keeta-checkout' ), $error->getMessage() )
				),
				'pending'      => false,
				'network_html' => '',
			);
		}

		return array(
			'html'         => self::rows_html( $state['rows'] ),
			'pending'      => Keeta_Checkout_Refund_Rows::has_pending( $state['rows'] ),
			'network_html' => self::network_html( $state['network'] ),
		);
	}

	/**
	 * The order's sessions, payments and refunds, from the checkout server.
	 *
	 * @param WC_Order $order The order.
	 * @return array{rows:array<int,array<string,mixed>>,network:string}
	 * @throws Keeta_Checkout_Client_Exception When the server cannot answer.
	 */
	private static function state( WC_Order $order ): array {
		$client   = self::client();
		$sessions = array();
		$payments = array();
		$refunds  = array();
		foreach ( self::session_ids( $order ) as $session_id ) {
			$sessions[ $session_id ] = $client->get_session( $session_id );
			$payments                = array_merge( $payments, $client->list_payments( $session_id ) );
			$refunds                 = array_merge( $refunds, $client->list_refunds( $session_id ) );
		}

		return array(
			'rows'    => Keeta_Checkout_Refund_Rows::build( $sessions, $payments, $refunds ),
			'network' => Keeta_Checkout_Refund_Rows::network( $sessions ),
		);
	}

	/**
	 * The rows, or a quiet note when there are none.
	 *
	 * @param array<int,array<string,mixed>> $rows The rows.
	 * @return string
	 */
	private static function rows_html( array $rows ): string {
		if ( array() === $rows ) {
			return self::notice( 'muted', __( 'No Keeta payment has arrived for this order yet.', 'keeta-checkout' ) );
		}

		$html = '<ul class="keeta-refunds__list">';
		foreach ( $rows as $row ) {
			$html .= self::row_html( $row );
		}
		return $html . '</ul>';
	}

	/**
	 * One payment.
	 *
	 * @param array<string,mixed> $row The row.
	 * @return string
	 */
	private static function row_html( array $row ): string {
		$amount = null !== $row['amount_label']
			/* translators: %s: an amount in base units. */
			? (string) $row['amount_label']
			: sprintf( __( '%s base units of another token', 'keeta-checkout' ), (string) $row['amount_base_units'] );

		list( $label, $tone ) = self::disposition( (string) $row['disposition'] );

		$meta = array();
		if ( '' !== $row['payer'] ) {
			$meta[] = sprintf(
				/* translators: %s: the payer's address. */
				esc_html__( 'from %s', 'keeta-checkout' ),
				'<code title="' . esc_attr( (string) $row['payer'] ) . '">' . esc_html( self::short( (string) $row['payer'] ) ) . '</code>'
			);
		}
		$when = self::when( (string) $row['block_date'] );
		if ( '' !== $when ) {
			$meta[] = esc_html( $when );
		}
		if ( '' !== $row['explorer_url'] ) {
			$meta[] = '<a href="' . esc_url( (string) $row['explorer_url'] ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Explorer', 'keeta-checkout' ) . '</a>';
		}

		return '<li class="keeta-refunds__row">'
			. '<div class="keeta-refunds__info">'
			. '<div class="keeta-refunds__main">'
			. '<span class="keeta-refunds__amount">' . esc_html( $amount ) . '</span>'
			. self::pill( $label, $tone )
			. '</div>'
			. '<div class="keeta-refunds__meta">' . implode( '<span aria-hidden="true"> · </span>', $meta ) . '</div>'
			. '</div>'
			. '<div class="keeta-refunds__side">' . self::side_html( $row ) . '</div>'
			. '</li>';
	}

	/**
	 * The right-hand side: a refund's state, the button, or why there is neither.
	 *
	 * @param array<string,mixed> $row The row.
	 * @return string
	 */
	private static function side_html( array $row ): string {
		if ( is_array( $row['refund'] ) ) {
			$refund = $row['refund'];
			list( $label, $tone, $detail ) = self::refund_state( $refund );
			$html = self::pill( $label, $tone );
			if ( '' !== $detail ) {
				$html .= '<span class="keeta-refunds__detail">' . esc_html( $detail ) . '</span>';
			}
			if ( null !== $refund['explorer_url'] && 'published' === $refund['status'] ) {
				$html .= '<a class="keeta-refunds__detail" href="' . esc_url( (string) $refund['explorer_url'] ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'View refund on explorer', 'keeta-checkout' ) . '</a>';
			}
			return $html;
		}

		if ( is_array( $row['action'] ) ) {
			$amount = (string) $row['action']['amount_label'];
			$label  = 'excess' === $row['action']['kind']
				/* translators: %s: the overpaid amount. */
				? sprintf( __( 'Refund the %s overpaid', 'keeta-checkout' ), $amount )
				/* translators: %s: the amount. */
				: sprintf( __( 'Refund %s', 'keeta-checkout' ), $amount );
			$confirm = sprintf(
				/* translators: 1: amount, 2: payer address, 3: two line breaks. */
				__( 'Send %1$s back to %2$s?%3$sIt comes out of your refund float, on chain, and cannot be undone.', 'keeta-checkout' ),
				$amount,
				(string) $row['payer'],
				"\n\n"
			);
			return '<button type="button" class="keeta-refunds__btn"'
				. ' data-block="' . esc_attr( (string) $row['block_hash'] ) . '"'
				. ' data-op="' . esc_attr( (string) $row['operation_index'] ) . '"'
				. ' data-confirm="' . esc_attr( $confirm ) . '">'
				. self::mark( 'solid' )
				. '<span class="keeta-refunds__btn-label">' . esc_html( $label ) . '</span>'
				. '</button>';
		}

		if ( 'other_token' === $row['blocked'] ) {
			return '<span class="keeta-refunds__detail">' . esc_html__( 'Sent in a different token from the order’s. Return it from your wallet.', 'keeta-checkout' ) . '</span>';
		}

		return '';
	}

	/**
	 * A payment's disposition, in words, and its colour.
	 *
	 * @param string $disposition The server's disposition.
	 * @return array{0:string,1:string}
	 */
	private static function disposition( string $disposition ): array {
		switch ( $disposition ) {
			case 'matched':
				return array( __( 'Paid', 'keeta-checkout' ), 'ok' );
			case 'overpaid':
				return array( __( 'Overpaid', 'keeta-checkout' ), 'warn' );
			case 'underpaid':
				return array( __( 'Underpaid', 'keeta-checkout' ), 'warn' );
			case 'late':
				return array( __( 'Arrived after expiry', 'keeta-checkout' ), 'warn' );
			case 'duplicate':
				return array( __( 'Paid twice', 'keeta-checkout' ), 'warn' );
			case 'cancelled':
				return array( __( 'Paid after cancelling', 'keeta-checkout' ), 'warn' );
			case 'wrong_token':
				return array( __( 'Wrong token', 'keeta-checkout' ), 'bad' );
			default:
				return array( ucfirst( str_replace( '_', ' ', $disposition ) ), 'neutral' );
		}
	}

	/**
	 * A refund's state, in words, its colour, and a line of detail.
	 *
	 * @param array<string,mixed> $refund The row's refund.
	 * @return array{0:string,1:string,2:string}
	 */
	private static function refund_state( array $refund ): array {
		$error = is_string( $refund['error'] ) ? $refund['error'] : '';
		switch ( $refund['status'] ) {
			case 'requested':
				return array( __( 'Refund requested', 'keeta-checkout' ), 'info', __( 'Your refund process sends it within a minute or so.', 'keeta-checkout' ) );
			case 'publishing':
				return array( __( 'Sending refund', 'keeta-checkout' ), 'info', '' );
			case 'published':
				/* translators: %s: the amount refunded. */
				return array( __( 'Refunded', 'keeta-checkout' ), 'ok', sprintf( __( '%s sent back', 'keeta-checkout' ), (string) $refund['amount_label'] ) );
			case 'failed':
				return array( __( 'Refund failed', 'keeta-checkout' ), 'bad', trim( $error . ' ' . __( 'Return it from your wallet.', 'keeta-checkout' ) ) );
			case 'refused':
				return array( __( 'Refund not sent', 'keeta-checkout' ), 'bad', trim( $error . ' ' . __( 'Return it from your wallet.', 'keeta-checkout' ) ) );
			default:
				return array( (string) $refund['status'], 'neutral', '' );
		}
	}

	/**
	 * A status pill.
	 *
	 * @param string $label Words.
	 * @param string $tone  ok, warn, bad, info or neutral.
	 * @return string
	 */
	private static function pill( string $label, string $tone ): string {
		return '<span class="keeta-pill keeta-pill--' . esc_attr( $tone ) . '">' . esc_html( $label ) . '</span>';
	}

	/**
	 * A one-line message in the panel body.
	 *
	 * @param string $tone    muted or bad.
	 * @param string $message Words.
	 * @return string
	 */
	private static function notice( string $tone, string $message ): string {
		return '<p class="keeta-refunds__notice keeta-refunds__notice--' . esc_attr( $tone ) . '">' . esc_html( $message ) . '</p>';
	}

	/**
	 * Which network, in the panel's header. Test is called out; main is plain.
	 *
	 * @param string $network `test`, `main`, or empty.
	 * @return string
	 */
	private static function network_html( string $network ): string {
		if ( 'test' === $network ) {
			return self::pill( __( 'Test network', 'keeta-checkout' ), 'warn' );
		}
		if ( 'main' === $network ) {
			return self::pill( __( 'Main network', 'keeta-checkout' ), 'neutral' );
		}
		return '';
	}

	/** Two placeholder rows while the panel loads. */
	private static function loading_html(): string {
		$row = '<li class="keeta-refunds__row keeta-refunds__row--loading" aria-hidden="true"><span class="keeta-skeleton keeta-skeleton--wide"></span><span class="keeta-skeleton"></span></li>';
		return '<span class="screen-reader-text">' . esc_html__( 'Loading Keeta payments…', 'keeta-checkout' ) . '</span><ul class="keeta-refunds__list">' . $row . $row . '</ul>';
	}

	/**
	 * `keeta_aabvt3ni7q…5u2fi`
	 *
	 * @param string $address A Keeta address.
	 * @return string
	 */
	private static function short( string $address ): string {
		return strlen( $address ) > 22 ? substr( $address, 0, 12 ) . '…' . substr( $address, -6 ) : $address;
	}

	/**
	 * The block's date, in the site's own format.
	 *
	 * @param string $iso An ISO-8601 date.
	 * @return string
	 */
	private static function when( string $iso ): string {
		$time = '' === $iso ? false : strtotime( $iso );
		if ( false === $time ) {
			return '';
		}
		return (string) wp_date( get_option( 'date_format' ) . ', ' . get_option( 'time_format' ), $time );
	}

	/**
	 * Keeta's mark, inline.
	 *
	 * `full` is the mark as published, with its fades, for the header; its gradient
	 * ids are renamed so they cannot meet the copy on a checkout page. `solid` drops
	 * the gradients for the small copy inside each button, so a page with several
	 * buttons does not repeat the same ids.
	 *
	 * @param string $variant full or solid.
	 * @return string
	 */
	private static function mark( string $variant ): string {
		static $source = null;
		if ( null === $source ) {
			$read   = file_get_contents( KEETA_CHECKOUT_PATH . 'assets/keeta-mark.svg' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			$source = false === $read ? '' : $read;
		}
		if ( '' === $source ) {
			return '';
		}

		$svg = str_replace( '<svg ', '<svg aria-hidden="true" focusable="false" ', $source );
		if ( 'solid' === $variant ) {
			$svg = (string) preg_replace( '/fill="url\(#[^)]+\)"/', 'fill="currentColor"', $svg );
			return (string) preg_replace( '#<defs>.*</defs>#s', '', $svg );
		}
		return str_replace( 'keeta-mark-', 'keeta-admin-mark-', $svg );
	}

	/**
	 * The order a request names, if the user may manage it. Ends the request if not.
	 *
	 * @return WC_Order
	 */
	private static function authorised_order(): WC_Order {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_send_json_error( array( 'message' => __( 'You are not allowed to manage orders.', 'keeta-checkout' ) ), 403 );
		}
		$order = wc_get_order( isset( $_POST['order_id'] ) ? absint( wp_unslash( $_POST['order_id'] ) ) : 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- checked by the caller.
		if ( ! $order instanceof WC_Order ) {
			wp_send_json_error( array( 'message' => __( 'That order does not exist.', 'keeta-checkout' ) ), 404 );
		}
		return $order;
	}

	/**
	 * The order's Keeta sessions.
	 *
	 * @param WC_Order $order The order.
	 * @return string[]
	 */
	private static function session_ids( WC_Order $order ): array {
		self::load_gateway();
		return Keeta_Checkout_Webhook::order_session_ids( $order );
	}

	/**
	 * A client for the configured checkout server.
	 *
	 * @return Keeta_Checkout_Client
	 * @throws Keeta_Checkout_Client_Exception When the gateway is not set up.
	 */
	private static function client(): Keeta_Checkout_Client {
		self::load_gateway();
		$gateway = function_exists( 'WC' ) && null !== WC()->payment_gateways()
			? ( WC()->payment_gateways()->payment_gateways()[ WC_Gateway_Keeta_Checkout::ID ] ?? null )
			: null;
		if ( ! $gateway instanceof WC_Gateway_Keeta_Checkout ) {
			throw new Keeta_Checkout_Client_Exception( __( 'the Keeta Checkout payment method is not set up', 'keeta-checkout' ) );
		}
		return new Keeta_Checkout_Client(
			(string) $gateway->get_option( 'server_url' ),
			(string) $gateway->get_option( 'api_key' ),
			self::TIMEOUT
		);
	}

	/**
	 * The gateway class, which WooCommerce loads lazily. Its constants are needed here.
	 */
	private static function load_gateway(): void {
		if ( ! class_exists( 'WC_Gateway_Keeta_Checkout', false ) && class_exists( 'WC_Payment_Gateway' ) ) {
			require_once KEETA_CHECKOUT_PATH . 'includes/class-wc-gateway-keeta-checkout.php';
		}
	}

	/**
	 * An order from whatever WordPress passed.
	 *
	 * @param mixed $object An order, a post, or anything else.
	 * @return WC_Order|null
	 */
	private static function order_from( $object ): ?WC_Order {
		if ( $object instanceof WC_Order ) {
			return $object;
		}
		if ( $object instanceof WP_Post && function_exists( 'wc_get_order' ) ) {
			$order = wc_get_order( $object->ID );
			return $order instanceof WC_Order ? $order : null;
		}
		return null;
	}
}
