import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const routes = {
  flap: { chain: 'bsc', address: '0x55d398326f99059ff775485246999027b3197955' },
  ponsv2: { chain: 'robinhood', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' },
};

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
  return { schemaVersion: 1, startedAt, updatedAt: now().toISOString(), tetherUsd,
    source: 'DEX Screener deepest direct route pool', tetherSource: 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd', quotes };
}

async function main() {
  const arg = (name, fallback) => process.argv.includes(name) ? path.resolve(process.argv[process.argv.indexOf(name)+1]) : path.join(root,fallback);
  const universe = JSON.parse(await fs.readFile(arg('--universe','asset-universe.json'),'utf8'));
  const target = arg('--snapshot','stock-price-data.json');
  let lastCall = 0;
  async function json(url) {
    let lastError;
    for (let attempt=0; attempt<3; attempt++) {
      try {
        await new Promise(resolve => setTimeout(resolve,Math.max(0,500-(Date.now()-lastCall))));
        lastCall = Date.now();
        const response = await fetch(url,{signal:AbortSignal.timeout(20_000),headers:{accept:'application/json'}});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch(error) {
        lastError = error;
        if(attempt<2) await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));
      }
    }
    throw new Error(`${url}: ${lastError.message}; previous snapshot preserved`);
  }
  const nativeSource = 'https://api.coingecko.com/api/v3/simple/price?ids=tether,ethereum,binancecoin,solana,hyperliquid,aster-2&vs_currencies=usd';
  const tether = await json(nativeSource);
  const nativePricesUsd = {ETH:Number(tether.ethereum?.usd),BNB:Number(tether.binancecoin?.usd),SOL:Number(tether.solana?.usd),HYPE:Number(tether.hyperliquid?.usd),ASTER:Number(tether['aster-2']?.usd)};
  if(Object.values(nativePricesUsd).some(value=>!Number.isFinite(value)||value<=0))throw new Error('Native quote price missing; previous snapshot preserved');
  const data = await collectPrices(universe,(chain,address)=>json(`https://api.dexscreener.com/token-pairs/v1/${chain}/${address}`),Number(tether.tether?.usd));
  data.nativePricesUsd = nativePricesUsd;
  data.nativeSource = nativeSource;
  await fs.writeFile(`${target}.tmp`,JSON.stringify(data,null,2)+'\n');
  await fs.rename(`${target}.tmp`,target);
  console.log(JSON.stringify({updatedAt:data.updatedAt,priced:Object.values(data.quotes).filter(q=>q.priceUsd>0).length,total:Object.keys(data.quotes).length}));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});
