const $ = selector => document.querySelector(selector);
const state = { view: 'discover', filter: 'growing', feed: [], picks: [], seen: new Set(), user: null, loading: true, error: '', updatedAt: 0, stale: false, leaders: [], animating: false, undoing: false, lastSwipe: null, pickQuery: '', pickSort: 'newest' };
const walletState = { wallet: null, account: null, wallets: new Set(), unsubscribe: null, connecting: false };
const buyState = { token: null, amount: '0.05', quote: null, busy: false, error: '', signature: '', status: '' };
const intelState = { token: null };
const storedId = localStorage.getItem('memeder-id');
const userId = storedId && /^[a-f0-9-]{36}$/.test(storedId) ? storedId : crypto.randomUUID();
localStorage.setItem('memeder-id', userId);

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
  const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ id: userId, handle: localStorage.getItem('memeder-handle') || undefined }) });
  state.user = data.user;
  state.picks = data.picks;
  state.seen = new Set(data.seen);
  state.lastSwipe = data.lastSwipe;
  render();
}
async function loadFeed(force = false) {
  state.loading = true; state.error = ''; render();
  try {
    const data = await api(`/api/feed${force ? '?refresh=1' : ''}`);
    state.feed = data.tokens;
    state.updatedAt = data.updatedAt;
    state.stale = data.stale;
    if (data.stale) toast('Showing the last available market snapshot.');
  } catch (error) { state.error = error.message; }
  state.loading = false; render();
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
  $('#walletButtonText').textContent = walletState.account ? shortAddress(walletState.account.address) : 'CONNECT WALLET';
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
    <div class="card-top"><span class="live-pill"><i></i> SOLANA / LIVE</span><div class="card-top-right"><span class="card-index">${String(position).padStart(2, '0')} / ${String(state.feed.length).padStart(2, '0')}</span><button type="button" class="card-intel" data-intel="${esc(token.address)}" aria-label="View ${esc(token.name)} details" title="Coin details">i</button></div></div>
    <div class="card-art-wrap"><div class="card-art-halo"></div>${tokenArt(token, 'card-art')}${early ? '<span class="early-badge">✳ +15 EARLY BONUS</span>' : ''}</div>
    <div class="card-content">
      <div class="card-eyebrow"><span>${state.filter === 'growing' ? '✳ GROWING NOW' : '✦ POPULAR NOW'}</span><span>PAIR AGE ${age(token.createdAt)}</span></div>
      <div class="card-title-row"><div><h2>${esc(token.name)}</h2><div class="token-symbol">$${esc(token.symbol)}</div></div><span class="change-badge ${positive ? 'up' : 'down'}"><small>24H CHANGE</small>${positive ? '↗' : '↘'} ${pct(token.change24)}</span></div>
      <div class="card-stats"><div><span>MARKET CAP</span><strong>${money(token.cap)}</strong></div><div><span>24H VOLUME</span><strong>${money(token.volume24)}</strong></div><div><span>LIQUIDITY</span><strong>${money(token.liquidity)}</strong></div></div>
      <div class="card-bottom"><span>1H MOMENTUM <b class="${token.change1 >= 0 ? 'positive' : 'negative'}">${pct(token.change1)}</b></span><div class="card-links"><a href="${esc(safeUrl(token.url))}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">CHART ↗</a><button type="button" class="card-buy" data-buy="${esc(token.address)}">BUY $${esc(token.symbol)} ↗</button></div></div>
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
      <article class="guide-card heart"><span class="guide-step">02 / PICK</span><img src="/assets/mascot-heart.png" alt="" loading="lazy"/><div><h3>Trust your gut</h3><p>Swipe right to save a find and earn points.</p></div></article>
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
    <div class="pulse-copy"><span class="pulse-kicker"><i></i> LIVE FROM THE DECK / 1H MOVE</span><h2>Something's <em>taking off.</em></h2><p><strong>$${esc(mover.symbol)}</strong> has a standout one-hour move in this batch. Momentum moves fast; check the chart before making a call.</p><a href="${esc(safeUrl(mover.url))}" target="_blank" rel="noopener noreferrer">EXPLORE THE CHART <span>↗</span></a></div>
    <div class="pulse-readout"><span>1H / PRICE MOVE</span><strong>${pct(mover.change1)}</strong><small>MARKET CAP ${money(mover.cap)}</small></div>
    <div class="pulse-planet"></div><img class="pulse-rocket" src="/assets/mascot-rocket.png" alt="" loading="lazy" />
    <span class="pulse-star one">✳</span><span class="pulse-star two">✦</span>
  </section>`;
}
function undoBar() {
  if (!state.lastSwipe) return '';
  return `<div class="undo-strip"><span><b>LAST CALL</b> ${state.lastSwipe.direction === 'right' ? 'PICKED' : 'PASSED'} $${esc(state.lastSwipe.symbol)}</span><button id="undoButton" type="button" ${state.undoing ? 'disabled' : ''}>↶ UNDO SWIPE</button></div>`;
}
function discover() {
  const sorted = sortedFeed(); const token = sorted[0];
  return `<section class="page-intro"><div><div class="eyebrow"><span class="eyebrow-line"></span> THE DISCOVERY DECK <span class="eyebrow-star">✳</span></div><h1>Find your next <em>meme.</em></h1><p>Swipe the chaos. Spot the early ones. Climb the ranks.</p></div><div class="intro-counter"><span>YOUR SCORE</span><strong>${Number(state.user?.points || 0).toLocaleString()} <small>PTS</small></strong><span class="counter-arrow">↗</span></div></section>
    <div class="section-toolbar"><div class="tabs" role="tablist" aria-label="Token feed"><button role="tab" aria-selected="${state.filter === 'growing'}" class="${state.filter === 'growing' ? 'selected' : ''}" data-filter="growing">✳ Growing</button><button role="tab" aria-selected="${state.filter === 'popular'}" class="${state.filter === 'popular' ? 'selected' : ''}" data-filter="popular">♨ Popular</button></div><div class="feed-status"><span></span>${state.loading ? 'LOADING MARKET' : state.error ? 'FEED OFFLINE' : state.stale ? 'CACHED SNAPSHOT' : `LIVE FEED · ${state.feed.length} TOKENS`}</div></div>
    ${state.loading ? `<div class="loading-panel"><img class="state-art scout-art" src="/assets/mascot-scout.png" alt="" /><h2>Scanning the chain...</h2><p>Finding Solana tokens with a pulse.</p></div>` : state.error ? `<div class="empty-panel"><img class="state-art scout-art" src="/assets/mascot-scout.png" alt="" /><h2>Market feed unavailable</h2><p>${esc(state.error)}</p><button class="primary-button" id="retryButton">TRY AGAIN ↗</button></div>` : !token ? `<div class="empty-panel"><img class="state-art scout-art" src="/assets/mascot-scout.png" alt="" /><h2>Deck cleared.</h2><p>You have made your calls on every token in this batch.</p><button class="primary-button" id="reloadDeck">REFRESH THE DECK ↗</button></div>` : `<div class="discovery-layout"><div class="deck-column"><div class="deck-stage">${sorted[1] ? card(sorted[1], 1, state.feed.length - sorted.length + 2) : ''}${card(token, 0, state.feed.length - sorted.length + 1)}</div><div class="swipe-actions"><button id="passButton" class="swipe-button pass" aria-label="Pass on ${esc(token.name)}"><span>×</span><b>PASS</b></button><div class="swipe-hint">SWIPE OR USE<br><kbd>←</kbd> <kbd>→</kbd></div><button id="pickButton" class="swipe-button pick" aria-label="Pick ${esc(token.name)}"><span>♥</span><b>MAKE A PICK</b></button></div><div class="deck-footnote">+10 POINTS PER PICK <span>✳</span> +15 FOR EARLY PICKS UNDER $1M CAP · BOOSTED LISTINGS</div></div>${insightPanel(token)}</div>`}${!state.loading && !state.error ? `${undoBar()}${marketPulse()}${huntGuide()}` : ''}`;
}
function watchlist() {
  const sorted = [...state.picks].sort((a, b) => state.pickSort === 'oldest' ? a.pickedAt - b.pickedAt
    : state.pickSort === 'points' ? b.points - a.points || b.pickedAt - a.pickedAt : b.pickedAt - a.pickedAt);
  const query = state.pickQuery.trim().toLowerCase();
  const visible = sorted.filter(pick => `${pick.name} ${pick.symbol} ${pick.address}`.toLowerCase().includes(query));
  const pickCards = visible.map((pick, i) => {
    const current = state.feed.find(x => x.address === pick.address);
    const gain = current && pick.entryPrice ? (current.price / pick.entryPrice - 1) * 100 : null;
    return `<article class="pick-row" data-search="${esc(`${pick.name} ${pick.symbol} ${pick.address}`.toLowerCase())}"><span class="pick-rank">${String(i + 1).padStart(2, '0')}</span>${tokenArt(pick, 'pick-art')}<div class="pick-name"><strong>${esc(pick.name)}</strong><span>$${esc(pick.symbol)} · PICKED ${new Date(pick.pickedAt).toLocaleDateString()}</span></div><div class="pick-metric"><small>ENTRY CAP</small><strong>${money(pick.entryCap)}</strong></div><div class="pick-metric"><small>POINTS EARNED</small><strong class="hot">+${pick.points}</strong></div><div class="pick-metric"><small>SINCE PICK</small><strong class="${gain === null ? '' : gain >= 0 ? 'up-text' : 'down-text'}">${gain === null ? '—' : pct(gain)}</strong></div><button class="pick-intel" data-intel="${esc(pick.address)}" aria-label="View ${esc(pick.name)} details">INFO</button><button class="pick-buy" data-buy="${esc(pick.address)}" aria-label="Buy ${esc(pick.name)}">BUY ↗</button><a class="row-link" href="https://dexscreener.com/solana/${esc(pick.address)}" target="_blank" rel="noopener noreferrer" aria-label="View ${esc(pick.name)} chart">↗</a></article>`;
  }).join('');
  return `<section class="page-intro subpage"><div><div class="eyebrow"><span class="eyebrow-line"></span> YOUR CALLS</div><h1>My <em>picks.</em></h1><p>Every right swipe you made, all in one place.</p></div><div class="intro-counter"><span>TOTAL PICKS</span><strong>${state.picks.length}</strong><span class="counter-arrow">♡</span></div></section>${state.picks.length ? `<div class="picks-tools"><label class="pick-search"><span>⌕</span><input id="pickSearch" type="search" placeholder="Search your picks" aria-label="Search your picks" value="${esc(state.pickQuery)}" /></label><select id="pickSort" aria-label="Sort your picks"><option value="newest" ${state.pickSort === 'newest' ? 'selected' : ''}>Newest first</option><option value="oldest" ${state.pickSort === 'oldest' ? 'selected' : ''}>Oldest first</option><option value="points" ${state.pickSort === 'points' ? 'selected' : ''}>Most points</option></select><span id="pickResults">${visible.length} FOUND</span></div><div class="list-heading"><span>TOKEN</span><span>ENTRY CAP</span><span>POINTS</span><span>SINCE PICK*</span></div><div id="pickListBody" class="pick-list">${pickCards}</div><div id="pickNoResults" class="pick-no-results" ${visible.length ? 'hidden' : ''}>No picks match that search. Try another name or symbol.</div><p class="list-note">*Change is shown only while a token remains in the current feed. Points are awarded when picked; this prototype does not award later performance bonuses.</p>` : `<div class="empty-panel picks-empty"><img class="state-art heart-art" src="/assets/mascot-heart.png" alt="" /><h2>No picks yet.</h2><p>Your favorite finds will appear here after a right swipe.</p><button class="primary-button" data-view="discover">START SWIPING ↗</button></div>`}`;
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
function setView(view) { state.view = view; render(); if (view === 'leaderboard') loadLeaderboard(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
async function swipe(direction) {
  if (state.animating || state.view !== 'discover') return;
  const token = sortedFeed()[0]; if (!token) return;
  state.animating = true;
  const cardEl = $('.swipe-card:not(.peek-card)');
  cardEl?.classList.add(direction === 'right' ? 'fly-right' : 'fly-left');
  try {
    const result = await api('/api/swipe', { method: 'POST', body: JSON.stringify({ userId, address: token.address, direction }) });
    await new Promise(resolve => setTimeout(resolve, 330));
    state.seen.add(token.address);
    state.user = result.user;
    state.lastSwipe = result.swipe;
    if (direction === 'right') { state.picks.unshift(result.swipe); toast(`+${result.swipe.points} points! ${token.symbol} added to your picks.`); }
    else toast(`${token.symbol} passed. On to the next one.`);
    render();
  } catch (error) { cardEl?.classList.remove('fly-right', 'fly-left'); toast(error.message); }
  state.animating = false;
}
async function undoSwipe() {
  if (!state.lastSwipe || state.animating || state.undoing) return;
  state.undoing = true;
  const address = state.lastSwipe.address;
  render();
  try {
    const result = await api('/api/swipe/undo', { method: 'POST', body: JSON.stringify({ userId, address }) });
    state.user = result.user;
    state.lastSwipe = result.lastSwipe;
    state.seen.delete(result.removed.address);
    if (result.removed.direction === 'right') state.picks = state.picks.filter(pick => pick.address !== result.removed.address);
    toast(`Last swipe undone. $${result.removed.symbol} is back in the deck.`);
  } catch (error) { toast(error.message); }
  state.undoing = false;
  render();
}
function attachDrag() {
  const cardEl = $('.swipe-card:not(.peek-card)'); if (!cardEl) return;
  let startX = 0, startY = 0, dragging = false;
  cardEl.addEventListener('pointerdown', e => { if (e.target.closest('a,button')) return; startX = e.clientX; startY = e.clientY; dragging = true; cardEl.setPointerCapture(e.pointerId); });
  cardEl.addEventListener('pointermove', e => { if (!dragging || state.animating) return; const dx = e.clientX - startX; const dy = e.clientY - startY; cardEl.style.transform = `translate(${dx}px, ${Math.min(20, Math.max(-20, dy))}px) rotate(${dx / 24}deg)`; cardEl.classList.toggle('drag-right', dx > 45); cardEl.classList.toggle('drag-left', dx < -45); });
  cardEl.addEventListener('pointerup', e => { if (!dragging) return; dragging = false; const dx = e.clientX - startX; cardEl.style.transform = ''; cardEl.classList.remove('drag-right', 'drag-left'); if (Math.abs(dx) > 100) swipe(dx > 0 ? 'right' : 'left'); });
  cardEl.addEventListener('pointercancel', () => { dragging = false; cardEl.style.transform = ''; });
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
    <div class="intel-actions"><a href="${esc(chart)}" target="_blank" rel="noopener noreferrer">VIEW CHART ↗</a><button data-buy="${esc(token.address)}" type="button">BUY $${esc(token.symbol)} ↗</button></div>
    <p class="trade-footnote">Boosted listings are promoted. Prices and activity can change quickly; verify the token mint and research before trading.</p>`;
}

