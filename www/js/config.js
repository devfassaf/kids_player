// config.js — app-wide constants. No imports, no I/O.

/* Page sizes (grid layouts are 3 columns) */
export const PAGE_FOLDERS = 6;   // home: 3×2, must never scroll
export const PAGE_VIDEOS = 15;   // folder grid: 3×5 (matches the original gallery)
export const PAGE_WATCH = 6;     // under the player: 3×2, one flick to see all

/* Player HUD (F1) */
export const HUD_HIDE_MS = 3000;     // controls auto-hide after 3s while playing
export const SEEK_STEP = 10;         // double-tap seek, seconds (YouTube muscle memory)
// INVARIANT: TAP_SINGLE_DELAY >= TAP_DOUBLE_MS, or a slow double-tap both pauses AND seeks.
export const TAP_DOUBLE_MS = 260;
export const TAP_SINGLE_DELAY = 280;
// v1.0.52 — a "tap" is a press that did not MOVE. The shield acts on pointerup with no
// threshold, so any swipe that ended over it (horizontal ones, and every swipe while
// fullscreen, where there is nothing to scroll and the browser never claims the gesture)
// read as a tap — and a center release PAUSED the video. Big enough for a child's wobbly
// finger (~2mm), far below a deliberate swipe.
export const TAP_SLOP_PX = 14;

/* Swipe paging (v1.0.57) — a flick left/right turns a page of tiles, next to the arrows.
   INVARIANT: SWIPE_MIN_PX > TAP_SLOP_PX, and by a wide margin. The two gestures share
   every surface (a tile is a <button>), so a travel that reads as a tap must never also
   read as a swipe. SWIPE_RATIO is what keeps a VERTICAL scroll from turning pages: the
   page scrolls under the same finger, and a scroll that drifts sideways is still a scroll.
   SWIPE_MAX_MS IS A SANITY CEILING, NOT A FLICK DETECTOR, and the difference was measured
   (2026-08-30, browser): the first version used 900ms on the theory that "a page turn is a
   flick" — and refused real swipes. The app cannot track a drag live (it flips on release),
   so DISTANCE is the whole "did you mean it" test; a 5-year-old dragging deliberately and
   slowly across a tablet is a page turn, not a mistake. What the ceiling still catches is a
   finger PARKED on the screen for seconds that then wanders off a tile — reversible either
   way, which is why erring long is the safe direction here. */
export const SWIPE_MIN_PX = 56;   // horizontal travel that counts as a deliberate swipe
export const SWIPE_MAX_MS = 2500; // beyond this the finger was resting, not swiping
export const SWIPE_RATIO = 1.4;   // |dx| must beat |dy| by this much to be "horizontal"

/* v1.0.62 — THE PAGE NOW FOLLOWS THE FINGER (user request: "משוב, על ידי הזזת הדף ביחס
   להזזת האצבע, למשתמש לדעת שהוא מזיז את הדף לדף הבא"). The neighbouring page is rendered
   beside the current one and both translate together, so the child SEES where they are
   going instead of guessing.

   ⚠️ SWIPE_ARM_PX > TAP_SLOP_PX IS THE SAME INVARIANT SWIPE_MIN_PX CARRIES, one step
   earlier and stricter in its consequence: this is the travel at which the grid starts to
   MOVE, so a value at or below the tap slop would make every tap on a tile visibly nudge
   the screen. It also has to clear the noise of a finger settling before a vertical scroll,
   which is why the ratio test is applied at the same moment (a scroll that drifts sideways
   must never arm a drag — the v1.0.52 collision, now visible while it happens).

   THE COMMIT IS RELATIVE, NOT ABSOLUTE (the user's decision 2026-08-30). With live feedback
   the honest rule is "what you see is what happens": past a third of the width the next page
   is already more than half-revealed, so releasing there must complete the turn. SWIPE_MIN_PX
   stays as the floor for the FALLBACK path (a gesture that never armed a live drag), which
   is why both constants exist.

   THE RUBBER-BAND is what the first/last page answers with (the user's decision): the page
   gives a little and springs back, which says "there is nothing that way" without the screen
   reading as frozen. Its cap is a FRACTION of the width, not a pixel count, so a phone and a
   tablet feel the same. */
