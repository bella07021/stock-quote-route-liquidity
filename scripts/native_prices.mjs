// Keep USD/USDT conversion and native Quote prices on one complete, dated source.
export const NATIVE_IDS = {
  USDT: 'tether', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana',
  HYPE: 'hyperliquid', ASTER: 'aster-2',
};
export const MAX_PRICE_AGE_SECONDS = 15 * 60;
const MAX_FUTURE_SECONDS = 60;
export const COINGECKO_SOURCE = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
  Object.values(NATIVE_IDS).join(',') + '&vs_currencies=usd&include_last_updated_at=true';
export const DEFILLAMA_SOURCE = 'https://coins.llama.fi/prices/current/' +
  Object.values(NATIVE_IDS).map(id => `coingecko:${id}`).join(',');

export function validatePriceTimestamps(timestamps, now = new Date()) {
  const current = now.getTime() / 1000;
  if (!Number.isFinite(current)) throw new Error('Invalid refresh time');
  for (const symbol of Object.keys(NATIVE_IDS)) {
    const stamp = timestamps?.[symbol];
    if (!Number.isFinite(stamp) || stamp <= 0 ||
        current - stamp > MAX_PRICE_AGE_SECONDS || stamp - current > MAX_FUTURE_SECONDS) {
      throw new Error(`${symbol}: missing, stale or future native price timestamp`);
    }
  }
}

function normalizePrices(payload, provider, now) {
  const prices = {};
  const timestamps = {};
  for (const [symbol, id] of Object.entries(NATIVE_IDS)) {
    const row = provider === 'CoinGecko' ? payload?.[id] : payload?.coins?.[`coingecko:${id}`];
    const price = provider === 'CoinGecko' ? row?.usd : row?.price;
    if (!Number.isFinite(price) || price <= 0) throw new Error(`${symbol}: invalid or missing native USD price`);
    if (provider === 'DefiLlama' && (!Number.isFinite(row?.confidence) || row.confidence < 0.99 || row.confidence > 1)) {
      throw new Error(`${symbol}: missing or low native price confidence`);
    }
    prices[symbol] = price;
    timestamps[symbol] = provider === 'CoinGecko' ? row?.last_updated_at : row?.timestamp;
  }
  validatePriceTimestamps(timestamps, now);
  const { USDT: tetherUsd, ...nativePricesUsd } = prices;
  const source = provider === 'CoinGecko' ? COINGECKO_SOURCE : DEFILLAMA_SOURCE;
  return { tetherUsd, nativePricesUsd, tetherSource: source, nativeSource: source,
    nativePriceProvider: provider, nativePriceTimestamps: timestamps };
}

export async function collectNativePrices(json, { now = () => new Date(), warn = console.warn } = {}) {
  const errors = [];
  for (const [provider, source] of [['CoinGecko', COINGECKO_SOURCE], ['DefiLlama', DEFILLAMA_SOURCE]]) {
    try {
      const result = normalizePrices(await json(source), provider, now());
      if (errors.length) warn(`Using ${provider} native prices after ${errors.join('; ')}`);
      return result;
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
    }
  }
  throw new Error(`No complete fresh native price source (${errors.join('; ')}); previous snapshot preserved`);
}

// Permanent HTTP errors (notably 403) go directly to the separate public
// fallback. Network errors, rate limits and server errors get bounded retries.
export function createJsonFetcher({ fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now } = {}) {
  let lastCall = 0;
  return async function json(url) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      let retryable = true;
      let retryDelay = 2000 * (attempt + 1);
      try {
        await sleep(Math.max(0, 500 - (now() - lastCall)));
        lastCall = now();
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
        if (!response.ok) {
          retryable = [408, 429].includes(response.status) || response.status >= 500;
          const retryAfter = response.headers?.get('retry-after');
          if (retryAfter) {
            const seconds = Number(retryAfter);
            const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
            // Do not retry sooner than requested or hold the whole workflow indefinitely.
            if (Number.isFinite(delay)) {
              retryDelay = Math.max(retryDelay, delay);
              if (retryDelay > 30_000) retryable = false;
            }
          }
          throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
      } catch (error) {
        lastError = error;
        if (!retryable || attempt === 2) break;
        await sleep(retryDelay);
      }
    }
    throw new Error(`${url}: ${lastError.message}`);
  };
}
