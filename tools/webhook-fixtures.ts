/**
 * Generate webhook-signature fixtures from the server's own implementation, for
 * the WooCommerce plugin's PHP tests to verify against.
 *
 * Run: pnpm fixtures
 *
 * This is the only thing that proves the TypeScript signer and the PHP verifier
 * agree. Two implementations of an HMAC scheme that were never checked against
 * each other is how a webhook integration silently rejects every delivery.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signWebhook } from '../packages/server/src/webhooks/signature.ts';

interface Fixture {
  name: string;
  valid: boolean;
  secret: string;
  rawBody: string;
  timestamp: number;
  header: string;
}

const SECRET = 'whsec_fixture_0000000000';
const TIMESTAMP = 1_762_000_000;

/** Bodies chosen to catch the encoding differences between the two languages. */
const bodies: Array<[string, unknown]> = [
  ['a paid event', { id: 'evt_1', type: 'checkout.session.paid', data: { session: { id: 'cs_1', amount: '12500000' } } }],
  ['an empty object', {}],
  ['unicode in a string', { note: 'héllo 日本 😀' }],
  ['a script-breaking string', { note: '</script><script>alert(1)</script>' }],
  ['the JavaScript line terminators', { note: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c` }],
  ['an escaped quote and backslash', { note: 'a"b\\c' }],
  ['a long body', { note: 'x'.repeat(5000) }]
];

const fixtures: Fixture[] = bodies.map(([name, value]) => {
  const rawBody = JSON.stringify(value);
  return {
    name,
    valid: true,
    secret: SECRET,
    rawBody,
    timestamp: TIMESTAMP,
    header: signWebhook({ rawBody, secret: SECRET, timestampSeconds: TIMESTAMP })
  };
});

// A few that must be refused, so the PHP side is checked for false acceptance too.
const valid = fixtures[0];
if (valid === undefined) throw new Error('no fixtures were generated');

fixtures.push(
  { ...valid, name: 'a tampered body', valid: false, rawBody: `${valid.rawBody} ` },
  { ...valid, name: 'the wrong secret', valid: false, secret: 'whsec_wrong_00000000000' },
  { ...valid, name: 'a corrupted signature', valid: false, header: valid.header.slice(0, -1) + (valid.header.endsWith('a') ? 'b' : 'a') },
  { ...valid, name: 'no signature in the header', valid: false, header: `t=${TIMESTAMP}` },
  { ...valid, name: 'no timestamp in the header', valid: false, header: valid.header.replace(/^t=\d+,/, '') }
);

const path = resolve(import.meta.dirname, '..', 'plugins', 'woocommerce', 'tests', 'fixtures.json');
writeFileSync(path, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8');

console.log(`Wrote ${fixtures.length} fixtures to ${path}`);
console.log(`  ${fixtures.filter((f) => f.valid).length} that must verify, ${fixtures.filter((f) => !f.valid).length} that must be refused`);
