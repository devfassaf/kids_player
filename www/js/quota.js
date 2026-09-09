// quota.js — YouTube Data API quota discipline. Pure, node-tested.
// THE rule: never call search.list (100 units). Everything here costs 1 unit/call.

import { CAP_REARM_HEADROOM, CAP_REARM_COOLDOWN_MS } from './config.js';

/** Split ids into API-batch chunks (videos.list / channels.list take up to 50). */
export function batchIds(ids, size = 50) {
  const uniq = [...new Set(ids)];
  const out = [];
  for (let i = 0; i < uniq.length; i += size) out.push(uniq.slice(i, i + size));
  return out;
}

/**
 * Predicted unit cost of a sync plan — pinned by an executable assertion in tests
 * (10 channels × 500 videos === 111).
 */
export function quotaCostFor({
  handleResolves = 0, channelBatches = 0, backfillPages = 0, titleBatches = 0,
  playlistPages = 0 // v1.0.21: the playlists tab — enumeration + item pages + UUSH probe
} = {}) {
  return handleResolves + channelBatches + backfillPages + titleBatches + playlistPages;
}

export function shouldThrottle(spentToday, planned, softCap = 8000) {
  return spentToday + planned > softCap;
}

/** Uploads playlist derived from the channel id — verified against the API when a key exists. */
export function uploadsPlaylistIdFor(channelId) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(String(channelId || '')) ? 'UU' + channelId.slice(2) : null;
}

/**
 * v1.0.21 — the channel's LONG-FORM uploads playlist: exactly its "Videos" tab.
 *
 * YouTube auto-generates sibling playlists next to `UU…` (all uploads), addressable by
 * swapping the prefix: `UULF…` long-form only, `UUSH…` Shorts only, `UULV…` live. This
 * is how Shorts and live streams are kept out of a child's library, and it costs NOTHING
 * — it is the same `playlistItems.list` call against a different id.
 *
 * ⚠️ UNDOCUMENTED by Google (community-discovered; measured 2026-07-31 on Cocomelon,
 * Blippi and Super Simple Songs: `UULF ∪ UUSH = UU` exactly, no overlap, no leftovers).
 * Two consequences the callers must honour:
 *  - a variant playlist DOES NOT EXIST when the channel has no content of that type, so
 *    a Shorts-only channel answers `404 playlistNotFound`. That is information, not an
 *    error — see sync2's backfill stage.
 *  - the ONLY reliable filter is which playlist a video is in. There is no `isShort`
 *    field anywhere in the Data API, and DURATION IS NOT A SUBSTITUTE: a Short is
 *    "≤3 minutes AND square-or-taller", the API cannot see aspect ratio, and ~30% of
 *    recent Super Simple Songs / Cocomelon LONG-FORM uploads are under 3 minutes. A
 *    length rule would delete real nursery rhymes. Never add one.
 */
export function longFormPlaylistIdFor(channelId) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(String(channelId || '')) ? 'UULF' + channelId.slice(2) : null;
}

/**
 * v1.0.21 — the channel's SHORTS-only playlist (sibling of the above). Not used to
 * import anything: it is read to build the exclusion set for the "playlists" tab, where
 * `playlistItems` exposes no Shorts flag and membership is the only exact test.
 * 404s (via `fetchUploadsPage(...).notFound`) when the channel has posted no Shorts.
 */
export function shortsPlaylistIdFor(channelId) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(String(channelId || '')) ? 'UUSH' + channelId.slice(2) : null;
}

/**
 * v1.0.21 — PURE: which playlist does this channel's backfill page, and is the persisted
 * cursor still valid for it?
 *
 * TWO bugs this closes:
 *  - `backfillCursor` is a POSITIONAL page token that belongs to ONE playlist. A device
 *    upgrading mid-backfill held a `UU…` token; reusing it against `UULF…` either
 *    resumed at a meaningless offset (silently skipping a slice of the back catalogue
 *    and then latching backfillDone) or was rejected, writing the bad token back so the
 *    channel returned 'backfill' forever and never delivered another video. The playlist
 *    the cursor was earned against is therefore recorded alongside it, and a mismatch
 *    RESETS the cursor instead of trusting it.
 *  - falling back to `UU…` when no long-form id can be derived would import the very
 *    Shorts this release exists to exclude. `playlistId: null` means SKIP, and the caller
 *    must honour it — never substitute the uploads playlist.
 *
 * @returns { playlistId, resetCursor } — playlistId null ⇒ do not backfill this channel
 */
