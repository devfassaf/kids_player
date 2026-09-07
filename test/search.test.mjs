// Home-search ranking (v1.0.7) — pure. The promise to the user: results ordered by
// match accuracy (exact > starts-with > word-start > substring), Hebrew-normalized
// on both sides so niqqud/emoji/punctuation never hide a match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch, rankItems } from '../www/js/search.js';

const rec = (key, title) => ({ key, normTitle: title });

test('scoreMatch tiers: exact > starts-with > word-start > substring > none', () => {
  const exact = scoreMatch('בובספוג', 'בובספוג');
  const starts = scoreMatch('בוב', 'בובספוג מכנס מרובע');
  const word = scoreMatch('מכנס', 'בובספוג מכנס מרובע');
  const sub = scoreMatch('כנס', 'בובספוג מכנס מרובע');
  assert.ok(exact > starts && starts > word && word > sub && sub > 0);
  assert.equal(scoreMatch('פיקאצ׳ו', 'בובספוג מכנס מרובע'), 0);
});

test('rankItems: accuracy order, Hebrew normalization on the query side', () => {
  const items = [
    rec('a', 'שיר הפרפרים'),
    rec('b', 'פרפרים בגינה'),
    rec('c', 'הרפתקאות עם פרפרים ועוד'),
    rec('d', 'חתולים')
  ];
  // query carries niqqud + emoji — must still match the normalized titles.
  // order: starts-with (b) > word-start (c) > substring "הפרפרים" (a)
  const out = rankItems('פַּרְפָּרִים 🦋', items);
  assert.deepEqual(out.map((r) => r.item.key), ['b', 'c', 'a']);
});

test('rankItems: partial word matches, earlier substring wins, ties by shorter title', () => {
  const items = [rec('long', 'שיר ארוך מאוד על פרח'), rec('short', 'שיר על פרח')];
  const out = rankItems('פרח', items);
  assert.equal(out.length, 2);
  assert.equal(out[0].item.key, 'short'); // same tier — shorter title first
});

test('rankItems: guards — short/blank queries return nothing, limit respected', () => {
  const many = Array.from({ length: 40 }, (_, i) => rec('k' + i, 'סרטון מספר ' + i));
  assert.deepEqual(rankItems('', many), []);
  assert.deepEqual(rankItems('ס', many), []); // below minLength
  assert.equal(rankItems('סרטון', many).length, 24); // default cap
  assert.equal(rankItems('סרטון', many, { limit: 5 }).length, 5);
  assert.deepEqual(rankItems('סרטון', null), []);
});

/* ---------------- Recent searches (v1.0.87) ---------------- */
import { readRecentSearches, pushRecentSearch } from '../www/js/search.js';
import { RECENT_SEARCH_MAX } from '../www/js/config.js';

test('recent searches: newest first, and entry 11 evicts the OLDEST — never anything else (v1.0.87)', () => {
  // The user's own spec: ten are kept, and the 11th search pushes the LAST one out.
  // The value is pinned here deliberately — changing the window is a product decision
  // and must update this line with it, never drift silently.
  assert.equal(RECENT_SEARCH_MAX, 10);
  let list = [];
  for (let i = 1; i <= RECENT_SEARCH_MAX; i++) list = pushRecentSearch(list, 'חיפוש ' + i);
  assert.equal(list.length, RECENT_SEARCH_MAX);
  assert.equal(list[0], 'חיפוש 10');                       // newest first
  assert.equal(list[RECENT_SEARCH_MAX - 1], 'חיפוש 1');    // oldest last
  list = pushRecentSearch(list, 'חיפוש 11');
  assert.equal(list.length, RECENT_SEARCH_MAX, 'the list must never grow past the cap');
  assert.equal(list[0], 'חיפוש 11');
  assert.ok(!list.includes('חיפוש 1'), 'the OLDEST entry is the one evicted');
  assert.ok(list.includes('חיפוש 2'), 'only the oldest is evicted — nothing else moves');
});

test('recent searches: a repeat MOVES to the front — searching twice must not burn two slots', () => {
  let list = [];
  for (let i = 1; i <= RECENT_SEARCH_MAX; i++) list = pushRecentSearch(list, 'חיפוש ' + i);
  list = pushRecentSearch(list, 'חיפוש 5');
  assert.equal(list[0], 'חיפוש 5');
  assert.equal(list.filter((q) => q === 'חיפוש 5').length, 1, 'a repeat is never duplicated');
  assert.equal(list.length, RECENT_SEARCH_MAX, 'a move is not a growth');
  assert.ok(list.includes('חיפוש 1'), 'a repeat evicts NOTHING — the oldest survives');
  // dedupe is by normalizeTitle, the same key the ranking matches by: a decorated retype
  // of the same query is ONE history entry, shown in its newest typed form.
  let l2 = pushRecentSearch([], 'פרפרים');
  l2 = pushRecentSearch(l2, 'פַּרְפָּרִים 🦋');
  assert.equal(l2.length, 1);
  assert.equal(l2[0], 'פַּרְפָּרִים 🦋');
});

test('recent searches: nothing-to-record returns the SAME reference, so callers skip the write', () => {
  const list = ['דינוזאורים'];
  assert.equal(pushRecentSearch(list, ''), list);
  assert.equal(pushRecentSearch(list, '   '), list);
  assert.equal(pushRecentSearch(list, 'ד'), list);       // below rankItems' own minLength —
  assert.equal(pushRecentSearch(list, '🦋'), list);      // …and a query that normalizes away
  assert.equal(pushRecentSearch(list, 'x'.repeat(201)), list); // junk length is refused, never trimmed
  assert.equal(pushRecentSearch(list, 'דינוזאורים'), list);    // already the newest — no-op
  // and a junk LIST is tolerated (Preferences can hold anything): still records correctly
  assert.deepEqual(pushRecentSearch(null, 'חתולים'), ['חתולים']);
  assert.deepEqual(pushRecentSearch(['ok', 42, null], 'חתולים'), ['חתולים', 'ok']);
});

test('readRecentSearches is TOTAL: junk storage reads as no history, never a throw', () => {
  assert.deepEqual(readRecentSearches(null), []);
  assert.deepEqual(readRecentSearches(undefined), []);
  assert.deepEqual(readRecentSearches(''), []);
  assert.deepEqual(readRecentSearches('not json {'), []);
  assert.deepEqual(readRecentSearches('"a string"'), []);
  assert.deepEqual(readRecentSearches('{"a":1}'), []);
  assert.deepEqual(readRecentSearches('[1,null,{"x":1}]'), []);
  // survivors: strings, trimmed, rankable (minLength), deduped by norm, junk-length dropped
  const raw = JSON.stringify([' שיר ', 'שִׁיר', 42, 'ח', 'חתולים', 'x'.repeat(300)]);
  assert.deepEqual(readRecentSearches(raw), ['שיר', 'חתולים']);
  // capped at the window even when storage holds more (an older/corrupted value)
  const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => 'שאילתה ' + i));
  assert.equal(readRecentSearches(many).length, RECENT_SEARCH_MAX);
});
