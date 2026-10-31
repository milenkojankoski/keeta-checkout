/**
 * Register Keeta Checkout with the WooCommerce Checkout block.
 *
 * Plain JavaScript against the globals WooCommerce already loads, so the plugin
 * needs no build step and a merchant can read everything that runs on their
 * checkout page.
 *
 * The gateway has no fields: picking it and pressing the order button sends the
 * shopper to the hosted pay page. So all this does is supply a label and a
 * description, and say the method is always offerable once the server has deemed
 * it active.
 */
(function () {
	'use strict';

	var registry = window.wc && window.wc.wcBlocksRegistry;
	var settingsApi = window.wc && window.wc.wcSettings;
	var element = window.wp && window.wp.element;

	if (!registry || !registry.registerPaymentMethod || !settingsApi || !element) {
		// A WooCommerce old enough to lack these also lacks the block checkout, so
		// the classic gateway is doing the work and there is nothing to register.
		return;
	}

	var createElement = element.createElement;
	var decodeEntities =
		window.wp.htmlEntities && window.wp.htmlEntities.decodeEntities
			? window.wp.htmlEntities.decodeEntities
			: function (value) {
					return value;
				};

	var data = settingsApi.getSetting('keeta_checkout_data', {});
	var label = decodeEntities(data.title || 'Pay with Keeta');

	/** The body shown when the method is selected: just the merchant's description. */
	function Description() {
		var text = decodeEntities(data.description || '');
		return text ? createElement('p', null, text) : null;
	}

	registry.registerPaymentMethod({
		name: 'keeta_checkout',
		label: createElement('span', null, label),
		ariaLabel: label,
		content: createElement(Description, null),
		// What the block editor shows a shop owner previewing the checkout.
		edit: createElement(Description, null),
		// Availability is the server's decision, already made in is_active().
		canMakePayment: function () {
			return true;
		},
		supports: {
			features: data.supports || ['products']
		}
	});
})();