export function planBackfillPlaylist(channel = {}) {
  const playlistId = longFormPlaylistIdFor(channel.channelId);
  if (!playlistId) return { playlistId: null, resetCursor: false };
  const earnedOn = channel.backfillPlaylistId || null;
  const hasCursor = !!channel.backfillCursor;
  return { playlistId, resetCursor: hasCursor && earnedOn !== playlistId };
}

/* ============================================================================
 * v1.0.91 — A BACKFILL THE LIBRARY CEILING LATCHED CAN BE WALKED AGAIN.
 *
 * THE DEFECT. sync2 persists `backfillCursor`/`backfillDone` PER PAGE, inside the fetch
 * loop — before `planMutations` has seen a single candidate. So when the library is at
 * `maxTotal`, the walk completes, latches `backfillDone: true`, and every brand-new
 * record it fetched is then refused as 'capped'. `planChannelFetch` reads that latch and
 * answers 'rss' for ever after: once the parent frees space the channel recovers only its
 * ~15-video feed window, and the back catalogue never returns. v1.0.90 fixed the MESSAGE
 * (it tells the parent to remove and re-add the source, which is the one act that rearms
 * the walk — db.deleteLibraryChannel); this is the mechanism.
 *
 * WHY IT TAKES TWO STEPS AND NOT ONE. In the run that reports the capped drops the
 * library is BY DEFINITION at the ceiling, so there is no headroom to re-arm into — a
 * one-shot "capped ⇒ re-arm" would fire exactly when it must not. The loss is therefore
 * REMEMBERED on the channel (`planCapNote`) and the re-arm is a separate question asked
 * on every later run (`planCapRearm`). Nothing else can reconstruct the fact afterwards:
 * a capped drop writes no record and no tombstone.
 * ========================================================================== */

/** finite number ≥ min, else the fallback. `Number(null) === 0` is the trap this exists
 *  for (plan.screenOffMinutes): a junk value must never coerce into a meaningful one. */
function num(v, min, fallback) {
  return (typeof v === 'number' && Number.isFinite(v) && v >= min) ? v : fallback;
}

/**
 * v1.0.91 — PURE: did this run lose content for this source AT A CAP, with nothing left
 * that will fetch it again? -> { note, fields }
 *
 * The note is IDEMPOTENT: a channel already carrying the stamp is not re-stamped, or a
 * library sitting at the ceiling would rewrite every channel record on every sync (the
 * churn-free rule this repo pins for planMutations, one store over). The stamp therefore
 * records the FIRST time the source was refused, which is also the more informative value.
 *
 * A walk still IN PROGRESS is never stamped: it has pages left, it will fetch them, and
 * whichever run finishes it is the run that latches — and stamps.
 */
export function planCapNote(channel, cappedCount, now = Date.now()) {
  const none = { note: false, fields: null };
  if (!channel || typeof channel !== 'object') return none;
  if (num(cappedCount, 1, 0) < 1) return none;
  // Both walks latch the same way and both feed the same cap. `playlistsDone` counts
  // because the playlists tab is a second source whose output was refused just as the
  // uploads walk's was (planPlaylistAdvance latches it with no idea what happened next).
  const latched = channel.backfillDone === true || channel.playlistsDone === true;
  if (!latched) return none;
  if (num(channel.backfillCappedAt, 1, 0) > 0) return none; // already remembered
  return { note: true, fields: { backfillCappedAt: num(now, 1, Date.now()) } };
}