/* v1.0.66 — the biggest picture worth sending to the playback notification. It crosses the
   bridge as base64 (≈1.33x the bytes) on every track change, and the system draws it at
   roughly 128dp — so a multi-megabyte frame would be paid for in full and thrown away. */
export const BG_ART_MAX_BYTES = 512 * 1024;

export const SWIPE_ARM_PX = 18;          // travel before the grid starts to move (> TAP_SLOP_PX)
export const SWIPE_COMMIT_RATIO = 0.33;  // release past this fraction of the width ⇒ turn
export const SWIPE_RUBBER = 0.35;        // resistance factor when there is no page that way
export const SWIPE_RUBBER_MAX = 0.12;    // …and never further than this fraction of the width
export const SWIPE_SNAP_MS = 220;        // the settle animation, both for a turn and a spring-back

/* Continuous play (v1.0.25) — OFF by default, per profile, synced.
   The countdown is the child's only visible way out of a chain: it must be long enough
   for a 5-year-old to notice the screen changed and reach the stop button, and short
   enough not to feel like the video froze. */
export const AUTOPLAY_COUNTDOWN_MS = 5000;
export const AUTOPLAY_RETRY_MS = 4000;   // one retry of the SAME video before moving on
// INVARIANT: a chain must be able to END. Without a ceiling, a library with a run of
// unplayable videos would flip through black screens indefinitely.
export const AUTOPLAY_MAX_FAILURES = 5;

/* Resume playback (v1.0.32) — OFF by default, per profile, synced. The POSITION itself is
   DEVICE-LOCAL and never serialized to Drive: it changes every few seconds of watching,
   and pushing that churn would rewrite the family document on every pause (the giftRank
   lesson — see drive.serializeStateEntry). */
export const RESUME_REWIND_SEC = 3;   // resume this much before the stop point (user-specified)
export const RESUME_MIN_POS_SEC = 8;  // a stop earlier than this is not worth resuming
export const RESUME_TAIL_SEC = 12;    // a stop this close to the end = finished → start over
export const RESUME_SAVE_MS = 5000;   // periodic save while playing (survives a process kill)

/* v1.0.57 — A CALL INTERRUPTS THE VIDEO; WHEN IT ENDS THE VIDEO CARRIES ON (user request).
   CALLS ONLY (user decision 2026-08-30): every other pause — the power button, HOME, the
   app switcher, the child's own tap — keeps the v1.0.32 behaviour, where the video waits
   paused and the child presses play. */
// How often to look while a resume is armed. Fast enough that "the call ended and the video
// came back" reads as automatic, and it runs ONLY while a paused video is waiting on a call
// — never as a background heartbeat.
export const CALL_RESUME_POLL_MS = 1500;
// After this the call is no longer "the thing that just interrupted us": the tablet has sat
// on a paused video for a quarter of an hour, whoever was watching has moved on, and
// starting it then would be a surprise noise in the room rather than a convenience.
export const CALL_RESUME_MAX_MS = 15 * 60 * 1000;

/* v1.0.58 — a pasted Drive folder may hold FOLDERS of songs (user request), so the import
   walks the tree to any depth. These are the safety ceilings, not expectations: the folder
   that prompted the feature is 33 folders / ~480 files, and the point of a bound is that a
   backup folder pasted by mistake cannot pull thousands of files or spend hundreds of
   requests. Hitting one is SAID, never silent (the v1.0.37 rule) — the parent is told the
   folder was too big rather than left wondering what is missing. */
export const DRIVE_TREE_MAX_FOLDERS = 100;
export const DRIVE_TREE_MAX_FILES = 2000;

/* v1.0.58 — THE DOWNLOADED-FILE CACHE. A file is only ever downloaded when streaming it
   failed, so most families cache nothing; a family whose Drive audio streams badly can
   accumulate hundreds of files, and until now nothing ever deleted one.
   PER FILE, measured from the LAST PLAY (user decision 2026-08-30, choosing it over a
   blanket monthly wipe): a blanket sweep deletes the one song the child plays every day and
   the tablet re-downloads it on mobile data, while an unused file is exactly what should go. */
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHE_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000; // the sweep itself runs at most daily

