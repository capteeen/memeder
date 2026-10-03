import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

const root = process.cwd();
const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.VERCEL ? join('/tmp', 'hunters.json') : join(root, 'data', 'hunters.json');
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const profileIdPattern = /^[a-f0-9-]{36}$/;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT]);
const SKIP_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
const stream = {
  tokens: new Map(), archive: new Map(), order: [], updatedAt: 0, error: '',
  step: 0, listing: 0, trendingPage: 1, newPage: 1, dexAt: 0, lastGeckoAt: 0
};
let feedLock = Promise.resolve();
const pendingOrders = new Map();
const tokenDecimals = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function readResponse(response, limit) {
  const text = await response.text();
  if (text.length > limit) throw new Error('Response too large');
  return text;
}

async function getJson(url, headers = []) {
  const headerMap = { Accept: 'application/json' };
  for (const header of headers) {
    const cut = String(header).indexOf(':');
    if (cut > 0) headerMap[header.slice(0, cut).trim()] = header.slice(cut + 1).trim();
  }
  const response = await fetch(url, { headers: headerMap, signal: AbortSignal.timeout(12000) });
  const text = await readResponse(response, 8 * 1024 * 1024);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return JSON.parse(text);
}

async function jupiterRequest(path, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
  const response = await fetch(`https://api.jup.ag${path}`, {
    method: payload ? 'POST' : 'GET',
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(25000)
  });
  const text = await readResponse(response, 4 * 1024 * 1024);
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('Invalid response from Jupiter'); }
  if (!response.ok) throw new Error(String(data.error || data.message || 'Jupiter request failed').slice(0, 180));
  return data;
}

function solToLamports(value) {
  const amount = String(value || '').trim();
  if (!/^(?:0|[1-9]\d{0,1})(?:\.\d{1,9})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  const lamports = Number(whole) * 1e9 + Number(fraction.padEnd(9, '0'));
  return lamports >= 1e6 && lamports <= 10e9 ? lamports : null;
}

function tokenToRaw(value, decimals) {
  const amount = String(value || '').trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals || whole.length > 20) return null;
  const raw = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return raw > 0n ? raw.toString() : null;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const text = await readResponse(response, 2 * 1024 * 1024);
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('Invalid response'); }
  if (!response.ok) throw new Error(String(data.error?.message || data.error || data.message || 'Request failed').slice(0, 180));
  return data;
}