function availableWallets() {
  return [...walletState.wallets].filter(wallet => wallet?.features?.['standard:connect'] && wallet?.features?.['solana:signTransaction'] && wallet.chains?.includes('solana:mainnet'));
}
function renderWalletChoices() {
  const choices = availableWallets();
  $('#walletChoices').innerHTML = `${walletState.account ? `<div class="connected-wallet"><span class="wallet-check">✓</span><div><strong>${esc(walletState.wallet.name)}</strong><small>${esc(shortAddress(walletState.account.address))} · SOLANA MAINNET</small></div><button id="disconnectWallet" type="button">DISCONNECT</button></div>` : ''}
    ${choices.length ? choices.map((wallet, index) => `<button type="button" class="wallet-choice" data-wallet-index="${index}"><span class="wallet-choice-icon">${wallet.icon?.startsWith('data:image/') ? `<img src="${esc(wallet.icon)}" alt="" />` : '✳'}</span><span>${esc(wallet.name)}</span><b>↗</b></button>`).join('') : '<div class="wallet-empty"><img src="/assets/mascot-scout.png" alt="" /><strong>No wallet found here</strong><p>Open Memeder in a browser with a Solana wallet installed, then try Connect Wallet again.</p></div>'}`;
}
function registerWallet(...wallets) {
  for (const wallet of wallets) walletState.wallets.add(wallet);
  if ($('#walletDialog').open) renderWalletChoices();
  return () => { for (const wallet of wallets) walletState.wallets.delete(wallet); if ($('#walletDialog').open) renderWalletChoices(); };
}
window.addEventListener('wallet-standard:register-wallet', event => {
  if (typeof event.detail === 'function') event.detail({ register: registerWallet });
});
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: registerWallet } }));

