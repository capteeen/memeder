import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const swipeCode = source.slice(source.indexOf('async function swipe('), source.indexOf('async function undoSwipe('));
const dragCode = source.slice(source.indexOf('let detachDrag ='), source.indexOf('function openIntel('));
const feedCode = source.slice(source.indexOf('function presentFeed('), source.indexOf('let deckFill ='));
const refreshCode = source.slice(source.indexOf('async function loadFeed('), source.indexOf('async function loadLeaderboard('));

function setup() {
  const listeners = new Map();
  const classes = new Set();
  const card = {
    dataset: { address: 'visible' },
    clientWidth: 400,
    style: { transform: '' },
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
    },
    addEventListener: (name, handler) => listeners.set(`card:${name}`, handler),
    setPointerCapture: () => {}
  };
  const calls = [];
  const state = { view: 'discover', feed: [{ address: 'visible', symbol: 'VIS' }, { address: 'new-first', symbol: 'NEW' }], seen: new Set(), picks: [], swipes: [], dragging: false, animating: false, renderAfterSwipe: false, blockSwipeClick: false };
  const context = vm.createContext({
    state,
    userId: 'test-user',
    $: () => card,
    sortedFeed: () => [state.feed[1], state.feed[0]],
    api: async (path, options) => {
      calls.push(JSON.parse(options.body));
      return { user: { points: 0 }, swipe: { address: calls.at(-1).address, symbol: 'VIS', points: 0 } };
    },
    render: () => {},
    toast: () => {},
    ensureDeck: () => {},
    rememberProfile: () => {},
    setSwipeHistory: swipes => { state.swipes = swipes; state.seen = new Set(swipes.map(swipe => swipe.address)); },
    window: {
      addEventListener: (name, handler) => listeners.set(`window:${name}`, handler),
      removeEventListener: name => listeners.delete(`window:${name}`)
    },
    setTimeout: fn => { fn(); return 1; }
  });
  vm.runInContext(`${swipeCode}\n${dragCode}`, context);
  return { context, state, card, classes, calls, listeners };
}

test('swipe commits the coin shown on the card after feed order changes', async () => {
  const { context, calls } = setup();
  await vm.runInContext("swipe('left')", context);
  assert.equal(calls[0].address, 'visible');
});

test('a fast horizontal release commits even without a pointermove event', async () => {
  const { context, state, card, calls, listeners } = setup();
  vm.runInContext('attachDrag()', context);
  listeners.get('card:pointerdown')({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, target: { closest: () => null } });
  assert.equal(state.dragging, true);
  listeners.get('window:pointerup')({ pointerId: 1, clientX: 120, clientY: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].address, card.dataset.address);
  assert.equal(calls[0].direction, 'right');
});

test('vertical movement does not commit a swipe', async () => {
  const { context, calls, listeners } = setup();
  vm.runInContext('attachDrag()', context);
  listeners.get('card:pointerdown')({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, clientY: 0, target: { closest: () => null } });
  listeners.get('window:pointerup')({ pointerId: 1, clientX: 30, clientY: 120 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('a feed refresh leaves a held card in place until the swipe ends', async () => {
  const { context, state } = setup();
  let renders = 0;
  state.dragging = true;
  state.loading = false;
  context.document = { querySelector: () => ({ dataset: { address: 'visible' } }) };
  context.render = () => { renders++; };
  context.paintFeedStatus = () => {};
  context.mergeTokens = () => {};
  context.sortedFeed = () => Array(8).fill(state.feed[0]);
  context.api = async () => ({ tokens: [], updatedAt: 1, stale: false });
  vm.runInContext(`${feedCode}\n${refreshCode}`, context);
  await vm.runInContext('loadFeed()', context);
  assert.equal(renders, 0);
  assert.equal(state.renderAfterSwipe, true);
});
