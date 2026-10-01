import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const port = Number(process.env.PORT) || 3000;
const dbPath = join(root, 'data', 'hunters.json');
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const cache = { tokens: [], updatedAt: 0, error: '' };
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const pendingOrders = new Map();
const tokenDecimals = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function getJson(url) {
  const { stdout } = await execFileAsync('curl', ['-fsSL', '--max-time', '12', '--compressed', url], { maxBuffer: 4 * 1024 * 1024, timeout: 14000 });
  return JSON.parse(stdout);
}

function jupiterRequest(path, payload) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--max-time', '25', '--compressed', '-w', '\n%{http_code}', '-H', 'Content-Type: application/json'];
    if (process.env.JUPITER_API_KEY) args.push('-H', `x-api-key: ${process.env.JUPITER_API_KEY}`);
    if (payload) args.push('-X', 'POST', '--data-binary', '@-');
    args.push(`https://api.jup.ag${path}`);
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 4 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(errors.trim() || 'Jupiter is unavailable'));
      const cut = output.lastIndexOf('\n');
      const status = Number(output.slice(cut + 1));
      let data;
      try { data = JSON.parse(output.slice(0, cut)); }
      catch { return reject(new Error('Invalid response from Jupiter')); }
      if (status < 200 || status >= 300) return reject(new Error(String(data.error || data.message || 'Jupiter request failed').slice(0, 180)));
      resolve(data);
    });
    child.stdin.end(payload ? JSON.stringify(payload) : undefined);
  });
}