/* v1.0.58 — an EMPTY folder is DELETED now, not just hidden (user request). The grace window
   exists because the destination picker creates the row BEFORE the add finishes: without it a
   parent choosing a picture for the folder they just made would watch it disappear. */
export const EMPTY_FOLDER_GRACE_MS = 10 * 60 * 1000;

/* v1.0.58 — SEARCH INSIDE A FOLDER (user request). The scope is the folder plus every
   folder nested with it.
   ⚠️ v1.0.61 CHANGED WHAT THAT MEANS. This comment used to end "nothing else nests; the app
   has no folder-in-folder screen and deliberately gains none" — true then, false now: an
   imported Drive tree nests for real (`parentFolderId`) and the scope is the SUBTREE, via
   pure `folderSubtreeIds`. The v1.0.58 rule survives inside it: standing in a disc searches
   the whole collection, because the root row is hidden from the child whenever it holds no
   songs of its own.
   The caps bound the read, not the answer: an imported collection is ~750 files today, and
   a folder search must never turn into loading a family's whole library into memory. */
export const FOLDER_SEARCH_MAX_PER_FOLDER = 2000;
export const FOLDER_SEARCH_MAX_TOTAL = 6000;

/* Rejected archive (v1.0.26) — a rejection is recoverable for this long, then the record
   is permanently deleted (delete + deny tombstone, exactly what "מחק לצמיתות" does).
   Long enough that a parent who changes their mind has a real window; short enough that
   the archive does not become a second library nobody prunes. */
export const REJECTED_TTL_DAYS = 30;

// v1.0.26 — how long a parent who forgot the code waits before it can be reset.
// Long enough that a child will not sit through it, short enough that a locked-out parent
// gets back in the next day. The wait is the UNIVERSAL path: it needs no device lock, no
// permission and no network, so it also covers Android TV and the many children's tablets
// that have no lock screen at all.
export const PIN_RECOVERY_DELAY_HOURS = 24;

// v1.0.31 — scheduled per-profile lock ("time to do something else"). Both are PER PROFILE
// and SYNCED. `AFTER` 0 = the feature is off for that child (the default). A nonsense
// DURATION falls back to this default rather than to 0 (a 0 would unlock instantly).
export const SCHED_LOCK_DEFAULT_DURATION_MIN = 20;

// v1.0.34 — idle screen-off. After this many minutes with NO touch/key while a video
// plays, the "עדיין צופים?" prompt shows; unanswered, the video pauses and keep-awake is
// released so the DEVICE's own display timeout can turn the screen off (an app cannot do
// that itself). DEFAULT IS ON at 10 (the user's decision — protects the panel and the
// battery when a child falls asleep mid-video); an explicit 0 = never, today's behavior.
export const SCREEN_OFF_DEFAULT_MIN = 10;
export const SCREEN_OFF_PROMPT_SEC = 45;


/* v1.0.57 — 🕒 "נצפה לאחרונה": the last N videos this child watched, in their own folder at
   the top of the home, IN ADDITION to wherever the video really lives (user request).
   Per profile, SYNCED (the number is a parenting choice); the WATCH STAMPS THEMSELVES ARE
   DEVICE-LOCAL, exactly like the resume position and for the same reason — "what was
   watched here" is about the tablet in the child's hands, and pushing a timestamp per
   video watched would rewrite the family document all afternoon (user decision 2026-08-30).
   ⚠️ DEFAULT IS ON at 10, so this arrives with the update for every existing family — the
   SCREEN_OFF_DEFAULT_MIN precedent, and it must ride the release notes the same way. */
export const RECENT_DEFAULT_LIMIT = 10;
export const RECENT_MAX_LIMIT = 50;   // beyond this the folder stops being a shortcut
// A video counts as WATCHED after this many seconds of playback (user decision): a child's
// mistaken tap, or a two-second peek, must not evict something they actually watched from a
// 10-slot folder. A video that ENDS counts regardless — a 6-second clip can never reach it.
export const RECENT_MIN_PLAY_SEC = 10;

