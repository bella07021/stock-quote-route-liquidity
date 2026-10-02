import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNativePrices, createJsonFetcher, validatePriceTimestamps } from './native_prices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const routes = {
  flap: { chain: 'bsc', address: '0x55d398326f99059ff775485246999027b3197955' },
  ponsv2: { chain: 'robinhood', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' },
};
export const BNC4_POOL = {
  key: 'fourmeme-bnc4', chain: 'bsc', symbol: 'BNC4',
  address: '0x7c8d5502b544ddaf8852fc46d1174e34876d545c',
  pairAddress: '0xbec6906a984f4695aca0f15bafa7de5eb45b54ab',
  quoteAddress: routes.flap.address,
};

export function selectBnc4Price(pairs, tetherUsd) {
  if (!Array.isArray(pairs)) throw new Error('BNC4: invalid pool payload');
  if (!Number.isFinite(tetherUsd) || tetherUsd <= 0) throw new Error('BNC4: invalid USDT/USD price');
  const pair = pairs.find(row => row.chainId === BNC4_POOL.chain &&
    row.pairAddress?.toLowerCase() === BNC4_POOL.pairAddress &&
    row.baseToken?.address?.toLowerCase() === BNC4_POOL.address &&
    row.quoteToken?.address?.toLowerCase() === BNC4_POOL.quoteAddress);
  if (!pair || !Number.isFinite(Number(pair.priceUsd)) || Number(pair.priceUsd) <= 0 ||
      !Number.isFinite(Number(pair.priceNative)) || Number(pair.priceNative) <= 0 ||
      !Number.isFinite(Number(pair.liquidity?.usd)) || Number(pair.liquidity.usd) <= 0 ||
      pair.url?.toLowerCase() !== `https://dexscreener.com/bsc/${BNC4_POOL.pairAddress}`) {
    throw new Error('BNC4: specified BNC4/USDT pool or price missing; previous snapshot preserved');
  }
  // Convert the direct USDT quote with the same FX input used in Excel.
  // The API's rounded priceUsd can otherwise make web USD outputs diverge.
  return {priceUsd:Number(pair.priceNative)*tetherUsd, priceUsdt:Number(pair.priceNative),
    pairAddress:BNC4_POOL.pairAddress, liquidityUsd:Number(pair.liquidity.usd),
    url:pair.url, route:'USDT'};
}

// Only direct, correctly oriented route pools with material liquidity can price a Quote.
export function selectPrice(pairs, asset, tetherUsd) {
  if (!Array.isArray(pairs)) throw new Error('Invalid pool payload');
  const route = routes[asset.platform];
  const address = asset.quoteAddress.toLowerCase();
  const candidates = pairs.filter(pair => pair.chainId === route.chain &&
    pair.baseToken?.address?.toLowerCase() === address &&
    pair.quoteToken?.address?.toLowerCase() === route.address &&
    Number(pair.liquidity?.usd) >= 100_000 &&
    Number(pair.priceUsd) > 0 && Number.isFinite(Number(pair.priceUsd)) &&
    Number(pair.priceNative) > 0 && Number.isFinite(Number(pair.priceNative)))
    .sort((a,b) => Number(b.liquidity.usd) - Number(a.liquidity.usd) || String(a.pairAddress).localeCompare(String(b.pairAddress)));
  if (!candidates.length) return { priceUsd: null, priceUsdt: null, reason: 'no-priced-route-pool' };
  const pair = candidates[0];
  if (!/^https:\/\/dexscreener\.com\//.test(pair.url || '')) throw new Error('Invalid price source URL');
  return {
    priceUsd: Number(pair.priceUsd),
    priceUsdt: asset.platform === 'flap' ? Number(pair.priceNative) : Number(pair.priceUsd) / tetherUsd,
    pairAddress: pair.pairAddress, liquidityUsd: Number(pair.liquidity.usd), url: pair.url,
    route: asset.platform === 'flap' ? 'USDT' : 'WETH',
  };
}

export async function collectPrices(universe, fetchPairs, tetherUsd, now = () => new Date()) {
  if (!Number.isFinite(tetherUsd) || tetherUsd <= 0) throw new Error('Invalid USDT/USD price');
  const startedAt = now().toISOString();
  const quotes = {};
  for (const [key, asset] of Object.entries(universe)) {
    if (!routes[asset.platform] || asset.quoteAssetClass !== 'equity') continue;
    const pairs = await fetchPairs(routes[asset.platform].chain, asset.quoteAddress.toLowerCase());
    const price = selectPrice(pairs, asset, tetherUsd);
    // An existing qualifying route with missing price is a failed fetch, not missing coverage.
    const qualifying = pairs.some(pair => pair.chainId === routes[asset.platform].chain &&
      pair.baseToken?.address?.toLowerCase() === asset.quoteAddress.toLowerCase() &&
      pair.quoteToken?.address?.toLowerCase() === routes[asset.platform].address && Number(pair.liquidity?.usd) >= 100_000);
    if (qualifying && price.priceUsd == null) throw new Error(`${key}: route price missing; previous snapshot preserved`);
    quotes[key] = { symbol: asset.quote, address: asset.quoteAddress.toLowerCase(), ...price, fetchedAt: now().toISOString() };
  }
  if (!Object.keys(quotes).length) throw new Error('Empty stock universe');
  // The user-selected BNC4 pool is fixed; never substitute another pool.
  const bnc4 = selectBnc4Price(await fetchPairs(BNC4_POOL.chain, BNC4_POOL.address), tetherUsd);
  quotes[BNC4_POOL.key] = {symbol:BNC4_POOL.symbol, address:BNC4_POOL.address,
    ...bnc4, fetchedAt:now().toISOString()};
  return { schemaVersion: 1, startedAt, updatedAt: now().toISOString(), tetherUsd,
    source: 'DEX Screener deepest direct route pool', tetherSource: 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd', quotes };
}

export async function refreshPrices(universe, target, { json = createJsonFetcher(), now = () => new Date(), warn = console.warn } = {}) {
  const native = await collectNativePrices(json, { now, warn });
  const data = await collectPrices(universe,async(chain,address)=> address === BNC4_POOL.address
    ? (await json(`https://api.dexscreener.com/latest/dex/pairs/bsc/${BNC4_POOL.pairAddress}`)).pairs
    : json(`https://api.dexscreener.com/token-pairs/v1/${chain}/${address}`), native.tetherUsd, now);
  // DEX requests can take time: recheck freshness immediately before publication.
  validatePriceTimestamps(native.nativePriceTimestamps, now());
  Object.assign(data, native);
  await fs.writeFile(`${target}.tmp`,JSON.stringify(data,null,2)+'\n');
  await fs.rename(`${target}.tmp`,target);
  return data;
}

async function main() {
  const arg = (name, fallback) => process.argv.includes(name) ? path.resolve(process.argv[process.argv.indexOf(name)+1]) : path.join(root,fallback);
  const universe = JSON.parse(await fs.readFile(arg('--universe','asset-universe.json'),'utf8'));
  const data = await refreshPrices(universe, arg('--snapshot','stock-price-data.json'));
  console.log(JSON.stringify({updatedAt:data.updatedAt,priced:Object.values(data.quotes).filter(q=>q.priceUsd>0).length,total:Object.keys(data.quotes).length}));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});
