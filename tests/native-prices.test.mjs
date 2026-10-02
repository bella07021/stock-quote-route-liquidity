import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NATIVE_IDS, COINGECKO_SOURCE, DEFILLAMA_SOURCE, MAX_PRICE_AGE_SECONDS,
  collectNativePrices, createJsonFetcher } from '../scripts/native_prices.mjs';
import { refreshPrices, BNC4_POOL } from '../scripts/refresh_stock_prices.mjs';

const stamp = 1_790_000_000;
const now = () => new Date(stamp * 1000);
const quiet = { now, warn: () => {} };
const values = { USDT: 0.999, ETH: 2700, BNB: 700, SOL: 120, HYPE: 90, ASTER: 0.7 };
const primary = () => Object.fromEntries(Object.entries(NATIVE_IDS).map(([symbol, id]) =>
  [id, { usd: values[symbol], last_updated_at: stamp - 30 }]));
const fallback = () => ({ coins: Object.fromEntries(Object.entries(NATIVE_IDS).map(([symbol, id]) =>
  [`coingecko:${id}`, { price: values[symbol], timestamp: stamp - 60, confidence: 0.99 }])) });
const response = (status, data, retryAfter) => ({ ok: status === 200, status,
  headers: { get: name => name === 'retry-after' ? retryAfter : null }, json: async () => data });

test('valid CoinGecko remains preferred, with exact USD IDs and source timestamps', async () => {
  const calls = [];
  const result = await collectNativePrices(async url => { calls.push(url); return primary(); }, quiet);
  assert.deepEqual(calls, [COINGECKO_SOURCE]);
  assert.equal(result.tetherUsd, values.USDT);
  assert.equal(result.nativePricesUsd.ASTER, values.ASTER);
  assert.equal(result.nativePriceTimestamps.USDT, stamp - 30);
  assert.equal(result.nativePriceProvider, 'CoinGecko');
  assert.equal(result.nativeSource, COINGECKO_SOURCE);
  assert.equal(result.tetherSource, COINGECKO_SOURCE);
});

test('HTTP 403 is not retried and switches to a complete DefiLlama batch', async () => {
  const calls = [], warnings = [];
  const json = createJsonFetcher({ sleep: async () => {}, fetchImpl: async url => {
    calls.push(url);
    return url === COINGECKO_SOURCE ? response(403) : response(200, fallback());
  } });
  const result = await collectNativePrices(json, { now, warn: message => warnings.push(message) });
  assert.deepEqual(calls, [COINGECKO_SOURCE, DEFILLAMA_SOURCE]);
  assert.equal(result.nativePriceProvider, 'DefiLlama');
  assert.equal(result.nativeSource, DEFILLAMA_SOURCE);
  assert.equal(result.tetherSource, DEFILLAMA_SOURCE);
  assert.equal(result.tetherUsd, values.USDT);
  assert.equal(result.nativePriceTimestamps.ASTER, stamp - 60);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CoinGecko.*HTTP 403/);
});

test('invalid or incomplete primary data switches the entire batch, without mixing', async () => {
  for (const id of Object.values(NATIVE_IDS)) {
    const data = primary();
    delete data[id];
    data.ethereum = { usd: 9999, last_updated_at: stamp };
    if (id === 'ethereum') delete data.ethereum;
    const result = await collectNativePrices(async url => url === COINGECKO_SOURCE ? data : fallback(), quiet);
    assert.equal(result.nativePriceProvider, 'DefiLlama');
    assert.equal(result.nativePricesUsd.ETH, values.ETH);
  }
});

test('both providers reject malformed prices, timestamps and missing IDs', async () => {
  for (const provider of ['CoinGecko', 'DefiLlama']) {
    const source = provider === 'CoinGecko' ? COINGECKO_SOURCE : DEFILLAMA_SOURCE;
    const make = provider === 'CoinGecko' ? primary : fallback;
    const rowFor = data => provider === 'CoinGecko' ? data.ethereum : data.coins['coingecko:ethereum'];
    const priceField = provider === 'CoinGecko' ? 'usd' : 'price';
    const timeField = provider === 'CoinGecko' ? 'last_updated_at' : 'timestamp';
    for (const [field, values] of [[priceField, [undefined, null, 0, -1, NaN, Infinity, '2700', true]],
      [timeField, [undefined, null, 0, '1790000000', NaN, Infinity, stamp - MAX_PRICE_AGE_SECONDS - 1, stamp + 61]]]) {
      for (const value of values) {
        const data = make(); rowFor(data)[field] = value;
        await assert.rejects(collectNativePrices(async url => {
          if (url === source) return data;
          throw new Error('unavailable');
        }, quiet), /No complete fresh native price source.*previous snapshot preserved/);
      }
    }
    for (const id of Object.values(NATIVE_IDS)) {
      const data = make();
      if (provider === 'CoinGecko') delete data[id]; else delete data.coins[`coingecko:${id}`];
      await assert.rejects(collectNativePrices(async url => {
        if (url === source) return data;
        throw new Error('unavailable');
      }, quiet), /No complete fresh native price source/);
    }
  }
});

