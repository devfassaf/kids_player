// drive.js — cross-device sync via a Google Drive DB file (decision 20).
// The DB JSON is modeled per-LIBRARY: everyone using the same input sheet (on the
// same Google account) shares videos, deny-list and channel subscriptions; gift
// state stays per profile. A Sheet mirror gives the parent a readable view.
//
// The pure parts (serializeDb / parseDb / mergeDbFiles) are node-tested. The merge is
// a small CRDT — grow-only deny-list, min/max lattices, LWW-by-updatedAt fields —
// commutative and idempotent, so two devices converge without a server.
//
// Files are tagged appProperties{kpApp:'kids-player'} and re-found by search after a
// reinstall; meta['drive'].dbFileId is only a cache (a 404 falls back to search).
// ⚠ Every mutating call sets an explicit Content-Type — CapacitorHttp silently drops
// a body without one (verified in Capacitor source).

import { httpRequest } from './platform.js';
import { getAccessToken, invalidateToken } from './gauth.js';
import { libraryIdFor } from './util.js';
import { looksLikeHtml } from './csv.js'; // a 200 + sign-in page is a FAILURE, never an empty doc
import { normalizeTitle, mergeVideoRecord, settleCuration } from './normalize.js';
// v1.0.40: the favourite half of a state entry is merged by the same pure rule everywhere
// (plan.js is the same import layer as this module — see the order in CLAUDE.md — and it
// does not import drive.js, so this edge adds no cycle).
import { mergeFavState } from './plan.js';
import {
  openDb, getMeta, putMeta, getSources, putSources, loadMergeIndex, putVideos,
  listLibraryChannels, putLibraryChannel, getChannel, putChannel, deleteLibraryChannel,
  getDeletedChannels, putDeletedChannels,
  listSiteEntries, putSiteEntry, deleteSiteEntry, getDeletedSiteEntries, putDeletedSiteEntries,
  listCustomFolders, putCustomFolder, deleteCustomFolder,
  getDeletedCustomFolders, putDeletedCustomFolders,
  loadDenyRecords, denyActive, tx, profScope, putVideoStates, getVideoState, purgeProfile
} from './db.js';
import { getAllSettings, putAllSettings, mergeSettings } from './settings.js';
import { getDeletedProfiles, putDeletedProfiles, mergeDeletedProfiles } from './store.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/* =================== PURE: serialize / parse / merge =================== */

export function parseDb(text) {
  try {
    const d = JSON.parse(text);
    if (!d || d.kind !== 'kids-player-db' || typeof d.libraries !== 'object') return null;
    return d;
  } catch { return null; }
}

/**
 * v1.0.22 — PURE: is this Drive response the document, or a FAILURE?
 *
 * WHY THIS EXISTS. `readDbFile` used to answer `null` for every outcome — a 401 from a
 * stale token, a dropped connection, a sign-in interstitial answering 200 with HTML, a
 * truncated body, and a genuinely absent file all looked identical. `mergeDbFiles(local,
 * null)` returns `local` verbatim, so the "the remote changed since our last write, merge
 * before overwriting" branch in `pushDrive` DEGRADED INTO A BLIND OVERWRITE of exactly the
 * document it existed to protect: one failed read and a fresh device PATCHed its empty
 * doc over the family's entire library, tombstones and channel subscriptions. Nothing
 * local held a copy.
 *
 * This is the same class as the sheet's `interpretSheetResponse`, and the same rule
 * applies, only harder because this feeds a WRITE: **emptiness may come from exactly one
 * input** — a 404, i.e. the file is really not there. Everything else THROWS.
 */
export function interpretDriveDoc(status, data) {
  if (status === 404) return null; // genuinely absent — the ONLY "no document" answer
  if (status !== 200) throw new Error('drive-http-' + (status || 0));
  const text = typeof data === 'string' ? data : (data == null ? '' : JSON.stringify(data));
  if (!text) throw new Error('drive-empty-body');
  if (looksLikeHtml(text)) throw new Error('drive-html'); // a lost grant answers 200 + a sign-in page
  const doc = parseDb(text);
  if (!doc) throw new Error('drive-not-json');
  return doc;
}

/**
 * v1.0.22 — PURE: the file-search result, with "couldn't ask" distinguishable from
 * "nothing there". Conflating them made a failed search report "no backup exists" to the
 * parent AND sent `pushDrive` down the create branch, producing a SECOND db file that
 * permanently shadows the family's real one (neither device's `dbFileId` points at the
 * other, so they never merge).
 */
export function interpretDriveList(status, data) {
  if (status !== 200) throw new Error('drive-http-' + (status || 0));
  const files = data && data.files;
  if (!Array.isArray(files)) throw new Error('drive-not-json');
  return files;
}

/**
 * v1.0.22 — PURE: may this push write, and with what?
 *
 * The one rule that matters: **a version mismatch we could not read is `'abort'`, never
 * `'write'`.** Aborting costs one deferred push (`pendingPush` retries); guessing costs
 * the family's whole backup.
 *
 * @param remoteRead { ok: boolean, doc: object|null } — `ok:false` means the read FAILED,
 *        `ok:true, doc:null` means the file is genuinely absent (a 404)
 */
/**
 * v1.0.38 — PURE: which library scope does a RESTORED profile read?
 *
 * A fresh device gets the profiles and every `libraries[…]` blob out of the document, but
 * the scope a profile reads is derivable from NEITHER. It used to be derived from the sheet
 * URL, which is exactly why forgetting the sheet would strand a restored family:
 * `ensureSources` mints `lib:p:<id>` while the content sits under the old `lib:<hash>` —
 * present in IndexedDB and reachable by nothing. Empty home, full database.
 *
 * The three branches are a compatibility ladder:
 *   1. `ps.libraryId` — a v1.0.38+ document says so outright.
 *   2. `ps.sheetUrl`  — an OLDER document. Reproduces the pre-v1.0.38 answer bit for bit, so
 *                       a restore from a pre-upgrade backup lands on the right `lib:<hash>`
 *                       and its migration then proceeds normally.
 *   3. neither        — the same answer `ensureSources` gives. Never null: that would let
 *                       the caller mint a scope that disagrees with the document.
 */
export function resolveRestoredLibraryId({ ps = null, profileId = '' } = {}) {
  const s = ps || {};
  if (s.libraryId) return String(s.libraryId);
  if (s.sheetUrl) return libraryIdFor(s.sheetUrl);
  return 'lib:p:' + profileId;
}

