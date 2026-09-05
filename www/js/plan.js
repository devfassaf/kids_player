// plan.js — the architectural centerpiece of sync: ONE pure function decides which
// records are written, merged, gifted, denied, or routed to parental approval.
// db.js only executes the returned plan. Everything here is node-tested; the single
// most important assertion in the suite is that running planMutations twice yields an
// EMPTY second diff (sync never churns the DB or re-gifts on every launch).

import { normalizeTitle, mergeVideoRecord, settleCuration } from './normalize.js';
import { sortKeyFor, compareForDisplay } from './order.js';
import { MAX_ITEMS_PER_CHANNEL, MAX_ITEMS_TOTAL, SWIPE_MIN_PX, SWIPE_MAX_MS, SWIPE_RATIO,
  SWIPE_ARM_PX, SWIPE_COMMIT_RATIO, SWIPE_RUBBER, SWIPE_RUBBER_MAX,
  RECENT_DEFAULT_LIMIT, RECENT_MAX_LIMIT, CACHE_MAX_AGE_MS, EMPTY_FOLDER_GRACE_MS } from './config.js';

/**
 * v1.0.37 — PURE: the caps a sync actually enforces.
 *
 * FIELD BUG this fixes ("הערוץ נוסף אבל אין בו סרטונים", @BARDAK613, reported across
 * four releases). `maxItemsPerChannel: 500, maxItemsTotal: 5000` were LITERALS written
 * into a profile's `sources` row the day it was created — six copies across app.js,
 * drive.js, share.js, sync2.js and migrate.js — while `config.js` carried the same two
 * names with NOT ONE consumer. So the ceiling was frozen per profile, invisible, and
 * unraisable by anybody: a parent with 16 channels sat at 5000 records and EVERY new
 * channel imported exactly nothing, silently, forever (measured: 98 real candidates in,
 * 98 `capped`, 0 puts).
 *
 * The config value is therefore the FLOOR, not a default: that is what heals the rows
 * already frozen at 5000 without a migration. A stored value is only honoured when it
 * is HIGHER (nothing writes one today, and shrinking a family's library from a stale
 * row would be the same class of silent loss).
 */
export function effectiveCaps(src) {
  const stored = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0);
  return {
    maxPerChannel: Math.max(MAX_ITEMS_PER_CHANNEL, stored(src && src.maxItemsPerChannel)),
    maxTotal: Math.max(MAX_ITEMS_TOTAL, stored(src && src.maxItemsTotal))
  };
}

/** Fields that constitute "the record changed" (put emitted only when one differs). */
const DIFF_FIELDS = [
  'title', 'titleSource', 'normTitle', 'folderId', 'channelId', 'sortKey', 'state',
  'thumbUrl', 'thumbId', 'localPath', 'publishedAt', 'rowIndex', 'origin', 'url', 'srcUrl'
];
const changed = (a, b) => DIFF_FIELDS.some((f) => (a[f] ?? null) !== (b[f] ?? null));

/**
 * v1.0.25 — PURE: a caller asked for a sync. Start one, or ride an existing one?
 *
 * FIELD BUG this fixes. v1.0.21 declared "a FORCED sync CHAINS, NEVER JOINS" and wrote the
 * comment above `syncLibrary` saying so — but the condition it shipped was
 * `if (!opts.force || cur.force) return cur.promise`, which JOINS whenever the running sync
 * is itself forced. The first sync of every launch IS forced and takes minutes on a real
 * library (a page fetch per channel logo, up to 40 backfill pages). So everything a parent
 * did inside that window rode a run that had ALREADY read the library:
 *   - adding a channel: the run listed the channels before the new one existed, finished
 *     "successfully", and `offerChannelApproval` then found 0 pending videos — so the
 *     three-way dialog never appeared and the parent was told "הערוץ סונכרן ✅" over an
 *     empty import. Pressing "רענון נתונים" (no run in flight) fixed it, which is exactly
 *     how it was reported from the field;
 *   - every `refreshAfterAdd` path: the new record kept no `srcChannelId` (so it sat in the
 *     loose list instead of its channel folder) and no `giftRank` (so it was not a 🎁) —
 *     the precise bug `refreshAfterAdd` was written to prevent, reintroduced by the race.
 *
 * The rule, and why each branch is the correct one:
 *   - not forced          → 'join-running'. The caller wrote nothing; any recent run answers it.
 *   - forced, one QUEUED  → 'join-queued'. A queued run has not read anything yet, so it is
 *                           guaranteed to observe this caller's writes. This branch is what
 *                           keeps three adds in a row from queueing three full sweeps.
 *   - forced, one RUNNING → 'queue'. It has already read; only a later run can see us.
 *   - nothing in flight   → 'start'.
 *
 * @param running whether a run is currently executing
 * @param queued  whether a run is already queued behind it (not yet started)
 * @param force   does this caller need state as of NOW (it just wrote something)?
 */
export function planSyncDispatch({ running = false, queued = false, force = false } = {}) {
  if (!running) return 'start';
  if (!force) return 'join-running';
  return queued ? 'join-queued' : 'queue';
}

/**
 * v1.0.25 — PURE: entering the home screen. Pull the family's shared state? Force the sync?
 *
 * The ORDER these two run in is the invariant (pull, THEN sync — they write the same video
 * records), and that lives in app.js. What lives here is WHETHER each one runs, because
 * both gates are easy to get wrong in opposite directions: a pull on every single gallery
 * entry hammers Drive, and a pull that never runs on launch is how an approval made on the
 * phone sat in Drive with no code path on the tablet that read it (v1.0.22).
 *
 * The FIRST entry of each launch is unconditional on both counts: the 3-minute sync
 * throttle and the 60-second pull throttle exist for a child flipping between the home and
 * a video, not for someone who just opened the app.
 *
 * @param launchDone      has the once-per-process launch refresh already run?
 * @param sinceLastPullMs how long ago the last successful pull finished
 * @param pullThrottleMs  the quiet period between pulls
 */
export function planEntryRefresh({ launchDone = false, sinceLastPullMs = Infinity, pullThrottleMs = 60000 } = {}) {
  const first = !launchDone;
  return { pull: first || sinceLastPullMs >= pullThrottleMs, forceSync: first };
}

/**
 * v1.0.26 — PURE: which folder does a video pulled from a standalone PLAYLIST belong in?
 *
 * A playlist is a subscription like a channel (same `libraryChannels` row, `kind:'playlist'`)
 * but its videos can come from anywhere. THE PARENT'S RULE: adding a channel and a playlist
 * of that same channel must not produce two folders holding the same videos — they unify
 * into the channel.
 *
 * Duplicate RECORDS were never the risk: `planMutations` keys on `yt:<videoId>`, so one
 * video arriving from both sources collapses to one row. The FOLDER is the risk — if the
 * two passes disagreed, `folderId` is in DIFF_FIELDS and the record would be rewritten on
 * every single sync, flipping between folders and breaking the churn-free invariant. Both
 * passes therefore have to answer this one question the same way.
 *
 * It also heals in the other order: add the playlist first, subscribe to the channel later,
 * and the next sync moves those videos into the channel folder by itself.
 *
 * The same shape of decision v1.0.21 already made for a channel's OWN playlists tab, where
 * the videos land in the channel's folder rather than a per-playlist one.
 *
 * @param ownerChannelId       videoOwnerChannelId from playlistItems (may be missing)
 * @param playlistId           the playlist being walked
 * @param subscribedChannelIds channels this library subscribes to
 */
export function playlistVideoFolder({ ownerChannelId, playlistId, subscribedChannelIds } = {}) {
  const owner = String(ownerChannelId || '');
  const subs = subscribedChannelIds instanceof Set
    ? subscribedChannelIds
    : new Set(subscribedChannelIds || []);
  if (owner && subs.has(owner)) return 'ch:' + owner;
  return playlistId ? 'pl:' + playlistId : null;
}

/**
 * v1.0.29 — PURE: which profile does the app open INTO on launch?
 *
 * Parent's request: the last-used profile loads automatically, so a child who owns the
 * device lands straight in their library. DEVICE-LOCAL BY DESIGN: the stored id lives in
 * Preferences (never synced — the settings channel is a different mechanism), because one
 * Google account often serves several devices, each belonging to a DIFFERENT child.
 *
 * Falls back to the picker (null) in exactly three cases, each load-bearing:
 *  - nothing stored (first launch, or a fresh install);
 *  - the stored id no longer exists (the profile was deleted, possibly on a peer device —
 *    auto-entering a ghost would crash activation or resurrect a tombstoned profile's UI);
 *  - a SHARE is queued from a cold start: since v1.0.23 the boot picker IS the share's
 *    routing question ("the profile the parent taps is the answer", alreadyRouted:true) —
 *    auto-skipping it would route the share with nobody having chosen a destination.
 */
export function planBootProfile({ storedId, profileIds, hasQueuedShare = false } = {}) {
  if (hasQueuedShare) return null;
  const id = String(storedId || '');
  if (!id) return null;
  const ids = profileIds instanceof Set ? profileIds : new Set(profileIds || []);
  return ids.has(id) ? id : null;
}

/**
 * v1.0.28 — PURE: group the parent's library list by the folder the child sees.
 *
 * The הוספה tab used to render one flat list of every live video (capped at
 * PARENT_LIST_CAP) — with a few channels that is hundreds of rows the parent must scroll
 * past just to reach the add form. The parent's request: everything collapsed, grouped
 * by the folder name the video actually lives in, all sections closed by default.
 *
 * Grouping is by the HOME folder (`homeFolderId || folderId`), the same identity the
 * child's grid files by; titles resolve from the subscriptions list (a playlist's title
 * lives in `titleOverride`/`title` on its row). Group order mirrors the home screen:
 * channels/playlists by their `order`, then the loose lists. Videos inside keep the
 * caller's order (newest first).
 *
 * @param records       live records, already display-sorted
 * @param subscriptions the library's `libraryChannels` rows
 * @returns [{ id, title, records }] — never empty groups
 */
export function groupLibraryByFolder(records, subscriptions = [], customFolders = []) {
  const subs = new Map();
  for (const c of subscriptions || []) {
    if (!c || !c.channelId) continue;
    const prefix = c.kind === 'playlist' ? 'pl:' : 'ch:';
    subs.set(prefix + c.channelId, {
      title: c.titleOverride || c.title || (c.kind === 'playlist' ? 'רשימת השמעה' : 'ערוץ'),
      order: c.order || 0
    });
  }
  // v1.0.56 — the parent's own folders. Their titles live in a store, not on the record.
  const custom = new Map();
  for (const f of customFolders || []) {
    if (f && f.folderId) custom.set(f.folderId, { title: f.title || 'תיקיה', order: f.order || 0 });
  }
  const groups = new Map();
  for (const rec of records || []) {
    if (!rec || !rec.key) continue;
    const folder = rec.homeFolderId || rec.folderId || 'sheet';
    let id = folder, title;
    if (subs.has(folder)) title = subs.get(folder).title;
    else if (folder.startsWith('ch:') || folder.startsWith('pl:')) {
      // an unsubscribed leftover — group it, never lose it
      title = rec.srcChannelTitle || (folder.startsWith('pl:') ? 'רשימת השמעה' : 'ערוץ');
    } else if (isCustomFolder(folder)) {
      // its own section even when the metadata row is missing (a peer's folder that has
      // not synced yet): folding it into "סרטונים נוספים" would tell the parent these
      // videos live somewhere they do not, and the section would silently disagree with
      // the child's home screen.
      title = custom.has(folder) ? custom.get(folder).title : 'תיקיה';
    } else if (folder === 'mine') { id = 'mine'; title = 'סרטונים אישיים'; }
    else { id = 'sheet'; title = 'סרטונים נוספים'; }
    if (!groups.has(id)) groups.set(id, { id, title, records: [] });
    groups.get(id).records.push(rec);
  }
  // deterministic tail: subscriptions by their own order, then unsubscribed leftovers
  // (alphabetical among themselves), then the shared list, then the personal one —
  // the same prominence order the child's home gives them
  const orderOf = (g) => {
    if (subs.has(g.id)) return subs.get(g.id).order;
    if (g.id === 'sheet') return Number.MAX_SAFE_INTEGER - 1;
    if (g.id === 'mine') return Number.MAX_SAFE_INTEGER;
    // a parent-created folder sorts by its own creation order, ahead of the leftovers
    if (custom.has(g.id)) return custom.get(g.id).order;
    return Number.MAX_SAFE_INTEGER - 2;
  };
  return [...groups.values()].sort((a, b) => {
    const oa = orderOf(a), ob = orderOf(b);
    if (oa !== ob) return oa - ob;
    return a.title.localeCompare(b.title, 'he');
  });
}

/**
 * v1.0.27 — PURE: which records are ORPHANS the mirror's GC may raw-delete?
 *
 * FIELD-CLASS DATA LOSS (review-caught, shipped in v1.0.26). The GC's old predicate was
 * one line: `rec.channelId && !subscribed.has(rec.channelId)`. A standalone PLAYLIST
 * subscription keeps the playlist id in the `channelId` slot, but every video it imports
 * keeps its OWNER channel in `channelId` — deliberately (the title-dedupe index and the
 * unify rule key on it). So `subscribed` held `PL…` while the records held `UC…`, and the
 * GC deleted EVERY foreign-owner playlist video on EVERY mirror pass: imported, wiped,
 * re-imported as pending, with every approval AND every rejection undone in a 30-minute
 * loop. `deleteVideoRaw` writes no tombstone, so rejections did not survive — breaching
 * "A REJECTION MUST SURVIVE EVERY LATER SYNC".
 *
 * The rule: a record is an orphan only when NEITHER home claims it —
 *   - its channelId is a subscribed CHANNEL, or
 *   - its FOLDER is a subscribed PLAYLIST's folder (`pl:<id>`). Parked records are judged
 *     by `homeFolderId` (the folder they will return to), because parking moves
 *     `folderId` to `~pending`/`~rejected` and the GC must not treat a parked playlist
 *     video as homeless.
 * A record with NO channelId is kept, as it always was: the GC has never had an opinion
 * about manual/direct-file records.
 *
 * @param records       iterable of video records
 * @param subscriptions the library's `libraryChannels` rows ({ channelId, kind })
 * @returns keys to raw-delete
 */
export function planOrphanGC(records, subscriptions) {
  const subs = [...(subscriptions || [])].filter(Boolean);
  const channelIds = new Set(subs.map((c) => c.channelId));
  const playlistFolders = new Set(subs.filter((c) => c.kind === 'playlist').map((c) => 'pl:' + c.channelId));
  const out = [];
  for (const rec of records || []) {
    if (!rec || !rec.key || !rec.channelId) continue;
    const folder = (rec.folderId === '~pending' || rec.folderId === '~rejected')
      ? rec.homeFolderId : rec.folderId;
    if (playlistFolders.has(folder)) continue;
    if (!channelIds.has(rec.channelId)) out.push(rec.key);
  }
  return out;
}

/**
 * v1.0.38 — PURE: may this orphan sweep proceed, or is it too big to be routine?
 *
 * WHY IT NEEDS A VALVE NOW. `planOrphanGC` only ever ran inside `applySheetMirror`, which
 * only ran under `if (sheetParsed)` — so a profile with NO sheet never ran it at all, and
 * after this release that is every profile. Making it an unconditional stage is a bug fix
 * (a subscription deleted by a peer leaves its videos behind forever), but the first pass on
 * an existing install may find months of accumulated orphans, and `deleteVideoRaw` writes no
 * tombstone — so a mass sweep can churn against the Drive doc: deleted here, re-unioned by
 * the document, swept again.
 *
 * The rule is planSheetMirror's one genuinely good idea, reused for the one deletion path
 * that survives: anything above max(valveMin, valvePct) is parked, and so is a sweep that
 * would take EVERYTHING (the v1.0.18 total-disappearance rule — a child owning ≤10 things
 * was silently wiped by the percentage floor alone).
 *
 * A parked sweep FAILS TOWARD THE OLD BEHAVIOUR: the orphans simply stay, which is exactly
 * what happened for every sheet-less profile until now.
 */
export function orphanSweepValve(opts) {
  // `(opts || {})`, not a `= {}` default parameter — that only fires for `undefined`, and an
  // explicit null from a caller reading an absent record would throw (the Number(null) trap).
  const { orphanCount = 0, liveTotal = 0, valveMin = 10, valvePct = 0.05 } = opts || {};
  const n = Math.max(0, Number(orphanCount) | 0);
  const total = Math.max(0, Number(liveTotal) | 0);
  if (!n) return { sweep: false, parked: false, count: 0 };
  if (total && n >= total) return { sweep: false, parked: true, count: n };
  const ceiling = Math.max(valveMin, Math.floor(total * valvePct));
  return n > ceiling ? { sweep: false, parked: true, count: n } : { sweep: true, parked: false, count: n };
}

/**
 * v1.0.26 — PURE: which rejected records have run out of their recovery window?
 *
 * A rejection is PARKED, not deleted (v1.0.23), so the parent can pull it back. That makes
 * the archive grow forever, and a channel re-offers its whole catalogue every 30 minutes,
 * so the pile is not small. After the window the record is purged for real — the same
 * delete + deny tombstone "מחק לצמיתות" writes, which is what keeps the video from
 * returning on the next sync.
 *
 * ⚠️ THAT IS IRREVERSIBLE, and for a video inside a channel there is no way back at all:
 * the only thing that revokes a tombstone is the SHEET re-adding the key, and a channel
 * video has no row of its own. So the archive tells the parent, per row, how long is left.
 *
 * A record with NO `rejectedAt` is never purged. That is the safe direction for a row
 * written before this existed (or by a peer running an older app): showing an old video in
 * the archive costs nothing, deleting one the parent might still want back is permanent.
 *
 * @returns { expired: [keys], daysLeft: Map<key, number> }
 */
export function planRejectedPurge(records, { now = Date.now(), days = 30 } = {}) {
  // A nonsense window falls back to the DEFAULT, never to a short one. `Math.max(1, …)`
  // was wrong: a negative value clamped to a ONE-DAY window, so a config typo would have
  // emptied the whole archive permanently on the next sync.
  const n = Number(days);
  const ttl = (Number.isFinite(n) && n > 0 ? n : 30) * 24 * 60 * 60 * 1000;
  const expired = [];
  const daysLeft = new Map();
  for (const r of records || []) {
    if (!r || !r.key) continue;
    const at = Number(r.rejectedAt);
    if (!Number.isFinite(at) || at <= 0) continue;   // unknown age ⇒ never auto-purge
    const age = now - at;
    if (age >= ttl) { expired.push(r.key); continue; }
    daysLeft.set(r.key, Math.max(1, Math.ceil((ttl - age) / 86400000)));
  }
  return { expired, daysLeft };
}

/**
 * v1.0.26 — PURE: what the waiting screen says at each step of adding a channel.
 * -> { title, step } , or null for a stage nobody should be waiting on.
 *
 * REPORTED FROM THE FIELD: "adding a channel takes a while — that is fine — but I cannot
 * tell whether it is still working or waiting for me to tap." Only ONE step of the flow
 * ever showed anything (the long import), so between every other click the parent got the
 * ordinary screen back with work still running behind it, and no way to know whether
 * tapping would do something or interrupt something.
 *
 * The text lives here rather than inline because it is the whole feature: a waiting screen
 * with no explanation is the same ambiguity in a different colour. `invariants.test.mjs`
 * pins that every stage app.js actually waits on has an entry — the shareOutcome rule, for
 * the same reason (a stage added later with no text would silently show "בטעינה…").
 *
 * The COUNT is part of the sentence wherever we know it: "מאשרים 109 סרטונים" tells the
 * parent both what is happening and why it is not instant.
 */
