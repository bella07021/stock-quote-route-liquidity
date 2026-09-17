import assert from 'node:assert/strict';
import { aggregatePools, collectSnapshot, routeConfig } from '../scripts/refresh_stock_routes.mjs';

const stock = '0x' + '1'.repeat(40);
const config = routeConfig.ponsv2;
const pair = (id, tvl, overrides = {}) => ({ chainId: 'robinhood', pairAddress: '0x' + id.repeat(40), baseToken: { address: stock }, quoteToken: { address: config.address }, liquidity: { usd: tvl }, ...overrides });
const poolId = '0x' + 'a'.repeat(64);
const result = aggregatePools([
  pair('2', 100_000), pair('2', 100_000), pair('3', 99_999),
  pair('4', 900_001, { pairAddress: poolId, baseToken: { address: config.address }, quoteToken: { address: stock } }),
  pair('5', 9_000_000, { chainId: 'bsc' }),
  pair('6', 9_000_000, { quoteToken: { address: routeConfig.flap.address } }),
], stock, config);
assert.equal(result.poolCount, 2, 'deduplicate and accept 64-hex pool IDs');
assert.equal(result.tvlUsd, 1_000_001, 'only qualifying pools in the exact route');
assert.throws(() => aggregatePools([pair('2', null)], stock, config), /invalid route pool TVL/);
assert.throws(() => aggregatePools(null, stock, config), /array/);
assert.equal(aggregatePools([], stock, config).tvlUsd, 0);
assert.equal(aggregatePools(Array(30).fill(pair('2', 100_000)), stock, config).coverage, '返回30池，可能截断');

const previous = { thresholdUsd: 1_000_000, platforms: { ponsv2: { rows: [] }, flap: { rows: [] } } };
const scenarios = {
  a: { platform: 'ponsv2', quoteAssetClass: 'equity', quote: 'A', quoteAddress: stock },
  b: { platform: 'flap', quoteAssetClass: 'equity', quote: 'B', quoteAddress: stock },
};
const original = JSON.stringify(previous);
await assert.rejects(collectSnapshot(previous, scenarios, async chain => {
  if (chain === 'bsc') throw new Error('network failure');
  return [pair('2', 2_000_000)];
}), /network failure/);
assert.equal(JSON.stringify(previous), original, 'failed refresh cannot mutate the old snapshot');
const snapshot = await collectSnapshot(previous, scenarios, async () => [], () => new Date('2026-09-17T01:00:00Z'));
assert.equal(snapshot.snapshotDate, '2026-09-17');
assert.equal(snapshot.platforms.flap.rows.length, 1);
assert.equal(JSON.stringify(previous), original);
console.log('Stock refresh aggregation and failure-preservation checks passed.');