/**
 * v1.0.80 — PURE: applyRemoteDoc meets a profile that ALREADY has a local sources record.
 * Should it repoint the scope, and to what? Returns the corrected libraryId, or null to
 * leave the record untouched.
 *
 * The bug this repairs (field-reported): `ensureSources` mints `lib:p:<pid>` the FIRST time a
 * profile's home renders with no sources record — and if the Drive pull is DELAYED past that
 * render (the device was signed OUT of Google at launch, so `maybePullDrive` returned
 * no-token while the home still rendered), the restore's `getSources → continue` then refused
 * to write the REAL libraryId the backup carries. The videos restore under `lib:<hash>` and
 * the profile points at an empty `lib:p:<pid>`: full database, empty home — the exact v1.0.38
 * failure, reached through a new door (a delayed pull instead of a fresh device). The sites
 * still showed, because `prof:<pid>` is derived straight from the profile id and needs no
 * mapping — which is the tell.
 *
 * It ONLY ever unwinds the auto-mint default, never an established scope:
 *   • no local record          → null (the fresh-restore branch writes it; not our job).
 *   • local IS `lib:p:<pid>` AND the doc names a DIFFERENT explicit scope → that scope.
 *   • local is a legit `lib:p:<pid>` (a v1.0.38+ profile — the doc names the same) → null.
 *   • local is any OTHER scope (already correct, or a real legacy hash) → null.
 * So the immutable-scope rule holds: the mint was the mistake, and this only reverses it.
 */
export function restoreScopeCorrection({ existing = null, ps = null, profileId = '' } = {}) {
  if (!existing) return null;
  const wanted = resolveRestoredLibraryId({ ps, profileId });
  return existing.libraryId === 'lib:p:' + profileId && wanted !== existing.libraryId ? wanted : null;
}

export function decidePush({ fileId = null, remoteVersion = null, lastRemoteVersion = '', remoteRead = null } = {}) {
  if (!fileId) return { action: 'create', useRemote: false, reason: 'no-file' };
  if (String(remoteVersion ?? '') === String(lastRemoteVersion || '')) {
    return { action: 'write', useRemote: false, reason: 'unchanged-since-our-write' };
  }
  // changed since our last write (or we could not establish the version at all)
  if (!remoteRead || !remoteRead.ok) {
    return { action: 'abort', useRemote: false, reason: 'remote-unreadable' };
  }
  return { action: 'write', useRemote: true, reason: 'merged' };
}

/**
 * Build the Drive DB document. NEVER includes: localPath (device-local URI),
 * thumb blobs, backfill cursors, or the YouTube API key (explicit refusal list).
 * profileSources (v1.0.4, additive — old readers ignore it) maps profile→sheetUrl
 * so a fresh device restoring the backup can rebuild each profile's sources record.
 */
/**
 * Channel fields that describe THIS DEVICE's progress, not the channel. They must never
 * travel in either direction: a page token is meaningless in another device's paging
 * position, and `backfillDone`/`playlistsDone` arriving from a peer makes this device skip
 * a back catalogue it never walked (the v1.0.18 rearm bug, reachable through Drive).
 * `lastRssCheckedAt` is a per-device throttle — a peer's value suppresses our next check.
 */
const PER_DEVICE_CHANNEL_FIELDS = [
  'backfillCursor', 'backfillPlaylistId', 'backfillDone', 'lastRssCheckedAt',
  'playlistCursor', 'playlistQueue', 'playlistsDone', 'noLongForm'
];

/** PURE: strip this device's progress fields from a channel record. */
/**
 * PURE (v1.0.32): what one profileVideoState record contributes to the Drive doc.
 * `unwrappedAt` travels (what a child opened stays open, everywhere); a wrapped gift's
 * rank is emitted for compatibility but stays remote-only on apply (local assignment
 * wins). THE PLAYBACK POSITION (posSec/durSec/posAt) NEVER TRAVELS — it changes every
 * few seconds of watching, so pushing it would rewrite the family document on every
 * pause, and a lock is about THIS device's session anyway (the giftRank decision,
 * 2026-07-31, replayed). A record carrying ONLY a position contributes nothing.
 */
export function serializeStateEntry(v) {
  if (!v) return null;
  // v1.0.40 — THE FAVOURITE HALF RIDES ALONG, and it must be added BEFORE the early
  // returns below, not after. This function was an if/return chain — "whichever field
  // wins" — so a ⭐ on a video the child had already opened (i.e. almost every one) would
  // have been silently dropped from the document and the star would exist on one device
  // only. Both timestamps travel because REMOVING a star is an event too (plan.favActive):
  // with only `favAt`, a peer's stale copy re-stars what the child just un-starred.
  const fav = {};
  if (v.favAt) fav.favAt = v.favAt;
  if (v.favOffAt) fav.favOffAt = v.favOffAt;
  if (v.unwrappedAt) return { unwrappedAt: v.unwrappedAt, ...fav };
  if (v.giftRank !== undefined) return { giftRank: v.giftRank, ...fav };
  return Object.keys(fav).length ? fav : null;
}

/**
 * PURE (v1.0.32): fold a REMOTE state entry into the LOCAL record on apply.
 * Only an unwrap applies (giftRank stays remote-only, unchanged rule). `unwrappedAt` is
 * min-merged — the EARLIEST open wins, per the "unwrappedAt is forever" invariant; the
 * old blind put let a later remote stamp overwrite an earlier local one. The local
 * playback position survives the fold: a pull must not erase where the child stopped.
 * Dropping giftRank from the result is the unwrap semantics (db.unwrapGift does the same).
 */
