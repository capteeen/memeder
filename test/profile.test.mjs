import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const profileCode = client.slice(client.indexOf('function storedProfile('), client.indexOf('function esc('));
const loadCode = client.slice(client.indexOf('async function loadProfile('), client.indexOf('function mergeTokens('));
const userCode = server.slice(server.indexOf('function ensureSwipeUser('), server.indexOf('\nconst server = createServer('));
const id = '01234567-89ab-cdef-0123-456789abcdef';

test('a swipe request can restore a profile missing from temporary server storage', () => {
  const context = vm.createContext({ profileIdPattern: /^[a-f0-9-]{36}$/, Date });
  vm.runInContext(userCode, context);
  const db = { users: {}, swipes: [] };
  const created = context.ensureSwipeUser(db, id);
  assert.equal(created.id, id);
  assert.equal(created.points, 0);
  created.points = 25;
  assert.equal(context.ensureSwipeUser(db, id).points, 25);
  assert.equal(context.ensureSwipeUser(db, 'bad-id'), null);
});

test('browser swipe history survives an empty server profile response', async () => {
  const swipes = [
    { address: 'passed', direction: 'left', points: 0, symbol: 'PASS' },
    { address: 'picked', direction: 'right', points: 25, symbol: 'PICK' }
  ];
  const profileKey = `date-profile-${id}`;
  const items = new Map([[profileKey, JSON.stringify({ id, user: { id, handle: 'Saved Hunter', points: 25 }, swipes })]]);
  const state = { user: null, swipes: [], picks: [], seen: new Set(), lastSwipe: null };
  const context = vm.createContext({
    state, userId: id, profileKey, storedHandle: 'Saved Hunter',
    localStorage: { getItem: key => items.get(key) || null, setItem: (key, value) => items.set(key, value) },
    api: async () => ({ user: { id, handle: 'Meme Hunter', points: 0 }, swipes: [] }),
    render: () => {}, toast: () => {}, Date, Set, JSON
  });
  vm.runInContext(`${profileCode}\n${loadCode}`, context);
  await vm.runInContext('loadProfile()', context);
  assert.equal(state.user.handle, 'Saved Hunter');
  assert.equal(state.user.points, 25);
  assert.deepEqual([...state.seen], ['passed', 'picked']);
  assert.equal(state.picks[0].address, 'picked');
  assert.equal(state.lastSwipe.address, 'picked');
});