test('fallback rejects absent, low or malformed confidence', async () => {
  for (const confidence of [undefined, null, 0.98, 1.01, NaN, '0.99']) {
    const data = fallback(); data.coins['coingecko:tether'].confidence = confidence;
    await assert.rejects(collectNativePrices(async url => {
      if (url === COINGECKO_SOURCE) throw new Error('HTTP 403');
      return data;
    }, quiet), /confidence/);
  }
});

test('transient HTTP and network errors get bounded retries', async () => {
  for (const failure of [408, 429, 500, 503, 'network', 'json']) {
    let calls = 0;
    const json = createJsonFetcher({ sleep: async () => {}, fetchImpl: async () => {
      calls++;
      if (calls === 3) return response(200, { good: true });
      if (failure === 'network') throw new Error('network');
      if (failure === 'json') return { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } };
      return response(failure);
    } });
    assert.deepEqual(await json(COINGECKO_SOURCE), { good: true });
    assert.equal(calls, 3);
  }
  let calls = 0;
  const json = createJsonFetcher({ sleep: async () => {}, fetchImpl: async () => { calls++; return response(503); } });
  await assert.rejects(json(COINGECKO_SOURCE), /HTTP 503/);
  assert.equal(calls, 3);
});

test('permanent HTTP errors are not retried', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const json = createJsonFetcher({ sleep: async () => {}, fetchImpl: async () => { calls++; return response(status); } });
    await assert.rejects(json(COINGECKO_SOURCE), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
});

test('retry-after is respected; excessive waits fail over instead of retrying early', async () => {
  for (const header of ['10', new Date(stamp * 1000 + 10_000).toUTCString()]) {
    const sleeps = []; let calls = 0;
    const json = createJsonFetcher({ now: () => stamp * 1000, sleep: async ms => sleeps.push(ms),
      fetchImpl: async () => ++calls === 1 ? response(429, null, header) : response(200, {}) });
    await json(COINGECKO_SOURCE);
    assert.ok(sleeps.includes(10_000));
  }
  let calls = 0;
  const json = createJsonFetcher({ sleep: async () => {}, fetchImpl: async () => { calls++; return response(429, null, '120'); } });
  await assert.rejects(json(COINGECKO_SOURCE), /HTTP 429/);
  assert.equal(calls, 1);
});

const asset = { platform: 'flap', quote: 'TEST', quoteAddress: '0xabc', quoteAssetClass: 'equity' };
const pair = { chainId: 'bsc', baseToken: { address: '0xabc' }, quoteToken: { address: BNC4_POOL.quoteAddress },
  liquidity: { usd: 200_000 }, priceUsd: '100', priceNative: '100.1', pairAddress: '0xpool', url: 'https://dexscreener.com/bsc/0xpool' };
const bnc4 = { ...pair, baseToken: { address: BNC4_POOL.address }, pairAddress: BNC4_POOL.pairAddress,
  url: `https://dexscreener.com/bsc/${BNC4_POOL.pairAddress}`, priceNative: '5.762' };
const routedJson = async url => {
  if (url === COINGECKO_SOURCE) throw new Error('HTTP 403');
  if (url === DEFILLAMA_SOURCE) return fallback();
  return url.includes('/latest/dex/pairs/') ? { pairs: [bnc4] } : [pair];
};

test('fallback refresh writes one complete snapshot with truthful provenance', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-prices-'));
  try {
    const target = path.join(folder, 'snapshot.json');
    const result = await refreshPrices({ test: asset }, target, { ...quiet, json: routedJson });
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), result);
    assert.equal(result.nativeSource, DEFILLAMA_SOURCE);
    assert.equal(result.tetherSource, DEFILLAMA_SOURCE);
    assert.equal(result.quotes[BNC4_POOL.key].priceUsd, 5.762 * values.USDT);
    assert.deepEqual(await fs.readdir(folder), ['snapshot.json']);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('provider, DEX, fixed-pool and late freshness failures leave snapshot bytes untouched', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-prices-'));
  try {
    const target = path.join(folder, 'snapshot.json');
    const before = '{"updatedAt":"previous","quotes":"untouched"}\n';
    await fs.writeFile(target, before);
    for (const failure of ['providers', 'dex', 'bnc4', 'late-stale']) {
      let time = stamp;
      await assert.rejects(refreshPrices({ test: asset }, target, { warn: () => {}, now: () => new Date(time * 1000), json: async url => {
        if (failure === 'providers') throw new Error('HTTP 403');
        if (url.includes('/token-pairs/') && failure === 'dex') throw new Error('DEX unavailable');
        if (url.includes('/latest/dex/pairs/')) {
          if (failure === 'bnc4') return { pairs: [] };
          if (failure === 'late-stale') time += MAX_PRICE_AGE_SECONDS;
        }
        return routedJson(url);
      } }));
      assert.equal(await fs.readFile(target, 'utf8'), before, failure);
      assert.deepEqual(await fs.readdir(folder), ['snapshot.json']);
    }
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
