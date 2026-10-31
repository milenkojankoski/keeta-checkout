<?php
/**
 * Talking to the checkout server.
 *
 * A thin wrapper over `wp_remote_*`, so it works on any host without cURL
 * assumptions and respects a site's configured HTTP proxy.
 *
 * The API key only ever authorises creating and reading sessions. It cannot move
 * money: the checkout server holds no signing key at all. That is worth knowing
 * when deciding how alarmed to be about where this key is stored.
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/** Raised when the checkout server cannot be reached or refuses a request. */
class Keeta_Checkout_Client_Exception extends Exception {}

/**
 * The checkout server's REST API.
 */
class Keeta_Checkout_Client {

	/** @var string Base URL, without a trailing slash. */
	private string $base_url;

	/** @var string Bearer API key. */
	private string $api_key;

	/** @var int Request timeout in seconds. */
	private int $timeout;

	/**
	 * @param string $base_url Checkout server base URL.
	 * @param string $api_key  Bearer API key.
	 * @param int    $timeout  Seconds to wait.
	 */
	public function __construct( string $base_url, string $api_key, int $timeout = 15 ) {
		$this->base_url = untrailingslashit( trim( $base_url ) );
		$this->api_key  = trim( $api_key );
		$this->timeout  = $timeout;
	}

	/**
	 * Create a checkout session.
	 *
	 * `amount` is a string, deliberately. A JSON number is a float, and the point
	 * of a string is that the exact digits WooCommerce calculated survive the trip.
	 *
	 * @param array<string,mixed> $body Session fields.
	 * @return array<string,mixed> The created session.
	 * @throws Keeta_Checkout_Client_Exception On any failure.
	 */
	public function create_session( array $body ): array {
		return $this->request( 'POST', '/api/sessions', $body );
	}

	/**
	 * Read a session back.
	 *
	 * Used when a shopper returns to the thank-you page before the webhook has
	 * arrived, so the order can be completed from the authoritative status rather
	 * than from the fact that they landed on a URL.
	 *
	 * @param string $session_id Session id.
	 * @return array<string,mixed>
	 * @throws Keeta_Checkout_Client_Exception On any failure.
	 */
	public function get_session( string $session_id ): array {
		return $this->request( 'GET', '/api/sessions/' . rawurlencode( $session_id ) . '?view=merchant' );
	}

	/**
	 * Which tokens this server will price a session in.
	 *
	 * @return array<int,array<string,mixed>>
	 * @throws Keeta_Checkout_Client_Exception On any failure.
	 */
	public function list_tokens(): array {
		$response = $this->request( 'GET', '/api/tokens' );
		return is_array( $response['tokens'] ?? null ) ? $response['tokens'] : array();
	}

	/**
	 * Is the server there, and which network is it on?
	 *
	 * @return array<string,mixed>
	 * @throws Keeta_Checkout_Client_Exception On any failure.
	 */
	public function health(): array {
		return $this->request( 'GET', '/health' );
	}

	/**
	 * Perform a request and decode the response.
	 *
	 * @param string                   $method HTTP method.
	 * @param string                   $path   Path beginning with a slash.
	 * @param array<string,mixed>|null $body   JSON body, for POST.
	 * @return array<string,mixed>
	 * @throws Keeta_Checkout_Client_Exception On transport, status or decode failure.
	 */
	private function request( string $method, string $path, ?array $body = null ): array {
		if ( '' === $this->base_url ) {
			throw new Keeta_Checkout_Client_Exception( 'no checkout server URL is configured' );
		}

		$args = array(
			'method'  => $method,
			'timeout' => $this->timeout,
			'headers' => array(
				'Authorization' => 'Bearer ' . $this->api_key,
				'Accept'        => 'application/json',
			),
		);

		if ( null !== $body ) {
			$encoded = wp_json_encode( $body );
			if ( false === $encoded ) {
				throw new Keeta_Checkout_Client_Exception( 'the request body could not be encoded' );
			}
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = $encoded;
		}

		$response = wp_remote_request( $this->base_url . $path, $args );

		if ( is_wp_error( $response ) ) {
			throw new Keeta_Checkout_Client_Exception(
				sprintf( 'could not reach the checkout server: %s', $response->get_error_message() )
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$raw    = (string) wp_remote_retrieve_body( $response );
		$parsed = json_decode( $raw, true );

		if ( $status < 200 || $status > 299 ) {
			// The server's errors carry a readable message and the field at fault;
			// surfacing that beats "request failed".
			$message = is_array( $parsed ) && isset( $parsed['error']['message'] )
				? (string) $parsed['error']['message']
				: sprintf( 'the checkout server answered %d', $status );

			if ( is_array( $parsed ) && isset( $parsed['error']['param'] ) ) {
				$message .= sprintf( ' (field: %s)', (string) $parsed['error']['param'] );
			}
			throw new Keeta_Checkout_Client_Exception( $message );
		}

		if ( ! is_array( $parsed ) ) {
			throw new Keeta_Checkout_Client_Exception( 'the checkout server did not return JSON' );
		}

		return $parsed;
	}
}
