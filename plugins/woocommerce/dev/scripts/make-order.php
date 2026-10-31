<?php
/**
 * Create an order and run the gateway's process_payment, as a real checkout does.
 *
 * Run with: docker compose run --rm --entrypoint wp setup \
 *   --path=/var/www/html --allow-root eval-file \
 *   wp-content/plugins/keeta-checkout-for-woocommerce/dev/scripts/make-order.php
 */

$ids = get_posts( array( 'post_type' => 'product', 'name' => 'keeta-test-item', 'fields' => 'ids', 'numberposts' => 1 ) );
$product_id = (int) ( $ids[0] ?? 0 );
if ( 0 === $product_id ) {
	echo "NO PRODUCT\n";
	exit( 1 );
}

$order = wc_create_order();
$order->add_product( wc_get_product( $product_id ), 1 );
$order->set_address(
	array(
		'first_name' => 'Dev',
		'last_name'  => 'Tester',
		'email'      => 'dev@example.test',
		'country'    => 'AT',
	),
	'billing'
);
$order->set_payment_method( 'keeta_checkout' );
$order->calculate_totals();
$order->save();

printf( "order_id=%d\n", $order->get_id() );
printf( "total=%s\n", $order->get_total() );
printf( "status_before=%s\n", $order->get_status() );

$gateway = WC()->payment_gateways()->payment_gateways()['keeta_checkout'];
$result  = $gateway->process_payment( $order->get_id() );
printf( "result=%s\n", wp_json_encode( $result ) );

$order = wc_get_order( $order->get_id() );
printf( "status_after=%s\n", $order->get_status() );
printf( "session=%s\n", (string) $order->get_meta( '_keeta_checkout_session_id' ) );
printf( "pay_url=%s\n", (string) $order->get_meta( '_keeta_checkout_pay_url' ) );
