// settings.js — the SYNCED settings channel (v1.0.25).
//
// Before this, exactly one setting-like value travelled between a family's devices:
// `libraryChannels.autoApprove`, and only because it rides a record that happens to carry
// a timestamp. Everything a parent can actually change — the PIN, the exit lock, "a shared
// video needs approval" — was device-local, so changing it on the phone did nothing to the
// tablet the child actually uses. There was no general mechanism; this is it.
//
// STORAGE: Preferences (platform.js), not IndexedDB. These are preferences — small, read
// at boot, and needed by pin.js before any database work happens. It also keeps the whole
// channel node-testable behind the same localStorage stub the rest of the suite uses.
//
// SHAPE: { account: { <name>: {v, at} }, profiles: { <profileId>: { <name>: {v, at} } } }
//   account  — one answer for the whole Google account (the parent PIN).
//   profiles — one answer per child (exit lock, share approval, autoplay).
//
// The `at` stamp is written HERE, never by the call sites. That is the v1.0.22 lesson from
// `putLibraryChannel`: an `updatedAt` that nobody sets makes the merge compare 0 > 0, so
// the FIRST document always wins and merge(A,B) stops equalling merge(B,A) — the
// documented commutativity invariant was provably false for that field.

import { prefGet, prefSet } from './platform.js';

const K = 'settings';

/** Scope value for a setting that belongs to the account rather than to one child. */
export const ACCOUNT = 'account';

const empty = () => ({ account: {}, profiles: {} });

export async function getAllSettings() {
  try {
    const raw = JSON.parse((await prefGet(K)) || '{}');
    return { account: raw.account || {}, profiles: raw.profiles || {} };
  } catch { return empty(); }
}

/** Whole-document write. Used by the Drive apply path, which carries real stamps already. */
export async function putAllSettings(next) {
  await prefSet(K, JSON.stringify({
    account: (next && next.account) || {},
    profiles: (next && next.profiles) || {}
  }));
}

/** @param scope ACCOUNT for an account-wide setting, otherwise a profileId. */
export async function putSetting(scope, name, value) {
  const all = await getAllSettings();
  const entry = { v: value, at: Date.now() };
  if (scope === ACCOUNT) all.account[name] = entry;
  else {
    if (!all.profiles[scope]) all.profiles[scope] = {};
    all.profiles[scope][name] = entry;
  }
  await putAllSettings(all);
}

/**
 * `fallback` comes back only when the setting was NEVER written. An explicit write of a
 * falsy value — a cleared PIN, a toggle switched off — is an ANSWER and must not be
 * replaced by the default, or turning something off would silently turn it back on.
 */
export async function getSetting(scope, name, fallback = null) {
  const all = await getAllSettings();
  const bag = scope === ACCOUNT ? all.account : (all.profiles[scope] || {});
  const entry = bag[name];
  return entry && 'v' in entry ? entry.v : fallback;
}

/**
 * v1.0.55 — read SEVERAL settings of one scope with ONE storage read. Each getSetting is
 * a full Preferences round-trip plus a whole-document parse; the scheduled-lock tick asks
 * for two flags every 5 seconds while the break screen is up, which made it two of each.
 * Same never-written-⇒-fallback semantics as getSetting, per name (the entry-shape check
 * matches mergeSettingEntry's, so a junk entry reads as the fallback instead of throwing).
 */
export async function getSettings(scope, names, fallback = null) {
  const all = await getAllSettings();
  const bag = scope === ACCOUNT ? all.account : (all.profiles[scope] || {});
  const out = {};
  for (const n of names || []) {
    const entry = bag[n];
    out[n] = entry && typeof entry === 'object' && 'v' in entry ? entry.v : fallback;
  }
  return out;
}

/**
 * Tie-break table. An exact `at` collision is rare but must be DETERMINISTIC, or
 * merge(A,B) !== merge(B,A) and two devices ping-pong forever — the v1.0.22 bug on
 * libraryChannels, which shipped because the fixtures carried timestamps and so pinned
 * the fixture rather than the production path.
 *
 * Where a tie has a SAFE direction we take it: one extra locked tablet or one extra
 * approval prompt costs a parent a few taps, and the opposite costs a child's safety.
 */