export function mergeAppliedState(mine, remote) {
  // v1.0.40 — a remote entry carrying ONLY a favourite must still apply. The old guard
  // returned null unless the remote had `unwrappedAt`, so a ⭐ added on the phone was
  // thrown away on the tablet's pull — the feature would have looked device-local.
  const fav = mergeFavState(mine, remote);
  const hasFav = fav.favAt || fav.favOffAt;
  if (!remote || (!remote.unwrappedAt && !hasFav)) return null;
  const out = { ...fav };
  if (remote.unwrappedAt || (mine && mine.unwrappedAt)) {
    out.unwrappedAt = mine && mine.unwrappedAt && remote.unwrappedAt
      ? Math.min(mine.unwrappedAt, remote.unwrappedAt)
      : (remote.unwrappedAt || mine.unwrappedAt);
  }
  if (mine) {
    if (mine.posSec !== undefined) out.posSec = mine.posSec;
    if (mine.durSec !== undefined) out.durSec = mine.durSec;
    if (mine.posAt !== undefined) out.posAt = mine.posAt;
    // v1.0.57 — 🕒's watch stamp is DEVICE-LOCAL (the user's decision) and must survive the
    // fold for exactly the reason the position above does: this function REPLACES the local
    // row, and a field the remote cannot carry is a field a pull would erase. Every pull
    // would have emptied "נצפה לאחרונה" on the tablet whenever the phone touched the same
    // video — silently, and only on the devices that sync.
    if (mine.playedAt !== undefined) out.playedAt = mine.playedAt;
    // a LOCAL gift rank is device-local by rule and must survive a fold that only
    // carries a star (the old shape dropped it as part of the unwrap semantics, which is
    // right for an unwrap and wrong for a favourite-only entry)
    if (!out.unwrappedAt && mine.giftRank !== undefined) out.giftRank = mine.giftRank;
  }
  return out;
}

export function stripPerDeviceChannel(c) {
  const out = { ...(c || {}) };
  for (const f of PER_DEVICE_CHANNEL_FIELDS) delete out[f];
  return out;
}

/**
 * v1.0.22 — PURE: the channel record to write when applying a remote doc.
 * The `prev == null` case is the one that bit: writing the peer's record verbatim handed
 * a device that had never seen the channel a `backfillDone: true`, so `planChannelFetch`
 * returned 'rss' forever and the child only ever got the ~15-video feed window.
 */
export function mergeChannelForApply(prev, remote) {
  const shared = stripPerDeviceChannel(remote);
  if (!prev) return shared; // brand-new here: adopt the SHARED facts, none of the progress
  const keep = {};
  for (const f of PER_DEVICE_CHANNEL_FIELDS) if (f in prev) keep[f] = prev[f];
  return { ...prev, ...shared, ...keep };
}

export function serializeDb({ profiles, libraries, profileState, profileSources, settings, deletedProfiles }) {
  const clean = {};
  for (const [libId, lib] of Object.entries(libraries || {})) {
    clean[libId] = {
      sheetUrl: lib.sheetUrl || null,
      videos: (lib.videos || []).map(({ localPath, thumbId, ...v }) => v),
      denylist: lib.denylist || [],
      // ONE list, shared with the apply side (mergeChannelForApply), so the two halves of
      // "paging state never travels" cannot drift. They did: this used to omit
      // `backfillDone` and `lastRssCheckedAt`.
      channels: (lib.channels || []).map(stripPerDeviceChannel),
      libraryChannels: lib.libraryChannels || [],
      // v1.0.36: channel-deletion tombstones — additive, an older app ignores the key.
      // Without them a deletion is pure ABSENCE, the union below can only re-add, and
      // every peer resurrected the subscription the parent threw out (field report).
      deletedChannels: lib.deletedChannels || {},
      // v1.0.45: approved websites + their tombstones. Also additive. These live on
      // PROFILE scopes, so the thinner `prof:` branch of buildLocalDoc must carry them
      // too — that branch is the only place they ever appear for most families.
      siteEntries: lib.siteEntries || [],
      deletedSiteEntries: lib.deletedSiteEntries || {}
    };
  }
  return JSON.stringify({
    kind: 'kids-player-db', schema: 1, exportedAt: Date.now(),
    profiles: profiles || [], libraries: clean, profileState: profileState || {},
    profileSources: profileSources || {},
    // Additive, like profileSources was in v1.0.4 — an older app simply ignores the key.
    settings: settings || { account: {}, profiles: {} },
    // v1.0.25: deleted-profile tombstones. Without them every peer unions the profile
    // straight back in and the parent's deletion undoes itself on the next pull.
    deletedProfiles: deletedProfiles || {}
  });
}

const lww = (a, b) => ((b && b.updatedAt) || 0) > ((a && a.updatedAt) || 0) ? b : a;

/**
 * v1.0.10: deny entries evolved from a grow-only set to an LWW-element set — an
 * entry may be REVOKED (removedAt >= at; see db.denyActive) when the sheet re-adds
 * a key. Merge rule: the entry whose LAST EVENT (deny or revoke) is later wins;
 * on a tie the revoked one wins (converges with "the sheet wins" semantics).
 */
const denyLastEvent = (d) => Math.max((d && d.at) || 0, (d && d.removedAt) || 0);
export function mergeDenyRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ea = denyLastEvent(a);
  const eb = denyLastEvent(b);
  if (ea !== eb) return ea > eb ? a : b;
  return denyActive(a) ? b : a; // tie → prefer the revoked entry
}

/**
 * v1.0.22 — the channel's `autoApprove` is "the parent approved this whole channel", so
 * it MUST converge. `lww` alone did not: no writer set `updatedAt` (now stamped inside
 * `db.putLibraryChannel`), both sides compared `0 > 0` → false → the FIRST argument won,
 * and `merge(A,B)` therefore answered `true` where `merge(B,A)` answered `false`. The
 * existing commutativity test missed it because its fixtures carry timestamps — it pinned
 * the fixture, not the production path.
 *
 * On an exact tie (two legacy rows, neither ever rewritten) recency cannot decide, so the
 * tie-break is the SAFE direction: the row that still requires the parent's approval wins.
 * It is deterministic, so the merge is commutative again, and it can only ever ask for one
 * more confirmation — never leak a channel's uploads to a child unreviewed. Any device
 * that touches the toggle after this release carries a real timestamp and wins outright.
 */
export function mergeLibraryChannel(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = a.updatedAt || 0;
  const tb = b.updatedAt || 0;
  if (ta !== tb) return tb > ta ? b : a;
  if (!!a.autoApprove !== !!b.autoApprove) return a.autoApprove ? b : a;
  return a;
}

/**
 * v1.0.36 — PURE: union of two channel-deletion tombstone maps ({channelId: deletedAt}).
 * The LATEST deletion wins — deliberately unlike deletedProfiles' min-merge: a profile
 * id is random and never reused, but a channel CAN be legitimately re-added and then
 * deleted AGAIN, and the newest event must be the one every device converges on.
 * Commutative + idempotent (tested).
 */
export function mergeDeletedChannels(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [id, at] of Object.entries(src || {})) {
      const t = Number(at) || 0;
      out[id] = id in out ? Math.max(out[id], t) : t;
    }
  }
  return out;
}