function clearWallet() {
  walletState.unsubscribe?.(); walletState.unsubscribe = null;
  walletState.wallet = null; walletState.account = null;
  buyState.quote = null;
  updateChrome(); renderWalletChoices();
  if ($('#buyDialog').open) renderBuy();
}
async function connectWallet(wallet) {
  if (walletState.connecting) return;
  walletState.connecting = true;
  try {
    const result = await wallet.features['standard:connect'].connect();
    const account = result.accounts?.find(item => item.chains?.includes('solana:mainnet'));
    if (!account) throw new Error('This wallet has no Solana mainnet account.');
    walletState.unsubscribe?.();
    walletState.wallet = wallet; walletState.account = account;
    walletState.unsubscribe = wallet.features['standard:events']?.on('change', event => {
      if (!event.accounts) return;
      const next = event.accounts.find(item => item.chains?.includes('solana:mainnet'));
      if (!next || next.address !== walletState.account?.address) clearWallet();
      else walletState.account = next;
    });
    $('#walletDialog').close(); updateChrome();
    toast(`${wallet.name} connected: ${shortAddress(account.address)}`);
    if (buyState.token) { renderBuy(); $('#buyDialog').showModal(); }
  } catch (error) { toast(error.message || 'Could not connect wallet.'); }
  walletState.connecting = false;
}
function openBuy(address) {
  const token = state.feed.find(item => item.address === address) || state.picks.find(item => item.address === address);
  if (!token) return toast('Coin details are unavailable. Refresh the deck.');
  buyState.token = token; buyState.quote = null; buyState.error = ''; buyState.signature = ''; buyState.status = '';
  if (!walletState.account) { renderWalletChoices(); $('#walletDialog').showModal(); return; }
  renderBuy(); $('#buyDialog').showModal();
}
function quoteFresh() { return buyState.quote && Date.now() < buyState.quote.expiresAt; }
function renderBuy() {
  const token = buyState.token; if (!token) return;
  const quote = buyState.quote;
  const fresh = quoteFresh();
  const output = quote ? formatUnits(quote.outputAmount, quote.decimals) : '—';
  const impact = quote?.priceImpactPct == null ? '—' : `${Number(quote.priceImpactPct).toFixed(2)}%`;
  $('#buyContent').innerHTML = `<div class="buy-token-head">${tokenArt(token, 'buy-token-art')}<div><span>BUYING</span><h2>${esc(token.name)}</h2><small>$${esc(token.symbol)} · <a href="https://solscan.io/token/${esc(token.address)}" target="_blank" rel="noopener noreferrer" title="View full token address on Solscan">${esc(shortAddress(token.address))} ↗</a></small></div></div>
    ${buyState.signature ? `<div class="trade-success"><img src="/assets/mascot-heart.png" alt="" /><strong>Swap sent!</strong><p>Check its status on Solscan. The token may take a moment to appear in your wallet.</p><a href="https://solscan.io/tx/${esc(buyState.signature)}" target="_blank" rel="noopener noreferrer">VIEW TRANSACTION ↗</a></div>` : `<div class="trade-body">
      <div class="trade-label"><span>YOU PAY</span><span>SOLANA MAINNET</span></div>
      <div class="amount-field"><input id="solAmount" type="number" inputmode="decimal" min="0.001" max="10" step="0.001" value="${esc(buyState.amount)}" aria-label="Amount in SOL" ${buyState.busy ? 'disabled' : ''}/><span class="sol-chip">◎ SOL</span></div>
      <div class="amount-presets"><button data-amount="0.01">0.01 SOL</button><button data-amount="0.05">0.05 SOL</button><button data-amount="0.1">0.1 SOL</button></div>
      <div class="swap-divider">↓</div>
      <div class="trade-label"><span>ESTIMATED RECEIVE</span><span>TO ${esc(shortAddress(walletState.account?.address || ''))}</span></div>
      <div class="receive-field"><strong>${esc(output)}</strong><span>$${esc(token.symbol)}</span></div>
      ${quote ? `<div class="quote-details"><div><span>MINIMUM RECEIVE</span><strong>${quote.minimumOutputAmount ? `${esc(formatUnits(quote.minimumOutputAmount, quote.decimals))} $${esc(token.symbol)}` : 'See wallet confirmation'}</strong></div><div><span>PRICE IMPACT</span><strong>${impact}</strong></div><div><span>JUPITER FEE</span><strong>${Number(quote.feeBps || 0) / 100}%</strong></div><div><span>EST. TRANSACTION FEES</span><strong>~${((Number(quote.signatureFeeLamports || 0) + Number(quote.prioritizationFeeLamports || 0) + Number(quote.rentFeeLamports || 0)) / 1e9).toFixed(6)} SOL</strong></div></div><p class="quote-expiry ${fresh ? '' : 'expired'}">${fresh ? 'Quote is ready. Review the amount, then approve in your wallet.' : 'Quote expired. Get a fresh one before buying.'}</p>` : '<p class="quote-expiry">Get a live Jupiter quote to see the estimated tokens and fees.</p>'}
      ${buyState.error ? `<div class="trade-error" role="alert">${esc(buyState.error)}</div>` : ''}
      <button id="buyPrimary" class="primary-button trade-primary" type="button" ${buyState.busy ? 'disabled' : ''}>${buyState.busy ? esc(buyState.status) : fresh ? 'CONFIRM IN WALLET ↗' : 'GET LIVE QUOTE ↗'}</button>
      <p class="trade-footnote">Memecoins are volatile. Swiping earns app points; buying spends real SOL. Your wallet shows the final transaction for approval.</p>
    </div>`}`;
}
async function getBuyQuote() {
  if (buyState.busy || !walletState.account) return;
  const amount = $('#solAmount').value.trim();
  if (!/^(?:0|[1-9]\d{0,1})(?:\.\d{1,9})?$/.test(amount) || Number(amount) < .001 || Number(amount) > 10) {
    buyState.error = 'Enter an amount from 0.001 to 10 SOL.'; renderBuy(); return;
  }
  buyState.amount = amount; buyState.error = ''; buyState.busy = true; buyState.status = 'FINDING A ROUTE…'; renderBuy();
  try {
    buyState.quote = await api('/api/buy/order', { method: 'POST', body: JSON.stringify({ outputMint: buyState.token.address, amountSol: amount, taker: walletState.account.address, userId }) });
  } catch (error) { buyState.error = error.message; buyState.quote = null; }
  buyState.busy = false; renderBuy();
}
async function executeBuy() {
  if (buyState.busy || !quoteFresh() || !walletState.account) return;
  const quote = buyState.quote;
  buyState.busy = true; buyState.error = ''; buyState.status = 'WAITING FOR WALLET…'; renderBuy();
  try {
    const result = await walletState.wallet.features['solana:signTransaction'].signTransaction({
      transaction: bytesFromBase64(quote.transaction), account: walletState.account, chain: 'solana:mainnet'
    });
    const signed = result[0]?.signedTransaction;
    if (!(signed instanceof Uint8Array)) throw new Error('Wallet did not return a signed transaction.');
    buyState.status = 'SENDING SWAP…'; renderBuy();
    const execution = await api('/api/buy/execute', { method: 'POST', body: JSON.stringify({ requestId: quote.requestId, signedTransaction: bytesToBase64(signed) }) });
    if (execution.status !== 'Success' || !execution.signature) throw new Error(execution.error || 'Swap was not confirmed. Check your wallet activity before retrying.');
    buyState.signature = execution.signature;
  } catch (error) { buyState.error = error.message || 'Swap failed. Check your wallet activity before retrying.'; }
  buyState.busy = false; renderBuy();
}
setInterval(() => { if ($('#buyDialog').open && buyState.quote && !quoteFresh() && !buyState.busy && !buyState.signature) renderBuy(); }, 5000);

