/**
 * The Keeta panel on a WooCommerce order.
 *
 * Loads the panel after the page, asks before every refund, and keeps checking for
 * a short while once one is on its way, so "Refund requested" turns into
 * "Refunded" without a reload. Plain JavaScript with no build step, like the rest
 * of the plugin; the HTML it shows is built and escaped in PHP.
 */
(function () {
	'use strict';

	var root = document.querySelector('.keeta-refunds');
	if (!root) {
		return;
	}

	var strings = window.keetaCheckoutRefunds || {};
	var body = root.querySelector('.keeta-refunds__body');
	var network = root.querySelector('.keeta-refunds__net');

	/** Check every few seconds while a refund is on its way, for about two minutes. */
	var POLL_MS = 3000;
	var POLL_LIMIT = 40;
	var timer = null;
	var polls = 0;

	function post(action, fields) {
		var data = new FormData();
		data.append('action', action);
		data.append('nonce', root.getAttribute('data-nonce'));
		data.append('order_id', root.getAttribute('data-order'));
		Object.keys(fields || {}).forEach(function (key) {
			data.append(key, fields[key]);
		});
		return fetch(root.getAttribute('data-ajax'), {
			method: 'POST',
			credentials: 'same-origin',
			body: data
		}).then(function (response) {
			return response.json();
		});
	}

	function show(payload) {
		body.innerHTML = payload.html;
		body.setAttribute('aria-busy', 'false');
		if (network) {
			network.innerHTML = payload.network_html || '';
		}
		clearTimeout(timer);
		if (payload.pending && polls < POLL_LIMIT) {
			polls += 1;
			timer = setTimeout(load, POLL_MS);
		}
	}

	function fail(message) {
		var note = document.createElement('p');
		note.className = 'keeta-refunds__notice keeta-refunds__notice--bad';
		note.textContent = message;
		body.textContent = '';
		body.appendChild(note);
		body.setAttribute('aria-busy', 'false');
	}

	function messageOf(result, fallback) {
		return (result && result.data && result.data.message) || fallback;
	}

	function load() {
		post('keeta_checkout_refund_panel')
			.then(function (result) {
				if (result && result.success) {
					show(result.data);
				} else {
					fail(messageOf(result, strings.loadFailed));
				}
			})
			.catch(function () {
				fail(strings.loadFailed);
			});
	}

	body.addEventListener('click', function (event) {
		var button = event.target.closest('.keeta-refunds__btn');
		if (!button || button.disabled) {
			return;
		}
		if (!window.confirm(button.getAttribute('data-confirm'))) {
			return;
		}

		var label = button.querySelector('.keeta-refunds__btn-label');
		var original = label ? label.textContent : '';
		button.disabled = true;
		if (label) {
			label.textContent = strings.requesting;
		}

		function restore(message) {
			button.disabled = false;
			if (label) {
				label.textContent = original;
			}
			window.alert(message);
		}

		post('keeta_checkout_request_refund', {
			block_hash: button.getAttribute('data-block'),
			operation_index: button.getAttribute('data-op')
		})
			.then(function (result) {
				if (result && result.success) {
					polls = 0;
					show(result.data);
				} else {
					restore(messageOf(result, strings.requestFailed));
				}
			})
			.catch(function () {
				restore(strings.requestFailed);
			});
	});

	load();
})();
