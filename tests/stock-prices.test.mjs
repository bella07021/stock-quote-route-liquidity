import assert from 'node:assert/strict';
import { selectPrice, collectPrices, selectBnc4Price, BNC4_POOL } from '../scripts/refresh_stock_prices.mjs';
const asset={platform:'flap',quote:'TESTB',quoteAddress:'0xabc',quoteAssetClass:'equity'};
const pair={chainId:'bsc',baseToken:{address:'0xabc'},quoteToken:{address:'0x55d398326f99059ff775485246999027b3197955'},liquidity:{usd:200_000},priceUsd:'100',priceNative:'100.1',pairAddress:'0xpool',url:'https://dexscreener.com/bsc/0xpool'};
assert.equal(selectPrice([pair],asset,0.999).priceUsdt,100.1);
assert.equal(selectPrice([{...pair,liquidity:{usd:99_999}}],asset,1).priceUsd,null);
assert.equal(selectPrice([{...pair,baseToken:pair.quoteToken,quoteToken:pair.baseToken}],asset,1).priceUsd,null);
assert.equal(selectPrice([{...pair,chainId:'robinhood'}],asset,1).priceUsd,null);
assert.equal(selectPrice([pair,{...pair,liquidity:{usd:300_000},priceNative:'101'}],asset,1).priceUsdt,101);
const pons={...asset,platform:'ponsv2'};
assert.equal(selectPrice([{...pair,chainId:'robinhood',quoteToken:{address:'0x0bd7d308f8e1639fab988df18a8011f41eacad73'}}],pons,0.5).priceUsdt,200);
await assert.rejects(collectPrices({test:asset},async()=>{throw new Error('network');},1),/network/);
await assert.rejects(collectPrices({test:asset},async()=>[{...pair,priceUsd:null}],1),/price missing/);
await assert.rejects(collectPrices({test:asset},async()=>[pair],0),/USDT/);
const bnc4={...pair,baseToken:{address:BNC4_POOL.address},pairAddress:BNC4_POOL.pairAddress,
  url:`https://dexscreener.com/bsc/${BNC4_POOL.pairAddress}`,priceNative:'5.7620',priceUsd:'5.76'};
assert.equal(selectBnc4Price([bnc4],0.999).priceUsdt,5.762,'Use USDT ratio, not rounded USD price');
assert.equal(selectBnc4Price([bnc4],0.999).priceUsd,5.762*0.999,'USD and USDT use the same FX in web and Excel');
for(const bad of [{...bnc4,pairAddress:'0xcf936261a1582b45eae2246105b3388d1e31c94d'},
  {...bnc4,baseToken:bnc4.quoteToken,quoteToken:bnc4.baseToken}, {...bnc4,chainId:'eth'},
  {...bnc4,priceNative:null}, {...bnc4,priceUsd:'NaN'}])assert.throws(()=>selectBnc4Price([bad],1),/specified/);
const snapshot=await collectPrices({test:asset},async(chain,address)=>address===BNC4_POOL.address?[bnc4]:[pair],0.999);
assert.equal(snapshot.quotes[BNC4_POOL.key].priceUsdt,5.762);
await assert.rejects(collectPrices({test:asset},async(chain,address)=>address===BNC4_POOL.address?[]:[pair],1),/BNC4/);
console.log('Stock price source and failure-preservation tests passed');
