// search.js — PURE search ranking for the home-screen search bar (v1.0.7).
// Matching runs over normalizeTitle output on BOTH sides, so niqqud/bidi/emoji/case
// differences never hide a result. Node-tested; no DOM, no IDB.
//
// Score model (higher = better, 0 = no match):
//   100 exact title  |  80 title starts with query  |  60 a WORD starts with query
//   40 substring anywhere — minus a small position penalty so earlier matches win;
//   ties break by shorter title (more of it matched), then stable by key.

import { normalizeTitle } from './normalize.js';
import { RECENT_SEARCH_MAX } from './config.js';

export function scoreMatch(normQuery, normTitle) {
  if (!normQuery || !normTitle) return 0;
  if (normTitle === normQuery) return 100;
  if (normTitle.startsWith(normQuery + ' ') || normTitle.startsWith(normQuery)) return 80;
  const idx = normTitle.indexOf(normQuery);
  if (idx < 0) return 0;
  if (normTitle[idx - 1] === ' ') return 60;
  return Math.max(1, 40 - Math.min(20, idx)); // substring: earlier is better
}

/**
 * Rank items against a query. Each item needs { key, normTitle } (video records have
 * normTitle persisted; folder entries pass a normalized channel title).
 * -> [{ item, score }] sorted best-first; empty array for a blank/too-short query.
 */
export function rankItems(query, items, { minLength = 2, limit = 24 } = {}) {
  const q = normalizeTitle(query);
  if (q.length < minLength) return [];
  const out = [];
  for (const item of items || []) {
    const score = scoreMatch(q, item.normTitle || '');
    if (score > 0) out.push({ item, score });
  }
  out.sort((a, b) =>
    (b.score - a.score)
    || ((a.item.normTitle || '').length - (b.item.normTitle || '').length)
    || (String(a.item.key) < String(b.item.key) ? -1 : 1));
  return out.slice(0, limit);
}

/* ---------------- Recent searches (v1.0.87) ---------------- */
// The search screen remembers the last RECENT_SEARCH_MAX queries so a repeat search is
// one tap. Both helpers are PURE and TOTAL: the list lives in Preferences, which can hold
// junk (a corrupted write, an older app's value, a hand-edited backup), and junk must read
// as "no history" — never as a thrown search screen.
//
// Dedupe is by normalizeTitle on BOTH helpers, the same key the ranking itself matches by:
// "פרפרים" and "פַּרְפָּרִים 🦋" are ONE search, and keeping both would waste two of the ten
// slots on one intent. The stored text is the RAW typed form (that is what the chip shows).

// Junk-length bound. Real queries are capped by the input's maxlength (60); anything far
// past that can only come from corrupted storage, and truncating it would risk splitting a
// surrogate pair (the normalizeProfileName lesson) — so an absurd entry is DROPPED, and an
// absurd push is refused, never trimmed into a half-emoji.
const RECENT_QUERY_JUNK_LEN = 200;

/**
 * Parse the raw Preferences string -> a clean history list (newest first).
 * Accepts anything. Survivors are strings, trimmed, non-empty AFTER normalization, at
 * least rankItems' own minLength (a shorter entry can never rank, so its chip would run a
 * search that shows nothing), deduped by normalizeTitle, capped at `max`.
 */
export function readRecentSearches(raw, { max = RECENT_SEARCH_MAX } = {}) {
  let arr = null;
  try { arr = JSON.parse(String(raw ?? '')); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    if (typeof v !== 'string' || v.length > RECENT_QUERY_JUNK_LEN) continue;
    const q = v.trim();
    const key = normalizeTitle(q);
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Push one query onto the history (newest first) -> a NEW array, capped at `max` — entry
 * max+1 evicts the OLDEST. A repeat of an existing entry MOVES to the front carrying the
 * newest typed form (searching the same thing twice is the whole feature — it must not
 * burn a second slot). Returns the SAME array reference when there is nothing to record —
 * blank, below rankItems' minLength (such a query never shows results), junk-length, or
 * already sitting at the front — so callers can skip the Preferences write.
 */
export function pushRecentSearch(list, query, { max = RECENT_SEARCH_MAX } = {}) {
  const q = (typeof query === 'string' ? query : '').trim();
  const key = normalizeTitle(q);
  if (key.length < 2 || q.length > RECENT_QUERY_JUNK_LEN) return list;
  if (Array.isArray(list) && list[0] === q) return list; // already the newest — no write
  const rest = (Array.isArray(list) ? list : []).filter(
    (v) => typeof v === 'string' && normalizeTitle(v) !== key
  );
  return [q, ...rest].slice(0, max);
}
