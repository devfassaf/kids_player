// db.js — the IndexedDB access layer. I/O ONLY: no business logic lives here.
// Merging/dedupe/gifting decisions are made by pure functions (planMutations,
// mergeVideoRecord…) BEFORE calling the write functions below — that split is what
// keeps the interesting logic node-testable.
//
// CONTRACTS:
//  1. tx() resolves on transaction.oncomplete — never on the last request's onsuccess
//     (the classic IDB lie: "saved" before the txn actually commits).
//  2. putVideos() is a BLIND bulk upsert. Do not add read-modify-write logic here.
//  3. Read functions resolve null/[] for "not found"; they reject only on structural errors.
//  4. deleteVideo() writes videos+denylist+opLog in ONE transaction — the deletion and
//     its tombstone are atomic or neither happens.
//  5. The ONE import below is deliberate and stays that way: `stateRowIsSpent` decides
//     whether a profileVideoState row may be DELETED, and that decision must be
//     node-testable (this module is not — there is no IndexedDB in node). normalize.js
//     sits BELOW db in the layer order and imports nothing, so it cannot become a cycle.
//
// SCOPING (decision 20): content is keyed by scopeId, the first component of every key.
//   'lib:p:<profileId>'   — a profile's own library: everything the parent added for that
//                           child, identical on every device of the account.
//   'lib:<fnv1a(sheet)>'  — LEGACY, and still load-bearing: families created before v1.0.38
//                           derived the id from a Google-Sheets URL, and several profiles can
//                           SHARE one. The migration keeps those ids exactly as they are —
//                           nothing may change a profile's scope any more (moveScope is gone).
//   'prof:<profileId>'    — per-profile content ("הסרטונים שלי": manual adds, shares).
// Per-child gift/unwrap state lives in profileVideoState, NOT on the video record, so
// one child's unwrapping never affects a sibling sharing the same library.
//
// GIFT INDEX TRICK (load-bearing): profileVideoState's by_gift index has keyPath
// ['profileId','giftRank']. IndexedDB omits a record from a compound index when any
// component is missing — so `delete rec.giftRank` on unwrap removes it from the index
// automatically. The "חדשים 🎁" folder is a pure range scan, no filtering.

import { stateRowIsSpent } from './normalize.js';

export const DB_NAME = 'kidsplayer';
export const DB_VERSION = 3;

export const profScope = (profileId) => 'prof:' + profileId;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    /**
     * EVERY store creation MUST sit inside an `ev.oldVersion <` guard (v1.0.45).
     *
     * This handler ran unconditionally for the whole life of version 1, which was
     * harmless only because the version never moved. The moment it does, an existing
     * install re-enters here with its 9 stores already present, `createObjectStore`
     * throws ConstraintError, the version-change transaction ABORTS, and openDb rejects
     * — the app cannot open its database at all, on every device in the field. Adding a
     * store without a guard is not a migration bug, it is a bricked install.
     *
     * A fresh install arrives with oldVersion 0 and falls through every block in order.
     */
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const from = (ev && ev.oldVersion) || 0;

      if (from < 1) {
        const videos = db.createObjectStore('videos', { keyPath: ['scopeId', 'key'] });
        videos.createIndex('by_folder_sort', ['scopeId', 'folderId', 'sortKey']);
        videos.createIndex('by_state', ['scopeId', 'state', 'sortKey']);
        videos.createIndex('by_channel_title', ['scopeId', 'channelId', 'normTitle']);
        videos.createIndex('by_key', 'key'); // non-unique: same video in several scopes

        const pvs = db.createObjectStore('profileVideoState', { keyPath: ['profileId', 'key'] });
        pvs.createIndex('by_gift', ['profileId', 'giftRank']); // sparse — see header

        db.createObjectStore('channels', { keyPath: 'channelId' });

        const libCh = db.createObjectStore('libraryChannels', { keyPath: ['libraryId', 'channelId'] });
        libCh.createIndex('by_library', ['libraryId', 'order']);

        const thumbs = db.createObjectStore('thumbs', { keyPath: 'id' });
        thumbs.createIndex('by_lastUsed', 'lastUsed');

        db.createObjectStore('denylist', { keyPath: ['scopeId', 'key'] });
        db.createObjectStore('sources', { keyPath: 'profileId' });
        db.createObjectStore('meta', { keyPath: 'id' });

        const ops = db.createObjectStore('opLog', { keyPath: 'seq', autoIncrement: true });
        ops.createIndex('by_scope', 'scopeId');
      }

      if (from < 2) {
        // v1.0.45 — approved websites. Shortcuts (what the child sees) and navigation
        // rules (what the child may reach) share one store behind a `kind` discriminator:
        // both are per-profile, ordered, parent-curated rows with the same LWW + tombstone
        // lifecycle, and nothing outside this feature reads the store, so there is no
        // pipeline for the other kind to leak into.
        const sites = db.createObjectStore('siteEntries', { keyPath: ['scopeId', 'entryId'] });
        // NOT read any more (see listSiteEntries): an index key with an undefined
        // component silently omits the record. Kept because dropping an index costs a
        // DB_VERSION bump, and an unread index is harmless.
        sites.createIndex('by_scope', ['scopeId', 'order']);
      }

      if (from < 3) {
        // v1.0.56 — PARENT-CREATED FOLDERS. Only the folder's own metadata lives here;
        // membership is the VIDEO's `folderId` ('cf:<id>'), exactly as a channel folder
        // works — so the by_folder_sort range index, pageFolder, the watch-grid chain and
        // the orphan GC all keep working with no new branch anywhere.
        // Deliberately NO index (the listSiteEntries lesson: an index key with an
        // undefined component silently hides the record); readers range the primary key.
        db.createObjectStore('customFolders', { keyPath: ['scopeId', 'folderId'] });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch {} dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('db-blocked'));
  });
  return dbPromise;
}

/**
 * Monotonic count of COMMITTED writes (v1.0.20) — the invalidation signal for derived
 * UI state. The home re-derives its folder list on every entry and every page flip, and
 * that derivation must read the whole library (the full records feed the tiles). Keying
 * a cache on this counter turns that read into once-per-CHANGE instead of
 * once-per-render, and because the bump lives inside tx() itself, no future write path
 * can forget to invalidate. Reads never bump it.
 */
let writeSeq = 0;
export const dataVersion = () => writeSeq;