const CHANNEL_ADD_WAITS = {
  resolve:  { title: 'מזהים את הערוץ', step: 'בודקים את הקישור מול יוטיוב…' },
  subscribe:{ title: 'מוסיפים את הערוץ', step: 'שומרים אותו ברשימת המקורות…' },
  approve:  { title: 'מאשרים את הסרטונים', step: 'עוד רגע והכול יהיה אצל הילד…' },
  building: { title: 'מכינים את רשימת הסרטונים', step: 'טוענים את מה שהערוץ הביא…' },
  saving:   { title: 'שומרים את הבחירה', step: 'מאשרים את מה שסימנתם…' },
  finishing:{ title: 'מסדרים את הספרייה', step: 'משבצים את הסרטונים בתיקיות ובמתנות…' },
  // v1.0.38 — the links file. Importing resolves every @handle in the file and then runs
  // ONE forced sync for the whole list, which is minutes on a 16-channel file; exporting
  // reads both scopes. Neither may run behind the ordinary screen.
  importing:{ title: 'מייבאים את הרשימה', step: 'מזהים את הערוצים ושומרים…' },
  exporting:{ title: 'מכינים את הקובץ', step: 'אוספים את הערוצים והסרטונים…' }
};

export function channelAddWait(stage, { count = 0 } = {}) {
  const base = CHANNEL_ADD_WAITS[stage];
  if (!base) return null;
  const n = Number(count);
  if (stage === 'approve' && Number.isFinite(n) && n > 0) {
    return { title: `מאשרים ${n} סרטונים`, step: base.step };
  }
  if (stage === 'building' && Number.isFinite(n) && n > 0) {
    return { title: base.title, step: `${n} סרטונים — עוד רגע…` };
  }
  if (stage === 'importing' && Number.isFinite(n) && n > 0) {
    return { title: base.title, step: `${n} לינקים — עוד רגע…` };
  }
  return { ...base };
}

export const CHANNEL_ADD_STAGES = Object.keys(CHANNEL_ADD_WAITS);

/**
 * v1.0.31 — PURE: the scheduled per-profile lock ("time to do something else").
 *
 * A parenting screen-time limit: after `afterMin` minutes of a session the app LOCKS for
 * `durationMin` minutes, then returns to normal and re-arms on the child's next video.
 *
 * DEVICE-LOCAL live state (the two timestamps), SYNCED settings (`afterMin`/`durationMin`):
 * a lock is about THIS device's session — syncing "locked until X" would lock a sibling's
 * device on the same account. Same split as PIN recovery (v1.0.26).
 *
 * The USER'S DECISIONS, encoded here:
 *  - the timer ACCUMULATES (armed by the first video, runs continuously) — it never resets
 *    on a new video, or continuous play would make the limit meaningless;
 *  - it counts wall-clock while the app is open, not only during playback.
 *
 * @param armedAt      ms when the session's countdown started (0 = not armed yet)
 * @param lockedUntil  ms the current lock ends (0 = not locked)
 * @param afterMin     lock after this many minutes (<=0 or nonsense ⇒ feature OFF)
 * @param durationMin  how long the lock lasts (nonsense ⇒ the default, never 0)
 * @returns { phase: 'off'|'idle'|'counting'|'due'|'locked', msLeft }
 *   'due' = the countdown elapsed; the caller must START the lock (set lockedUntil).
 *   'locked' with msLeft<=0 = expired; the caller must CLEAR it and re-arm on next video.
 */
export function evalScheduledLock({ now = Date.now(), armedAt = 0, lockedUntil = 0, afterMin = 0, durationMin = 20 } = {}) {
  const after = Number(afterMin);
  if (!Number.isFinite(after) || after <= 0) return { phase: 'off', msLeft: 0 };
  const until = Number(lockedUntil) || 0;
  if (until > 0) return { phase: 'locked', msLeft: Math.max(0, until - now) };
  const armed = Number(armedAt) || 0;
  if (armed <= 0) return { phase: 'idle', msLeft: 0 };
  const deadline = armed + after * 60000;
  if (now >= deadline) return { phase: 'due', msLeft: 0 };
  return { phase: 'counting', msLeft: deadline - now };
}

/**
 * v1.0.34 — PURE: the idle screen-off minutes from the profile's raw setting.
 *
 * NEVER-WRITTEN (null/undefined/'') ⇒ the DEFAULT — the user's decision: the feature is
 * ON out of the box, because the family it protects (a child asleep in front of a lit
 * panel all night) is exactly the family that never opens the settings screen.
 * An EXPLICIT 0 ⇒ OFF (today's behavior: the screen stays awake while a video plays).
 * NONSENSE (NaN/negative/Infinity) ⇒ the default, never a short window — the
 * `planRejectedPurge` rule. Beware `Number(null) === 0`: the never-written check must
 * run BEFORE coercion, or the default would silently read as "off".
 */
export function screenOffMinutes(raw, defMin = 10) {
  const def = Number.isFinite(+defMin) && +defMin > 0 ? Math.min(600, +defMin) : 10;
  if (raw === null || raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(600, Math.floor(n));
}

/* ---------------- favourites (v1.0.40) ---------------- */

/**
 * v1.0.40 — PURE: is this per-child state entry an ACTIVE favourite?
 *
 * An LWW-element set, exactly like the deny-list (`db.denyActive`) and for the same reason:
 * **un-favouriting has to travel too.** With a single `favAt` field, removing a star on the
 * tablet would be undone by the phone's stale copy on the next pull — the child would take
 * a video out of ⭐ and watch it walk back in. So a removal is an EVENT (`favOffAt`), never
 * a deletion, and the later event wins.
 *
 * A TIE resolves to NOT-favourite: of the two ways to be wrong, a star the child has to tap
 * again is a shrug, and a video that refuses to leave ⭐ is the app disobeying them. (The
 * deny-list resolves its own tie the same way — toward the state the user last asked for.)
 */
export function favActive(st) {
  if (!st) return false;
  const on = Number(st.favAt) || 0;
  const off = Number(st.favOffAt) || 0;
  return on > 0 && on > off;
}

/**
 * v1.0.40 — PURE: merge two copies of the favourite half of one state entry.
 * MAX per field, so it is commutative and idempotent (tested) — no server, two devices.
 */
export function mergeFavState(a, b) {
  const pick = (f) => Math.max(Number((a && a[f]) || 0), Number((b && b[f]) || 0));
  const out = {};
  const on = pick('favAt');
  const off = pick('favOffAt');
  if (on) out.favAt = on;
  if (off) out.favOffAt = off;
  return out;
}

/**
 * v1.0.40 — PURE: the child's ⭐ folder, in the order they will see it.
 *
 * `favAt` ASCENDING — a new favourite is APPENDED (the user's decision 2026-08-11). A
 * 5-year-old navigates by POSITION, not by title: putting the newest star first would move
 * every video they already know, every time they add one.
 *
 * @param states Map<key, stateEntry> | object — the profile's whole per-video state
 * @returns keys, oldest favourite first
 */
export function favouriteKeys(states) {
  const entries = states instanceof Map
    ? [...states.entries()]
    : Object.entries(states && typeof states === 'object' ? states : {});
  return entries
    .filter(([, st]) => favActive(st))
    .sort((x, y) => (Number(x[1].favAt) || 0) - (Number(y[1].favAt) || 0))
    .map(([key]) => key);
}

/* ---------------- swipe paging (v1.0.57) ---------------- */

/**
 * v1.0.57 — PURE: what a finished drag over a paged grid means.
 *
 * DIRECTION IS RTL, and it is not a style choice: the ◀ "next" arrow sits on the LEFT of
 * the pager (the DOM puts `prev` first, and `dir="rtl"` mirrors the row), so the next page
 * lives to the left and the finger drags the current page RIGHTWARDS to bring it in — a
 * Hebrew book, and Android's own RTL ViewPager. `dx > 0` is therefore 'next'.
 *
 * Three refusals, each closing a different collision:
 *   - travel below SWIPE_MIN_PX: the surface is covered in <button> tiles, so anything a
 *     child could mean as a TAP (TAP_SLOP_PX = 14) must never also turn a page;
 *   - vertical dominance: the page scrolls under the same finger, and a scroll that drifts
 *     sideways is still a scroll — the v1.0.52 lesson, from the other side;
 *   - slower than SWIPE_MAX_MS: a finger that was RESTING on the screen and wandered off a
 *     tile. Deliberately a loose ceiling and not a flick test — see config.js: measuring a
 *     real swipe is what corrected that, and a slow deliberate drag is a page turn.
 *
 * BOUNDS LIVE HERE, not in the caller: the first and last page must absorb the gesture
 * silently (the arrows are `disabled` there, and a page that "flips" to itself reads as a
 * broken screen). An UNKNOWN duration does not refuse the gesture — the isTapGesture rule:
 * an odd WebView that reports no clock must not cost the child every swipe, and the worst
 * case is a page turn they can undo with one flick back.
 */
/**
 * v1.0.62 — PURE: has the finger moved enough, and horizontally enough, to START DRAGGING
 * the grid? -> 'next' | 'prev' | null.
 *
 * This runs on every pointermove until it answers, and the answer is what makes the screen
 * move. Two refusals, and both are the same collisions `swipePageAction` handles at release
 * — but here they matter MORE, because a wrong answer is visible while it happens:
 *  - below SWIPE_ARM_PX the travel is inside tap territory, and a tap on a tile that nudges
 *    the whole screen reads as a bug;
 *  - a movement that is not clearly horizontal is a SCROLL (the page scrolls under the same
 *    finger), and arming on it would make the grid jitter sideways during every scroll.
 */
export function swipeDragArm({ dx, dy } = {}) {
  const x = Number(dx);
  const y = Number(dy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) < SWIPE_ARM_PX) return null;
  if (Math.abs(x) < Math.abs(y) * SWIPE_RATIO) return null;
  // RTL: dragging RIGHT brings the NEXT page in from the left — the pager puts `prev` first
  // in the DOM and dir="rtl" mirrors the row, so ◀ "next" sits on the LEFT. Same mapping as
  // swipePageAction, and it must stay the same or the drag would preview one page and the
  // release would turn to the other.
  return x > 0 ? 'next' : 'prev';
}

/**
 * v1.0.62 — PURE: how far the grid is translated right now, in pixels.
 *
 * `edge` means there is no page in that direction. The user's decision (2026-08-30) is a
 * RUBBER BAND there rather than a frozen screen: the page gives a little and springs back,
 * which tells a child "there is nothing this way" in the only language they have. The cap
 * is a fraction of the width so a phone and a tablet feel the same.
 *
 * The sign is clamped to the ARMED direction. Only ONE neighbour is rendered (rendering both
 * doubles a database read taken while the finger is already moving), so dragging back past
 * the start must come to REST at 0 rather than reveal a page that is not there.
 */
export function swipeDragOffset({ dx, dir = null, width = 0, edge = false } = {}) {
  const x = Number(dx);
  const w = Number(width);
  if (!Number.isFinite(x) || !Number.isFinite(w) || w <= 0) return 0;
  const sign = dir === 'next' ? 1 : dir === 'prev' ? -1 : 0;
  if (!sign) return 0;
  const travel = x * sign;                    // how far along the armed direction
  if (travel <= 0) return 0;                  // dragged back past the start
  if (edge) return sign * Math.min(travel * SWIPE_RUBBER, w * SWIPE_RUBBER_MAX);
  return sign * Math.min(travel, w);          // never further than one full page
}

/**
 * v1.0.62 — PURE: does releasing here turn the page? -> boolean.
 *
 * RELATIVE, not the absolute SWIPE_MIN_PX (the user's decision): with the neighbour visible,
 * "what you see is what happens" is the only rule that cannot surprise — past a third of the
 * width the next page is already more than half revealed. An `edge` drag never commits, no
 * matter how far it was pulled: there is no page to turn to, which is what the rubber band
 * was saying the whole time.
 */
export function swipeDragCommit({ dx, dir = null, width = 0, edge = false } = {}) {
  if (edge) return false;
  const x = Number(dx);
  const w = Number(width);
  if (!Number.isFinite(x) || !Number.isFinite(w) || w <= 0) return false;
  const sign = dir === 'next' ? 1 : dir === 'prev' ? -1 : 0;
  if (!sign) return false;
  return x * sign >= w * SWIPE_COMMIT_RATIO;
}

export function swipePageAction({ dx, dy, dt, page, total } = {}) {
  const x = Number(dx);
  const y = Number(dy);
  const p = Number(page);
  const n = Number(total);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(p) || !Number.isFinite(n)) return null;
  const ms = Number(dt);
  if (Number.isFinite(ms) && ms > SWIPE_MAX_MS) return null;
  if (Math.abs(x) < SWIPE_MIN_PX) return null;
  if (Math.abs(x) < Math.abs(y) * SWIPE_RATIO) return null;
  if (n <= 1) return null;
  const dir = x > 0 ? 'next' : 'prev';
  if (dir === 'next' && p >= n - 1) return null;
  if (dir === 'prev' && p <= 0) return null;
  return dir;
}

/* ---------------- 🕒 נצפה לאחרונה (v1.0.57) ---------------- */

/**
 * v1.0.57 — PURE: how many videos the "watched recently" folder holds. 0 = OFF.
 *
 * ⚠️ THE UNSET CHECK MUST PRECEDE THE COERCION, and this is the third feature to say so
 * (`plan.screenOffMinutes`, `plan.normalizeLockMinutes`): `Number(null) === 0`, so reading
 * the value first would turn "the parent never opened this screen" into an explicit
 * "off" and silently discard the default.
 *
 * A nonsense value falls back to the DEFAULT, never to 0 — the `planRejectedPurge` rule,
 * pointing the opposite way to `keepNewestPerChannel` because the directions are not
 * symmetric: there, a typo must not start proposing DELETIONS; here, the worst a wrong
 * value can do is show a shortcut folder nobody asked for, while reading a typo as OFF
 * would quietly remove a folder the child navigates by.
 */
export function recentLimitFor(raw, { def = RECENT_DEFAULT_LIMIT, max = RECENT_MAX_LIMIT } = {}) {
  if (raw === null || raw === undefined || raw === '') return def; // never written
  const n = Number(raw);
  if (n === 0) return 0;                       // an explicit 0 IS the answer: off
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/**
 * v1.0.57 — PURE: the folder's contents, newest watch FIRST (the user's explicit order).
 *
 * The OPPOSITE of ⭐'s ascending order, and deliberately: ⭐ is a shelf the child builds and
 * navigates by position, while this folder's whole promise is "what I was just watching is
 * at the front". The cost is stated where it matters: THE FOLDER REORDERS ITSELF AFTER
 * EVERY VIDEO, which is why the watch-grid chain runs on a snapshot (see app.openWatch) —
 * a live re-read would make "the next video" the one that just moved, forever.
 */
export function recentKeys(states, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return [];
  const entries = states instanceof Map
    ? [...states.entries()]
    : Object.entries(states && typeof states === 'object' ? states : {});
  return entries
    .filter(([key, st]) => key && st && Number(st.playedAt) > 0)
    .sort((x, y) => (Number(y[1].playedAt) || 0) - (Number(x[1].playedAt) || 0))
    .slice(0, Math.floor(n))
    .map(([key]) => key);
}

/* ---------------- rolling window (v1.0.39) ---------------- */

/**
 * v1.0.39 — PURE: how many newest videos to keep per channel. 0 = the feature is OFF.
 *
 * The OPPOSITE default to `screenOffMinutes` above, and deliberately so: that feature
 * turns a screen off, this one DELETES the child's videos. So never-written ⇒ OFF, and
 * every unusable value ⇒ OFF too. `planRejectedPurge`'s "nonsense falls back to the
 * default, never to something destructive" rule points at 0 here, because 0 is the
 * harmless direction — a typo must not start proposing deletions.
 *
 * A window BELOW `min` is refused (→ OFF) for the same reason: `keep: 1` on a 500-video
 * channel is almost certainly a mistyped 100, and it would propose emptying the folder.
 */
export function keepNewestPerChannel(raw, { min = 10, max = 5000 } = {}) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;      // an explicit 0 IS the answer: off
  const v = Math.floor(n);
  if (v < min) return 0;
  return Math.min(max, v);
}

/**
 * v1.0.39 — PURE: which of a channel's videos sit OUTSIDE the rolling window?
 *
 * It PROPOSES; it never deletes. The sync stores nothing and acts on nothing — the parent
 * reviews per channel and answers (the user's decision 2026-08-09). That is the whole
 * safety model of this feature, so the split is structural: this function cannot delete
 * because it returns keys, and the sync has no code that consumes them.
 *
 * Rules, each one a decision:
 *  - LIVE records only. Pending and rejected are PARKED (`~pending`/`~rejected`), invisible
 *    to the child, and owned by the approval queue and its 30-day purge — deleting them
 *    here would silently answer a question the parent has not been asked.
 *  - NEWEST first (`sortKey` desc, the same order `db.pageFolder` renders): the first
 *    `keep` records stay, everything after them is proposed.
 *  - A PROTECTED key is never proposed, at ANY depth. It does not consume a slot from the
 *    newest `keep` either, so a folder with 30 protected favourites and a window of 200
 *    settles at 230 rather than hiding 30 recent uploads. The child's favourite is the
 *    thing this feature must never eat — a 5-year-old rewatches one video 200 times.
 *  - `keep <= 0` ⇒ nothing proposed. OFF must be OFF everywhere, not only in the caller.
 *
 * @param records  live-or-not records of ONE library (the caller may pass everything)
 * @param keep     window size; 0/negative ⇒ no proposal at all
 * @param protectedKeys Set of keys the parent marked, plus anything the child has opened
 * @returns { byChannel: { [sourceId]: { over: [key…], total, keptCount } }, total }
 */
export function planChannelWindow({ records, keep, protectedKeys = new Set() }) {
  const n = Math.floor(Number(keep) || 0);
  const out = { byChannel: {}, total: 0 };
  if (!(n > 0)) return out;
  const guard = protectedKeys instanceof Set ? protectedKeys : new Set(protectedKeys || []);

  // group LIVE records by the folder that actually shows them
  const groups = new Map();
  for (const rec of records || []) {
    if (!rec || !rec.key || rec.state !== 'live') continue;
    const m = /^(?:ch|pl):(.+)$/.exec(String(rec.folderId || ''));
    if (!m) continue; // loose singles have no channel folder and no window
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push(rec);
  }

  for (const [sourceId, list] of groups) {
    // newest first. `sortKey` is the app's own display order (order.js) and is finite for
    // every stored record (a non-finite one is refused at import), so this is total.
    list.sort((a, b) => (Number(b.sortKey) || 0) - (Number(a.sortKey) || 0));
    const over = [];
    let kept = 0;
    for (const rec of list) {
      if (guard.has(rec.key)) { kept += 1; continue; } // protected: survives at any depth
      if (kept < n) { kept += 1; continue; }
      over.push(rec.key);
    }
    if (over.length) {
      out.byChannel[sourceId] = { over, total: list.length, keptCount: list.length - over.length };
      out.total += over.length;
    }
  }
  return out;
}

/**
 * v1.0.39 — PURE: split a proposal into the rows the review screen renders and the
 * remainder it must SAY OUT LOUD.
 *
 * A channel 4000 over the window cannot render 4000 thumbnails, and a parent must never be
 * asked to confirm a deletion whose size they were not told. The items are the NEWEST of
 * the proposal (the caller passes them in that order) — the ones most likely to be worth
 * keeping — and `hidden` is what the confirm text has to name.
 *
 * Takes whatever the caller renders (records, or bare keys): it only ever slices and counts,
 * so the contract is "an ordered proposal", not a particular element shape.
 */
/**
 * v1.0.39 — PURE: every key the rolling window must not touch.
 *
 * Two sources: what the PARENT marked (`keepForever` on the record — the durable answer to
 * "let me mark what not to delete") and the one honest signal that the CHILD used a video,
 * a saved playback position (`posSec`).
 *
 * ⚠️ `unwrappedAt` IS NOT A WATCH SIGNAL, and assuming it was made this whole feature a
 * no-op — measured in the browser: a 60-video channel 40 over its window proposed ZERO.
 * `planGifts`' baseline stamps `unwrappedAt` on **every live record that did not become a
 * gift**, precisely so it can never be gifted later, so after one sync almost the entire
 * library carries it. Opening a gift writes the same field, and nothing distinguishes the
 * two. The app has no play counter, so "the child watched this" is simply not knowable
 * beyond `posSec` — which only exists while the resume setting is on. Hence the parent's
 * ticks are the real protection, and this is the belt.
 *
 * Pure for a second reason, also found in the browser: per-child state is a **Map**
 * (`loadGiftStates`), and the first version read it with `Object.entries` — which yields
 * nothing, so the child half protected NOBODY. Both shapes are accepted and pinned.
 *
 * v1.0.40 — the CHILD'S OWN ⭐ joins the set, and it is the strongest signal in it: a star
 * is a deliberate statement, where `posSec` is a guess that a fully-watched video does not
 * even leave behind. `statesByProfile` carries EVERY profile that reads this library, not
 * only the active one: on a legacy shared scope, one child's window must never prune the
 * sibling's favourite (the same cross-profile rule `db.deleteVideoStates` follows).
 */