/**
 * v1.0.36 — PURE: does a subscription row outlive a deletion tombstone?
 * STRICTLY newer wins: a deliberate re-add (sheet row, in-app add, snapshot import)
 * stamps a fresh `updatedAt` inside putLibraryChannel and beats the tombstone; a tie
 * is a deletion — resurrecting a channel the parent threw out is the betrayal,
 * re-hiding a re-added one is only a complaint (the resolveCuration tie rule).
 */
export function channelOutlivesTombstone(row, at) {
  return ((row && row.updatedAt) || 0) > (Number(at) || 0);
}

/**
 * v1.0.36 — PURE: the libraryChannels half of applying a remote doc. Absence must
 * finally PROPAGATE: adopt the union of both tombstone maps, refuse to put a remote
 * row that loses to it (a STALE doc still carrying the deleted subscription was the
 * resurrection — pullDrive applies the raw remote doc, unmerged), and delete the
 * local rows that lose (the device that never heard about the deletion).
 */
export function planChannelApply({ localRows, remoteRows, localTombs, remoteTombs }) {
  const tombs = mergeDeletedChannels(localTombs, remoteTombs);
  const survives = (lc) => !(lc.channelId in tombs) || channelOutlivesTombstone(lc, tombs[lc.channelId]);
  return {
    tombs,
    puts: (remoteRows || []).filter((lc) => lc && lc.channelId && survives(lc)),
    deletes: (localRows || []).filter((lc) => lc && lc.channelId && !survives(lc)).map((lc) => lc.channelId)
  };
}

/* ---------------- approved websites (v1.0.45) ----------------
   Deliberately a line-for-line mirror of the libraryChannels trio above: one LWW record
   merge, one max-merge tombstone map, one strict-outlives test, one apply plan. Same
   shape, same reasoning, same tie rule — a second pattern here would be a second set of
   bugs to find. */

/**
 * PURE: two copies of one site entry. Later `updatedAt` wins (stamped inside
 * `db.putSiteEntry`, never at the call sites).
 *
 * On an exact tie the tie-break is the SAFE direction, which for this feature means the
 * MORE restrictive row: a rule that does NOT allow external content beats one that does.
 * Deterministic, so the merge stays commutative, and the worst it can do is make a page
 * render plainly until the parent flips the toggle again.
 */
export function mergeSiteEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = a.updatedAt || 0;
  const tb = b.updatedAt || 0;
  if (ta !== tb) return tb > ta ? b : a;
  if (!!a.allowExternal !== !!b.allowExternal) return a.allowExternal ? b : a;
  return a;
}

/** PURE: union of two site-deletion tombstone maps ({entryId: deletedAt}); latest wins. */
export function mergeDeletedSiteEntries(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [id, at] of Object.entries(src || {})) {
      const t = Number(at) || 0;
      out[id] = id in out ? Math.max(out[id], t) : t;
    }
  }
  return out;
}

/**
 * PURE: does a site row outlive a deletion tombstone? STRICTLY newer wins; a TIE is a
 * deletion. Showing a child a site the parent removed is the betrayal; making them re-add
 * one is a complaint.
 */
export function siteEntryOutlivesTombstone(row, at) {
  return ((row && row.updatedAt) || 0) > (Number(at) || 0);
}

/** PURE: the siteEntries half of applying a remote doc (the planChannelApply twin). */
export function planSiteApply({ localRows, remoteRows, localTombs, remoteTombs }) {
  const tombs = mergeDeletedSiteEntries(localTombs, remoteTombs);
  const survives = (e) => !(e.entryId in tombs) || siteEntryOutlivesTombstone(e, tombs[e.entryId]);
  return {
    tombs,
    puts: (remoteRows || []).filter((e) => e && e.entryId && survives(e)),
    deletes: (localRows || []).filter((e) => e && e.entryId && !survives(e)).map((e) => e.entryId)
  };
}

/* ---------------- custom folders (v1.0.56) ----------------
   The same trio again, for the same reason: one LWW record merge, one max-merge tombstone
   map, one strict-outlives test, one apply plan. */

/**
 * PURE: two copies of one parent-created folder. Later `updatedAt` wins (stamped inside
 * `db.putCustomFolder`). An exact tie takes the row with a PICTURE — both are the parent's
 * own choice and neither is unsafe, so the tie-break is simply the richer folder, and it
 * is deterministic, which is what keeps the merge commutative.
 */
export function mergeCustomFolder(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = a.updatedAt || 0;
  const tb = b.updatedAt || 0;
  if (ta !== tb) return tb > ta ? b : a;
  if (!!a.artThumbId !== !!b.artThumbId) return a.artThumbId ? a : b;
  return a;
}

/** PURE: union of two folder-deletion tombstone maps ({folderId: deletedAt}); latest wins. */
export function mergeDeletedCustomFolders(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [id, at] of Object.entries(src || {})) {
      const t = Number(at) || 0;
      out[id] = id in out ? Math.max(out[id], t) : t;
    }
  }
  return out;
}

/** PURE: strictly newer survives; a TIE is a deletion (the siteEntry rule). */
export function customFolderOutlivesTombstone(row, at) {
  return ((row && row.updatedAt) || 0) > (Number(at) || 0);
}

/** PURE: the customFolders half of applying a remote doc. */
export function planCustomFolderApply({ localRows, remoteRows, localTombs, remoteTombs }) {
  const tombs = mergeDeletedCustomFolders(localTombs, remoteTombs);
  const survives = (e) => !(e.folderId in tombs) || customFolderOutlivesTombstone(e, tombs[e.folderId]);
  return {
    tombs,
    puts: (remoteRows || []).filter((e) => e && e.folderId && survives(e)),
    deletes: (localRows || []).filter((e) => e && e.folderId && !survives(e)).map((e) => e.folderId)
  };
}