document.addEventListener('click', e => {
  const close = e.target.closest('[data-close-dialog]');
  if (close) { close.closest('dialog')?.close(); return; }
  const intel = e.target.closest('[data-intel]');
  if (intel) { e.stopPropagation(); openIntel(intel.dataset.intel); return; }
  const buy = e.target.closest('[data-buy]');
  if (buy) { e.stopPropagation(); if ($('#intelDialog').open) $('#intelDialog').close(); openBuy(buy.dataset.buy); return; }
  if (e.target.closest('#undoButton')) { undoSwipe(); return; }
  if (e.target.closest('#copyMint')) {
    if (intelState.token && navigator.clipboard?.writeText) navigator.clipboard.writeText(intelState.token.address).then(() => toast('Token mint copied.')).catch(() => toast('Could not copy the token mint.'));
    else toast('Clipboard access is unavailable in this browser.');
    return;
  }
  if (e.target.closest('#walletButton')) { buyState.token = null; renderWalletChoices(); $('#walletDialog').showModal(); return; }
  const choice = e.target.closest('[data-wallet-index]');
  if (choice) { const wallet = availableWallets()[Number(choice.dataset.walletIndex)]; if (wallet) connectWallet(wallet); return; }
  if (e.target.closest('#disconnectWallet')) {
    Promise.resolve(walletState.wallet?.features?.['standard:disconnect']?.disconnect()).catch(() => {}).finally(() => { clearWallet(); $('#walletDialog').close(); toast('Wallet disconnected.'); });
    return;
  }
  const preset = e.target.closest('[data-amount]');
  if (preset) { buyState.amount = preset.dataset.amount; buyState.quote = null; buyState.error = ''; renderBuy(); return; }
  if (e.target.closest('#buyPrimary')) { if (quoteFresh()) executeBuy(); else getBuyQuote(); return; }
  const view = e.target.closest('[data-view]');
  if (view) { e.preventDefault(); setView(view.dataset.view); return; }
  const filter = e.target.closest('[data-filter]');
  if (filter) { state.filter = filter.dataset.filter; render(); return; }
  if (e.target.closest('#passButton')) swipe('left');
  if (e.target.closest('#pickButton')) swipe('right');
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
  if (e.target.id !== 'solAmount') return;
  buyState.amount = e.target.value; buyState.quote = null; buyState.error = '';
  const button = $('#buyPrimary'); if (button) button.textContent = 'GET LIVE QUOTE ↗';
  const receive = $('.receive-field strong'); if (receive) receive.textContent = '—';
  const details = $('.quote-details'); if (details) details.remove();
  const expiry = $('.quote-expiry'); if (expiry) expiry.textContent = 'Get a live Jupiter quote to see the estimated tokens and fees.';
});
document.addEventListener('change', e => {
  if (e.target.id === 'pickSort') { state.pickSort = e.target.value; render(); }
});
document.addEventListener('keydown', e => {
  if ($('#profileDialog').open || $('#walletDialog').open || $('#buyDialog').open || $('#intelDialog').open || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
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
    state.user = data.user; state.lastSwipe = data.lastSwipe; localStorage.setItem('memeder-handle', data.user.handle); $('#profileDialog').close(); render(); if (state.view === 'leaderboard') loadLeaderboard(); toast('Hunter profile updated.');
  } catch (error) { toast(error.message); }
});

render();
renderWalletChoices();
Promise.all([loadProfile(), loadFeed()]).catch(error => toast(error.message));
