const $ = selector => document.querySelector(selector);
const state = { view: 'discover', filter: 'growing', feed: [], picks: [], swipes: [], seen: new Set(), user: null, loading: true, filling: false, refreshing: false, dragging: false, renderAfterSwipe: false, error: '', updatedAt: 0, stale: false, leaders: [], animating: false, undoing: false, lastSwipe: null, pickQuery: '', pickSort: 'newest', blockSwipeClick: false };
const walletState = { wallet: null, account: null, wallets: new Set(), unsubscribe: null, connecting: false, error: '', legacySeen: new Set() };
const buyState = { token: null, side: 'buy', amount: '0.05', quote: null, busy: false, error: '', signature: '', status: '', balance: null, balanceError: '', balanceRequest: 0 };
const intelState = { token: null };
function migratedStorageValue(key, previousKey) {
  const value = localStorage.getItem(key) || localStorage.getItem(previousKey);
  if (value) localStorage.setItem(key, value);
  localStorage.removeItem(previousKey);
  return value;
}
const storedId = migratedStorageValue('date-id', 'memeder-id');
const storedHandle = migratedStorageValue('date-handle', 'memeder-handle');
migratedStorageValue('date-wallet', 'memeder-wallet');
const userId = storedId && /^[a-f0-9-]{36}$/.test(storedId) ? storedId : crypto.randomUUID();
localStorage.setItem('date-id', userId);
const profileKey = `date-profile-${userId}`;

function storedProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(profileKey) || 'null');
    return saved?.id === userId && Array.isArray(saved.swipes) ? saved : null;
  } catch { return null; }
}
function setSwipeHistory(swipes) {
  state.swipes = swipes;
  state.seen = new Set(swipes.map(swipe => swipe.address));
  state.picks = swipes.filter(swipe => swipe.direction === 'right').reverse();
  state.lastSwipe = swipes.at(-1) || null;
  if (state.user) state.user.points = swipes.reduce((points, swipe) => points + Number(swipe.points || 0) + Number(swipe.breakoutBonus || 0), 0);
}
function rememberProfile() {
  try { localStorage.setItem(profileKey, JSON.stringify({ id: userId, user: state.user, swipes: state.swipes })); }
  catch { toast('Could not save your picks in this browser.'); }
}

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]); }
function safeUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } }
function money(value) {
  const n = Number(value || 0);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function price(value) {
  const n = Number(value || 0);
  if (!n) return '—';
  if (n < .00000001) return `$${n.toExponential(2)}`;
  if (n < .0001) return `$${n.toFixed(8).replace(/0+$/, '')}`;
  if (n < 1) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(3)}`;
}
function pct(value) { return `${Number(value) > 0 ? '+' : ''}${Number(value || 0).toFixed(1)}%`; }
function shortAddress(value) { return `${value.slice(0, 4)}…${value.slice(-4)}`; }
function formatUnits(value, decimals) {
  const base = 10n ** BigInt(decimals);
  const units = BigInt(value);
  const whole = (units / base).toLocaleString('en-US');
  const fraction = (units % base).toString().padStart(decimals, '0').slice(0, 9).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
function bytesFromBase64(value) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
function bytesToBase64(bytes) { let result = ''; for (const byte of bytes) result += String.fromCharCode(byte); return btoa(result); }
function plainUnits(value, decimals) {
  const units = BigInt(value || 0);
  const base = 10n ** BigInt(decimals);
  const whole = (units / base).toString();
  const fraction = (units % base).toString().padStart(Number(decimals), '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
function trimAmount(value) {
  const [whole, fraction = ''] = String(value).split('.');
  const trimmed = fraction.slice(0, 4).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}
function solDisplay(lamports) { return trimAmount(plainUnits(lamports || '0', 9)); }
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  if (typeof bytes === 'string') return bytes;
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let index = zeros; index < bytes.length; index++) {
    let carry = bytes[index];
    for (let digit = 0; digit < digits.length; digit++) {
      carry += digits[digit] << 8;
      digits[digit] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map(digit => BASE58[digit]).join('');
}
function signatureText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return base58(value);
  return '';
}
function tradeButtons(address, symbol, loud = false) {
  const id = esc(address);
  const label = esc(symbol);
  const buyClass = loud ? 'token-buy card-buy' : 'token-buy pick-buy';
  return `<button type="button" class="token-trade" data-trade="${id}" aria-label="Trade $${label}">TRADE</button><button type="button" class="${buyClass}" data-buy="${id}" aria-label="Buy $${label}">BUY</button><button type="button" class="token-sell" data-sell="${id}" aria-label="Sell $${label}">SELL</button>`;
}
function walletRejection(error, fallback) {
  const message = error?.message || fallback;
  return /reject|cancel|denied|closed/i.test(message) ? 'Cancelled in the wallet. Nothing was sent.' : message;
}
function age(timestamp) {
  if (!timestamp) return '—';
  const hours = Math.max(0, (Date.now() - timestamp) / 3600000);
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}
function tokenArt(token, className = '') {
  const url = safeUrl(token.image);
  return url ? `<img class="${className}" src="${esc(url)}" alt="${esc(token.name)} logo" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"/><span class="token-fallback ${className}" style="display:none">${esc(token.symbol?.slice(0, 1) || '✳')}</span>` : `<span class="token-fallback ${className}">${esc(token.symbol?.slice(0, 1) || '✳')}</span>`;
}
async function api(path, options) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}
async function loadProfile() {
  const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ id: userId, handle: storedHandle || undefined }) });
  const saved = storedProfile();
  state.user = { ...data.user, ...(saved?.user || {}) };
  setSwipeHistory(saved?.swipes || data.swipes || []);
  rememberProfile();
  render();
}
function restoreProfile() {
  const saved = storedProfile();
  state.user = saved?.user || { id: userId, handle: storedHandle || 'Meme Hunter', points: 0, joinedAt: Date.now() };
  setSwipeHistory(saved?.swipes || []);
  render();
}
function mergeTokens(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return 0;
  const index = new Map(state.feed.map((token, i) => [token.address, i]));
  let added = 0;
  for (const token of tokens) {
    if (!token?.address) continue;
    const at = index.get(token.address);
    if (at === undefined) { index.set(token.address, state.feed.length); state.feed.push(token); added += 1; }
    else state.feed[at] = { ...state.feed[at], ...token };
  }
  return added;
}
function feedLabel() {
  if (state.loading || (state.filling && !sortedFeed().length)) return 'LOADING MARKET';
  if (state.error && !state.feed.length) return 'FEED OFFLINE';
  return `LIVE FEED · ${state.feed.length}${state.filling || state.refreshing ? '+' : ''} TOKENS`;
}
function paintFeedStatus() {
  const el = document.querySelector('.feed-status');
  if (!el) return;
  el.innerHTML = `<span></span>${feedLabel()}`;
}
function presentFeed() {
  if (state.view !== 'discover') return;
  if (state.animating || state.dragging) { state.renderAfterSwipe = true; return; }
  if (document.querySelector('.swipe-card')) { paintFeedStatus(); return; }
  render();
}
let deckFill = null;
function scheduleRefill() {
  clearTimeout(scheduleRefill.timer);
  scheduleRefill.timer = setTimeout(() => { if (sortedFeed().length < 8) ensureDeck(); }, 12000);
}
async function fillDeck() {
  state.filling = true;
  if (!sortedFeed().length && state.view === 'discover' && !state.loading) render();
  else paintFeedStatus();
  let pulls = 0;
  let waits = 0;
  try {
    while (sortedFeed().length < 8 && pulls < 8) {
      const data = await api('/api/feed?more=1');
      const added = mergeTokens(data.tokens);
      if (data.updatedAt) state.updatedAt = data.updatedAt;
      if (added > 0) presentFeed();
      if (data.retry && added === 0) {
        if (++waits > 4) break;
        await new Promise(resolve => setTimeout(resolve, 2200));
        continue;
      }
      pulls += 1;
    }
  } catch (error) {
    if (!state.feed.length) state.error = error.message;
    else toast(error.message);
  }
  state.filling = false;
  if (!sortedFeed().length || state.error) presentFeed();
  else paintFeedStatus();
  if (sortedFeed().length < 8) scheduleRefill();
}
function ensureDeck() {
  if (deckFill) return deckFill;
  if (sortedFeed().length >= 8) {
    if (state.filling) { state.filling = false; paintFeedStatus(); }
    return Promise.resolve();
  }
  deckFill = fillDeck().finally(() => { deckFill = null; });
  return deckFill;
}
async function loadFeed(force = false) {
  const blank = state.feed.length === 0;
  if (blank) { state.loading = true; state.error = ''; render(); }
  else state.refreshing = true;
  try {
    const data = await api(`/api/feed${force ? '?refresh=1' : ''}`);
    mergeTokens(data.tokens);
    state.updatedAt = data.updatedAt;
    state.stale = data.stale;
    state.error = '';
    if (data.stale) toast('Showing the last available market snapshot.');
  } catch (error) {
    if (!state.feed.length) state.error = error.message;
    else toast(error.message);
  }
  state.loading = false;
  state.refreshing = false;
  state.filling = sortedFeed().length < 8;
  if (state.view === 'discover') presentFeed();
  else render();
  if (sortedFeed().length < 8) ensureDeck();
}
async function loadLeaderboard() {
  try { state.leaders = (await api('/api/leaderboard')).leaders; render(); }
  catch (error) { toast(error.message); }
}
function updateChrome() {
  const user = state.user;
  $('#sidebarPoints').textContent = Number(user?.points || 0).toLocaleString();
  $('#sidebarHandle').textContent = user?.handle || 'Meme Hunter';
  $('#pickCount').textContent = state.picks.length;
  $('.avatar').textContent = (user?.handle || 'M')[0].toUpperCase();
  $('#topAvatar').textContent = (user?.handle || 'M')[0].toUpperCase();
  $('#breadcrumbText').textContent = ({ discover: 'DISCOVER / THE DECK', watchlist: 'YOUR HUNT / MY PICKS', leaderboard: 'THE HUNT / LEADERBOARD' })[state.view];
  $('#walletButtonText').textContent = walletState.connecting ? 'CONNECTING…' : walletState.account ? shortAddress(walletState.account.address) : 'CONNECT WALLET';
  $('#walletButton').classList.toggle('connected', Boolean(walletState.account));
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === state.view && el.tagName === 'BUTTON'));
}
function sortedFeed() {
  const visible = state.feed.filter(x => !state.seen.has(x.address));
  return visible.sort((a, b) => state.filter === 'growing'
    ? (Math.max(-100, Math.min(500, b.change1)) * Math.log10(b.volume24 + 10)) - (Math.max(-100, Math.min(500, a.change1)) * Math.log10(a.volume24 + 10))
    : b.volume24 - a.volume24);
}
function card(token, index = 0, position = 1) {
  const positive = token.change24 >= 0;
  const early = token.cap > 0 && token.cap < 1000000;
  return `<article class="swipe-card ${index ? 'peek-card' : ''}" data-address="${esc(token.address)}" ${index ? 'aria-hidden="true"' : ''}>
    <div class="card-glow"></div><div class="card-grid"></div>
    <div class="card-top"><span class="live-pill"><i></i> SOLANA / LIVE</span><div class="card-top-right"><span class="card-index">LIVE</span><button type="button" class="card-intel" data-intel="${esc(token.address)}" aria-label="View ${esc(token.name)} details" title="Coin details">i</button></div></div>
    <div class="card-art-wrap"><div class="card-art-halo"></div>${tokenArt(token, 'card-art')}${early ? '<span class="early-badge">✳ +15 EARLY BONUS</span>' : ''}</div>
    <div class="card-content">
      <div class="card-eyebrow"><span>${state.filter === 'growing' ? '✳ GROWING NOW' : '✦ POPULAR NOW'}</span><span>PAIR AGE ${age(token.createdAt)}</span></div>
      <div class="card-title-row"><div><h2>${esc(token.name)}</h2><div class="token-symbol">$${esc(token.symbol)}</div></div><span class="change-badge ${positive ? 'up' : 'down'}"><small>24H CHANGE</small>${positive ? '↗' : '↘'} ${pct(token.change24)}</span></div>
      <div class="card-stats"><div><span>MARKET CAP</span><strong>${money(token.cap)}</strong></div><div><span>24H VOLUME</span><strong>${money(token.volume24)}</strong></div><div><span>LIQUIDITY</span><strong>${money(token.liquidity)}</strong></div></div>
      <div class="card-bottom"><span>1H MOMENTUM <b class="${token.change1 >= 0 ? 'positive' : 'negative'}">${pct(token.change1)}</b></span><div class="card-links"><a href="${esc(safeUrl(token.url))}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">CHART ↗</a></div></div>
      <div class="card-actions-row">${tradeButtons(token.address, token.symbol, true)}</div>
    </div>
    <div class="swipe-stamp nope">PASS</div><div class="swipe-stamp yep">PICKED</div>
  </article>`;
}
function insightPanel(token) {
  if (!token) return '';
  const ratio = token.buys24 + token.sells24 ? Math.round(token.buys24 / (token.buys24 + token.sells24) * 100) : 50;
  const momentum = Math.max(4, Math.min(96, 50 + token.change1 / 2));
  return `<aside class="insights">
    <div class="insight-title"><span>✳</span> THE SIGNAL <small>LIVE DATA</small></div>
    <div class="insight-card"><div class="insight-label">1H MOMENTUM <span>${token.change1 >= 0 ? '↗' : '↘'}</span></div><strong class="insight-number ${token.change1 >= 0 ? 'hot' : 'cool'}">${pct(token.change1)}</strong><p>Price change in the last hour</p><div class="momentum-meter"><span class="meter-zero"></span><span class="meter-marker" style="left:${momentum}%"></span></div><div class="meter-legend"><span>DOWN</span><span>UP</span></div></div>
    <div class="insight-card"><div class="insight-label">BUY PRESSURE <span>✦</span></div><strong class="insight-number">${ratio}<small>%</small></strong><p>${token.buys24.toLocaleString()} buys / ${token.sells24.toLocaleString()} sells (24h)</p><div class="pressure-track"><span style="width:${ratio}%"></span></div></div>
    <div class="tip-card"><img src="/assets/mascot-scout.png" alt="" /><div><strong>EARLY BIRD BONUS</strong><p>Pick a token under $1M market cap to earn 15 extra points.</p></div></div>
    <div class="data-note">Boosted tokens are promoted listings. Research every pick. Market data can change quickly.</div>
  </aside>`;
}
function huntGuide() {
  return `<section class="hunt-guide" aria-labelledby="huntGuideTitle">
    <div class="guide-heading"><div><span>✳ THE HUNT, IN THREE MOVES</span><h2 id="huntGuideTitle">Find it. Pick it. <em>Flex it.</em></h2></div><span class="guide-heading-arrow">↘</span></div>
    <div class="guide-cards">
      <article class="guide-card scout"><span class="guide-step">01 / DISCOVER</span><img src="/assets/mascot-scout.png" alt="" loading="lazy"/><div><h3>Scout the deck</h3><p>Browse growing and popular Solana memes.</p></div></article>
      <article class="guide-card heart"><span class="guide-step">02 / PICK</span><img src="/assets/mascot-heart.png" alt="" loading="lazy"/><div><h3>Trust your gut</h3><p>Slide right to save a find and earn points.</p></div></article>
      <article class="guide-card trophy"><span class="guide-step">03 / CLIMB</span><img src="/assets/mascot-trophy.png" alt="" loading="lazy"/><div><h3>Make your mark</h3><p>Spot early coins and climb the leaderboard.</p></div></article>
    </div>
  </section>`;
}
function marketPulse() {
  const deck = sortedFeed();
  const candidates = deck.filter(token => token.liquidity >= 10000 && token.change1 > 0)
    .sort((a, b) => b.change1 - a.change1);
  const mover = candidates.find(token => token.address !== deck[0]?.address) || candidates[0];
  if (!mover) return '';
  return `<section class="pulse-banner" aria-label="Live market pulse">
    <div class="pulse-copy"><span class="pulse-kicker"><i></i> LIVE FROM THE DECK / 1H MOVE</span><h2>Something's <em>taking off.</em></h2><p><strong>$${esc(mover.symbol)}</strong> has a standout one-hour move in the live feed. Momentum moves fast; check the chart before making a call.</p><a href="${esc(safeUrl(mover.url))}" target="_blank" rel="noopener noreferrer">EXPLORE THE CHART <span>↗</span></a></div>
    <div class="pulse-readout"><span>1H / PRICE MOVE</span><strong>${pct(mover.change1)}</strong><small>MARKET CAP ${money(mover.cap)}</small></div>
    <div class="pulse-planet"></div><img class="pulse-rocket" src="/assets/mascot-rocket.png" alt="" loading="lazy" />
    <span class="pulse-star one">✳</span><span class="pulse-star two">✦</span>
  </section>`;
}
function undoBar() {
  if (!state.lastSwipe) return '';
  return `<div class="undo-strip"><span><b>LAST CALL</b> ${state.lastSwipe.direction === 'right' ? 'PICKED' : 'PASSED'} $${esc(state.lastSwipe.symbol)}</span><button id="undoButton" type="button" ${state.undoing ? 'disabled' : ''}>↶ UNDO SWIPE</button></div>`;
}
function deckActions(token) {
  return `<div class="swipe-actions"><button id="passButton" class="swipe-button pass" type="button" aria-label="Pass on ${esc(token.name)}"><span>×</span><b>PASS</b></button><div class="swipe-hint">SLIDE LEFT OR RIGHT<br><kbd>←</kbd> <kbd>→</kbd></div><button id="pickButton" class="swipe-button pick" type="button" aria-label="Pick ${esc(token.name)}"><span>♥</span><b>MAKE A PICK</b></button></div>`;
}
function discover() {
  const sorted = sortedFeed(); const token = sorted[0];
  return `<section class="page-intro"><div><div class="eyebrow"><span class="eyebrow-line"></span> THE DISCOVERY DECK <span class="eyebrow-star">✳</span></div><h1>Find your next <em>meme.</em></h1><p>Swipe the chaos. Spot the early ones. Climb the ranks.</p></div><div class="intro-counter"><span>YOUR SCORE</span><strong>${Number(state.user?.points || 0).toLocaleString()} <small>PTS</small></strong><span class="counter-arrow">↗</span></div></section>
    <div class="section-toolbar"><div class="tabs" role="tablist" aria-label="Token feed"><button role="tab" aria-selected="${state.filter === 'growing'}" class="${state.filter === 'growing' ? 'selected' : ''}" data-filter="growing">✳ Growing</button><button role="tab" aria-selected="${state.filter === 'popular'}" class="${state.filter === 'popular' ? 'selected' : ''}" data-filter="popular">♨ Popular</button></div><div class="feed-status"><span></span>${feedLabel()}</div></div>
    ${state.loading || (state.filling && !token) ? `<div class="loading-panel"><img class="state-art scout-art" src="/assets/mascot-scout.png" alt="" /><h2>Scanning the chain...</h2><p>Finding the next Solana tokens. The deck keeps going.</p></div>` : state.error && !token ? `<div class="empty-panel"><img class="state-art scout-art" src="/assets/mascot-scout.png" alt="" /><h2>Market feed unavailable</h2><p>${esc(state.error)}</p><button class="primary-button" id="retryButton">TRY AGAIN ↗</button></div>` : !token ? `<div class="empty-panel"><img class="state-art scout-art" src="/assets/mascot-scout.png" alt="" /><h2>Next wave incoming.</h2><p>New coins are lining up. This live feed does not end.</p><button class="primary-button" id="reloadDeck">KEEP HUNTING ↗</button></div>` : `<div class="discovery-layout"><div class="deck-column"><div class="deck-stage">${sorted[1] ? card(sorted[1], 1) : ''}${card(token, 0)}</div>${deckActions(token)}<div class="deck-footnote">+10 POINTS PER PICK <span>✳</span> +15 FOR EARLY PICKS UNDER $1M CAP</div></div>${insightPanel(token)}</div>`}${!state.loading && !(state.filling && !token) && !(state.error && !token) ? `${undoBar()}${marketPulse()}${huntGuide()}` : ''}`;
}
function watchlist() {
  const sorted = [...state.picks].sort((a, b) => state.pickSort === 'oldest' ? a.pickedAt - b.pickedAt
    : state.pickSort === 'points' ? b.points - a.points || b.pickedAt - a.pickedAt : b.pickedAt - a.pickedAt);
  const query = state.pickQuery.trim().toLowerCase();
  const visible = sorted.filter(pick => `${pick.name} ${pick.symbol} ${pick.address}`.toLowerCase().includes(query));
  const pickCards = visible.map((pick, i) => {
    const current = state.feed.find(x => x.address === pick.address);
    const gain = current && pick.entryPrice ? (current.price / pick.entryPrice - 1) * 100 : null;
    return `<article class="pick-row" data-search="${esc(`${pick.name} ${pick.symbol} ${pick.address}`.toLowerCase())}"><span class="pick-rank">${String(i + 1).padStart(2, '0')}</span>${tokenArt(pick, 'pick-art')}<div class="pick-name"><strong>${esc(pick.name)}</strong><span>$${esc(pick.symbol)} · PICKED ${new Date(pick.pickedAt).toLocaleDateString()}</span></div><div class="pick-metric"><small>ENTRY CAP</small><strong>${money(pick.entryCap)}</strong></div><div class="pick-metric"><small>POINTS EARNED</small><strong class="hot">+${pick.points}</strong></div><div class="pick-metric"><small>SINCE PICK</small><strong class="${gain === null ? '' : gain >= 0 ? 'up-text' : 'down-text'}">${gain === null ? '—' : pct(gain)}</strong></div><button class="pick-intel" data-intel="${esc(pick.address)}" aria-label="View ${esc(pick.name)} details">INFO</button><div class="pick-actions">${tradeButtons(pick.address, pick.symbol)}</div><a class="row-link" href="https://dexscreener.com/solana/${esc(pick.address)}" target="_blank" rel="noopener noreferrer" aria-label="View ${esc(pick.name)} chart">↗</a></article>`;
  }).join('');
  return `<section class="page-intro subpage"><div><div class="eyebrow"><span class="eyebrow-line"></span> YOUR CALLS</div><h1>My <em>picks.</em></h1><p>Every pick, with buy and sell once your wallet is connected.</p></div><div class="intro-counter"><span>TOTAL PICKS</span><strong>${state.picks.length}</strong><span class="counter-arrow">♡</span></div></section>${state.picks.length ? `<div class="picks-tools"><label class="pick-search"><span>⌕</span><input id="pickSearch" type="search" placeholder="Search your picks" aria-label="Search your picks" value="${esc(state.pickQuery)}" /></label><select id="pickSort" aria-label="Sort your picks"><option value="newest" ${state.pickSort === 'newest' ? 'selected' : ''}>Newest first</option><option value="oldest" ${state.pickSort === 'oldest' ? 'selected' : ''}>Oldest first</option><option value="points" ${state.pickSort === 'points' ? 'selected' : ''}>Most points</option></select><span id="pickResults">${visible.length} FOUND</span></div><div class="list-heading"><span>TOKEN</span><span>ENTRY CAP</span><span>POINTS</span><span>SINCE PICK*</span></div><div id="pickListBody" class="pick-list">${pickCards}</div><div id="pickNoResults" class="pick-no-results" ${visible.length ? 'hidden' : ''}>No picks match that search. Try another name or symbol.</div><p class="list-note">*Change is shown only while a token remains in the current feed. Points are awarded when picked; this prototype does not award later performance bonuses.</p>` : `<div class="empty-panel picks-empty"><img class="state-art heart-art" src="/assets/mascot-heart.png" alt="" /><h2>No picks yet.</h2><p>Your favorite finds will appear here after a right swipe.</p><button class="primary-button" data-view="discover">START SWIPING ↗</button></div>`}`;
}
function leaderboard() {
  const leaders = state.leaders;
  return `<section class="page-intro subpage"><div><div class="eyebrow"><span class="eyebrow-line"></span> HALL OF FLAME</div><h1>The <em>leaderboard.</em></h1><p>The sharpest meme hunters on this app instance.</p></div><div class="intro-counter"><span>YOUR SCORE</span><strong>${Number(state.user?.points || 0).toLocaleString()} <small>PTS</small></strong><span class="counter-arrow">♛</span></div></section>
    <div class="leaderboard-hero"><div><span class="hero-kicker">✳ THE RULES OF THE HUNT</span><h2>Good taste earns<br/><em>bragging rights.</em></h2><p>Get 10 points for each pick. Find it under $1M market cap and get 15 more.</p></div><div class="hero-mascot"><img src="/assets/mascot-trophy.png" alt="Flame mascot lifting a trophy" /></div></div>
    <div class="leaderboard-heading"><span>RANK / HUNTER</span><span>PICKS</span><span>POINTS</span></div><div class="leaderboard-list">${leaders.map(x => `<div class="leader-row ${x.id === userId ? 'you' : ''}"><div class="leader-identity"><span class="leader-rank ${x.rank <= 3 ? 'medal' : ''}">${String(x.rank).padStart(2, '0')}</span><span class="leader-avatar">${esc(x.handle[0].toUpperCase())}</span><span><strong>${esc(x.handle)} ${x.id === userId ? '<b class="you-tag">YOU</b>' : ''}</strong><small>MEME HUNTER</small></span></div><span class="leader-picks">${x.picks}</span><strong class="leader-points">${x.points.toLocaleString()} <small>PTS</small></strong></div>`).join('')}</div><p class="list-note">Leaderboard uses profiles saved on this server. Hunter names are editable, and points reflect picks made here.</p>`;
}
function render() {
  $('#appMain').dataset.view = state.view;
  $('#appMain').innerHTML = state.view === 'discover' ? discover() : state.view === 'watchlist' ? watchlist() : leaderboard();
  updateChrome();
  if (state.view === 'discover' && !state.loading && !state.error) attachDrag();
}
function setView(view) { state.view = view; render(); if (view === 'leaderboard') loadLeaderboard(); if (view === 'discover') ensureDeck(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
async function swipe(direction) {
  if (state.animating || state.view !== 'discover') return;
  const cardEl = $('.swipe-card:not(.peek-card)');
  const token = state.feed.find(item => item.address === cardEl?.dataset.address);
  if (!token) return;
  state.dragging = false;
  state.animating = true;
  cardEl?.classList.add(direction === 'right' ? 'fly-right' : 'fly-left');
  try {
    const result = await api('/api/swipe', { method: 'POST', body: JSON.stringify({ userId, address: token.address, direction }) });
    await new Promise(resolve => setTimeout(resolve, 180));
    state.user = { ...result.user, handle: state.user?.handle || result.user.handle };
    setSwipeHistory([...state.swipes, result.swipe]);
    rememberProfile();
    if (direction === 'right') toast(`+${result.swipe.points} points! ${token.symbol} is in your picks. Buy or sell it there anytime.`);
    else toast(`${token.symbol} passed. On to the next one.`);
    render();
  } catch (error) { cardEl?.classList.remove('fly-right', 'fly-left'); if (cardEl) cardEl.style.transform = ''; toast(error.message); }
  state.animating = false;
  if (state.renderAfterSwipe) { state.renderAfterSwipe = false; render(); }
  if (sortedFeed().length < 8) ensureDeck();
}
async function undoSwipe() {
  if (!state.lastSwipe || state.animating || state.undoing) return;
  state.undoing = true;
  const address = state.lastSwipe.address;
  const removed = state.lastSwipe;
  render();
  try { await api('/api/swipe/undo', { method: 'POST', body: JSON.stringify({ userId, address }) }); }
  catch { /* browser history remains authoritative if the server instance changed */ }
  setSwipeHistory(state.swipes.slice(0, -1));
  rememberProfile();
  toast(`Last swipe undone. $${removed.symbol} is back in the deck.`);
  state.undoing = false;
  render();
}
let detachDrag = () => {};
function attachDrag() {
  detachDrag();
  detachDrag = () => {};
  const cardEl = $('.swipe-card:not(.peek-card)');
  if (!cardEl) return;
  let pointer = null;
  const resetCard = () => {
    cardEl.classList.remove('dragging', 'drag-right', 'drag-left');
    cardEl.style.transform = '';
  };
  const stopTracking = () => {
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    pointer = null;
    state.dragging = false;
  };
  detachDrag = () => { stopTracking(); };
  function finish(commit, event) {
    if (!pointer) return;
    const tracked = pointer;
    if (event) {
      tracked.dx = event.clientX - tracked.x;
      tracked.dy = event.clientY - tracked.y;
      if (Math.abs(tracked.dx) >= 16 && Math.abs(tracked.dx) > Math.abs(tracked.dy)) tracked.locked = true;
    }
    stopTracking();
    if (Math.abs(tracked.dx) > 8) {
      state.blockSwipeClick = true;
      setTimeout(() => { state.blockSwipeClick = false; }, 400);
    }
    const commitDistance = Math.max(72, cardEl.clientWidth * 0.18);
    const armed = commit && tracked.locked && Math.abs(tracked.dx) >= commitDistance && Math.abs(tracked.dx) > Math.abs(tracked.dy);
    if (armed) {
      cardEl.classList.remove('dragging', 'drag-right', 'drag-left');
      swipe(tracked.dx > 0 ? 'right' : 'left');
      return;
    }
    resetCard();
    try { cardEl.releasePointerCapture(tracked.id); } catch { /* capture may already be gone */ }
    if (state.renderAfterSwipe) { state.renderAfterSwipe = false; render(); }
  }
  function onUp(event) { if (pointer && event.pointerId === pointer.id) finish(true, event); }
  function onCancel(event) { if (pointer && event.pointerId === pointer.id) finish(false); }
  cardEl.addEventListener('pointerdown', event => {
    if (state.animating || event.target.closest('a, button')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, locked: false };
    state.dragging = true;
    try { cardEl.setPointerCapture(event.pointerId); } catch { /* pointer may already be gone */ }
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  });
  cardEl.addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id || state.animating) return;
    pointer.dx = event.clientX - pointer.x;
    pointer.dy = event.clientY - pointer.y;
    if (!pointer.locked) {
      if (Math.abs(pointer.dy) > 16 && Math.abs(pointer.dy) > Math.abs(pointer.dx)) { finish(false); return; }
      if (Math.abs(pointer.dx) < 16 || Math.abs(pointer.dx) <= Math.abs(pointer.dy)) return;
      pointer.locked = true;
      cardEl.classList.add('dragging');
    }
    cardEl.style.transform = `translate(${pointer.dx}px, 0px) rotate(${pointer.dx / 28}deg)`;
    cardEl.classList.toggle('drag-right', pointer.dx > 72);
    cardEl.classList.toggle('drag-left', pointer.dx < -72);
  });
}