/** Commutative + idempotent (tested): merge(a,b) ≡ merge(b,a); merge(a,a) ≡ a. */
export function mergeDbFiles(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { kind: 'kids-player-db', schema: 1, exportedAt: Math.max(a.exportedAt || 0, b.exportedAt || 0) };

  // v1.0.25 — tombstones FIRST: a profile the parent deleted must not survive the union
  // that put it back on every other device.
  out.deletedProfiles = mergeDeletedProfiles(a.deletedProfiles, b.deletedProfiles);
  const profById = new Map();
  for (const p of [...(a.profiles || []), ...(b.profiles || [])]) {
    if (!p || !p.id || p.id in out.deletedProfiles) continue;
    profById.set(p.id, profById.has(p.id) ? lww(profById.get(p.id), p) : p);
  }
  out.profiles = [...profById.values()];

  out.libraries = {};
  const libIds = new Set([...Object.keys(a.libraries || {}), ...Object.keys(b.libraries || {})]);
  for (const id of libIds) {
    const la = (a.libraries || {})[id];
    const lb = (b.libraries || {})[id];
    if (!la || !lb) { out.libraries[id] = la || lb; continue; }

    const vids = new Map();
    for (const v of la.videos || []) vids.set(v.key, v);
    for (const v of lb.videos || []) vids.set(v.key, vids.has(v.key) ? mergeVideoRecord(vids.get(v.key), v) : v);

    // deny-list: LWW-element union (v1.0.10) — entries never vanish, but a revoked
    // entry (sheet re-add) is inert. Only ACTIVE winners drop videos.
    const deny = new Map();
    for (const d of [...(la.denylist || []), ...(lb.denylist || [])]) {
      deny.set(d.key, mergeDenyRecord(deny.get(d.key), d));
    }
    for (const [key, d] of deny) { if (denyActive(d)) vids.delete(key); }

    const chans = new Map();
    for (const c of [...(la.channels || []), ...(lb.channels || [])]) {
      chans.set(c.channelId, chans.has(c.channelId) ? lww(chans.get(c.channelId), c) : c);
    }
    const libCh = new Map();
    for (const c of [...(la.libraryChannels || []), ...(lb.libraryChannels || [])]) {
      libCh.set(c.channelId, mergeLibraryChannel(libCh.get(c.channelId), c));
    }
    // v1.0.36 — deletion tombstones filter the union (the deletedProfiles pattern):
    // without this the union can only ever ADD, so one peer that had not pulled yet
    // re-injected every deleted subscription on its next push. A row with a NEWER
    // updatedAt (deliberate re-add) outlives the tombstone; a doc from an older app
    // carries no deletedChannels key and filters nothing.
    const chDel = mergeDeletedChannels(la.deletedChannels, lb.deletedChannels);
    for (const [chId, at] of Object.entries(chDel)) {
      const row = libCh.get(chId);
      if (row && !channelOutlivesTombstone(row, at)) libCh.delete(chId);
    }

    // v1.0.45 — approved websites, same union-then-filter shape as the channels above.
    const sites = new Map();
    for (const e of [...(la.siteEntries || []), ...(lb.siteEntries || [])]) {
      if (!e || !e.entryId) continue;
      sites.set(e.entryId, mergeSiteEntry(sites.get(e.entryId), e));
    }
    const siteDel = mergeDeletedSiteEntries(la.deletedSiteEntries, lb.deletedSiteEntries);
    for (const [entryId, at] of Object.entries(siteDel)) {
      const row = sites.get(entryId);
      if (row && !siteEntryOutlivesTombstone(row, at)) sites.delete(entryId);
    }

    // v1.0.56 — parent-created folders, the same union-then-filter shape again.
    const cfs = new Map();
    for (const e of [...(la.customFolders || []), ...(lb.customFolders || [])]) {
      if (!e || !e.folderId) continue;
      cfs.set(e.folderId, mergeCustomFolder(cfs.get(e.folderId), e));
    }
    const cfDel = mergeDeletedCustomFolders(la.deletedCustomFolders, lb.deletedCustomFolders);
    for (const [folderId, at] of Object.entries(cfDel)) {
      const row = cfs.get(folderId);
      if (row && !customFolderOutlivesTombstone(row, at)) cfs.delete(folderId);
    }

    out.libraries[id] = {
      sheetUrl: la.sheetUrl || lb.sheetUrl || null,
      videos: [...vids.values()],
      denylist: [...deny.values()],
      channels: [...chans.values()],
      libraryChannels: [...libCh.values()],
      deletedChannels: chDel,
      siteEntries: [...sites.values()],
      deletedSiteEntries: siteDel,
      customFolders: [...cfs.values()],
      deletedCustomFolders: cfDel
    };
  }

  // profile→sheet mapping (v1.0.4): LWW by updatedAt, same as profiles
  out.profileSources = {};
  const spids = new Set([...Object.keys(a.profileSources || {}), ...Object.keys(b.profileSources || {})]);
  for (const pid of spids) {
    const sa = (a.profileSources || {})[pid];
    const sb = (b.profileSources || {})[pid];
    out.profileSources[pid] = sa && sb ? lww(sa, sb) : (sa || sb);
  }

  // per-profile gift state: unwrappedAt takes MIN (once unwrapped anywhere, forever)
  out.profileState = {};
  const pids = new Set([...Object.keys(a.profileState || {}), ...Object.keys(b.profileState || {})]);
  for (const pid of pids) {
    const sa = (a.profileState || {})[pid] || {};
    const sb = (b.profileState || {})[pid] || {};
    const keys = new Set([...Object.keys(sa), ...Object.keys(sb)]);
    const merged = {};
    for (const k of keys) {
      const ua = sa[k] && sa[k].unwrappedAt;
      const ub = sb[k] && sb[k].unwrappedAt;
      if (ua || ub) merged[k] = { unwrappedAt: Math.min(ua || Infinity, ub || Infinity) };
      else merged[k] = sa[k] || sb[k];
    }
    out.profileState[pid] = merged;
  }

  // synced settings (v1.0.25): per key, later write wins; an exact tie resolves the SAFE
  // way. Absent on a doc written by an older app — then the present side is the answer.
  out.settings = mergeSettings(a.settings, b.settings);
  return out;
}

/* =================== I/O: Drive API =================== */