function solToLamports(value) {
  const amount = String(value || '').trim();
  if (!/^(?:0|[1-9]\d{0,1})(?:\.\d{1,9})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  const lamports = Number(whole) * 1e9 + Number(fraction.padEnd(9, '0'));
  return lamports >= 1e6 && lamports <= 10e9 ? lamports : null;
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

async function fetchFeed(force = false) {
  if (!force && cache.tokens.length && Date.now() - cache.updatedAt < 180000) return cache;
  try {
    const [top, latest] = await Promise.all([
      getJson('https://api.dexscreener.com/token-boosts/top/v1'),
      getJson('https://api.dexscreener.com/token-boosts/latest/v1')
    ]);
    const profiles = [...top, ...latest].filter(x => x.chainId === 'solana' && addressPattern.test(x.tokenAddress || ''));
    const unique = [...new Map(profiles.map(x => [x.tokenAddress, x])).values()].slice(0, 30);
    if (!unique.length) throw new Error('No Solana tokens returned');
    const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${unique.map(x => x.tokenAddress).join(',')}`);
    const byAddress = new Map(unique.map(x => [x.tokenAddress, x]));
    const best = new Map();
    for (const pair of pairs) {
      if (pair.chainId !== 'solana' || !byAddress.has(pair.baseToken?.address)) continue;
      const address = pair.baseToken.address;
      const old = best.get(address);
      if (!old || Number(pair.liquidity?.usd || 0) > Number(old.liquidity?.usd || 0)) best.set(address, pair);
    }
    const tokens = [...best.values()].map(pair => compactPair(pair, byAddress.get(pair.baseToken.address)))
      .filter(x => x.price > 0 && x.liquidity >= 3000 && x.volume24 >= 1000);
    if (!tokens.length) throw new Error('No active pairs returned');
    cache.tokens = tokens;
    cache.updatedAt = Date.now();
    cache.error = '';
  } catch (error) {
    cache.error = error.message;
    if (!cache.tokens.length) throw error;
  }
  return cache;
}

async function readDb() {
  try { return JSON.parse(await readFile(dbPath, 'utf8')); }
  catch { return { users: {}, swipes: [] }; }
}
async function saveDb(db) {
  await mkdir(join(root, 'data'), { recursive: true });
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
    if (text.length > 10000) throw new Error('Request too large');
  }
  return JSON.parse(text || '{}');
}
function publicUser(user) { return { id: user.id, handle: user.handle, points: user.points, joinedAt: user.joinedAt }; }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/feed' && req.method === 'GET') {
      const feed = await fetchFeed(url.searchParams.get('refresh') === '1');
      return json(res, 200, { tokens: feed.tokens, updatedAt: feed.updatedAt, stale: Boolean(feed.error), error: feed.error });
    }
    if (url.pathname === '/api/buy/order' && req.method === 'POST') {
      const input = await bodyJson(req);
      const taker = String(input.taker || '');
      const outputMint = String(input.outputMint || '');
      const amount = solToLamports(input.amountSol);
      if (!addressPattern.test(taker) || !addressPattern.test(outputMint) || !amount || outputMint === SOL_MINT) {
        return json(res, 400, { error: 'Enter a valid wallet, token, and SOL amount between 0.001 and 10.' });
      }
      const feed = await fetchFeed();
      const db = await readDb();
      const token = feed.tokens.find(x => x.address === outputMint)
        || db.swipes.find(x => x.userId === input.userId && x.address === outputMint && x.direction === 'right');
      if (!token) return json(res, 400, { error: 'This coin is no longer available in your deck or picks.' });
      let decimals = tokenDecimals.get(outputMint);
      if (decimals === undefined) {
        const matches = await jupiterRequest(`/tokens/v2/search?query=${encodeURIComponent(outputMint)}`);
        decimals = Array.isArray(matches) ? matches.find(x => x.id === outputMint)?.decimals : undefined;
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return json(res, 502, { error: 'Could not verify this token’s decimals.' });
        tokenDecimals.set(outputMint, decimals);
        if (!process.env.JUPITER_API_KEY) await new Promise(resolve => setTimeout(resolve, 2100));
      }
      const query = new URLSearchParams({ inputMint: SOL_MINT, outputMint, amount: String(amount), taker });
      const order = await jupiterRequest(`/swap/v2/order?${query}`);
      if (!order.transaction || !order.requestId || String(order.inAmount) !== String(amount) || !/^\d+$/.test(String(order.outAmount))) {
        return json(res, 502, { error: 'Jupiter could not build a swap for this coin. Try again later.' });
      }
      const expiresAt = Date.now() + 60000;
      for (const [key, value] of pendingOrders) if (value.expiresAt < Date.now()) pendingOrders.delete(key);
      pendingOrders.set(order.requestId, { transaction: order.transaction, taker, outputMint, expiresAt });
      return json(res, 200, {
        requestId: order.requestId, transaction: order.transaction, expiresAt,
        inputAmount: amount, outputAmount: String(order.outAmount), decimals,
        minimumOutputAmount: /^\d+$/.test(String(order.otherAmountThreshold)) ? String(order.otherAmountThreshold) : null,
        slippageBps: order.slippageBps ?? null,
        priceImpactPct: order.priceImpactPct ?? null,
        signatureFeeLamports: order.signatureFeeLamports ?? 0,
        prioritizationFeeLamports: order.prioritizationFeeLamports ?? 0,
        rentFeeLamports: order.rentFeeLamports ?? 0,
        feeBps: order.feeBps ?? 0,
        symbol: token.symbol, name: token.name, outputMint
      });
    }
    if (url.pathname === '/api/buy/execute' && req.method === 'POST') {
      const input = await bodyJson(req);
      const order = pendingOrders.get(String(input.requestId || ''));
      if (!order || order.expiresAt < Date.now()) return json(res, 400, { error: 'Quote expired. Get a fresh quote before buying.' });
      if (typeof input.signedTransaction !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.signedTransaction) || input.signedTransaction.length > 10000) {
        return json(res, 400, { error: 'Invalid signed transaction.' });
      }
      const original = Buffer.from(order.transaction, 'base64');
      const signed = Buffer.from(input.signedTransaction, 'base64');
      if (original.length !== signed.length || !signedMessage(original).equals(signedMessage(signed))) {
        return json(res, 400, { error: 'Signed transaction differs from the reviewed quote.' });
      }
      pendingOrders.delete(input.requestId);
      const result = await jupiterRequest('/swap/v2/execute', { signedTransaction: input.signedTransaction, requestId: input.requestId });
      return json(res, 200, { status: result.status, signature: result.signature || '', error: result.error || '' });
    }
    if (url.pathname === '/api/profile' && req.method === 'POST') {
      const input = await bodyJson(req);
      const id = String(input.id || '');
      if (!/^[a-f0-9-]{36}$/.test(id)) return json(res, 400, { error: 'Invalid profile ID' });
      const db = await readDb();
      const handle = String(input.handle || db.users[id]?.handle || 'Meme Hunter').trim().replace(/[^\w .-]/g, '').slice(0, 22) || 'Meme Hunter';
      db.users[id] = db.users[id] || { id, handle, points: 0, joinedAt: Date.now() };
      db.users[id].handle = handle;
      await saveDb(db);
      return json(res, 200, {
        user: publicUser(db.users[id]),
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
      const user = db.users[String(input.userId || '')];
      if (!user || !['left', 'right'].includes(input.direction)) return json(res, 400, { error: 'Invalid swipe' });
      const feed = await fetchFeed();
      const token = feed.tokens.find(x => x.address === input.address);
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
    res.writeHead(200, { 'Content-Type': mime[extname(file)] });
    res.end(bytes);
  } catch (error) {
    json(res, 500, { error: error.message || 'Something went wrong' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Memeder running at http://localhost:${port}`));