/** Run fn(stores…) inside one transaction; resolves on oncomplete (contract #1). */
export async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = storeNames.map((n) => t.objectStore(n));
    let result;
    t.oncomplete = () => { if (mode === 'readwrite') writeSeq += 1; resolve(result); };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('tx-aborted'));
    try {
      const r = fn(...stores);
      if (r && typeof r.then === 'function') r.then((v) => { result = v; }).catch((e) => { try { t.abort(); } catch {} reject(e); });
      else result = r;
    } catch (e) { try { t.abort(); } catch {} reject(e); }
  });
}

/* Promisify one IDBRequest (for reads outside tx()). */
const preq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const CHUNK = 200;

/* ---------------- videos ---------------- */

export async function getVideo(scopeId, key) {
  const db = await openDb();
  const r = await preq(db.transaction('videos').objectStore('videos').get([scopeId, key]));
  return r || null;
}

/** Blind bulk upsert, chunked so one huge sync can't hold a write txn for seconds. */
export async function putVideos(recs) {
  for (let i = 0; i < recs.length; i += CHUNK) {
    const slice = recs.slice(i, i + CHUNK);
    await tx(['videos'], 'readwrite', (videos) => { for (const r of slice) videos.put(r); });
  }
}

const folderRange = (scopeId, folderId) =>
  IDBKeyRange.bound([scopeId, folderId, -Infinity], [scopeId, folderId, Infinity]);

export async function countFolder(scopeId, folderId) {
  const db = await openDb();
  return preq(db.transaction('videos').objectStore('videos').index('by_folder_sort').count(folderRange(scopeId, folderId)));
}

/**
 * Page one folder, newest (highest sortKey) first.
 *  - keyset (preferred): { after: {sortKey, key} } → O(limit) at any depth
 *  - offset (pager UI):  { offset } → cursor.advance(offset)
 * Returns { items, total }.
 */