export function protectedWindowKeys({ records = [], states = null, statesByProfile = null, recent = null } = {}) {
  const out = new Set();
  for (const rec of records) if (rec && rec.key && rec.keepForever) out.add(rec.key);
  // v1.0.57 — WHATEVER IS IN 🕒 RIGHT NOW IS PROTECTED (the user's decision 2026-08-30).
  // A watch stamp is the honest play signal this feature has always lacked: `posSec` below
  // is cleared by a video watched to the END (resumeSaveDecision), so the most-rewatched
  // video — exactly the one the rationale is about — carries no position at all. The keys
  // arrive COMPUTED because the limit is per profile and a sibling on a legacy shared
  // library has their own; unioning "every video ever watched" instead would quietly gut
  // the window it is protecting from.
  for (const key of (Array.isArray(recent) ? recent : [])) if (key) out.add(key);
  const readEntries = (s) => (s instanceof Map
    ? [...s.entries()]
    : Object.entries(s && typeof s === 'object' ? s : {}));
  const sets = [];
  if (states) sets.push(states);
  for (const s of (Array.isArray(statesByProfile) ? statesByProfile : [])) if (s) sets.push(s);
  for (const src of sets) {
    for (const [key, st] of readEntries(src)) {
      if (!key || !st) continue;
      if (favActive(st)) { out.add(key); continue; } // the child said so, explicitly
      if (Number(st.posSec) > 0) out.add(key);
    }
  }
  return out;
}


export function pruneReviewList(over, cap = 200) {
  const all = Array.isArray(over) ? over.filter(Boolean) : [];
  const c = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : 200;
  return { rows: all.slice(0, c), hidden: Math.max(0, all.length - c), total: all.length };
}

/**
 * v1.0.39 — PURE: the rolling window's confirm. The words ARE the feature (the v1.0.27
 * rule), and three of them were missing or wrong:
 *
 *  - **`hidden` must be NAMED.** `pruneReviewList`'s own contract says a parent must never
 *    confirm a deletion whose size they were not told, and the review renders at most
 *    `PRUNE_REVIEW_CAP` rows. A parent could press "סמן הכול", read "סומנו להשארה: 200",
 *    and still be deleting 3800 — because ticking can only reach what is rendered.
 *  - **`emptied` must be SAID.** Wiping a channel removes its tile from the child's home,
 *    and because the prune writes tombstones the current RSS window does NOT come back —
 *    only a genuinely NEW upload repopulates it, which for a dormant channel is never.
 *  - **THE WAY BACK IS NOT A PROMISE.** The old text said "כדי להחזיר אותם צריך להוסיף את
 *    הערוץ מחדש" as a fact. It is conditional: re-adding means remove-then-add, the
 *    orphan sweep then takes the channel's remaining records (including ones marked keep
 *    forever), the backfill only re-arms when no other library still subscribes, and a
 *    keyless install gets RSS's ~15 newest instead of the back catalogue — so the pruned
 *    keys may never be re-offered and `offerDeniedRestore` will have nothing to restore.
 *    It is stated as "not always possible", because that is what it is.
 */
export function pruneConfirmText({ name = '', count = 0, hidden = 0, kept = 0, emptied = false } = {}) {
  const n = Math.max(0, Number(count) | 0);
  const h = Math.max(0, Number(hidden) | 0);
  const k = Math.max(0, Number(kept) | 0);
  const parts = [`מ"${name}".`];
  if (h) parts.push(`מתוכם ${h} אינם מוצגים ברשימה שראיתם.`);
  if (k) parts.push(`${k} סרטונים שסימנתם יישארו לתמיד ולא יוצעו שוב.`);
  parts.push('סרטונים שסומנו בעבר להשארה לא יימחקו.');
  if (emptied) parts.push('התיקייה של הערוץ תתרוקן ותיעלם ממסך הילד עד שיתפרסם סרטון חדש.');
  parts.push('המחיקה היא לצמיתות: הסרטונים לא יחזרו בסנכרון, והחזרה שלהם בהמשך אינה מובטחת.');
  return { title: `למחוק ${n} סרטונים?`, text: parts.join(' ') };
}

/**
 * v1.0.34 — PURE: the idle screen-off state machine (user decisions 2026-08-07).
 * After `afterMin` minutes with NO user input while a video PLAYS: show "עדיין צופים?"
 * for `promptSec` seconds; silence means the caller must save the position, THEN pause
 * IN PLACE (the v1.0.32 screen-off order — never stop()), and keep-awake follows the
 * pause down by itself (the player heartbeat holds it only while playing). The DEVICE's
 * own display timeout is what actually turns the screen off — an app cannot do that
 * without device-admin, which is the wrong tool for a kids player.
 *
 * `playing:false` is 'off' by design: wake is not held while paused or outside the
 * player, so the OS already handles those — there is nothing for the app to do.
 *
 * @param lastInputAt  ms of the last touch/remote key (0 = none observed yet)
 * @param promptAt     ms the prompt was shown (0 = not showing) — the caller stamps it
 * @returns 'off' | 'counting' | 'prompt' | 'sleep'
 */
export function evalIdleSleep({ now = Date.now(), lastInputAt = 0, promptAt = 0, afterMin = 0, playing = false, promptSec = 45 } = {}) {
  const after = Number(afterMin);
  if (!Number.isFinite(after) || after <= 0 || !playing) return 'off';
  const shown = Number(promptAt) || 0;
  if (shown > 0) return now - shown >= (Number(promptSec) || 45) * 1000 ? 'sleep' : 'prompt';
  const last = Number(lastInputAt) || 0;
  if (last <= 0) return 'counting';
  return now - last >= after * 60000 ? 'prompt' : 'counting';
}

/**
 * v1.0.31 — PURE: how long the current lock should last, from the profile's setting.
 * A nonsense value falls back to the default (never 0 — that would unlock on the spot),
 * the `planRejectedPurge` rule.
 */
export function scheduledLockDurationMs(durationMin, defMin = 20) {
  const n = Number(durationMin);
  return (Number.isFinite(n) && n > 0 ? n : (Number.isFinite(+defMin) && +defMin > 0 ? +defMin : 20)) * 60000;
}

