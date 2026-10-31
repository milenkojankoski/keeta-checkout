/**
 * `keeta-checkout check`: does this configuration actually work?
 *
 * Validates the configuration, then reaches the network to confirm the things a
 * merchant cannot check by reading their own file: that the receiving account
 * exists, that each accepted token resolves and is payable by a shopper, and that
 * the resolver answers at all.
 *
 * Worth its own command because every one of these failures otherwise shows up as a
 * shopper unable to pay, which is the most expensive place to discover them.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { TokenRegistry, configFromEnv, type CheckoutConfig } from '@keeta-checkout/server';

export interface CheckIO {
  log: (line: string) => void;
}

/** Each thing checked, and how it went. */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runCheck(env: NodeJS.ProcessEnv, io: CheckIO): Promise<number> {
  let config: CheckoutConfig;
  try {
    config = configFromEnv(env);
  } catch (error) {
    io.log(`The configuration is not usable: ${error instanceof Error ? error.message : String(error)}`);
    io.log('');
    io.log('Run `keeta-checkout init` to write a fresh one.');
    return 1;
  }

  const results: CheckResult[] = [
    { name: 'configuration', ok: true, detail: `valid, for the ${config.network} network` }
  ];

  const client = KeetaNet.UserClient.fromNetwork(config.network, null);
  try {
    // The receiving account. A brand new account has no blocks yet, which is fine:
    // what matters is that the node answers and the address is well formed.
    try {
      const balance = await client.client.getBalance(config.receivingAddress, client.baseToken);
      results.push({
        name: 'receiving account',
        ok: true,
        detail: `reachable, holding ${balance} base units of KTA for fees it will never need`
      });
    } catch (error) {
      results.push({
        name: 'receiving account',
        ok: false,
        detail: `could not be read: ${error instanceof Error ? error.message : String(error)}`
      });
    }

    // The resolver, and every token a session could be priced in.
    const tokens = new TokenRegistry({ client });
    try {
      const listed = await tokens.list();
      const open = listed.filter((token) => token.openToAnyHolder);
      results.push({
        name: 'resolver',
        ok: open.length > 0,
        detail:
          open.length > 0
            ? `lists ${listed.length} tokens, ${open.length} of them payable by a shopper`
            : 'lists no token a shopper could pay with'
      });

      if (config.acceptedTokens.length === 0) {
        results.push({
          name: 'accepted tokens',
          ok: true,
          detail: `not restricted; sessions may use any of ${open.map((token) => token.ticker ?? token.address).join(', ')}`
        });
      } else {
        for (const wanted of config.acceptedTokens) {
          try {
            const token = await tokens.resolve(wanted);
            results.push({
              name: `token ${wanted}`,
              ok: token.openToAnyHolder,
              detail: token.openToAnyHolder
                ? `${token.ticker ?? token.address}, ${token.decimals} decimals`
                : 'is permit-listed, so a shopper cannot pay with it; price in an open token and use a payout to settle in fiat'
            });
          } catch (error) {
            results.push({
              name: `token ${wanted}`,
              ok: false,
              detail: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    } catch (error) {
      results.push({
        name: 'resolver',
        ok: false,
        detail: `did not answer: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  } finally {
    await client.destroy();
  }

  // Things worth saying that are not pass or fail.
  const notes: string[] = [];
  if (config.publicUrl === undefined) {
    notes.push('No public URL is set, so sessions carry no hostedUrl and QR links are relative.');
  }
  if (config.webhookEndpoints.length === 0) {
    notes.push('No webhook endpoints are configured, so your backend will have to poll for payment.');
  }
  if (config.network === 'main') {
    notes.push('This is the main network. Payments are real money.');
  }

  for (const result of results) {
    io.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name.padEnd(20)} ${result.detail}`);
  }
  if (notes.length > 0) {
    io.log('');
    for (const note of notes) io.log(`note  ${note}`);
  }

  const failed = results.filter((result) => !result.ok);
  io.log('');
  io.log(failed.length === 0 ? 'Everything checks out. `keeta-checkout serve` is ready.' : `${failed.length} check(s) failed.`);
  return failed.length === 0 ? 0 : 1;
}