async function api(token, opts) {
  const res = await httpRequest({ ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  // A 401 means the token is dead NOW, whatever our 55-minute guess says. Dropping it
  // here is what lets the very next call re-authorize instead of failing for the rest of
  // the hour — and an hour of failing reads is how a push ends up with no remote to merge.
  if (res && res.status === 401) invalidateToken('http-401');
  return res;
}

/** THROWS when the search itself failed — "couldn't ask" must never read as "nothing there". */
async function findDbFile(token) {
  const q = encodeURIComponent("appProperties has { key='kpApp' and value='kids-player' } and trashed=false");
  const res = await api(token, { url: `${DRIVE}/files?q=${q}&spaces=drive&fields=files(id,name,version,appProperties)`, responseType: 'json' });
  const data = typeof res.data === 'string' ? (() => { try { return JSON.parse(res.data); } catch { return null; } })() : res.data;
  const files = interpretDriveList(res.status, data);
  return files.find((f) => f.appProperties && f.appProperties.kpKind === 'db') || null;
}

async function createDbFile(token, content) {
  const meta = { name: 'kids-player-db.json', appProperties: { kpApp: 'kids-player', kpKind: 'db', kpSchema: '1' } };
  const body =
    '--kpb\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
    '\r\n--kpb\r\nContent-Type: application/json\r\n\r\n' + content + '\r\n--kpb--';
  const res = await api(token, {
    method: 'POST', url: `${UPLOAD}/files?uploadType=multipart&fields=id,version`,
    headers: { 'Content-Type': 'multipart/related; boundary=kpb' }, body, responseType: 'json'
  });
  return res.status === 200 ? res.data : null;
}

async function updateDbFile(token, fileId, content) {
  const res = await api(token, {
    method: 'PATCH', url: `${UPLOAD}/files/${fileId}?uploadType=media&fields=id,version`,
    headers: { 'Content-Type': 'application/json' }, body: content, responseType: 'json'
  });
  return res.status === 200 ? res.data : null;
}

/**
 * -> { ok: true, doc }  (doc null ⇒ the file is genuinely absent, a 404)
 *    { ok: false, error } (we could NOT read it — the caller must not write)
 * Never collapses those two into `null`: that is what let a failed read overwrite the
 * family's backup. See interpretDriveDoc.
 */
async function readDbFile(token, fileId) {
  const res = await api(token, { url: `${DRIVE}/files/${fileId}?alt=media`, responseType: 'text' });
  try {
    return { ok: true, doc: interpretDriveDoc(res.status, res.data) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* =================== local <-> document =================== */

async function buildLocalDoc(profiles) {
  const libraries = {};
  const profileState = {};
  const profileSources = {};
  for (const p of profiles) {
    const src = await getSources(p.id);
    // v1.0.38: an entry for EVERY profile with a sources row, carrying the SCOPE. It used to
    // be written only when a sheetUrl existed, which made the whole map empty the moment
    // profiles forgot their sheets — see the restore branch in applyRemoteDoc.
    // `libraryId` and `sheetUrl` are ONE fact and must travel together, which the
    // whole-object LWW in mergeDbFiles already guarantees.
    // ⚠ `sheetUrl` must stay NULL (never '' or a sentinel) for a migrated profile: an older
    // app's own `if (!ps.sheetUrl) continue` guard is what keeps the new doc harmless there.
    if (src) {
      profileSources[p.id] = {
        libraryId: src.libraryId || null,
        sheetUrl: src.sheetUrl || null,
        updatedAt: src.updatedAt || 0
      };
    }
    const lib = src && src.libraryId;
    if (lib && !libraries[lib]) {
      const vids = [...(await loadMergeIndex(lib)).values()];
      const libCh = await listLibraryChannels(lib);
      const chans = [];
      for (const lc of libCh) { const c = await getChannel(lc.channelId); if (c) chans.push(c); }
      libraries[lib] = {
        sheetUrl: src.sheetUrl || null, videos: vids,
        // FULL deny rows (v1.0.10) incl. revoked ones — real timestamps, so the
        // LWW merge is meaningful (the old code stamped Date.now() on every push)
        denylist: await loadDenyRecords(lib),
        channels: chans, libraryChannels: libCh,
        // v1.0.36: the deletion tombstones travel with the library they guard
        deletedChannels: await getDeletedChannels(lib),
        // v1.0.45: sites are profile-scoped, so a library scope never has any — but the
        // key must still be present and empty, or a merge against a peer would read this
        // side as "unknown" rather than "none".
        siteEntries: [], deletedSiteEntries: {},
        // v1.0.56: custom folders are the mirror image — LIBRARY-scoped, because the
        // videos they hold are library records.
        customFolders: await listCustomFolders(lib),
        deletedCustomFolders: await getDeletedCustomFolders(lib)
      };
    }
    // profile-scope manual items ride inside a pseudo-library keyed by the prof scope
    const pScope = profScope(p.id);
    const pv = [...(await loadMergeIndex(pScope)).values()];
    // v1.0.45 — approved websites live HERE, on the profile scope, and this blob used to
    // exist only when the profile had personal VIDEOS. A child with three approved sites
    // and no manually-added video would have produced no entry at all, so the sites would
    // have synced nowhere while every screen looked correct locally.
    const pSites = await listSiteEntries(pScope);
    const pSiteDel = await getDeletedSiteEntries(pScope);
    if (pv.length || pSites.length || Object.keys(pSiteDel).length) {
      libraries[pScope] = {
        sheetUrl: null, videos: pv,
        denylist: await loadDenyRecords(pScope),
        channels: [], libraryChannels: [],
        siteEntries: pSites, deletedSiteEntries: pSiteDel,
        // present-and-empty for the same reason the library branch carries empty sites:
        // an absent key must not read as "unknown" to a peer's merge
        customFolders: [], deletedCustomFolders: {}
      };
    }
    const states = {};
    const db = await openDb();
    await new Promise((resolve) => {
      const range = IDBKeyRange.bound([p.id, ''], [p.id, '￿']);
      const req = db.transaction('profileVideoState').objectStore('profileVideoState').openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        const v = cur.value;
        const entry = serializeStateEntry(v); // v1.0.32: a pos-only record travels NOWHERE
        if (entry) states[v.key] = entry;
        cur.continue();
      };
      req.onerror = () => resolve();
    });
    profileState[p.id] = states;
  }
  return { profiles, libraries, profileState, profileSources,
    settings: await getAllSettings(), deletedProfiles: await getDeletedProfiles() };
}

async function applyRemoteDoc(doc) {
  for (const [libId, lib] of Object.entries(doc.libraries || {})) {
    const existing = await loadMergeIndex(libId);
    // v1.0.10: merge remote deny rows with local ones (LWW per key) — a local
    // revoke must not be resurrected by a stale active deny from an old doc.
    const mergedDeny = new Map((await loadDenyRecords(libId)).map((d) => [d.key, d]));
    for (const d of lib.denylist || []) {
      if (!d || !d.key) continue;
      const remote = { scopeId: libId, key: d.key, at: d.at || 0, removedAt: d.removedAt, reason: d.reason || 'drive-sync' };
      mergedDeny.set(d.key, mergeDenyRecord(mergedDeny.get(d.key), remote));
    }
    const activeDenied = new Set([...mergedDeny.values()].filter(denyActive).map((d) => d.key));

    const puts = [];
    for (const v of lib.videos || []) {
      if (!v || !v.key || activeDenied.has(v.key)) continue;
      const mine = existing.get(v.key);
      const rec = mine ? mergeVideoRecord(mine, { ...v, scopeId: libId }) : { ...v, scopeId: libId, localPath: null, thumbId: null };
      rec.normTitle = normalizeTitle(rec.title);
      // v1.0.22 — THIS is where a peer's approval lands, and it must land REACHABLE.
      // mergeVideoRecord promotes a locally-pending record when the remote one is live
      // (exactly the "I approved it on the phone" case) but never moves it out of
      // '~pending', so the video became live, invisible to the child, AND gone from the
      // approval queue. Settled on the remote-only branch too: a doc written by an older
      // build can already carry that shape.
      settleCuration(rec, v.homeFolderId || v.folderId, Date.now());
      puts.push(rec);
    }
    await putVideos(puts);
    await tx(['denylist'], 'readwrite', (deny) => {
      for (const d of mergedDeny.values()) deny.put(d);
    });
    await tx(['videos'], 'readwrite', (videos) => { // enforce ACTIVE tombstones only
      for (const key of activeDenied) videos.delete([libId, key]);
    });
    for (const c of lib.channels || []) {
      const prev = await getChannel(c.channelId);
      // LOCAL paging state always wins, and a channel we have never seen adopts the
      // SHARED facts only — never the peer's progress (a doc written before this release
      // may still carry it).
      await putChannel(mergeChannelForApply(prev, c));
    }
    // v1.0.36 — the libraryChannels half goes through pure planChannelApply: adopt the
    // union of deletion tombstones FIRST (so an interrupted apply still remembers),
    // delete the local rows that lose to it, and put only the remote rows that outlive
    // it — pullDrive applies the RAW remote doc, so a stale doc still carrying a
    // deleted subscription used to resurrect it right here.
    const chPlan = planChannelApply({
      localRows: await listLibraryChannels(libId),
      remoteRows: lib.libraryChannels || [],
      localTombs: await getDeletedChannels(libId),
      remoteTombs: lib.deletedChannels
    });
    await putDeletedChannels(libId, chPlan.tombs);
    for (const chId of chPlan.deletes) {
      // tombstone:false — the merged map above already carries the peer's own `at`;
      // restamping it here would make this device's copy instantly newer and the two
      // sides would bump each other forever (the preserveTimestamp lesson).
      await deleteLibraryChannel(libId, chId, { tombstone: false });
    }
    // preserveTimestamp: the merged record's `updatedAt` is the winner's, and restamping
    // it here would make it instantly newer than the peer's — the two devices would then
    // overwrite each other forever instead of converging.
    for (const lc of chPlan.puts) {
      await putLibraryChannel({ ...lc, libraryId: libId }, { preserveTimestamp: true });
    }
    // v1.0.45 — approved websites, through pure planSiteApply, same order and same
    // reasoning as the channels above: tombstones first, then the local losers, then the
    // remote survivors with their own timestamps preserved.
    const sitePlan = planSiteApply({
      localRows: await listSiteEntries(libId),
      remoteRows: lib.siteEntries || [],
      localTombs: await getDeletedSiteEntries(libId),
      remoteTombs: lib.deletedSiteEntries
    });
    await putDeletedSiteEntries(libId, sitePlan.tombs);
    for (const entryId of sitePlan.deletes) {
      await deleteSiteEntry(libId, entryId, { tombstone: false });
    }
    for (const e of sitePlan.puts) {
      await putSiteEntry({ ...e, scopeId: libId }, { preserveTimestamp: true });
    }
    // v1.0.56 — parent-created folders, identical shape and order.
    const cfPlan = planCustomFolderApply({
      localRows: await listCustomFolders(libId),
      remoteRows: lib.customFolders || [],
      localTombs: await getDeletedCustomFolders(libId),
      remoteTombs: lib.deletedCustomFolders
    });
    await putDeletedCustomFolders(libId, cfPlan.tombs);
    for (const folderId of cfPlan.deletes) {
      await deleteCustomFolder(libId, folderId, { tombstone: false });
    }
    for (const e of cfPlan.puts) {
      // `artThumbId` names a blob in the LOCAL thumbs store, which never travels — so a
      // folder arriving from a peer renders its emoji until this device fetches the
      // picture itself from `artSrcUrl` (best-effort, on the next render).
      await putCustomFolder({ ...e, scopeId: libId }, { preserveTimestamp: true });
    }
  }
  // Rebuild sources for restored profiles (v1.0.4): a fresh device knows the library data
  // but not WHICH SCOPE each profile reads. Local records win — this only fills the gap for
  // profiles that have none.
  //
  // v1.0.38 — the guard used to be `if (!ps.sheetUrl) continue`, which was fine only while
  // every scope was DERIVED from a sheet URL. Once a profile forgets its sheet, that guard
  // skips it entirely: a fresh device would restore the profiles and every `libraries[…]`
  // blob and then mint `lib:p:<id>` from ensureSources, while the content sits under the old
  // `lib:<hash>` — present in IndexedDB and pointed at by nothing. Empty home, full
  // database. The scope now travels explicitly and resolveRestoredLibraryId decides.
  for (const [pid, ps] of Object.entries(doc.profileSources || {})) {
    if (!ps) continue;
    const existing = await getSources(pid);
    if (existing) {
      // v1.0.80 — repair a wrongly-minted default scope (see restoreScopeCorrection). Leaves
      // an established scope alone; only unwinds the `lib:p:<pid>` ensureSources minted before
      // a signed-out launch let the pull run. Without it: full database, empty home.
      const fix = restoreScopeCorrection({ existing, ps, profileId: pid });
      if (fix) await putSources({ ...existing, libraryId: fix, updatedAt: Date.now() });
      continue;
    }
    await putSources({
      profileId: pid, schema: 1, sheetUrl: ps.sheetUrl || null,
      libraryId: resolveRestoredLibraryId({ ps, profileId: pid }),
      sheetHash: null, // force a full parse on the first sync (while a sheet still exists)
      shareIntent: { enabled: true, requireApproval: true }, defaultAutoApprove: false,
      maxItemsPerChannel: 500, maxItemsTotal: 5000, drive: { enabled: true }, updatedAt: Date.now()
    });
  }

  // unwrappedAt states apply for EVERY profile in the doc (v1.0.4): a fresh device
  // restoring the backup must not re-gift videos the children already opened.
  // giftRank states deliberately stay remote-only — local gift assignment wins.
  // v1.0.32: folded through pure mergeAppliedState instead of a blind put — the local
  // record may now carry the device's playback position, and the old shape erased it
  // on every pull (it also let a LATER remote unwrappedAt beat an earlier local one,
  // violating min-merge).
  for (const [pid, st] of Object.entries(doc.profileState || {})) {
    const keys = Object.keys(st || {});
    if (!keys.length) continue;
    const puts = [];
    for (const key of keys) {
      const merged = mergeAppliedState(await getVideoState(pid, key), st[key]);
      if (merged) puts.push({ profileId: pid, key, ...merged });
    }
    if (puts.length) await putVideoStates(puts);
  }

  // Synced settings (v1.0.25). Merged against what this device already has rather than
  // overwritten: a change made HERE since the last push must not be undone by a doc that
  // predates it. The merged entries keep their ORIGINAL `at` — restamping an applied
  // record would make it instantly newer than the peer's and the two would ping-pong
  // forever (the same reason mergeChannelForApply exists).
  if (doc.settings) await putAllSettings(mergeSettings(await getAllSettings(), doc.settings));

  // v1.0.25 — a peer's deleted-profile tombstones become OURS. Without this only the
  // device that pressed delete remembers, so every other device keeps pushing the profile
  // back into the document and the deletion never converges. Applied BEFORE
  // mergeRestoredProfiles runs (pullDrive), so the filter there sees them.
  const tombs = mergeDeletedProfiles(await getDeletedProfiles(), doc.deletedProfiles);
  await putDeletedProfiles(tombs);
  for (const id of Object.keys(tombs)) {
    // …and erase what a previous pull may already have restored here.
    try { await purgeProfile(id, ['prof:' + id, 'lib:p:' + id]); } catch {}
  }
}

/* =================== public: push / pull =================== */

let pushTimer = null;

/** Debounced background push — call after any local mutation worth syncing. */
export function schedulePush(profiles) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushDrive(profiles).catch(() => {}); }, 60 * 1000);
}

export async function pushDrive(profiles) {
  const token = await getAccessToken({ interactive: false });
  if (!token) { await patchDriveMeta({ pendingPush: true }); return { ok: false, error: 'no-token' }; }

  const meta = (await getMeta('drive')) || {};
  const localDoc = parseDb(serializeDb(await buildLocalDoc(profiles)));

  let fileId = meta.dbFileId;
  let remoteVersion = null;
  let probeFailed = false;
  if (fileId) {
    const probe = await api(token, { url: `${DRIVE}/files/${fileId}?fields=id,version`, responseType: 'json' });
    if (probe.status === 404) fileId = null; // parent deleted it in Drive — fall through
    else if (probe.status === 200) remoteVersion = (typeof probe.data === 'string' ? JSON.parse(probe.data) : probe.data).version;
    else probeFailed = true; // 401/5xx — we do NOT know the version; never guess (see below)
  }
  if (probeFailed) { await patchDriveMeta({ pendingPush: true }); return { ok: false, error: 'probe-failed' }; }
  if (!fileId) {
    // A FAILED SEARCH must not read as "no backup exists": that sent us to createDbFile
    // and produced a second db file permanently shadowing the family's real one.
    let found;
    try { found = await findDbFile(token); } catch (e) {
      await patchDriveMeta({ pendingPush: true });
      return { ok: false, error: 'search-failed:' + String((e && e.message) || e) };
    }
    if (found) { fileId = found.id; remoteVersion = found.version; }
  }

  // The remote is only read when it changed since OUR last write, and an unreadable
  // remote ABORTS. Merging `null` used to yield localDoc, i.e. a blind overwrite in the
  // exact branch meant to protect the peer's changes.
  const needRemote = !!fileId && String(remoteVersion ?? '') !== String(meta.lastRemoteVersion || '');
  const remoteRead = needRemote ? await readDbFile(token, fileId) : null;
  const plan = decidePush({ fileId, remoteVersion, lastRemoteVersion: meta.lastRemoteVersion, remoteRead });
  if (plan.action === 'abort') {
    await patchDriveMeta({ pendingPush: true });
    return { ok: false, error: 'remote-unreadable:' + ((remoteRead && remoteRead.error) || '?') };
  }

  let content;
  if (plan.useRemote) {
    const merged = mergeDbFiles(localDoc, remoteRead.doc);
    await applyRemoteDoc(merged);
    content = JSON.stringify(merged);
  } else {
    content = JSON.stringify(localDoc);
  }

  const res = plan.action === 'create' ? await createDbFile(token, content) : await updateDbFile(token, fileId, content);
  if (!res) { await patchDriveMeta({ pendingPush: true }); return { ok: false, error: 'upload-failed' }; }
  await patchDriveMeta({ enabled: true, dbFileId: res.id, lastRemoteVersion: res.version, lastPushAt: Date.now(), pendingPush: false });
  return { ok: true };
}

/** On sign-in / new device: pull the remote DB and merge it into local state. */
export async function pullDrive(myProfileId) {
  const token = await getAccessToken({ interactive: false });
  if (!token) return { ok: false, error: 'no-token' };
  const meta = (await getMeta('drive')) || {};
  let fileId = meta.dbFileId;
  if (!fileId) {
    // `empty: true` tells the parent "there is no backup yet". A failed search must
    // therefore be an ERROR, or we invite them to create a second, shadowing db file.
    let found;
    try { found = await findDbFile(token); } catch (e) {
      return { ok: false, error: 'search-failed:' + String((e && e.message) || e) };
    }
    if (!found) return { ok: true, empty: true };
    fileId = found.id;
  }
  const read = await readDbFile(token, fileId);
  if (!read.ok) return { ok: false, error: read.error };
  if (!read.doc) return { ok: true, empty: true }; // 404: the file is really gone
  const doc = read.doc;
  await applyRemoteDoc(doc);
  // Restore profiles from the backup (v1.0.4): on a fresh device the local list is
  // empty — without this, a connected backup restored the library but no profiles.
  let profilesRestored = 0;
  try {
    const { mergeRestoredProfiles } = await import('./store.js');
    profilesRestored = await mergeRestoredProfiles(doc.profiles);
  } catch {}
  await patchDriveMeta({ enabled: true, dbFileId: fileId, myProfileId });
  return { ok: true, profiles: doc.profiles || [], profilesRestored };
}

async function patchDriveMeta(patch) {
  const cur = (await getMeta('drive')) || {};
  await putMeta('drive', { ...cur, ...patch });
}
