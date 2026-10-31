# keeta-checkout

Accept Keeta payments on your website. A small server that watches your own Keeta
account, marks orders paid, serves a hosted pay page with a QR code, and signs
webhooks to your backend. It holds no key: a compromise of the server cannot move
your funds.

```
npx keeta-checkout init     # configure, and generate the secrets
npx keeta-checkout check    # confirm the address and tokens work on this network
npx keeta-checkout serve    # take payments
```

Needs Node 24. Also available as a container image,
`ghcr.io/milenkojankoski/keeta-checkout`, and with a WooCommerce plugin.

Documentation, source, the plugin and the design records:
https://github.com/milenkojankoski/keeta-checkout

Apache-2.0.
