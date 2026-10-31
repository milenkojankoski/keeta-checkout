<?php
/**
 * The block checkout integration.
 *
 * The Checkout block does not read `get_available_payment_gateways()`. It asks its
 * own registry, and a gateway only appears there if it registers a payment method
 * type like this one and a script that calls `registerPaymentMethod`.
 *
 * There is very little to do here because the gateway has no fields: the shopper
 * picks it, WooCommerce calls `process_payment()`, and they are redirected to the
 * hosted pay page. So the JavaScript side only has to supply a label and a
 * description; there is no card form to render and no client-side validation.
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

// The gateway class is normally loaded from the `woocommerce_payment_gateways`
// filter, which has not necessarily run when the blocks registry is built.
require_once KEETA_CHECKOUT_PATH . 'includes/class-wc-gateway-keeta-checkout.php';

/**
 * Exposes the gateway to the Checkout and Cart blocks.
 */
final class Keeta_Checkout_Blocks extends AbstractPaymentMethodType {

	/**
	 * Must match the gateway's id, so the block posts back a payment method
	 * WooCommerce can route to `WC_Gateway_Keeta_Checkout`.
	 *
	 * A literal rather than `WC_Gateway_Keeta_Checkout::ID`: a property default is
	 * evaluated when this class is defined, which can be before the gateway class
	 * exists, and the result is a fatal error during registry construction.
	 *
	 * @var string
	 */
	protected $name = 'keeta_checkout';

	/** Load the gateway's settings, which is where the label and description live. */
	public function initialize(): void {
		$this->settings = get_option( 'woocommerce_' . $this->name . '_settings', array() );
	}

	/**
	 * Whether to offer it.
	 *
	 * Deferred to the gateway itself rather than re-implemented, so the block and
	 * the classic checkout can never disagree about whether Keeta is available.
	 */
	public function is_active(): bool {
		$gateway = $this->gateway();
		return null !== $gateway && $gateway->is_available();
	}

	/**
	 * Scripts the block needs.
	 *
	 * Plain JavaScript against the globals WooCommerce already provides, so the
	 * plugin ships as source with no build step. A merchant can read every line of
	 * what runs on their checkout.
	 *
	 * @return string[] Script handles.
	 */
	public function get_payment_method_script_handles(): array {
		$handle = 'keeta-checkout-blocks';
		$base   = KEETA_CHECKOUT_PATH . 'keeta-checkout.php';

		wp_register_script(
			$handle,
			plugins_url( 'assets/blocks.js', $base ),
			array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities' ),
			KEETA_CHECKOUT_VERSION,
			true
		);

		// The stylesheet is deliberately not enqueued here. `is_checkout()` is true
		// on the block checkout page as well as the classic one, so the gateway's
		// own `wp_enqueue_scripts` hook already covers both and one enqueue is
		// enough for either checkout.
		return array( $handle );
	}

	/**
	 * Data handed to that script, as `keeta_checkout_data`.
	 *
	 * Only what the shopper sees. No API key, no webhook secret, no server URL:
	 * this lands in the page source of a public checkout.
	 *
	 * @return array<string,mixed>
	 */
	public function get_payment_method_data(): array {
		$gateway = $this->gateway();

		return array(
			'title'          => $this->get_setting( 'title', __( 'Pay with Keeta', 'keeta-checkout' ) ),
			'description'    => $this->get_setting( 'description', '' ),
			'supports'       => null === $gateway ? array( 'products' ) : array_values( $gateway->supports ),
			// Said plainly, because a redirect a shopper did not expect is the
			// moment they abandon a cart.
			'redirectNotice' => __(
				'You will be taken to a secure page to pay from your Keeta wallet, then brought back here.',
				'keeta-checkout'
			),
		);
	}

	/**
	 * The gateway instance, or null when WooCommerce has not built it.
	 *
	 * @return WC_Gateway_Keeta_Checkout|null
	 */
	private function gateway() {
		if ( ! function_exists( 'WC' ) || null === WC()->payment_gateways() ) {
			return null;
		}
		$gateway = WC()->payment_gateways()->payment_gateways()[ $this->name ] ?? null;

		return $gateway instanceof WC_Gateway_Keeta_Checkout ? $gateway : null;
	}
}
