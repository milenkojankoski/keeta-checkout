<?php
/**
 * Plugin Name:       Keeta Checkout for WooCommerce
 * Plugin URI:        https://github.com/milenkojankoski/keeta-checkout
 * Description:       Accept Keeta payments in WooCommerce. Settles to your own Keeta account in about 400 ms, with no processor fee.
 * Version:           0.1.0
 * Requires at least: 7.0
 * Requires PHP:      8.1
 * Author:            Keeta Checkout
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       keeta-checkout
 *
 * WC requires at least: 9.0
 * WC tested up to:      11.2
 *
 * @package KeetaCheckout
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

define( 'KEETA_CHECKOUT_VERSION', '0.1.0' );
define( 'KEETA_CHECKOUT_PATH', plugin_dir_path( __FILE__ ) );

require_once KEETA_CHECKOUT_PATH . 'includes/class-keeta-checkout-amount.php';
require_once KEETA_CHECKOUT_PATH . 'includes/class-keeta-checkout-signature.php';
require_once KEETA_CHECKOUT_PATH . 'includes/class-keeta-checkout-client.php';
require_once KEETA_CHECKOUT_PATH . 'includes/class-keeta-checkout-webhook.php';

/**
 * Declare compatibility with WooCommerce's High Performance Order Storage.
 *
 * This plugin reads and writes orders only through the CRUD methods, never with
 * direct post meta queries, so it works on either storage backend.
 */
add_action(
	'before_woocommerce_init',
	static function (): void {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		}
	}
);

/**
 * Register the gateway with WooCommerce.
 *
 * The gateway class is loaded here rather than at the top of the file because it
 * extends WC_Payment_Gateway, which does not exist until WooCommerce has loaded.
 */
add_filter(
	'woocommerce_payment_gateways',
	static function ( array $gateways ): array {
		require_once KEETA_CHECKOUT_PATH . 'includes/class-wc-gateway-keeta-checkout.php';
		$gateways[] = 'WC_Gateway_Keeta_Checkout';
		return $gateways;
	}
);

add_action( 'rest_api_init', array( 'Keeta_Checkout_Webhook', 'register_route' ) );

/**
 * Tell the merchant plainly when WooCommerce is missing, rather than failing
 * silently with no payment method in the list.
 */
add_action(
	'admin_notices',
	static function (): void {
		if ( class_exists( 'WooCommerce' ) ) {
			return;
		}
		echo '<div class="notice notice-error"><p>';
		esc_html_e( 'Keeta Checkout for WooCommerce needs WooCommerce to be installed and active.', 'keeta-checkout' );
		echo '</p></div>';
	}
);

/** A link straight to the settings, since that is the only thing to do after installing. */
add_filter(
	'plugin_action_links_' . plugin_basename( __FILE__ ),
	static function ( array $links ): array {
		$url = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=keeta_checkout' );

		array_unshift(
			$links,
			'<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'keeta-checkout' ) . '</a>'
		);
		return $links;
	}
);