/** v1.0.31 — PURE: a mm:ss countdown, never negative, never blank. */
export function lockCountdownLabel(msLeft) {
  const s = Math.max(0, Math.ceil((Number(msLeft) || 0) / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return m + ':' + ss;
}

/**
 * v1.0.55 — PURE: how contained is the scheduled-lock ("הפסקה") screen?
 *
 * The parent's new choice (`lockTablet`, per-profile, synced, OFF unless written): during
 * the break, may the child leave to OTHER APPS, or is the whole tablet locked? The
 * mechanism is the SAME OS screen pinning the kiosk (`exitLock`) uses — so the two
 * settings interact, and this helper is the one place that knows how:
 *
 *  - hideExit: the kiosk hides the exit door entirely (the v1.0.31 rule, unchanged) —
 *    under it "exit the app" is never on offer, break or no break.
 *  - gateExit: full-tablet lock keeps the door VISIBLE but behind the parent code — the
 *    parent's own way out while the break keeps running for the child (user decision
 *    2026-08-28: code → unpin → exit; the break is NOT cancelled by leaving).
 *  - pinTask: pin while the break screen shows. Owned by the break, not by the kiosk —
 *    applyExitLock keeps owning the kiosk's pin. (gateExit and pinTask are the same bit
 *    TODAY, named separately because different surfaces consume them; if they ever
 *    diverge, this function is the only place that changes.)
 *  - unpinOnClear: may a pin the break is HOLDING be released when the lock clears?
 *    The kiosk vetoes (v1.0.36: a kiosk session stays pinned; its release points are
 *    the code-gated exits). Whether the break IS holding one is RUNTIME state
 *    (app.js `breakPinHeld`), deliberately not this setting: lockTablet can flip
 *    mid-break — the settings sync — and the release must follow what was actually
 *    pinned, not what the toggle says at release time (review finding).
 *
 * Junk values read as false — the exitLockOn precedent (`=== true`): a corrupted setting
 * must fall back to today's behaviour, never lock a tablet the parent never locked.
 */
export function lockScreenContainment({ kiosk = false, lockTablet = false } = {}) {
  const k = kiosk === true;
  const t = lockTablet === true;
  return { hideExit: k, gateExit: t, pinTask: t, unpinOnClear: !k };
}

/**
 * v1.0.55 — PURE: map a KeyboardEvent.key to a PIN-keypad action.
 *
 * The code can be TYPED — a TV remote's digit buttons, a hardware keyboard — instead of
 * tapped, which is the second half of the discreet-keypad request: on TV, tapping means
 * D-pad-walking a visible focus ring across the digits, which shows the child the code
 * one highlight at a time. Typing shows nothing.
 *
 * Digit keys arrive as '0'..'9' for both the top row and the numpad (e.key, not e.code —
 * e.code would be 'Numpad7'/'Digit7' and miss one of them). Backspace/Delete map to the
 * keypad's own ⌫. EVERYTHING else is null: Enter must stay with the D-pad manager (it
 * activates whatever is focused), and Escape stays the hardware-back stand-in.
 */
export function pinKeyAction(key) {
  if (typeof key !== 'string') return null;
  if (/^[0-9]$/.test(key)) return key;
  if (key === 'Backspace' || key === 'Delete') return 'del';
  return null;
}

/**
 * v1.0.26 — PURE: where a "I forgot the parent code" request stands.
 * -> { state: 'none' | 'waiting' | 'ready', msLeft, hoursLeft }
 *
 * **WITHOUT THIS THERE IS NO WAY BACK IN.** Since v1.0.25 the PIN hash rides the synced
 * settings channel into the Drive document, so the old answer — reinstall the app — gives
 * a backed-up family the forgotten code straight back on the next pull. The families who
 * did the right thing and enabled backup were the ones with no door.
 *
 * A WAIT is the mechanism because it is the only one that always works: no device lock (a
 * child's tablet often has none, and Android TV never does), no permission, no network,
 * nothing to lose. It stops the person it needs to stop — a 5-year-old will not sit out a
 * day — while the countdown on the child's home is the parent's warning that someone asked.
 *
 * NOT a security boundary, and the docs say so: whoever can move the system clock forward
 * skips the wait. That is unavoidable without a server, and it is a different threat than
 * the one this app has ever defended against. The device-credential path is the strong one.
 *
 * A request timestamp in the FUTURE (the clock moved backwards, or a restored backup) only
 * ever makes the remaining wait LONGER, never shorter — the safe direction, so it needs no
 * special case at all: the subtraction simply yields more time, and the one branch below
 * covers every way the deadline can already have passed. (A `Math.max(0, …)` floor was
 * here first and no planted regression could make it fail — the `<= 0` branch had already
 * absorbed the only case it could have caught.)
 */
export function planPinRecovery({ requestedAt, now = Date.now(), hours = 24 } = {}) {
  // A nonsense window falls back to the DEFAULT, never to a short one — the same rule as
  // `planRejectedPurge`, and for a sharper reason: a typo that resolved to a one-second
  // wait would hand the parent screen to the child on the spot.
  const h = Number(hours);
  const delay = (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
  const at = Number(requestedAt);
  if (!Number.isFinite(at) || at <= 0) return { state: 'none', msLeft: 0, hoursLeft: 0 };
  const msLeft = at + delay - now;
  if (msLeft <= 0) return { state: 'ready', msLeft: 0, hoursLeft: 0 };
  return { state: 'waiting', msLeft, hoursLeft: Math.ceil(msLeft / 3600000) };
}

/**
 * v1.0.26 — PURE: which way back in does the parent get offered right now?
 * -> 'device' | 'wait-start' | 'wait-pending' | 'wait-ready'
 *
 * Two mechanisms, and the ORDER between them is the decision:
 *
 * **An existing request always wins over the fast path.** A wait that is already running
 * is state the parent deliberately created, possibly on a day when the fingerprint reader
 * was not cooperating; hiding it behind a prompt they may fail again would strand them,
 * and silently discarding it would be worse. So `waiting` and `ready` are reported as
 * themselves whatever the device can do.
 *
 * **The device credential is only ever an ADDITION.** When nothing has been requested yet
 * and the device can prove an adult is present, that is the one-second route. Everywhere
 * else — no lock screen (the common children's tablet), Android TV, a browser, an older
 * APK without the plugin method, a prompt that throws — this answers `wait-start` and the
 * 24-hour path carries the feature alone. The caller treats a FAILED prompt the same way,
 * which is why a broken sensor cannot lock a parent out.
 */
export function planRecoveryRoute({ deviceAuth = false, recovery = null } = {}) {
  const state = recovery && recovery.state;
  if (state === 'ready') return 'wait-ready';
  if (state === 'waiting') return 'wait-pending';
  return deviceAuth === true ? 'device' : 'wait-start';
}

/**
 * v1.0.26 — PURE: what the countdown says. Hebrew, and it must never read "0 שעות".
 */
export function pinRecoveryLabel(plan) {
  if (!plan || plan.state !== 'waiting') return '';
  const mins = Math.ceil(plan.msLeft / 60000);
  if (mins <= 60) return `אפשר יהיה לאפס את קוד ההורים בעוד ${mins} דקות`;
  return `אפשר יהיה לאפס את קוד ההורים בעוד ${plan.hoursLeft} שעות`;
}

/**
 * v1.0.26 — PURE: what the parent is told after sharing a link from YouTube.
 *
 * FIELD BUG. `handleShare` had SEVEN silent `return`s and no success message either, so
 * every possible outcome — added, parked for approval, duplicate, previously deleted,
 * cancelled, unrecognised, no library yet — looked identical from the outside: nothing.
 * A parent reported "sharing does not work" and there was no way, from the app, to learn
 * which of the seven it was.
 *
 * Every route now ends here. `kind` is the toast colour; the TEXT carries the meaning.
 */
const SHARE_OUTCOMES = {
  added: { kind: 'ok', text: 'נוסף ✅' },
  pending: { kind: 'warn', text: 'נוסף וממתין לאישור — מסך ההורים ← ממתינים 👀' },
  'channel-added': { kind: 'ok', text: 'הערוץ נוסף ✅' },
  'playlist-added': { kind: 'ok', text: 'רשימת ההשמעה נוספה ✅' },
  duplicate: { kind: 'warn', text: 'הסרטון כבר קיים בספרייה' },
  denied: { kind: 'warn', text: 'הסרטון הזה נמחק בעבר. אפשר להוסיף אותו שוב ממסך ההורים ← הוספה' },
  cancelled: { kind: 'warn', text: 'ההוספה בוטלה' },
  'no-profile': { kind: 'warn', text: 'נשמר — ייכנס אחרי שתבחרו פרופיל' },
  unsupported: { kind: 'err', text: 'הקישור לא נתמך (סרטון YouTube, ערוץ, רשימת השמעה, או קובץ mp4)' },
  'no-library': { kind: 'err', text: 'ההוספה נכשלה — אין עדיין רשימה לפרופיל הזה' },
  'resolve-failed': { kind: 'err', text: 'לא הצלחנו לזהות את הערוץ' },
  failed: { kind: 'err', text: 'ההוספה נכשלה. אפשר לנסות ממסך ההורים ← הוספה' }
};

export function shareOutcome(reason) {
  return SHARE_OUTCOMES[reason] || SHARE_OUTCOMES.failed;
}

/** Every reason `share.handleShare` can answer with — the test pins the two lists match. */
export const SHARE_REASONS = Object.keys(SHARE_OUTCOMES);

/**
 * @param candidates  enriched candidate records for ONE scope:
 *   { scopeId,key,type,id,url,srcUrl,driveId, title,titleSource,thumbUrl,
 *     channelId,folderId,origin,publishedAt,rowIndex, autoApprove }
 * @param existing    Map<key, lightProjection> (db.loadMergeIndex)
 * @param denySet     Set<key> — tombstones; denied candidates are dropped, period.
 * @param caps        { maxPerChannel, maxTotal }
 * @param quarantine  first sync after migration: unknown keys arrive as 'pending'
 *                    regardless of autoApprove (legacy deletions are unrecoverable —
 *                    one bulk parent decision instead of silent resurrection).
 * @returns { puts, newLiveKeys, pendingKeys, mergeReport, counts }
 */
export function planMutations({ candidates, existing, denySet, now = Date.now(), caps = {}, quarantine = false }) {
  const maxPerChannel = caps.maxPerChannel || 500;
  const maxTotal = caps.maxTotal || 5000;

  const puts = new Map();          // key -> record
  const newLiveKeys = [];
  const pendingKeys = [];
  const mergeReport = [];
  const perChannel = new Map();
  let dropsDenied = 0;
  let dropsCapped = 0;

  // Title-dedupe index over EXISTING records: channelId -> normTitle -> key.
  // Scoped per channel only — cross-channel same-name videos are legitimate.
  const titleIndex = new Map();
  for (const [key, rec] of existing) {
    if (!rec.channelId || !rec.normTitle) continue;
    if (!titleIndex.has(rec.channelId)) titleIndex.set(rec.channelId, new Map());
    const m = titleIndex.get(rec.channelId);
    if (!m.has(rec.normTitle)) m.set(rec.normTitle, key);
  }
  // Reappearing merged-away links resolve to their survivor instead of resurrecting.
  const mergedFromIndex = new Map();
  for (const [key, rec] of existing) {
    for (const lost of rec.mergedFrom || []) mergedFromIndex.set(lost, key);
  }

  let total = existing.size;

  /* v1.0.37 — WHY A DROP IS ATTRIBUTED TO A SOURCE, not just counted.
   * `counts.capped`/`counts.denied` existed and were thrown away by every caller, so a
   * channel that resolved perfectly and delivered 98 candidates could have all 98 dropped
   * and the parent was told "אין בו סרטונים" — a statement about the CHANNEL when the
   * truth was about the LIBRARY. Attribution is by BOTH the candidate's channelId and its
   * folder's source id, because a PLAYLIST video keeps its OWNER in channelId (v1.0.26)
   * and matching on channelId alone finds ZERO for a playlist — the exact shape of the
   * pendingKeysOfChannel bug. deniedKeys ride along so the parent can be OFFERED the
   * restore: for a channel video there is otherwise no way back at all (no sheet row to
   * re-add, v1.0.26), which is what made this dead end permanent.
   */
  const byChannel = new Map();
  const sourceIdsOf = (c) => {
    const ids = [];
    if (c.channelId) ids.push(c.channelId);
    const m = /^(?:ch|pl):(.+)$/.exec(String(c.folderId || ''));
    if (m && m[1] && m[1] !== c.channelId) ids.push(m[1]);
    return ids;
  };
  // ATTRIBUTION COUNTS UNIQUE KEYS, not drop events. One run offers the same video
  // several times (the RSS window, the UULF backfill and the playlists pass all cover
  // it), so counting events told the parent "250 מהסרטונים שלו הוסרו" about a channel
  // with 98 videos — measured. A number that overstates by 2.5× is the same class of
  // small lie the message exists to remove.
  const noteDrop = (c, kind, key) => {
    for (const id of sourceIdsOf(c)) {
      if (!byChannel.has(id)) byChannel.set(id, { capped: new Set(), denied: new Set() });
      byChannel.get(id)[kind].add(key || c.key);
    }
  };

  for (const c of candidates) {
    if (!c || !c.key) continue;
    const key = mergedFromIndex.get(c.key) || c.key;
    if (denySet.has(key) || denySet.has(c.key)) {
      dropsDenied += 1;
      noteDrop(c, 'denied', key);
      continue;
    }

    const normTitle = normalizeTitle(c.title);
    const base = {
      scopeId: c.scopeId,
      key,
      type: c.type, id: c.id ?? null, url: c.url ?? null, srcUrl: c.srcUrl || '',
      driveId: c.driveId ?? null,
      title: c.title || '', normTitle, titleSource: c.title ? (c.titleSource || 'sheet') : null,
      folderId: c.folderId, channelId: c.channelId ?? null,
      sortKey: sortKeyFor(c),
      publishedAt: c.publishedAt ?? null, rowIndex: c.rowIndex ?? null,
      origin: c.origin,
      state: 'live',
      addedAt: now, approvedAt: null,
      thumbId: null, thumbUrl: c.thumbUrl || null, localPath: null,
      updatedAt: now
    };

    // APPROVAL IS DECIDED BEFORE ANY MERGE (v1.0.22). This routing used to live only in
    // the brand-new branch at the bottom, so `base` reached the two merge branches still
    // carrying its 'live' default — and `mergeVideoRecord` promotes a pending survivor
    // when the LOSER is live (right when the loser really was approved, catastrophic when
    // it only looked that way). A channel added in the parent screen is autoApprove:false,
    // so a same-titled twin arriving in the SAME run silently AUTO-APPROVED a video the
    // parent had never seen: live in the child's folder with approvedAt still null. Found
    // on a real channel whose 109-video backfill produced exactly 2 such twins.
    // Pending records are PARKED in '~pending' so the kid-facing folder index
    // (by_folder_sort has no state component) can never surface them; approval restores
    // homeFolderId.
    const needsApproval = quarantine || !c.autoApprove;
    if (needsApproval) {
      base.state = 'pending';
      base.homeFolderId = base.folderId;
      base.folderId = '~pending';
    }

    const prior = puts.get(key) || existing.get(key) || null;

    // Intra-channel title dedupe (only for channel/sheet content with a real title).
    let titleTwin = null;
    if (!prior && c.channelId && normTitle) {
      const twinKey = titleIndex.get(c.channelId)?.get(normTitle);
      if (twinKey && twinKey !== key) titleTwin = puts.get(twinKey) || existing.get(twinKey) || null;
    }

    if (titleTwin) {
      const merged = settleCuration(
        mergeVideoRecord({ ...titleTwin, scopeId: c.scopeId }, base), base.homeFolderId || base.folderId, now
      );
      mergeReport.push({
        survivorKey: merged.key, survivorTitle: merged.title,
        mergedKeys: [key], channelId: c.channelId, normTitle
      });
      if (!existing.has(merged.key) || changed(existing.get(merged.key), merged)) puts.set(merged.key, merged);
      continue;
    }

    if (prior) {
      const merged = mergeVideoRecord({ ...prior, scopeId: c.scopeId, key }, base);
      // An existing record keeps its curation: pending stays pending (parked) and — v1.0.23
      // — rejected stays rejected. The candidate arriving here is the same channel video the
      // RSS pass re-offers every 30 minutes, so a sync that undid rejections would hand the
      // child back everything the parent threw out.
      // HONESTY NOTE: the 'rejected' half is a SECOND layer, not the mechanism.
      // `normalize.resolveCuration` already keeps it, because `base` reaches this branch
      // with `approvedAt: null` (only the brand-new branch stamps it) and any rejectedAt
      // beats 0. Removing this line alone therefore breaks no test. It stays as a local
      // statement of intent and as cover if `base` ever starts carrying a real approval —
      // do not read it as the thing that makes rejection stick.
      if (prior.state === 'pending' || prior.state === 'rejected') merged.state = prior.state;
      settleCuration(merged, prior.homeFolderId || base.homeFolderId || base.folderId, now);
      if (!existing.has(key) || changed(existing.get(key), merged)) puts.set(key, merged);
      continue;
    }

    // Brand-new record: caps, then the approval bookkeeping for the routing above.
    const chCount = (perChannel.get(c.channelId) || 0);
    if (c.channelId && chCount >= maxPerChannel) { dropsCapped += 1; noteDrop(c, 'capped'); continue; }
    if (total >= maxTotal) { dropsCapped += 1; noteDrop(c, 'capped'); continue; }

    if (needsApproval) pendingKeys.push(key);
    else { base.approvedAt = now; newLiveKeys.push(key); }
    puts.set(key, base);
    total += 1;
    if (c.channelId) perChannel.set(c.channelId, chCount + 1);
    if (c.channelId && normTitle) {
      if (!titleIndex.has(c.channelId)) titleIndex.set(c.channelId, new Map());
      titleIndex.get(c.channelId).set(normTitle, key);
    }
  }

  return {
    puts: [...puts.values()],
    newLiveKeys, pendingKeys, mergeReport,
    counts: { candidates: candidates.length, puts: puts.size, denied: dropsDenied, capped: dropsCapped },
    // v1.0.37: the same numbers, attributed — this is what lets a zero name its cause.
    drops: {
      capped: dropsCapped,
      denied: dropsDenied,
      byChannel: Object.fromEntries([...byChannel.entries()].map(([id, e]) => [id, {
        capped: e.capped.size, denied: e.denied.size, deniedKeys: [...e.denied]
      }]))
    }
  };
}

/**
 * v1.0.37 — PURE: what a source's zero MEANS, from the sync's own drop attribution.
 * -> { capped, denied, deniedKeys }
 *
 * Kept separate from the message so both the wording and the restore offer read the same
 * fact, and so a caller with no drop information (an older sync result, a share path)
 * degrades to "no drops" rather than to a wrong claim.
 */
export function sourceDrops(drops, sourceId) {
  const e = drops && drops.byChannel && sourceId ? drops.byChannel[sourceId] : null;
  return {
    capped: Math.max(0, (e && e.capped) | 0),
    denied: Math.max(0, (e && e.denied) | 0),
    deniedKeys: (e && Array.isArray(e.deniedKeys)) ? e.deniedKeys : []
  };
}

/**
 * Per-PROFILE gift planning (F9). Gift state lives in profileVideoState, not on the
 * shared video record — one child's unwrapping never affects a sibling.
 *
 * firstSync=true (baseline): only the newest `baseline` live records become gifts
 * (rank 1..N); every OTHER live record gets unwrappedAt so it can never gift later.
 * firstSync=false: every newly-live key without prior state becomes a gift.
 * An item with unwrappedAt anywhere NEVER receives a rank (tested invariant).
 * Ranks are gated on having some thumbnail (a gift must reveal a picture).
 */
export function planGifts({ profileId, liveRecords, newLiveKeys, existingStates, firstSync, baseline = 12, now = Date.now() }) {
  const statePuts = [];
  const stateOf = (key) => existingStates.get(key) || null;
  // A gift must reveal a picture. YouTube always has one (hqdefault is guaranteed) —
  // the key-prefix fallback keeps this true even over partial projections.
  const giftable = (r) => !!(r.thumbId || r.thumbUrl || r.type === 'youtube' || String(r.key).startsWith('yt:'));

  if (firstSync) {
    const sorted = liveRecords.slice().sort(compareForDisplay);
    let rank = 1;
    for (const r of sorted) {
      const st = stateOf(r.key);
      if (st && (st.unwrappedAt || st.giftRank)) continue; // never re-gift / re-rank
      if (rank <= baseline && giftable(r)) {
        statePuts.push({ profileId, key: r.key, giftRank: rank });
        rank += 1;
      } else {
        statePuts.push({ profileId, key: r.key, unwrappedAt: now });
      }
    }
    return statePuts;
  }

  let maxRank = 0;
  let outstanding = 0; // ranks the child has not opened yet
  for (const st of existingStates.values()) {
    if (!st.giftRank) continue;
    maxRank = Math.max(maxRank, st.giftRank);
    if (!st.unwrappedAt) outstanding += 1;
  }
  const byKey = new Map(liveRecords.map((r) => [r.key, r]));
  // v1.0.21 — CAP THE OUTSTANDING GIFTS AT `baseline`, exactly like the first sync does.
  //
  // 🎁 is a treat the child opens one at a time; a folder holding hundreds is not a
  // bigger treat, it is a wall (the v1.0.20 field bug). The old incremental branch had NO
  // ceiling, so any bulk arrival — approve-all, a channel backfill going live, or a
  // baseline that was spent while the library was nearly empty — gifted EVERYTHING. This
  // makes such a runaway unrepresentable rather than repairable, and the NEWEST arrivals
  // are the ones that get the ranks.
  const fresh = newLiveKeys
    .filter((key) => {
      const st = stateOf(key);
      if (st && (st.unwrappedAt || st.giftRank)) return false; // never re-gift / re-rank
      const rec = byKey.get(key);
      return !!rec && giftable(rec);
    })
    .sort((a, b) => compareForDisplay(byKey.get(a), byKey.get(b))); // newest first
  for (const key of fresh) {
    if (outstanding >= baseline) break;
    maxRank += 1;
    outstanding += 1;
    statePuts.push({ profileId, key, giftRank: maxRank });
  }
  return statePuts;
}


/* planSheetMirror (v1.0.10) lived here until v1.0.38 — the presence mirror that made the
 * sheet the truth in BOTH directions, plus its mass-deletion safety valve. Both are gone
 * with the sheet. Its one genuinely good idea, the valve, survives as orphanSweepValve
 * above; its unDenyKeys — the ONLY path that ever revoked a deletion tombstone — is
 * replaced by an explicit parental answer (deniedReAddPrompt), which is the whole reason
 * that dialog exists. */


/**
 * PURE: does this record live in the shared ⭐ "סרטונים נוספים" bucket — a single the parent
 * added by hand, by share or from a links file — rather than content a channel brought in?
 *
 * v1.0.38 renamed it from `isSheetBacked` (and dropped its list-form twin, which only the
 * presence-mirror used). It never described a spreadsheet: it is the home screen's
 * loose-list boundary, and the old name kept telling readers otherwise. NOTE `'sheet'` is
 * still the FOLDER ID — renaming that would be a folderId migration of every record in
 * every library for zero benefit, and it would break pageAnyFolder / nextAfter /
 * db.approvePending / snapshot / share all at once.
 *
 *  - `state === 'live'`: a PENDING share is parked with `homeFolderId:'sheet'` and is not
 *    part of the child's list yet.
 *  - the folder test reads `homeFolderId` FIRST, because a parked record's `folderId` is
 *    '~pending'/'~rejected' and its real home is the field behind it.
 */
export function isLooseRecord(r) {
  if (!r || r.state !== 'live') return false;
  return (r.homeFolderId || r.folderId) === 'sheet';
}

/* planScopeAdoption (v1.0.20) died in v1.0.38 with moveScope and the sheet wizard: no
 * code path can change a profile's libraryId any more, so there is no scope move left to
 * gate. Its sibling question — "may a profile PURGE erase this scope?" — lives on below
 * in planProfilePurge, which is not sheet-coupled. */

/**
 * v1.0.25 — PURE: deleting a profile. Which scopes may actually be erased?
 *
 * `deleteCurrentProfile` promises "כל הסרטונים של הפרופיל יימחקו. פעולה זו אינה הפיכה"
 * and, until now, deleted nothing but the row in the profile list: `db.purgeProfile`
 * existed with ZERO callers. Measured on 2026-08-02 — a throwaway profile with one channel
 * kept all 500 videos, its subscription and its sources record after the delete.
 *
 * The personal scope `prof:<id>` is always the profile's alone. The LIBRARY scope is the
 * careful half: `lib:<fnv1a(sheet)>` is SHARED by every profile reading that sheet, and
 * erasing it would take a sibling's whole library with it. A sheet-less profile gets
 * `lib:p:<id>`, which is exclusive by construction — that is where the content actually
 * lives for most families. Same question `planScopeAdoption` asks before a move.
 *
 * @param profileId the profile being deleted
 * @param libraryId its library scope, if it has one
 * @param others    [{ profileId, libraryId }] for every OTHER profile
 * @returns { scopes: string[], sharedWith: string[] } — scopes is what may be erased
 */
export function planProfilePurge(profileId, libraryId, others = []) {
  if (!profileId) return { scopes: [], sharedWith: [] };
  const scopes = ['prof:' + profileId];
  if (!libraryId) return { scopes, sharedWith: [] };
  const sharedWith = [];
  for (const o of others || []) {
    if (!o || !o.profileId || o.profileId === profileId) continue;
    if (o.libraryId && o.libraryId === libraryId) sharedWith.push(o.profileId);
  }
  if (!sharedWith.length) scopes.push(libraryId);
  return { scopes, sharedWith };
}

/**
 * v1.0.20 — PURE: may this sync spend the "gifts baselined" flag?
 *
 * The baseline records what already existed before a child started, so the newest 12
 * become gifts and the rest never do. Spending the flag on an EMPTY library is a bug
 * with two visible halves: adding a channel runs a sync where every candidate is still
 * pending (in-app adds require approval), so nothing is live yet — and then approving
 * produced no gifts at all, while the sync after that took the incremental path and
 * gifted the ENTIRE backfill at once.
 */
export function shouldRecordGiftBaseline(firstSync, liveCount) {
  return !!firstSync && Number(liveCount || 0) > 0;
}

/**
 * v1.0.20 — PURE: repair a 🎁 folder that the burned-baseline bug inflated.
 *
 * On devices that added a channel before the fix, the baseline flag was spent on an
 * empty library and the next sync gifted the ENTIRE backfill: a "חדשים" folder holding
 * the whole library, which the child would have to tap through one by one. This decides
 * the repair — keep the `baseline` NEWEST, retire the rest — which is exactly the state
 * the first sync should have produced.
 *
 * ⚠️ RANK IS NOT RECENCY on the piles this repairs. `planGifts` sorts by
 * `compareForDisplay` only on its BASELINE branch; the INCREMENTAL branch (the one that
 * actually creates a runaway) stamps `maxRank+1` while walking `newLiveKeys`, which comes
 * from `loadMergeIndex` — a cursor over the `[scopeId, key]` primary key, i.e. ALPHABETICAL
 * by video id. Ranking by giftRank therefore kept an arbitrary alphabetical dozen and
 * retired the genuinely newest videos, permanently (`unwrappedAt` is min-merged forever).
 * So the caller passes `sortKeyOf`; giftRank is only the tie-break / last-resort fallback.
 *
 * Deliberately conservative: a child who simply never opens gifts accumulates ranks
 * legitimately, so only an implausible pile is touched.
 *
 * @param states iterable of profileVideoState records for ONE profile
 * @param sortKeyOf Map|function key -> sortKey (the video's own recency). Omit only when
 *                  the records are unavailable; ordering then degrades to giftRank.
 * @returns { keep: string[], retire: string[] } — retire = give up its rank
 */
export function planGiftRunawayRepair(states, { baseline = 12, floor = 60, sortKeyOf = null } = {}) {
  const ranked = [];
  for (const st of states || []) if (st && st.giftRank && !st.unwrappedAt) ranked.push(st);
  if (ranked.length <= Math.max(floor, baseline)) return { keep: [], retire: [] };
  const recency = sortKeyOf == null ? null
    : typeof sortKeyOf === 'function' ? sortKeyOf
      : (k) => (sortKeyOf.get ? sortKeyOf.get(k) : sortKeyOf[k]);
  ranked.sort((a, b) => {
    if (recency) {
      const ra = Number(recency(a.key));
      const rb = Number(recency(b.key));
      const fa = Number.isFinite(ra);
      const fb = Number.isFinite(rb);
      // a record we can date always outranks one we cannot — never retire a video
      // just because its sortKey went missing
      if (fa !== fb) return fa ? -1 : 1;
      if (fa && rb !== ra) return rb - ra; // newest first
    }
    return a.giftRank - b.giftRank;
  });
  return {
    keep: ranked.slice(0, baseline).map((s) => s.key),
    retire: ranked.slice(baseline).map((s) => s.key)
  };
}

/** Folder ids that are just "everything loose" — no identity of their own. */
/** Channel-avatar retry windows. The API call is batched and ~free; the scrape is a
 *  full 1.5MB page fetch, one channel at a time — hence the two very different budgets. */
export const LOGO_API_RETRY_MS = 24 * 60 * 60 * 1000;
export const LOGO_SCRAPE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * v1.0.24 — PURE: should this sync try to (re)fetch the channel's avatar, and how?
 *
 * A channel folder with no avatar renders the 📺 emoji, which is exactly what a folder of
 * VIDEOS should not look like — the logo is how a non-reading child tells one channel from
 * another. Two separate defects made that permanent:
 *
 *  1. `logoTriedAt` used to be stamped by the channels.list writer even when NOTHING was
 *     tried — keyless mode returns empty logos without making a request, and so does the
 *     error branch. The keyless page-scrape immediately below is gated on that same field,
 *     so the fallback was suppressed for a WEEK on a channel's very first sync, which is
 *     precisely when the parent is looking at the new tile. The scrape now owns
 *     `logoTriedAt` (it is the last resort) and the API path owns `logoApiTriedAt`.
 *  2. A stored URL the browser cannot LOAD is worse than no URL: the tile silently falls
 *     back to the emoji (`img.onerror`) and nothing ever re-asked, because both fetch
 *     paths skipped any channel that already had a `logoUrl`. Avatars do go stale — a
 *     channel that rebrands 404s its old URL forever. The renderer now records
 *     `logoFailedAt`, and a failure NEWER than the fetch marks the URL known-bad.
 *
 * Absent a recorded failure a stored logo is trusted, so existing libraries are never
 * re-scraped wholesale. The `logoApiTriedAt` field being NEW is deliberate: every channel
 * already on a device passes the API gate exactly once after the update, which is what
 * heals the channels the first defect stranded — no migration needed.
 *
 * `failedAt` is passed IN rather than read off the record, and it lives in `meta` on the
 * caller's side. Two reasons, one of them measured: (a) whether an image renders is a
 * property of THIS device's WebView, like every other per-device channel field the Drive
 * layer strips — it must never travel; and (b) the sync's stages read a channel record,
 * spend seconds on the network, then write the whole snapshot back, so a marker stored on
 * the record is silently reverted by whichever stage happens to be in flight. That is not
 * hypothetical: it is exactly what swallowed the first version of this fix.
 *
 * @param ch       the channel record ({} for one that does not exist yet)
 * @param hasKey   is a YouTube API key configured (no key ⇒ the API path cannot run)
 * @param failedAt when the renderer last failed to LOAD the stored logoUrl (0 = never)
 * @returns { api, scrape } — whether each path should run now
 */
export function planChannelLogo(ch, { hasKey = false, failedAt = 0, now = Date.now() } = {}) {
  const c = ch || {};
  const failed = !!failedAt && failedAt >= (c.logoFetchedAt || 0);
  const stale = !c.logoUrl || failed;
  if (!stale) return { api: false, scrape: false };
  const fresh = (at, win) => !!at && now - at < win;
  return {
    api: !!hasKey && !fresh(c.logoApiTriedAt, LOGO_API_RETRY_MS),
    scrape: !fresh(c.logoTriedAt, LOGO_SCRAPE_RETRY_MS)
  };
}

/**
 * v1.0.21 — PURE: may this RSS entry enter the library?
 * Shorts and live streams never do. Kept as a named predicate so an INVERSION
 * (`if (!v.isShort) continue`, which would import only Shorts) fails a test instead of
 * satisfying a grep for the word.
 */
export function acceptRssEntry(v) {
  return !!v && !v.isShort && !v.isLive;
}

/**
 * v1.0.21 — PURE: may this item of a channel's own PLAYLIST enter the library?
 * This is a child-safety boundary, so each rejection is deliberate:
 *  - a videoId that is not a real id — junk in the response;
 *  - a FOREIGN uploader: the parent subscribed to THIS channel, not to whatever it
 *    curated from others;
 *  - a MISSING uploader: private and deleted playlist entries are exactly what come back
 *    with no `videoOwnerChannelId`, and they render as an untappable "Private video"
 *    tile. (Unlike the RSS case, "unknown" here means unplayable, not third-party — so
 *    this one fails CLOSED.)
 *  - a known Short of this channel (`playlistItems` carries no Shorts flag, so UUSH
 *    membership is the only exact test).
 */
export function acceptPlaylistItem(v, { channelId, shortIds } = {}) {
  if (!v || !/^[A-Za-z0-9_-]{11}$/.test(String(v.videoId || ''))) return false;
  if (!v.ownerChannelId) return false;
  if (channelId && v.ownerChannelId !== channelId) return false;
  if (shortIds && shortIds.has && shortIds.has(v.videoId)) return false;
  return true;
}

/**
 * v1.0.21 — PURE: advance the resumable walk of a channel's playlists.
 *
 * The wedge this exists to prevent: `playlistsDone` used to be derived from "the queue is
 * empty", which is ALSO true when the enumeration never ran (throttled / errored). One
 * quota blip on the first pass then disabled the playlists source for that channel for
 * the lifetime of the install, because nothing rearms the flag.
 *
 * @param state { playlistQueue, playlistCursor }
 * @param ev    { listComplete } after enumerating, or { pageError, nextPageToken } after a page
 * @returns { playlistQueue, playlistCursor, playlistsDone }
 */
export function planPlaylistAdvance(state = {}, ev = {}) {
  const queue = Array.isArray(state.playlistQueue) ? state.playlistQueue : [];
  // enumeration result: done ONLY when the list was fully read and held nothing
  if ('listComplete' in ev) {
    return {
      playlistQueue: queue,
      playlistCursor: null,
      playlistsDone: !!ev.listComplete && queue.length === 0
    };
  }
  // a page of the head playlist
  if (ev.pageError) {
    // a private/deleted playlist must not wedge the queue — drop it and move on
    const rest = queue.slice(1);
    return { playlistQueue: rest, playlistCursor: null, playlistsDone: rest.length === 0 };
  }
  if (ev.nextPageToken) {
    return { playlistQueue: queue, playlistCursor: ev.nextPageToken, playlistsDone: false };
  }
  const rest = queue.slice(1);
  return { playlistQueue: rest, playlistCursor: null, playlistsDone: rest.length === 0 };
}

/**
 * v1.0.21 — PURE: what did a 404 on the long-form playlist mean?
 * Only a 404 on the FIRST page of a DERIVED id says "this channel has no long-form
 * video". A 404 deeper in, or any other error (403/quota/network), must never be read as
 * "Shorts-only" — that would close the channel's backfill over a transient failure.
 */
export function planNoLongForm({ notFound = false, isFirstPage = false, derived = false } = {}) {
  const shortsOnly = !!(notFound && isFirstPage && derived);
  return { noLongForm: shortsOnly, closeBackfill: shortsOnly };
}

/**
 * v1.0.21 — PURE: the safety valve for an UNDOCUMENTED dependency.
 *
 * `UULF…` is not a documented API. If YouTube retires it, page 1 answers 404 for EVERY
 * channel at once and the naive reading ("they are all Shorts-only") would close every
 * backfill in every family's library in a single sync, with a false explanation shown to
 * each parent. A whole-population failure is an OUTAGE, not a fact about the channels.
 * Same spirit as the sheet-mirror valve: refuse to act, keep the old state, say so.
 *
 * @param results [{ channelId, notFound }] — one entry per channel that tried this run
 */
export function planLongFormOutage(results = []) {
  const tried = (results || []).filter((r) => r && r.channelId);
  if (tried.length < 2) return { outage: false, notFoundCount: tried.filter((r) => r.notFound).length };
  const notFoundCount = tried.filter((r) => r.notFound).length;
  return { outage: notFoundCount === tried.length, notFoundCount };
}

/**
 * v1.0.22 — PURE: which (scope, folder) should the UNDER-PLAYER grid page?
 *
 * The grid is how the child reaches the next video, so an empty one is a dead end. Two
 * rules fight here and the order matters:
 *  - came from a FOLDER view ⇒ browse that folder, because a virtual 🎞️ group folder is
 *    not stored on the record and `item.folderId` cannot express it (v1.0.12);
 *  - …EXCEPT 🎁 'new', which is a VIEW over other folders, not a folder. Opening a gift
 *    unwraps it, so it leaves the sparse by_gift index immediately — and paging 'new'
 *    then returned FEWER items than the child could see, or nothing at all when it was
 *    the last gift. A gift browses where the video actually lives, which is also what
 *    player.js's own comment always claimed.
 *  - '~pending' is a parking slot and must never be browsed.
 */
export function resolveWatchContext({
  item, isWatching = false, prevFolderId = null, folderViewId = null,
  libScope = null, profileScope = null
} = {}) {
  const rec = item || {};
  const real = (f) => (f && f !== '~pending' ? f : null);
  const fromView = folderViewId === 'new' ? null : real(folderViewId);
  const folderId = isWatching
    ? real(prevFolderId) || real(rec.homeFolderId) || real(rec.folderId)
    : fromView || real(rec.homeFolderId) || real(rec.folderId) || real(prevFolderId);
  return {
    scope: rec.scopeId || (folderId === 'mine' ? profileScope : libScope) || libScope || profileScope || null,
    folderId: folderId || null
  };
}

const FLAT_FOLDER_IDS = new Set(['sheet', 'mine']);


/**
 * v1.0.24 — PURE: what does the dot on the 🔒 gate button MEAN right now?
 *
 * One dot has always stood for two unrelated errands: content waiting for a decision, and
 * an app update ready to install. The parent could not tell them apart, so the routine
 * one — a manual-approval channel published something and the child cannot see it until
 * someone says yes — looked exactly like the rare one and got learned as "ignorable".
 *
 * Colour is now the destination: 'info' (blue) is content, and tapping lands on ממתינים;
 * 'alert' (red) is the update, and tapping lands on אודות where the install button lives.
 * Content WINS a tie: it is the errand with a child waiting at the other end, and the
 * update keeps its own red dot on the אודות tab regardless.
 */
export function attentionDot({ pending = 0, updateReady = false } = {}) {
  if (pending > 0) return 'info';
  if (updateReady) return 'alert';
  return null;
}

/** The parent screen's tabs, in order. app.js renders from this list. */
export const PARENT_TAB_IDS = ['about', 'approve', 'add', 'sources', 'sites', 'settings'];

/**
 * v1.0.24 — PURE: which parent-screen tab opens?
 *
 * `parentTab` is sticky across visits (v1.0.14 lands on אודות the first time). Anything
 * waiting for approval overrides that stickiness EVERY visit, not once: the queue is the
 * only tab whose content is blocking a child, and a parent who crossed the PIN while the
 * blue dot was lit came for it. Once the queue is empty the sticky tab is restored, so
 * the override can never strand a parent who lives in הגדרות.
 *
 * @param sticky  the tab the parent last used
 * @param pending how many records are waiting for a decision
 * @param tabs    the valid tab list (a sticky value not in it falls back to the first)
 */
export function parentLandingTab(sticky, pending = 0, tabs = PARENT_TAB_IDS) {
  const list = Array.isArray(tabs) && tabs.length ? tabs : PARENT_TAB_IDS;
  if (pending > 0 && list.includes('approve')) return 'approve';
  return list.includes(sticky) ? sticky : list[0];
}

/**
 * v1.0.24 — PURE: what do the two bulk buttons in the ממתינים tab act on?
 *
 * The tab gained per-row checkboxes (the same mechanism as the new-channel picker), and a
 * bulk button that does not SAY its scope is a trap: "דחיית הכול" pressed while three rows
 * are ticked must not throw out thirty. So the scope is derived here and written into the
 * label — with nothing ticked the buttons keep their v1.0.4 meaning (the whole queue,
 * including rows past the 200-row display cap), and one tick narrows both of them.
 *
 * Nothing is ticked by default, unlike the picker: there a channel was just added and is
 * presumed wanted, here the parent is triaging a drip and pre-ticking would put a
 * whole-queue action one tap away under a label that reads like a selection.
 *
 * @param selected how many displayed rows are ticked
 * @param total    how many records are in the queue
 * @returns { scope: 'all'|'selected', count, approve, reject } — count is what will happen
 */
export function pendingBulkAction(selected = 0, total = 0) {
  const sel = Math.max(0, selected | 0);
  const all = Math.max(0, total | 0);
  if (sel <= 0) {
    return { scope: 'all', count: all, approve: '✅ אישור הכול', reject: '🗑️ דחיית הכול' };
  }
  return { scope: 'selected', count: sel, approve: `✅ אישור ${sel}`, reject: `🗑️ דחיית ${sel}` };
}

/**
 * v1.0.25 — PURE: what does the parent get told after a channel finishes importing?
 *
 * A reassuring "הערוץ סונכרן ✅" over a backlog of 109 videos the child cannot see is how
 * the v1.0.22 bug stayed invisible for a whole release: the parent had no reason to look
 * in ממתינים, so the child's home just stayed empty. The message must therefore always
 * name the outcome — approved, waiting, or genuinely nothing.
 *
 * Both entry points share it (parent screen + a channel shared from YouTube), which is
 * the point: the share path used to announce success before the import had even run.
 *
 * A ZERO gets named too. Until the forced-sync fix a zero was usually a lie (the sync had
 * joined the launch run and never looked at this channel); now that it is real, "nothing
 * arrived" and "this channel publishes only Shorts" are different facts, and the second
 * one is permanent — Shorts are excluded on purpose (v1.0.21), so the parent should hear
 * it rather than stare at an empty folder. A plain ✅ is left for the one case that
 * deserves it: nothing new, but the channel does have content the child can see.
 *
 * @param approved did the parent choose "אישור הכל"?
 * @param count    the backlog size, whichever way they answered
 * @param empty    only consulted when count is 0 — { noLongForm, hasLive }
 */
export function channelAddOutcome(approved, count = 0, empty = {}, picked = null) {
  const n = Math.max(0, count | 0);
  const { noLongForm = false, hasLive = true, isPlaylist = false } = empty || {};
  // v1.0.37 — A DROPPED IMPORT MUST NAME ITSELF. Both of these produced the identical
  // "אבל לא נמצאו בו סרטונים" as a channel that genuinely has none, and both are states
  // of the LIBRARY, not of the channel — which is why the parent (and four releases of
  // fixes) kept looking at the channel. Measured with 98 real candidates: a library at
  // the ceiling drops all 98 as `capped`; a channel whose videos were removed before
  // drops all 98 as `denied`.
  const capped = Math.max(0, (empty && empty.capped) | 0);
  const denied = Math.max(0, (empty && empty.denied) | 0);
  // v1.0.26: a playlist is a source too, and calling it "הערוץ" is the kind of small lie
  // that makes a parent wonder whether the app understood what they pasted.
  // Hebrew gender agrees with the noun: ערוץ is masculine, רשימה feminine.
  const what = isPlaylist ? 'רשימת ההשמעה נוספה' : 'הערוץ נוסף';
  const inIt = isPlaylist ? 'בה' : 'בו';
  if (approved && n) return `${what} ו-${n} סרטונים אושרו ✅`;
  // v1.0.26 FIELD-ADJACENT BUG, found while verifying the waiting screens: after the
  // MANUAL pick the message fell through to "N ממתינים לאישור" — reporting a queue the
  // parent had just emptied by hand. Nothing is waiting after a pick; say what they chose.
  if (picked && (picked.kept | 0) + (picked.rejected | 0) > 0) {
    const kept = picked.kept | 0;
    const rej = picked.rejected | 0;
    if (kept && rej) return `${what}: ${kept} סרטונים אושרו ו-${rej} נדחו ✅`;
    if (kept) return `${what} ו-${kept} סרטונים אושרו ✅`;
    return `${what}, וכל ${rej} הסרטונים נדחו`;
  }
  // A PARTIAL cap is the same lie in miniature: "12 ממתינים לאישור" over a 98-video
  // channel reads as "that is the whole channel". The clause is appended rather than
  // replacing the branch, so every message keeps naming what DID arrive.
  if (n) {
    const base = `${what}. ${n} סרטונים ממתינים לאישור ברשימת "ממתינים" 👀`;
    return capped ? `${base} (${capped} סרטונים לא נוספו — הספרייה הגיעה למגבלה)` : base;
  }
  // The ceiling first: it is the one a parent can act on immediately, and it blocks
  // every source in the library rather than just this one.
  if (capped) return `${what}, אבל הספרייה הגיעה למגבלת הסרטונים — ${capped} סרטונים לא נוספו. מחקו ערוץ או תוכן שאינו בשימוש ונסו שוב`;
  // Previously removed: irreversible until now (a channel video has no sheet row to
  // re-add, so no tombstone could ever be revoked). The caller offers the restore.
  if (denied) return `${what}, אבל ${denied} מהסרטונים שלו הוסרו בעבר ולכן לא נוספו`;
  if (noLongForm) return 'הערוץ נוסף, אבל הוא מפרסם רק Shorts — לא נמשכו ממנו סרטונים';
  if (!hasLive) return `${what}, אבל לא נמצאו ${inIt} סרטונים`;
  return isPlaylist ? 'רשימת ההשמעה סונכרנה ✅' : 'הערוץ סונכרן ✅';
}

/**
 * v1.0.20 — PURE: may the home render its ONE folder's videos flat, with no tile?
 *
 * The rule exists for the sheet-only setup: when the only folder is the shared
 * "סרטונים נוספים" list, making the child tap into it first is a pointless step, so
 * the home shows the videos directly.
 *
 * FIELD BUG it fixes: the old test was "exactly one folder, whatever it is", so a
 * library whose only content was ONE subscribed channel flattened too — the parent
 * added a channel and got a 100-page flat wall of its backfill instead of the 📺
 * folder with the channel's logo, which is the whole point of subscribing. A channel
 * (or a 🎞️ collection) has an IDENTITY the child navigates by; it always gets a tile.
 *
 * @param folders the built folder list (`{ id, isNew }` is all this needs)
 */
export function shouldFlattenHome(folders) {
  const list = Array.isArray(folders) ? folders : [];
  if (list.length !== 1) return false;
  const only = list[0];
  // 🎁 "חדשים" is a view over other folders' videos, never the home in its own right
  if (!only || only.isNew) return false;
  return FLAT_FOLDER_IDS.has(only.id);
}

/**
 * v1.0.12 — PURE: group loose single links by their SOURCE channel.
 * Singles (manual adds / sheet rows / shares — records with no channelId) that come
 * from the same YouTube channel are collected into one virtual folder so the child's
 * home stays tidy; a channel with only ONE single stays in the flat list, which also
 * means deleting down to one video un-groups it automatically (no migration).
 *
 * A single whose channel is ALREADY subscribed is NOT grouped separately (user
 * decision): its id is returned under `absorb` so the UI can show it inside that
 * channel's existing folder — one folder per channel, never two with the same name.
 *
 * @param singles      [{ key, srcChannelId, srcChannelTitle }] — live, sheet-folder records
 * @param subscribedChannelIds Set/array of channel ids the library subscribes to
 * @param min          how many singles make a group (2 = "a pair or more")
 * @returns { groups: [{ channelId, title, keys }], absorb: Map<channelId, keys[]>, loose: keys[] }
 */
export function groupSinglesByChannel(singles, subscribedChannelIds = [], min = 2) {
  const subscribed = subscribedChannelIds instanceof Set
    ? subscribedChannelIds : new Set(subscribedChannelIds || []);
  const byChannel = new Map();
  const loose = [];
  for (const s of singles || []) {
    if (!s || !s.key) continue;
    if (!s.srcChannelId) { loose.push(s.key); continue; }
    if (!byChannel.has(s.srcChannelId)) byChannel.set(s.srcChannelId, []);
    byChannel.get(s.srcChannelId).push(s);
  }
  const groups = [];
  const absorb = new Map();
  for (const [channelId, list] of byChannel) {
    if (subscribed.has(channelId)) { absorb.set(channelId, list.map((s) => s.key)); continue; }
    if (list.length >= min) {
      const titled = list.find((s) => s.srcChannelTitle);
      groups.push({
        channelId,
        title: (titled && titled.srcChannelTitle) || 'ערוץ',
        keys: list.map((s) => s.key)
      });
    } else {
      for (const s of list) loose.push(s.key);
    }
  }
  groups.sort((a, b) => (b.keys.length - a.keys.length) || (a.channelId < b.channelId ? -1 : 1));
  return { groups, absorb, loose };
}

/* ---------------- The parent's channel list (v1.0.32) ---------------- */

/** A channel awaiting its sync decision surfaces as "new" for this long. */
export const NEW_CHANNEL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * PURE: split the parent's subscriptions into "ערוצים חדשים" (awaiting a decision) and
 * the folded regular list, both newest-first.
 *
 * A channel is FRESH only while BOTH hold: nobody has made its sync decision yet
 * (`decidedAt` — stamped by the three-way dialog's real answers, by the auto-approve
 * toggle, and at creation for a sheet row that carries an explicit auto/manual flag; a
 * decision made on ANY device travels with the record), and it entered within the
 * window. The window runs from `addedAt`, so an unhandled channel drains into the
 * regular list by itself — the section can never silt up. "אחר כך" is deliberately NOT
 * a decision (that is the whole point of the third button).
 *
 * A row with no usable `addedAt` (pre-v1.0.21 rows) is never fresh — surprising an old
 * subscription into the "new" section would read as a bug — and sorts to the END of the
 * regular list, where old things belong.
 */
export function planChannelSections(channels, { now = Date.now() } = {}) {
  const fresh = [];
  const rest = [];
  for (const c of channels || []) {
    if (!c || !c.channelId) continue;
    const added = Number(c.addedAt) || 0;
    // |now-added| — a peer device's clock may run minutes AHEAD, and its just-added
    // channel must still read as new here; a wildly future stamp (a broken clock) must
    // not pin a row into the section for a year.
    const delta = now - added;
    const inWindow = added > 0 && delta < NEW_CHANNEL_WINDOW_MS && delta > -NEW_CHANNEL_WINDOW_MS;
    if (!c.decidedAt && inWindow) fresh.push(c);
    else rest.push(c);
  }
  const newestFirst = (a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
  fresh.sort(newestFirst);
  rest.sort(newestFirst); // missing addedAt ⇒ 0 ⇒ the end, stable among themselves
  return { fresh, rest };
}

/* ---------------- Channel-logo byte cache (v1.0.32) ---------------- */

/**
 * PURE: how to render a channel's avatar, and whether to (re)fetch its bytes.
 * Cached bytes ALWAYS render — offline, dead URLs and rebrands included — and the
 * render never waits for the network: a NEW url only refreshes the cache in the
 * background. No bytes + no url = the emoji fallback, and nothing to fetch.
 */
export function planLogoCache({ hasBlob = false, blobSrcUrl = null, url = null } = {}) {
  const u = typeof url === 'string' && url ? url : null;
  if (hasBlob) return { render: 'blob', fetch: !!(u && u !== blobSrcUrl) };
  return u ? { render: 'url', fetch: true } : { render: 'emoji', fetch: false };
}

/**
 * PURE (v1.0.32 hardening): what the FIRST PAINT of a channel logo uses. Bytes already
 * in memory win — the `<img src=url>` form hit the network on EVERY render even when the
 * cache was full (found in self-review), which is the exact waste the cache exists to
 * remove. No bytes → the URL; neither → the emoji until (maybe) IDB bytes arrive.
 */
export function logoFirstPaint({ cachedObjUrl = null, url = null } = {}) {
  if (typeof cachedObjUrl === 'string' && cachedObjUrl) return { kind: 'blob', src: cachedObjUrl };
  if (typeof url === 'string' && url) return { kind: 'url', src: url };
  return { kind: 'emoji', src: null };
}

/**
 * PURE (v1.0.32 hardening): may a finished logo fetch deliver into its target?
 *  'set'     — the img is still mounted: just point it at the bytes.
 *  'remount' — the emoji fallback replaced the img (onerror), but the HOST still shows
 *              THIS channel: put the img back and paint it.
 *  'skip'    — anything else. The guard is the hostChannelId comparison: the folder
 *              header (#folder-logo-top) is ONE element shared by every folder view, so
 *              channel A's late fetch used to re-mount A's logo into the header while it
 *              already belonged to folder B (real bug, caught in self-review). A host
 *              that meanwhile serves another channel is not ours to touch.
 */
export function planLogoDelivery({ imgConnected = false, hostConnected = false, hostChannelId = null, channelId = null } = {}) {
  if (imgConnected) return 'set';
  if (hostConnected && channelId && hostChannelId === channelId) return 'remount';
  return 'skip';
}

/* ==================== v1.0.38 — the links file, and reviving a deletion ====================
 *
 * The Google-Sheets sources list is gone. Two of its jobs needed a replacement, and both
 * live here as pure decisions:
 *   1. bulk add / move a library between devices  → the links file (serialized elsewhere,
 *      DECIDED here: what a row becomes, what a confirm says, what the outcome says).
 *   2. revoking a deletion tombstone. Until now the ONLY undeny path was the sheet
 *      re-adding the key (planSheetMirror.unDenyKeys). An explicit re-add is that act now
 *      — but it must be an explicit ANSWER, never automatic.
 */

/**
 * PURE: the `libraryChannels` record ONE source row asks for.
 *
 * Extracted from sync2's channel-row loop so the sheet reader (while it still exists),
 * the links importer and any future row source share ONE rule. The v1.0.25/v1.0.33 lesson:
 * two callers with private copies of "add" is exactly how the share path once shipped
 * without the import-and-ask flow.
 *
 * flag 'auto' ⇒ autoApprove true · 'manual' ⇒ false · ABSENT ⇒ !!src.defaultAutoApprove.
 * `decidedAt`: an EXPLICIT flag IS the parent's decision (v1.0.32), so the row skips the
 * "ערוצים חדשים" section; a FLAGLESS row gets null and surfaces there for 24h — which is
 * where a bulk import should ask, once per channel, instead of in sixteen modals.
 * `updatedAt` is deliberately NOT set here: db.putLibraryChannel stamps it (v1.0.22).
 */
export function channelRowSubscription(row, src, { now = Date.now(), order = 0, source = 'file' } = {}) {
  const r = row || {};
  const flag = String(r.flag || '').trim().toLowerCase();
  const explicit = flag === 'auto' || flag === 'manual';
  const rec = {
    libraryId: (src && src.libraryId) || null,
    channelId: r.channelId || r.playlistId || null,
    autoApprove: flag === 'auto' ? true : flag === 'manual' ? false : !!(src && src.defaultAutoApprove),
    autoApproveSource: explicit ? source : 'default',
    decidedAt: explicit ? now : null,
    order: order | 0,
    addedAt: now,
    hidden: false,
    sourceRow: true,
    titleOverride: r.title || ''
  };
  if (r.kind === 'playlist' || (!r.channelId && r.playlistId)) rec.kind = 'playlist';
  return rec;
}

/**
 * PURE: the video record a MANUAL add writes (paste, search result, links-file row).
 *
 * Extracted from app.addClassifiedRow — same reason as channelRowSubscription. `origin`
 * decides the sortKey DOMAIN (order.js), so a links-file row passes 'sheet-row' + its line
 * number and lands in the same ordering domain a sheet row used to, while a pasted link
 * stays 'manual' (above all of them). The caller supplies sortKey because order.js is not
 * imported here.
 */
export function manualVideoRecord({ row, scope, title = '', sortKey = 0, origin = 'manual',
  rowIndex = null, now = Date.now() } = {}) {
  const r = row || {};
  const display = String(title || '').trim();
  return {
    scopeId: scope, key: r.key, type: r.type, id: r.id ?? null, url: r.url ?? null,
    srcUrl: r.srcUrl, driveId: r.driveId ?? null, media: r.media ?? null,
    title: display, titleSource: display ? 'sheet' : null,
    folderId: 'sheet', channelId: null,   // 'sheet' is the ⭐ folder id, not a spreadsheet
    sortKey, publishedAt: null, rowIndex, origin, state: 'live',
    addedAt: now, approvedAt: now,
    thumbId: null, thumbUrl: null, localPath: null, updatedAt: now
  };
}

/**
 * PURE: does some SUBSCRIPTION already reproduce this record, so the links file must not
 * give it a line of its own?
 *
 * planOrphanGC's rule read forwards — deliberately the same expression, not a second copy:
 * a record belongs to a subscription when its channelId is a subscribed CHANNEL or its
 * folder is a subscribed PLAYLIST's `pl:<id>` (parked rows judged by homeFolderId). A
 * subscribed channel's 2000 videos are ONE channel line; exporting them all produces a
 * file no parent can read, doubles the import, and re-adds videos they may have rejected.
 */
export function coveredBySubscription(rec, subscriptions) {
  if (!rec || !rec.key) return false;
  const subs = [...(subscriptions || [])].filter(Boolean);
  if (rec.channelId && subs.some((c) => c.channelId === rec.channelId)) return true;
  const folder = (rec.folderId === '~pending' || rec.folderId === '~rejected')
    ? rec.homeFolderId : rec.folderId;
  return subs.some((c) => c.kind === 'playlist' && 'pl:' + c.channelId === folder);
}

/**
 * PURE: this key was deleted before. What is the parent asked?
 *
 * WHY THIS EXISTS. A deny tombstone was revocable by exactly one thing — the SHEET
 * re-adding the key (v1.0.10) — and drive.mergeDbFiles DELETES any video whose tombstone
 * is active from the merged document. So with the sheet gone, a re-pasted deleted video
 * would be written, shown to the child, and silently destroyed by the next pull on every
 * device. (That hole is already open today: addClassifiedRow never consulted the deny set
 * at all — the sheet's un-deny was quietly repairing it.)
 *
 * It must be an ANSWER, never automatic: a parent who removed three bad videos must not
 * get them back for re-pasting a link (the v1.0.23 rule — showing rejected content is the
 * betrayal, hiding wanted content is a complaint).
 *
 * `ask:false` when nothing is denied, or when a live record already EXISTS — asking about
 * a tombstone for a key that also has a record is incoherent.
 * `count` is how many keys ONE answer covers: a bulk import asks once, not N times.
 *
 * The wording varies by COUNT and not by entry point, deliberately: paste, search, share
 * and import all revoke the same thing, and one dialog the parent learns once beats four
 * that say it differently.
 * -> { ask, emoji, title, text, ok, cancel }
 */
export function deniedReAddPrompt(opts) {
  // Destructured from `(opts || {})`, never a `= {}` default parameter: that only fires for
  // `undefined`, so an explicit `null` from a caller reading an absent record would throw
  // — the same trap as `Number(null) === 0` in screenOffMinutes.
  const { denied = false, exists = false, count = 1, source = '' } = opts || {};
  const n = Math.max(0, Number(count) | 0);
  // v1.0.61 — the plural sentence names WHERE the parent is standing. It was written for the
  // links file and says "בקובץ … מהלינקים בקובץ"; a Drive folder import reused it verbatim and
  // told a parent importing a FOLDER of songs about links in a file they never opened. The
  // words are the feature (the v1.0.27 rule), so the noun follows the door.
  const where = source === 'drive-folder'
    ? { in: 'בתיקיה', of: 'מהקבצים בתיקיה' }
    : { in: 'בקובץ', of: 'מהלינקים בקובץ' };
  if (!denied || exists || !n) return { ask: false };
  // "בכל המכשירים" is not decoration: un-denying is not a local act, and a parent who
  // thinks otherwise would be surprised on the other tablet.
  if (n === 1) {
    return {
      ask: true, emoji: '♻️',
      title: 'הסרטון הזה הוסר בעבר — להחזיר אותו?',
      text: 'מחקתם את הסרטון הזה קודם, ולכן הוא לא נוסף שוב. "החזרה" תבטל את המחיקה בכל המכשירים.',
      ok: 'החזרה', cancel: 'לא, להשאיר מוסר'
    };
  }
  return {
    ask: true, emoji: '♻️',
    title: `${n} מהסרטונים ${where.in} הוסרו בעבר — להחזיר אותם?`,
    text: `${n} ${where.of} מפנים לסרטונים שמחקתם בעבר, ולכן הם לא נוספו. `
      + '"החזרה" תבטל את המחיקה שלהם בכל המכשירים; השאר נוספו כרגיל.',
    ok: 'החזרה', cancel: 'לא, להשאיר מוסרים'
  };
}

/**
 * PURE: the same question for a whole CHANNEL's removed backlog (v1.0.37's
 * app.offerDeniedRestore, moved here so both revive dialogs are pinned in one place).
 * A channel video has no row anywhere, so before this the removal was permanent.
 */
export function deniedRestorePrompt(count = 0, { isPlaylist = false } = {}) {
  const n = Math.max(0, Number(count) | 0);
  if (!n) return { ask: false };
  const what = isPlaylist ? 'רשימת ההשמעה' : 'הערוץ';
  const many = n > 1;
  // hebCount, for the same reason linksImportOutcome uses it: "1 סרטונים … הוסרו" is wrong in
  // a way a parent notices, and a channel whose ONE removed video blocks the import is a
  // perfectly ordinary case.
  const videos = hebCount(n, 'סרטון', 'סרטונים');
  return {
    ask: true, emoji: '♻️',
    title: `${videos} של ${what} ${many ? 'הוסרו' : 'הוסר'} בעבר`,
    text: `מחקתם ${videos} של ${what} הזה בעבר, ולכן ${many ? 'הם לא נוספו' : 'הוא לא נוסף'} שוב. `
      + `להחזיר ${many ? 'אותם' : 'אותו'} לרשימת ההמתנה לאישור? הפעולה תבטל את המחיקה בכל המכשירים.`,
    ok: 'החזרה לאישור', cancel: many ? 'לא, להשאיר מוסרים' : 'לא, להשאיר מוסר'
  };
}

/* ==================== v1.0.38 — the sheet SUNSET (delete after 2026-09-10) ====================
 *
 * The one-time migration off the Google-Sheets sources list: read the sheet ONE last time,
 * fold it into the database, forget it, delete the file the app created. Everything here is
 * scheduled for deletion — see test/sunset.test.mjs for the removal checklist.
 */


/** The links file's row cap. A parent's list is tens of lines; this is the accident bound. */
export const LINKS_IMPORT_MAX = 1000;

/**
 * PURE: a counted Hebrew noun phrase. "1 ערוצים" is wrong in a way a parent notices
 * immediately, and every count in these messages can legitimately be 1 (one channel, one
 * revived video, one duplicate). Hebrew puts the numeral BEFORE a plural noun but says
 * "ערוץ אחד" for one, so the two forms are not the same shape.
 */
export function hebCount(n, one, many) {
  const k = Math.max(0, Number(n) | 0);
  return k === 1 ? `${one} אחד` : `${k} ${many}`;
}

/** The same for a FEMININE noun ("רשימה אחת"). */
export function hebCountF(n, one, many) {
  const k = Math.max(0, Number(n) | 0);
  return k === 1 ? `${one} אחת` : `${k} ${many}`;
}

/**
 * PURE: the confirm dialog for one parsed links file.
 *
 * Counts BY KIND, always — "יובאו 40 שורות" tells a parent nothing about whether they are
 * about to subscribe to sixteen channels. `ok` NAMES THE TARGET profile, so a parent
 * standing in the wrong child's profile sees it before committing. `third` is offered only
 * when the file carries a profile name that does not already exist (never auto-rename
 * behind their back — v1.0.22).
 * Raised with askKid, not confirmKid: a scrim-tap dismiss must not count as an answer.
 * -> { emoji, title, text, ok, cancel, third? }
 */
export function linksImportConfirm(counts, { targetName = '', profileName = '', canCreateProfile = false } = {}) {
  const c = counts || {};
  const ch = Math.max(0, c.channels | 0);
  const pl = Math.max(0, c.playlists | 0);
  const vid = Math.max(0, c.videos | 0);
  const bad = Math.max(0, c.invalid | 0);
  const rm = Math.max(0, c.removed | 0);
  const parts = [];
  if (ch) parts.push(hebCount(ch, 'ערוץ', 'ערוצים'));
  if (pl) parts.push(hebCountF(pl, 'רשימת השמעה', 'רשימות השמעה'));
  if (vid) parts.push(hebCount(vid, 'סרטון', 'סרטונים'));
  const what = parts.length ? parts.join(' · ') : 'שום דבר שאפשר להוסיף';
  let text = `בקובץ: ${what}.`;
  if (bad) text += ` ${bad} שורות לא זוהו ויידלגו.`;
  if (rm) text += ` ${rm} שורות מסומנות כמוסרות ויידלגו.`;
  if (ch || pl) text += ' סרטונים מערוץ או מרשימה ימתינו לאישורכם, אלא אם סומן auto.';
  const target = String(targetName || '').trim();
  const out = {
    emoji: '📄',
    title: 'לייבא את הרשימה?',
    text,
    ok: target ? `ייבוא ל${target}` : 'ייבוא',
    cancel: 'ביטול'
  };
  const name = String(profileName || '').trim();
  if (canCreateProfile && name) out.third = `לפרופיל חדש בשם "${name}"`;
  else if (name && !canCreateProfile) out.text += ` (כבר יש פרופיל בשם "${name}".)`;
  return out;
}

/**
 * PURE: what actually happened. Same contract as channelAddOutcome — ALWAYS name the
 * outcome, and A ZERO MUST NAME ITS OWN CAUSE (v1.0.37). Every branch is distinct, because
 * "nothing happened" and "everything was already here" are different facts to a parent
 * staring at an unchanged screen.
 */
export function linksImportOutcome({ channels = 0, playlists = 0, videos = 0, pending = 0,
  existed = 0, skippedDenied = 0, revived = 0, failed = 0, invalid = 0 } = {}) {
  const ch = Math.max(0, channels | 0);
  const pl = Math.max(0, playlists | 0);
  const vid = Math.max(0, videos | 0);
  const added = ch + pl + vid;
  if (!added) {
    if (existed) return `כל הלינקים בקובץ (${existed}) כבר קיימים בספרייה — לא נוסף כלום`;
    if (skippedDenied) return `כל הלינקים בקובץ (${skippedDenied}) הוסרו בעבר ולא הוחזרו — לא נוסף כלום`;
    if (failed) return `לא הצלחנו לזהות ${hebCount(failed, 'מקור', 'מקורות')} בקובץ — בדקו את הלינקים ונסו שוב`;
    if (invalid) return 'אף שורה בקובץ לא זוהתה כלינק נתמך — לא נוסף כלום';
    return 'לא נוסף כלום — הקובץ לא הכיל לינקים חדשים';
  }
  const parts = [];
  if (ch) parts.push(hebCount(ch, 'ערוץ', 'ערוצים'));
  if (pl) parts.push(hebCountF(pl, 'רשימת השמעה', 'רשימות השמעה'));
  if (vid) parts.push(hebCount(vid, 'סרטון', 'סרטונים'));
  let msg = `${added === 1 ? 'נוסף' : 'נוספו'} ${parts.join(' · ')} ✅`;
  if (pending) msg += ` · ${hebCount(pending, 'סרטון', 'סרטונים')} ${pending === 1 ? 'ממתין' : 'ממתינים'} לאישור ברשימת "ממתינים" 👀`;
  if (revived) msg += ` · ${revived} ${revived === 1 ? 'הוחזר' : 'הוחזרו'} ממחיקה`;
  if (skippedDenied) msg += ` · ${skippedDenied} ${skippedDenied === 1 ? 'דולג' : 'דולגו'} (הוסרו בעבר)`;
  if (existed) msg += ` · ${existed} ${existed === 1 ? 'כבר היה' : 'כבר היו'} בספרייה`;
  if (failed) msg += ` · ${failed} ${failed === 1 ? 'מקור לא זוהה' : 'מקורות לא זוהו'}`;
  return msg;
}

/**
 * PURE: what the parent is told after an export, per delivery rung.
 *
 * EVERY rung names WHERE THE FILE IS, and no two share a sentence — an export whose file
 * the parent cannot find is the same failure as no export at all. 'nothing' exists because
 * an empty file that shares as a blank message is the silent-nothing failure (v1.0.26).
 */
export function linksExportOutcome({ delivery = 'none', name = '', dir = '', counts = null } = {}) {
  const c = counts || {};
  const n = Math.max(0, (c.channels | 0) + (c.playlists | 0) + (c.videos | 0) + (c.files | 0));
  const where = dir ? `${dir}${name}` : name;
  switch (delivery) {
    case 'nothing':
      return { ok: false, text: 'אין עדיין תוכן לייצוא — הוסיפו סרטון או ערוץ קודם' };
    case 'native':
      return { ok: true, text: `נשמר קובץ עם ${n} לינקים ונפתחה חלונית שיתוף. הקובץ במכשיר: ${where}` };
    case 'file-only':
      return { ok: true, shareTextFallback: true,
        text: `הקובץ נשמר במכשיר ✅ ${where} — לא נמצאה אפליקציה לשיתוף. אפשר לשלוח אותו כטקסט בכפתור שמתחת.` };
    case 'download':
      return { ok: true, text: `הקובץ ירד לתיקיית ההורדות בשם ${name}` };
    case 'clipboard':
      return { ok: true, text: 'הרשימה הועתקה ללוח — הדביקו אותה בהודעה או בקובץ ושמרו' };
    case 'shown':
      return { ok: true, shown: true, text: 'לא הצלחנו לשמור קובץ — הרשימה מוצגת כאן להעתקה ידנית' };
    default:
      return { ok: false, text: 'הייצוא נכשל — נסו שוב' };
  }
}

/* ---------------- custom folders (v1.0.56) ---------------- */

/** The prefix that makes a folder id a parent-created one. `cf:` is deliberately short
 *  and distinct from `ch:`/`pl:`/`grp:`; `isCustomFolder` is the ONE test everywhere. */
export const CUSTOM_FOLDER_PREFIX = 'cf:';
export const isCustomFolder = (folderId) => String(folderId || '').startsWith(CUSTOM_FOLDER_PREFIX);

/** A folder title is drawn at full length on a tile and typed by a parent, so it is
 *  bounded exactly like a profile name is (v1.0.26): trim, collapse whitespace, cap BY
 *  CODE POINT (a `.slice` cuts "🦁" in half and stores a lone surrogate forever). */
export const FOLDER_TITLE_MAX = 24;
export function normalizeFolderTitle(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, FOLDER_TITLE_MAX).join('');
}

/**
 * PURE: mint a custom folder id. Random, like a profile id — it is created on ONE device
 * and travels in the Drive doc, so there is nothing to agree on and nothing to derive
 * from the title (which the parent may rename, and two folders may legitimately share).
 */
export function customFolderId(now = Date.now(), rand = Math.random()) {
  const t = Math.max(0, Math.floor(Number(now) || 0)).toString(36);
  const r = Math.floor(Math.abs(Number(rand) || 0) * 1e9).toString(36).padStart(6, '0').slice(0, 6);
  return CUSTOM_FOLDER_PREFIX + t + r;
}

/**
 * PURE: is this title already taken in this library? Compared on the NORMALIZED title
 * (the same normalizeTitle the dedupe index uses), so "חיות" and "חיות " are one name.
 * Returns the clashing folder or null — never throws on a junk list.
 */
export function customFolderTitleClash(title, folders, { exceptId = null } = {}) {
  const want = normalizeTitle(normalizeFolderTitle(title));
  if (!want) return null;
  for (const f of folders || []) {
    if (!f || f.folderId === exceptId) continue;
    if (normalizeTitle(normalizeFolderTitle(f.title)) === want) return f;
  }
  return null;
}

/**
 * PURE: the destination list for the "where should this go?" picker, in the order it is
 * shown. The DEFAULT is always first and always 'sheet' ("סרטונים נוספים") — the user's
 * decision: a parent who just taps the first button gets exactly today's behaviour.
 * Custom folders follow in their own order; `create` is the last row.
 */
export function folderPickOptions(customFolders, { defaultTitle = 'סרטונים נוספים' } = {}) {
  const rows = [{ folderId: 'sheet', title: defaultTitle, emoji: '🎬', isDefault: true }];
  for (const f of [...(customFolders || [])].filter(Boolean).sort((a, b) => (a.order || 0) - (b.order || 0))) {
    if (!isCustomFolder(f.folderId)) continue;
    rows.push({ folderId: f.folderId, title: f.title || 'תיקיה', emoji: f.emoji || '📁', isDefault: false });
  }
  return rows;
}

/**
 * PURE: what a folder deletion does, and what the parent must be told before it happens.
 *  - 'move'  — the folder row goes, its videos land back in "סרטונים נוספים". Reversible
 *              in the sense that matters: nothing is destroyed.
 *  - 'purge' — the videos are DELETED with tombstones (the v1.0.39 rule: a raw delete is
 *              pure absence and every Drive merge is a union, so a peer would re-push
 *              them). Irreversible, and the text says so.
 * An empty folder needs no question at all — `needsChoice` is false and 'move' is a no-op.
 */
export function planFolderDeletion({ title = '', count = 0, mode = 'move', children = 0 } = {}) {
  const n = Math.max(0, Number(count) | 0);
  const name = String(title || 'התיקיה');
  // v1.0.61 — DELETING A COLLECTION DELETES THE FOLDERS INSIDE IT (the user's decision: it
  // works like Drive). Saying so is not politeness: after nesting, "delete this folder" can
  // mean 32 discs and 751 songs, and a parent who reads only the folder's own name has been
  // told the smallest true thing rather than the relevant one.
  const kids = Math.max(0, Number(children) | 0);
  const alsoFolders = kids ? (kids === 1 ? ' ואת התיקיה שבתוכה' : ` ואת ${kids} התיקיות שבתוכה`) : '';
  if (!n) {
    return { needsChoice: !!kids, mode: 'move', moves: 0, deletes: 0, children: kids,
      text: kids
        ? `למחוק את התיקיה "${name}"${alsoFolders}? היא לא מכילה סרטונים בעצמה.`
        : `למחוק את התיקיה "${name}"? היא ריקה.` };
  }
  // The singular/plural phrasing is written out rather than built with hebCount: that
  // helper appends "אחד" AFTER its noun ("סרטון אחד"), which only reads correctly when the
  // noun phrase ends there — embedding a verb produced "הסרטון שבתוכה יעבור אחד".
  if (mode === 'purge') {
    const what = n === 1 ? 'ואת הסרטון שבתוכה' : `ואת ${n} הסרטונים שבתוכה`;
    return { needsChoice: true, mode: 'purge', moves: 0, deletes: n, children: kids,
      text: `למחוק את התיקיה "${name}"${alsoFolders} ${what} לצמיתות? ` +
        'הסרטונים יימחקו בכל המכשירים ולא ניתן יהיה לשחזר אותם — רק להוסיף מחדש.' };
  }
  const what = n === 1 ? 'הסרטון שבתוכה יעבור' : `${n} הסרטונים שבתוכה יעברו`;
  return { needsChoice: true, mode: 'move', moves: n, deletes: 0, children: kids,
    text: `למחוק את התיקיה "${name}"${alsoFolders}? ${what} ל"סרטונים נוספים" — שום סרטון לא יימחק.` };
}

/* ---------------- Drive folders (v1.0.56) ----------------
   A subscribed Drive folder is just a CUSTOM FOLDER that knows how to refill itself: the
   folder row carries `driveFolderId`, and its files are ordinary video records filed under
   its own `cf:<id>`. That reuse is the whole design — paging, parking, search, deletion,
   the watch-grid chain and the Drive sync all already work on those. */

/**
 * PURE: compare two filenames the way a human reads a numbered album — "פרק 2" before
 * "פרק 10". A plain string sort puts 10 before 2, which for a folder of numbered songs
 * means the child gets them in the wrong order, every time.
 */
export function naturalCompare(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const re = /(\d+)|(\D+)/g;
  const pa = sa.match(re) || [];
  const pb = sb.match(re) || [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else {
      const d = x.localeCompare(y, 'he');
      if (d) return d;
    }
  }
  return pa.length - pb.length;
}

/**
 * PURE: which files of a listed Drive folder become records, and in what order.
 *
 * ADDITIVE ONLY (user decision 2026-08-29): a file that vanished from Drive is NOT deleted
 * here — a failed listing that reads as "the folder is empty" is exactly the shape that
 * deleted families' libraries in the sheet era, and the parent can always delete in-app.
 * Non-media (a PDF, a subfolder) is filtered; a file already in the library, or one whose
 * key carries an active deny tombstone, is skipped.
 *
 * -> { add: [{driveId,name,media}], skipped: {existing,denied,nonMedia} }
 */
export function planDriveFolderImport({ files = [], existingKeys = null, denyKeys = null,
  mediaKindOf = null } = {}) {
  const have = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
  const denied = denyKeys instanceof Set ? denyKeys : new Set(denyKeys || []);
  const kindOf = typeof mediaKindOf === 'function' ? mediaKindOf : () => null;
  const add = [];
  const skipped = { existing: 0, denied: 0, nonMedia: 0 };
  // v1.0.61 — the denied KEYS, not just their count. A count can only be reported; the keys
  // are what lets the parent be ASKED and the tombstones revoked when they say yes (user
  // request). Collected here rather than re-derived by the caller, so "which files were
  // refused" keeps exactly one answer.
  const deniedKeys = [];
  const rows = [...(files || [])].filter((f) => f && typeof f.id === 'string' && f.id);
  rows.sort((a, b) => naturalCompare(a.name, b.name));
  for (const f of rows) {
    const media = kindOf(f);
    if (media !== 'audio' && media !== 'video') { skipped.nonMedia += 1; continue; }
    const key = 'file:drive:' + f.id;
    if (have.has(key)) { skipped.existing += 1; continue; }
    if (denied.has(key)) { skipped.denied += 1; deniedKeys.push(key); continue; }
    add.push({ driveId: f.id, name: String(f.name || ''), media });
  }
  return { add, skipped, deniedKeys };
}

/**
 * v1.0.58 — PURE: a UNIQUE folder title. A Drive tree can hold two folders with the same
 * name in different branches, and two identical tiles on the child's home is a screen the
 * parent cannot read. Deterministic (" (2)", " (3)") so a re-import lands on the SAME title
 * instead of drifting a suffix upward on every refresh — identity is the driveFolderId, and
 * this only decides what a human reads.
 */
export function uniqueFolderTitle(want, taken, { max = 60 } = {}) {
  const base = String(want || '').trim().slice(0, max) || 'תיקיה';
  const used = new Set([...(taken || [])].map((t) => normalizeTitle(String(t || ''))));
  if (!used.has(normalizeTitle(base))) return base;
  for (let n = 2; n < 500; n++) {
    const cand = `${base} (${n})`;
    if (!used.has(normalizeTitle(cand))) return cand;
  }
  return base;
}

/**
 * v1.0.58 — PURE: turn a walked Drive TREE into app folders and their files.
 *
 * THE USER'S DECISION (2026-08-30): a folder per Drive subfolder, not one flat list. The
 * app has no folder-inside-a-folder screen and deliberately gains none — the tree is
 * FLATTENED INTO A LIST of ordinary custom folders, each carrying its own `driveFolderId`,
 * which is what lets everything built in v1.0.56 (paging, search, the watch-grid chain,
 * deletion with tombstones, the Drive sync) keep working with no new branch anywhere.
 *
 * Which folders get a row:
 *  - the ROOT always, even with no media of its own. It holds nothing, so the child never
 *    sees it (a custom folder with 0 videos is hidden — the v1.0.21 rule), but it is what
 *    ANCHORS the refresh: without a row for it, a disc added to the Drive folder later
 *    would never be noticed, and the user asked for exactly that to keep working.
 *  - any descendant that holds at least one media file. A folder of folders contributes
 *    nothing but its children.
 *
 * Files are routed through `planDriveFolderImport` — the SAME decision the flat import
 * uses — so "which files are media, which are already here, which were removed before"
 * has exactly one answer in this app.
 */
export function planDriveTreeImport({ folders = [], existingFolders = [], existingKeys = null,
  denyKeys = null, mediaKindOf = null, rootId = null } = {}) {
  const byDriveId = new Map();
  for (const f of existingFolders || []) if (f && f.driveFolderId) byDriveId.set(f.driveFolderId, f);
  const taken = (existingFolders || []).map((f) => (f && f.title) || '').filter(Boolean);
  const kindOf = typeof mediaKindOf === 'function' ? mediaKindOf : () => null;

  const out = [];
  const totals = { existing: 0, denied: 0, nonMedia: 0 };
  const deniedKeys = [];
  let added = 0;
  // Pass 1 — plan every node's own files, and remember who holds media. v1.0.58 dropped a
  // folder that held only subfolders ("a folder of folders is not a folder here") because
  // the tree was FLATTENED and such a row could never be opened. v1.0.61 nests it, so that
  // folder is exactly the one the parent taps to reach the discs: it survives if it holds
  // media OR any descendant does.
  const nodes = [];
  const holdsMedia = new Set();
  for (const node of folders || []) {
    if (!node || typeof node.id !== 'string' || !node.id) continue;
    const plan = planDriveFolderImport({
      files: node.files || [], existingKeys, denyKeys, mediaKindOf: kindOf
    });
    totals.existing += plan.skipped.existing;
    totals.denied += plan.skipped.denied;
    totals.nonMedia += plan.skipped.nonMedia;
    deniedKeys.push(...(plan.deniedKeys || []));
    const mediaHere = plan.add.length + plan.skipped.existing + plan.skipped.denied;
    if (mediaHere) holdsMedia.add(node.id);
    nodes.push({ node, plan });
  }
  // Pass 2 — lift "holds media" up every ancestor chain, so a container folder survives.
  // Walking parents per node is O(n·depth) and depth is cap-bounded, which is nothing for
  // the 32-disc trees this exists for.
  const parentOf = new Map();
  for (const { node } of nodes) parentOf.set(node.id, node.parentId || null);
  const bearing = new Set();
  for (const { node } of nodes) {
    if (!holdsMedia.has(node.id)) continue;
    let at = node.id;
    const guard = new Set(); // a malformed parent chain must never loop
    while (at && !guard.has(at)) { guard.add(at); bearing.add(at); at = parentOf.get(at) || null; }
  }
  for (const { node, plan } of nodes) {
    const isRoot = node.id === rootId || node.depth === 0;
    // The ROOT always gets a row even when the whole tree holds nothing: it is what ANCHORS
    // the refresh, and without it nothing would ever re-walk the tree (the v1.0.58 rule).
    if (!isRoot && !bearing.has(node.id)) continue;
    const existing = byDriveId.get(node.id) || null;
    let title = existing ? existing.title : '';
    if (!existing) {
      title = uniqueFolderTitle(normalizeFolderTitle(node.name || '') || 'תיקיה מדרייב', taken);
      taken.push(title);
    }
    added += plan.add.length;
    out.push({
      driveFolderId: node.id, title, isRoot, depth: Number(node.depth) || 0,
      // v1.0.61 — the Drive parent, which the caller maps to a `cf:` id. The walk has always
      // returned it; nothing ever persisted it, which is why the tree arrived FLAT.
      parentDriveId: isRoot ? null : (node.parentId || null),
      existing, add: plan.add, skipped: plan.skipped
    });
  }
  return { folders: out, added, skipped: totals, deniedKeys };
}

/**
 * PURE: what the parent is told after a Drive folder is added or refreshed. A ZERO names
 * its own cause — the v1.0.37 rule: "nothing arrived" and "nothing NEW arrived" and "we
 * could not read the folder" are three different facts, and only one of them is a problem
 * the parent can fix (sharing).
 */
export function driveFolderOutcome({ ok = true, added = 0, skipped = null, first = true,
  folders = 0, truncated = false, partial = false } = {}) {
  const s = skipped || {};
  if (!ok) {
    return 'לא הצלחנו לקרוא את התיקיה מדרייב. ודאו שהיא משותפת "לכל מי שיש לו הקישור"';
  }
  // v1.0.58 — a NESTED import says how it was laid out, because the parent pasted ONE link
  // and is about to find a folder holding several more (v1.0.61: they nest under it now
  // rather than landing beside it on the home); and a walk that was cut short
  // or could not read part of the tree SAYS SO (the v1.0.37 rule) instead of quietly
  // delivering less than the folder holds.
  const notes = [];
  if (truncated) notes.push('התיקיה גדולה מאוד, אז נוספה רק ההתחלה');
  if (partial) notes.push('חלק מתת-התיקיות לא נקראו — ודאו שכולן משותפות');
  const tail = notes.length ? ' · ' + notes.join(' · ') : '';
  if (added > 0) {
    const what = added === 1 ? 'קובץ אחד' : `${added} קבצים`;
    if (folders > 1) {
      const where = `ב-${folders} תיקיות`;
      return (first ? `התיקיה נוספה! ${what} ${where}` : `נוספו ${what} חדשים ${where}`) + tail;
    }
    return (first ? `התיקיה נוספה! ${what} מוכנים` : `נוספו ${what} חדשים`) + tail;
  }
  if (partial) return 'לא הצלחנו לקרוא את תת-התיקיות. ודאו שהן משותפות "לכל מי שיש לו הקישור"';
  if (s.nonMedia && !s.existing && !s.denied) {
    return 'לא נמצאו בתיקיה קבצי שמע או וידאו (קבצים אחרים לא נתמכים)';
  }
  if (s.denied) {
    const n = s.denied === 1 ? 'קובץ אחד' : `${s.denied} קבצים`;
    return `לא נוסף כלום — ${n} בתיקיה הוסרו כאן בעבר`;
  }
  if (s.existing) return 'אין קבצים חדשים בתיקיה';
  return 'התיקיה ריקה';
}

/**
 * v1.0.58 — PURE: which folders a search STARTED INSIDE ONE FOLDER may look at.
 *
 * ⚠️ WHAT "NESTED" MEANS HERE CHANGED IN v1.0.61, and this comment used to say the
 * opposite: folders WERE flat (`ch:`, `cf:`, `grp:`, `pl:`) and the app had no
 * folder-inside-a-folder screen. It has one now — an imported Drive tree nests for real via
 * `parentFolderId`, and the scope is the SUBTREE (pure `folderSubtreeIds`). A folder that
 * nests nothing is still its own scope, which is what "search in this folder" means for
 * every other folder kind.
 *
 * The v1.0.58 rule survives INSIDE a collection, and its reason is unchanged: standing in a
 * disc searches THE WHOLE COLLECTION (the user's decision 2026-08-30), because reading it
 * strictly downwards would make the feature useless exactly where it was asked for — the
 * root row is hidden from the child when it holds no songs of its own, so from a disc there
 * would be no way to reach the other 31. `driveRootId` remains the fallback for a tree
 * imported before v1.0.61 whose rows have not been re-walked yet.
 *
 * ⚠️ A FOLDER LOCK NARROWS IT TO ONE FOLDER, ALWAYS. The global search is hidden under a
 * folder lock precisely because "search reaches ANOTHER folder"; a scoped search may stay
 * (the user's decision) only for as long as it cannot do that — and a result from a sibling
 * folder is a way to reach that folder's grid through the watch screen.
 */
/**
 * PURE (v1.0.61): the chain of folder ids from `folderId` up to its root, the folder itself
 * FIRST. `[]` for an unknown id.
 *
 * This is the one place that walks `parentFolderId`, because a folder lock, the home filter
 * and the search scope all need the same answer and three copies would disagree exactly
 * where it hurts. The cycle guard is not defensive decoration: `parentFolderId` travels in
 * the Drive document and is merged LWW per row, so two devices editing different rows can
 * briefly produce a chain that points at itself — and a lock that hangs is a child stuck.
 */
export function folderAncestry(folderId, rows = []) {
  const fid = String(folderId || '');
  if (!fid) return [];
  const by = new Map();
  for (const r of rows || []) if (r && r.folderId) by.set(r.folderId, r);
  if (!by.has(fid)) return [];
  const out = [];
  const seen = new Set();
  let at = fid;
  while (at && by.has(at) && !seen.has(at)) {
    seen.add(at); out.push(at);
    at = (by.get(at).parentFolderId) || null;
  }
  return out;
}

/**
 * PURE (v1.0.61): `folderId` and every folder beneath it, the folder itself FIRST.
 *
 * The downward twin of folderAncestry. Deleting a collection must reach every disc inside
 * it (their rows AND their videos), and the search scope needs the same walk — two copies
 * would disagree exactly where it hurts. Cycle-guarded for the same reason: parentFolderId
 * is merged LWW per row across devices and can briefly point in a circle.
 */
export function folderSubtreeIds(folderId, rows = []) {
  const fid = String(folderId || '');
  if (!fid) return [];
  const kidsOf = new Map();
  for (const r of rows || []) {
    if (!r || !r.parentFolderId || !r.folderId) continue;
    if (!kidsOf.has(r.parentFolderId)) kidsOf.set(r.parentFolderId, []);
    kidsOf.get(r.parentFolderId).push(r.folderId);
  }
  const out = [];
  const seen = new Set();
  const stack = [fid];
  while (stack.length) {
    const at = stack.pop();
    if (!at || seen.has(at)) continue;
    seen.add(at); out.push(at);
    for (const k of kidsOf.get(at) || []) stack.push(k);
  }
  return out;
}

/**
 * PURE (v1.0.61): is `folderId` the locked folder or anywhere beneath it?
 *
 * A folder lock used to be an EQUALITY test in five places, which was right while folders
 * were flat. Nested, equality would lock a child into a collection's front door and then
 * refuse every disc inside it — the lock would read as broken. An unknown folder is NOT
 * contained: the lock errs strict (containment's direction since v1.0.56).
 */
export function folderWithinLock(folderId, lockFolderId, rows = []) {
  const lock = String(lockFolderId || '');
  if (!lock) return true;                       // no lock ⇒ nothing is out of bounds
  const fid = String(folderId || '');
  if (!fid) return false;
  if (fid === lock) return true;
  return folderAncestry(fid, rows).includes(lock);
}

/**
 * PURE (v1.0.61): which custom folders the HOME screen shows — the roots.
 *
 * v1.0.58 put every folder of an imported tree on the home (32 discs = 8 pages of tiles);
 * the user asked for the Drive shape instead. A child row whose parent is GONE falls back
 * to the home rather than disappearing: an older app on the same account sweeps container
 * rows it does not understand, and a disc that vanished entirely would be worse than one
 * that is merely in the wrong place (the next refresh restores the shape).
 */
export function homeFolderRows(rows = []) {
  const list = (rows || []).filter(Boolean);
  // ⚠️ TWO SHAPES REACH THIS, and only one of them was handled at first: a `customFolders`
  // DB row calls its id `folderId`, while the tile objects `buildFolders` produces — which
  // is what the home actually renders — call it `id`. Reading only `folderId` made every
  // parent lookup miss, so the filter silently kept all 32 discs on the home: the feature
  // did nothing, with a green suite. Found in the browser against the real collection.
  const idOf = (r) => r.id || r.folderId || '';
  const ids = new Set(list.map(idOf).filter(Boolean));
  return list.filter((r) => !r.parentFolderId || !ids.has(r.parentFolderId));
}

/**
 * PURE (v1.0.61): a folder screen shows its CHILD FOLDERS and its own videos in ONE paged
 * grid, folders first.
 *
 * One pager, not two: 32 discs need paging themselves, and a 5-year-old cannot be asked to
 * tell two pagers apart. `pageAnyFolder`/`nextAfter` are deliberately NOT touched — the
 * concatenation happens here, so both keep their invariant that they cover the same folder
 * kinds and neither grows a nesting branch.
 *
 * -> { folderSlots, videoOffset, videoLimit } for page `page` (0-based).
 * ⚠️ `videoLimit` may be 0 on a page filled entirely by folder tiles, and the caller must
 * still CALL `db.pageFolder` — its `total` sizes the pager. `pageFolder` answers
 * `{items: [], total}` for a zero limit (the v1.0.58 fix), which is exactly that shape.
 */
export function folderPageSlots({ childCount = 0, page = 0, pageSize = 15 } = {}) {
  const kids = Math.max(0, Number(childCount) || 0);
  const size = Math.max(1, Number(pageSize) || 1);
  const p = Math.max(0, Number(page) || 0);
  const start = p * size;
  const folderStart = Math.min(start, kids);
  const folderEnd = Math.min(start + size, kids);
  const folderSlots = Math.max(0, folderEnd - folderStart);
  return {
    folderOffset: folderStart,
    folderSlots,
    videoOffset: Math.max(0, start - kids),
    videoLimit: size - folderSlots
  };
}

/** PURE (v1.0.61): how many pages a folder screen has once its child folders are counted. */
export function folderPageTotal({ childCount = 0, videoTotal = 0, pageSize = 15 } = {}) {
  const size = Math.max(1, Number(pageSize) || 1);
  const n = Math.max(0, Number(childCount) || 0) + Math.max(0, Number(videoTotal) || 0);
  return Math.max(1, Math.ceil(n / size));
}

export function folderSearchScope({ folderId = null, customRows = [], locked = false } = {}) {
  const fid = String(folderId || '');
  if (!fid) return [];
  if (locked) return [fid];
  const rows = Array.isArray(customRows) ? customRows.filter(Boolean) : [];
  const here = rows.find((r) => r.folderId === fid);
  if (!here) return [fid];
  // v1.0.61 — the scope is the SUBTREE the child is standing in, which for a folder that
  // nests is what "and everything inside it" means (the user's request). The v1.0.58 rule
  // survives inside it: from a disc, the whole COLLECTION is searched, because the root row
  // is hidden from the child whenever it holds no songs of its own — a strictly downward
  // reading would leave the other 31 discs unreachable from anywhere.
  const chain = folderAncestry(fid, rows);
  const top = chain.length ? chain[chain.length - 1] : fid;
  const subtree = folderSubtreeIds(top, rows);
  if (subtree.length > 1) {
    // the folder the child is standing in comes FIRST: its own songs are the likeliest answer
    return [fid, ...subtree.filter((id) => id !== fid)];
  }
  const rootDriveId = here.driveRootId || here.driveFolderId;
  if (!rootDriveId) return [fid];
  const tree = rows.filter((r) => r.driveFolderId === rootDriveId || r.driveRootId === rootDriveId);
  if (tree.length <= 1) return [fid];
  // the folder the child is standing in comes FIRST: its own songs are the likeliest answer
  const ids = tree.map((r) => r.folderId).filter(Boolean);
  return [fid, ...ids.filter((id) => id !== fid)];
}

/**
 * v1.0.61 — PURE: the words of "⚙️ איך לסנכרן את הערוץ?" (user report: the button hid the
 * row and asked nothing).
 *
 * ⚠️ THE QUESTION IS THE SUBSCRIPTION MODE, NOT THE BACKLOG. The old flow asked "what do I
 * do with these N videos?" and could only be raised when N > 0 — so a channel whose queue
 * was empty (Shorts-only, a peer's row this device has not synced yet, an auto-approved
 * default, or simply a null library scope) was marked "decided" with NO dialog at all and
 * stayed on manual forever. A mode is a property of the SUBSCRIPTION and can always be
 * asked; the backlog is a consequence, and the same answer settles it.
 *
 * Three answers, and the third is a real button (the v1.0.23 rule — mapping an answer onto
 * an accidental dismiss lets a child poking the scrim decide what reaches them). "אחר כך"
 * writes NOTHING, so the row stays where the parent can find it again.
 */
export function channelSyncModeDialog({ name = '', pending = 0 } = {}) {
  const who = String(name || '').trim() || 'הערוץ';
  const n = Math.max(0, Number(pending) | 0);
  const waiting = n
    ? `יש ${n === 1 ? 'סרטון אחד שממתין' : `${n} סרטונים שממתינים`} לאישור. `
    : 'עדיין אין סרטונים שממתינים. ';
  // singular/plural written out rather than built with hebCount — that helper appends
  // "אחד" AFTER its noun, which only reads correctly when the noun phrase ends there
  const auto = !n ? 'אוטומטי: כל סרטון חדש שיעלה בערוץ ייכנס מעצמו, בלי לשאול. '
    : n === 1 ? 'אוטומטי: הוא ייכנס עכשיו, וגם כל סרטון חדש שיעלה בערוץ — בלי לשאול שוב. '
    : 'אוטומטי: הם ייכנסו עכשיו, וגם כל סרטון חדש שיעלה בערוץ — בלי לשאול שוב. ';
  const manual = !n ? 'ידני: כל סרטון חדש ימתין לאישור שלכם בלשונית "ממתינים".'
    : n === 1 ? 'ידני: תחליטו עכשיו אם להשאיר אותו, וכל סרטון חדש ימתין לאישור.'
    : 'ידני: תבחרו עכשיו אילו להשאיר, וכל סרטון חדש ימתין לאישור.';
  return {
    title: `איך לסנכרן את ${who}?`,
    text: waiting + auto + manual,
    ok: 'אוטומטי', third: 'ידני', cancel: 'אחר כך'
  };
}

/** PURE: what the parent is told after answering. A zero names itself (the v1.0.37 rule):
 *  "nothing was waiting" and "N were approved" are different facts. */
export function channelSyncModeOutcome({ auto = false, approved = 0, name = '' } = {}) {
  const who = String(name || '').trim() || 'הערוץ';
  const n = Math.max(0, Number(approved) | 0);
  if (auto) {
    return n
      ? `${who} יסונכרן אוטומטית · ${n === 1 ? 'סרטון אחד אושר' : `${n} סרטונים אושרו`}`
      : `${who} יסונכרן אוטומטית — כל סרטון חדש ייכנס מעצמו`;
  }
  return `${who} יסונכרן ידנית — כל סרטון חדש ימתין לאישור שלכם`;
}

/* ---------------- downloaded-file cache (v1.0.58) ----------------
   A video is only ever downloaded when STREAMING it failed, so most families cache
   nothing — but a family whose Drive audio streams badly can accumulate hundreds of
   files, and nothing has ever deleted one. Three rules, all decided here:
   deletion follows the record, an unused file expires, and a file nothing owns is junk. */

/**
 * PURE: which cached files to delete now.
 *
 * `files`   — what is ACTUALLY on disk: [{ name, size, mtime }] (platform.fsListDir).
 * `owned`   — Map<fileName, { usedAt }> built from the records that hold a localPath.
 *
 * THE POLICY IS PER FILE, NOT A BLANKET SWEEP (user decision 2026-08-30, and the reason is
 * the child): a monthly "delete everything" removes the one song they play daily, and the
 * tablet re-downloads it on the family's mobile data. Age is measured from the LAST PLAY,
 * so what is used survives and only what was forgotten goes.
 *
 * A file with NO record is an ORPHAN and always goes — that is the only thing that can free
 * what earlier versions leaked (a video deleted before v1.0.58 left its file behind forever).
 *
 * ⚠️ A FILE WITH NO USE STAMP IS GIVEN A FULL WINDOW, NEVER DELETED ON SIGHT. Every file
 * downloaded before this version has no `localUsedAt`, and reading "no stamp" as "never
 * used" would wipe the whole cache the first time the sweep ran — exactly the blanket
 * behaviour the decision rejected. The caller stamps them instead (`stampMissing`).
 */
export function planCacheSweep({ files = [], owned = null, now = Date.now(),
  maxAgeMs = CACHE_MAX_AGE_MS } = {}) {
  const own = owned instanceof Map ? owned : new Map(Object.entries(owned || {}));
  const del = [];
  const stampMissing = [];
  let bytes = 0;
  let orphans = 0;
  let expired = 0;
  for (const f of files || []) {
    const name = f && typeof f.name === 'string' ? f.name : '';
    if (!name) continue;
    const rec = own.get(name);
    if (!rec) {
      orphans += 1;
      del.push(name);
      bytes += Number(f.size) || 0;
      continue;
    }
    const usedAt = Number(rec.usedAt);
    if (!Number.isFinite(usedAt) || usedAt <= 0) { stampMissing.push(name); continue; }
    if (now - usedAt > maxAgeMs) {
      expired += 1;
      del.push(name);
      bytes += Number(f.size) || 0;
    }
  }
  return { delete: del, stampMissing, bytes, orphans, expired };
}

/** PURE: human bytes, for the parent's "how much is this costing me" line. */
export function formatBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '0 MB';
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
  const mb = b / (1024 * 1024);
  if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
  return (mb / 1024).toFixed(1) + ' GB';
}

/**
 * PURE: the "delete from the device too?" question (user request + decision 2026-08-30).
 *
 * ASKED ONLY WHEN THERE IS SOMETHING TO ASK ABOUT, and ONCE PER BATCH. A video that was
 * never downloaded — which is most of them, since a download only happens after streaming
 * fails — must not raise a dialog at all, and a 40-video rejection must not raise forty.
 */
export function deleteLocalChoice({ total = 0, local = 0, bytes = 0 } = {}) {
  const n = Math.max(0, Number(local) | 0);
  if (!n) return { ask: false, text: '' };
  const t = Math.max(n, Number(total) | 0);
  const size = bytes > 0 ? ` (${formatBytes(bytes)})` : '';
  const what = n === 1 ? 'קובץ אחד ירד' : `${n} קבצים ירדו`;
  const scope = t === n ? '' : ` מתוך ${t} שנמחקים`;
  return {
    ask: true,
    text: `${what}${scope} למכשיר הזה${size}. למחוק גם אותם מזיכרון המכשיר? ` +
      'הקבצים בגוגל דרייב לא ייגעו.'
  };
}

/**
 * PURE: which EMPTY custom folders to delete (user request: delete them, do not just hide
 * them as today).
 *
 * TWO EXEMPTIONS, and both are load-bearing:
 *  - A DRIVE ROOT ANCHOR (`driveFolderId` and no `driveRootId`) is empty ON PURPOSE — it is
 *    the row the refresh walks, and deleting it would silently stop a nested Drive folder
 *    from ever picking up a disc added later (the user's decision 2026-08-30: keep it).
 *  - A folder created MINUTES ago. The picker creates the row before the add finishes, and
 *    a parent who is still choosing a picture would watch their new folder vanish.
 */
export function planEmptyFolderSweep({ folders = [], counts = null, now = Date.now(),
  graceMs = EMPTY_FOLDER_GRACE_MS } = {}) {
  const by = counts instanceof Map ? counts : new Map(Object.entries(counts || {}));
  const kids = new Set();
  for (const f of folders || []) if (f && f.parentFolderId) kids.add(f.parentFolderId);
  const out = [];
  for (const f of folders || []) {
    if (!f || !f.folderId) continue;
    if ((Number(by.get(f.folderId)) || 0) > 0) continue;
    // v1.0.61 — A FOLDER THAT HOLDS FOLDERS IS NOT EMPTY. With the tree nested, the row the
    // parent taps to reach 32 discs holds no songs of its OWN, and sweeping it would delete
    // the whole collection's front door (its children survive, unreachable from the home).
    if (kids.has(f.folderId)) continue;
    // ⚠️ ANY Drive-backed row is exempt, not just the root anchor. The 30-minute refresh
    // re-creates whatever it finds in Drive, so a swept descendant comes straight back with
    // a NEW folderId — the sweep and the refresh would write a tombstone and mint a row
    // against each other forever, against the Drive document, on every device.
    if (f.driveFolderId) continue;
    const born = Number(f.createdAt) || Number(f.order) || 0;
    if (born && now - born < graceMs) continue;           // the parent is still working
    out.push(f.folderId);
  }
  return out;
}

/* ---------------- containment lock (v1.0.56) ----------------
   The parent locks the child INTO the app, or into ONE folder, with an optional timer.
   Entering and leaving both cost the parent code. DEVICE-LOCAL state (Preferences), like
   the scheduled break: a lock is about the tablet in the child's hands, and syncing
   "locked until X" would lock a sibling's device too. */

// v1.0.67 — two more containment modes, both about the websites surface (user request):
//   'sites' — the child is held on the websites SCREEN. They may open any approved site and
//             come back, but not return to the videos and not leave the app. The exact
//             sibling of 'folder', one surface over.
//   'site'  — the child is held INSIDE one site. They browse it as usual; the viewer will
//             not close, and the navigation rules narrow to that site alone.
export const CONTAIN_MODES = ['app', 'folder', 'sites', 'site'];

/**
 * PURE: is a containment lock active, and what does it hold?
 *
 *  - `until === 0` means UNTIL THE PARENT RELEASES IT (the user's "0" — an explicit,
 *    deliberate value, never a fallback for junk);
 *  - an unknown mode, or folder mode with no folder, is NOT a lock. Failing OPEN here is
 *    deliberate and is the opposite of the exit-lock's direction: this state is written by
 *    one device and read on every render, so a corrupted value must not strand a child
 *    behind a lock nobody can identify — while the KIOSK (exitLock) is unaffected and
 *    still contains them.
 * -> { active, mode, folderId, msLeft, expired }
 */
export function evalContainment({ now = Date.now(), mode = null, folderId = null, siteUrl = null, siteGrain = null, until = 0 } = {}) {
  const off = { active: false, mode: null, folderId: null, siteUrl: null, siteGrain: null, msLeft: 0, expired: false };
  const m = CONTAIN_MODES.includes(mode) ? mode : null;
  if (!m) return off;
  const fid = typeof folderId === 'string' && folderId ? folderId : null;
  if (m === 'folder' && !fid) return off;
  // v1.0.67 — a 'site' lock is meaningless without the site, exactly as 'folder' is without
  // the folder: an active-but-targetless lock would hold the child somewhere undefined.
  const su = typeof siteUrl === 'string' && /^https:/i.test(siteUrl) ? siteUrl : null;
  if (m === 'site' && !su) return off;
  const u = Number(until) || 0;
  if (u > 0 && now >= u) return { ...off, expired: true };
  // v1.0.76 — a 'site' lock has a GRAIN: 'prefix' holds the child on the locked page's URL
  // prefix (feature 4), 'host' (the default, and the v1.0.67 behaviour) on the whole site.
  // Any value but 'prefix' reads as 'host' — an unwritten or corrupted grain must fall back
  // to the WIDER, already-shipped behaviour, never silently pin a child onto one page.
  const grain = m === 'site' ? (siteGrain === 'prefix' ? 'prefix' : 'host') : null;
  return { active: true, mode: m, folderId: m === 'folder' ? fid : null,
    siteUrl: m === 'site' ? su : null, siteGrain: grain, msLeft: u > 0 ? u - now : 0, expired: false };
}

/**
 * PURE: what the child's chrome looks like under a containment lock.
 *
 * `hideExit` is OR-ed with the kiosk elsewhere — this helper answers only what CONTAINMENT
 * requires, so the two features cannot silently cancel each other out. The padlock itself
 * is always visible: it is the parent's only way back in, and a child who taps it meets
 * the code screen.
 */
export function containmentChrome({ active = false, mode = null, atLockFolder = true } = {}) {
  if (!active) {
    return { hideExit: false, hideChip: false, hideHome: false, hideSites: false, locked: false };
  }
  return {
    hideExit: true,                 // the child may not leave the app
    hideChip: true,                 // …nor switch to a sibling's profile
    // folder mode: no way out of THIS folder. v1.0.61 — but a lock now covers a SUBTREE,
    // and a child standing inside a disc of a locked collection needs a way back up to the
    // disc list; hiding the button there would leave them with only the hardware back,
    // which in immersive mode costs an edge swipe. So it is hidden only AT the lock's own
    // folder, where it would genuinely be a way out. `atLockFolder` defaults TRUE so a
    // caller that does not know its position gets the strict answer (the containment rule).
    hideHome: (mode === 'folder' && atLockFolder !== false) || mode === 'sites',
    // v1.0.67 — under a SITES lock the websites screen IS where the child lives, so its 🏠
    // (which returns to the videos) goes away; under a FOLDER lock the launcher itself was
    // already hidden, because a website reaches outside the folder entirely.
    hideSites: mode === 'folder',
    locked: true
  };
}

/**
 * v1.0.76 — PURE: what a padlock tap does when a lock is ALREADY active.
 *
 * The reported bug: with a lock active, EVERY padlock tap was release-only (an early
 * return), so a parent who had locked a site and then wanted to lock the app — or just
 * change the duration — could never reach the "how long?" dialog. It only ever appeared on
 * the FIRST lock. The fix is a choice after the code: release, or re-lock with a fresh
 * duration (the user's decision 2026-09-06).
 *
 * This maps the dialog answer. 'ok' is the primary button = RELEASE (the common intent when
 * a 🔒 is showing); 'third' = RE-LOCK (the path that did not exist); anything else — cancel,
 * scrim dismiss — leaves the lock exactly as it was. Pinning the ok/third mapping here stops
 * a silent inversion (swapping the two buttons would hand a child a release where the parent
 * meant to re-lock).
 */
export function relockChoice(answer) {
  if (answer === 'ok') return 'release';
  if (answer === 'third') return 'relock';
  return 'none';
}

/**
 * v1.0.76 — PURE: which GRAIN of site lock the parent chose (user request: "כל האתר / רק
 * הדף"). A site lock holds the child on the whole approved SITE (host); a page lock holds
 * them on ONE page's URL-prefix and its sub-pages. 'ok' (the primary button) = the whole
 * site — the v1.0.67 behaviour, the safe default when a parent is unsure; 'third' = just
 * this page (the prefix); anything else = they backed out, engage nothing.
 *
 * Returns the `siteGrain` value stored on the lock: 'host' | 'prefix' | null. Pinning the
 * mapping here stops a silent inversion (locking a child onto one page when the parent meant
 * the whole site, or vice versa).
 */
export function siteLockGrain(answer) {
  if (answer === 'ok') return 'host';
  if (answer === 'third') return 'prefix';
  return null;
}

/**
 * PURE: minutes for a new lock. 0 is a real answer ("until I unlock it"), so it must
 * survive; anything unusable falls back to the remembered value and then to 0 — the
 * planRejectedPurge rule (a typo must never invent a short lock the parent did not ask
 * for, nor a long one). Capped at 12h: past that "until I unlock" is the honest choice.
 */
export const CONTAIN_MAX_MIN = 720;
export function normalizeLockMinutes(value, fallback = 0) {
  // ⚠️ THE UNSET CHECK PRECEDES THE COERCION — `Number(null)` and `Number('')` are both 0,
  // and 0 is a MEANINGFUL answer here ("until I unlock it"). Coercing first turns a
  // never-written value into an explicit "lock forever" and silently discards the
  // remembered default. The same trap plan.screenOffMinutes documents.
  const unset = (v) => v === null || v === undefined || v === '' ||
    (typeof v === 'number' && !Number.isFinite(v)) || typeof v === 'object';
  const clamp = (n) => Math.min(Math.floor(n), CONTAIN_MAX_MIN);
  if (!unset(value)) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return clamp(n);
  }
  if (!unset(fallback)) {
    const f = Number(fallback);
    if (Number.isFinite(f) && f >= 0) return clamp(f);
  }
  return 0;
}

/**
 * PURE: the sentence under the padlock dialog — it must say what the child will lose.
 *
 * v1.0.76 — a site lock now has two grains: 'host' holds the child on the whole approved
 * site, 'prefix' (a page lock, feature 4) on the locked page and its sub-pages. `siteLabel`
 * is the human name of the site/page, shown so the parent knows exactly what they are pinning.
 */
export function containConfirmText({ mode = 'app', folderTitle = '', minutes = 0, siteGrain = 'host', siteLabel = '' } = {}) {
  let what;
  if (mode === 'folder') {
    what = `הילד/ה יוכל/תוכל לצפות רק בתיקיה "${folderTitle || 'הנוכחית'}"`;
  } else if (mode === 'site') {
    what = siteGrain === 'prefix'
      ? `הילד/ה יוכל/תוכל לגלוש רק בדף ${siteLabel || 'הזה'} ובדפים שבתוכו`
      : `הילד/ה יוכל/תוכל לגלוש רק באתר ${siteLabel || 'הזה'}`;
  } else if (mode === 'sites') {
    what = 'הילד/ה יוכל/תוכל לגלוש רק באתרים המאושרים';
  } else {
    what = 'הילד/ה יוכל/תוכל לצפות בכל התיקיות';
  }
  const how = minutes > 0
    ? `הנעילה תשתחרר לבד אחרי ${minutes} דקות, או קודם עם קוד ההורים.`
    : 'הנעילה תישאר עד שתשחררו אותה עם קוד ההורים.';
  // a site/page lock does not hide the folders, but it DOES prevent leaving the app
  return `${what}, ולא תהיה אפשרות לצאת מהאפליקציה או להחליף פרופיל. ${how}`;
}

/** PURE: the countdown label for a running containment lock ('' when it has no end). */
export function containCountdownLabel(msLeft) {
  const ms = Number(msLeft) || 0;
  if (ms <= 0) return '';
  const total = Math.ceil(ms / 60000);
  if (total < 60) return `${total} דק׳`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} ש׳ ${m} דק׳` : `${h} ש׳`;
}
