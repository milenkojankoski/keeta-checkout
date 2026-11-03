#!/bin/sh
# Install and configure the whole shop, so a payment can be tested immediately.
#
# Runs once, inside the wordpress:cli container. Idempotent: running it again on an
# existing install reconfigures rather than failing.
set -eu

WP="wp --path=/var/www/html --allow-root"
SITE_URL="http://localhost:8080"
# WordPress reaches the API over the compose network, not the published port.
CHECKOUT_API="http://checkout:3000"
API_KEY="kck_dev_0000000000000000000000"
WEBHOOK_SECRET="whsec_dev_00000000000000000000"

say() { printf '\n==> %s\n' "$1"; }

say 'Waiting for WordPress files and the database'
for i in $(seq 1 60); do
  if $WP core is-installed >/dev/null 2>&1; then
    echo 'already installed'
    break
  fi
  if $WP core version >/dev/null 2>&1; then
    say 'Installing WordPress'
    $WP core install \
      --url="$SITE_URL" \
      --title='Keeta Checkout Dev Shop' \
      --admin_user=admin \
      --admin_password=admin \
      --admin_email=dev@example.test \
      --skip-email
    break
  fi
  sleep 2
done

$WP core is-installed || { echo 'WordPress did not come up'; exit 1; }

say 'Pretty permalinks'
# The REST route URL that the plugin shows in its settings comes from rest_url(),
# which needs permalinks to produce /wp-json/... rather than ?rest_route=.
$WP rewrite structure '/%postname%/' --hard >/dev/null
$WP rewrite flush --hard >/dev/null

say 'WooCommerce'
$WP plugin is-installed woocommerce >/dev/null 2>&1 || $WP plugin install woocommerce --activate
$WP plugin is-active woocommerce >/dev/null 2>&1 || $WP plugin activate woocommerce

say 'Store basics'
$WP option update woocommerce_store_address '1 Test Street' >/dev/null
$WP option update woocommerce_store_city 'Vienna' >/dev/null
$WP option update woocommerce_default_country 'AT' >/dev/null
$WP option update woocommerce_currency 'EUR' >/dev/null
$WP option update woocommerce_price_decimal_sep '.' >/dev/null
$WP option update woocommerce_price_thousand_sep ',' >/dev/null
# Nothing to ship, so the cart does not ask for an address it does not need.
$WP option update woocommerce_ship_to_countries 'disabled' >/dev/null
$WP option update woocommerce_enable_guest_checkout 'yes' >/dev/null
# Skip the setup wizard and the marketing nags.
$WP option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null 2>&1 || true
$WP option set woocommerce_task_list_hidden yes >/dev/null 2>&1 || true
# Launch the store. WooCommerce 11 starts new stores in "Coming soon" mode, which
# shows visitors who are not logged in an empty shop: the product is there, but
# only the admin can see it.
$WP option update woocommerce_coming_soon 'no' >/dev/null
# The shop is the home page, so the site opens on something to buy.
SHOP_PAGE=$($WP option get woocommerce_shop_page_id 2>/dev/null || true)
if [ -n "$SHOP_PAGE" ]; then
  $WP option update show_on_front 'page' >/dev/null
  $WP option update page_on_front "$SHOP_PAGE" >/dev/null
fi

say 'Keeta Checkout plugin'
$WP plugin activate keeta-checkout-for-woocommerce

say 'Configuring the gateway'
# The store prices in EUR, so a matching token keeps the pairing warning quiet.
# $EURC exists on main but not on test, so this dev shop uses $KTA and the warning
# is expected: it is the guard working, not a misconfiguration to hide.
cat > /tmp/gateway.json <<JSON
{
  "enabled": "yes",
  "title": "Pay with Keeta",
  "description": "Pay from your Keeta wallet. Settles in about a second.",
  "server_url": "$CHECKOUT_API",
  "api_key": "$API_KEY",
  "webhook_secret": "$WEBHOOK_SECRET",
  "token": "\$KTA",
  "expires_in": "1800",
  "debug": "yes"
}
JSON
$WP option update woocommerce_keeta_checkout_settings "$(cat /tmp/gateway.json)" --format=json >/dev/null

say 'A product to buy'
if ! $WP post list --post_type=product --field=ID --name=keeta-test-item | grep -q .; then
  $WP wc product create \
    --name='Keeta Test Item' \
    --slug=keeta-test-item \
    --type=simple \
    --regular_price=0.01 \
    --virtual=true \
    --status=publish \
    --user=admin >/dev/null
fi

say 'Done'
cat <<INFO

  shop        $SITE_URL
  admin       $SITE_URL/wp-admin   (admin / admin)
  gateway     $SITE_URL/wp-admin/admin.php?page=wc-settings&tab=checkout&section=keeta_checkout
  webhook     $SITE_URL/wp-json/keeta-checkout/v1/webhook
  checkout    http://localhost:3000/health

  Buy "Keeta Test Item" (0.01), choose Pay with Keeta, and you land on the
  hosted pay page. Pay it from the dev payer wallet with:

    pnpm tsx plugins/woocommerce/dev/pay-order.ts <session id>

INFO