function openIntel(address) {
  intelState.token = state.feed.find(item => item.address === address) || state.picks.find(item => item.address === address);
  if (!intelState.token) return toast('Coin details are unavailable. Refresh the deck.');
  renderIntel(); $('#intelDialog').showModal();
}
function renderIntel() {
  const token = intelState.token; if (!token) return;
  const live = state.feed.find(item => item.address === token.address);
  const current = live || token;
  const buys = Number(live?.buys24 || 0), sells = Number(live?.sells24 || 0);
  const buyShare = buys + sells ? Math.round(buys / (buys + sells) * 100) : 0;
  const chart = safeUrl(current.url || `https://dexscreener.com/solana/${token.address}`);
  const socials = (live?.socials || []).map(item => {
    const url = safeUrl(item.url);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(String(item.type || 'LINK').toUpperCase())} ↗</a>` : '';
  }).join('');
  $('#intelContent').innerHTML = `<div class="intel-head">${tokenArt(current, 'intel-art')}<div><span class="intel-live"><i></i>${live ? 'CURRENT FEED' : 'SAVED PICK'}</span><h2>${esc(token.name)}</h2><small>$${esc(token.symbol)} · SOLANA</small></div></div>
    <div class="intel-price"><span>${live ? 'PRICE / USD' : 'PICK ENTRY PRICE / USD'}</span><strong>${price(live?.price || token.entryPrice)}</strong><span class="${live ? live.change24 >= 0 ? 'up-text' : 'down-text' : ''}">${live ? pct(live.change24) + ' / 24H' : 'LATEST PRICE UNAVAILABLE'}</span></div>
    <div class="intel-grid"><div><span>MARKET CAP</span><strong>${current.cap || token.entryCap ? money(current.cap || token.entryCap) : '—'}</strong></div><div><span>LIQUIDITY</span><strong>${live ? money(live.liquidity) : '—'}</strong></div><div><span>24H VOLUME</span><strong>${live ? money(live.volume24) : '—'}</strong></div><div><span>PAIR AGE</span><strong>${live ? age(live.createdAt) : '—'}</strong></div></div>
    ${live ? `<div class="intel-activity"><div><span>24H ACTIVITY</span><strong>${buys.toLocaleString()} BUYS <b>/</b> ${sells.toLocaleString()} SELLS</strong></div><div class="intel-activity-track"><span style="width:${buyShare}%"></span></div></div>` : '<p class="intel-unavailable">This pick is not in the current feed, so live market stats are unavailable.</p>'}
    <div class="intel-mint"><span>TOKEN MINT</span><div><code>${esc(token.address)}</code><button id="copyMint" type="button">COPY</button></div></div>
    ${socials ? `<div class="intel-socials">${socials}</div>` : ''}
    <div class="intel-actions"><a href="${esc(chart)}" target="_blank" rel="noopener noreferrer">VIEW CHART ↗</a><button class="trade" data-trade="${esc(token.address)}" type="button">TRADE</button><button data-buy="${esc(token.address)}" type="button">BUY</button><button class="sell" data-sell="${esc(token.address)}" type="button">SELL</button></div>
    <p class="trade-footnote">Boosted listings are promoted. Prices and activity can change quickly; verify the token mint and research before trading.</p>`;
}

function isSolanaWallet(wallet) {
  const features = wallet?.features || {};
  const solana = (wallet?.chains || []).some(chain => String(chain).startsWith('solana'));
  return Boolean(solana && features['standard:connect'] && (features['solana:signTransaction'] || features['solana:signAndSendTransaction']));
}
function solanaAccount(accounts = []) {
  return accounts.find(account => !account.chains?.length || account.chains.some(chain => String(chain).startsWith('solana'))) || null;
}
function walletIcon(wallet) {
  const icon = wallet.icon || '';
  if (icon.startsWith('data:image/')) return icon;
  return safeUrl(icon);
}
function availableWallets() {
  const ranked = [...walletState.wallets].filter(isSolanaWallet);
  const byName = new Map();
  for (const wallet of ranked) {
    const existing = byName.get(wallet.name);
    if (!existing || (existing.legacy && !wallet.legacy)) byName.set(wallet.name, wallet);
  }
  return [...byName.values()];
}
function renderWalletChoices() {
  const choices = availableWallets();
  const icon = wallet => { const src = walletIcon(wallet); return src ? `<img src="${esc(src)}" alt="" />` : '✳'; };
  $('#walletChoices').innerHTML = `${walletState.account ? `<div class="connected-wallet"><span class="wallet-check">✓</span><div><strong>${esc(walletState.wallet.name)}</strong><small>${esc(shortAddress(walletState.account.address))} · SOLANA MAINNET</small></div><button id="disconnectWallet" type="button">DISCONNECT</button></div>` : ''}
    ${walletState.connecting ? '<p class="wallet-status">Waiting for approval in your wallet…</p>' : ''}
    ${walletState.error ? `<div class="trade-error" role="alert">${esc(walletState.error)}</div>` : ''}
    ${choices.length ? choices.map((wallet, index) => `<button type="button" class="wallet-choice" data-wallet-index="${index}" ${walletState.connecting ? 'disabled' : ''}><span class="wallet-choice-icon">${icon(wallet)}</span><span>${esc(wallet.name)}</span><b>↗</b></button>`).join('') : '<div class="wallet-empty"><img src="/assets/mascot-scout.png" alt="" /><strong>No wallet found here</strong><p>Install a Solana wallet, then scan again. Phantom and Solflare both work.</p><div class="wallet-install"><a href="https://phantom.app/download" target="_blank" rel="noopener noreferrer">GET PHANTOM ↗</a><a href="https://solflare.com/download" target="_blank" rel="noopener noreferrer">GET SOLFLARE ↗</a></div></div>'}
    <button id="rescanWallets" type="button" class="wallet-rescan">SCAN AGAIN</button>`;
}
function registerWallet(...wallets) {
  for (const wallet of wallets) {
    walletState.wallets.add(wallet);
    restoreWallet(wallet);
  }
  if ($('#walletDialog').open) renderWalletChoices();
  return () => { for (const wallet of wallets) walletState.wallets.delete(wallet); if ($('#walletDialog').open) renderWalletChoices(); };
}
function adoptWallet(wallet, account) {
  walletState.unsubscribe?.();
  walletState.wallet = wallet;
  walletState.account = account;
  walletState.connecting = false;
  walletState.error = '';
  localStorage.setItem('date-wallet', wallet.name);
  const off = wallet.features['standard:events']?.on?.('change', event => {
    if (!event.accounts) return;
    const next = solanaAccount(event.accounts);
    if (!next) { clearWallet(); toast('Wallet disconnected.'); return; }
    const changed = next.address !== walletState.account?.address;
    walletState.account = next;
    if (!changed) return;
    buyState.quote = null;
    buyState.balance = null;
    updateChrome();
    if ($('#buyDialog').open) { renderBuy(); loadTradeBalance(); }
    else if ($('#walletDialog').open) renderWalletChoices();
  });
  walletState.unsubscribe = typeof off === 'function' ? off : null;
  updateChrome();
}
async function restoreWallet(wallet) {
  if (walletState.account || walletState.connecting || !isSolanaWallet(wallet)) return;
  if (localStorage.getItem('date-wallet') !== wallet.name) return;
  walletState.connecting = true;
  updateChrome();
  try {
    const result = await wallet.features['standard:connect'].connect({ silent: true });
    const account = solanaAccount(result.accounts);
    if (!account?.address) throw new Error('Not connected');
    adoptWallet(wallet, account);
  } catch {
    walletState.connecting = false;
    updateChrome();
  }
}
function clearWallet() {
  walletState.unsubscribe?.(); walletState.unsubscribe = null;
  walletState.wallet = null; walletState.account = null; walletState.connecting = false;
  localStorage.removeItem('date-wallet');
  buyState.quote = null; buyState.balance = null;
  updateChrome(); renderWalletChoices();
  if ($('#buyDialog').open) renderBuy();
}
async function connectWallet(wallet) {
  if (walletState.connecting) return;
  walletState.connecting = true;
  walletState.error = '';
  updateChrome();
  renderWalletChoices();
  try {
    const result = await wallet.features['standard:connect'].connect();
    const account = solanaAccount(result.accounts);
    if (!account?.address) throw new Error('This wallet has no Solana account.');
    adoptWallet(wallet, account);
    $('#walletDialog').close();
    toast(`${wallet.name} connected: ${shortAddress(account.address)}`);
    if (buyState.token) { renderBuy(); $('#buyDialog').showModal(); loadTradeBalance(); }
  } catch (error) {
    walletState.connecting = false;
    walletState.error = walletRejection(error, 'Could not connect wallet.');
    updateChrome();
    renderWalletChoices();
    toast(walletState.error);
  }
}
let web3Promise;
function solanaWeb3() { web3Promise ||= import('https://esm.sh/@solana/web3.js@1.98.4'); return web3Promise; }
function legacyAccount(key) {
  const address = typeof key?.toBase58 === 'function' ? key.toBase58() : String(key || '');
  return { address, publicKey: key?.toBytes?.() || new Uint8Array(), chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
}
function legacyWallet(provider, name) {
  const features = {
    'standard:connect': {
      connect: async ({ silent } = {}) => {
        if (silent && !provider.isConnected && !provider.publicKey) throw new Error('Not connected');
        const response = silent ? { publicKey: provider.publicKey } : await provider.connect();
        const key = response?.publicKey || provider.publicKey;
        if (!key) throw new Error('This wallet has no Solana account.');
        return { accounts: [legacyAccount(key)] };
      }
    },
    'standard:disconnect': { disconnect: () => provider.disconnect?.() },
    'solana:signTransaction': {
      signTransaction: async ({ transaction }) => {
        const { VersionedTransaction } = await solanaWeb3();
        const signed = await provider.signTransaction(VersionedTransaction.deserialize(transaction));
        const bytes = signed.serialize();
        return [{ signedTransaction: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }];
      }
    }
  };
  if (provider.signAndSendTransaction) {
    features['solana:signAndSendTransaction'] = {
      signAndSendTransaction: async ({ transaction }) => {
        const { VersionedTransaction } = await solanaWeb3();
        const result = await provider.signAndSendTransaction(VersionedTransaction.deserialize(transaction));
        return [{ signature: result?.signature || result }];
      }
    };
  }
  return { name, icon: typeof provider.icon === 'string' ? provider.icon : '', chains: ['solana:mainnet'], features, legacy: true };
}
function scanLegacyWallets() {
  const found = [['Phantom', window.phantom?.solana], ['Solflare', window.solflare], ['Backpack', window.backpack], ['Solana', window.solana]];
  for (const [fallback, provider] of found) {
    if (!provider?.connect || walletState.legacySeen.has(provider)) continue;
    if (fallback === 'Solana' && (provider.isPhantom || provider.isSolflare || provider.isBackpack)) continue;
    walletState.legacySeen.add(provider);
    const name = provider.isPhantom ? 'Phantom' : provider.isSolflare ? 'Solflare' : provider.isBackpack ? 'Backpack' : fallback;
    registerWallet(legacyWallet(provider, name));
  }
}
function refreshWallets() {
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: registerWallet } }));
  scanLegacyWallets();
  renderWalletChoices();
}
function openTrade(address, side = 'buy') {
  const token = state.feed.find(item => item.address === address) || state.picks.find(item => item.address === address);
  if (!token) return toast('Coin details are unavailable. Refresh the deck.');
  buyState.token = token;
  buyState.side = side === 'sell' ? 'sell' : 'buy';
  buyState.amount = buyState.side === 'sell' ? '' : (buyState.amount && buyState.amount !== '' ? buyState.amount : '0.05');
  if (buyState.side === 'buy' && !/^(?:0|[1-9]\d{0,1})(?:\.\d{1,9})?$/.test(buyState.amount)) buyState.amount = '0.05';
  buyState.quote = null; buyState.error = ''; buyState.signature = ''; buyState.status = '';
  buyState.balance = null; buyState.balanceError = '';
  if (!walletState.account) { walletState.error = ''; refreshWallets(); $('#walletDialog').showModal(); return; }
  renderBuy(); $('#buyDialog').showModal(); loadTradeBalance();
}
function quoteFresh() {
  return Boolean(buyState.quote && buyState.quote.side === buyState.side && Date.now() < buyState.quote.expiresAt);
}
function balanceLine() {
  if (!walletState.account) return '';
  if (buyState.balanceError) return 'Wallet balance unavailable. You can still request a quote.';
  if (!buyState.balance) return 'Checking wallet…';
  const sol = solDisplay(buyState.balance.solLamports);
  if (buyState.side === 'sell') {
    const held = buyState.balance.decimals == null ? '0' : trimAmount(plainUnits(buyState.balance.tokenAmount, buyState.balance.decimals));
    return `WALLET $${esc(buyState.token.symbol)} ${esc(held)} · ${esc(sol)} SOL`;
  }
  return `WALLET ${esc(sol)} SOL`;
}
async function loadTradeBalance() {
  const token = buyState.token;
  const owner = walletState.account?.address;
  if (!token || !owner) return;
  const request = ++buyState.balanceRequest;
  try {
    const balance = await api(`/api/wallet/balances?owner=${encodeURIComponent(owner)}&mint=${encodeURIComponent(token.address)}`);
    if (buyState.balanceRequest !== request || buyState.token?.address !== token.address) return;
    buyState.balance = balance;
    buyState.balanceError = '';
  } catch (error) {
    if (buyState.balanceRequest !== request) return;
    buyState.balanceError = error.message;
  }
  if ($('#buyDialog').open && document.activeElement?.id !== 'tradeAmount') renderBuy();
  else if ($('#walletBalance')) $('#walletBalance').textContent = balanceLine();
}
function renderBuy() {
  const token = buyState.token; if (!token) return;
  const selling = buyState.side === 'sell';
  const quote = buyState.quote;
  const fresh = quoteFresh();
  const output = quote ? formatUnits(quote.outputAmount, quote.decimals) : '—';
  const impact = quote?.priceImpactPct == null ? '—' : `${Number(quote.priceImpactPct).toFixed(2)}%`;
  const receiveSymbol = selling ? '◎ SOL' : `$${esc(token.symbol)}`;
  const minimum = quote?.minimumOutputAmount ? `${esc(formatUnits(quote.minimumOutputAmount, quote.decimals))} ${receiveSymbol}` : 'See wallet confirmation';
  const noTokens = selling && buyState.balance && BigInt(buyState.balance.tokenAmount || '0') === 0n;
  const presets = selling
    ? `<div class="amount-presets"><button type="button" data-percent="25" ${buyState.busy ? 'disabled' : ''}>25%</button><button type="button" data-percent="50" ${buyState.busy ? 'disabled' : ''}>50%</button><button type="button" data-percent="100" ${buyState.busy ? 'disabled' : ''}>MAX</button></div>`
    : `<div class="amount-presets"><button type="button" data-amount="0.01">0.01 SOL</button><button type="button" data-amount="0.05">0.05 SOL</button><button type="button" data-amount="0.1">0.1 SOL</button></div>`;
  $('#buyContent').innerHTML = `<div class="buy-token-head">${tokenArt(token, 'buy-token-art')}<div><span>${selling ? 'SELLING' : 'BUYING'}</span><h2>${esc(token.name)}</h2><small>$${esc(token.symbol)} · <a href="https://solscan.io/token/${esc(token.address)}" target="_blank" rel="noopener noreferrer" title="View full token address on Solscan">${esc(shortAddress(token.address))} ↗</a></small></div></div>
    <div class="trade-tabs" role="tablist"><button type="button" data-side="buy" class="${selling ? '' : 'selected'}" ${buyState.busy ? 'disabled' : ''}>BUY</button><button type="button" data-side="sell" class="${selling ? 'selected' : ''}" ${buyState.busy ? 'disabled' : ''}>SELL</button></div>
    ${buyState.signature ? `<div class="trade-success"><img src="/assets/mascot-heart.png" alt="" /><strong>${selling ? 'Sell sent!' : 'Buy sent!'}</strong><p>Check its status on Solscan. Balances can take a moment to update in your wallet.</p><a href="https://solscan.io/tx/${esc(buyState.signature)}" target="_blank" rel="noopener noreferrer">VIEW TRANSACTION ↗</a></div>` : `<div class="trade-body">
      <p id="walletBalance" class="wallet-balance">${balanceLine()}</p>
      <div class="trade-label"><span>YOU PAY</span><span>SOLANA MAINNET</span></div>
      <div class="amount-field"><input id="tradeAmount" type="text" inputmode="decimal" value="${esc(buyState.amount)}" placeholder="0.00" aria-label="${selling ? 'Token amount' : 'Amount in SOL'}" ${buyState.busy ? 'disabled' : ''}/><span class="sol-chip">${selling ? `$${esc(token.symbol)}` : '◎ SOL'}</span></div>
      ${presets}
      <div class="swap-divider">↓</div>
      <div class="trade-label"><span>ESTIMATED RECEIVE</span><span>TO ${esc(shortAddress(walletState.account?.address || ''))}</span></div>
      <div class="receive-field"><strong>${esc(output)}</strong><span>${receiveSymbol}</span></div>
      ${quote ? `<div class="quote-details"><div><span>MINIMUM RECEIVE</span><strong>${minimum}</strong></div><div><span>PRICE IMPACT</span><strong>${impact}</strong></div><div><span>JUPITER FEE</span><strong>${Number(quote.feeBps || 0) / 100}%</strong></div><div><span>EST. TRANSACTION FEES</span><strong>~${((Number(quote.signatureFeeLamports || 0) + Number(quote.prioritizationFeeLamports || 0) + Number(quote.rentFeeLamports || 0)) / 1e9).toFixed(6)} SOL</strong></div></div><p class="quote-expiry ${fresh ? '' : 'expired'}">${fresh ? 'Quote is ready. Review it, then approve in your wallet.' : 'Quote expired. Get a fresh one before confirming.'}</p>` : `<p class="quote-expiry">${noTokens ? 'This wallet does not hold this token yet. Buy it here first, then you can sell it back to SOL.' : 'Get a live Jupiter quote to see the estimated amount and fees.'}</p>`}
      ${buyState.error ? `<div class="trade-error" role="alert">${esc(buyState.error)}</div>` : ''}
      <button id="buyPrimary" class="primary-button trade-primary" type="button" ${buyState.busy || noTokens ? 'disabled' : ''}>${buyState.busy ? esc(buyState.status) : fresh ? `CONFIRM ${selling ? 'SELL' : 'BUY'} IN WALLET ↗` : 'GET LIVE QUOTE ↗'}</button>
      <p class="trade-footnote">Memecoins are volatile. Picks earn app points. Buying and selling move real tokens, and your wallet shows the final transaction before anything is sent.</p>
    </div>`}`;
}
async function getBuyQuote() {
  if (buyState.busy || !walletState.account) return;
  const amount = $('#tradeAmount').value.trim();
  const selling = buyState.side === 'sell';
  if (selling) {
    if (!/^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) {
      buyState.error = 'Enter how many tokens you want to sell.'; renderBuy(); return;
    }
  } else if (!/^(?:0|[1-9]\d{0,1})(?:\.\d{1,9})?$/.test(amount) || Number(amount) < .001 || Number(amount) > 10) {
    buyState.error = 'Enter an amount from 0.001 to 10 SOL.'; renderBuy(); return;
  }
  buyState.amount = amount; buyState.error = ''; buyState.busy = true; buyState.status = 'FINDING A ROUTE…'; renderBuy();
  try {
    buyState.quote = await api('/api/buy/order', { method: 'POST', body: JSON.stringify({ tokenMint: buyState.token.address, outputMint: buyState.token.address, side: buyState.side, amount, amountSol: selling ? undefined : amount, amountToken: selling ? amount : undefined, taker: walletState.account.address, userId }) });
  } catch (error) { buyState.error = error.message; buyState.quote = null; }
  buyState.busy = false; renderBuy();
}
async function signSwapTransaction(transactionBase64) {
  const wallet = walletState.wallet;
  const account = walletState.account;
  const chain = account.chains?.find(item => String(item).startsWith('solana:')) || 'solana:mainnet';
  const bytes = bytesFromBase64(transactionBase64);
  const sign = wallet.features['solana:signTransaction'];
  if (sign) {
    const result = await sign.signTransaction({ transaction: bytes, account, chain });
    const signed = result?.[0]?.signedTransaction;
    if (!(signed instanceof Uint8Array)) throw new Error('Wallet did not return a signed transaction.');
    return { signedTransaction: bytesToBase64(signed) };
  }
  const send = wallet.features['solana:signAndSendTransaction'];
  if (!send) throw new Error('This wallet cannot sign Solana transactions.');
  const result = await send.signAndSendTransaction({ transaction: bytes, account, chain });
  const signature = signatureText(result?.[0]?.signature);
  if (!signature) throw new Error('Wallet did not return a signature.');
  return { signature };
}
async function executeBuy() {
  if (buyState.busy || !quoteFresh() || !walletState.account) return;
  const quote = buyState.quote;
  buyState.busy = true; buyState.error = ''; buyState.status = 'WAITING FOR WALLET…'; renderBuy();
  try {
    const signed = await signSwapTransaction(quote.transaction);
    if (signed.signature) buyState.signature = signed.signature;
    else {
      buyState.status = 'SENDING SWAP…'; renderBuy();
      const execution = await api('/api/buy/execute', { method: 'POST', body: JSON.stringify({ requestId: quote.requestId, signedTransaction: signed.signedTransaction }) });
      if (execution.status !== 'Success' || !execution.signature) throw new Error(execution.error || 'Swap was not confirmed. Check your wallet activity before retrying.');
      buyState.signature = execution.signature;
    }
  } catch (error) { buyState.error = walletRejection(error, 'Swap failed. Check your wallet activity before retrying.'); }
  buyState.busy = false; renderBuy();
}
setInterval(() => { if ($('#buyDialog').open && buyState.quote && !quoteFresh() && !buyState.busy && !buyState.signature) renderBuy(); }, 5000);

document.addEventListener('click', e => {
  const close = e.target.closest('[data-close-dialog]');
  if (close) { close.closest('dialog')?.close(); return; }
  const intel = e.target.closest('[data-intel]');
  if (intel) { e.stopPropagation(); openIntel(intel.dataset.intel); return; }
  const trade = e.target.closest('[data-trade], [data-buy], [data-sell]');
  if (trade) {
    e.stopPropagation();
    if ($('#intelDialog').open) $('#intelDialog').close();
    openTrade(trade.dataset.trade || trade.dataset.buy || trade.dataset.sell, trade.hasAttribute('data-sell') ? 'sell' : 'buy');
    return;
  }
  if (e.target.closest('#undoButton')) { undoSwipe(); return; }
  if (e.target.closest('#copyMint')) {
    if (intelState.token && navigator.clipboard?.writeText) navigator.clipboard.writeText(intelState.token.address).then(() => toast('Token mint copied.')).catch(() => toast('Could not copy the token mint.'));
    else toast('Clipboard access is unavailable in this browser.');
    return;
  }
  if (e.target.closest('#walletButton')) { buyState.token = null; walletState.error = ''; refreshWallets(); $('#walletDialog').showModal(); return; }
  if (e.target.closest('#rescanWallets')) { refreshWallets(); return; }
  const choice = e.target.closest('[data-wallet-index]');
  if (choice) { const wallet = availableWallets()[Number(choice.dataset.walletIndex)]; if (wallet) connectWallet(wallet); return; }
  if (e.target.closest('#disconnectWallet')) {
    Promise.resolve(walletState.wallet?.features?.['standard:disconnect']?.disconnect()).catch(() => {}).finally(() => { clearWallet(); $('#walletDialog').close(); toast('Wallet disconnected.'); });
    return;
  }
  const sideButton = e.target.closest('[data-side]');
  if (sideButton && $('#buyDialog').open) {
    const side = sideButton.dataset.side === 'sell' ? 'sell' : 'buy';
    if (buyState.busy || side === buyState.side) return;
    buyState.side = side;
    buyState.amount = side === 'sell' ? '' : '0.05';
    buyState.quote = null; buyState.error = ''; buyState.signature = '';
    renderBuy();
    return;
  }
  const preset = e.target.closest('[data-amount], [data-percent]');
  if (preset && $('#buyDialog').open) {
    if (preset.dataset.percent) {
      const balance = buyState.balance;
      if (!balance || balance.decimals == null) return;
      const raw = BigInt(balance.tokenAmount || '0') * BigInt(preset.dataset.percent) / 100n;
      if (raw <= 0n) return;
      buyState.amount = plainUnits(raw.toString(), balance.decimals);
    } else buyState.amount = preset.dataset.amount;
    buyState.quote = null; buyState.error = ''; buyState.signature = '';
    renderBuy();
    return;
  }
  if (e.target.closest('#buyPrimary')) { if (quoteFresh()) executeBuy(); else getBuyQuote(); return; }
  const view = e.target.closest('a[data-view], button[data-view]');
  if (view) { e.preventDefault(); setView(view.dataset.view); return; }
  const filter = e.target.closest('[data-filter]');
  if (filter) { state.filter = filter.dataset.filter; render(); return; }
  if (state.blockSwipeClick && e.target.closest('#passButton, #pickButton')) return;
  if (e.target.closest('#passButton')) { swipe('left'); return; }
  if (e.target.closest('#pickButton')) { swipe('right'); return; }
  if (e.target.closest('#retryButton') || e.target.closest('#reloadDeck') || e.target.closest('#refreshButton')) loadFeed(true);
  if (e.target.closest('#profileButton, #topAvatar')) { $('#handleInput').value = state.user?.handle || ''; $('#profileDialog').showModal(); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'pickSearch') {
    state.pickQuery = e.target.value;
    const query = state.pickQuery.trim().toLowerCase();
    let found = 0;
    document.querySelectorAll('.pick-row').forEach(row => { row.hidden = !row.dataset.search.includes(query); if (!row.hidden) row.querySelector('.pick-rank').textContent = String(++found).padStart(2, '0'); });
    $('#pickResults').textContent = `${found} FOUND`;
    $('#pickNoResults').hidden = found > 0;
    return;
  }
  if (e.target.id !== 'tradeAmount') return;
  buyState.amount = e.target.value; buyState.quote = null; buyState.error = '';
  const button = $('#buyPrimary'); if (button) button.textContent = 'GET LIVE QUOTE ↗';
  const receive = $('.receive-field strong'); if (receive) receive.textContent = '—';
  const details = $('.quote-details'); if (details) details.remove();
  const expiry = $('.quote-expiry'); if (expiry) expiry.textContent = buyState.side === 'sell' ? 'Get a live Jupiter quote to see the estimated SOL and fees.' : 'Get a live Jupiter quote to see the estimated tokens and fees.';
});
document.addEventListener('change', e => {
  if (e.target.id === 'pickSort') { state.pickSort = e.target.value; render(); }
});
document.addEventListener('keydown', e => {
  if ($('#profileDialog').open || $('#walletDialog').open || $('#buyDialog').open || $('#intelDialog').open || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.repeat) return;
  if (e.key === 'ArrowLeft') swipe('left');
  if (e.key === 'ArrowRight') swipe('right');
});
$('#buyDialog').addEventListener('close', () => { buyState.token = null; buyState.quote = null; });
$('#intelDialog').addEventListener('close', () => { intelState.token = null; });
$('#profileForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const handle = $('#handleInput').value.trim(); if (!handle) return;
  try {
    const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ id: userId, handle }) });
    state.user = { ...data.user, points: state.user?.points || 0 }; localStorage.setItem('date-handle', data.user.handle); rememberProfile(); $('#profileDialog').close(); render(); if (state.view === 'leaderboard') loadLeaderboard(); toast('Hunter profile updated.');
  } catch (error) { toast(error.message); }
});

window.__dateOnWallet = event => {
  if (typeof event.detail === 'function') event.detail({ register: registerWallet });
};
for (const event of window.__dateWallets || []) window.__dateOnWallet(event);
window.__dateWallets = [];
refreshWallets();
let walletScans = 0;
const walletScan = setInterval(() => { scanLegacyWallets(); if (++walletScans > 20) clearInterval(walletScan); }, 500);
render();
renderWalletChoices();
loadProfile().catch(() => restoreProfile()).then(() => loadFeed());
