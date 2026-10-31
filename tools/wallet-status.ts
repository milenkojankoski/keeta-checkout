/**
 * Print the development wallets: address, explorer link and every token balance.
 *
 * Run: pnpm wallets:status
 *
 * Reading balances moves no value, so this needs no confirmation. Seeds are never
 * printed.
 */
import {
  WALLET_ROLES,
  addressFor,
  clientFor,
  decimalsOf,
  explorerAccountUrl,
  formatBaseUnits,
  loadTestEnv,
  requireTestNetwork,
  signedResolver,
  accountFor
} from './keeta.ts';

loadTestEnv();
const network = requireTestNetwork();

console.log(`Network: ${network}\n`);

for (const role of WALLET_ROLES) {
  const address = addressFor(role);
  const client = clientFor(role);

  try {
    console.log(`${role}`);
    console.log(`  address  ${address}`);
    console.log(`  explorer ${explorerAccountUrl(address, network)}`);

    const balances = await client.client.getAllBalances(accountFor(role));
    if (balances.length === 0) {
      console.log('  balances none yet. Run `pnpm wallets:fund`.');
    } else {
      console.log('  balances');
      for (const { token, balance } of balances) {
        const tokenAddress = token.publicKeyString.get();
        const { info } = await client.client.getAccountInfo(token);
        let formatted = `${balance} base units`;
        try {
          const decimals = await decimalsOf(client, token);
          formatted = `${formatBaseUnits(balance, decimals)} (${balance} base units, ${decimals} decimals)`;
        } catch {
          // No metadata on this token: base units are all we can say truthfully.
        }
        console.log(`    ${info.name || '(unnamed token)'}  ${formatted}`);
        console.log(`      ${tokenAddress}`);
      }
    }
    console.log('');
  } finally {
    await client.destroy();
  }
}

// What the resolver offers on this network, so later steps know which tickers a
// session can be priced in. Token addresses always come from here, never from memory.
const merchantClient = clientFor('merchant');
try {
  const resolver = signedResolver(merchantClient, accountFor('merchant'));
  const tokens = await resolver.listTokens();
  console.log(`Tokens listed by the resolver on ${network}: ${tokens.length}`);
  for (const { currency, token } of tokens) {
    console.log(`  ${String(currency).padEnd(10)} ${token}`);
  }
} catch (error) {
  console.log(`Could not list resolver tokens: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await merchantClient.destroy();
}