const RPC_URLS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
async function solanaRpc(method, params) {
  let lastError = new Error('Solana RPC is unavailable');
  for (const url of RPC_URLS) {
    try {
      const data = await postJson(url, { jsonrpc: '2.0', id: 1, method, params });
      if (data.error) throw new Error(String(data.error.message || 'Solana RPC failed').slice(0, 160));
      return data.result;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

function collectHoldings(items, mint, into) {
  for (const item of items || []) {
    if (item.pubkey && into.seen.has(item.pubkey)) continue;
    if (item.pubkey) into.seen.add(item.pubkey);
    const info = item.account?.data?.parsed?.info;
    if (!info || (info.mint && info.mint !== mint)) continue;
    const amount = info.tokenAmount;
    if (!amount?.amount || !/^\d+$/.test(String(amount.amount))) continue;
    into.raw += BigInt(amount.amount);
    if (Number.isInteger(amount.decimals)) into.decimals = amount.decimals;
  }
}
async function walletBalances(owner, mint) {
  const sol = await solanaRpc('getBalance', [owner]);
  const [classic, token2022] = await Promise.allSettled([
    solanaRpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]),
    solanaRpc('getProgramAccounts', [TOKEN_2022, {
      encoding: 'jsonParsed',
      filters: [
        { memcmp: { offset: 0, bytes: mint } },
        { memcmp: { offset: 32, bytes: owner } }
      ]
    }])
  ]);
  const holdings = { raw: 0n, decimals: null, seen: new Set() };
  if (classic.status === 'fulfilled') collectHoldings(classic.value?.value, mint, holdings);
  if (token2022.status === 'fulfilled') collectHoldings(Array.isArray(token2022.value) ? token2022.value : [], mint, holdings);
  if (classic.status === 'rejected' && token2022.status === 'rejected') throw classic.reason;
  if (token2022.status === 'rejected' && holdings.raw === 0n) throw token2022.reason;
  return { solLamports: String(sol?.value ?? 0), tokenAmount: holdings.raw.toString(), decimals: holdings.decimals };
}

const decimalLookups = new Map();
function lookupDecimals(mint) {
  if (tokenDecimals.has(mint)) return Promise.resolve(tokenDecimals.get(mint));
  if (!decimalLookups.has(mint)) decimalLookups.set(mint, fetchDecimals(mint).finally(() => decimalLookups.delete(mint)));
  return decimalLookups.get(mint);
}
async function fetchDecimals(mint) {
  const matches = await jupiterRequest(`/tokens/v2/search?query=${encodeURIComponent(mint)}`);
  const decimals = Array.isArray(matches) ? matches.find(item => item.id === mint)?.decimals : undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Could not verify this token’s decimals.');
  tokenDecimals.set(mint, decimals);
  return decimals;
}

function signedMessage(bytes) {
  let count = 0, shift = 0, offset = 0, next;
  do {
    next = bytes[offset++];
    if (next === undefined || offset > 3) throw new Error('Invalid transaction');
    count |= (next & 0x7f) << shift;
    shift += 7;
  } while (next & 0x80);
  if (count < 1 || count > 16 || bytes.length < offset + count * 64 + 1) throw new Error('Invalid transaction');
  return bytes.subarray(offset + count * 64);
}

function compactPair(pair, profile) {
  const token = pair.baseToken || {};
  const change = pair.priceChange || {};
  const txns = pair.txns || {};
  const info = pair.info || {};
  const cap = Number(pair.marketCap || pair.fdv || 0);
  return {
    address: token.address,
    name: String(token.name || 'Unknown token').slice(0, 60),
    symbol: String(token.symbol || '???').slice(0, 16),
    image: info.imageUrl || (profile?.icon?.startsWith('http') ? profile.icon : ''),
    price: Number(pair.priceUsd || 0),
    cap,
    liquidity: Number(pair.liquidity?.usd || 0),
    volume24: Number(pair.volume?.h24 || 0),
    change1: Number(change.h1 || 0),
    change24: Number(change.h24 || 0),
    buys24: Number(txns.h24?.buys || 0),
    sells24: Number(txns.h24?.sells || 0),
    createdAt: Number(pair.pairCreatedAt || 0),
    url: pair.url || `https://dexscreener.com/solana/${token.address}`,
    socials: (info.socials || []).filter(x => /^https:\/\//.test(x.url || '')).slice(0, 3),
    boost: Number(profile?.totalAmount || 0)
  };
}

function withFeedLock(task) {
  const run = feedLock.then(task, task);
  feedLock = run.then(() => undefined, () => undefined);
  return run;
}
function remember(token) {
  if (!token?.address) return false;
  const exists = stream.tokens.has(token.address);
  stream.archive.delete(token.address);
  stream.tokens.set(token.address, token);
  if (!exists) {
    stream.order.push(token.address);
    while (stream.order.length > 800) {
      const address = stream.order.shift();
      const old = stream.tokens.get(address);
      if (!old) continue;
      stream.tokens.delete(address);
      stream.archive.set(address, old);
    }
    while (stream.archive.size > 2000) stream.archive.delete(stream.archive.keys().next().value);
  }
  stream.updatedAt = Date.now();
  return !exists;
}
function findListed(address) {
  return stream.tokens.get(address) || stream.archive.get(address) || null;
}
function absorbPairs(pairs, profiles, minLiquidity = 3000, minVolume = 1000) {
  const best = new Map();
  for (const pair of pairs) {
    if (pair.chainId !== 'solana' || !profiles.has(pair.baseToken?.address)) continue;
    const address = pair.baseToken.address;
    const old = best.get(address);
    if (!old || Number(pair.liquidity?.usd || 0) > Number(old.liquidity?.usd || 0)) best.set(address, pair);
  }
  const added = [];
  for (const pair of best.values()) {
    const token = compactPair(pair, profiles.get(pair.baseToken.address));
    if (!(token.price > 0 && token.liquidity >= minLiquidity && token.volume24 >= minVolume) || SKIP_MINTS.has(token.address)) continue;
    if (remember(token)) added.push(token);
  }
  return added;
}
async function mergeDexProfiles(url) {
  const list = await getJson(url);
  const rows = (Array.isArray(list) ? list : []).filter(row => row.chainId === 'solana' && addressPattern.test(row.tokenAddress || ''));
  const unique = [...new Map(rows.map(row => [row.tokenAddress, row])).values()].slice(0, 30);
  if (!unique.length) return [];
  const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${unique.map(row => row.tokenAddress).join(',')}`);
  return absorbPairs(Array.isArray(pairs) ? pairs : [], new Map(unique.map(row => [row.tokenAddress, row])));
}
async function mergeDexBoosts() {
  const [top, latest] = await Promise.all([
    getJson('https://api.dexscreener.com/token-boosts/top/v1'),
    getJson('https://api.dexscreener.com/token-boosts/latest/v1')
  ]);
  const profiles = [...top, ...latest].filter(row => row.chainId === 'solana' && addressPattern.test(row.tokenAddress || ''));
  const unique = [...new Map(profiles.map(row => [row.tokenAddress, row])).values()].slice(0, 30);
  if (!unique.length) throw new Error('No Solana tokens returned');
  const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${unique.map(row => row.tokenAddress).join(',')}`);
  const added = absorbPairs(Array.isArray(pairs) ? pairs : [], new Map(unique.map(row => [row.tokenAddress, row])));
  if (!stream.tokens.size) throw new Error('No active pairs returned');
  stream.dexAt = Date.now();
  stream.error = '';
  return added;
}
function fromGeckoPool(pool, included) {
  const quote = String(pool.relationships?.quote_token?.data?.id || '').replace(/^solana_/, '');
  if (!QUOTE_MINTS.has(quote)) return null;
  const baseId = pool.relationships?.base_token?.data?.id;
  const base = included.get(baseId) || {};
  const address = base.address || String(baseId || '').replace(/^solana_/, '');
  if (!addressPattern.test(address) || SKIP_MINTS.has(address)) return null;
  const price = Number(pool.attributes?.base_token_price_usd || 0);
  const liquidity = Number(pool.attributes?.reserve_in_usd || 0);
  const volume24 = Number(pool.attributes?.volume_usd?.h24 || 0);
  if (!(price > 0 && liquidity >= 2500 && volume24 >= 500)) return null;
  const change = pool.attributes?.price_change_percentage || {};
  const tx = pool.attributes?.transactions?.h24 || {};
  const fallback = String(pool.attributes?.name || 'Unknown token').split(' / ')[0];
  const image = String(base.image_url || '');
  return {
    address,
    name: String(base.name || fallback).slice(0, 60),
    symbol: String(base.symbol || fallback).slice(0, 16),
    image: image.startsWith('https://') ? image : '',
    price,
    cap: Number(pool.attributes?.market_cap_usd || pool.attributes?.fdv_usd || 0),
    liquidity,
    volume24,
    change1: Number(change.h1 || 0),
    change24: Number(change.h24 || 0),
    buys24: Number(tx.buys || 0),
    sells24: Number(tx.sells || 0),
    createdAt: Date.parse(pool.attributes?.pool_created_at || '') || 0,
    url: `https://dexscreener.com/solana/${address}`,
    socials: [],
    boost: 0
  };
}
async function mergeGecko(kind, pageKey) {
  const page = stream[pageKey];
  const payload = await getJson(
    `https://api.geckoterminal.com/api/v2/networks/solana/${kind}?page=${page}&include=base_token`,
    ['Accept: application/json', 'User-Agent: Date/1.0']
  );
  stream.lastGeckoAt = Date.now();
  const pools = Array.isArray(payload.data) ? payload.data : [];
  if (!pools.length) {
    stream[pageKey] = 1;
    return [];
  }
  stream[pageKey] = page >= 10 ? 1 : page + 1;
  const included = new Map((payload.included || []).filter(item => item.type === 'token').map(item => [item.id, item.attributes || {}]));
  const added = [];
  for (const pool of pools) {
    const token = fromGeckoPool(pool, included);
    if (token && remember(token)) added.push(token);
  }
  stream.error = '';
  return added;
}
async function mergeDexRotation() {
  if (!stream.dexAt || Date.now() - stream.dexAt > 60000) return mergeDexBoosts();
  const url = stream.listing++ % 2 === 0
    ? 'https://api.dexscreener.com/token-profiles/latest/v1'
    : 'https://api.dexscreener.com/community-takeovers/latest/v1';
  return mergeDexProfiles(url);
}
async function pullNextBatch() {
  const slot = stream.step % 5;
  const useDex = slot === 4;
  if (!useDex && stream.lastGeckoAt && Date.now() - stream.lastGeckoAt < 2000) return { added: [], retry: true };
  stream.step += 1;
  try {
    const added = useDex
      ? await mergeDexRotation()
      : await mergeGecko(slot % 2 === 0 ? 'trending_pools' : 'new_pools', slot % 2 === 0 ? 'trendingPage' : 'newPage');
    return { added, retry: false };
  } catch (error) {
    stream.error = error.message;
    return { added: [], retry: true };
  }
}
async function fetchFeed(force = false) {
  if (force || !stream.dexAt || Date.now() - stream.dexAt > 180000) {
    try { await mergeDexBoosts(); }
    catch (error) {
      stream.error = error.message;
      if (!stream.tokens.size) {
        try { await mergeGecko('trending_pools', 'trendingPage'); }
        catch (err) { stream.error = err.message; }
      }
    }
  }
  if (force) {
    try { await pullNextBatch(); }
    catch (error) { stream.error = error.message; }
  }
  if (!stream.tokens.size) throw new Error(stream.error || 'No active pairs returned');
  return { tokens: [...stream.tokens.values()], updatedAt: stream.updatedAt, error: stream.error };
}

async function readDb() {
  try { return JSON.parse(await readFile(dbPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { users: {}, swipes: [] };
    throw error;
  }
}
async function saveDb(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 80000) throw new Error('Request too large');
  }
  return JSON.parse(text || '{}');
}
function publicUser(user) { return { id: user.id, handle: user.handle, points: user.points, joinedAt: user.joinedAt }; }
function ensureSwipeUser(db, id) {
  if (!profileIdPattern.test(id)) return null;
  return db.users[id] ||= { id, handle: 'Meme Hunter', points: 0, joinedAt: Date.now() };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/feed' && req.method === 'GET') {
      const more = url.searchParams.get('more') === '1';
      const payload = await withFeedLock(() => more ? pullNextBatch() : fetchFeed(url.searchParams.get('refresh') === '1'));
      if (more) {
        return json(res, 200, { tokens: payload.added, added: payload.added.length, retry: payload.retry, updatedAt: stream.updatedAt, stale: Boolean(stream.error) });
      }
      return json(res, 200, { tokens: payload.tokens, updatedAt: payload.updatedAt, stale: Boolean(payload.error), error: payload.error });
    }
    if (url.pathname === '/api/wallet/balances' && req.method === 'GET') {
      const owner = url.searchParams.get('owner') || '';
      const mint = url.searchParams.get('mint') || '';
      if (!addressPattern.test(owner) || !addressPattern.test(mint) || mint === SOL_MINT) {
        return json(res, 400, { error: 'Enter a valid wallet and token.' });
      }
      const balances = await walletBalances(owner, mint);
      let decimals = balances.decimals;
      if (decimals == null && balances.tokenAmount !== '0') {
        try { decimals = await lookupDecimals(mint); } catch { decimals = null; }
      }
      return json(res, 200, { owner, mint, solLamports: balances.solLamports, tokenAmount: balances.tokenAmount, decimals });
    }
    if (url.pathname === '/api/buy/order' && req.method === 'POST') {
      const input = await bodyJson(req);
      const taker = String(input.taker || '');
      const tokenMint = String(input.tokenMint || input.outputMint || '');
      const side = input.side === 'sell' ? 'sell' : 'buy';
      if (!addressPattern.test(taker) || !addressPattern.test(tokenMint) || tokenMint === SOL_MINT) {
        return json(res, 400, { error: side === 'sell' ? 'Enter a valid wallet and token to sell.' : 'Enter a valid wallet, token, and SOL amount between 0.001 and 10.' });
      }
      await withFeedLock(() => fetchFeed(false));
      const db = await readDb();
      const token = findListed(tokenMint)
        || db.swipes.find(x => x.userId === input.userId && x.address === tokenMint && x.direction === 'right');
      if (!token) return json(res, 400, { error: 'This coin is no longer available in your deck or picks.' });
      const hadDecimals = tokenDecimals.has(tokenMint);
      let decimals;
      try { decimals = await lookupDecimals(tokenMint); }
      catch (error) { return json(res, 502, { error: error.message || 'Could not verify this token’s decimals.' }); }
      const amount = side === 'sell' ? tokenToRaw(input.amountToken ?? input.amount, decimals) : solToLamports(input.amountSol ?? input.amount);
      if (!amount) {
        return json(res, 400, { error: side === 'sell' ? 'Enter how many tokens you want to sell.' : 'Enter a SOL amount between 0.001 and 10.' });
      }
      let balances = null;
      try { balances = await walletBalances(taker, tokenMint); }
      catch { balances = null; }
      if (balances && side === 'buy' && BigInt(balances.solLamports) < BigInt(amount)) {
        return json(res, 400, { error: 'Not enough SOL in this wallet for that amount.' });
      }
      if (balances && side === 'sell' && BigInt(balances.tokenAmount) < BigInt(amount)) {
        return json(res, 400, { error: 'Amount is higher than this wallet’s token balance.' });
      }
      if (!hadDecimals && !process.env.JUPITER_API_KEY) await new Promise(resolve => setTimeout(resolve, 2100));
      const inputMint = side === 'sell' ? tokenMint : SOL_MINT;
      const outputMint = side === 'sell' ? SOL_MINT : tokenMint;
      const query = new URLSearchParams({ inputMint, outputMint, amount: String(amount), taker });
      const order = await jupiterRequest(`/swap/v2/order?${query}`);
      if (!order.transaction || !order.requestId || String(order.inAmount) !== String(amount) || !/^\d+$/.test(String(order.outAmount))) {
        return json(res, 502, { error: 'Jupiter could not build a swap for this coin. Try again later.' });
      }
      if (balances && side === 'buy') {
        const fees = ['signatureFeeLamports', 'prioritizationFeeLamports', 'rentFeeLamports']
          .reduce((sum, key) => sum + (/^\d+$/.test(String(order[key] ?? '0')) ? BigInt(order[key]) : 0n), 0n);
        if (BigInt(balances.solLamports) < BigInt(amount) + fees) {
          return json(res, 400, { error: 'Not enough SOL to cover this swap and its network fees.' });
        }
      }
      const expiresAt = Date.now() + 60000;
      for (const [key, value] of pendingOrders) if (value.expiresAt < Date.now()) pendingOrders.delete(key);
      pendingOrders.set(order.requestId, { transaction: order.transaction, taker, outputMint: tokenMint, side, expiresAt });
      const outputDecimals = side === 'sell' ? 9 : decimals;
      return json(res, 200, {
        requestId: order.requestId, transaction: order.transaction, expiresAt, side,
        inputAmount: String(amount), outputAmount: String(order.outAmount), decimals: outputDecimals,
        minimumOutputAmount: /^\d+$/.test(String(order.otherAmountThreshold)) ? String(order.otherAmountThreshold) : null,
        slippageBps: order.slippageBps ?? null,
        priceImpactPct: order.priceImpactPct ?? null,
        signatureFeeLamports: order.signatureFeeLamports ?? 0,
        prioritizationFeeLamports: order.prioritizationFeeLamports ?? 0,
        rentFeeLamports: order.rentFeeLamports ?? 0,
        feeBps: order.feeBps ?? 0,
        symbol: token.symbol, name: token.name, outputMint: tokenMint
      });
    }
    if (url.pathname === '/api/buy/execute' && req.method === 'POST') {
      const input = await bodyJson(req);
      const requestId = String(input.requestId || '');
      const signedTransaction = input.signedTransaction;
      if (typeof signedTransaction !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signedTransaction) || signedTransaction.length > 60000) {
        return json(res, 400, { error: 'Invalid signed transaction.' });
      }
      const order = pendingOrders.get(requestId);
      if (order?.expiresAt < Date.now()) return json(res, 400, { error: 'Quote expired. Get a fresh quote before confirming.' });
      if (order) {
        const original = Buffer.from(order.transaction, 'base64');
        const signed = Buffer.from(signedTransaction, 'base64');
        if (original.length !== signed.length || !signedMessage(original).equals(signedMessage(signed))) {
          return json(res, 400, { error: 'Signed transaction differs from the reviewed quote.' });
        }
        pendingOrders.delete(requestId);
      }
      const result = await jupiterRequest('/swap/v2/execute', { signedTransaction, requestId });
      return json(res, 200, { status: result.status, signature: result.signature || '', error: result.error || '' });
    }
    if (url.pathname === '/api/profile' && req.method === 'POST') {
      const input = await bodyJson(req);
      const id = String(input.id || '');
      if (!profileIdPattern.test(id)) return json(res, 400, { error: 'Invalid profile ID' });
      const db = await readDb();
      const handle = String(input.handle || db.users[id]?.handle || 'Meme Hunter').trim().replace(/[^\w .-]/g, '').slice(0, 22) || 'Meme Hunter';
      db.users[id] = db.users[id] || { id, handle, points: 0, joinedAt: Date.now() };
      db.users[id].handle = handle;
      await saveDb(db);
      return json(res, 200, {
        user: publicUser(db.users[id]),
        swipes: db.swipes.filter(x => x.userId === id),
        picks: db.swipes.filter(x => x.userId === id && x.direction === 'right').reverse(),
        seen: db.swipes.filter(x => x.userId === id).map(x => x.address),
        lastSwipe: db.swipes.findLast(x => x.userId === id) || null
      });
    }
    if (url.pathname === '/api/swipe/undo' && req.method === 'POST') {
      const input = await bodyJson(req);
      const db = await readDb();
      const user = db.users[String(input.userId || '')];
      if (!user) return json(res, 400, { error: 'Hunter profile not found.' });
      const index = db.swipes.findLastIndex(x => x.userId === user.id);
      if (index < 0) return json(res, 404, { error: 'No swipe to undo.' });
      const removed = db.swipes[index];
      if (removed.address !== input.address) return json(res, 409, { error: 'Your latest swipe changed. Refresh and try again.' });
      db.swipes.splice(index, 1);
      user.points = Math.max(0, user.points - Number(removed.points || 0) - Number(removed.breakoutBonus || 0));
      await saveDb(db);
      return json(res, 200, { user: publicUser(user), removed, lastSwipe: db.swipes.findLast(x => x.userId === user.id) || null });
    }
    if (url.pathname === '/api/swipe' && req.method === 'POST') {
      const input = await bodyJson(req);
      const db = await readDb();
      const id = String(input.userId || '');
      if (!['left', 'right'].includes(input.direction)) return json(res, 400, { error: 'Invalid swipe' });
      const user = ensureSwipeUser(db, id);
      if (!user) return json(res, 400, { error: 'Invalid swipe' });
      let token = findListed(String(input.address || ''));
      if (!token) {
        await withFeedLock(() => fetchFeed(false));
        token = findListed(String(input.address || ''));
      }
      if (!token) return json(res, 400, { error: 'Token is no longer in the feed. Refresh and try again.' });
      if (db.swipes.some(x => x.userId === user.id && x.address === token.address)) return json(res, 409, { error: 'Already swiped this token' });
      const early = token.cap > 0 && token.cap < 1000000;
      const points = input.direction === 'right' ? 10 + (early ? 15 : 0) : 0;
      const swipe = { userId: user.id, address: token.address, name: token.name, symbol: token.symbol, image: token.image, direction: input.direction, points, entryPrice: token.price, entryCap: token.cap, pickedAt: Date.now(), breakoutBonus: 0 };
      db.swipes.push(swipe);
      user.points += points;
      await saveDb(db);
      return json(res, 200, { user: publicUser(user), swipe });
    }
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      const db = await readDb();
      const leaders = Object.values(db.users).sort((a, b) => b.points - a.points || a.joinedAt - b.joinedAt).slice(0, 50).map((user, index) => ({ ...publicUser(user), rank: index + 1, picks: db.swipes.filter(x => x.userId === user.id && x.direction === 'right').length }));
      return json(res, 200, { leaders });
    }
    if (url.pathname === '/api/picks' && req.method === 'GET') {
      const id = url.searchParams.get('userId');
      const db = await readDb();
      return json(res, 200, { picks: db.swipes.filter(x => x.userId === id && x.direction === 'right').reverse() });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(root + '/') || !mime[extname(file)]) return json(res, 404, { error: 'Not found' });
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch (error) {
    json(res, 500, { error: error.message || 'Something went wrong' });
  }
});
const host = process.env.HOST || (process.env.VERCEL ? '0.0.0.0' : '127.0.0.1');
server.listen(port, host, () => console.log(`Date running at http://localhost:${port}`));