/* v1.0.39 — ROLLING WINDOW: keep only the newest N videos per channel.
   0 = OFF, and OFF IS THE DEFAULT. This is the only feature in the app that deletes the
   CHILD'S content, so it may never arrive with an update: a family that never opens the
   settings screen keeps every video it has. When it IS on, the sync still deletes nothing
   on its own — it only proposes, and the parent reviews per channel (the user's decision
   2026-08-09: "tell me which channel, let me mark what not to delete, or wipe it and keep
   only new ones"). */
// The number the parent is POINTED AT when they type something unusable (a mistyped `1`
// reads as off, and an "off" message with no way forward is a dead end). It has a live
// consumer for the reason v1.0.37 exists: a constant nobody reads is a lie.
export const KEEP_NEWEST_SUGGESTED = 200;
// The review screen renders at most this many rows. A channel 4000 videos over the window
// would otherwise build 4000 thumbnails and read as a frozen app; the rows shown are the
// NEWEST of those proposed, i.e. the ones a parent is most likely to want to keep.
export const PRUNE_REVIEW_CAP = 200;

/* Sync */
// v1.0.37 — THESE ARE THE LIVE CAPS NOW. They existed here since the overhaul with
// ZERO consumers: the binding values were literals frozen into each profile's `sources`
// row at creation, so editing this file changed nothing and no parent could ever raise
// them. `plan.effectiveCaps` reads them as the FLOOR, which is what heals the profiles
// already carrying the old 5000.
export const MAX_ITEMS_PER_CHANNEL = 500;
// Raised 5000 → 12000 on a MEASUREMENT (2026-08-08, browser, real records): the only
// cost that grows with library size is `loadMergeIndex` — 114ms @5000, 229ms @10000,
// 468ms @20000 — and it is paid once per write-generation, not per render (the
// buildFolders cache, v1.0.20). Paging stayed FLAT (2.8ms → 7.2ms) because it is
// index-ranged. 12000 holds ~24 channels at the per-channel cap with headroom, and
// stays near a second even on a tablet several times slower than the measuring machine.
// The parent had 16 channels and a silent ceiling; that is the bug this number fixes.
export const MAX_ITEMS_TOTAL = 12000;
export const QUOTA_DAILY_SOFT_CAP = 8000; // pause backfill before a hard 403

/*
 * Hybrid YouTube Data API key (decision 23): a baked-in default ships in the APK so
 * the family gets full channel history with zero setup; the parent screen can override
 * it (Preferences 'yt:apiKey' wins). The key itself is NOT committed — the repo is
 * public. It lives in the gitignored www/js/keys.local.js, resolved via keys.js.
 * NEVER serialize it into the Drive DB or the Sheet mirror.
 */

/* Profile avatars (moved from app.js) */
export const AVATARS = [
  { e: '🦁', c: '#ffd166' }, { e: '🐼', c: '#cdd6ea' }, { e: '🐰', c: '#ffc9de' },
  { e: '🦊', c: '#ffb37a' }, { e: '🐸', c: '#b8e994' }, { e: '🐵', c: '#e6c79c' },
  { e: '🐯', c: '#ffcf6b' }, { e: '🦄', c: '#e4c1f9' }, { e: '🐙', c: '#ff9aa2' },
  { e: '🐧', c: '#a0c4ff' }, { e: '🐨', c: '#d7d7d7' }, { e: '🐬', c: '#8fd0e0' }
];

/** v1.0.45 — how long the add flow waits for a site to answer before giving up on its
 *  title and icon. The address is still addable; only the niceties are skipped. Without
 *  a bound a hanging host leaves the parent on "בודקים את הכתובת…" with no way out. */
export const SITE_PROBE_TIMEOUT_MS = 8000;

/** v1.0.76 — the most tiles the PiP window's ⏮/⏭ track walks (one pageAnyFolder read,
 *  built lazily on PiP entry). The v1.0.63 BG_TRACK_MAX precedent: the track is the ORDER
 *  THE CHILD IS LOOKING AT, frozen once, and a floating window does not need more than a
 *  couple of hundred reachable tiles — an unbounded read is a whole-library deserialize
 *  on a low-end tablet. */
export const PIP_TRACK_MAX = 200;
