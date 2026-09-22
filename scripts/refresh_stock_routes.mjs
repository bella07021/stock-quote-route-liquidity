import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
export const routeConfig = {
  ponsv2: { chain: 'robinhood', quote: 'WETH', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' },
  flap: { chain: 'bsc', quote: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955' },
};
export const minPoolTvlUsd = 100_000;

export function aggregatePools(pairs, assetAddress, config) {
  if (!Array.isArray(pairs)) throw new Error('Pool response must be an array');
  const pools = new Map();
  for (const pair of pairs) {
    if (pair.chainId !== config.chain) continue;
    const base = String(pair.baseToken?.address || '').toLowerCase();
    const quote = String(pair.quoteToken?.address || '').toLowerCase();
    const matches = (base === assetAddress && quote === config.address) || (quote === assetAddress && base === config.address);
    if (!matches) continue;
    const tvl = pair.liquidity?.usd;
    if (typeof tvl !== 'number' || !Number.isFinite(tvl) || tvl < 0) throw new Error('Missing or invalid route pool TVL');
    if (tvl < minPoolTvlUsd) continue;
    const id = String(pair.pairAddress || '').toLowerCase();
    if (!/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) throw new Error('Invalid route pool address');
    pools.set(id, { address: id, tvlUsd: tvl });
  }
  return {
    tvlUsd: [...pools.values()].reduce((sum, pool) => sum + pool.tvlUsd, 0),
    poolCount: pools.size, returnedPairs: pairs.length, pools: [...pools.values()],
    coverage: pairs.length >= 30 ? '返回30池，可能截断' : '返回少于30池',
  };
}

export async function collectSnapshot(previous, scenarios, fetchPairs, now = () => new Date()) {
  const data = structuredClone(previous);
  data.thresholdUsd = 900_000;
  data.sourceType = 'dexscreener';
  data.sourceLabel = 'DEX Screener 公共 API';
  data.minPoolTvlUsd = minPoolTvlUsd;
  data.refreshStartedAt = now().toISOString();
  for (const [platform, config] of Object.entries(routeConfig)) {
    const assets = Object.values(scenarios).filter(scenario => scenario.platform === platform && scenario.quoteAssetClass === 'equity');
    if (!assets.length) throw new Error(`Missing ${platform} stock models`);
    const rows = [];
    for (const asset of assets) {
      const address = asset.quoteAddress.toLowerCase();
      const pairs = await fetchPairs(config.chain, address);
      rows.push({
        symbol: asset.quote, name: asset.quoteName, address,
        ...aggregatePools(pairs, address, config),
        url: `https://dexscreener.com/${config.chain}/${address}`,
        cutoffUtc: now().toISOString(),
      });
    }
    if (new Set(rows.map(row => row.address)).size !== rows.length) throw new Error(`Duplicate ${platform} stock CA`);
    data.platforms[platform] = { ...previous.platforms[platform], rows, updatedAt: now().toISOString(), sourceLabel: data.sourceLabel };
  }
  data.updatedAt = now().toISOString();
  // China Standard Time is UTC+8 year-round; the scheduled run occurs on the prior UTC date.
  data.snapshotDate = new Date(Date.parse(data.updatedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return data;
}

function supportedSymbols(data, platform) {
  return data.platforms[platform].rows.filter(row => row.tvlUsd >= data.thresholdUsd).map(row => row.symbol).sort();
}

async function main() {
  const universeIndex = process.argv.indexOf('--universe');
  const snapshotIndex = process.argv.indexOf('--snapshot');
  const snapshotPath = snapshotIndex >= 0 ? path.resolve(process.argv[snapshotIndex + 1]) : null;
  const previous = snapshotPath ? JSON.parse(await fs.readFile(snapshotPath, 'utf8')) : require('../stock-route-data.js');
  const scenarios = universeIndex >= 0 ? JSON.parse(await fs.readFile(path.resolve(process.argv[universeIndex + 1]), 'utf8')) : require('../calculator.js').scenarios;
  let lastCall = 0;
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function fetchPairs(chain, address) {
    const url = `https://api.dexscreener.com/token-pairs/v1/${chain}/${address}`;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await delay(Math.max(0, 500 - (Date.now() - lastCall)));
        lastCall = Date.now();
        const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const pairs = await response.json();
        if (!Array.isArray(pairs)) throw new Error('Invalid pool response');
        return pairs;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await delay(2000 * (attempt + 1));
      }
    }
    throw new Error(`${chain}/${address}: ${lastError.message}; previous snapshot preserved`);
  }
  const next = await collectSnapshot(previous, scenarios, fetchPairs);
  const changes = {};
  for (const platform of Object.keys(routeConfig)) {
    const before = supportedSymbols(previous, platform);
    const after = supportedSymbols(next, platform);
    changes[platform] = { supported: after, added: after.filter(symbol => !before.includes(symbol)), removed: before.filter(symbol => !after.includes(symbol)) };
  }
  const target = snapshotPath || path.join(root, 'stock-route-data.js');
  const temporary = `${target}.tmp`;
  const text = snapshotPath ? JSON.stringify(next, null, 2) + '\n' : '// Route liquidity snapshot. Updated only after all model quotes are fetched successfully.\n' +
    '(function (root) {\n  const data = ' + JSON.stringify(next, null, 2) + ';\n' +
    '  if (typeof module === "object" && module.exports) module.exports = data;\n' +
    '  root.StockRouteData = data;\n})(typeof globalThis !== "undefined" ? globalThis : this);\n';
  await fs.writeFile(temporary, text);
  await fs.rename(temporary, target);
  console.log(JSON.stringify({ updatedAt: next.updatedAt, stockCount: Object.values(next.platforms).reduce((sum, p) => sum + p.rows.length, 0), changes }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