/**
 * v1.0.91 — PURE: may this source's walk be re-armed now? -> { rearm, fields }
 *
 * ⚠️ EVERY REFUSAL FAILS TOWARD THE STATUS QUO, and that direction is the whole safety
 * of the feature. Re-arming wrongly costs up to BACKFILL_PAGE_BUDGET pages of quota and a
 * family's mobile data on EVERY sync, for ever, while the library stays full — the exact
 * runaway this gate exists to prevent. Refusing wrongly costs nothing the parent did not
 * already have: v1.0.90's message still names remove-and-re-add as the way back.
 *
 * THE GATE IS HEADROOM, and it is the same gate for BOTH cap causes:
 *  - the TOTAL ceiling (`total >= maxTotal`) — room must have opened, or the re-walk
 *    refills nothing and simply latches again;
 *  - the PER-CHANNEL cap (`maxPerChannel` counts new records per RUN, so a >500-video
 *    channel drops its tail even in an empty library) — room is exactly what lets the
 *    next run take the next slice, and the walk terminates once the channel is whole.
 * One rule covers both because "is there anywhere to put what we would fetch?" is the
 * only question either cause actually asks.
 *
 * THE COOLDOWN BOUNDS THE LOOP, NOT JUST THE DATA (the v1.0.58 rule). The convergence
 * argument — freed slots carry deny tombstones, so a re-walk cannot refill them — is
 * probably true and is not something a child's tablet should depend on: with the
 * cooldown, a broken gate can waste one page budget per channel per DAY and no more.
 *
 * NOT reset here: `noLongForm`. It records a 404 on the derived long-form playlist —
 * a fact about the channel, nothing to do with the cap — and clearing it would buy a
 * probe every recovery for a genuinely Shorts-only channel. (db.deleteLibraryChannel
 * does clear it, correctly: an unsubscribe forgets everything we learned.)
 */
export function planCapRearm({
  channel, total, maxTotal, hasKey = false,
  headroom = CAP_REARM_HEADROOM, cooldownMs = CAP_REARM_COOLDOWN_MS, now = Date.now()
} = {}) {
  const none = { rearm: false, fields: null };
  if (!channel || typeof channel !== 'object') return none;
  // No key ⇒ planChannelFetch can only answer 'rss' ⇒ a re-armed walk fetches NOTHING and
  // the note would be spent for nothing. Keep it for the day a key arrives.
  if (!hasKey) return none;
  if (num(channel.backfillCappedAt, 1, 0) < 1) return none; // nothing was ever lost here

  const t = num(now, 1, Date.now());
  // A junk margin falls back to the CONFIGURED one, never to zero: zero is "re-arm the
  // moment a single slot opens", i.e. the runaway itself (the planRejectedPurge rule —
  // a config typo must not silently invert a feature).
  const margin = num(headroom, 1, CAP_REARM_HEADROOM);
  const cool = num(cooldownMs, 0, CAP_REARM_COOLDOWN_MS);
  if (t - num(channel.backfillRearmedAt, 0, 0) < cool) return none;

  // An unreadable library size or ceiling cannot be gated on — refuse rather than guess.
  const have = num(total, 0, null);
  const cap = num(maxTotal, 1, null);
  if (have === null || cap === null) return none;
  if (cap - have < margin) return none;

  return {
    rearm: true,
    fields: {
      backfillCursor: null, backfillDone: false, backfillPlaylistId: null,
      playlistCursor: null, playlistQueue: null, playlistsDone: false,
      backfillCappedAt: null, backfillRearmedAt: t
    }
  };
}

/**
 * What to do for one channel this run. Truth table (tested):
 *   no uploadsPlaylistId              -> resolve
 *   !backfillDone && hasKey           -> backfill (resume from cursor)
 *   !backfillDone && !hasKey          -> rss
 *   backfillDone && rss stale (>30m)  -> rss
 *   else                              -> skip
 */
export function planChannelFetch(channel, now = Date.now(), hasKey = false) {
  if (!channel.uploadsPlaylistId) return 'resolve';
  if (!channel.backfillDone) return hasKey ? 'backfill' : 'rss';
  if (now - (channel.lastRssCheckedAt || 0) > 30 * 60 * 1000) return 'rss';
  return 'skip';
}
