<?php
/**
 * Place an order through the Store API, which is exactly what the Checkout block
 * does when a shopper presses the order button.
 *
 * This is the path that `process_payment()` alone does not prove: the block posts
 * to `/wc/store/v1/checkout`, WooCommerce routes to the gateway, and the redirect
 * comes back as `payment_result.redirect_url`.
 *
 * Run with: docker compose run --rm --entrypoint wp setup \
 *   --path=/var/www/html --allow-root eval-file \
 *   wp-content/plugins/keeta-checkout-for-woocommerce/dev/scripts/block-checkout.php
 */

// There is no browser here, so there is no nonce to present.
add_filter( 'woocommerce_store_api_disable_nonce_check', '__return_true' );

$ids        = get_posts( array( 'post_type' => 'product', 'name' => 'keeta-test-item', 'fields' => 'ids', 'numberposts' => 1 ) );
$product_id = (int) ( $ids[0] ?? 0 );
if ( 0 === $product_id ) {
	echo "NO PRODUCT\n";
	exit( 1 );
}

WC()->cart->empty_cart();
WC()->cart->add_to_cart( $product_id, 1 );
WC()->cart->calculate_totals();
printf( "cart total: %s %s\n", WC()->cart->get_total( 'edit' ), get_woocommerce_currency() );

$address = array(
	'first_name' => 'Dev',
	'last_name'  => 'Tester',
	'address_1'  => '1 Test Street',
	'city'       => 'Vienna',
	'postcode'   => '1010',
	'country'    => 'AT',
	'email'      => 'dev@example.test',
);

$request = new WP_REST_Request( 'POST', '/wc/store/v1/checkout' );
$request->set_header( 'content-type', 'application/json' );
$request->set_body(
	wp_json_encode(
		array(
			'billing_address'  => $address,
			'shipping_address' => $address,
			'payment_method'   => 'keeta_checkout',
		)
	)
);

$response = rest_do_request( $request );
$data     = $response->get_data();

printf( "http status:    %d\n", $response->get_status() );

if ( isset( $data['order_id'] ) ) {
	$result = $data['payment_result'] ?? array();
	printf( "order_id:       %d\n", (int) $data['order_id'] );
	printf( "order status:   %s\n", (string) ( $data['status'] ?? '?' ) );
	printf( "payment status: %s\n", (string) ( $result['payment_status'] ?? '?' ) );
	printf( "redirect:       %s\n", (string) ( $result['redirect_url'] ?? '(none)' ) );

	$order = wc_get_order( (int) $data['order_id'] );
	printf( "session meta:   %s\n", (string) $order->get_meta( '_keeta_checkout_session_id' ) );
} else {
	printf( "error: %s\n", (string) ( $data['code'] ?? '?' ) );
	printf( "       %s\n", substr( (string) ( $data['message'] ?? '' ), 0, 300 ) );
}