export async function pageFolder(scopeId, folderId, { after = null, offset = 0, limit = 15 } = {}) {
  const db = await openDb();
  const idx = db.transaction('videos').objectStore('videos').index('by_folder_sort');
  const range = after
    ? IDBKeyRange.bound([scopeId, folderId, -Infinity], [scopeId, folderId, after.sortKey], false, true)
    : folderRange(scopeId, folderId);
  const total = await preq(idx.count(folderRange(scopeId, folderId)));
  // limit <= 0 means "no room left on this page" and MUST yield nothing. The push used to
  // happen before the length check, so a zero limit returned ONE row: pageAnyFolder passes
  // `limit - eSlice.length`, which is exactly 0 once absorbed singles fill the page, so a
  // channel with ≥PAGE_SIZE absorbed singles rendered 16 tiles on a 15-tile grid and
  // repeated that row as the first tile of page 2.
  if (!(Number(limit) > 0)) return { items: [], total };
  const items = await new Promise((resolve, reject) => {
    const out = [];
    let advanced = after ? true : offset === 0; // keyset ranges need no advance
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      if (!advanced) { advanced = true; cur.advance(offset); return; }
      out.push(cur.value);
      if (out.length >= limit) return resolve(out);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { items, total };
}

/** Pending-approval queue for a scope, newest first. */
export async function pagePending(scopeId, { offset = 0, limit = 50 } = {}) {
  const db = await openDb();
  const idx = db.transaction('videos').objectStore('videos').index('by_state');
  const range = IDBKeyRange.bound([scopeId, 'pending', -Infinity], [scopeId, 'pending', Infinity]);
  const total = await preq(idx.count(range));
  const items = await new Promise((resolve, reject) => {
    const out = [];
    let advanced = offset === 0;
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      if (!advanced) { advanced = true; cur.advance(offset); return; }
      out.push(cur.value);
      if (out.length >= limit) return resolve(out);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { items, total };
}

/**
 * Find a LIVE record by key in ANY scope (by_key index) — keys are content-addressed
 * (yt:<id>), so the same video under a drifted library id is still the same video.
 * Preference: the passed scopes first, then anything live.
 */
export async function findLiveByKey(key, preferScopes = []) {
  const db = await openDb();
  const all = await preq(db.transaction('videos').objectStore('videos').index('by_key').getAll(key));
  const live = (all || []).filter((r) => r.state === 'live');
  if (!live.length) return null;
  for (const s of preferScopes) {
    const hit = live.find((r) => r.scopeId === s);
    if (hit) return hit;
  }
  return live[0];
}

export async function findByNormTitleInChannel(scopeId, channelId, normTitle) {
  if (!normTitle) return null; // empty normTitle never dedupes
  const db = await openDb();
  const r = await preq(db.transaction('videos').objectStore('videos')
    .index('by_channel_title').get([scopeId, channelId, normTitle]));
  return r || null;
}

/**
 * The whole scope as Map<key, record> for the pure merge planner. FULL records, not a
 * projection: mergeVideoRecord clones the survivor, so a partial projection would
 * silently strip type/id/url from merged records (a real bug caught in verification —
 * a merged record lost its video type). Records are ~400B now (no inline base64), so
 * 5000 records ≈ 2MB, well off the render path.
 */
export async function loadMergeIndex(scopeId) {
  const db = await openDb();
  const map = new Map();
  await new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([scopeId, ''], [scopeId, '￿']);
    const req = db.transaction('videos').objectStore('videos').openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      map.set(cur.value.key, cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return map;
}

export async function setVideoFields(scopeId, key, patch) {
  await tx(['videos'], 'readwrite', (videos) => {
    const r = videos.get([scopeId, key]);
    r.onsuccess = () => { if (r.result) videos.put({ ...r.result, ...patch, updatedAt: Date.now() }); };
  });
}

/**
 * v1.0.39 — mark videos the rolling window may NEVER delete (the parent ticked them).
 * Grow-only: it only ever sets the flag, and `normalize.mergeVideoRecord` ORs it so the
 * protection survives a sync and a peer's older copy.
 */
export async function markKeepForever(scopeId, keys) {
  const list = [...new Set((keys || []).filter(Boolean))];
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    await tx(['videos'], 'readwrite', (videos) => {
      for (const key of slice) {
        const r = videos.get([scopeId, key]);
        r.onsuccess = () => { if (r.result) videos.put({ ...r.result, keepForever: true, updatedAt: Date.now() }); };
      }
    });
  }
  return list.length;
}

/**
 * v1.0.39 — the BULK form of deleteVideo, for the rolling window's prune.
 *
 * A channel can sit thousands of videos over the window, and one transaction per key
 * (three stores each) is minutes of jank on a tablet. Chunked, like putVideos. The
 * tombstone is NOT optional here: a raw delete is pure row absence, and every Drive merge
 * is a union — a peer would re-push every pruned video straight back (the v1.0.36 lesson).
 */
export async function deleteVideosWithTombstones(scopeId, keys, reason = 'window-prune') {
  const list = [...new Set((keys || []).filter(Boolean))];
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const now = Date.now();
    await tx(['videos', 'denylist', 'opLog'], 'readwrite', (videos, deny, ops) => {
      for (const key of slice) {
        videos.delete([scopeId, key]);
        deny.put({ scopeId, key, at: now, reason });
        ops.add({ scopeId, op: 'deny', key, at: now });
      }
    });
  }
  return list.length;
}

/** Delete + tombstone + oplog atomically (contract #4). Durable across all future syncs. */
export async function deleteVideo(scopeId, key, reason = 'parent-delete') {
  const now = Date.now();
  await tx(['videos', 'denylist', 'opLog'], 'readwrite', (videos, deny, ops) => {
    videos.delete([scopeId, key]);
    deny.put({ scopeId, key, at: now, reason });
    ops.add({ scopeId, op: 'deny', key, at: now });
  });
}

export async function approvePending(scopeId, keys) {
  const now = Date.now();
  await tx(['videos'], 'readwrite', (videos) => {
    for (const key of keys) {
      const r = videos.get([scopeId, key]);
      r.onsuccess = () => {
        // v1.0.23: also un-rejects — the parent's rejected list restores straight to live
        if (r.result && (r.result.state === 'pending' || r.result.state === 'rejected')) {
          videos.put({
            ...r.result, state: 'live', approvedAt: now, rejectedAt: null, updatedAt: now,
            folderId: r.result.homeFolderId || r.result.folderId // un-park (see plan.js)
          });
        }
      };
    }
  });
}

/**
 * v1.0.23 — REJECT WITHOUT DESTROYING. The record is parked in '~rejected' (invisible to
 * the child, `by_folder_sort` never reaches it) and NO tombstone is written, so the parent
 * can pull it back out. That is the whole point: the old `rejectPending` called
 * `deleteVideo`, which erased the row AND wrote a deny-list tombstone whose only undeny
 * path is a sheet re-add — and a video inside a channel has no sheet row, so a rejection
 * was final and unappealable.
 *
 * `rejectedAt` is the timestamp `normalize.resolveCuration` compares, which is how the
 * rejection beats a peer's stale 'live' copy instead of being silently revived by it.
 * No sheet removal row is written here — that would deny the key on every device
 * permanently, defeating the restore. Emptying the list (`purgeRejected`) is what makes it
 * permanent.
 */
export async function rejectPending(scopeId, keys) {
  const now = Date.now();
  await tx(['videos'], 'readwrite', (videos) => {
    for (const key of keys) {
      const r = videos.get([scopeId, key]);
      r.onsuccess = () => {
        const rec = r.result;
        if (!rec || rec.state === 'rejected') return;
        videos.put({
          ...rec, state: 'rejected', rejectedAt: now, approvedAt: null, updatedAt: now,
          // remember the real home BEFORE parking, or a restore has nowhere to go
          homeFolderId: rec.homeFolderId || (rec.folderId === '~pending' ? null : rec.folderId) || 'sheet',
          folderId: '~rejected'
        });
      };
    }
  });
}

/** v1.0.23 — back to the approval queue (the parent wants to look again, not to approve). */
export async function restoreRejected(scopeId, keys) {
  const now = Date.now();
  await tx(['videos'], 'readwrite', (videos) => {
    for (const key of keys) {
      const r = videos.get([scopeId, key]);
      r.onsuccess = () => {
        if (r.result && r.result.state === 'rejected') {
          videos.put({ ...r.result, state: 'pending', rejectedAt: null, updatedAt: now, folderId: '~pending' });
        }
      };
    }
  });
}

/**
 * v1.0.23 — "מחק לצמיתות": empty the rejected list for real. THIS is the destructive one —
 * atomic delete + deny-list tombstone, the same call the library's 🗑️ makes, so the
 * deletion travels to every device and nothing can resurrect it. Deliberately writes no
 * sheet removal rows: this is a bulk operation and hundreds of `# הוסר` rows would wreck
 * the sheet (the same reason bulk reject-all never wrote them).
 */
export async function purgeRejected(scopeId, keys) {
  for (const key of keys) await deleteVideo(scopeId, key, 'parent-reject');
}

/** Page the rejected list, newest decision first. Same index as pagePending. */
export async function pageRejected(scopeId, { limit = 200 } = {}) {
  const db = await openDb();
  const idx = db.transaction('videos').objectStore('videos').index('by_state');
  const range = IDBKeyRange.bound([scopeId, 'rejected', -Infinity], [scopeId, 'rejected', Infinity]);
  const total = await preq(idx.count(range));
  const items = await new Promise((resolve, reject) => {
    const out = [];
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      out.push(cur.value);
      if (out.length >= limit) return resolve(out);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { items, total };
}

/** Remove WITHOUT a tombstone (e.g. a legacy record that migrated into the library scope). */
export async function deleteVideoRaw(scopeId, key) {
  await tx(['videos'], 'readwrite', (videos) => { videos.delete([scopeId, key]); });
}

/* ---------------- per-profile gift/unwrap state ---------------- */

export async function getVideoState(profileId, key) {
  const db = await openDb();
  const r = await preq(db.transaction('profileVideoState').objectStore('profileVideoState').get([profileId, key]));
  return r || null;
}

export async function putVideoStates(recs) {
  for (let i = 0; i < recs.length; i += CHUNK) {
    const slice = recs.slice(i, i + CHUNK);
    await tx(['profileVideoState'], 'readwrite', (s) => { for (const r of slice) s.put(r); });
  }
}

/** Gift folder ("חדשים 🎁"): range scan over the sparse by_gift index, rank ASC. */
export async function pageGifts(profileId, { offset = 0, limit = 15 } = {}) {
  const db = await openDb();
  const idx = db.transaction('profileVideoState').objectStore('profileVideoState').index('by_gift');
  const range = IDBKeyRange.bound([profileId, -Infinity], [profileId, Infinity]);
  const total = await preq(idx.count(range));
  const items = await new Promise((resolve, reject) => {
    const out = [];
    let advanced = offset === 0;
    const req = idx.openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      if (!advanced) { advanced = true; cur.advance(offset); return; }
      out.push(cur.value);
      if (out.length >= limit) return resolve(out);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { items, total };
}

export async function countGifts(profileId) {
  const db = await openDb();
  return preq(db.transaction('profileVideoState').objectStore('profileVideoState')
    .index('by_gift').count(IDBKeyRange.bound([profileId, -Infinity], [profileId, Infinity])));
}

/**
 * v1.0.32 — playback position, riding the SAME per-profile record as the gift state.
 * DEVICE-LOCAL by design: drive.serializeStateEntry never emits these fields and the
 * apply side preserves the local ones, so a pull cannot erase where the child stopped.
 * The write MERGES into the existing record — a blind put here would erase a gift.
 */
export async function savePlayPosition(profileId, key, posSec, durSec) {
  await tx(['profileVideoState'], 'readwrite', (s) => {
    const r = s.get([profileId, key]);
    r.onsuccess = () => {
      const rec = r.result || { profileId, key };
      rec.posSec = posSec;
      rec.durSec = durSec;
      rec.posAt = Date.now();
      s.put(rec);
    };
  });
}

/**
 * Clear the position (video finished). A record left with nothing else is deleted.
 *
 * ⚠️ v1.0.57 — THE "NOTHING ELSE" TEST USED TO EAT ⭐. It was written inline in v1.0.32 as
 * `giftRank === undefined && !unwrappedAt`, before favourites existed, and v1.0.40 added
 * `favAt`/`favOffAt` to this very row without revisiting it — so a starred video that was
 * never a gift, watched to the END with resume on, lost its star silently (and wrote no
 * `favOffAt`, so a peer could later re-star it). The predicate is now pure and shared:
 * `normalize.stateRowIsSpent`, which names every field this row can carry.
 */
export async function clearPlayPosition(profileId, key) {
  await tx(['profileVideoState'], 'readwrite', (s) => {
    const r = s.get([profileId, key]);
    r.onsuccess = () => {
      const rec = r.result;
      if (!rec) return;
      delete rec.posSec;
      delete rec.durSec;
      delete rec.posAt;
      if (stateRowIsSpent(rec)) s.delete([profileId, key]);
      else s.put(rec);
    };
  });
}

/**
 * v1.0.57 — the 🕒 "watched recently" stamp, on the SAME per-profile row as the gift state,
 * the star and the resume position (no new store, no new index, no DB_VERSION bump — the
 * ⭐ pattern: the folder is derived from the state map app.loadGiftStates already holds).
 *
 * DEVICE-LOCAL by design: `drive.serializeStateEntry` never emits it and the apply side
 * preserves it, so a pull cannot rewrite what this tablet watched. Read-modify-write for
 * the reason every writer here does it — a blind put would erase a gift or a star.
 *
 * `at = null` clears the stamp (the folder's self-heal, when the video is gone everywhere).
 */
export async function setPlayed(profileId, key, at = Date.now()) {
  if (!profileId || !key) return false;
  await tx(['profileVideoState'], 'readwrite', (s) => {
    const r = s.get([profileId, key]);
    r.onsuccess = () => {
      const rec = r.result || { profileId, key };
      if (at === null) {
        if (!r.result) return;             // nothing to clear
        delete rec.playedAt;
        if (stateRowIsSpent(rec)) { s.delete([profileId, key]); return; }
      } else {
        rec.playedAt = at;
      }
      s.put(rec);
    };
  });
  return true;
}

/** Remove an orphaned gift/unwrap state row (its video no longer exists anywhere). */
export async function deleteVideoState(profileId, key) {
  await tx(['profileVideoState'], 'readwrite', (s) => { s.delete([profileId, key]); });
}

/**
 * v1.0.39 — the BULK form, for the rolling window's prune. Chunked, and across every
 * profile the caller names.
 *
 * NOT optional bookkeeping. `planGifts` counts `outstanding` gifts straight out of this
 * store — `giftRank && !unwrappedAt`, records or no records — and stops gifting once
 * `outstanding >= baseline`. So pruning even a handful of UN-OPENED gifts would leave
 * orphan ranks that jam gifting **permanently**: the child never receives another 🎁, and
 * `planGiftRunawayRepair` cannot rescue it (it no-ops below its 60-record floor). The 🎁
 * tile also counts index entries, so the orphans would promise a folder that resolves to
 * nothing. And `drive.serializeStateEntry` emits every row, so they would sit in the
 * family document forever — in a feature whose whole purpose is bounding growth.
 */
export async function deleteVideoStates(profileIds, keys) {
  const pids = [...new Set((profileIds || []).filter(Boolean))];
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!pids.length || !list.length) return 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    await tx(['profileVideoState'], 'readwrite', (s) => {
      for (const pid of pids) for (const key of slice) s.delete([pid, key]);
    });
  }
  return list.length * pids.length;
}

/**
 * v1.0.40 — one profile's whole per-video state, as a Map keyed by video key.
 *
 * The same range scan `app.loadGiftStates` does for the ACTIVE child, exposed so the rolling
 * window can also read a SIBLING's stars: on a legacy shared library one child's window must
 * never prune the other child's favourite.
 */
export async function loadVideoStates(profileId) {
  const out = new Map();
  if (!profileId) return out;
  const db = await openDb();
  await new Promise((resolve) => {
    const range = IDBKeyRange.bound([profileId, ''], [profileId, '￿']);
    const req = db.transaction('profileVideoState').objectStore('profileVideoState').openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      out.set(cur.value.key, cur.value);
      cur.continue();
    };
    req.onerror = () => resolve();
  });
  return out;
}

/**
 * v1.0.40 — the child's ⭐. Read-modify-write on ONE state row, so it cannot disturb the
 * gift/unwrap/resume fields sharing it.
 *
 * A removal writes `favOffAt` rather than clearing `favAt`: un-favouriting has to travel
 * between devices, and a deleted field carries no information for a union to merge (the
 * same reason the deny-list revokes instead of deleting, and the v1.0.36 channel lesson).
 * `plan.favActive` decides which of the two timestamps is current.
 *
 * NO NEW INDEX and therefore no DB_VERSION bump: the ⭐ folder is derived from the profile's
 * state map, which `app.loadGiftStates` already holds in memory for every render.
 */
export async function setFavourite(profileId, key, on, at = Date.now()) {
  if (!profileId || !key) return false;
  await tx(['profileVideoState'], 'readwrite', (s) => {
    const r = s.get([profileId, key]);
    r.onsuccess = () => {
      const cur = r.result || { profileId, key };
      s.put(on ? { ...cur, favAt: at } : { ...cur, favOffAt: at });
    };
  });
  return true;
}

/** Unwrap: set unwrappedAt, DELETE giftRank (drops out of by_gift automatically). */
export async function unwrapGift(profileId, key) {
  await tx(['profileVideoState', 'opLog'], 'readwrite', (s, ops) => {
    const r = s.get([profileId, key]);
    r.onsuccess = () => {
      const rec = r.result || { profileId, key };
      rec.unwrappedAt = rec.unwrappedAt || Date.now();
      delete rec.giftRank;
      s.put(rec);
    };
    ops.add({ scopeId: profScope(profileId), op: 'unwrap', key, at: Date.now() });
  });
}

/* ---------------- channels ---------------- */

export async function getChannel(channelId) {
  const db = await openDb();
  const r = await preq(db.transaction('channels').objectStore('channels').get(channelId));
  return r || null;
}
export async function putChannel(rec) {
  await tx(['channels'], 'readwrite', (c) => { c.put(rec); });
}

/**
 * v1.0.24 — "this device's WebView could not LOAD the channel's stored avatar".
 *
 * Deliberately in `meta`, NOT on the channel record. The sync's stages read a channel,
 * spend seconds on the network, and write the whole snapshot back (13 call sites do this),
 * so a marker written by the renderer mid-sync is silently reverted — measured, and it
 * swallowed the first version of this fix. It is also per-device by nature, like every
 * other channel field `drive.stripPerDeviceChannel` keeps off the wire.
 */
const logoFailKey = (channelId) => 'logofail:' + channelId;
export async function getLogoFailedAt(channelId) {
  return Number(await getMeta(logoFailKey(channelId))) || 0;
}
export async function setLogoFailedAt(channelId, at) {
  await putMeta(logoFailKey(channelId), at || 0);
}
export async function listLibraryChannels(libraryId) {
  const db = await openDb();
  const idx = db.transaction('libraryChannels').objectStore('libraryChannels').index('by_library');
  const r = await preq(idx.getAll(IDBKeyRange.bound([libraryId, -Infinity], [libraryId, Infinity])));
  return r || [];
}
/**
 * v1.0.22 — the `updatedAt` STAMP LIVES HERE, not at the nine call sites. This record
 * carries `autoApprove`, i.e. "the parent approved this whole channel", and
 * `drive.mergeLibraryChannel` resolves two devices by that timestamp. Nobody set it, so
 * both sides compared 0 > 0, the FIRST document won, and the toggle converged on
 * whichever order the merge happened to run in — provably order-dependent.
 * `preserveTimestamp` is for the ONE caller that must not restamp: applying a merged
 * remote record (drive.applyRemoteDoc). Restamping there would make every applied record
 * instantly "newer" than the peer's, and the two devices would ping-pong forever.
 */
export async function putLibraryChannel(rec, { preserveTimestamp = false } = {}) {
  const out = preserveTimestamp && rec.updatedAt ? rec : { ...rec, updatedAt: Date.now() };
  await tx(['libraryChannels'], 'readwrite', (s) => { s.put(out); });
}
/* v1.0.36 — CHANNEL-DELETION TOMBSTONES. Deleting a subscription used to be pure row
   ABSENCE, and absence carries no information: every Drive merge is a union, so any
   peer (or any stale doc) still holding the row silently re-subscribed the family to
   the exact channel the parent threw out (field report — "the channel comes back").
   Same disease `deletedProfiles` and the video deny-list already cured; channels never
   got the treatment. Shape: one meta key per library → { channelId: deletedAt }. The
   LATEST deletion wins the map merge (drive.mergeDeletedChannels — unlike profiles'
   min-merge, because a channel CAN be legitimately re-added and deleted again), and a
   row outlives the tombstone only when its own `updatedAt` is STRICTLY newer — a
   deliberate re-add (sheet row, in-app add, snapshot import) stamps a fresh updatedAt
   and wins; a tie is a deletion (resurrecting a deleted channel is the betrayal,
   re-hiding a re-added one is a complaint). */
const chDelKey = (libraryId) => 'chDel:' + libraryId;
export async function getDeletedChannels(libraryId) {
  const raw = await getMeta(chDelKey(libraryId));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}
export async function putDeletedChannels(libraryId, map) {
  await putMeta(chDelKey(libraryId), map && typeof map === 'object' ? map : {});
}

/* ---------------- approved websites (v1.0.45) ----------------
   ONE store, two kinds:
     kind:'shortcut' — {url, title, iconId}   the tiles the CHILD sees
     kind:'rule'     — {display, host, port, segments[], allowExternal}   where they may go
   A rule may be a sub-path or an entirely different site, which is exactly why it is not
   shown as a tile. Scope is a PROFILE scope ('prof:<id>'), so two children on one account
   never inherit each other's browsing surface. */

export async function listSiteEntries(scopeId) {
  const db = await openDb();
  // ⚠️ THE PRIMARY KEY, NOT THE by_scope INDEX. IndexedDB leaves a record OUT of an index
  // entirely when any component of its index key is undefined — and `by_scope` is
  // ['scopeId', 'order']. So a row written without `order` (a peer on another version, a
  // hand-edited snapshot, any future writer) EXISTS in the store and is invisible to every
  // reader, permanently and silently. Measured in the browser: getAll() on the store
  // returned both rows while this function returned none. That failure mode presents as
  // "the sync is broken" and cannot be diagnosed from any screen.
  //
  // The keyPath is ['scopeId', 'entryId'] and both are always present — a row without them
  // cannot be stored at all — so this range can never hide anything. The index bought
  // nothing: every caller sorts by `order` in JS anyway (see app.siteShortcuts).
  const store = db.transaction('siteEntries').objectStore('siteEntries');
  const r = await preq(store.getAll(IDBKeyRange.bound([scopeId, ''], [scopeId, '\uffff'])));
  return r || [];
}

/**
 * The `updatedAt` STAMP LIVES HERE, not at the call sites — the v1.0.22 putLibraryChannel
 * lesson. `drive.mergeSiteEntry` resolves two devices by this timestamp; a field nobody
 * stamps makes every comparison 0 > 0, so the FIRST document wins and the merge becomes
 * order-dependent, which is the same as saying it is broken.
 * `preserveTimestamp` is for the one caller applying an already-merged remote record.
 */
export async function putSiteEntry(rec, { preserveTimestamp = false } = {}) {
  const base = preserveTimestamp && rec.updatedAt ? rec : { ...rec, updatedAt: Date.now() };
  // `order` is what the tile order is sorted by, and a row missing it used to be dropped
  // from the by_scope index outright. Defaulted HERE, not at the nine call sites — the
  // v1.0.22 putLibraryChannel lesson — so no writer can produce a malformed row again.
  const out = Number.isFinite(Number(base.order)) ? base : { ...base, order: 0 };
  await tx(['siteEntries'], 'readwrite', (s) => { s.put(out); });
}

/* Deletion tombstones, mirroring chDel: exactly — see the v1.0.36 note above. A removed
   site must STAY removed: every Drive merge is a union, so absence alone is re-added by
   any peer that has not pulled yet. */
const siteDelKey = (scopeId) => 'siteDel:' + scopeId;
export async function getDeletedSiteEntries(scopeId) {
  const raw = await getMeta(siteDelKey(scopeId));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}
export async function putDeletedSiteEntries(scopeId, map) {
  await putMeta(siteDelKey(scopeId), map && typeof map === 'object' ? map : {});
}

export async function deleteSiteEntry(scopeId, entryId, { tombstone = true, tombstoneAt } = {}) {
  // TOMBSTONE FIRST — a crash between the two writes must leave the intent recorded.
  if (tombstone) {
    const map = await getDeletedSiteEntries(scopeId);
    const at = tombstoneAt || Date.now();
    map[entryId] = Math.max(Number(map[entryId]) || 0, at);
    await putDeletedSiteEntries(scopeId, map);
  }
  await tx(['siteEntries'], 'readwrite', (s) => { s.delete([scopeId, entryId]); });
}

/* ---------------- custom folders (v1.0.56) ----------------
   A parent-created folder for single videos and files. The record here is METADATA
   ONLY — `{scopeId, folderId:'cf:<id>', title, emoji, artThumbId, artSrcUrl, order,
   createdAt, updatedAt}`; membership is the video's own `folderId`, which is why every
   existing folder mechanism (paging, the watch-grid chain, search, parking via
   homeFolderId) works on these with no new branch.

   Scope is the LIBRARY scope: the videos these folders hold are library records, and a
   folder scoped anywhere else could never contain them. Siblings sharing a legacy
   library therefore share the folders too — same as they already share the content. */

export async function listCustomFolders(scopeId) {
  const db = await openDb();
  const store = db.transaction('customFolders').objectStore('customFolders');
  const r = await preq(store.getAll(IDBKeyRange.bound([scopeId, ''], [scopeId, '￿'])));
  return r || [];
}

export async function getCustomFolder(scopeId, folderId) {
  const db = await openDb();
  return (await preq(db.transaction('customFolders').objectStore('customFolders').get([scopeId, folderId]))) || null;
}

/** `updatedAt` is stamped HERE, never at the call sites — the v1.0.22 putLibraryChannel
 *  lesson: drive.mergeCustomFolder resolves two devices by it, and a field nobody stamps
 *  makes every comparison `0 > 0`, i.e. order-dependent, i.e. broken. */
export async function putCustomFolder(rec, { preserveTimestamp = false } = {}) {
  const base = preserveTimestamp && rec.updatedAt ? rec : { ...rec, updatedAt: Date.now() };
  const out = Number.isFinite(Number(base.order)) ? base : { ...base, order: base.createdAt || 0 };
  await tx(['customFolders'], 'readwrite', (s) => { s.put(out); });
}

const cfDelKey = (scopeId) => 'cfDel:' + scopeId;
export async function getDeletedCustomFolders(scopeId) {
  const raw = await getMeta(cfDelKey(scopeId));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}
export async function putDeletedCustomFolders(scopeId, map) {
  await putMeta(cfDelKey(scopeId), map && typeof map === 'object' ? map : {});
}

/** TOMBSTONE FIRST (the chDel/siteDel rule): every Drive merge is a union, so absence
 *  alone is re-added by any peer that has not pulled. `tombstone:false` is for
 *  drive.applyRemoteDoc applying a peer's own tombstone. This deletes ONLY the folder
 *  row — what happens to the videos inside is the caller's decision (app.deleteCustomFolder
 *  asks the parent), because it is the difference between moving and destroying. */
export async function deleteCustomFolder(scopeId, folderId, { tombstone = true, tombstoneAt } = {}) {
  if (tombstone) {
    const map = await getDeletedCustomFolders(scopeId);
    const at = tombstoneAt || Date.now();
    map[folderId] = Math.max(Number(map[folderId]) || 0, at);
    await putDeletedCustomFolders(scopeId, map);
  }
  await tx(['customFolders'], 'readwrite', (s) => { s.delete([scopeId, folderId]); });
}

/** Re-home every record filed under `folderId` (live rows by folderId, parked rows by
 *  homeFolderId — a pending video must land in the right place when it is approved).
 *  Returns how many moved. Chunked through putVideos like every other bulk write. */
export async function moveFolderVideos(scopeId, folderId, targetFolderId) {
  const all = [...(await loadMergeIndex(scopeId)).values()];
  const now = Date.now();
  const out = [];
  for (const rec of all) {
    const parked = rec.folderId === '~pending' || rec.folderId === '~rejected';
    const home = parked ? rec.homeFolderId : rec.folderId;
    if (home !== folderId) continue;
    out.push(parked
      ? { ...rec, homeFolderId: targetFolderId, updatedAt: now }
      : { ...rec, folderId: targetFolderId, homeFolderId: rec.homeFolderId ? targetFolderId : rec.homeFolderId, updatedAt: now });
  }
  if (out.length) await putVideos(out);
  return out.length;
}

export async function deleteLibraryChannel(libraryId, channelId, { tombstone = true, tombstoneAt } = {}) {
  // TOMBSTONE FIRST: a crash between the two writes must leave the intent recorded, or
  // the interrupted deletion resurrects silently.
  // `tombstone: false` is for the one caller that is NOT a parental deletion —
  // drive.applyRemoteDoc (applying a peer's tombstone, whose own `at` must be preserved
  // or the two devices restamp each other forever).
  if (tombstone) {
    const map = await getDeletedChannels(libraryId);
    const at = tombstoneAt || Date.now();
    map[channelId] = Math.max(Number(map[channelId]) || 0, at);
    await putDeletedChannels(libraryId, map);
  }
  await tx(['libraryChannels'], 'readwrite', (s) => { s.delete([libraryId, channelId]); });
  // v1.0.18 — REARM THE BACKFILL. Unsubscribing removes the libraryChannels row,
  // but the GLOBAL channels record survives with `backfillDone: true`, so on a
  // re-subscribe planChannelFetch (quota.js) returns 'rss' and only the ~15 videos
  // in the feed window ever come back — the whole back catalogue is gone for good,
  // while the confirm dialog explicitly promises "אפשר להוסיף אותו שוב בעתיד".
  // Only rearm once NO library still subscribes: another profile's sheet may share
  // this channel, and re-backfilling a live subscription burns YouTube quota.
  const db = await openDb();
  const rows = await preq(db.transaction('libraryChannels').objectStore('libraryChannels').getAll());
  if ((rows || []).some((r) => r.channelId === channelId)) return;
  const ch = await getChannel(channelId);
  // uploadsPlaylistId and the logo are kept — they cost a lookup/scrape to rebuild
  // and never go stale; only the cursor is state that must not outlive the sub.
  // v1.0.21: the PLAYLISTS walk is a second source with the same problem — a surviving
  // `playlistsDone` meant a re-added channel never re-imported its playlist content, and
  // a surviving `noLongForm` kept it closed AND kept showing the parent "only Shorts".
  if (ch) {
    await putChannel({
      ...ch,
      backfillCursor: null, backfillDone: false, backfillPlaylistId: null,
      playlistCursor: null, playlistQueue: null, playlistsDone: false, noLongForm: false,
      // v1.0.91: the cap-recovery bookkeeping goes with the rest of the progress. The
      // walk is already re-armed by the lines above, so a surviving `backfillCappedAt`
      // could only buy one pointless re-arm, and a surviving `backfillRearmedAt` would
      // hold the re-added channel's FIRST genuine recovery back by up to a day.
      backfillCappedAt: null, backfillRearmedAt: null
    });
  }
}

/* ---------------- thumbs (Blob cache) ---------------- */

export async function getThumbBlob(id) {
  const db = await openDb();
  const r = await preq(db.transaction('thumbs').objectStore('thumbs').get(id));
  return r ? r.blob : null;
}
/** Full record (blob + meta). The logo cache needs `srcUrl` to detect a rebrand (v1.0.32). */
export async function getThumbRecord(id) {
  const db = await openDb();
  return (await preq(db.transaction('thumbs').objectStore('thumbs').get(id))) || null;
}
export async function putThumb(id, blob, meta = {}) {
  await tx(['thumbs'], 'readwrite', (t) => {
    t.put({ id, blob, bytes: blob && blob.size || 0, lastUsed: Date.now(), ...meta });
  });
}
/** Batched LRU bump — one transaction per RENDER, not per <img>. */
export async function touchThumbs(ids) {
  if (!ids || !ids.length) return;
  const now = Date.now();
  await tx(['thumbs'], 'readwrite', (t) => {
    for (const id of ids) {
      const r = t.get(id);
      r.onsuccess = () => { if (r.result) { r.result.lastUsed = now; t.put(r.result); } };
    }
  });
}
export async function evictThumbs({ maxBytes = 120 * 1024 * 1024, maxCount = 6000, pinned = new Set() } = {}) {
  const db = await openDb();
  const all = await preq(db.transaction('thumbs').objectStore('thumbs').index('by_lastUsed').getAllKeys());
  // stats maintained lazily: count via keys, bytes via meta record
  const stats = (await getMeta('thumbStats')) || { bytes: 0 };
  if (all.length <= maxCount && stats.bytes <= maxBytes) return 0;
  const target = Math.floor(Math.min(maxCount, all.length) * 0.8);
  let removed = 0;
  await tx(['thumbs'], 'readwrite', (t) => {
    const req = t.index('by_lastUsed').openCursor(); // oldest first
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (all.length - removed > target && !pinned.has(cur.value.id)) {
        cur.delete(); removed += 1;
      }
      if (all.length - removed > target) cur.continue();
    };
  });
  return removed;
}

/* ---------------- denylist ---------------- */

/**
 * v1.0.10: a deny entry can be REVOKED (removedAt >= at) — the sheet re-adding a key
 * is the one deliberate undeny path ("the sheet wins"). Revoked entries stay stored
 * (they must travel through Drive merges to defeat stale denies on other devices)
 * but are INERT: loadDenySet exposes only the active ones.
 */
export const denyActive = (d) => !!d && !(d.removedAt >= (d.at || 0));

/**
 * v1.0.22 — PURE: the deny row to write when unioning one scope's tombstones into
 * another, or `null` for "leave the target alone".
 *
 * TWO bugs this closes, both from deciding "is it missing?" with `loadDenySet` (which
 * exposes ACTIVE entries only):
 *  - a REVOKED target entry read as absent, so it was `put` over and lost its
 *    `removedAt` — silently undoing the one deliberate undeny path ("the sheet wins").
 *  - the replacement was stamped `at: Date.now()`, which always wins Drive's
 *    last-event comparison, so the resurrected tombstone propagated and deleted the
 *    video on every other device. A tombstone must carry the SOURCE event's time.
 */
export function denyRowToWrite(existing, incoming, toScope) {
  if (!incoming || !incoming.key) return null;
  if (existing) return null; // present in any form (active OR revoked) — never overwrite
  return {
    scopeId: toScope,
    key: incoming.key,
    at: Number(incoming.at) || 0,
    ...(incoming.removedAt ? { removedAt: Number(incoming.removedAt) } : {}),
    reason: incoming.reason || 'scope-merge'
  };
}

export async function loadDenySet(scopeId) {
  const recs = await loadDenyRecords(scopeId);
  return new Set(recs.filter(denyActive).map((d) => d.key));
}

/** FULL deny rows (active + revoked) — the Drive doc must carry both. */
export async function loadDenyRecords(scopeId) {
  const db = await openDb();
  const range = IDBKeyRange.bound([scopeId, ''], [scopeId, '￿']);
  return (await preq(db.transaction('denylist').objectStore('denylist').getAll(range))) || [];
}
/**
 * Union tombstones from one scope into another (v1.0.6 mine→shared absorb):
 * only keys MISSING in the target are written, so repeated runs are no-ops and the
 * original deny timestamps in the target are never overwritten.
 */
export async function copyDenies(fromScope, toScope) {
  // FULL rows on BOTH sides: presence must be judged by the record existing, not by it
  // being active, and the source's own `at` has to travel (see denyRowToWrite).
  const fromRows = await loadDenyRecords(fromScope);
  if (!fromRows.length) return 0;
  const have = new Map((await loadDenyRecords(toScope)).map((d) => [d.key, d]));
  const rows = fromRows.map((d) => denyRowToWrite(have.get(d.key), d, toScope)).filter(Boolean);
  if (!rows.length) return 0;
  await tx(['denylist'], 'readwrite', (deny) => { for (const r of rows) deny.put(r); });
  return rows.length;
}

/**
 * v1.0.10: unDeny REVOKES instead of deleting — the inert marker (removedAt) must
 * out-merge stale active denies still sitting in Drive docs of other devices.
 */
/* v1.0.17's moveScope lived here until v1.0.38. Its one caller was attaching/changing a
 * SHEET (the scope was derived from the sheet URL), and that act is gone. Nothing may
 * change a profile's libraryId any more — the sunset migration's safety rests on it. */

export async function unDeny(scopeId, key) {
  const db = await openDb();
  const prev = await preq(db.transaction('denylist').objectStore('denylist').get([scopeId, key]));
  await tx(['denylist', 'opLog'], 'readwrite', (deny, ops) => {
    deny.put({ ...(prev || { scopeId, key, at: 0 }), removedAt: Date.now() });
    ops.add({ scopeId, op: 'undeny', key, at: Date.now() });
  });
}

/* ---------------- sources / meta / oplog ---------------- */

export async function getSources(profileId) {
  const db = await openDb();
  const r = await preq(db.transaction('sources').objectStore('sources').get(profileId));
  return r || null;
}
export async function putSources(rec) {
  await tx(['sources'], 'readwrite', (s) => { s.put(rec); });
}

export async function getMeta(id) {
  const db = await openDb();
  const r = await preq(db.transaction('meta').objectStore('meta').get(id));
  return r ? r.v : null;
}
export async function putMeta(id, v) {
  await tx(['meta'], 'readwrite', (m) => { m.put({ id, v }); });
}
export async function patchMeta(id, patch) {
  await tx(['meta'], 'readwrite', (m) => {
    const r = m.get(id);
    r.onsuccess = () => { m.put({ id, v: { ...(r.result && r.result.v || {}), ...patch } }); };
  });
}

export async function appendOp(op) {
  await tx(['opLog'], 'readwrite', (ops) => { ops.add({ ...op, at: op.at || Date.now() }); });
}
export async function listOpsSince(seq = 0) {
  const db = await openDb();
  const r = await preq(db.transaction('opLog').objectStore('opLog').getAll(IDBKeyRange.lowerBound(seq, true)));
  return r || [];
}
export async function compactOpsThrough(seq) {
  await tx(['opLog'], 'readwrite', (ops) => { ops.delete(IDBKeyRange.upperBound(seq)); });
}

/* ---------------- profile lifecycle ---------------- */

/**
 * Erase a deleted profile's data.
 *
 * `scopes` comes from pure `plan.planProfilePurge` and is the caller's decision: the
 * personal `prof:<id>` scope always, PLUS the library scope when no sibling profile still
 * reads it. Passing none keeps the old "personal data only" behaviour.
 *
 * This had ZERO callers until v1.0.25 while `deleteCurrentProfile` promised the deletion
 * was permanent — measured: a throwaway profile with one channel kept all 500 videos, its
 * subscription and its sources record. It also only ever cleared `prof:<id>`, which for a
 * sheet-less profile (scope `lib:p:<id>`) is where almost nothing lives.
 */
export async function purgeProfile(profileId, scopes = null) {
  const list = (Array.isArray(scopes) && scopes.length) ? scopes : [profScope(profileId)];
  const range = (s) => IDBKeyRange.bound([s, ''], [s, '￿']);
  // Per-library bookkeeping. DELETED, not written as null: `putMeta(k, null)` leaves the
  // row in place, and these would otherwise keep a purged library "recently synced" and
  // re-alert about a mirror divergence for content that no longer exists.
  const metaKeys = [];
  for (const s of list) {
    // v1.0.45: the site tombstones live on PROFILE scopes, so this key is collected for
    // every scope. The library-only keys below stay gated — asking for
    // 'sheetMirrorAlert:prof:x' would just delete a row that never existed, but the
    // site key genuinely lives there, and leaving it behind means a profile deleted and
    // recreated with the same id inherits tombstones that silently swallow its new sites.
    metaKeys.push(siteDelKey(s));
    if (!String(s).startsWith('lib:')) continue;
    metaKeys.push('sync:' + s + ':lastFullSyncAt', 'sheetMirrorAlert:' + s,
      'sheetMirrorIgnoredSig:' + s, 'dedupe:' + s, chDelKey(s), cfDelKey(s));
  }
  await tx(['videos', 'denylist', 'libraryChannels', 'siteEntries', 'customFolders', 'profileVideoState', 'sources', 'meta', 'opLog'], 'readwrite',
    (videos, deny, libCh, sites, cfs, pvs, sources, meta, ops) => {
      for (const s of list) {
        videos.delete(range(s));
        deny.delete(range(s));
        // libraryChannels is keyed [libraryId, channelId] — a purged library's
        // subscriptions are orphans the moment its videos are gone.
        libCh.delete(range(s));
        sites.delete(range(s));
        cfs.delete(range(s)); // v1.0.56 — same reason: folders of a library that is gone
      }
      for (const k of metaKeys) meta.delete(k);
      pvs.delete(IDBKeyRange.bound([profileId, ''], [profileId, '￿']));
      sources.delete(profileId);
      ops.add({ scopeId: profScope(profileId), op: 'purge-profile', at: Date.now() });
    });
}