const SAFE_ON_TIE = {
  exitLock: true,       // stay in kiosk mode
  lockTablet: true,     // v1.0.55: keep the whole tablet locked during the break — containment errs strict
  shareApproval: true,  // keep asking before a shared video reaches the child
  autoplay: false,      // stop at the end of the video
  resume: false,        // start from the beginning (v1.0.32 — today's behaviour)
  // v1.0.63: keep playing when the app goes to the background. FALSE on a tie, and the
  // reason is the same asymmetry the whole table follows: a tie that answers "off" costs
  // a parent one tap to turn it back on; a tie that answers "on" leaves a tablet playing
  // in a bag, at night, on a device where nobody asked for it.
  bgPlay: false,
  // v1.0.76: HOME shrinks the video into a floating PiP window. FALSE on a tie — the bgPlay
  // asymmetry again, plus one more: PiP puts the LAUNCHER under the child's finger, so a
  // tie that answers "on" quietly opens a door out of the app nobody agreed to.
  pip: false,
  // v1.0.45: hide the websites button. Note this is the TIE rule, not the default — an
  // unwritten `sitesEnabled` reads as ON (the parent asked for it on by default), while
  // two devices disagreeing at the same millisecond resolve to the narrower surface.
  sitesEnabled: false
};

/**
 * v1.0.39 — NUMERIC settings whose safe tie-break is the LARGER value.
 *
 * `keepNewest` is the rolling window, and the two ways to be wrong are not symmetric: a
 * window that is too large keeps videos nobody wanted (a complaint), a window that is too
 * small proposes deleting videos the child watches (a betrayal — the resolveCuration rule).
 * The generic fallback below orders by STRING, which is deterministic but would prefer
 * "9" over "200" on an exact `at` collision. `Math.max` is commutative, so the merge stays
 * order-free either way.
 */
const SAFE_ON_TIE_MAX = new Set(['keepNewest']);

/** PURE: which of two writes of ONE setting survives. Commutative — tests pin that. */
export function mergeSettingEntry(name, a, b) {
  const okA = a && typeof a === 'object' && 'v' in a;
  const okB = b && typeof b === 'object' && 'v' in b;
  if (!okA) return okB ? b : null;
  if (!okB) return a;
  const ta = a.at || 0;
  const tb = b.at || 0;
  if (tb > ta) return b;
  if (ta > tb) return a;
  if (a.v === b.v) return a;
  const safe = SAFE_ON_TIE[name];
  if (safe !== undefined) return a.v === safe ? a : b;
  // v1.0.39: a numeric setting whose safe direction is "delete less" — see SAFE_ON_TIE_MAX.
  // 0 IS NOT A SMALL WINDOW, IT IS OFF, and off deletes nothing at all — so it wins before
  // the max rule. Without that, an exact `at` collision let the phone turn the feature back
  // ON for a parent who had just switched it off on the tablet.
  if (SAFE_ON_TIE_MAX.has(name) && Number.isFinite(Number(a.v)) && Number.isFinite(Number(b.v))) {
    if (Number(a.v) === 0 || Number(b.v) === 0) return Number(a.v) === 0 ? a : b;
    return Number(a.v) >= Number(b.v) ? a : b;
  }
  // No safe direction (the PIN hash is just an opaque string): order by VALUE so both
  // argument orders answer identically.
  return String(a.v) > String(b.v) ? a : b;
}

/** PURE: merge two whole settings documents, per scope, per key. */
export function mergeSettings(a, b) {
  const A = a || {};
  const B = b || {};
  const out = empty();
  for (const n of new Set([...Object.keys(A.account || {}), ...Object.keys(B.account || {})])) {
    const m = mergeSettingEntry(n, (A.account || {})[n], (B.account || {})[n]);
    if (m) out.account[n] = m;
  }
  for (const pid of new Set([...Object.keys(A.profiles || {}), ...Object.keys(B.profiles || {})])) {
    const pa = (A.profiles || {})[pid] || {};
    const pb = (B.profiles || {})[pid] || {};
    const bag = {};
    for (const n of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      const m = mergeSettingEntry(n, pa[n], pb[n]);
      if (m) bag[n] = m;
    }
    out.profiles[pid] = bag;
  }
  return out;
}
