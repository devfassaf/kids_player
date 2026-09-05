# CLAUDE.md — kids_player

Child-safe, parent-curated YouTube/video player for a ~5-year-old on an Android tablet.
**Vanilla JS ES modules (NO framework, NO bundler) + Capacitor 6.** UI is RTL Hebrew
(`<html dir="rtl">`). `www/` is the whole app; `android/` is committed and carries
hand-maintained native code. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the module map
and data model before touching sync/db/player code.

## Commands

```bash
npm run serve        # dev server http://localhost:5173 (fixed port, no-store, /__proxy CORS helper)
npm test             # node:test suite (~519 tests) — MUST stay green; pure logic only, no DOM
npm run apk          # cap copy + DEBUG apk → installs as com.assaf.kidsplayer.DEV (never collides with release)
npm run apk:release  # cap copy + SIGNED release apk (fails loudly if ~/.keystores/kids-player.properties missing)
npm run apk:verify   # apksigner — mandatory before publishing anything
```

Release/versioning/publishing: [PUBLISHING.md](PUBLISHING.md) + [INSTALL_AND_RELEASE.md](INSTALL_AND_RELEASE.md).
Version single source of truth = `package.json "version"` (gradle + JS derive from it).

## Hard invariants — breaking any of these is a regression

**Player ([www/js/player.js](www/js/player.js)):**
- `stop()` tears down and NEVER calls `onExit`; only `finish()` may (switching videos breaks otherwise).
- `setupHud()` binds `window` listeners — never run it twice without `teardown()`.
- The YouTube→YouTube reuse path (`loadVideoById`) must not recreate the iframe/HUD; it swaps the
  mutable `cb` so `finish()` never fires a stale `onExit`. Near-end poll guarded by
  `Date.now()-swapAt>1200 && currentTime>0.5`.
- `TAP_SINGLE_DELAY >= TAP_DOUBLE_MS` (config.js) or a slow double-tap both pauses AND seeks.
  The single-tap branch must ALSO `clearTimeout(tapTimer)` first: two taps in the 20ms gap
  between the two constants armed TWO toggles, so a deliberate double-tap paused and
  instantly resumed (v1.0.22).
- The pure decisions live in [playerlogic.js](www/js/playerlogic.js) (imports only config.js)
  and are node-tested — player.js itself is untestable DOM. **`clampSeek` on EVERY seek**
  (touch, drag and TV remote): an unclamped forward seek runs past the end, YouTube fires
  ENDED → `finish()` → `onExit`, so pressing ⏩ near the end EJECTED the child from the
  video. `shouldFinishNearEnd` also compares the player's REPORTED video id against the
  expected one — the wall-clock swap grace alone is a bet on network latency, and a slow
  `loadVideoById` made the poll read the previous video's tail.
- `pointercancel` MUST be bound next to `pointerup`: the seek bar sits in Android's bottom
  gesture inset, so the OS routinely steals the drag and no `pointerup` arrives. `dragging`
  then stayed true forever and every later pointermove anywhere seeked the video (v1.0.22).
- `loadYouTubeApi()` must be able to FAIL and be retried (onerror + timeout, and a rejected
  attempt is not cached). It used to cache a promise with no reject, so one offline tap left
  every YouTube video dead — black player, stale HUD, no status — until the app was killed.
- The YT `onError` timer is CANCELLABLE and re-checks `swapAt`. `reuse()` deliberately leaves
  `torn === false`, so video A's 400ms error timer used to destroy the iframe playing B.
- `playFile` takes the same `playSeq` token as `playYouTube`: `prepareStreamSrc` awaits a
  native bridge, and a tap during it detached the `<video>` while it kept decoding audio —
  two soundtracks that nothing could stop, because `current` no longer referenced it.
- A held TV-remote key must NOT scrub (`e.repeat` → reveal only). Android TV repeats at
  ~30/s and each event was a full ±10s seek: one second jumped ~4 minutes and could run
  past the end, ejecting the child.
- HUD bar CONTAINERS are `pointer-events:none` ALWAYS (only buttons/seek take events, only while
  `.hud-on`) — interactive bars swallow the center-tap/double-tap on small players.
- Tap model: hidden→tap only reveals; visible→center-50% tap toggles play. Paused pins the HUD.
  **A tap is a press that did not MOVE** (v1.0.52, `playerlogic.isTapGesture`, `TAP_SLOP_PX`):
  `onTap` fires on pointerup with no threshold, so a swipe releasing over the shield used to
  read as a tap and a center release PAUSED the video. And the shield is
  **`touch-action: pan-y`, NEVER `none`** — in LANDSCAPE the player is most of the viewport,
  so `none` meant the surface a finger naturally swipes could not scroll the page at all
  ("יוצאים ממסך מלא ואי אפשר לגלול", the bug v1.0.50/51 could not fix because the document
  COULD scroll, just not from there). Both invariant-pinned.
- A video that ENDS calls `leaveWatch()` (v1.0.16): exit fullscreen, then `nav.back()` —
  the child returns to the FOLDER / search results they came from, never unconditionally
  home (`goGallery()` there was the bug). Works after video→video switches too because
  `openWatch` uses `nav.replace` while watching, so the entry below stays the folder.
- The app runs in game-style IMMERSIVE mode always (v1.0.16, MainActivity
  `applyImmersive()` + re-applied in `onWindowFocusChanged`): system bars hidden,
  `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` reveals them on an edge swipe. CSS keeps a
  minimum top padding (`calc(16px + env(safe-area-inset-top))`) so content never hugs
  the bezel when the insets report 0.
- Auto-fullscreen on tile tap: `enterPlayerFullscreen()` runs SYNCHRONOUSLY inside the tap
  gesture (an await first may void the user activation). 🏠 lives OUTSIDE the player
  (`.watch-top`, top-right) — deliberate: home requires exiting fullscreen first (v1.0.2).
- The app rotates freely (no manifest screenOrientation since v1.0.2) — portrait tweaks live in
  the 560px media query; check both orientations when touching layout.

**Data ([www/js/db.js](www/js/db.js), [plan.js](www/js/plan.js), [sync2.js](www/js/sync2.js)):**
- `classifyLink` in [classify.js](www/js/classify.js) is THE safety boundary — every link entering
  storage passes through it, including snapshot import and share intents. Never bypass.
- `loadMergeIndex` returns FULL records. A partial projection silently strips type/id/url from
  merged records (real bug once).
- Pending records are PARKED in `folderId:'~pending'` (kid folder queries must never see them);
  approval restores `homeFolderId`.
- **THERE ARE THREE CURATION STATES, AND 'rejected' IS NOT A DELETION** (v1.0.23).
  `normalize.PARKED` names both parking slots (`~pending`, `~rejected`) — a record the child
  must not see is moved OUT of its real folder, because `by_folder_sort` has no state
  component and state alone would not hide it. `db.rejectPending` now PARKS instead of
  calling `deleteVideo`: the record survives, no tombstone is written, and the parent can
  pull it back from the rejected list (`db.restoreRejected` → pending). The old behaviour was
  unappealable — `deleteVideo` erased the row AND wrote a deny tombstone whose only undeny
  path is a sheet re-add, and a video inside a channel has no sheet row at all.
  `db.purgeRejected` ("מחק לצמיתות") is the ONLY destructive step and it is the old path:
  delete + tombstone, so it travels to every device. Neither soft-reject nor purge writes
  `# הוסר` sheet rows — a removal row denies the key everywhere forever (defeating restore),
  and bulk rows wreck the sheet (the same reason bulk reject-all never wrote them).
- **A REJECTION MUST SURVIVE EVERY LATER SYNC.** A channel video is re-offered by the RSS
  pass every 30 minutes and by every backfill page, so anything that forgets the rejection
  hands the child back exactly what the parent threw out. Two layers, both deliberate:
  `normalize.resolveCuration` (pure) decides curation for any two copies of one video — **the
  LATER parental decision wins**, `pending` is never a decision, and a tie resolves to
  `'rejected'` (hiding a wanted video is a complaint; showing a rejected one is a betrayal);
  and `plan.planMutations`' prior branch pins `prior.state` for pending/rejected. The pure
  helper is the mechanism — the plan.js line is a second layer and no test fails without it
  (its own comment says so; do not read it as load-bearing).
- `mergeVideoRecord` no longer promotes with "a live loser beats a pending survivor" — it
  delegates to `resolveCuration`, so a peer's stale `live` copy cannot revive a rejection
  that happened later on another device.
- **APPROVAL IS DECIDED BEFORE ANY MERGE, AND A MERGE MAY NEVER GRANT IT** (v1.0.22).
  `base.state` in `planMutations` defaulted to `'live'` and the `quarantine || !autoApprove`
  routing lived only in the brand-new branch at the bottom — so the titleTwin branch
  short-circuited past it with a spurious `'live'`, and `mergeVideoRecord` promotes a
  pending survivor when the LOSER is live. A channel added in the parent screen is
  `autoApprove:false`, so a same-titled twin arriving in the SAME run AUTO-APPROVED a video
  the parent had never seen: live in the child's folder with `approvedAt` still null. Found
  in the field on @rotemama4kids — its 109-video backfill contained exactly 2 such twins,
  and those 2 were the ONLY videos the child could see (the parent read that as "the app
  imported 2 videos"). Both merge branches now go through pure `settleCuration`, which also
  closes the mirror-image hole: `mergeVideoRecord` flips `state` but never `folderId`, so a
  legitimately promoted record used to stay parked in `'~pending'` — invisible in the child's
  folder AND absent from the approval queue. `settleCuration` lives in
  [normalize.js](www/js/normalize.js) next to the merge it repairs, because BOTH callers of
  that merge need it: `plan.planMutations` and `drive.applyRemoteDoc` — a peer's approval
  arriving over the Drive doc hits the identical promotion.
- **SHARED STATE TRAVELS BOTH WAYS** (v1.0.22). The app scheduled a PUSH on every mutation
  but called `pullDrive` from exactly three places — the first-launch Google connect,
  profile creation, and the enable-backup button. Neither app launch, nor profile entry, nor
  `syncLibrary`, nor the parent's 🔄 ever pulled, so an approval made on the phone reached
  Drive and SAT there: the tablet had no code path that read it, and one profile showed a
  different library on every device. `app.maybePullDrive()` now pulls on profile activation
  (which covers every launch — a launch ends in one) and on resume from the background.
  It is SILENT, best-effort, throttled (60s), and shares its in-flight promise so two
  callers cannot pop two pulls. It reports whether anything CHANGED via the
  `db.dataVersion()` write counter, so a render only happens when there is something new.
  **The pull and the sheet sync are SERIALIZED** (`pullThenSync`): both write the same video
  records, and interleaving them would let one clobber the other's merge.
- **`libraryChannels.updatedAt` IS STAMPED INSIDE `db.putLibraryChannel`**, not at the nine
  call sites (v1.0.22). That row carries `autoApprove` = "the parent approved this whole
  channel", and `drive.mergeLibraryChannel` resolves two devices by that timestamp. Nobody
  set it, so both sides compared `0 > 0`, the FIRST document won, and `merge(A,B)` answered
  `true` where `merge(B,A)` answered `false` — provably order-dependent, i.e. the documented
  commutativity invariant was false for this field. The suite missed it because the fixtures
  carry timestamps: **it pinned the fixture, not the production path.** On an exact tie
  (two legacy rows) the tie-break is the SAFE direction — the row still requiring approval
  wins — which is deterministic and can only ever ask for one extra confirmation.
  `drive.applyRemoteDoc` passes `preserveTimestamp`: restamping an applied remote record
  would make it instantly newer than the peer's and the two devices would ping-pong forever.
- Gift RANKS stay device-local on purpose (`drive.js` skips `giftRank`); only `unwrappedAt`
  converges, min-merged, so what a child opened stays open everywhere. Decision 2026-07-31:
  syncing `giftRank` is the exact path that once produced a runaway 🎁 folder needing a
  repair migration, and the child-visible benefit is small.
- **THE SOURCE OF TRUTH IS (SUBSCRIPTIONS, LOOSE VIDEOS); EVERYTHING ELSE IS DERIVED**
  (v1.0.38). `libraryChannels` rows ARE the source list; video records in the `'sheet'`
  folder are the individually added singles; both already travel in the Drive doc, which
  is why removing the Google-Sheets list added **0 bytes** to it. There is no second store
  and no mirror: nothing outside the app can add or delete content. See
  [docs/V1038.md](docs/V1038.md).
- Deletion = atomic delete + deny-list tombstone. Since v1.0.10 the deny-list is an
  LWW-element set: entries are never removed, only REVOKED (`removedAt >= at` = inert;
  `db.denyActive`, merge rule `drive.mergeDenyRecord` — later event wins, tie → revoked).
  **The revocation paths are now exactly two, and both are an explicit parental ANSWER**
  (v1.0.38): `plan.deniedReAddPrompt` when the parent re-adds one key by paste/search/
  share/import, and `app.offerDeniedRestore` for a channel's removed backlog. It must
  never be automatic — a parent who removed three bad videos must not get them back for
  re-pasting a link (the v1.0.23 rule). ⚠️ THIS WAS A LIVE HOLE, not a theoretical one:
  `addClassifiedRow` never consulted the deny set at all, so a re-pasted deleted video
  was written, shown to the child, and destroyed by the next pull
  (`drive.mergeDbFiles` deletes any video whose tombstone is active). The sheet's
  un-deny had been quietly repairing that.
- **NOTHING MIRRORS ANY MORE** (v1.0.38 deleted `planSheetMirror` + `applySheetMirror`).
  What the mirror also did — sweeping content whose channel nobody subscribes to — is now
  an UNCONDITIONAL sync stage (`sync2.gcOrphans`, pure `plan.planOrphanGC`), which is a
  bug fix: it only ever ran under `if (sheetParsed)`, so a sheet-less profile never swept,
  and a peer's channel deletion left its videos forever. `plan.orphanSweepValve` parks any
  sweep above max(10, 5%) or one that would take EVERYTHING (the v1.0.18 rule), because
  `deleteVideoRaw` writes no tombstone and a mass sweep churns against the Drive doc; a
  parked sweep is SAID in the sources tab, never left in a meta key nobody reads.
- **THE COMPLETE LIST OF THINGS THAT MAY DELETE A VIDEO RECORD**: the parent's explicit
  🗑️, `db.purgeRejected`, the 30-day rejected expiry, the migration's `# הוסר` rows,
  `db.purgeProfile`, and the orphan sweep. Adding to this list is a safety decision.
- `sortKey` depends only on the row's own ordinal/timestamps — appending never renumbers
  existing rows (test-pinned). `origin:'sheet-row'` survives as an ORDERING DOMAIN
  (`order.SHEET_BASE + rowIndex`, rendered DESC so the last line shows first); a links-file
  import writes it, which is why an imported list keeps its file order.
- `planMutations` twice over identical inputs ⇒ empty diff (the churn-free test is sacred).
- Gift state lives in `profileVideoState`, NOT on video records (siblings share libraries);
  `unwrappedAt` is forever (min-merged everywhere).
- **AN UNREADABLE DRIVE DOC IS NEVER AN EMPTY ONE** (v1.0.22, `drive.interpretDriveDoc` /
  `interpretDriveList` / `decidePush` — same pattern as `interpretSheetResponse`, and the
  same reason). `readDbFile` used to answer `null` for a 401, a network drop, a 200 + HTML
  sign-in page and a genuinely absent file alike; `mergeDbFiles(local, null)` returns
  `local`, so the "the remote changed since our last write, merge first" branch became a
  BLIND OVERWRITE of the very document it protected — one failed read and a fresh device
  PATCHed its empty doc over the family's whole library. **A version mismatch we could not
  read ABORTS** (`pendingPush` retries). Emptiness may come from exactly one input: a 404.
  A failed file SEARCH likewise must not read as "no backup" — that created a second db
  file permanently shadowing the real one.
- **PER-DEVICE CHANNEL PROGRESS TRAVELS NOWHERE**, in either direction, via ONE shared list
  (`drive.stripPerDeviceChannel` / `mergeChannelForApply`): cursors, `backfillDone`,
  `lastRssCheckedAt`, `playlistQueue`/`playlistsDone`, `noLongForm`. The serialize side used
  to omit `backfillDone`, and the apply side wrote a peer's record VERBATIM when the channel
  was new here — so a device inherited "finished" and only ever saw the ~15-video RSS window.
- A 401 INVALIDATES the cached token (`gauth.invalidateToken`, called from `drive.api`). The
  55-minute lifetime is our guess, not something `authorize()` returns, so a token revoked in
  the parent's account kept being handed out for up to an hour of failing I/O — which is the
  most likely real-world trigger for the overwrite above. `authorize()` is also shared between
  concurrent callers, so two taps cannot pop two system dialogs.
- `copyDenies` judges presence by the RECORD EXISTING, not by `loadDenySet` (which hides
  revoked entries), and carries the source row's own `at` (`db.denyRowToWrite`). Otherwise a
  revoked tombstone read as absent, was overwritten with `at: Date.now()`, lost its
  `removedAt`, won the Drive last-event comparison, and re-deleted the video on every device.
- `db.pageFolder` returns NOTHING for `limit <= 0`. The push used to precede the length
  check, so a zero limit yielded one row — and `pageAnyFolder` passes `limit - extras.length`,
  which is exactly 0 once absorbed singles fill a page (16 tiles on a 15-tile grid, the row
  repeated on page 2).
- **A PROFILE NAME IS UNIQUE PER GOOGLE ACCOUNT, NOT PER DEVICE** (v1.0.22). `createProfile`
  mints the id LOCALLY and BOTH merge paths union by id (`store.mergeProfileLists`,
  `drive.mergeDbFiles`) — the name is never compared — so two devices on one account could
  each create "נועם" and both would survive the sync. That is not cosmetic: `profileVideoState`
  is keyed by profileId (the child's 🎁 progress SPLITS), `prof:<id>` splits their personal
  videos, and a sheet-less profile gets `lib:p:<profileId>` — two whole libraries for one
  child, while the parent just sees two identical avatars. Creation therefore PULLS FROM
  DRIVE first (`pullDrive` already folds remote profiles in via `mergeRestoredProfiles`) and
  blocks with a distinct message via pure `store.profileNameConflict` → 'local'|'remote'|null.
  The pull is BEST-EFFORT: hard-blocking creation when Drive is unreachable would make the
  app unusable offline. That leaves one irreducible case — two devices offline at once —
  because with no server there is no coordination point; `store.duplicateProfileNames`
  reports it in the parent screen and the parent renames or deletes. Never auto-merge
  (irreversible: gift state + scopes) and never auto-rename behind their back.
- **A PROFILE'S `libraryId` IS IMMUTABLE** (decision 20, as of v1.0.38). `lib:p:<profileId>`
  for every profile created from now on; `prof:<id>` stays the personal scope. A legacy
  `lib:<fnv1a(sheetKey)>` is kept EXACTLY as it is — pre-v1.0.38 families derived it from a
  sheet URL and several profiles may SHARE one, so changing it would strand the whole family
  library under an unreachable scope, on every device. `db.moveScope`, `plan.planScopeAdoption`
  and `app.adoptLibraryScope` are DELETED, which is what makes this enforceable rather than
  aspirational: no code path can change a scope any more, and an invariants guard fails if one
  comes back. There is deliberately NO way to attach a sources sheet either — the migration
  deletes the family's sheet files, so a re-attached URL would point at a file nothing
  maintains AND would undo the migration on the next launch.
- **THE SCOPE TRAVELS IN THE DRIVE DOC** (`profileSources[pid].libraryId`, v1.0.38, additive).
  It used to be derivable from the sheet URL and the entry was written only when one existed —
  so after the migration a fresh device restoring the backup got the profiles and every
  `libraries[…]` blob but NO sources row, and `ensureSources` minted `lib:p:<id>` while the
  content sat under the old hash: empty home, full database. Pure
  `drive.resolveRestoredLibraryId` decides (explicit id → the legacy derivation → `lib:p:`).
  An older app is unharmed because a migrated entry carries `sheetUrl: null` and its own
  `if (!ps.sheetUrl) continue` skips it — which is why that value must stay NULL, never `''`
  or a sentinel (test-pinned).

**Platform/native:**
- `platform.exitApp()` prefers `KidsNative.exitApp` (finishAndRemoveTask + delayed kill) —
  `App.exitApp()` only finish()es and reads as "minimize" on real devices (v1.0.4).
- CapacitorHttp silently DROPS a request body without an explicit `Content-Type` header.
- `Filesystem.downloadFile` IGNORES `recursive:true` on Android — `mkdir` first.
- Registering Capacitor's `backButton` listener disables ALL default back handling —
  `nav.handleBack` must consume every case (catch-all swallow).
- Native plugins register BEFORE `super.onCreate()` in MainActivity. `BridgeActivity.load()` calls
  `this.onNewIntent(getIntent())` itself — one onNewIntent override covers cold+warm share intents.
- OAuth = Play Services AuthorizationClient (`drive.file` only): NO refresh token exists, no client
  secret; one Android OAuth client per signing SHA-1 (see GOOGLE_CLOUD_SETUP.md).
- YouTube quota: NEVER call `search.list` (100 units). RSS is free. Batch by 50.
  The parent's search (v1.0.33) is NOT an exception: it uses the KEYLESS youtubei
  endpoint (0 quota, no API key), sanctioned in `www/js/ytsearch.js` ONLY — the
  invariants suite pins the one-module rule, bans `key=`/`getApiKey()` there, and
  still fails any Data-API search shape anywhere.
- The API key ships via GITIGNORED [www/js/keys.local.js](www/js/keys.local.js) (repo is PUBLIC —
  never commit it; never serialize it into the Drive DB/Sheet). Restrict it by API only — an
  Android-app restriction breaks CapacitorHttp requests.
- No-bundler import layer order (a cycle = undefined bindings at runtime, not a build error):
  `platform → store/classify/csv/util → db → plan/sync2/drive → ui/* → app.js`. `nav.js` never
  imports views. `tour.js` imports NOTHING (pure data + pure functions), so it is safe
  anywhere in the order.

- v1.0.76 — **HOME SHRINKS THE VIDEO INTO A FLOATING WINDOW (PiP)** (user request),
  **opt-in, per profile, OFF unless a parent turns it on** — the bgPlay shape (v1.0.63),
  one surface up.
  - **THE MECHANISM IS ANDROID'S OWN PICTURE-IN-PICTURE** (API 26+): the activity shrinks
    into a floating window over the launcher. The window's X and expand are the SYSTEM'S
    OWN affordances; only ⏮/⏯/⏭ are ours (RemoteActions), and their taps ride the EXISTING
    `playbackCommand` retained-until-consumed channel — no second command path.
  - ⚠️ **ENTERING PiP FIRES THE VERY appStateChange THE v1.0.32 SCREEN-OFF HANDLER PAUSES
    ON.** Android pauses the activity when the video shrinks — so without a gate the whole
    feature is a frozen floating frame. `inPipMode` is set by the native `pipChanged`
    event, which Android fires BEFORE the onPause (onPictureInPictureModeChanged precedes
    it, and bridge events keep their order); the handler's FIRST line consults it.
    Guard-pinned as an ORDER (the gate before the save), and the event order itself is a
    device checklist item — the one link no browser can prove.
  - **THE DECISION IS PUSHED AHEAD OF THE HOME PRESS** (`setPipState`): `onUserLeaveHint`
    is synchronous and cannot ask the bridge — the v1.0.63 cached-decision shape, one layer
    down, cached as statics in the plugin. Pure `playerlogic.pipEligibility` owns the rule;
    pushed from openWatch, every onPlayState, the watch view's onLeave, the setting/kiosk
    toggles, and both containment doors (engage + clear).
  - ⚠️ **EVERY LOCK REFUSES PiP, AND THAT IS THE SAFETY HALF OF THE FEATURE**: the floating
    window sits over the LAUNCHER, i.e. HOME with PiP armed walks the child out of the app
    with the video in tow — exactly the door the kiosk (exitLock), every containment mode
    and the scheduled break exist to close. Refused in JS (`pipEligibility`: kiosk/contained)
    AND natively (`maybeEnterPip` re-checks `inLockTaskStatic` — the OS refuses under screen
    pinning anyway, but the decision must be OURS, not an OS side effect). An unreadable
    kiosk setting reads as kiosk-ON (strict), and the settings hint SAYS the window floats
    over the home screen rather than letting a parent discover it. Browser-verified: with
    the kiosk on, the pushed state was `eligible:false` while the video kept `playing:true`.
  - **YOUTUBE IS INCLUDED — THE OPPOSITE OF bgPlay, DELIBERATELY** (user decision
    2026-09-06): in PiP the activity stays VISIBLE, so the WebView is never throttled or
    evicted — the reason YouTube is excluded from background playback does not apply. The YT
    engine therefore learned to report play/pause through `cb.onPlayState` (the file engine
    has since v1.0.74; through `cb`, NEVER `opts` — reuse() swaps it, and `opts` would report
    into the PREVIOUS video's callbacks). The background service is unaffected: republish is
    gated on `bgPlayLive`, which YouTube never arms. **Nothing pinned this before** — a plant
    deleting the YT reporter left the whole suite green, so a new guard covers it.
  - **⏮/⏭ ARE REAL TRACK SKIPS** (user decision 2026-09-06 — the notification keeps its
    ±10s, v1.0.68; two surfaces, two jobs). The track is built ONCE from `pageAnyFolder` —
    THE pagination entry point (the v1.0.63 precedent, capped at `PIP_TRACK_MAX`) — so the
    window can never disagree with the grid the child last saw. **A wrapped gift is SKIPPED,
    never opened** (pure `pipSkipTarget`; a THROWING gift predicate reads as "gift" — unknown
    must skip, fail closed); **no wrap-around** (a chain that loops plays all night); and the
    state is RE-READ after the await (v1.0.57 — the command is retained natively). The verbs
    route BEFORE the bgPlay gate: PiP works with background playback off, and the window's ⏯
    is admitted by `pipEnabled` alone — while ⏪10/⏩10 stay the notification's.
  - **THE WINDOW GOING AWAY HAS ITS OWN DOOR** (`pipHidden`): the X, or the screen turning
    off over it, arrive as `onStop` with NO appStateChange (the activity already paused at
    entry). Natively a dismissal is told from an EXPAND by what follows the mode change —
    onStop within 2s = dismissed, onResume = expanded. The JS door repeats the v1.0.32
    contract exactly: save FIRST (the live playhead), consult `backgroundPlayDecision`
    (screen-off over the window must not silence a legitimate bgPlay listen), pause IN
    PLACE, never stop().
  - **"עדיין צופים?" IS HELD DURING PiP** — the prompt renders inside `#player-wrap` and a
    PiP window forwards no taps to the page, so the question would be unanswerable; the
    counter is held at NOW like bgPlay's hidden branch (v1.0.63).
  - **IN THE WINDOW THE APP STRIPS TO THE VIDEO** (`html.pip`, CSS only): the whole activity
    is scaled into ~2 inches, so the top bar, title, grid and pager would be unreadable
    confetti. A fullscreen video already fills the window through the native custom view; the
    CSS covers the windowed case (the audio scene, a windowed video).
  - ⚠️ **TWO OF THE FIRST GUARDS WERE PROVEN VACUOUS BY THEIR OWN PLANTS**, the lesson of
    this release: a whole-function match on openWatch was satisfied by the onPlayState
    callback INSIDE it (re-anchored to the arm call), and a 700-char window from
    `onPipHidden(` reached INTO the neighbouring onAppPause once comments were stripped and
    matched THAT handler's `backgroundPlayDecision` (`handlerBody` — the appPauseBody
    brace-balancing, generalized — replaced it). A char window into app.js is a guess about
    distance; a balanced body is not. A guard also fired on the icon file's own comment (the
    v1.0.69 trap, a fourth time — read comment-stripped).
  - Icons are flat white vectors (alpha-tint, v1.0.66), no raster fallbacks (nothing here
    uses an API-24 attribute, v1.0.69), unmirrored transport glyphs. `pip: false` joined
    SAFE_ON_TIE — a tie that answers "on" quietly opens a door out of the app.
  - 2 unit tests (23 assertions) + 2 invariants guards (42 assertions), every guard proven
    red on a planted regression (12). APK builds and both PiP-touching java files are
    byte-identical across copies (KidsNativePlugin joined the parity set); the four drawables
    are confirmed PACKAGED. Browser-verified with a stubbed bridge on a real audio record:
    eligibility pushed on play for BOTH engines, the pause gate keeping the video playing on
    PiP entry, `pipHidden` pausing in place, ⏮/⏭ walking the real grid order with no
    wrap-around, a wrapped gift skipped, ⏯ working with bgPlay off, the idle prompt held, and
    the kiosk refusing PiP mid-play. **Real PiP — the window, its buttons, the event order,
    YouTube's behaviour inside it — is a DEVICE checklist item.**

- v1.0.76 — **THE APPROVED-SITES VIEWER GAINS BROWSER BACK/FORWARD** (user request: "כפתורים
  ימינה ושמאלה … כמו שיש בדפדפן אינטרנט"). Two buttons at the RTL-LEFT of the viewer bar
  (opposite the 🏠 pill), driving the WebView's OWN history (`goBack`/`goForward`).
  - **THE GLYPHS ARE THE APP'S OWN PAGER LANGUAGE** (`ui/pager.js`): ▶ = "previous" (back),
    ◀ = "next" (forward), mirrored for RTL — so a child meets ONE arrow convention across
    the whole app, and it matches Android's own RTL browser.
  - **GREYED WHEN DEAD** (`updateNavButtons`, `canGoBack`/`canGoForward` → `setEnabled` +
    35% alpha): a child must not tap an arrow that does nothing. Refreshed from open() and
    from EVERY history hook — `onPageStarted`, `onPageFinished` (where `canGoForward` flips
    to false once a new nav commits) and `doUpdateVisitedHistory` (a same-document pushState
    that `onPageStarted` misses).
  - ⚠️ **NOT A HOLE IN THE SAFETY BOUNDARY.** `goBack`/`goForward` reach only history
    entries that `shouldOverrideUrlLoading` ALREADY vetted when they first loaded, and a
    site lock rebuilds the overlay (mode change → forceClose → fresh WebView, empty history),
    so an in-lock history holds only in-lock pages. History navigation does not re-run the
    URL filter and does not need to. `weblock.js` is untouched — this is pure chrome.
  - Fields, not locals (the history hooks reach them), nulled in `forceClose` beside
    `titleView`. Both java copies; the ⚠️ guard's per-hook check is BRACE-BALANCED
    (`javaMethodBody`) after a fixed char window bled into the next hook and passed with a
    deleted call — the handlerBody trap, a third time.
  - **DEVICE-ONLY**: the viewer is a native overlay that does not exist in a browser, so the
    whole feature is a device-checklist item. 1 invariants guard (both copies), proven red
    on four planted regressions; APK compiles.

- v1.0.75 — **A PAGE TURN NO LONGER FLASHES THE PAGE YOU LEFT** (field report: "אחרי
  שמדפדפים יש ריצוד ולרגע הדף הקודם מוצג, וכל הדפדוף לא חלק").
  - **ROOT CAUSE: THE ORDER IN `clearDrag`, AND THE COMMENT ON THE COMMIT PATH ALREADY
    PROMISED THE RIGHT ONE.** It read "the real render happens behind a grid already sitting
    where the ghost was, so the swap itself is never seen" — while the code removed the
    ghost, zeroed the transform, and only THEN ran the page turn. `renderHome` /
    `renderFolderView` / `renderWatchGrid` are all async, so for the frames until the render
    landed the grid sat at rest still holding the previous page. **The intent was documented;
    the sequence was inverted.**
  - **THE FIX IS TO RENDER WHILE THE GRID IS STILL OFF-SCREEN.** The settle leaves the grid
    translated a full page away with the ghost covering the viewport; the turn now runs
    there, and only when its promise resolves is the ghost removed and the transform
    cleared — one frame, nothing to see. Every `onSwipe` RETURNS its render so the swap
    waits on the new content rather than on a timer.
  - ⚠️ **MEASURED, NOT REASONED.** Sampling every 20ms did NOT reproduce it — the window is
    shorter than a sample. A `MutationObserver` on the grid's `style` fires as a MICROTASK,
    i.e. before paint, and caught it exactly: with the old order, **2 frames** about to paint
    at rest with the ghost gone and the old page still in the grid; with the fix, **0**. The
    first attempt to "verify the negative" was too coarse and would have passed a broken fix.
  - **THE FAST-FLIP FLUSH (v1.0.62) SURVIVES**: the pending turn is still run when a new
    gesture cancels the settle — it is now run *before* the reset rather than after, and the
    reset is skipped entirely if a newer gesture has taken the grid (`token !== seq`), while
    the old ghost is removed by reference either way.
  - 1 invariants guard extended (the v1.0.62 cleanup test now pins the ORDER and that all
    three callbacks return their render), proven red on a planted regression.

- v1.0.74 — **THE LOCK SCREEN SHOWED ⏸ OVER A TRACK THAT HAD FINISHED** (field report, with
  a screenshot reading 57:06 of 57:06 and a pause button).
  - **ROOT CAUSE: THE SESSION STATE WAS PUBLISHED ONLY WHEN THE NOTIFICATION'S OWN BUTTONS
    WERE PRESSED.** `armBackgroundPlayback` published `playing: true` at open, and the
    toggle/seek handlers republished on their own taps — so a pause from the SCREEN, a pause
    by a call, or a track simply ENDING changed nothing, and the widget kept advertising
    `STATE_PLAYING` for ever. The icon is drawn from that state, which is why it offered to
    pause a silent track.
  - **THE STATE NOW FOLLOWS THE PLAYER**: `playItem` gained `onPlayState`, fired from the
    file engine's own `play`/`pause`/`ended` listeners — the same three the audio scene
    already used (v1.0.70). Files only, which is exactly right: YouTube is excluded from
    background playback by design, so there is no second engine to teach.
  - ⚠️ **IT REPORTS WHAT HAPPENED, NOT WHAT WAS ASKED FOR.** The notification's ⏯ now just
    calls `pauseCurrent()`/`resumeCurrent()` and lets the player's event do the publishing:
    `resumeCurrent()` can be REFUSED by the browser (no user activation, a device still
    holding audio focus), and publishing "playing" straight after the call would leave the
    widget claiming a silent track is running — the same bug, one layer up. Guard-pinned by
    the ABSENCE of a publish in the toggle branch.
  - **EVERY PUBLISH GOES THROUGH ONE HELPER** (`republishBackgroundState`), count-pinned at
    two call sites — the arm and the helper. The artwork guard (v1.0.66) follows it there,
    which makes "the picture is re-sent on every publish" true by construction rather than
    per-caller.
  - **`ended` IS THE CASE IN THE REPORT**, and it now does both things: corrects the state
    AND reaches the disarm, so a finished track leaves no notification behind at all.
  - 1 invariants guard (10 assertions), proven red three ways. Browser-verified with a
    stubbed bridge on a real audio record: play, pause and ended each produced a republish,
    and `ended` was followed by the service stopping.

- v1.0.73 — **AN AUDIO FILE PLAYS IN THE ORDINARY PLAYER, NOT FULLSCREEN** (user request).
  - Fullscreen exists so a video fills the screen. An mp3 has no picture of its own — it
    plays behind the CSS music scene (v1.0.56) — so filling the screen with that scene hides
    the seek bar, ⭐ and the way back for no gain at all. ⛶ is still there for a child who
    wants it.
  - ⚠️ **ONLY A KNOWN `media: 'audio'` OPTS OUT, AND "UNKNOWN" IS TREATED AS VIDEO.** That
    field is null for a record nothing has enriched yet (a share, a links-file row, a peer on
    an older app) and is only CORRECTED at `loadedmetadata` from `videoWidth` — long after
    the tap. Reading null as audio would open real videos windowed; reading it as video keeps
    exactly today's behaviour, which is the safe direction for a guess. Pinned by the shape
    of the test, not just its presence.
  - **A VIDEO THAT TURNS OUT TO BE AUDIO KEEPS THE FULLSCREEN IT WAS GIVEN.** Dropping out of
    fullscreen a second later, when `loadedmetadata` corrects the field, is a jump the child
    did not ask for — and the scene it would reveal is the same one either way.
  - **THE v1.0.2 RULE IS UNTOUCHED**: the call stays SYNCHRONOUS and unawaited inside the tap
    gesture (an await first voids the user activation). A conditional costs nothing, and the
    v1.0.40 guard that pins the no-await prelude was extended to pin the condition too.
  - 1 unit test + the v1.0.40 guard extended, every guard proven red on a planted regression
    (3). Browser-verified on the real library: tapping a song made **zero** fullscreen
    requests and showed the music scene windowed, while the YouTube video still requested it.

- v1.0.72 — **A CALL RESUMES ONLY WHAT A CALL STOPPED** (field report: "עצרתי את השמע
  ועברתי להתעסק עם משהו אחר, וכשסיימתי שיחה השיר חזר להתנגן").
  - **THE RULE WAS ALWAYS WRITTEN DOWN AND ENFORCED IN ONLY ONE OF THE TWO DOORS.** v1.0.57's
    own entry says the watcher "arms only if the video was actually PLAYING (otherwise a
    video the child had paused before the call resumes after it)" — and the LIFECYCLE door
    does exactly that (`onAppPause` reads the playhead before pausing). But the **POLL** —
    which exists precisely because a heads-up call fires no lifecycle event at all — saw only
    `!st.playing` and could not tell a call's pause from a deliberate one. So the guarded
    door was the one calls rarely use, and the unguarded one was the common path.
  - **THE DISTINCTION CANNOT BE INFERRED, SO IT IS RECORDED.** A video paused by a call and
    one paused by a child are identical from outside. `player.markUserToggle` marks the
    pause at the surfaces a person actually presses — the centre tap, the TV remote's OK and
    the notification's ⏯ — and `playbackState()` carries it to the watcher.
  - ⚠️ **AN APP-INITIATED PAUSE MUST NOT MARK**, and a guard pins that by ABSENCE: screen-off,
    a scheduled break and the call's own pause are exactly the ones a call may legitimately
    resume from. Marking them would silently delete the whole feature — proven by planting it.
  - **CLEARED WHEREVER THE VIDEO PLAYS AGAIN** (`resumeCurrent`, and every new `playItem`), or
    a stale mark would block the NEXT real call — the mirror-image bug, also plant-proven.
  - The rule lives in `planCallResume`, not in its callers: two callers with one rule between
    them is how this bug happened the first time.
  - 1 unit test (the reported scenario, plus the whole matrix) + 1 invariants guard, every
    guard proven red on a planted regression (5, covering BOTH directions). Browser-verified
    on the live player: a centre-tap pause sets the mark, playing again clears it.

- v1.0.71 — **A CENTRE TAP SAYS WHAT IT DID** (user request: the same YouTube feedback the
  ±10 seek already gave). The ±10 badge has existed since v1.0.9, so the gesture a child uses
  MOST — pause and resume — was the one with no confirmation at all.
  - **ONE ELEMENT AND ONE TIMER FOR BOTH KINDS** (`#seek-feedback`, `flash(txt, kind)`): a
    seek landing on top of a pause would otherwise leave two badges fighting over the middle
    of the video. Count-pinned.
  - **THEY ARE TOLD APART BY SHAPE, NOT BY TEXT.** The seek is a pill saying a number; the
    toggle is a ROUND glyph. The child this is for cannot read the number, so the difference
    has to be something they can see at a glance.
  - ⚠️ **THE STATE IS READ BEFORE THE TOGGLE.** `togglePlay()` starts an ASYNCHRONOUS play on
    both engines, so asking afterwards can still answer "paused" — the badge would contradict
    the thing that just happened. What the child DID is what gets shown, which is also what
    YouTube shows. Guard-pinned and proven red on exactly that inversion.
  - **BOTH SURFACES WITH NO VISIBLE CONTROL USE IT**: the centre tap and the TV remote's OK.
    The HUD's own play/pause button deliberately does NOT — that button is already the
    indicator, and flashing a badge over it would say the same thing twice.
  - ⚠️ **TWO GUARDS IN THIS ONE TEST USED A CHARACTER WINDOW AND BOTH WERE WRONG.** One
    missed a declaration sitting 10 characters past a 200-char guess (a guard failing on
    correct code); the other matched a `border-radius: 50%` belonging to a LATER rule and
    stayed green with the badge planted square. Both are anchored to the CSS rule's own
    braces now. A window into a stylesheet is a guess about formatting.
  - 1 invariants guard (9 assertions), proven red three ways. Browser-verified on the live
    player at a real 820px viewport: ⏸ on pause, ▶ on resume, the video really stopping and
    starting, and a double-tap right still showing the PILL "10 ⏩" while moving exactly 10s.

- v1.0.70 — **THREE FIELD REPORTS, AND THE FIRST WAS A FEATURE THAT COULD NEVER BE TURNED
  ON.** All three are the same shape: correct-looking code on a surface no browser renders.
  - ⚠️ **THE SITE LOCK WAS UNREACHABLE.** v1.0.67 emitted `webLockRequest` from exactly two
    places, and BOTH sat inside `if (childLocked)` — so a lock could only be released, never
    ENGAGED. Reported as "אני לא רואה שיש נעילה לאתר אינטרנט ספציפי", and that is precisely
    what it was: nothing to see. The browser verification covered the SITES lock end to end
    and never touched the SITE lock, because the viewer is a native overlay — **a
    device-only surface hid a dead feature, not merely an unverified one.** The viewer's bar
    now carries a dedicated 🔓/🔒 button, and the ⏎ close button is hidden while locked.
  - ⚠️ **THE LOCK SCREEN DRAWS THE SESSION'S ACTIONS, NEVER THE NOTIFICATION'S.** v1.0.69
    gave the notification its ring-with-10 icons and the lock screen kept showing the
    system's ⏮/⏭ triangles, because `ACTION_SKIP_TO_NEXT/PREVIOUS` were advertised in the
    `PlaybackState` and **a standard action can only ever wear a standard icon**. They are
    gone from the advertised set, and ⏪10/⏩10 are published as **custom actions**, which is
    the one mechanism that carries an app's own drawable onto the lock screen and a car
    display. The callbacks stay: a steering wheel's physical ⏮/⏭ keys arrive whether or not
    the action is advertised — advertising decides what is DRAWN.
  - **THE AUDIO SCENE HOLDS STILL WHEN THE SOUND DOES** (user request). A picture that keeps
    bobbing over a paused track is the only moving thing on the screen, and movement reads
    as "still playing". `animation-play-state: paused` FREEZES mid-cycle rather than
    resetting — `animation: none` would snap every element back to its start, a visible jump
    on every pause. Driven by the media element's OWN play/pause/ended events, so it follows
    every source at once: the shield, the HUD, the notification's ⏯, a call, screen-off. The
    class is cleared on teardown for the same reason `is-audio` is — the wrap is shared, and
    a stale one would freeze the NEXT track's scene.
  - 1 invariants guard (11 assertions) + the v1.0.65 action guard reshaped, every guard
    proven red on a planted regression (4 — one of which reproduces the original dead
    feature exactly). Browser-verified for the half a browser can see: the scene runs, then
    freezes with the animation still applied rather than reset.

- v1.0.69 — **THE SEEK BUTTONS WEAR A RING WITH "10" IN IT** (user request, with a
  screenshot of Spotify's ⟲15 sitting directly beside our plain rewind triangle).
  - ⚠️ **A `VectorDrawable` HAS NO `<text>` ELEMENT**, so the digits cannot be written — the
    "1" and the "0" are hand-built PATHS. Verified by rasterising the artwork at **24px and
    magnifying it ten times**, because a path that parses is not a path that reads (the
    `ic_notification` lesson, v1.0.66, one icon over).
  - Flat white on transparent: a notification action icon is drawn from its ALPHA channel and
    tinted, so any colour is discarded. Guard-pinned, along with the four shapes the artwork
    needs (ring, arrowhead, and both digits) and a ban on the system triangles returning.
  - **NO RASTER FALLBACKS HERE, AND THAT IS NOT AN OVERSIGHT.** `ic_notification.xml` gets
    PNGs because it uses `android:fillType`, an API-24 attribute, which makes AAPT emit them
    and move the vector to `drawable-anydpi-v24`. Nothing in these two needs it: VectorDrawable,
    arc path commands and `strokeLineCap` are all API 21+ and minSdk is 22. Said out loud in
    the drawables themselves so the difference is not read as a mistake.
  - ⚠️ **AND IT REMOVED A LATENT CRASH ON THE APP'S OWN MINIMUM.** `iconOf()` built an
    `Icon`, whose `Notification.Action.Builder` overload is **API 23+**, while the app
    declares minSdk 22 — and `buildNotification` runs OUTSIDE the try that guards
    `startForeground`, so on a 5.1 device that was a `NoSuchMethodError`, not a missing
    icon. The int-based builder works on every version and is what both the seek icons and
    the play/pause glyph use now.
  - ⚠️ **A GUARD FIRED ON ITS OWN COMMENT FOR THE THIRD TIME THIS SESSION**: the drawable's
    comment explains that there is no `<text>` element, and the guard banning `<text>`
    matched that sentence. It reads the file comment-stripped now.
  - 1 invariants guard extended (8 assertions), proven red three ways. APK builds and both
    drawables are confirmed PACKAGED.

> ⚠️ **VERSION NOTE (2026-08-31): 1.0.67 WAS NEVER CUT** — the third deliberate skip, after
> 1.0.61 and 1.0.65. The website locks (labelled `v1.0.67`) and the notification seek
> (`v1.0.68`) were merged back to back, so ONE release carries both: 1.0.66 → **1.0.68**.
> The standing rule: cut the HIGHEST label in the tree, so no comment in the source ever
> names a version that has not shipped.

- v1.0.68 — **THE NOTIFICATION SEEKS TEN SECONDS INSTEAD OF SKIPPING TRACKS** (user
  request, from a screenshot of Spotify's own ⟲15/⟳15 sitting directly above ours).
  - **WHY IT IS THE RIGHT TRADE FOR THIS LIBRARY**: the content is mostly long recordings —
    45-minute discs, not three-minute songs — and moving INSIDE the track is what a parent
    reaches for. The cost is real and worth stating: **there is no longer any way to change
    track from the notification**; that needs the app.
  - **THE STEP IS `SEEK_STEP` (10s), THE SAME ONE A DOUBLE-TAP ON THE VIDEO GIVES**, so the
    notification and the screen can never disagree about what a skip means.
  - ⚠️ **THIS IS A THIRD SEEK SURFACE, AND THE CLAMP IS NOT OPTIONAL.** `player.seekRelative`
    goes through `tvKeyIntent`, which clamps: an unclamped forward seek runs past the end,
    the engine fires ENDED → `finish()` → `onExit`, and the child is EJECTED from the video —
    the v1.0.22 bug this app has already paid for once, on the TV remote.
  - ⚠️ **AND THE FIRST GUARD FOR IT WAS VACUOUS.** The unit test covers `tvKeyIntent`, which
    proves the DECISION clamps and says nothing about whether the caller uses it: planting a
    hand-rolled `c.getTime() + 10` inside `seekRelative` left the whole suite GREEN. The
    guard now pins the WIRING — where the bug actually lives — and is proven red on exactly
    that plant.
  - **A CAR'S OWN ⏮/⏭ MAP TO THE SAME TEN SECONDS** rather than sitting dead: a head unit
    renders what the `PlaybackState` advertises, and the alternative is two buttons that do
    nothing. `ACTION_REWIND`/`ACTION_FAST_FORWARD` are advertised alongside them.
  - **THE SEEK REPUBLISHES THE STATE**, or the car's progress bar keeps extrapolating from
    the position before the jump (the v1.0.65 rule: the position is published, never ticked).
  - **THE SKIP MACHINERY IS REMOVED, NOT LEFT DANGLING**: `bgTrack`, `buildBackgroundTrack`,
    `playerlogic.backgroundSkipTarget` and `BG_TRACK_MAX` each had exactly one consumer, and
    a constant with no consumer is a lie (the v1.0.37 rule). Two tests that pinned the old
    buttons were updated deliberately rather than deleted.
  - 1 unit test + 1 new invariants guard (plus the v1.0.63 button pin reshaped), proven red
    on a planted regression (3 — one of which is what exposed the vacuous guard). APK builds.

- v1.0.67 — **THE LOCK REACHES THE WEBSITES TOO: ONTO THE LIST, AND INTO ONE SITE** (user
  request: "לנעול את הילד בתוך האתר, הילד יוכל לגלוש כרגיל אך לא לצאת ממנו").
  - **TWO NEW MODES, ONE MECHANISM.** `CONTAIN_MODES` grows to `['app','folder','sites','site']`.
    `'sites'` is the exact sibling of `'folder'` one surface over — the child is held on the
    websites screen and may open any approved site and come back (the user's decision), but
    not return to the videos and not leave the app. `'site'` holds them INSIDE one site.
  - **A `'site'` LOCK WITHOUT A URL IS OFF**, exactly as `'folder'` is without a folderId: an
    active-but-targetless lock holds a child somewhere undefined. https only — the weblock rule.
  - **"BROWSE NORMALLY BUT NOT LEAVE" IS TWO NARROWINGS, and neither weakens the safety
    boundary.** `weblock.rulesForLockedSite` keeps the locked page's own rule plus any rule
    for the SAME host (so a site whose sections are separate rules still works end to end)
    and drops the rest — an approved link to ANOTHER site can no longer carry the child out
    (the user's decision 2026-08-31). It can only ever REMOVE reach, so `matchRule` keeps one
    implementation. The second narrowing is native: the viewer will not close for the child.
  - ⚠️ **THE VIEWER'S CLOSE SPLITS IN TWO, AND THAT SPLIT IS THE FEATURE.** `closeOverlay()`
    is the CHILD asking — refused under a lock, and it asks JS for the parent code instead;
    `forceClose()` is the APP demanding, and it always works. v1.0.45's own comment calls the
    screen-time close "the one wiring step that decides whether the browser respects screen
    time at all", so a site lock holds the child in and never the app. Guard-pinned both ways.
  - **HARDWARE BACK STOPS FALLING THROUGH.** Inside the viewer back means: leave fullscreen →
    walk the site's history → close. Under a lock that last step is swallowed. And the bar's
    button becomes **🔒 הורים**: leaving a "חזרה" label on a control that refuses to go back
    is how a child learns the app is broken.
  - **THE CODE SCREEN CANNOT BE SHOWN UNDER THE VIEWER** — it is a native overlay laid over
    the whole app — so the padlock closes the viewer first, and **backing out REOPENS the
    site**. Without that, tapping the padlock and changing your mind would itself be the way
    out. The PIN is never verified in Java (guard-banned): one implementation, in JS.
  - **BOTH LOCKS SURVIVE A RESTART**, because force-closing the app is the first thing a child
    tries. A `'site'` lock REOPENS the site (the user's decision) — landing on the list would
    let the child simply not tap it and sit outside the lock.
  - ⚠️ **AND IT FAILS OPEN, IN THIS ORDER.** If the parent deleted the site, or the viewer is
    unavailable at all, the lock RELEASES itself and says so. Measured in the browser: with
    the availability check written first, an orphaned lock never reached the release and the
    child sat on a locked screen with no 🏠 holding a lock on a site that could never open.
    Containment errs strict everywhere else; a lock nobody can identify errs open (v1.0.56).
  - ⚠️ **`renderSitesView` IS SYNCHRONOUS, AND `await f().catch()` ON IT THROWS.** The
    exception escaped `activateProfile`, the boot's own catch fired, and a locked child's
    relaunch landed on the PROFILE PICKER — outside the lock the persistence exists to
    enforce. 732 green tests, a built APK and `node --check` all passed on it; only running
    the real boot with a lock engaged showed it.
  - ⚠️ **A GUARD OF MINE TRIPPED ON CORRECT CODE**: `/\bpin\b|PIN/i` bans the parent code from
    Java, but the second alternative has no word boundary and fired on `lastActivityPing`. A
    guard that trips on what it is meant to permit trains you to delete it; bounded now, and
    re-proven against a real `pin` field planted in Java.
  - 3 unit tests + 2 invariants guards, every guard proven red on a planted regression (5).
    Java compiles. Browser-verified end to end through the real code gate: the sites lock
    engaging, its 🏠 refusing even when clicked, hardware back swallowed, exit and chip gone
    while the site tile stayed tappable, a relaunch landing inside the lock fully painted, the
    release restoring every door, and an orphaned site lock releasing itself with an honest
    message. **The site viewer itself is a DEVICE checklist item** — the native overlay does
    not exist in a browser.

> ⚠️ **VERSION NOTE (2026-08-31): 1.0.65 WAS NEVER CUT** — the same deliberate skip as
> 1.0.61. The MediaSession (labelled `v1.0.65`) and the notification artwork (`v1.0.66`)
> were merged back to back, so ONE release carries both: 1.0.64 → **1.0.66**. The rule this
> repo now follows is to cut the HIGHEST label in the tree, so no comment in the source ever
> names a version that has not shipped — the direction that cannot mislead.

- v1.0.66 — **THE NOTIFICATION SHOWS THE SONG'S PICTURE AND THE APP'S OWN MARK** (user
  request, with a screenshot of the row sitting anonymously under Spotify's).
  - **TWO DIFFERENT ICONS, and only one of them existed.** The **small icon** is the
    status-bar glyph — v1.0.63 used the generic `android.R.drawable.ic_media_play`, which is
    why the row was unidentifiable. The **large icon** is the big square picture Spotify
    shows, and it was **never set at all**.
  - ⚠️ **THE SMALL ICON MUST BE A FLAT WHITE SILHOUETTE, NEVER `@mipmap/ic_launcher`.**
    Android draws it from the ALPHA channel only and tints it, so the coloured launcher icon
    arrives as a featureless blob. A dedicated vector (`ic_notification.xml`) draws a screen
    with a play triangle — verified by extracting the COMPILED png from the APK and looking
    at it at 96/48/24px, because a vector that parses is not a vector that reads.
  - ⚠️ **AN AUDIO FILE NEVER HAS A PICTURE OF ITS OWN, WHICH IS THE WHOLE PROBLEM HERE.**
    `captureFrame` returns null for a track with no video (v1.0.56) — and background
    playback is *for* mp3s. Measured on the real library: **0 of the audio records carry a
    thumbId**. So the FOLDER's picture is the fallback that actually shows: the parent chose
    it, and it is what the child saw on the tile they tapped. Then the app icon.
  - ⚠️ **AND ON A DRIVE-IMPORTED COLLECTION THERE IS USUALLY NO FOLDER PICTURE EITHER** —
    measured: 0 of 34 imported folders had one (an import gives them 📂, not art). So for a
    typical music library the app icon is what appears, until the parent sets a picture with
    the v1.0.58 🖼️ editor. Said plainly rather than promising artwork that will not come.
  - **THE PICTURE CROSSES THE BRIDGE AS BASE64** because it lives in IndexedDB inside the
    WebView, which the service cannot open — the same wall that makes full Android Auto a
    second playback engine (v1.0.65). Byte-identical round trip verified in the browser.
    Capped (`BG_ART_MAX_BYTES`), decoded with `inSampleSize`, cached against its own string
    so a play/pause tap does not re-decode, and TOTAL — a bad image is "no artwork", never a
    crashed playback service.
  - **RE-SENT ON EVERY PUBLISH**: the service rebuilds the whole notification, so omitting
    the artwork on a play/pause tap would blank the picture. Guard-pinned.
  - Album art is set in TWO places for the same reason the actions are: `setLargeIcon` feeds
    the notification, `METADATA_KEY_ALBUM_ART` feeds the lock-screen widget and the car.
  - 1 invariants guard (12 assertions), proven red five ways. APK builds, and the drawable
    is confirmed PACKAGED (a vector in the wrong folder fails silently, not loudly).

- v1.0.65 — **A REAL `MediaSession`, SO A CAR CAN CONTROL THE MUSIC** (user request: "האם
  תוכל לספק תמיכה ב-android auto… לבחור שיר מהצג של הרכב?").
  - ⚠️ **VIDEO ON A CAR SCREEN IS IMPOSSIBLE, and not for want of effort.** Android Auto
    permits third-party apps in fixed categories only (media=audio, navigation, messaging);
    there is no video surface at all. Video exists on Android Automotive OS — an OS built
    INTO the car, not a phone projection — and is blocked there while driving. Recorded so
    nobody re-opens this as a feature request.
  - ⚠️ **"MIRROR THE APP LIKE SPOTIFY" IS A MISREADING OF WHAT SPOTIFY DOES.** Auto renders
    ITS OWN UI from a content tree the app serves through a `MediaBrowserService` /
    `MediaLibraryService`. Nothing is mirrored, and there is no cheaper path: a UI the app
    designs would never pass Auto's distraction rules. Browsing the library from the car
    therefore means ExoPlayer + a library service + exporting the library where native code
    can read it — the whole library lives in **IndexedDB inside the WebView**, which a
    service running with no Activity cannot open. That is a SECOND playback engine, and the
    user declined it (2026-08-31).
  - **WHAT WAS BUILT INSTEAD**, and it is the prerequisite either way: the framework
    `android.media.session.MediaSession` (API 21+, **no new dependency** — androidx.media
    would have pulled in a library for something the platform already has). It gives the
    car's steering-wheel and head-unit buttons over Bluetooth, the standard lock-screen
    media widget instead of a custom notification, and the track name + a progress bar on
    the car display.
  - **THE ACTIONS A CAR RENDERS COME FROM THE `PlaybackState`, NOT from the notification's
    own action list** — two separate surfaces that must advertise the same three controls or
    a button exists on one and is dead on the other. Guard-pinned, both halves.
  - **THE POSITION IS PUBLISHED, NEVER TICKED.** The system extrapolates from the position
    and the playback SPEED, so a car's progress bar advances with no timer of ours — on a
    child's tablet a per-second bridge call is a wake-up paid for nothing.
  - **THE SESSION IS RELEASED IN `onDestroy`**: one that outlives its service keeps taking
    the car's media buttons for a video that is not playing — the "a control for a dead
    video" rule this feature follows everywhere else.
  - The subtitle is the FOLDER'S name, from `folders` — the same list the home renders — so
    the notification, the lock screen and the car can never disagree about where a song is
    from.
  - 1 invariants guard (9 assertions), proven red four ways (an inactive session, a
    notification not backed by it, a dead skip callback, and a session outliving the
    service). Java proven to COMPILE. **The car itself is a device checklist item.**

- v1.0.64 — **THE PLAYBACK NOTIFICATION NEVER APPEARED, AND THE REASON IS A ONE-LINE
  MISUNDERSTANDING** (field report on the v1.0.63 release: "שמעתי שיר ולחצתי על כפתור
  הבית, השיר המשיך להתנגן — יופי. אבל לא הופיע לי כפתור").
  - **ROOT CAUSE: `POST_NOTIFICATIONS` IS A RUNTIME PERMISSION ON ANDROID 13+, AND A
    MANIFEST ENTRY ONLY MAKES IT REQUESTABLE.** It is DENIED by default. v1.0.63 declared it
    and nothing ever called for it, so on every modern device the foreground service started
    (the audio kept playing, which is why the feature looked half-alive) and the notification
    was silently suppressed.
  - ⚠️ **THE DOCS DESCRIBED THE BUG AS A FEATURE.** v1.0.63's own entry says "if
    POST_NOTIFICATIONS is denied the service still runs and the parent simply loses the
    visible control" — written as a graceful degradation, and it was in fact the ONLY
    behaviour, because the code to ask was never written. A documented failure mode is not
    evidence that the success path exists.
  - **ASKED WHEN THE PARENT TURNS THE SETTING ON**, which is the one moment it has context:
    they have just said they want playback to continue with the screen off, and the
    notification is how they control it. Not at launch (a prompt with no context on a child's
    tablet) and not when the screen goes off (a dialog nobody is there to see).
  - **A DENIED ANSWER IS SAID**, and it needed a new `.form-msg.warn` style: the file had
    only `.ok` (green) and `.err` (red), so the message would have rendered colourless — i.e.
    read as "nothing happened", which is exactly the silence this fix is about.
  - **GUARD**: any runtime-gated permission the manifest declares must have a
    `requestPermissionForAlias` + `@PermissionCallback` in BOTH java copies, and the feature's
    own toggle must ask. Proven red three ways (no request, no ask, no colour).

- v1.0.63 — **THE MUSIC CAN KEEP PLAYING WITH THE SCREEN OFF** (user request), **opt-in,
  per profile, OFF unless a parent turns it on.**
  - ⚠️ **THIS TAKES THE APP FROM 2 PERMISSIONS AND 0 SERVICES TO 5 AND 1.** All three new
    permissions (`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
    `POST_NOTIFICATIONS`) belong to this one feature, and the manifest comment that promised
    "exactly two" is rewritten rather than quietly deleted. A family that never opens the
    setting gains no service and no notification.
  - ⚠️ **ANDROID CANNOT TELL THE POWER BUTTON FROM `HOME`.** `appStateChange` carries no
    reason, so the setting really means "keep playing when the app goes to the background",
    and a child who taps HOME keeps hearing it. That cannot be fixed — only said, which the
    setting's own hint does.
  - **YOUTUBE IS EXCLUDED BY DESIGN** (the user's decision): the IFrame player is a WebView
    Android may throttle or evict the moment the app is not foreground, so "background
    YouTube" would be a promise the app cannot keep. Own audio/video files only.
  - ⚠️ **THE SERVICE IS STARTED IN `openWatch`, WHILE THE APP IS PROVABLY FOREGROUND.**
    Since API 31 a backgrounded app may not start a foreground service at all, so arming
    when the screen goes off is too late on every modern device — the feature would look
    implemented and never work. That is also why the notification appears during ordinary
    viewing: it IS the control, and every media app behaves this way.
  - **THE DECISION IS MADE FROM CACHED STATE** (`bgPlayEnabled`, refreshed in
    `loadGiftStates` beside `resumeEnabled`). `onAppPause` reads the live playhead and must
    stay a synchronous arrow (invariant-pinned); by the time an awaited settings read
    returned, the video would already be paused.
  - ⚠️ **THE CALL WATCHER STAYS ARMED EVEN WHEN THE VIDEO KEEPS PLAYING.** A call takes
    audio focus and the WebView pauses its own media regardless of our service, so an early
    `return` for the background case would leave a background-playing video stopped for good
    once the call ended. Guard-pinned by the ABSENCE of that return.
  - **⏮/⏯/⏭ ON THE NOTIFICATION** (the user's decision 2026-08-31). The skip list is the
    ORDER THE CHILD IS LOOKING AT — built once from `pageAnyFolder`, THE pagination entry
    point (the v1.0.58 precedent) — so the notification can never disagree with the grid
    under the player. `nextAfter` was NOT mirrored: it walks forward from a cursor and has
    no reverse, and writing one would be a second answer to "what is in this folder, in what
    order" (the v1.0.21 bug). No wrap-around: a chain that looped would play all night.
  - **A WRAPPED GIFT IS SKIPPED, NEVER OPENED** (`backgroundSkipTarget`): its whole ritual is
    that the FIRST TAP unwraps it and deliberately does not play (v1.0.25), so starting it
    from a notification would consume the video while leaving the tile wrapped forever.
  - ⚠️ **THE NOTIFICATION HAS NO CONTENT INTENT, DELIBERATELY.** Tapping it must not open
    the app: under a containment lock that would be a way out of a locked folder, and on a
    kiosk tablet a way back into a session the parent ended. Three transport buttons and
    nothing else; guard-pinned against `setContentIntent`.
  - **TORN DOWN AT EVERY DOOR** (each guard-pinned): leaving the watch view, a profile switch
    (`bgPlay` is a per-profile answer and a sibling's song must not follow the next child),
    and a **scheduled break — which also PAUSES**: screen time that leaves a song playing is
    not a break, and the notification would hand the child a ⏭ button for its whole duration.
    The teardown sits AFTER `showLockedScreen`'s parent-screen guard, for the same reason
    that guard exists.
  - **THE IDLE "עדיין צופים?" TIMER IS SUSPENDED** while playing hidden (the user's
    decision): it exists for a child asleep IN FRONT OF a screen, and there is no screen to
    show the prompt on. The counter is held at NOW rather than paused, so the full window
    restarts when the app returns.
  - The channel is `IMPORTANCE_LOW` with no sound and no vibration — a media notification
    that chimed on every song change is a tablet that wakes a sleeping child. `START_NOT_STICKY`:
    a service the SYSTEM restarted would show a control for a video that is not playing,
    with a JS side that no longer exists.
  - If **POST_NOTIFICATIONS is denied** on Android 13+ the service still runs and the parent
    simply loses the visible control — said out loud rather than degrading in silence.
  - ⚠️ **PROCESS, PAID A THIRD TIME**: a `git checkout www/js/app.js` during a plant cycle
    destroyed the whole settings toggle AND the `onAppPause` branch, because at that moment
    they were still UNCOMMITTED. Commit BEFORE planting. It was caught only because a new
    guard asserted the handler consults the decision — by a test written for the feature,
    not by re-reading the diff.
  - ⚠️ Two existing guards over `onAppPause` extracted its body with a non-greedy
    `([\s\S]*?)\}\);`, which ends at the FIRST `});` — so the moment the handler called
    anything with an object literal, the body was truncated and both guards claimed it had
    "stopped pausing the player". A guard that breaks on correct code trains you to edit the
    test until it passes. Extraction is brace-balanced now (`appPauseBody`).
  - 4 unit tests + 2 invariants guards, every guard proven red on a planted regression (7),
    and the debug APK BUILDS — the text-parity tests cannot see a Java syntax error.
    Browser-verified with a stubbed bridge: the setting persisting and naming the child,
    both messages, the service arming on a real audio file with its real title, a YouTube
    video never arming, and the service stopping when the watch view is left.
    **Real background playback, the notification, its three buttons and the permission
    prompt are DEVICE checklist items** — no browser can prove them.

> ⚠️ **VERSION NOTE (2026-08-30): 1.0.61 WAS NEVER CUT.** The three v1.0.61 trains (the
> channel-sync dialog, re-adding removed content, nested Drive folders) and the v1.0.62
> swipe feedback were merged together, so ONE release carries all four: 1.0.60 → **1.0.62**.
> The number was skipped deliberately rather than repeating the v1.0.57 mistake in reverse —
> this way no label in the code names a version that has not shipped, which is the direction
> that cannot mislead. A skipped number costs nothing: `update.parseVersion` compares three
> components, so 1.0.60 → 1.0.62 is an ordinary upgrade, and the what's-new screen simply
> has no 1.0.61 to show.

- v1.0.62 — **THE PAGE FOLLOWS THE FINGER, AND THE NEXT PAGE COMES IN WITH IT** (user
  request: "משוב, על ידי הזזת הדף ביחס להזזת האצבע, למשתמש לדעת שהוא מזיז את הדף לדף הבא").
  v1.0.57 turned pages on RELEASE with nothing visible until it happened — the child had to
  learn that the gesture existed. Now the grid tracks the finger 1:1 and the neighbouring
  page slides in beside it.
  - **FOUR USER DECISIONS** (2026-08-30): a real **carousel** (the neighbour is visible, not
    just the current page moving); a **rubber band** at the first/last page; the turn decided
    by **relative distance** (⅓ of the width) rather than the old fixed 56px; and **only the
    tile grid moves** — the folder name, 🏠, 🔍 and the pager stay put.
  - **THREE PURE DECISIONS** (`plan.swipeDragArm` / `swipeDragOffset` / `swipeDragCommit`,
    node-tested; a second copy of any is invariant-banned alongside `swipePageAction`).
    ⚠️ **ARMING HAPPENS DURING THE MOVE, WHICH IS WHAT THIS FEATURE COSTS.** v1.0.57 could
    decide "swipe or scroll?" at leisure on release; here a wrong answer is VISIBLE while it
    happens, so `SWIPE_ARM_PX` (18) must clear `TAP_SLOP_PX` (14) — a tap that nudges the
    whole screen reads as a bug — and the `SWIPE_RATIO` test runs at the same instant, or the
    grid jitters sideways during every vertical scroll (the v1.0.52 collision, made visible).
  - **THE COMMIT IS RELATIVE BECAUSE THE FEEDBACK IS**: past a third of the width the next
    page is already more than half revealed, so releasing there must complete the turn —
    "what you see is what happens" is the only rule that cannot surprise. `SWIPE_MIN_PX`
    survives as the floor for the FALLBACK path, which is why both constants still exist.
  - **THE LIVE TRACK IS AN ADDITION, NEVER A REPLACEMENT**, and that is a safety property:
    `renderPage` is async (it reads the database with the finger already moving), a viewport
    can be missing, and a ghost may never arrive — every one of those falls through to the
    v1.0.57 flick, which is also what a mouse and a TV remote still use. Guard-pinned.
  - ⚠️ **`overflow: hidden` IS APPLIED ONLY WHILE `.swiping`.** Permanent `overflow-x: hidden`
    turns the OTHER axis into `auto` per spec, making the viewport a scroll container and
    taking vertical scrolling away from the document — the exact class of bug v1.0.50/51/52
    chased around this app three times. During a gesture there is nothing to scroll inside it
    (the grid is its only in-flow child and exactly fills it), so the clip is safe there.
  - **THREE WAYS TO LEAVE A CHILD'S GRID STUCK TRANSLATED, all closed and each guard-pinned**:
    `pointercancel` SPRINGS BACK rather than only dropping the start (the OS steals drags —
    the v1.0.22 seek-bar invariant); a grid rebuilt UNDER the finger by a sync or a Drive pull
    fires `kp:gridrender` and drops the drag; and a **FAST FLIP MUST NOT LOSE A PAGE** —
    a child swiping again inside the 220ms settle cancels it, so `clearDrag` FLUSHES the
    committed turn it was carrying. Without that flush the faster they swipe the more pages
    silently vanish.
  - The `kp:gridrender` event is dispatched on the **GRID**, never its viewport: events bubble
    UP, and on the watch screen the swipe host IS the grid, so a viewport-level event would
    never reach the listener. Guard-pinned by that reasoning.
  - The ghost render is **`silent`**: it must not move the pager, or the page would read as
    already turned before the child committed to anything.
  - ⚠️ **TOOLING, AGAIN** (the v1.0.57 lesson, paid twice): in a HIDDEN Browser pane
    `setTimeout` is throttled ~6× and CSS transitions may not run at all, so a settle that
    takes 220ms can measure as seconds. The first reading of "the release did not commit" was
    a sample taken too early, not a bug — poll for the change instead of sleeping once.
  - 4 unit tests + 2 invariants guards, every guard proven red on a planted regression (7).
    Browser-verified on all three grids at a real 820px viewport: the transform tracking the
    finger 1:1 from 20px to 300px, the ghost carrying the NEXT page's real tiles, a release
    past ⅓ committing and below it springing back, the rubber band capped at exactly 12% of
    the width with no ghost rendered, a 45px sideways drift during a vertical scroll never
    arming, a tap moving nothing, a fast double-flip landing BOTH turns (3/3 → 1/3), the
    post-swipe click swallowed while a later tap still worked, a mid-gesture re-render
    leaving nothing stuck, and the player's shield and wrap untouched throughout.

- v1.0.61 — **A DRIVE TREE NESTS, EXACTLY AS IT DOES IN DRIVE** (user request, with a
  screenshot of 32 disc folders spread over 8 pages of the child's home).
  - ⚠️ **THIS REVERSES A v1.0.58 DECISION, DELIBERATELY.** That release flattened the tree
    into sibling `cf:` rows and said so in five places (plan.js, config.js, this file twice)
    — because the app had no folder-inside-a-folder screen and gaining one was out of scope.
    The user's decision on 2026-08-30 is the opposite, so every one of those statements and
    both machine guards were rewritten, not deleted quietly. **The cost lands on the child**:
    a disc used to be one tap from the home and is now two. The win is a home of ONE tile.
  - **`parentFolderId` ON THE `customFolders` ROW IS THE WHOLE DATA MODEL** — a `cf:` id, or
    null for a root. **No `DB_VERSION` bump** (the store is schemaless per row and a row
    without the field reads as a root), and it travels for free: custom folders are
    serialized wholesale and merged LWW by `updatedAt`. **The walk has always returned
    `parentId`; nothing ever persisted it**, which is the entire reason the tree arrived flat.
  - **A FOLDER THAT HOLDS ONLY FOLDERS NOW GETS A ROW.** v1.0.58 dropped it ("a folder of
    folders is not a folder here") and was right to: flattened, such a row could never be
    opened. Nested, it is exactly the row the parent taps. It survives if it holds media OR
    any descendant does, and hidden-at-zero (v1.0.21) counts CHILDREN as well as videos —
    otherwise the collection the user wants on the home is the one thing hidden.
  - **`pageAnyFolder` AND `nextAfter` DID NOT CHANGE, AND A GUARD PINS THAT.** The child
    tiles are concatenated onto the page in `renderGridPage` through pure
    `folderPageSlots`/`folderPageTotal` — folders first, **ONE pager** (32 discs need paging
    themselves, and a 5-year-old cannot be asked to tell two pagers apart). A page filled
    entirely by folder tiles asks `pageFolder` for `limit: 0` and MUST still call it —
    `res.total` sizes the pager, and the v1.0.58 zero-limit fix is what makes that safe.
  - **THE STACK ENTRY IS THE AUTHORITY, NOT THE MODULE GLOBAL.** `folder` now sits on the
    stack more than once, so `onEnter` reads `entry.params.folderId` and the page rides
    `entry.params.page` — without it a back-pop repaints the disc the child just left. And
    **the header moved out of `openFolder` into the render** (`paintFolderHeader`): a
    back-pop never runs `openFolder`, so the collection's discs appeared under the DISC's
    name. Both found in the browser; the grid was right and the header lied.
  - **THE FOLDER LOCK IS AN ANCESTRY TEST** (`folderAncestry` / `folderWithinLock`, pure,
    cycle-guarded because `parentFolderId` is merged LWW per row and two devices can
    briefly produce a chain that points at itself — a lock that hangs is a child stuck).
    Equality would lock a child into a collection's front door and refuse every disc inside
    it. **`containmentChrome.hideHome` became conditional** for the same reason: 🏠 is
    hidden only AT the lock's own folder, and inside a subfolder it reappears as the way
    back up — its handler already pops to the parent, so showing it is the entire fix.
  - **DELETING A COLLECTION DELETES THE FOLDERS INSIDE IT** (the user's decision: it works
    like Drive). `folderSubtreeIds` is the downward twin of `folderAncestry` and the ONE
    walk the cascade and the search scope share. Every child row gets its own `cfDel:`
    tombstone (absence alone is re-added by any peer that has not pulled — v1.0.36), the
    confirm NAMES what it takes ("ואת 32 התיקיות שבתוכה"), and both answers reach every
    video in the subtree — a move that re-homed only the top folder would orphan 751 songs.
  - **THE EMPTY-FOLDER SWEEP LEARNED TWO EXEMPTIONS**, and the second is a bug fix that
    predates nesting: a folder with CHILDREN is not empty, and **ANY Drive-backed row is
    exempt, not just the root anchor** — `planDriveFolderImport` counts DENIED files as
    media present, so a swept disc returns on the next refresh with a NEW id, and the sweep
    and the refresh would tombstone-and-mint against each other every 30 minutes, on every
    device.
  - **THE SNAPSHOT WAS ALREADY DROPPING THE TREE**, which nesting only made visible:
    `driveFolderId`/`driveRootId` were absent from the whitelist, so a restored folder never
    refreshed again. All three fields travel now, and `parentFolderId` is VALIDATED (an
    untrusted string from a file that the ancestry walk follows; a row naming ITSELF as its
    parent would vanish from the home forever).
  - **THE MIGRATION IS THE IMPORT ITSELF**: an existing row is matched by `driveFolderId`
    and gains its parent IN PLACE, so a flat tree nests itself on the next add or refresh —
    no dataver step. An older app on the same account ignores the unknown field and shows
    every folder on the home (degraded, never broken), and `homeFolderRows` falls back to
    the home for a child whose parent row is GONE: worse placed, never invisible.
  - ⚠️ **TWO DEFECTS THE BROWSER CAUGHT AND 707 GREEN TESTS COULD NOT**, both "the feature
    does nothing" (the v1.0.59 lesson, again): `homeFolderRows` read only `folderId`, but
    the home renders TILE objects whose id field is `id` — so every parent lookup missed
    and all 32 discs stayed on the home; and the parent's folder list told a parent that
    the row holding 32 discs was "ריקה — לא מוצגת לילד" while it sat on the child's home.
    A third was caught by a PLANT: the first version of the pagination guard checked only
    that the helpers were CALLED, and stayed green with the child lookup replaced by `[]`.
  - 6 unit tests + 5 invariants guards, every guard proven red on a planted regression (7).
    Verified in the browser against the REAL 32-disc collection: 751 files in 32 discs under
    ONE home tile reading "32 תיקיות"; the collection opening onto 3 pages of discs; a disc
    opening onto its songs; back returning to the right page AND the right header; search
    from inside a disc finding 4 hits across the collection; a lock on the collection
    letting its discs open while hiding 🏠 only at the top; a relaunch landing inside the
    lock fully painted; the sweep run an hour into the future deleting NOTHING; and the
    cascade taking 34 folders to 1 with 33 tombstones while all 751 songs moved unharmed.

- v1.0.61 — **CONTENT THE PARENT REMOVED CAN BE ADDED AGAIN, AND EVERY DOOR ASKS** (user
  request: "תוכן זה הוסר בעבר, האם להוסיף אותו שוב כעת?").
  - **THREE PATHS ALREADY ASKED AND THREE REFUSED IN SILENCE.** Paste, YouTube search and a
    single Drive file have gone through `plan.deniedReAddPrompt` since v1.0.38. A **share**
    answered `'denied'` and stopped; a **Drive folder import** skipped the files and said so
    only when NOTHING else arrived; a **channel add** offered `offerDeniedRestore` only when
    the channel imported ZERO videos — so a channel where 12 of 40 had been removed here
    imported the 28 and reported the 12 **nowhere** (`channelAddOutcome` returns from its
    `if (n)` branch long before it reaches the denied clause). That gate is now gone from
    both the channel and the playlist branch.
  - ⚠️ **THE SHARE ASKS *AFTER* THE PARENT CODE, AND THAT ORDER IS THE WHOLE SAFETY
    PROPERTY.** A share arrives from any app, on a tablet a child is holding. Asking at the
    deny check — where the refusal used to live — would hand the child a one-tap way to
    revoke a deletion tombstone by sharing the video back, and **a revoked tombstone travels
    to every device**. So `routeShare` now only *computes* `denied` there and puts the
    question below `decision`, where a parent has provably passed the PIN. With **no**
    interactive handler (browser preview, a thrown handler) nobody has authenticated and the
    old refusal stands. Guard-pinned by INDEX, not by presence.
  - **THE DRIVE IMPORT ASKS ONCE FOR THE BATCH** (the links-file precedent): a tree walk can
    meet dozens of removed files, and dozens of dialogs is a parent tapping "yes" without
    reading. The keys come from the PLAN (`planDriveFolderImport`/`planDriveTreeImport` now
    return `deniedKeys`, not just a count) because the caller cannot recompute them — the
    walk that produced them is a network operation — and the plan is **re-run** after the
    revoke, so nothing downstream needs to know this happened. Only on a FIRST import
    (`&& first`): the 30-minute refresh runs unattended and must never raise a dialog at
    nobody.
  - ⚠️ **THE PLURAL SENTENCE WAS THE LINKS-FILE COPY, VERBATIM** — it told a parent importing
    a FOLDER of songs about "מהלינקים בקובץ", a file they never opened. Found in the browser,
    not by reading. `deniedReAddPrompt` takes a `source` now and the noun follows the door
    (the v1.0.27 rule: the words ARE the feature).
  - The v1.0.38 rule is unchanged and still holds: un-denying is **never automatic** — every
    one of the five paths is an explicit parental answer, and the guard that every `unDeny`
    in the UI layer sits next to a question covers the two new ones.
  - 4 unit tests + 2 invariants guards (plus the v1.0.37 restore guard deliberately flipped),
    every guard proven red on a planted regression (6 — one of which was caught VACUOUS by
    its own plant: `plan = planDriveTreeImport(` also matched the import's own opening
    declaration, so the guard stayed green with the entire re-run deleted). Browser-verified
    end to end through the real PIN gate and a REAL 23-file Drive folder: a share of a
    deleted video asking only after the code and adding it on "החזרה"; the same share
    declined leaving the tombstone and storing nothing; three deleted songs re-offered as one
    question with the honest count and restored; and two declined, staying removed with
    "לא נוסף כלום — 2 קבצים בתיקיה הוסרו כאן בעבר".

- v1.0.61 — **"⚙️ איך לסנכרן את הערוץ?" ACTUALLY ASKS NOW** (field report with a screenshot:
  tapping it hid the row and asked nothing, and the channel stayed un-synced until the
  parent ticked auto-approve by hand in the list below).
  - **ROOT CAUSE: THE BUTTON WAS ASKING THE WRONG QUESTION.** It delegated to
    `offerChannelApproval`, which asks about the BACKLOG — and that function returns
    `{count: 0}` **before opening any dialog** when the pending queue is empty.
    `decideNewChannel` then read `count === 0` as "the tap was the review", called
    `markChannelDecided` (which writes **`decidedAt` ONLY, never `autoApprove`**) and showed
    a 4-second toast. The row left "ערוצים חדשים" with nothing decided.
  - **SIX STATES REACH AN EMPTY QUEUE**, and only one of them is the intended
    Shorts-only case: a peer's row this device has not synced yet, an auto-approved
    `defaultAutoApprove`, a pending record parked in the PROFILE scope (`pendingKeysOfChannel`
    reads ONE scope, unlike `pendingTotal`), `pagePending`'s 5000 cap — and **a null
    `libScope`**, which is the exact failure `test/invariants.test.mjs` already carries a
    guard about for the sibling functions. A seventh silent path: `askKid` answers
    `'dismiss'` instantly when another modal is open (modals never stack), which the old
    code could not tell from a real "אחר כך".
  - **THE FIX IS A DIFFERENT QUESTION, NOT A PATCHED GUARD.** A sync MODE is a property of
    the SUBSCRIPTION and can always be asked; the backlog is a consequence, and the same
    answer settles it. `plan.channelSyncModeDialog` is raised on every tap regardless of the
    queue, and the answer writes **both** `autoApprove` (which IS the ✅ in the channel list)
    and `decidedAt` (which is only what clears the row out of the section), plus
    `autoApproveSource:'ui'`. "אוטומטי" also approves any backlog; "ידני" opens the picker
    when there is one.
  - **"אחר כך" AND A DISMISS WRITE NOTHING** — the row stays where the parent can find it,
    which is the v1.0.23 rule ("אחר כך" is deliberately not a decision) now applied to the
    accidental-dismiss case too. A null scope says so instead of deciding.
  - The ADD flow's own three-way dialog is untouched: there the parent has just pasted a
    channel and the backlog IS the question.
  - 3 unit tests + 1 invariants test (5 wiring halves), every guard proven red on a planted
    regression (5). **`decideNewChannel` had ZERO test coverage before this** — the empty-queue
    branch was described only in a CLAUDE.md paragraph that called it intended behaviour.
    Browser-verified through the real PIN gate on a planted empty-queue channel: the dialog
    opens, "אוטומטי" saves `autoApprove:true` + `decidedAt` and ticks the ✅ in the list
    below, "אחר כך" leaves the row untouched, and both survive a reload.

- v1.0.58 REVIEW PASS — **THREE DEFECTS REACHED MAIN, AND A FOURTH WAS BORN FIXING THEM.**
  Found by reading the shipped diff with fresh eyes; every one is now guard-pinned and
  proven red on a planted regression. **All four are the same shape: a green suite over code
  no node test can execute.**
  1. **A FOLDER HOLDING ONLY PARKED VIDEOS WAS DELETED AS EMPTY.** `db.countFolder` ranges
     `by_folder_sort`, and a video awaiting approval carries `folderId: '~pending'` with the
     real folder in `homeFolderId` — so it counts as ZERO. A parent can put one there on
     purpose (`moveVideoToFolder` writes exactly that field for a parked record). Approving
     it afterwards filed the video under a folder that no longer existed: invisible on every
     screen, forever — the precise failure `deleteCustomFolderFlow`'s own comment exists to
     prevent. The sweep now counts pending AND rejected records by their `homeFolderId`.
  2. **THE CACHE SWEEP COULD DELETE A LIVE CACHED FILE.** It owned files by re-deriving the
     name from the record, but `cacheExtFor` reads `media` and **v1.0.56 CORRECTS `media` at
     `loadedmetadata`** — so a Drive file with no extension in its URL flips `.mp4` → `.mp3`
     after its first play, stops matching any record, and is deleted as an "orphan". The
     name now comes from `localPath`, THE PATH ACTUALLY WRITTEN. Measured live: the two
     names really do differ, and the sweep now deletes nothing.
  3. **OPENING THE PICTURE EDITOR AND SAVING WIPED THE PICTURE.** `fpArtChoice` starts null
     every time the editor opens, so the `else` branch fired for a parent who opened 🖼️,
     looked, and tapped שמירה. Its comment claimed "an emoji was chosen" and **nothing
     checked it** — the class of bug this review exists to find. Only an explicit emoji tap
     drops the art now, and the flag is cleared per folder so one edit cannot wipe the next.
  4. ⚠️ **THE FIX FOR (1) SHIPPED DEAD FOR ONE ITERATION**: `db.pagePending`/`pageRejected`
     answer `{ items, total }`, and spreading the OBJECT throws "not iterable" — **after**
     the promise's `.catch` has had its chance, so the throw escaped to the caller's
     `.catch(() => {})` and the whole empty-folder sweep silently did nothing. The suite
     stayed green. Caught by verifying in the browser that the CONTROL folder was actually
     deleted, not by trusting that the guarded case passed. **A feature that "does nothing"
     is the signature of a swallowed throw — verify the negative AND the positive.**

- v1.0.58 — **SEARCH INSIDE A FOLDER** (user request: like the home's search, but over the
  current folder and everything nested in it).
  - ⚠️ **"NESTED" HAS EXACTLY ONE MEANING IN THIS APP, and the phrase suggests otherwise.**
    There is no folder hierarchy: folders are flat (`ch:` `cf:` `grp:` `pl:`) and there is
    no folder-inside-a-folder screen — this feature deliberately does not add one. The ONLY
    parent/child relation in the data is what an imported Drive tree leaves behind, where
    every folder of one import carries `driveRootId` pointing at its root (v1.0.58).
    ⚠️ **SUPERSEDED BY v1.0.61**, which nests an imported Drive tree for real
    (`parentFolderId`) and gives it a folder-inside-a-folder screen. The search scope is
    the SUBTREE now; the paragraph below — standing in a disc searches the whole
    collection — is unchanged and still the reason.
  - **INSIDE AN IMPORTED COLLECTION THE SCOPE IS THE WHOLE COLLECTION** (user decision
    2026-08-30), not just what hangs below the current folder. The reason is structural: the
    root row is HIDDEN from the child whenever it holds no songs of its own, so a strictly
    downward reading would leave no place from which the other 31 discs could ever be
    searched. The folder the child is standing in is searched FIRST — its own songs are the
    likeliest answer. Anywhere else the scope is the folder itself, which is what "search in
    this folder" means when nothing nests.
  - **THE CANDIDATES COME FROM `pageAnyFolder`, NOT FROM A SECOND READING OF THE FOLDER
    RULES.** That function is THE pagination entry point and already knows every folder kind
    — the 🎁/⭐/🕒 views that carry no `folderId` at all, a channel's absorbed singles, the
    trimmed loose list. Filtering the merge index by `folderId` instead would have been a
    second answer to "what is in this folder", and the two would have disagreed exactly
    where it hurts (the v1.0.21 bug that cost the child every way out of a gift). The search
    therefore sees what the folder shows BY CONSTRUCTION, and is bounded by config caps so
    it can never become "load the family's whole library".
  - **A FOLDER LOCK NARROWS IT TO ONE FOLDER, ALWAYS, AND SUPPRESSES FOLDER RESULTS.** The
    home's search is hidden while such a lock is on, and its own comment says why — "search
    reaches ANOTHER folder". A scoped search may stay (the user's decision: a child locked
    into a 700-song folder should still be able to find a song) only for as long as it
    cannot do that, and a sibling folder's result IS a way to reach that folder's grid
    through the watch screen's under-player pager.
  - Nested folder NAMES are results too (user decision), folders first — in a 32-disc
    collection, typing the disc's name should open it in one tap. Never the folder the child
    is already in, and never under a lock.
  - ONE screen and ONE ranking: it reuses `view-search` and `search.rankItems`; only
    `searchFolderId` differs, and the home's search clears it so the two can never blur.
  - ⚠️ **FOUND IN THE BROWSER AND NOWHERE ELSE**: the edit that adds the two caps to the
    config import silently did not apply (the line had moved in an earlier change), so both
    were `undefined` — a ReferenceError swallowed by the caller's `catch`, which showed as a
    search that found nothing and said nothing. `node --check` passes on that, and no node
    test executes app.js at runtime. **An unasserted string replace is how this happens; the
    fix asserts the constants landed in the import.**
  - 3 unit tests + 1 invariants test (5 wiring halves), every guard proven red on a planted
    regression (8). Verified in the browser against the real 32-disc collection: "קדיש" from
    inside disc 9 found 4 songs across the collection, a disc NAME opened that folder in one
    tap, the home's search stayed global — and with a real folder lock engaged the same
    query returned exactly 1 result, from the locked folder, with no folder results at all.

> ⚠️ **NAMING NOTE (2026-08-30): everything labelled `v1.0.58` below SHIPPED IN v1.0.57.**
> The three v1.0.57 features and both v1.0.58 trains were merged and released together, so
> `npm version patch` cut one release — 1.0.56 → **1.0.57** — carrying all of them. The
> `v1.0.58` labels in the code, the tests and the entries below are therefore the FEATURE
> TRAIN's name, not the version a family runs. Left as they are on purpose: renaming ~80
> comments would churn the whole diff for a cosmetic gain, and publishing a duplicate
> release would have shown every parent the same what's-new text twice. The next version to
> be cut is 1.0.58 and it will contain none of this.

- v1.0.58 — **THE TABLET STOPS FILLING UP, AND A FOLDER CAN CHANGE ITS FACE** (four user
  requests in one release).
  - **AN EMPTY FOLDER IS DELETED, NOT HIDDEN.** v1.0.56 deliberately kept the row (the
    parent could still rename it and file videos into it); the user asked for the opposite,
    so pure `plan.planEmptyFolderSweep` now names them and the sweep deletes them **with the
    ordinary tombstone** — absence alone is re-added by any peer that has not pulled (the
    v1.0.36 rule). Two exemptions, both load-bearing: a **DRIVE ROOT ANCHOR** is empty BY
    DESIGN (it is the row the nested refresh walks — deleting it silently stops a folder
    from ever picking up a disc added later, so the user chose to keep it), and a folder
    born in the last ten minutes belongs to a parent who is still working on it (the
    destination picker creates the row BEFORE the add finishes). The home still hides a
    zero-count folder, because a row can exist for the moments before the sweep runs.
  - **A FOLDER PICTURE HAS THREE DOORS, AND CAN BE CHANGED AFTERWARDS.** The name search
    already existed (v1.0.56); this adds the **pasted https link** and a **🖼️ button on the
    parent's folder row**. The editor REUSES the creation chooser — same doors, same byte
    cache, same rules — and only hides the destination list and the name field, which is why
    `renderFolderPick` must put both back (guard-pinned: an art edit could otherwise leave
    the next add with a picker that has nothing to pick from). `folderart.artUrlCandidate`
    is pure and https-only for the reason `weblock` is: these bytes are fetched by the app
    and land on a CHILD's screen. ONE renderer serves search results and pasted links,
    because "what if the picture will not load" is a load-bearing answer (a candidate that
    cannot render is removed, so the parent never picks a picture the folder can never show).
  - **DELETING A VIDEO CAN DELETE ITS DOWNLOADED COPY** (user request). Nothing ever did
    before, so every deletion since the app existed leaked a file into private storage.
    Asked **ONCE per batch and only when a copy is really on the device** (the user's
    decision): a download only happens after streaming fails, so most deletions raise no
    dialog at all, and a 40-video rejection raises one question rather than forty.
    `plan.deleteLocalChoice` decides; `askDeleteLocalCopies` is the one helper every
    deletion surface goes through (count-pinned), and **cancelling deletes nothing**.
    **GOOGLE DRIVE IS NEVER TOUCHED** — the text says so, and a guard bans the remote
    surfaces from that code path.
  - **THE CACHE PRUNES ITSELF, PER FILE, BY LAST PLAY** — the user chose this over their own
    "wipe everything monthly" idea once the cost was named: a blanket sweep deletes the one
    song the child plays every day, and the tablet re-downloads it on the family's mobile
    data. `localUsedAt` is the only honest clock (stamped where a cached copy is actually
    SERVED, in `prepareStreamSrc`) and is DEVICE-LOCAL like `localPath` itself — a guard
    bans it from the Drive document.
    ⚠️ **A FILE WITH NO STAMP IS GIVEN A FULL WINDOW, NEVER DELETED ON SIGHT.** Every file
    downloaded before this version has none, and reading "no stamp" as "never used" would
    wipe the whole cache the first time the sweep ran — exactly the blanket behaviour the
    decision rejected. **An ORPHAN (a file no record owns) always goes**: that is the only
    thing that can free what earlier versions leaked, and it is also what cleans up after a
    parent who answered "רק מהאפליקציה".
  - **BOTH SWEEPS RUN AFTER THE PULL AND THE DRIVE REFRESH, NEVER BEFORE** (index-pinned):
    those two ADD content, and a sweep that ran first would judge a folder empty a second
    before its videos arrived — deleting a folder full of songs, on every device.
  - **THE MANUAL CLEANER NOW MEASURES WHAT IT FREED.** It counted RECORDS holding a
    localPath and called everything "קבצי וידאו", so a parent could free 300 MB and be told
    "נמחקו 0" — audio has been cacheable since v1.0.56, and a file left behind by a deletion
    has no record at all. It reads the DIRECTORY before wiping and reports files + bytes.
  - 13 unit tests + 3 invariants tests, every guard proven red on a planted regression (16 —
    one of which fired on its own function name and had to be sharpened). Verified in the
    browser against the real app: the old empty folder swept while the Drive anchor and a
    fresh folder survived; a simulated device where the 40-day-old file and an orphan were
    deleted while the freshly-played one kept its copy; the daily throttle refusing a second
    sweep; the cleaner reporting "נוקו 3 קבצים · 5.7 MB"; a real file deletion clearing its
    record's `localPath`; and the 🖼️ editor refusing plain http, accepting an https link,
    caching its BYTES onto the folder, and handing the picker's chrome back to the next add.

- v1.0.58 — **A DRIVE FOLDER MAY CONTAIN FOLDERS OF SONGS** (user request), **and the
  "התיקיה ריקה" it used to answer was never about an empty folder** (same report).
  - ⚠️ **THE BUG FIRST, because it is the one that lied.** A folder of 28 mp3s answered
    "התיקיה ריקה". Measured against the reported folders before changing anything: the link
    parsing, BOTH network doors, the HTML parser and the media classifier were all correct,
    and four user-agents (Dalvik included) get the identical page — so it was **NOT** the
    v1.0.32 mobile-page trap. The defect is in `fetchDriveFolder`: **`files.list` answers
    200 with an EMPTY LIST — not an error — when the API key may not see into a folder
    shared "anyone with the link"**, and the keyed branch returned that as
    `{ok:true, files:[]}` from inside its own pagination loop. So the app reported an empty
    folder and **never tried the public page that CAN read it**. The interpretSheetResponse
    doctrine one level deeper: **emptiness may only be reported by a door that actually saw
    the contents** — the keyed branch now returns only when it read something, and an empty
    answer falls through. Pinned by shape (exactly one keyed return, gated on `out.length`,
    keyless door after it) and proven against a simulated empty keyed answer.
  - **A SUBFOLDER IS TOLD BY ITS LINK, NEVER BY ITS ICON.** The keyless page gives a folder
    row `<a href=".../drive/folders/<id>">` and **no `/type/<mime>` icon at all**, so the
    icon-only reading answered `mimeType: null` for every subfolder — which is why the
    parser's own header comment claiming folders were "skipped here" had never been true.
    The rule is now the same one `classify.driveFolderId` uses for a pasted link: the two id
    spaces are identical and only the URL shape separates them. `DRIVE_FOLDER_MIME` /
    `isDriveFolderEntry` are the single name for it (invariant-banned elsewhere).
  - **THE TREE IS FLATTENED INTO A LIST OF ORDINARY CUSTOM FOLDERS — one per Drive
    subfolder that holds media** (user decision 2026-08-30). The app has no
    folder-inside-a-folder screen and deliberately gains none: each row is a plain `cf:`
    folder carrying its own `driveFolderId`, so paging, search, the watch-grid chain,
    deletion-with-tombstones and the Drive sync all keep working with **no new branch
    anywhere** (invariant-pinned on `pageAnyFolder` and `nextAfter`).
  - **THE ROOT ALWAYS GETS A ROW, EVEN WITH NO MEDIA OF ITS OWN.** It holds nothing, so the
    child never sees it (0 videos = hidden, the v1.0.21 rule) — but it is what **ANCHORS THE
    REFRESH**, and the user asked for a disc added in Drive later to arrive on its own.
    Without that row nothing would ever re-walk the tree.
  - **THE REFRESH WALKS ROOTS ONLY.** Every folder of a tree carries its own
    `driveFolderId`, and the root's walk already re-lists all of them — so refreshing the
    descendants too would list a 33-folder tree **33 times over, every half hour**, on a
    family's mobile data. A descendant whose root row the parent DELETED refreshes itself
    again, or the remaining folders would silently stop updating.
  - **BREADTH-FIRST, and that is not a style choice**: the caps cut the walk off, and a
    depth-first walk would spend them on one deep branch while the parent's top-level discs
    went missing. An unreadable **ROOT** aborts (check the sharing); an unreadable **CHILD**
    sets `partial` and the walk carries on — the import is ADDITIVE, so what we could read
    is still worth having. Both facts are said out loud (the v1.0.37 rule), as is a walk cut
    short by a cap.
  - ⚠️ **A GUARD IS A THING THAT CAN BREAK, so the walk is bounded by LISTINGS PERFORMED as
    well.** Planting the removal of the `seen` cycle guard did not turn a test red — it made
    the walk **run forever**, because a Drive shortcut pointing at an ancestor re-queues an
    id that never grows `seen`, so the folder cap is never reached. A frozen app on a
    family's tablet is far worse than importing less than the folder holds; the loop now
    counts listings, so the worst a broken identity check can do is truncate.
  - Identity is the `driveFolderId`, never the title: a folder the PARENT renamed keeps its
    name across every refresh instead of being duplicated under the Drive name. Two discs
    that genuinely share a name get " (2)" (`plan.uniqueFolderTitle`, deterministic so a
    re-import lands on the same title instead of drifting a suffix upward).
  - Files route through the SAME `planDriveFolderImport` the flat import uses, so "which
    files are media / already here / removed before" keeps exactly one answer.
  - 11 unit tests + 1 invariants test (5 wiring halves), every guard proven red on a planted
    regression (15 — one of which is what exposed the infinite walk). Verified against the
    REAL reported folder through the real add form: **751 files in 32 folders in ~8s**, the
    root row hidden at 0, natural song order, 🎵 badges; the reported "flat" folder alone →
    28 files; and then the tree ON TOP of it reusing that row instead of duplicating it
    (723 new + 28 existing = 751).

- v1.0.57 — **A PAGE OF TILES TURNS WITH A FINGER** (user request: keep the blue arrows,
  and also swipe left/right on the app screen).
  - **THE ARROWS STAY, and that is not politeness**: a TV remote produces NO pointer
    events at all, so they are the only pager on Android TV — and they are what tells a
    child another page exists. The flick is added beside them, never instead.
  - **RTL: A SWIPE TO THE RIGHT IS THE *NEXT* PAGE.** The pager puts `prev` first in the
    DOM and `dir="rtl"` mirrors the row, so the ◀ "next" button sits on the LEFT: the next
    page lives there, and the finger drags the current page rightwards to bring it in — a
    Hebrew book, and Android's own RTL ViewPager. Backwards is invisible to every other
    test (the app would page fine and feel wrong), so the direction itself is pinned.
  - **ONE PURE DECISION** (`plan.swipePageAction`, node-tested; a second copy anywhere is
    invariant-banned) with four refusals: the whole TAP band (every tile is a `<button>`
    and `SWIPE_MIN_PX` must clear `TAP_SLOP_PX` by a wide margin), a vertical scroll that
    drifts sideways (the v1.0.52 collision from the other side), a finger that was parked
    on the screen, and **the first/last page, which absorb the gesture silently** — the
    arrows are `disabled` there and a page that "flips" to itself reads as broken.
  - **THE HOSTS ARE `touch-action: pan-y`, NEVER `none` AND NEVER LEFT AT `auto`.** With
    `auto` the browser claims a slightly-diagonal flick as a scroll and cancels it, so the
    feature would work only for a perfectly straight finger; with `none` the page could not
    scroll from the grid at all — the exact v1.0.50/51 bug on a new surface.
  - **THE WATCH VIEW BINDS ITS GRID ALONE**, never the view: the player owns centre-tap
    pause and double-tap seek, and a page turn must not become a fourth meaning for a
    finger crossing it. Verified: a swipe over the shield leaves the grid's page alone.
  - **A CAPTURE-PHASE CLICK SWALLOW** — the flick ENDS on a tile, so without it turning the
    page also opens that video (guaranteed with a mouse, WebView-dependent on touch). It is
    a DEADLINE, not a flag: a gesture that produces no click must not leave a live trap that
    eats the child's next real tap (proven both ways in the browser).
  - ⚠️ **TWO DEFECTS THE BROWSER CAUGHT AND THE GREEN SUITE COULD NOT**, both the kind that
    makes an app feel broken rather than wrong:
    1. **THE TIME CEILING REFUSED REAL SWIPES.** It started at 900ms as a "flick" test.
       The app flips on RELEASE and cannot track a drag live, so DISTANCE is the whole
       intent test — and a 5-year-old drags slowly and means it. Now 2500ms, documented as
       a sanity ceiling (a parked finger that wanders off a tile), not a flick detector.
    2. **A LOST GESTURE END ATE THE NEXT SWIPE.** `pointerdown` dropped the gesture whenever
       a start was still standing — written for a second finger, and in practice it
       swallowed every other swipe once an end went missing. Ends go missing for ordinary
       reasons: the grid re-renders under the finger (a sync landing, a Drive pull applying)
       so the pointerup fires on a detached node and never reaches the host, or an incoming
       call backgrounds the app mid-touch. `pointerdown` now always starts fresh, and
       multi-touch is refused by the pointerId check on the RELEASE, where it cannot poison
       the gesture that follows.
  - ⚠️ **TOOLING LESSON**: in a HIDDEN Browser pane `setTimeout` is throttled ~6× (a 150ms
    sleep measured as 937ms), which is what made defect 1 visible. Any gesture timing read
    in that pane is wall-clock inflated — measure `dt` inside the handler, never assume the
    sleep you asked for. And `git restore` during the plant cycle destroyed both fixes
    because they were UNCOMMITTED (the v1.0.56 lesson, paid twice): commit BEFORE planting.
  - 6 unit tests + 1 invariants test (7 wiring halves), every guard proven red on a planted
    regression (12). Browser-verified end to end on all three grids: both directions, the
    bounds absorbed, a vertical scroll and a tap-sized move ignored, the click swallow both
    ways, the player isolated, and a swipe right after an ABANDONED gesture still working.
    Real gesture ARBITRATION (does `pan-y` actually scroll under a finger) stays a device
    checklist item — no synthetic pointer event can prove it.
- v1.0.57 — **🕒 "נצפה לאחרונה": THE LAST X VIDEOS THIS CHILD WATCHED** (user request: a
  folder for quick access back to what they were watching, IN ADDITION to where the video
  really lives, newest first, and the parent picks X in the settings — default 10).
  - **THE THIRD DERIVED FOLDER**, built exactly like ⭐ (v1.0.40): no record carries
    `folderId:'recent'`, so it is resolved from the profile's own state map — no new store,
    no new index, **no `DB_VERSION` bump**. `playedAt` rides the `profileVideoState` row that
    already carries the gift rank, the unwrap, the resume position and the ⭐.
  - **THE NUMBER SYNCS, THE STAMPS DO NOT** (user decision 2026-08-30). `recentLimit` is a
    parenting choice and travels; `playedAt` is about the tablet in the child's hands, so
    `drive.serializeStateEntry` never emits it and **`mergeAppliedState` PRESERVES the local
    one** — that second half is load-bearing: the fold REPLACES the row, so without it every
    pull emptied 🕒 for any video the other device had touched. The resume position's rule,
    replayed, and both halves are behaviour-tested.
  - **WATCHED = 10 SECONDS OF PLAYBACK POSITION, or a video that ENDED.** Position, not
    elapsed wall-clock: it survives a pause, ignores a video sitting still on screen, and a
    resumed video is already past it (which is right — they are watching it again). The
    'ended' path is `force`d because a 6-second clip can never reach the threshold and the
    player is already torn down there. Stamped ONCE per opening: the tick fires every few
    seconds and **every write bumps `db.dataVersion()`**, which the home's folder cache keys
    off — re-stamping would rebuild the home every 5 seconds for the whole video.
  - **NEWEST FIRST — THE OPPOSITE OF ⭐, AND EACH ORDER FORBIDS THE OTHER.** ⭐ appends
    because a pre-reader navigates by POSITION; 🕒's whole promise is "what I was just
    watching is at the front". The cost is real: **THE FOLDER REORDERS ITSELF AFTER EVERY
    VIDEO**, which is why the watch screen FREEZES a snapshot on entry (`watchCtx.recent`)
    and carries it across video→video switches. A live re-read makes the chain rock: enter
    at [A,B,C], watch B → B moves to the front → "next after B" is A → watch A → "next after
    A" is B, forever. Measured in the browser: the under-player grid kept [3,2,1] while the
    live order had already become [2,3,1].
  - **`recentLimit` IS PART OF THE FOLDER-CACHE KEY**, for the same reason `profileId` is: it
    is a SETTING, so it lives in Preferences and changing it does NOT move
    `db.dataVersion()`. Without it the parent sets 🕒 to 0 and the child's home keeps the
    folder until some unrelated write happens to bump the counter. The cache key must name
    everything the derivation reads.
  - **ITS MEMBERS ARE PROTECTED FROM THE ROLLING WINDOW** (user decision) — for the active
    child AND every sibling reading a shared library, each with their OWN limit (the keys are
    computed at the call site for exactly that reason; unioning "every video ever watched"
    would gut the window). This also repairs v1.0.39's documented weakness: `posSec` is
    CLEARED by a video watched to the END, so the most-rewatched video — the one that whole
    rationale is about — carried no signal at all. A watch stamp does.
  - ⚠️ **TWO ADJACENT DEFECTS, BOTH THE SAME CLASS: a row shared by four features, rebuilt by
    a writer that knew about two.**
    1. **`db.clearPlayPosition` ATE ⭐.** It deleted the row whenever it carried no `giftRank`
       and no `unwrappedAt` — written in v1.0.32, before favourites existed, and never
       revisited when v1.0.40 put `favAt`/`favOffAt` on the same row. So a starred,
       never-gifted video watched to the END with resume on lost its star **silently**, and
       wrote no `favOffAt` either, so a peer's copy could later re-star it. The predicate is
       now pure, shared and names every field: `normalize.stateRowIsSpent`. The next feature
       to share this row extends THAT function.
    2. **THE SNAPSHOT IMPORT BLIND-PUT A TWO-FIELD RECORD OVER THE LIVE ROW**, erasing the
       child's ⭐, their resume position and their 🕒 for every video the file mentioned —
       the bug `drive.mergeAppliedState` exists to prevent on the sync path, on the path
       nobody had looked at. It folds onto the existing row now. The device-local fields are
       deliberately NOT taken from the file (the same rule the Drive doc follows).
  - ⚠️ **DEFAULT ON AT 10 — this arrives with the update for every existing family** (the
    `SCREEN_OFF_DEFAULT_MIN` precedent) and MUST ride the release notes.
  - 10 unit tests + 1 invariants test (7 wiring halves), every guard proven red on a planted
    regression (11). Browser-verified end to end through the real player and the real PIN
    gate: the stamp landing from both paths, the tile appearing after 🎁 and hidden at zero,
    the newest-first order, the frozen snapshot while the live order moved, 10 → 2 shrinking
    the folder on the child's home (which is the cache-key fix), 0 removing it, and a ⭐
    SURVIVING a video watched to the end with resume on.
- v1.0.57 — **A CALL PAUSES THE VIDEO, AND THE END OF THE CALL RESUMES IT** (user request).
  - **CALLS ONLY** (user decision 2026-08-30). Every other pause — the power button, HOME,
    the app switcher, the child's own tap — keeps the v1.0.32 behaviour exactly: the video
    waits paused and the child presses play. Auto-resuming any backgrounding would start a
    video in a pocket, in a bag, and in the middle of the night.
  - **THE LIFECYCLE CANNOT TELL A CALL FROM ANYTHING ELSE**, so the signal is the device's
    AUDIO MODE (`platform.audioMode` → new native `KidsNative.audioMode` →
    `AudioManager.getMode()`). Chosen over `TelephonyManager` for two reasons and both are
    guard-pinned: it needs **NO PERMISSION** (READ_PHONE_STATE is a runtime prompt on a
    child's tablet, to resume a video), and it catches **VoIP** — WhatsApp and friends report
    `MODE_IN_COMMUNICATION`, which a telephony listener never sees, and a tablet with no SIM
    has no other kind of call. Polled, not pushed: `OnModeChangedListener` is API 31+.
  - **TWO DOORS, AND THE SECOND IS NOT OPTIONAL.** On a modern Android an incoming call is a
    heads-up notification: the ringtone takes audio focus, the WebView pauses its own media,
    and **no `appStateChange` fires at all**. So the app watches on the lifecycle (arming at
    `onAppPause`, resuming at `onAppResume`) AND on a short poll that exists only while a
    paused video is waiting on a call. Verified live with a stubbed bridge: armed and
    resumed with no lifecycle event and no user input.
  - **ONLY AN AFFIRMATIVE `'normal'` RESUMES.** The first version read "not a call mode ⇒ the
    call ended", which quietly made `'unknown'` — a failed bridge, an APK built before the
    native method existed, a browser — mean "play it", so ANY pause would have resumed.
    Caught by RUNNING the decision matrix, not by reading it. `'other'` (call screening among
    them) is not evidence either. Both the JS wrapper and the Java default answer `unknown`,
    never `normal`.
  - **THREE MORE WAYS A VIDEO COULD HAVE STARTED ITSELF, all closed and each guard-pinned:**
    the state is re-read AFTER the bridge `await` (the child can leave, the video can change,
    a scheduled break can take the screen during it); `onAppPause` reads the playhead BEFORE
    pausing and arms only if the video was actually PLAYING (otherwise a video the child had
    paused before the call resumes after it); and the idle "עדיין צופים?" park is MARKED
    (`idleParkedAt`), so a later call cannot un-park a video the app stopped because nobody
    was watching — the empty room that feature exists to protect.
  - **ON RESUME THE SCHEDULED-LOCK CHECK RUNS FIRST**, and the order is index-pinned: a break
    that matured during the call resets nav to the lock screen, and `planCallResume` then
    answers `'disarm'` because the watch view is gone. Resuming first would leave a video
    playing behind the lock.
  - The intent is ONE-SHOT and expires after `CALL_RESUME_MAX_MS` (15 min): past that the
    call is no longer "what just interrupted us", and starting the video is a surprise noise
    rather than a convenience. Leaving the watch view drops the intent AND its poll.
  - ⚠️ **TOOLING**: a hidden Browser pane throttles `setInterval` hard (Chrome backgrounds
    them to ~1/min), so a poll-driven feature can look dead there. Read the poll's own log
    line before concluding anything — the first "it did not resume" was a missing tick, not
    a bug.
  - 3 unit tests + 2 invariants tests (7 wiring halves + java parity + the permission ban),
    every guard proven red on a planted regression (11). Java proven to COMPILE (debug apk
    built) — the text-parity tests cannot see a syntax error. A REAL call stays a device
    checklist item; the browser proved the machinery with a stubbed bridge.

- v1.0.56 — **THE PARENT CAN LOCK THE CHILD INTO THE APP, OR INTO ONE FOLDER** (user
  request: a padlock beside the home button; code to lock, code to unlock; and a timer
  whose last value is remembered).
  - **TWO MODES, ONE MECHANISM.** App mode: every folder stays open, but there is no way
    out of the app and no profile switch. Folder mode: the child sees only the folder they
    are in. Pure `plan.containmentChrome` answers ONLY containment's half of each control,
    so it can never silently cancel the kiosk out (`hideExit` is OR-ed with `exitLockOn`).
  - **HIDING BUTTONS IS NOT ENFORCEMENT.** Hardware back is swallowed in the locked folder
    and never offers the exit dialog on the home; **`openFolder` itself REFUSES any folder
    but the locked one** — a relaunch paints the home for an instant, a TV remote reaches a
    tile, and a search result carries a folder id; the watch screen's 🏠, the search
    launcher and the sites launcher all close under a folder lock; and the scheduled BREAK
    returns INTO the locked folder instead of the gallery.
  - **0 IS A REAL ANSWER ("until I unlock it"), which is why `normalizeLockMinutes` checks
    for UNSET BEFORE COERCING.** `Number(null) === 0` would turn a never-written value into
    an explicit lock-forever and silently discard the remembered default — the same trap
    `plan.screenOffMinutes` documents. Caught by its own unit test, not by reasoning.
  - **DEVICE-LOCAL, and it SURVIVES A RESTART.** Same rule as the scheduled break: a lock
    is about the tablet in the child's hands, and syncing "locked until X" would lock a
    sibling's device (an invariant bans `contain:` from drive/settings/snapshot). The mode
    and `until` stamps are read on boot, on profile activation and on resume, so a
    force-close is not an escape.
  - **THE OS PIN FOLLOWS OWNERSHIP** (`containPinHeld`, the v1.0.55 pattern) and **never
    unpins a kiosk session** (v1.0.36 — `stopLockTask` raises the device keyguard). The 5s
    tick re-asserts it, because the hold-back+recents gesture unpins with NO lifecycle
    event at all.
  - **A CORRUPTED LOCK FAILS OPEN** — deliberately the opposite of the kiosk's strict
    direction. This state is written by one device and read on every render, so junk must
    not strand a child behind a lock nobody can identify; the kiosk still contains them
    independently, so nothing is lost by erring open here.
  - ⚠️ **THREE BUGS THE BROWSER CAUGHT THAT THE GREEN SUITE COULD NOT**, each now pinned:
    a relaunch landed on the HOME with every other folder tappable (and, once fixed, landed
    in the folder with a BLANK header because `folders` was not built yet — the landing now
    awaits `renderHome` and goes through `openFolder`); releasing the lock **stranded the
    parent on the PIN screen** (`startPin`'s default onSuccess navigates by itself, so a
    handler that only does work never leaves); and the exit button was hidden ONE-WAY, so a
    kiosk-off family lost it permanently after ever using a lock.
  - ⚠️ **PROCESS LESSON, paid for in lost work**: a plant cycle was run on UNCOMMITTED
    changes and the first `git restore` destroyed ~250 lines of finished feature code.
    `git restore` is only safe on a file whose good state is already committed — check
    `git status` BEFORE the cycle. Two guards in this feature were also caught VACUOUS by
    their own plants (an `onBack` existence check that `() => false` satisfied, and a
    windowed match that reached into the NEXT `nav.register`) — both re-anchored to the
    registration's own body and re-proven.
  - 7 unit tests + 1 invariants test (12 assertions), every guard proven red on a planted
    regression (5). Browser-verified end to end through the real code gate: engage on a
    folder, hardware back refused, the watch screen's 🏠 gone and back returning to the
    folder, a relaunch landing inside it fully painted, a different folder's tile
    redirecting to the locked one, the app-wide mode keeping every folder open with the
    remembered 15 minutes pre-filled, and a release restoring every control.

- v1.0.56 — **A WHOLE DRIVE FOLDER IS A SELF-REFILLING FOLDER** (user request: paste a link
  to a shared Drive folder and its files arrive as a folder named after it; files added
  there later flow in on their own).
  - **IT IS A CUSTOM FOLDER THAT KNOWS HOW TO REFILL ITSELF** (`driveFolderId` on the row).
    No new folder kind, no new store, no new prefix — paging, parking, search, the
    watch-grid chain, deletion-with-tombstones and the Drive sync all keep working
    untouched. An invariant pins that `pageAnyFolder` never grew a Drive branch.
  - **ADDITIVE ONLY** (user decision 2026-08-29): a file the parent removes in DRIVE is
    never removed from the child's library — only an explicit in-app deletion does that.
    An unreadable listing **ABORTS and says so**; treating it as an empty folder is the
    exact shape that deleted families' libraries in the sheet era. Guard-pinned: the
    importer may not call ANY delete.
  - ⚠️ **WHICH DOOR RUNS IS AN OPERATOR SETTING, and both are measured.** On 2026-08-29
    both `files.list` and `files.get` answered `403 API_KEY_SERVICE_BLOCKED` — the KEY's own
    restriction (it was YouTube-only), not a Google-wide block, which is what
    `reason: API_KEY_SERVICE_BLOCKED` distinguishes. The project key was widened on
    2026-08-30 and re-measured: `files.get` on a bogus id now answers 404 "File not found"
    and `files.list` returns real children with sizes in ~650ms, so the KEYED path is live
    and paginates. A key that is not widened, and every keyless build, still work through
    `embeddedfolderview`; one refusal sets a SESSION memo (`noteDriveKeyRefused`) so later
    folders skip the dead keyed attempt instead of walking the whole transport ladder again
    — found by watching a real add crawl in the browser, not by reasoning.
  - ⚠️ **`files.list` ANSWERS THE CHILDREN ONLY — NEVER THE FOLDER'S NAME.** The keyed path
    therefore fetches it separately (`keyedFolderName` → `files.get` on the FOLDER id,
    which answers a folder exactly like a file). Widening the key ACTIVATED this gap: until
    then only the scrape ran, and its `<title>` carried the name for free. Without the extra
    call every API-imported folder would have been titled by the generic fallback instead of
    what the parent named it in Drive — the user's explicit requirement. Count-pinned.
  - **THE PUBLIC PAGE GIVES MORE THAN EXPECTED**: its `<title>` IS the folder's own name
    (the tile has no other keyless source for it), and each row's icon URL carries the real
    `mimeType`, so audio-vs-video needs no filename guessing. **Parsed PER ENTRY BLOCK** —
    zipping three global matches shifts every later name onto the wrong file the moment one
    entry lacks a title (proven with a planted regression). An EMPTY folder and an
    UNREADABLE page are told apart by the container class the real page always carries;
    note `"flip-entries"` does NOT contain `"flip-entry"`, which is what made the first
    version of that check answer null for an empty folder.
  - **Natural name order** (`plan.naturalCompare`), so a numbered album plays 1, 2, 10 —
    never 1, 10, 2. Subfolders and non-media are filtered.
  - **A ZERO NAMES ITS CAUSE** (the v1.0.37 rule): "no media here", "these were removed
    here before", "nothing new", "the folder is empty" and "we could not read it — check
    the sharing" are five different facts and five different sentences, test-pinned distinct.
  - `classifySourceRow` learns `kind:'drivefolder'`; a folder link can NEVER reach
    `classifyLink` — file and folder ids are identical and only the URL shape separates
    them. The old test that pinned a folder link as `'invalid'` was pinning the missing
    feature (the v1.0.26 playlist lesson) and was updated deliberately.
  - Two count-pins raised with their reasons: `refreshAfterAdd` 8→9 (a new add path) and
    `entryRefresh`'s shared render 2→3 (a third branch that writes records).
  - 5 unit tests + 1 invariants test, every guard proven red on a planted regression (4).
    Browser-verified against a REAL public Drive folder (listing, name, MIME types, and the
    honest "no media" outcome for its PDFs) and, through the same real importer with a
    served listing, the media half: natural order, correct kinds, then a refresh that took
    a NEW file while two files deleted in Drive correctly SURVIVED.

- v1.0.56 — **THE PARENT CAN MAKE FOLDERS** (user request: until now every single video
  landed in the one fixed "סרטונים נוספים" list; now each manual add ASKS where it goes,
  and a folder can be created on the spot).
  - **THE FOLDER ROW IS METADATA; MEMBERSHIP IS THE VIDEO'S OWN `folderId`** (`cf:<id>`).
    That one decision is why nothing else needed a new branch: `by_folder_sort` ranges over
    it, `db.pageFolder` pages it, `pageAnyFolder`/`nextAfter` fall through to their default
    branch exactly as `pl:` does (invariant-pinned: a `cf:` case appearing in either is a
    REGRESSION), parking via `homeFolderId` works, and the watch-grid chain follows it.
  - **THE DEFAULT IS ALWAYS FIRST AND ALWAYS 'sheet'** (`plan.folderPickOptions`): a parent
    who taps the top button gets exactly the behaviour every earlier version had. Asked on
    the three paths where the parent is STANDING THERE — paste, YouTube search, a single
    Drive file — and only AFTER every refusal (duplicate, deny-tombstone) has passed, so
    nobody picks a folder for a video that is not going to be added. **Backing out CANCELS
    the add**: it is a question, and no answer is not "the default".
  - **`nav.register('folderpick')`'s `onLeave` is what resolves the awaiting add** — every
    exit (button, hardware back, a navigation from elsewhere) settles it exactly once, or
    the caller hangs forever holding a half-finished add (the v1.0.23 chooseShareProfile
    lesson). Guard-pinned.
  - **DELETING A FOLDER ASKS ABOUT ITS VIDEOS, AND THE DEFAULT MOVES THEM.** `planOrphanGC`
    never touches a record with no `channelId` — i.e. every manual single — so a folder
    deleted without re-homing its contents leaves them filed under a folder that no longer
    exists: invisible on every screen, forever, and NOT cleaned up by anything. The purge
    answer writes **tombstones** (`deleteVideosWithTombstones`), because a raw delete is
    pure absence and every Drive merge is a union (the v1.0.39 rule).
  - **The convergence trio is copied line-for-line from `siteEntries`** (`mergeCustomFolder`
    / `mergeDeletedCustomFolders` / `customFolderOutlivesTombstone` / `planCustomFolderApply`),
    tombstone written FIRST, `preserveTimestamp` on apply, **both `buildLocalDoc` branches
    carrying the keys present-and-empty** (the v1.0.45 measurement: an absent key reads as
    "unknown", not "none"), and `purgeProfile` taking `cfDel:` with it. A second pattern here
    would be a second set of bugs.
  - **THE PICTURE IS SEARCHED, THE PARENT CHOOSES, AND THE BYTES ARE CACHED**
    ([folderart.js](www/js/folderart.js), user decision 2026-08-29). An arbitrary image
    search on a 5-year-old's tablet cannot be made safe by a query parameter, so the module
    may only PROPOSE — an invariant bans it from writing anything, and it imports platform
    alone. **Provider order is a MEASUREMENT, not a preference** (2026-08-29, live): Wikimedia
    Commons resolves the CONCEPT across languages ("דינוזאורים" → Dinosaur-plateau / Pinata /
    cake), while Openverse matched only Hebrew METADATA ("דינוזאורים" → Israeli archive photos
    of Haifa; "מכוניות" → naive paintings of Luna Park). Re-measure before reordering. The
    chosen image is stored as BYTES in the thumbs store (`cfart:<folderId>`) — the v1.0.32
    logo lesson: a stored URL 404s on a rebrand, needs the network on every render, and
    cannot work offline. `artThumbId` never travels (it names a local blob); a peer's folder
    shows its emoji until this device fetches the picture itself.
  - **`groupLibraryByFolder` gives an UNKNOWN `cf:` folder its own section**, never folding
    it into "סרטונים נוספים": a peer's folder whose metadata has not synced yet would
    otherwise tell the parent those videos live somewhere they do not, and the section would
    disagree with the child's home.
  - **A `📁` "move to folder" button on the parent's library rows** is the door for content
    that did NOT arrive through the add form (a share from YouTube, a links-file import, a
    pre-v1.0.56 library). Offered ONLY for loose/custom-folder records — a channel's video
    cannot be filed by hand, because the sync owns `ch:<id>` membership and would put it
    straight back.
  - ⚠️ **`DB_VERSION` 2 → 3.** Every `createObjectStore` sits inside its `if (from < N)`
    guard, and the invariants test now walks each guard's REAL BRACE RANGE rather than a
    fixed look-behind window (the `from < 1` block alone creates nine stores, so the first
    version of that guard failed on correct code). Verified in the browser on a real v2
    database: it opens at v3 with 11 stores and no `ConstraintError`.
  - The links file deliberately does NOT carry folder assignment (no second grammar, no
    second parser — the v1.0.38 promise); it travels in the Drive doc and the snapshot.
  - **CENTERING: `#view-folderpick` is the third user of the `.wn-wrap` skeleton and hit the
    exact bug its comment warns about** — measured pinned to the RTL right edge, fixed, and
    re-measured centered (353px both sides).
  - 12 unit tests + 3 invariants tests; browser-verified end to end through the real PIN gate:
    the v2→v3 upgrade, a folder created from a live Hebrew image search (6 relevant
    candidates, 34KB cached), the video filed into it, the tile + header art + search all
    finding it, and a delete that MOVED the video instead of orphaning it.

- v1.0.56 — **AUDIO (mp3) IS CONTENT, AND A DRIVE FILE KNOWS ITS OWN NAME** (user request:
  add a Drive link to an audio or video file and it reaches the child). Half of this
  already existed and was quietly poor: `classifyLink` has accepted Drive links since the
  beginning, `media.js` streams them and falls back to a download cache — so an mp3 from
  Drive already played, as a **black rectangle with no caption**.
  - **`media: 'audio'|'video'|null` RIDES THE RECORD**, and null is a legitimate value —
    a share, a links-file row and a peer on an older app all produce one. It is set from
    a direct link's EXTENSION, from a Drive file's fetched `mimeType`, and **corrected at
    `loadedmetadata` from `videoWidth > 0`, which is the only source that cannot be wrong**.
    It survives `mergeVideoRecord` (`s.media || l.media` — the `keepForever` lesson: `out =
    {...s}` drops the enrichment whenever the other copy wins) and the snapshot.
  - ⚠️ **`captureFrame` BURNED A BLACK JPEG ONTO EVERY AUDIO TILE, PERMANENTLY.** It sized
    the canvas `video.videoWidth || 320`, and an audio element reports 0 — so it painted
    nothing onto a 320×180 canvas and `persistThumb` stored the result, which it then
    **never retries** (`if (item.thumbId || item.thumbUrl) return`). No video track ⇒ no
    frame ⇒ null. The guard bans a NUMERIC fallback specifically: the correct early-return
    itself contains `videoWidth ||`, and the first version of that guard tripped on its own
    fix (caught by running it — the vacuous/self-tripping trap in both directions).
  - **THE AUDIO SCENE IS A CLASS ON THE SHARED WRAP** (`.is-audio` → `#audio-scene`, CSS
    only, no assets): `pointer-events:none` ALWAYS (the HUD-container invariant — proven,
    not assumed: `elementFromPoint` over the scene's centre answers `tap-shield` during
    real playback) and `z-index:1`, under the HUD and every overlay. **`cleanup()` always
    clears it** — the wrap is shared with the YouTube engine, which never touches this
    class, so a file that left it behind would cover the NEXT video.
  - **A DRIVE LINK CARRIES NO FILENAME**, so `titleFromFileUrl` was captioning tiles with
    the literal path segment (`"view"`). It now answers `''` for a Drive link, and
    `titleFromFileName` (new) names a file from its METADATA instead.
  - **[gdrivepub.js](www/js/gdrivepub.js) IS THE ONE PUBLIC-DRIVE MODULE** (the ytsearch
    precedent: an undocumented/keyed Google surface gets exactly one blast radius). It
    **never imports gauth and never sends an Authorization header** — `drive.file` is the
    only OAuth scope, it cannot read a parent's own files, and it must never grow
    (v1.0.19). Everything here works ONLY on a file shared "anyone with the link", which
    playback on the child's tablet already requires — **so an unreadable answer is ALSO
    the honest signal that the file is probably not shared, and the add says so instead of
    a reassuring ✅**. Keyed `files.get` first, the public `/view` page scraped second
    (keyless builds); both parsers TOTAL — an error envelope or a sign-in page answers
    null, never a caption. ⚠️ The shared API key needs **Google Drive API** added to its
    API restrictions (GOOGLE_CLOUD_SETUP שלב 5); a YouTube-only key answers 403 and falls
    back to the scrape — degraded, never broken.
  - **THE CACHE EXTENSION FOLLOWS THE FILE** (`media.cacheExtFor`): Android guesses a
    `file://` src's MIME from its extension, so the old hardcoded `.mp4` on an mp3 was a
    decode gamble. `LOCALPATH_RE` (the snapshot's untrusted-path whitelist) widens in
    lockstep and stays anchored.
  - **AUDIO BEHAVES EXACTLY LIKE VIDEO** (user decision 2026-08-29): screen-off/background
    pauses it, and "עדיין צופים?" applies. True background audio needs a native foreground
    service and is deliberately a separate future feature, not a silent half-implementation.
  - 13 unit tests + 2 invariants tests; every guard proven red on a planted regression (10
    plants, reverted with `git restore` — never a line-global regex).

- v1.0.45 — **APPROVED WEBSITES: a restricted browser inside the app** (user request).
  Full record: **[docs/V1045.md](docs/V1045.md)**; the maintainer's map (what lives where,
  how to extend it, the five things that break in silence): **[docs/WEBSITES.md](docs/WEBSITES.md)**
  — read that one BEFORE touching `weblock.js` or `KidsWebPlugin.java`. Until now every item a child could see
  passed `classifyLink`, one narrow boundary; this puts a BROWSER on a 5-year-old's
  tablet, so most of the work is what gets BLOCKED.
  - **TWO LISTS, AND THE SPLIT IS THE FEATURE.** One store, `siteEntries`, discriminated
    by `kind`: a **`shortcut`** (url+title+icon) is what the child sees as a tile; a
    **`rule`** (a canonical prefix) is where they may navigate and is **NEVER rendered** —
    a rule is often a sub-path or a different site entirely. Navigation is checked against
    ALL rules, so one approved site may link to another. **Adding a shortcut auto-creates
    the matching rule**, or the first link tap inside it is blocked and the site reads as
    broken rather than as an unmade setting. Scope is the PROFILE (`prof:<id>`).
  - **[weblock.js](www/js/weblock.js) IS THE SAFETY BOUNDARY** — the `classifyLink` of this
    feature, pure, one module, invariant-pinned. A `startsWith` is NOT a prefix check:
    `example.com/kids/` would admit `example.com/kids-adult/`, `good.com` would admit
    `good.com.evil.com` and `good.com@evil.com` (userinfo). So https ONLY, userinfo
    refused, host lower-cased sans `www.`, port normalized, **path compared BY SEGMENT**,
    each segment `decodeURIComponent`-ed and THEN `.`/`..` refused — that order because
    `Uri.getPathSegments()` decodes on its own, so `%2e%2e` reaches Java already as `..`.
    `matchRule` returns the LONGEST match, so a broad rule added later cannot loosen a
    section the parent kept strict.
  - **THE RULE LIVES IN TWO LANGUAGES, SO JS NORMALIZES AND JAVA ONLY COMPARES.**
    Enforcement is `shouldOverrideUrlLoading`, which the node suite cannot execute; JS
    hands over `{host, port, segments[]}` already canonical and `KidsWebPlugin` must never
    parse a prefix itself.
  - **AN `<iframe>` CANNOT ENFORCE THIS** (same-origin blocks reading `location` or
    intercepting navigation, and much of the web sends `X-Frame-Options: DENY`), and
    Custom Tabs has no hooks. Hence a native WebView — added to the decor view, NOT a
    second Activity, so lock-task (the kiosk lock) and immersive mode are unaffected.
  - **NINE DOORS, EACH A ONE-GESTURE ESCAPE**, all pinned in BOTH java copies: non-https
    schemes (`intent://` `market://` `tel:` `mailto:` open ANOTHER APP), subresources
    (ads/trackers/embedded players), downloads (an APK), `onCreateWindow`, camera/mic/
    geolocation, the long-press menu, `startActionMode` (text selection → "Web search"),
    `file://`, and mixed content. **Third-party content is STRICT by default** — same host
    or subdomain, or another approved rule's host — with a per-RULE opt-out behind a
    warning.
  - **THE PASSWORD IS TYPED ONCE**: cookies + DOM storage persist, and
    **`CookieManager.flush()`** runs on close and on `onPause` — without it the login dies
    with the process and "once" silently becomes "every time". ⚠️ SSO to another host is
    blocked by the rules, so the login door is **parent mode**: `parentMode:true` navigates
    UNRESTRICTED, behind the PIN, with a differently-coloured bar; the child inherits the
    session. Not a new capability — the parent screen already opens any URL via
    `openExternal`. An invariants guard pins that no child path can reach it.
  - **A BLOCKED PAGE IS A FIX, NOT A DEAD END**: a calm message plus a discreet "הורים"
    button → `webAddRequest` → **`startPin` in JS** → pick the grain (whole site / this
    section / this page, defaulting to the SECTION, never the whole site) → reopen on the
    blocked page. **THE PIN IS NEVER VERIFIED IN JAVA** — that would be a second
    implementation of the one check guarding the whole parent surface; an invariant bans
    the word.
  - ⚠️ **`DB_VERSION` 1 → 2, AND THE UPGRADE HANDLER WOULD HAVE BRICKED EVERY INSTALL.**
    It created all 9 stores UNCONDITIONALLY — harmless only while the version never moved.
    Measured in the browser: an unguarded bump throws `ConstraintError`, aborts the
    version-change transaction, and the app cannot open its database AT ALL. Every
    `createObjectStore` now sits inside `if (ev.oldVersion < N)`, pinned by a test.
  - ⚠️ **`buildLocalDoc` HAS TWO BRANCHES AND THE SECOND IS THINNER.** Sites are
    profile-scoped, and the `prof:<id>` pseudo-library is built separately (it already
    omitted `deletedChannels`) **and only `if (pv.length)`** — so a child with approved
    sites and no personal videos would have synced NOTHING, silently, while every local
    screen looked right. Both branches carry the collection now; guard-pinned.
  - Deletion is a **tombstone written FIRST** (`meta['siteDel:<scope>']`, max-merge, strict
    outlives, **tie = deleted**) — the v1.0.36 lesson: absence alone is re-added by any
    peer that has not pulled. `purgeProfile`'s `metaKeys` loop was filtered to `lib:`
    scopes and would have stranded these; fixed.
  - **SCREEN TIME, or the browser is a hole in it**: `armScheduledLock()` on site open;
    **`showLockedScreen` closes the viewer BEFORE `nav.reset('locked')`** (a native overlay
    would otherwise hide the lock while the child kept browsing); taps inside a native
    WebView never reach `window`, so the plugin emits a throttled `webActivity` that feeds
    `idleLastInputAt`; `tickIdleSleep` counts `siteViewerOpen`. There is deliberately NO
    "עדיין צופים?" prompt for a site — it lives inside `#player-wrap`, under the WebView —
    so the idle path just closes the viewer and hands control back to the app.
  - `sitesEnabled` is per-profile and synced, **ON unless written** (tie → off). The
    launcher shows only when it is on AND at least one shortcut exists (v1.0.21), and never
    on TV — a remote cannot drive an arbitrary website. `refreshSitesLauncher` RE-READS
    rather than trusting a cache: measured in the browser, a peer's change was otherwise
    invisible until the profile was switched.
  - **THE VIEWER IS DEVICE-ONLY AND THE BROWSER SAYS SO** rather than half-working with an
    iframe. All the chrome is browser-verifiable; the viewer is a device-checklist item.
  - The links file is deliberately untouched (its promise is "no second parser, no second
    safety boundary"). 18 weblock unit tests + 8 Drive/snapshot tests + 13 wiring
    invariants; every guard proven red on a planted regression — and the first three fired
    on their own COMMENTS, so the Java guards read comment-stripped source.

- v1.0.54 — **A FULLSCREEN VIDEO PLAYS LANDSCAPE, ALWAYS** (user request, phone report:
  with the system rotation lock on — the common phone default — fullscreen played
  PORTRAIT. Browsing not rotating on that phone is the SAME system lock and is left
  alone deliberately: the app has rotated freely since v1.0.2, and fighting the system
  outside the player would be a regression, not a feature). Decision 2026-08-25: every
  handheld device, phone and tablet alike — all content is 16:9 long-form (Shorts are
  excluded by design), so landscape is always the video's shape. A TV is excluded (no
  sensor, landscape by construction; pure helper answers null and nothing is touched).
  - **The WebView cannot override the system rotation lock; only the ACTIVITY can** —
    new `KidsNative.setOrientation`: `setRequestedOrientation(SENSOR_LANDSCAPE)` (both
    ways of holding the device) entering fullscreen, `UNSPECIFIED` (back to the system's
    own rule) leaving it — exactly what YouTube itself does. The manifest's
    `configChanges` already includes `orientation|screenSize`, so the rotation resizes
    the live WebView without recreating the activity mid-video.
  - **ONE hook covers every door**: the existing `fullscreenchange` listener (both vendor
    names) — the tile tap's auto-fullscreen, ⛶, hardware back, and a video that ENDS.
    The decision is pure `playerlogic.fullscreenOrientation({ fullscreen, tv })` →
    `'landscape' | 'auto' | null`.
  - ⚠️ **THE 'auto' RESTORE RUNS BEFORE THE WATCH GUARD, and that ORDER is the
    invariant** (index-pinned in the handler): `leaveWatch` (a video that ended) exits
    fullscreen and then navigates away, so a restore gated on `nav.isActive('watch')`
    would leave the WHOLE APP stuck sideways after every finished video, on every
    rotation-locked phone.
  - Exiting on a rotation-locked phone lands back in portrait — the system's rule, like
    every other app. Both java copies carry the method (parity-pinned: SENSOR_LANDSCAPE,
    UNSPECIFIED, runOnUiThread); `platform.setOrientation` is bridge-gated and never
    throws (browser dev = silent no-op; embedded panes deny fullscreen anyway, so the
    visible behavior is a device-checklist item). Java proven to COMPILE (debug apk
    built) — the text-parity tests cannot see a syntax error. 1 unit + 1 invariants test
    + the reshaped v1.0.43 pin, every guard proven red on a planted regression (5).
- v1.0.53 — **THE FULLSCREEN PLAYER SAYS WHAT IS PLAYING** (user request: like YouTube —
  tap the screen and see the video's name, and beneath it the channel it comes from).
  Two user decisions shaped it (2026-08-19): **FULLSCREEN ONLY** — everywhere else the
  title already sits under the player (`.watch-title`, F5) and covering the video twice
  buys nothing — and **logo + name** for the channel line (the avatar bytes are already
  cached device-side since v1.0.32; a child who cannot read gets more from the picture).
  - `#player-topbar` lives INSIDE `#player-wrap` (the fullscreen element), fades with
    `.hud-on`, and is `pointer-events:none` ALWAYS — the HUD-container invariant. The
    visibility gate is CSS-only: BOTH vendor fullscreen pseudo-classes + `.hud-on`. A
    bare `.hud-on` rule is banned by the invariants test — it would show the overlay in
    the small player too, against the decision.
  - **Driven from `openWatch`/`setWatchTitle`, never from player.js**: openWatch runs on
    every open AND every video→video switch — including the YouTube reuse path, which
    never re-runs setupHud — and the async oEmbed title fallback already carries the
    stale-fetch guard both titles need (`setBoth`). player.js touching `np-title` is
    invariant-banned.
  - **Pure `playerlogic.nowPlayingChannel(rec, folders)`** decides the channel line: the
    family's OWN folder title first (`ch:`/`grp:` folders both carry `channelId`), then
    `srcChannelTitle`, else NO line ("במידה והוא חלק מערוץ" — the user's own condition).
    **No name ⇒ no line, even with an id**: an unlabeled logo tells the child nothing.
    A playlist video names its OWNER (the v1.0.26 channelId rule); the `pl:` folder can
    never match because its channelId slot holds the playlist id, not a UC id.
  - **The logo rides the v1.0.32 byte cache** (`mountChannelLogo`): `dataset.logoChannel`
    + `planLogoDelivery` keep a slow video-A fetch out of video B's overlay, and
    `setWatchChannel` empties the host AND deletes the dataset before every mount (the
    leak guard, test-pinned). CSS `.np-logo-host:empty { display:none }` hides the circle
    until real bytes paint — late IDB/network delivery un-hides it by re-mounting.
  - Verified in the browser: both titles mirror and update through the REUSE path
    (Baby Shark → Number song, channel line followed), opacity 0 outside fullscreen, and
    `elementFromPoint` over the overlay area answers `tap-shield` — hit-transparency
    proven, not assumed. The overlay VISIBLE in real fullscreen is a device-checklist
    item (embedded panes deny fullscreen). 3 unit tests + 1 invariants test, every guard
    proven red on a planted regression (5 plants).
- v1.0.52 — **LANDSCAPE CAN FINALLY SCROLL THE WATCH PAGE** (field report, the THIRD scroll
  fix: "מסך מאוזן, יוצאים ממסך מלא, אי אפשר לגלול מטה"). v1.0.50 made the document able to
  grow and v1.0.51 landed the fullscreen exit at the top — and the report came back anyway,
  because in LANDSCAPE the player (64vh tall, centered) IS most of the screen, and the
  `.tap-shield` covering it said `touch-action: none`: the surface a finger naturally swipes
  scrolled NOTHING (portrait never showed it — the player is ~35% there and the grid below
  is the natural swipe area). Worse, the swipe's pointerup on the shield read as a TAP —
  no movement threshold existed — so a center release PAUSED the video mid-attempt.
  - **The shield is `touch-action: pan-y` now**: vertical swipes over the player scroll the
    page; taps/double-taps stay with the shield (a pan the browser claims ends in
    pointercancel, which can never reach `onTap`). In fullscreen nothing is scrollable, so
    behaviour there is unchanged.
  - **A tap is a press that did not move** — pure `playerlogic.isTapGesture` (`TAP_SLOP_PX`
    14, Euclidean, not per-axis: a diagonal must not slip through), consulted FIRST in
    `onTap`. Missing coordinates fail OPEN (an odd WebView must not lose every tap; a
    wrongly accepted tap is just the old status quo). Kills the horizontal-swipe and
    in-fullscreen-swipe pause class too.
  - **The child's finger disarms the v1.0.51 pin**: the pin exists to defeat the WebView's
    PROGRAMMATIC scroll restore, which arrives with no pointer event — but for 700ms it
    also snapped the child's own scroll back to the top ("I swipe and it bounces back").
    Any `pointerdown` (window, capture, passive) zeroes the window; every gesture that can
    trigger the exit itself (⛶, system back) completes before `fullscreenchange` fires, so
    a pointerdown seen while pinned is always a NEW, deliberate gesture.
  - **Fixed overlays got the .tour-wrap treatment** — every VIEW grows with its content
    (v1.0.50) but `position:fixed` cannot: a `.modal` card taller than a short landscape
    viewport was clipped at BOTH ends by the flex centering, buttons unreachable. `.modal`
    scrolls (`overflow-y:auto`, `overscroll-behavior:contain`, 14px padding), the card
    centers by `margin:auto`, the scrim went `position:fixed` so scrolling never uncovers
    the page behind. `.preview-bubble` is height-capped (`100dvh`-based) with
    `overflow-y:auto`, its children `flex: 0 0 auto` so the video is not squished instead.
  - Verified in the browser at 1280×800, 767×500 and 500×767 against the LIVE player: the
    shield computes `pan-y`; tap toggles play, vertical/horizontal swipes never pause,
    double-tap still seeks +10; a 613px modal on a 500px viewport keeps its top visible and
    scrolls to its buttons; every screen (home/folder/watch/pin/parent×3/profiles/search/
    guide) either fits or scrolls fully in BOTH orientations. Gesture-level pan and the
    on-device fullscreen exit remain device-checklist items (docs/TESTING.md). 5 unit tests
    + 2 config pins + 2 invariants tests, every guard proven red on a planted regression
    (8 plants).
- v1.0.43 — **LEAVING FULLSCREEN LANDS ON THE TOP OF THE WATCH PAGE** (user request). Exiting
  fullscreen is NOT a navigation: `nav.handleBack` answers `'exit-fullscreen'` and returns,
  and the HUD's ⛶ does the same — so nothing ever scrolled, and the child came back to
  wherever they had scrolled to, usually the under-player grid with the small player
  off-screen above. `nav.go` has guaranteed a top landing since the F4 fix; this is the one
  way out that never goes through nav.
  - The scroll runs **TWICE, and both are load-bearing**: immediately, because
    `requestAnimationFrame` callbacks are **SUSPENDED while the document is hidden**
    (measured — fullscreen exiting as the app backgrounds would otherwise leave the page
    scrolled), and again after `nav.transition`'s proven double rAF, because the reflow as
    the element leaves fullscreen lands after an immediate scroll and would undo it.
  - `nav.isActive('watch')` is checked at event time AND inside the deferred callback:
    `leaveWatch` (a video that ENDED) exits fullscreen and then `nav.back()`s into the
    folder, restoring its scroll — a late scroll-to-top would drop the child at the top of a
    folder they were half-way down. Verified in the browser: scrolled to 280 → exit →
    top; and a LATE event after the navigation left the folder's position alone.
  - Both vendor event names are bound (older WebViews fire only `webkitfullscreenchange`).
  - **v1.0.51: the double rAF was NOT enough on device** — Android's WebView RESTORES the
    pre-fullscreen scroll offset as the native custom view tears down, after both rAFs.
    A `scroll` listener now PINS the top for `FS_EXIT_PIN_MS` (700ms) after the exit
    (same three guards: window expired / re-entered fullscreen / left the watch view).
    Never fix this class of race with a longer timer — the pin reacts to the restore
    whenever it lands. See docs/V1045.md §18.

- v1.0.44 — **THE SHEET SUNSET IS DELETED, a month before its deadline** (user request). The
  v1.0.38 migration's whole job was one final read of the family's sources sheet plus the
  deletion of that file; `test/sunset.test.mjs` carried the seven-step checklist and all of it
  is done. What that removes from the app: the **only** Google Sheets call and the **only**
  HTTP DELETE it ever made — both now banned by an invariant, because either one coming back
  would also bring back a Google capability the app does not need.
  - **DEVIATION FROM MY OWN CHECKLIST, deliberate**: step 4 said to delete
    `migrate.planMigration`'s `legacySheetMigrated` along with `sheetUrl`/`sheetHash`. It has a
    LIVE consumer — `sync2`'s quarantine reads it to route a legacy family's unknown keys to
    `'pending'` instead of resurrecting videos they deleted in the pre-overhaul app. `sheetUrl`
    had to go (nothing clears it once the sunset is gone) and `sheetHash` was already
    vestigial; the flag stays, and does not depend on a sheet existing.
  - `sunset:<pid>` meta rows are left behind on devices that ran the migration. Deliberate: a
    dataver step to sweep a few dead bytes per profile is more machinery than the tidiness is
    worth, and nothing reads them.
  - ⚠️ **THE EARLY REMOVAL'S COST, stated because it is real**: a family that never launched
    v1.0.38–v1.0.43 three times will now never have its sheet read. The failure mode is NOT
    destruction — with the migration gone nothing deletes their sheet either, so the file
    stays in their Drive and its rows can be re-imported through the links-file paste. What
    they lose is the automatic fold of rows the sync had not already stored.

## Verification workflow

**Full guide: [docs/TESTING.md](docs/TESTING.md)** — including what a green suite does NOT
prove, and the device checklist. The short version:

1. `npm test` after any logic change.
2. Browser (`npm run serve`): full UI flows; IndexedDB migration works in-browser; sync runs against
   the real sheet through `/__proxy`. Escape = hardware-back stand-in. Fullscreen is DENIED in
   embedded panes — not an app bug.
3. Device (`npm run apk` → the `.dev` app): back button, native fullscreen, keep-awake,
   share-from-YouTube, Drive sign-in, updater. NEVER install a debug build over the release app.

## Configuration — one file

[www/js/links.js](www/js/links.js) (`LINKS`) is the SINGLE place for every external
address: donation links (`donate.paybox` / `donate.paypal` — empty string = method not
offered, both empty = donation block hidden), developer contact mail + cc + subject,
the public site (GitHub Pages from `docs/`, used by Google OAuth verification AND the
About tab's privacy button), and `updateRepo` for the updater. `donate.js`, `update.js`
(`UPDATE_REPO`) and `app.js` all read from it — never hardcode an address again; a test
pins that the consumers follow the config and that every address is well-formed.

## Current state pointers

- All 14 overhaul features are implemented (see git log stages 0-7 + fix commits).
- v1.0.55 — **THE CODE KEYPAD IS SILENT, AND THE CODE CAN BE TYPED** (user request: the
  child watches the parent enter the code, so no key may change color or stand out when
  pressed; and on TV the remote's digit buttons should type it directly).
  - **NO pressed feedback on `.key`, deliberately** — the `.key:active` rule is DELETED
    and invariant-banned (`:hover` too). The ONLY feedback is the dots row, which says
    how many digits, never which; `-webkit-tap-highlight-color` was already transparent
    globally. This is a privacy rule, not styling drift — never re-add it.
  - **Typed digits ride the SAME `onKey` pipeline** as taps. Pure `plan.pinKeyAction`
    maps `e.key` (top row AND numpad both arrive as '0'-'9' — that is why it reads
    `e.key`, never `e.code`), Backspace/Delete → ⌫, and refuses everything else so
    Enter stays with the D-pad manager (it activates the focused control — accepting it
    would double-type) and Escape stays the hardware-back stand-in. The listener is
    gated on `nav.isActive('pin')` AND `!isModalOpen()` — the recovery flow stacks
    confirm dialogs over the PIN screen, and digits must not leak into the buffer
    behind them — and never consumes out of a text field.
  - **The on-screen pad STAYS on TV** (user decision 2026-08-28): many Android TV
    remotes carry no digit buttons at all, and hiding the pad would lock those parents
    out of the parent screen forever. The D-pad focus ring on the pad therefore stays
    too (a remote cannot walk an invisible pad) — typing is how a TV parent enters the
    code without the child seeing which keys light up.
  1 unit test + 1 invariants test, every guard proven red on a planted regression.
- v1.0.55 — **THE BREAK CAN LOCK THE WHOLE TABLET** (user request: in the scheduled-lock
  settings the parent chooses whether the child may leave to OTHER APPS while the app is
  locked — today's behaviour — or the whole tablet locks until the break ends, and only
  a parent with the code can exit the app or cancel the wait).
  - **`lockTablet` — per-profile, SYNCED, OFF unless written**: a family that never opens
    the settings keeps today's behaviour exactly. Tie → true (`settings.SAFE_ON_TIE`, the
    exitLock direction — containment errs strict); junk reads as OFF (the exitLockOn
    `=== true` precedent — a corrupted value must never lock a tablet nobody locked).
  - **The mechanism is the kiosk's own OS screen pinning**, and pure
    `plan.lockScreenContainment({ kiosk, lockTablet })` is the ONE place that knows how
    the two settings interact: `hideExit` (the kiosk hides the door entirely — the
    v1.0.31 rule, unchanged), `gateExit` (the full lock keeps the door VISIBLE but behind
    the parent code), `pinTask` (pin while the break screen shows — placed AFTER
    showLockedScreen's parent-screen guard, so the OS pinning ceremony never runs over a
    parent mid-configuration), `unpinOnClear` (release when the break ends — **NEVER
    under the kiosk**, the v1.0.36 rule: a kiosk session stays pinned).
  - **THE RELEASE FOLLOWS OWNERSHIP, NEVER A RE-READ OF THE TOGGLE** (`breakPinHeld`,
    process-local, set only by a SUCCESSFUL native pin): the lockTablet setting can flip
    mid-break — settings sync — and a release gated on the setting stranded the pin for
    good when a parent toggled it off during a break (review finding). `clearScheduledLock`
    releases when the break HOLDS the pin AND pure `unpinOnClear` (= the kiosk veto,
    v1.0.36: a kiosk session stays pinned) allows it; the flag then always drops — under a
    kiosk veto the pin's ownership passes to the kiosk. The pin-release points (amends
    v1.0.36's "exactly three"): the code-gated exits — **one shared `pinGatedExit`
    ceremony** (code → unpin → exit; askExit and the break door are its ONLY two callers,
    count-pinned) — the settings toggle, the native installer, and `clearScheduledLock`.
  - **EVERY teardown goes through `clearScheduledLock`, including phase-'off'** (review
    finding): a parent zeroing `lockAfterMin` on another device syncs here, and
    `evalScheduledLock` answers 'off' BEFORE it ever reads `lockedUntil` (test-pinned) —
    the old bare `leaveLockedScreen()` left the tablet OS-pinned with a stale `until`
    stamp that would re-lock the child the moment the feature was ever re-enabled.
  - **The tick RE-APPLIES containment every 5s while the break screen is up**
    (`refreshLockContainment` — exit-door visibility AND the pin, one helper over ONE
    settings read via `settings.getSettings` + `breakContainment`, idempotent, gated
    natively by v1.0.36's `inLockTask`), for two measured reasons: the hold-back+recents
    gesture unpins WITHOUT backgrounding the app, so the kiosk's resume re-arm never
    fires and the tick is the only chance; and the settings SYNC, so a parent flipping
    them on another device mid-break otherwise leaves a STALE exit door until the next
    break — found in the browser, not by reasoning. **A code screen stacked over the lock
    keeps the re-assert alive** (review finding): showLockedScreen bails on its pin-view
    guard, so without the tick's `pin`+`breakPinHeld` branch a child could tap 🚪, leave
    the code screen up, gesture-unpin and walk out for the rest of the break — while a
    parent-gate PIN with no break pin held still never gets the OS ceremony.
  - **Two code-gated doors on the break screen** (user decision 2026-08-28), both
    STACKED, never `replace` (review finding: replace made CANCEL land on the gallery
    until the next tick — a spammable hatch): 'פתיחה להורים' (code → cancels the break)
    and '🚪 יציאה מהאפליקציה' — FREE when only the app locks (today's families keep
    their exit), `pinGatedExit` when the tablet locks — **and the break keeps RUNNING
    for the child**: the `:until` stamp persists, so reopening the app lands back on the
    lock. The door reads the FULL containment AT TAP TIME and SELF-HEALS under the kiosk
    (re-hide, no exit) — a tap beating the 5s refresh after a remote kiosk-flip must not
    exit through a stale button.
  - ⚠️ Known bounds, stated in the settings hint: unpinning can raise the DEVICE's own
    lock screen ("ask for PIN before unpinning", a system setting the app cannot read —
    the askExit consequence, except here it can land with nobody present when the break
    expires by itself); a REBOOT escapes any screen pinning (Android — the lock
    re-engages when the app reopens, the same bound the kiosk always had); and turning
    the toggle OFF mid-break deliberately does NOT unpin (strict direction) — the pin
    releases at break end or through the code-gated exit.
  - **THE REVIEW PASS IS PART OF THE RELEASE** (8 finder angles + verification over the
    full diff; every fix below is guard-pinned and its guard proven red):
    - Two GLOBAL-REGEX plant-reverts had corrupted UNRELATED lines and shipped green —
      `refreshDonateUi` gained a `contain.hideExit` free variable (a swallowed
      ReferenceError that killed the help block + the 30-day donate nudge forever) and
      `enterParent` gained `|| isModalOpen()` (a CORRECT code entered while an update
      prompt resolved mid-await was silently eaten, buffer consumed). Both reverted;
      an invariant now pins that enterParent never consults isModalOpen. LESSON: revert
      a planted regression with git restore or an anchored whole-file substitution,
      NEVER a line-global regex — and re-read the full diff after any plant cycle.
    - The first ordering guard anchored `indexOf` on a COMMENT (the v1.0.45 comment
      names `nav.reset('locked')` before the call does) and the release guard's
      `/unlockTask/` was satisfied by a comment — both vacuous, the exact trap
      TESTING.md names. The lock guards now read COMMENT-STRIPPED source (`CODE`)
      through anchored `fnSlice` (a rename fails as "lost the anchor", never as a
      phantom regression).
    - A held remote digit (~30/s auto-repeat, the dpad.js lesson) could fill BOTH setup
      steps and silently mint '7777' as the family code — `e.repeat` is refused.
    - The stale-door paint (containment resolved AFTER `nav.reset`), the phase-'off'
      teardown, the pin-over-code-screen suspension, and the mid-break toggle-off
      stranding — all above, each with its own guard.
  1 unit + 1 settings-tie + 1 invariants test (10 wiring halves), plus getSettings and
  evalScheduledLock-off pins; across both v1.0.55 features every guard was proven red
  on a planted regression (26 plants total, incl. the review pass).
- v1.0.40 — **⭐ מועדפים: THE CHILD'S OWN MARK** (user request 2026-08-11: any video the child
  taps ⭐ on appears in its own folder at the top of the home, IN ADDITION to where it lives,
  and is never deleted automatically; a second tap removes it).
  - **IT ALSO FIXES v1.0.39's WEAKEST POINT.** The window's automatic belt was `posSec`, and
    a video watched to the END clears its position — so the most-rewatched video carried no
    signal at all. A star is a STATEMENT, not a guess, and it is now the strongest member of
    `protectedWindowKeys`.
  - **`favAt` + `favOffAt`, AN LWW-ELEMENT SET** (`plan.favActive`, the `db.denyActive`
    pattern). A removal is an EVENT, never a cleared field: with a single `favAt`, un-starring
    on the tablet would be undone by the phone's stale copy and the video would walk back
    into ⭐. Later event wins; a TIE is NOT a favourite (a star the child taps again is a
    shrug, a video that refuses to leave is the app disobeying them). `mergeFavState` is
    max-per-field, so it is commutative and idempotent.
  - **TWO FUNCTIONS WOULD HAVE DROPPED IT IN SILENCE**, and the feature would have looked
    device-local: `drive.serializeStateEntry` was an if/return chain ("whichever field
    wins"), so a star on an already-opened video — i.e. almost every one — never reached the
    document; and `mergeAppliedState` returned `null` unless the REMOTE carried an
    `unwrappedAt`, so a favourite-only entry was discarded on pull. Both now carry the
    favourite half, and the fold preserves the local position AND a local `giftRank`.
  - **NO NEW INDEX AND NO `DB_VERSION` BUMP**: the ⭐ folder is derived from the profile's
    state map, which `loadGiftStates` already holds in memory for every render. `db.setFavourite`
    is a read-modify-write on ONE row so it cannot disturb the gift/unwrap/resume fields.
  - **ORDER IS `favAt` ASCENDING — a new star is APPENDED** (the user's decision). A
    5-year-old navigates by POSITION, not by title; newest-first would move every video they
    already know each time they add one.
  - ⭐ is pushed SECOND in `buildFolders`, right after 🎁, and hidden at zero (a tile that
    opens an empty grid is the v1.0.21 bug). Both `pageAnyFolder` AND `nextAfter` learn the
    kind — the existing invariant that they cover the same set now includes `'fav'`, so the
    chain can never disagree with the grid. ⭐ IS chained (unlike 🎁): watching favourites
    one after another is the point of the folder.
  - The ⭐ pager's self-heal clears only the FAVOURITE fields. The gift folder may delete the
    whole state row (a rank is its whole point); doing that here would erase `unwrappedAt`
    and RE-GIFT a video the child already opened.
  - The button lives in `.watch-top` next to 🏠, **OUTSIDE `player-wrap`** — the HUD's tap
    model (centre tap = pause, double tap = seek) has been broken more than once, and a real
    `<button>` there is also what the TV remote reaches. No PIN and no confirm: it is not
    destructive in either direction.
  - **A SIBLING'S STAR PROTECTS TOO** (`protectedWindowKeys({ statesByProfile })` +
    `db.loadVideoStates`): on a legacy shared library one child's window must never prune the
    other child's favourite — the same cross-profile rule `db.deleteVideoStates` follows.
  - ⚠️ **NO CAP, by the user's decision** (2026-08-11) after the consequence was stated: a
    child who stars a great many videos narrows what the rolling window can ever propose. A
    channel whose whole over-window set is starred simply produces no notice, which is the
    honest outcome — there is nothing to offer.
  - **THE FOLDER ART** (user request; corrected in v1.0.42 — I had it backwards). **⭐ STAYS
    THE FAVOURITES FOLDER'S MARK**: a star IS the universal "favourite" sign and was never
    what collided. The hand-authored SVG scene belongs to the LOOSE-SINGLES folder
    ("סרטונים נוספים"), which is what used to wear that star — a mixed-bag folder gets a
    mixed-bag picture (rainbow, rocket, horse, two children), with 🎬 as its fallback. Two constraints decided the drawing and the first draft broke both: it renders in a
    104px circle (72px under 560px), so a shape must be ~35 of 120 units to read at all (the
    draft's 22-unit faces came out ~7px, i.e. mud); and the circular clip cuts anything past
    ~52 units from the centre (the draft's sun and second child were sliced). `mountFolderArt`
    keeps the emoji as an `onerror` FALLBACK — a stale WebView cache must degrade to ⭐, never
    to an empty circle. An invariants test pins that the asset SHIPS, that it is
    self-contained (no xlink/image/remote url/font/script — the app runs from file://), and
    that the fallback exists.
  - **⭐ IS A VIEW THE CHILD CAN EMPTY FROM INSIDE IT**, which nothing else in the app can do:
    un-starring the video they are watching removes it from the very list the under-player
    grid is paging, and with one favourite that left an EMPTY grid and then an empty folder
    screen. `renderWatchGrid` falls back to where the video actually LIVES
    (`homeFolderId || folderId`) when ⭐ runs dry — the same fix 🎁 needed in v1.0.21, for the
    same reason (a gift leaves 🎁 the instant it is unwrapped). Verified in the browser: the
    grid went 1 → 3 tiles (the channel) instead of 1 → 0.
  - **TAP → FULLSCREEN IS NOW PINNED** (the v1.0.2 rule had no test for 38 releases). Every
    feature since has added lines to `openWatch` and to the tile handler, and ONE `await` in
    front of either silently costs the child fullscreen — a symptom node cannot see. The guard
    checks the tile handler is neither `async` nor awaiting, and that nothing is awaited
    between `openWatch`'s entry and `enterPlayerFullscreen()`. Measured with a REAL tap in the
    browser: the request reaches `#player-wrap` with `navigator.userActivation.isActive` TRUE.
  - **TV AUDIT** (v1.0.40): the ⭐ makes `.watch-top` a three-button row; verified in `tv=1`
    that all three are real, visible `<button>`s, that the remote reaches the star (up from
    the player, then left), and that `html.tv button:focus` covers it. ⚠️ WHILE AUDITING,
    `getComputedStyle` reported `outline-style: none` on ALL THREE — including two untouched
    buttons. That was **`document.hasFocus() === false`** in a background pane, so `:focus`
    matched nothing: an artifact, not a bug (the same class as the preview browser's fake
    image failures, v1.0.24). Verify a focus ring only in a pane that holds focus.
  - Verified end-to-end in the browser: ☆ → ⭐ → ☆ → ⭐ with the stored LWW timestamps, the
    home ordering 🎁 → ⭐ → 📺, the video present in BOTH ⭐ and its channel folder, and a
    window of 1 over 8 videos proposing seven — never the starred one. 8 unit tests + 4
    wiring invariants, every guard proven red on a planted regression (one of them caught
    VACUOUS on its first plant and sharpened).
- v1.0.39 — **THE ROLLING WINDOW: the library stops growing forever, and NOTHING is ever
  deleted without the parent answering** (user request 2026-08-09: "I want to stay up to
  date with the newest videos" → their own conditions: *tell me which channel, let me mark
  what not to delete, or wipe the channel and keep only new ones*).
  - **THE FRAMING CORRECTION THAT CAME FIRST, and it was measured**: the per-channel cap
    does NOT block new uploads. A folder at 500 — or at 3000 — accepts fresh RSS entries
    (5 offered, 5 imported). The ceiling that eventually stops new videos is
    `MAX_ITEMS_TOTAL`, and it stops them **for every channel at once**. So this feature
    bounds GROWTH; it is not a fix for "new videos do not arrive".
  - **`keepNewest` is per-profile, SYNCED, and 0 (OFF) unless written.** The opposite
    default to `screenOffAfterMin`, deliberately: it is the only setting in the app that
    deletes the CHILD's content, so it may never arrive with an update. Pure
    `plan.keepNewestPerChannel` reads every unusable value — including a window below the
    10 minimum — as OFF: a mistyped `1` must not propose emptying a folder.
  - **THE SYNC NEVER DELETES FOR THE WINDOW.** `plan.planChannelWindow` PROPOSES (live
    records only — pending/rejected are parked and belong to the approval queue and its
    30-day purge), the מקורות tab NAMES the channels that are over, and the only code that
    deletes sits behind a `confirmKid`. An invariants test bans any other module from even
    mentioning `planChannelWindow` or `deleteVideosWithTombstones`.
  - The review reuses `view-pick` with the MIRRORED default: rows arrive **unticked**
    (they are the ones proposed for deletion; a tick means "keep forever"), where the
    approval picker starts all-ticked. Two answers: delete those over the window, or
    `pick-alt` — delete every video of the channel and let RSS repopulate it ("only new
    from now on"; the backfill is already finished for a subscribed channel).
    `pickHandlers.keepOpen` exists because a CANCELLED confirm must leave the parent on the
    list with live buttons — the shared wiring nulls the handlers and navigates back.
  - **`keepForever` is GROW-ONLY through `normalize.mergeVideoRecord`** (`s.keepForever ||
    l.keepForever`). `out = {...s}` alone loses it whenever the other copy wins — a peer
    with an older `addedAt` becomes the survivor, and the fresh sync candidate carries no
    flag — and the failure mode is a protected favourite quietly becoming deletable.
  - The prune uses **`db.deleteVideosWithTombstones`** (`reason: 'window-prune'`), chunked.
    A tombstone is NOT optional: a raw delete is pure absence and every Drive merge is a
    union, so a peer would re-push every pruned video (the v1.0.36 lesson). Consequence to
    state out loud, and the confirm does: a pruned video returns only by re-adding the
    channel (`app.offerDeniedRestore`, v1.0.37).
  - **THREE DEFECTS THE BROWSER CAUGHT AND REASONING DID NOT** — all three would have
    shipped green:
    1. `giftStates` is a **Map**, and the first version read it with `Object.entries`, so
       the child-side protection matched NOBODY.
    2. **`unwrappedAt` IS NOT A WATCH SIGNAL.** `planGifts`' baseline stamps it on every
       live record that did not become a gift, so after one sync nearly the whole library
       carries it — trusting it made the feature a measured no-op (a 60-video channel 40
       over its window proposed ZERO). The app has no play counter; `posSec` (resume) is
       the only honest signal, so **the parent's ticks are the real protection**.
    3. `pick-alt` deleted videos the parent had ALREADY marked keep-forever — a marked
       video is not proposed, so it never appears in the list and cannot be re-ticked.
       `allLive` now excludes `keepForever`.
  - **THE PROPOSAL IS RE-READ AT COMMIT TIME.** It is computed when the review OPENS, and a
    sync, a Drive pull or the parent acting elsewhere can move a video in between (approved,
    rejected, protected, already gone). Writing a `window-prune` tombstone for something
    that is no longer a prunable live record would permanently deny a video this dialog
    never asked about; the toast reports what was ACTUALLY removed, not the pre-confirm
    intent.
  - `keepForever` also travels through the SNAPSHOT: the export carries full records, and
    the import (which builds an explicit record) used to drop it, so a restore silently
    unprotected every favourite — the same class as the `srcChannel*` fields that function
    already carries for exactly that reason. It stays SPARSE (never written as `false`).
  - `settings.SAFE_ON_TIE_MAX` — a numeric tie-break for `keepNewest`: on an exact `at`
    collision the LARGER window wins, because the generic fallback orders by STRING and
    would prefer `"9"` over `"200"`. Too large keeps videos nobody wanted; too small
    proposes deleting videos the child watches (the resolveCuration asymmetry).
  - ⚠️ KNOWN CONSEQUENCE, not a bug: on a LEGACY shared library (`lib:<hash>`, several
    profiles on one sheet-derived scope) the setting is per-child but the CONTENT is shared,
    so one child's window prunes the shared folder for the siblings too. The settings label
    names the child (`keep-newest-owner`) and every deletion is reviewed per channel, so
    nothing happens unseen — but the effect crosses profiles.
  - **THE ADVERSARIAL PASS FOUND FIVE MORE, and the first one was severe** (all fixed,
    all pinned):
    1. **ORPHAN GIFT STATE JAMS 🎁 FOREVER.** `planGifts` counts `outstanding` straight out
       of `profileVideoState` — `giftRank && !unwrappedAt`, records or no records — and stops
       gifting at `outstanding >= baseline`. Pruning a handful of UN-OPENED gifts therefore
       meant the child never received another one, and `planGiftRunawayRepair` cannot rescue
       it (it no-ops below its 60-record floor). The 🎁 tile counts the same index, so the
       orphans also promised a folder that resolved to nothing, and `serializeStateEntry`
       would have carried them in the Drive doc forever — in a feature whose purpose is
       bounding growth. `db.deleteVideoStates` now clears them for **every profile that reads
       the library**, not just the active one (a legacy shared scope jams a sibling too).
    2. **`pick-alt` deleted the `posSec`-protected half** — the exact twin of the
       keep-forever bug: protected ⇒ never proposed ⇒ never rendered ⇒ impossible to tick.
       ONE `guarded` set now gates the proposal AND the wipe pool.
    3. **`SAFE_ON_TIE_MAX` turned an explicit OFF into ON**: 0 is not a small window, it is
       off, so it wins the tie before the max rule.
    4. **A throw inside `commit` was a silent dead end** — `settled` was released only on a
       cancelled confirm, so any failed write left both buttons inert with no message.
       try/catch releases it and says so.
    5. **The review could be opened twice** (its prelude does two library reads before
       navigating): the second open repainted the list and replaced `pickHandlers`, and the
       `nav.go('pick')` then nulled the LIVE handler — a zombie screen with dead buttons.
       One-at-a-time guard.
    Plus the honesty fixes the feature's own rules demanded: pure `plan.pruneConfirmText`
    names the rows the parent could NOT see (`hidden`), says when the folder will empty and
    vanish from the child's home, and states the way back as **not guaranteed** (re-adding
    means remove-then-add, whose orphan sweep takes the channel's remaining records; the
    backfill re-arms only when no other library subscribes; a keyless install only sees the
    RSS window). The borrowed `view-pick` chrome is retargeted (🧺, "להשאיר הכול") instead of
    heading a deletion screen with a green ✅.
  - ⚠️ **`posSec` IS A WEAK BELT, and the reason is worth knowing**: a video watched to the
    END clears its position (`resumeSaveDecision` → 'clear'), so the most-rewatched video —
    the one the rationale is about — carries no signal at all. Only ABANDONED videos are
    belted. The app has no play counter; the parent's ticks are the protection.
  - Verified end-to-end in the browser through the real PIN gate: 60 live + window 20 → 40
    proposed → two ticked → confirm CANCELLED leaves 60 records, 0 marks and live buttons →
    confirmed leaves exactly 22 (20 newest + 2 marked), 38 `window-prune` tombstones, and
    the notice disappears. The wipe path verified to honour an earlier mark (28 of 30).
    20 unit tests + 11 wiring invariants, every guard proven red on a planted regression.
- v1.0.38 — **THE GOOGLE-SHEETS SOURCES LIST IS GONE** (user request). Full record:
  **[docs/V1038.md](docs/V1038.md)** — read it before touching `sunset`, `linksfile` or
  `libraryId`. The short version, because each line is an invariant elsewhere in this file:
  - The sheet was a SECOND SOURCE OF TRUTH (read every sync, DELETED what vanished from it,
    written back through a durable queue) — the root of fixes in v1.0.10/12/18/19/20/26/32/34.
    The sources were always in the database; removing it added **0 bytes** to the Drive doc.
    Doc COMPACTION (614→175 B/record) was deliberately left out: it is a one-way format
    change, and bundling it would make a sync regression impossible to attribute.
  - **The links file** ([linksfile.js](www/js/linksfile.js)) is the bulk door and the way a
    library moves between devices/accounts. It reuses the OLD SHEET'S ROW GRAMMAR as text, so
    there is no new parser and no second safety boundary (`parseCsv` → `parseSourceRows` →
    `classifySourceRow`) and a CSV pasted from an old spreadsheet still imports. Export writes
    CANONICAL links only — never a video's stored `srcUrl`, which can carry `&list=` and read
    back as a PLAYLIST — and only records no subscription reproduces (514 records → 4 lines,
    measured). Import has TWO doors (picker + paste; Android TV has no picker at all) and does
    NOT route through `addClassifiedRow`: that is one dialog per channel and one forced sync
    per video. Delivery is write-then-share (`EXTERNAL` is permission-free; the new native
    `shareFile` exists because `shareText` cannot attach a file).
  - **THE MIGRATION IS DELETABLE AND A DATED TEST SAYS WHEN** ([sunset.js](www/js/sunset.js),
    ⏳ **delete after 2026-09-10**; `test/sunset.test.mjs` fails on that date and carries the
    checklist). It runs between the pull and the sync in `entryRefresh` — NOT in `dataver`,
    which blocks boot behind a faded splash and means "run once" where this needs three
    attempts across launches. Its two irrecoverable-loss guards: a channel with a v1.0.36
    tombstone is NEVER re-subscribed by the final read (a sheet row has no timestamp and
    `putLibraryChannel` stamps a fresh one that would beat it), and `interpretSheetResponse`
    keeps every refusal because a wrong `[]` now forgets the sheet and then PERMANENTLY
    deletes a file full of rows. Exactly one `files.delete`, on a FILE id — the folder is
    never touched, because under `drive.file` we cannot prove it is empty.
  - Two latent bugs the removal exposed and fixed: the orphan sweep never ran for a sheet-less
    profile, and `profileSources` carried no entry without a `sheetUrl` (a restored migrated
    family would have landed on an empty home over a full database).
- v1.0.37 — **"הערוץ נוסף אבל אין בו סרטונים" WAS NEVER ABOUT THE CHANNEL** (@BARDAK613,
  the FIFTH report of this sentence; v1.0.28/29/31/32 each fixed a real resolution bug and
  none of them was this). **RESOLUTION IS FINE** — measured live on the reported channel:
  `channels.list?forHandle` → the right id, the DESKTOP scrape (`externalId`) → the right
  id, the MOBILE scrape (the RSS `href`, v1.0.32) → the right id, UULF → 97 long-form
  videos, RSS → 13. The zero came from `planMutations`, and it came out SILENT:
  - **THE CAPS WERE DEAD CONSTANTS.** `config.js` has exported `MAX_ITEMS_PER_CHANNEL` /
    `MAX_ITEMS_TOTAL` since the overhaul with **ZERO consumers** (proven by a sweep, now a
    test). The binding values were the literals `500`/`5000` written into each profile's
    `sources` row the day it was created — six copies across app.js, drive.js, share.js,
    sync2.js, migrate.js — so editing config.js changed nothing, no parent could raise the
    ceiling, and a library at 5000 dropped **every candidate of every new channel, forever**
    (measured: 98 real candidates in, `capped: 98`, 0 puts). A parent with 16 channels is
    plausibly there, which is why it "kept coming back and was never solved".
  - `plan.effectiveCaps(src)` is now the ONE source: **config is the FLOOR**, which is what
    heals the rows already frozen at 5000 without a migration; a stored value wins only when
    HIGHER (shrinking a family's library from a stale row is the same silent loss).
    `MAX_ITEMS_TOTAL` 5000 → **12000, on a measurement** (browser, real records:
    `loadMergeIndex` 114ms @5000 / 229ms @10000 / 468ms @20000, paid once per
    write-generation thanks to the v1.0.20 buildFolders cache; paging stayed FLAT at
    2.8→7.2ms because it is index-ranged).
  - **A DROP IS NOW ATTRIBUTED, AND A ZERO NAMES ITS OWN CAUSE.** `counts.capped`/`denied`
    were computed since the overhaul and thrown away by every caller, so "the library is
    full", "these videos were removed before" and "this channel genuinely has none"
    produced the IDENTICAL sentence. `planMutations` returns `drops.byChannel`,
    `syncLibrary` returns it, `importChannelAndAsk` passes it to `diagnoseEmptyChannel`,
    and `channelAddOutcome` names the ceiling (with the count and the way out) or the
    tombstones. A **PARTIAL** cap is reported too — "12 ממתינים" out of 98 is the same lie
    in miniature.
  - **ATTRIBUTION COUNTS UNIQUE KEYS, NOT DROP EVENTS**: one run offers the same video via
    the RSS window, the UULF backfill AND the playlists pass, so the first version told the
    parent "250 מהסרטונים שלו הוסרו" about a 98-video channel (measured). Attribution is
    keyed by BOTH `channelId` and the folder's source id — a playlist video keeps its OWNER
    in `channelId` (v1.0.26), so matching on channelId alone finds ZERO for a playlist,
    the exact shape of the pendingKeysOfChannel bug.
  - **A REMOVED BACKLOG HAS A WAY BACK** (`app.offerDeniedRestore`). A deny tombstone is
    revoked by exactly one thing — the SHEET re-adding the key (v1.0.10) — and a channel
    video has no sheet row, so one in-place delete or the 30-day purge of a rejected record
    (v1.0.26) made that channel unimportable FOREVER, on every device. It is never revoked
    automatically (a parent who removed three bad videos must not get them back for
    re-subscribing — the v1.0.23 rule): the parent is ASKED, with the count, while standing
    right there, which is the same explicit act the sheet re-add stands in for.
  - **LESSON, now a test**: a constant with no consumer is a lie. Both `MAX_ITEMS_*` are
    pinned to having a live importer, and the cap path is pinned against reading
    `src.maxItems*` again. 7 behavior tests + 4 wiring invariants; every guard proven red on
    a planted regression (the unique-key guard's first plant did not even apply — caught by
    re-checking, the vacuous-guard trap).
- v1.0.36 — **A DELETED CHANNEL FINALLY STAYS DELETED** (field report: "אני מסיר ערוץ
  והוא חוזר אחרי זמן מה", multi-device account). `libraryChannels` deletion was pure row
  ABSENCE — no tombstone anywhere — and every Drive merge is a UNION, so any peer (or any
  stale doc, including this device's own inside the 60s push-debounce window) silently
  re-subscribed the family to the channel the parent threw out. The exact disease
  `deletedProfiles` and the video deny-list already cured; channels never got the
  treatment.
  - **`deletedChannels` tombstones** ({channelId: deletedAt}, meta key `chDel:<lib>`),
    written INSIDE `db.deleteLibraryChannel` BEFORE the row delete (a crash in between
    must keep the intent). LATEST deletion wins the map merge (`drive.mergeDeletedChannels`
    — deliberately unlike profiles' min-merge: a channel CAN be re-added and deleted
    again). A row outlives the tombstone only when its own `updatedAt` is STRICTLY newer
    (`channelOutlivesTombstone`): a deliberate re-add (sheet row / in-app add / snapshot
    import / moveScope re-attach — all stamp fresh) wins; a TIE deletes (resurrection is
    the betrayal, re-hiding a re-add is a complaint — the resolveCuration rule).
  - The tombstones ride each library in the Drive doc (additive — an older app ignores
    them, and a doc WITHOUT the key filters nothing), `mergeDbFiles` filters the union
    against them, and `applyRemoteDoc` routes libraryChannels through pure
    `planChannelApply`: adopt the merged map FIRST, delete local losers WITHOUT
    restamping (the preserveTimestamp lesson — apply-side passes `tombstone:false`),
    and refuse to put a stale doc's rows. The pull path (`pullDrive`) applies the RAW
    remote doc, so the apply-side filter is load-bearing, not belt-and-braces.
  - `moveScope` passes `tombstone:false` (a move is not a parental deletion) and its
    re-put deliberately stamps fresh so re-attaching a sheet outranks old tombstones;
    `purgeProfile` deletes the `chDel:` meta key with the other per-library bookkeeping.
  - The sheet layer is unchanged: the queued-delete guard (v1.0.10) still blocks
    re-subscribe while the row-removal op is in flight, and a row STILL PRESENT in the
    sheet legitimately re-adds (presence is truth) — with a fresh stamp that beats the
    tombstone by design.
  - 8 behavior tests in gdrive.test.mjs (both merge orders, re-add, tie, older-app docs,
    idempotence, apply plan, serialization) + 2 wiring invariants, every guard proven
    red on a planted regression.
- v1.0.36 — **THE KIOSK PIN NEVER RELEASES MID-SESSION, AND THE UPDATER RUNS UNDER IT**
  (two field reports, same root: `stopLockTask()` raises the DEVICE keyguard on many
  devices — "lock device when unpinning" is a system setting the app can neither read
  nor change).
  - `applyExitLock` (profile activation, and now the resume re-arm) only ever PINS.
    Switching from a locked child to an unlocked sibling used to lock the whole TABLET
    mid-switch; now the session stays pinned and the unlocked profile keeps the exit
    button as its way out — containment errs STRICT, never loose, and unlocked→locked
    still pins immediately. The release points are exactly: the code-gated exits (ONE
    shared `pinGatedExit` ceremony — `askExit` and, since v1.0.55, the break screen's
    exit door; two callers, count-pinned), the settings toggle, the native installer —
    and since v1.0.55 the END OF A SCHEDULED BREAK (`clearScheduledLock`: the break's
    OWN pin only, `breakPinHeld` ownership + the `unpinOnClear` kiosk veto, so a kiosk
    session still never unpins mid-session).
  - Native `lockTask`/`unlockTask` are GATED on `getLockTaskModeState` (one
    `inLockTask()` gate): a redundant unpin keyguards the tablet; a redundant re-pin
    re-runs the pinning ceremony on some OEMs. `isTaskLocked` reads the same gate.
  - `installApk` unpins DEFENSIVELY on the SAME UI-thread hop that starts the installer
    — Android silently refuses new tasks over lock-task mode, so with the kiosk ON the
    update button did nothing. A cancelled install resumes into the `onAppResume`
    re-arm (safe on every resume precisely because `applyExitLock` never unpins).
  - Both java copies (android/ + native-reference/) carry the change; `invariants.test.mjs`
    pins all four halves, each proven red on a planted regression.
- v1.0.34 — **A SHEET-LESS PROFILE GOT ITS DOOR BACK** (user request: the sources tab
  showed a DEAD copy-link button over "אין רשימת מקורות"). When the active profile has no
  sheet, `#remote-copy` is replaced by `#remote-connect` (exactly one of the two, pure
  `plan.sourcesPanelActions`) which opens **the SAME wizard as profile creation**
  (`openSheetSetup(p, { fromParent: true })`) — create a new list / join a sibling's /
  **pick from the app-created lists found in Drive** (`sheetwrite.listAppSheets`, new).
  Invariants guard pins the routing, proven against a hand-rolled-putSources plant.
  - **PASTING AN EXTERNAL SHEET STAYED OUT, deliberately** (user decision 2026-08-07,
    after the v1.0.19 wall was explained): under `drive.file` a hand-made sheet cannot
    even be READ, and re-adding the `spreadsheets` scope brings Google's unverified-app
    scare screen back for every family. The Drive picker covers the honest cases —
    reinstall / second device of the same account — which the join-by-profile buttons
    cannot see.
  - **A FAILED LISTING IS NEVER AN EMPTY ONE** (`sheetwrite.interpretFileList`, the
    interpretSheetResponse/interpretDriveList doctrine): pretending emptiness would push
    a parent into creating a DUPLICATE family list. `ok:false` with a token shows "לא
    הצלחנו לבדוק"; `no-token` stays silent — the listing runs as SILENT enrichment when
    the wizard opens, and a family that skipped the Google connect must not get an
    uninvited sign-in dialog. A stale answer may not paint into a wizard that moved on
    (the logoTarget lesson), and dedupe is by `util.canonicalSheetKey`, never the raw
    URL — the same file joined via two URL forms must land in ONE `lib:` scope.
  - **FROM THE SOURCES TAB THE WIZARD IS PUSHED, NOT RESET, AND SKIPS ITS OWN PIN**
    (`wizardGated`): the parent crossed the real gate seconds ago, and a second code
    reads as broken. Back/skip return to the PARENT SCREEN (`onBack` returns false → nav
    pops; activating the profile there would kick the parent to the child's home for
    changing nothing); a successful connect still runs `finishSheetSetup` →
    `activateProfile` (the adoption sync needs its loading screen). At profile creation
    everything behaves exactly as before (reset + PIN).
- v1.0.34 — **THE SCREEN GOES DARK WHEN NOBODY IS THERE** (user request: a child falls
  asleep mid-video and the panel burns all night). After `screenOffAfterMin` minutes
  (per-profile, SYNCED; **default ON at 10** — an explicit 0 = never, the old behavior;
  ⚠️ the default changes every existing install and MUST ride the release notes) with no
  touch/remote key WHILE A VIDEO PLAYS: the "עדיין צופים? 👀" overlay shows for
  `SCREEN_OFF_PROMPT_SEC` (45s); unanswered → save position, pause IN PLACE (the v1.0.32
  order: save FIRST, never `stop()`), and keep-awake follows the pause down by itself
  (wake.js holds it only while playing). **The DEVICE's own display timeout is what turns
  the screen off** — an app cannot do that (device-admin is the wrong tool for a kids
  player) nor change the system timeout (WRITE_SETTINGS), so a tablet set to "never
  sleep" stays lit and the settings hint says so honestly.
  - Pure decisions, unit-pinned: `plan.screenOffMinutes` — never-written ⇒ DEFAULT
    (`Number(null) === 0` is the trap: the unset check must precede coercion or the
    default silently reads as "off"), explicit 0 ⇒ off, nonsense ⇒ default (the
    planRejectedPurge rule); `plan.evalIdleSleep` → 'off'|'counting'|'prompt'|'sleep',
    where `playing:false` is 'off' BY DESIGN — wake is not held while paused/outside the
    player, the OS already owns those, so "count only while playing" is the whole feature.
  - **THE ANSWERING TAP/KEY IS CONSUMED** (`onUserInput` stops propagation only while the
    prompt is up): on TV, OK would otherwise toggle pause and ←/→ would seek ±10s — "I'm
    here" must never scrub the video. Input = window-CAPTURE `pointerdown`+`keydown`, so
    no handler's stopPropagation can starve the timer; the prompt itself needs no handler
    of its own (any input anywhere answers it — the button is an affordance).
  - The overlay lives INSIDE `#player-wrap`, above the tap-shield (the autoplay-next
    rule: that is the element that goes fullscreen). Same behavior on TV (user decision
    2026-08-07): the pause lets the TV's own screensaver/sleep take over. A profile
    switch stamps fresh input so a sibling never inherits idle time. The invariants
    guard was proven against five planted regressions (order swap, dropped save,
    `stop()`, dropped keydown listener, overlay outside the wrap).
- v1.0.33 — **THE ADD TAB SEARCHES YOUTUBE** (user request: type like on youtube.com,
  see YouTube's own results, preview, add). The mechanism is the KEYLESS youtubei
  endpoint — `search.list` stayed banned (100 units on the shared key ≈ 80 searches/day
  for ALL families combined) — verified live incl. the Dalvik UA, so the v1.0.32
  mobile-page trap does not apply (an API, not a redirecting page). Invariants, all
  guard-pinned and proven against planted regressions:
  - **The youtubei literal lives in [ytsearch.js](www/js/ytsearch.js) ONLY** (one-module
    blast radius for an undocumented endpoint), it never sees a key (`key=`, a
    `getApiKey()` call and a keys import all fail the suite), and its imports are
    ⊆ {platform, util}. The `/search?` URL-literal guard now exempts exactly that
    module and, inside it, allows exactly the two sanctioned endpoints — the
    suggestions URL (`/complete/search?`) trips the same regex, so an exemption
    written only for youtubei leaves the suite red.
  - **Shorts and RD-mixes are filtered IN THE PURE PARSER** (the user's decision: no
    Shorts anywhere): reel shelves dropped wholesale, a videoRenderer with the SHORTS
    overlay or a /shorts/ navigation dropped, `RD…` lockup playlists dropped. Planted
    fixtures pin each (the forbidden item sits between two survivors). Unknown signal
    = include, per the standing rule.
  - **The officialCard is HEADER-ANCHORED**: Cocomelon-class channels appear in mixed
    results only as `officialCardViewModel`, whose `contents` subtree carries FOREIGN
    related-channel ids (measured) — identity is read from the header alone and only
    when every UC id there agrees; an ambiguous card is skipped (the ערוצים chip still
    finds the real channelRenderer). The @RabbiRosenblum decoy class, pre-empted.
  - **A CHANNEL/PLAYLIST RESULT OPENS FOR BROWSING** (user request, same release):
    tapping its thumbnail OR its name swaps the list area for the source's own videos —
    a channel shows its VIDEOS TAB only (`youtubei/v1/browse` + the tab's own protobuf
    params; Shorts have a separate tab, so this is by construction what a subscription
    would import), a playlist shows its contents (`VL`-prefixed browseId). The header
    carries back / avatar / name / one ➕ for adding the whole source; every video row
    behaves exactly like a search result (bubble preview, single-add, ✓ precompute).
    Back (button AND hardware back, before goGallery — gated on the add panel being
    visible) restores the search results untouched; a new search closes the browse.
    ONE state map serves both lists (a ✓ earned inside the browse must show on the
    results row and vice versa — a video key is global). Browse continuations ride
    `onResponseReceivedActions` (search uses ...Commands; the reader takes both), and
    **an unparsable CONTINUATION is END-OF-LIST, never the 'parse' alarm** — measured:
    a playlist delivered whole on page one still carries a token whose continuation
    answers nothing but trackingParams; only a FIRST page may raise 'parse'. The
    one-module invariant widened from `youtubei/v1/search` to ANY `youtubei/` literal.
  - **Adding routes through the SAME pipeline as pasting**: results are normalized to
    canonical URLs and re-classified (`classifySourceRow` — classifyLink stays THE
    boundary; a kind mismatch is refused), then `addClassifiedRow` — the helper
    extracted from `parentAdd`, one path for both callers (the v1.0.25 lesson).
    share.js deliberately NOT unified (pending-first is a different curation policy).
    A search add carries the result's title so the record needs no oEmbed fetch.
  - **The preview bubble gained mode `'search'`**: `#pv-add` adds-and-advances via
    `previewDecide` (added AND already-exists count as decided); `pv-delete` is hidden
    there too — the old `toggle('hidden', pending)` would have shown a live 🗑️ over an
    item with no stored record. The bubble gets COPIES (previewDecide splices); row
    state syncs back by key, never index.
  - **Two monotonic seq counters** (search vs suggestions — one counter would let a
    keystroke's suggest fetch invalidate an in-flight search); a late response never
    paints a newer query's list (the logoTarget lesson). Continuation additionally
    re-checks query+filter, and appends dedupe by `type:id`.
  - **`oe=utf-8` on the suggestions URL is LOAD-BEARING**: without it a Hebrew query
    is answered in windows-1255 (measured live — the dropdown rendered ����).
    Suggestion taps bind on **pointerdown** (click loses the race against the input's
    blur); Escape closes only the dropdown (stopPropagation — browser Escape doubles
    as hardware-back).
  - **Messages are the feature** (v1.0.27 rule), pinned distinct in `searchMessage`:
    'network' (try again; the shown results stay) vs 'parse' (= "YouTube changed
    something", the update-the-app alarm — `parseSearchResponse` answers null only
    when NO top-level shape is recognized; recognized-but-empty is `{items:[]}`).
  - **"✓ קיים" is precomputed against BOTH scopes** (lib + prof) before render — the
    row must agree with what the add would answer, and `addClassifiedRow` dedupes
    against both.
  - Transport: `platform.httpPostJson` — body stringified + explicit Content-Type at
    the seam (the CapacitorHttp silent-body-drop trap); browser dev rides `/__proxy`,
    which now forwards POST (1MB cap, Content-Type only, never cookies/auth — dev
    server only, same SSRF guard). No public-CORS-proxy POST rung on purpose.
  - The guide gained 2 slides at the end of 'דרך 2 · במסך ההורים' — the deck is now
    EXACTLY at the 20-slide test cap; the next slide must raise the cap deliberately.
  - **THE REVIEW PASS IS PART OF THE RELEASE** ([docs/V1033.md](docs/V1033.md) §4 has
    the full list; every fix is pinned). The rules it minted:
    - **The parsers are TOTAL** — innertube's array→keyed-object churn answers
      "unrecognized", never a throw. A throw used to read as 'network' ("בדקו את
      החיבור" over working Wi-Fi) and the shape-changed alarm never fired; a totality
      test feeds truthy-malformed docs to both parsers. A 200-with-HTML interstitial
      is 'network' on BOTH transports (device and browser used to disagree).
    - **Browse teardown has ONE path** (`closeYtsBrowse`) — a hand-rolled two-line
      teardown in ytsSearch left the old browse rows rendered and tappable while the
      fetch ran (and forever when it failed), so a thumbnail tap previewed the WRONG
      video via `activeYtsItems()`'s fallback. The HIGH finding of the pass.
    - **`previewDecide` is re-entrancy-latched**: the `previewCtx !== ctx` check
      cannot catch a double-tap because splice MUTATES the shared object — the second
      splice removed the NEXT video, which the parent never saw.
    - **The bubble's button matrix is pure** (`playerlogic.previewBubbleButtons`,
      per-mode node tests, unknown mode = nothing destructive); renderPreview's
      delegation is guard-pinned.
    - **Hiding the suggest dropdown invalidates its in-flight fetch** (seq bump inside
      `ytsHideSuggest`), suggestion taps bind pointerdown AND click (a TV remote's OK
      produces no pointerdown), and blur skips the hide when focus moved INTO the
      dropdown. Hardware back closes dropdown → browse → screen, in that order,
      guard-pinned with the panel-add visibility gate.
    - **`resetYtsUi()` on profile activation** — the search area is per profile; the
      previous child's "✓ קיים" marks were computed against the other child's scopes
      (the buildFolders profile-identity rule, applied here).
    - **One `libraryHasVideo` helper** for the row precompute AND addClassifiedRow's
      dedupe (the row must agree with what the add answers), and one transient
      `'adding'` state (⏳) latches the same source across surfaces — the browse-head ➕
      and the result row could run two concurrent imports.
    - `addClassifiedRow` has EXACTLY two callers (parentAdd + ytsAdd, the
      importChannelAndAsk-style pin); ytsAdd's kind-mismatch refusal is pinned by its
      FULL conditional shape — the bare-substring version stayed green under a
      `false &&` plant, caught by its own red-check.
    - Playlist ids are validated (`PLAYLIST_ID`) like every other id class; the
      youtubei endpoint constants are NOT exported (an import plus a hand-appended
      key parameter would have tripped no guard); dead `searchMessage` stages deleted
      — the add outcome speaks in `addClassifiedRow`'s voice only.
- v1.0.32 — **CHANNEL LOGOS ARE CACHED AS BYTES AND RETRY ON EVERY HOME ENTRY** (user
  request: the folder picture must always load). The avatar used to be re-fetched from
  the network on EVERY render (`<img src=url>`) — flaky Wi-Fi or a rebrand (old URL
  404s) showed 📺 despite the app having had the picture moments earlier. Now the bytes
  are stored ONCE in the thumbs store (`logo:<channelId>`, ~30KB, `srcUrl` in the meta)
  and render from the device — offline included; pure `plan.planLogoCache` decides:
  cached bytes ALWAYS render and the render NEVER waits for the network (a new URL only
  refreshes in the background; a dead/absent URL keeps the picture — stored BYTES beat
  the v1.0.24 lesson's stored-URL). `platform.httpGetBlob` fetches (native base64 →
  Blob; browser: direct → /__proxy → CORS proxies). A folder still missing its bytes
  retries on each render/home entry, deduped only while a fetch is in flight.
  **THE SERVE HALF NEVER DEDUPES — only the network half does.** The first version
  deduped the whole resolver: a render arriving mid-fetch got nothing and the fetch then
  painted a DETACHED img (the home re-renders several times during boot alone) —
  measured as 📺 tiles sitting on top of a full byte cache. `logoTarget` tracks the
  LATEST mounted img per channel; delivery re-mounts into the host when onerror already
  swapped the emoji in. Used logos get `touchThumbs` so the LRU eviction never takes
  them. The parent's channel list heals through the same cache.
  Hardening pass (self-review, all three pinned pure):
  - **A late fetch may NOT paint into a host that moved on** (`planLogoDelivery`):
    `#folder-logo-top` is ONE element shared by every folder view, and channel A's slow
    fetch used to plant A's logo into folder B's header. The host carries
    `dataset.logoChannel`; a mismatch skips.
  - **Warm memory paints FIRST** (`logoFirstPaint`): the unconditional `img.src = url`
    hit the network on every render even with a full cache. Verified: zero ggpht
    requests across a whole re-rendering session.
  - **The refreshed logo's OLD objectURL is never revoked**: a background view's img may
    still display it, and revoking fires a spurious `noteLogoFailure`. One leaked URL
    per rebrand is nothing.
- v1.0.32 — **THE PROFILE PICKER HAS AN EXIT BUTTON** (user request): same `.exit-btn`
  as the home's, same `askExit` flow hardware-back there always ran — confirm, then a
  free exit, **or the parent code first when the kiosk lock is armed** (user's decision:
  always visible, never a silent hole). The lock check reads
  `activeProfileId || prefGet('activeProfile')` — on a boot picker no profile is active
  yet but the kiosk was armed from the LAST ACTIVE one (the launch rule), and reading
  only the live global would have walked straight through an armed lock (the cold-start
  share picker is the real case: stored profile + lock + picker shown).
- v1.0.32 — **THE MOBILE CHANNEL PAGE FINALLY RESOLVES — @BARDAK613, THIRD RECURRENCE,
  ROOT CAUSE AT LAST.** A request carrying a MOBILE user-agent (the tablet WebView, or
  the native HTTP layer's Dalvik default) is REDIRECTED to m.youtube.com, whose page has
  NO `externalId` and NO canonical-channel link while carrying FIVE decoy `"channelId"`
  occurrences (measured live) — so the anchored extractor correctly refused, fell back to
  the poisoned cache, and returned the decoy. **Every earlier fix (v1.0.29–31) verified
  in a DESKTOP browser, which gets the www page — that is why they kept passing
  verification and failing on the device.** The mobile page names its identity in its own
  anchored shapes: the RSS alternate link (`feeds/videos.xml?channel_id=UC…`) and the
  og:url/twitter:url metas pointing at `/channel/UC…` — both now matched, BEFORE the
  decoy-prone legacy key. Verified live across the full UA matrix (none/Dalvik/okhttp/
  mobile-Chrome) and generalized on @rotemama4kids + @RabbiRosenblum mobile pages.
  A device already carrying the bad subscription self-heals: the sheet row keeps the
  @handle and re-resolves on every sync, so once resolution answers the real id the real
  channel subscribes and imports by itself. **LESSON: any scrape-parsing fix must be
  probed against the MOBILE page variant, not just the browser's desktop one.**
- v1.0.32 — **BACKUP AND LIST MANAGEMENT LEFT THE UI; THE MACHINERY IS UNTOUCHED** (user
  request: backup is automatic — never let the user run it by hand).
  - Settings: the status line and "גיבוי עכשיו" are GONE. The `#drive-block` shows ONLY
    while backup is OFF (the enable path for a family that skipped the first-launch
    connect — hiding it for them too would leave no door, ever); once enabled the whole
    block disappears. The automatic pull (entry/resume) + push (every mutation) are
    exactly as before.
  - Sources: create / join / disconnect are GONE — list management is not a parent-facing
    concept any more. **The profile-creation wizard is the ONE remaining place a sheet is
    attached** (`connectWizardSheet` → `adoptLibraryScope`); `connectSheetUrl` was removed
    with its last callers — anything re-attaching a sheet from the sources tab must route
    through that same migration if it ever returns. The copy-link button stays (how a
    parent opens/shares the sheet), the refresh stays, and BOTH safety surfaces stay: the
    mirror safety-valve alert and the sheetwrite queue/dropped warnings.
  - A sheet-less profile keeps working (`lib:p:<id>`); the panel and the copy button now
    SAY that instead of pointing at buttons that no longer exist.
- v1.0.32 — **THE ADD FORM LOST ITS NAME/IMAGE FIELDS** (user request): the `אפשרויות`
  details (add-title/add-thumb) is gone — never re-add it. The name and picture come
  from the content itself: YouTube titles/thumbnails were already fetched when the field
  was left empty (now always); a direct FILE has no metadata, so its display name derives
  from the filename in the link — pure `classify.titleFromFileUrl` (percent-DECODED, so
  Hebrew filenames work; extension stripped; `_-+` opened into spaces; '' for anything
  unusable — no caption beats a caption of garbage) — and its thumbnail from the captured
  first frame (`persistThumb`, unchanged since v1.0.5).
- v1.0.32 — **THE ABOUT TAB LOST THREE BUTTONS** (user request): מדיניות פרטיות, תנאי
  שימוש, מה חדש בגירסה. The policies LIVE ON THE SITE as sticky nav tabs (all three
  docs/ pages carry the same `.site-tabs` bar) — **the privacy/terms URLs must stay
  ALIVE: Google OAuth verification points at them** (`LINKS.site.privacy/terms` remain
  in links.js as the record even though the app no longer opens them; the 🌐 site button
  is the in-app path). What's-new shows in the ONE place that matters — the update
  prompt before an install; `update.notesForInstalledVersion` + the `update.notesAll`
  store went with the button (dead code).
- v1.0.32 — **THE SOURCES TAB: subscriptions fold away; an undecided channel surfaces as
  "ערוצים חדשים" for 24h.** The channel list is a CLOSED `<details>` like the library list
  (v1.0.28), sorted newest-first by `addedAt` (every creation path already stamped it;
  a pre-v1.0.21 row without one is never "new" and sorts to the END — surprising an old
  subscription into the new section would read as a bug). Membership and order are pure
  `plan.planChannelSections` (undecided + |now−addedAt| < `NEW_CHANNEL_WINDOW_MS`; the
  absolute delta lets a peer clock minutes ahead still read as new without letting a
  broken clock pin a row there for a year).
  - **`decidedAt` is the new field**: stamped by the three-way dialog's REAL answers
    (אישור הכל, and a SAVED manual pick — backing out of the picker is "אחר כך" and
    stamps nothing), by the auto-approve toggle in either direction, and at creation for
    a sheet row carrying an explicit auto/manual flag. It rides the libraryChannels
    record, so a decision made on any device travels. "אחר כך" is deliberately NOT a
    decision; 24h drains the row into the regular list by itself, so the section cannot
    silt up.
  - A fresh row trades the auto-approve toggle for one real `<button>` (TV remote needs
    one) that raises the SAME three-way dialog the add flow uses. A fresh channel whose
    queue is EMPTY (Shorts-only, or auto-approved meanwhile) treats the tap itself as
    the review — a row that does nothing on tap reads as broken — with a toast saying so.
  - Browser-verified end-to-end behind the real PIN gate: planted fresh row renders in
    the section, the folded list shows "ערוצים (N)" closed, the tap stamps `decidedAt`,
    hides the section and moves the row.
- v1.0.32 — **THE SCREEN-OFF BUTTON FINALLY PAUSES THE VIDEO** (field report: pressing
  the tablet's physical power button darkened the screen but the soundtrack kept
  playing — kiosk lock on or off alike). Android does NOT pause the WebView, and the app
  listened only to `onAppResume`; `platform.onAppPause` (appStateChange `isActive:false`,
  visibilitychange-hidden in the browser) is the missing half. The handler does exactly
  two things IN ORDER: `saveWatchPosition(currentWatch)` (reads the live playhead —
  pausing first would be fine, but a torn-down player would not) then
  `player.pauseCurrent()` — **pause IN PLACE, never `stop()`**: stop() destroys the
  player and coming back to a black hole is the "הסרטון נעלם" the user reported. When the
  screen returns the video waits, PAUSED, at its spot (the HUD heartbeat pins itself on
  the pause); the child taps play. The power button itself was never blocked — keep-awake
  only prevents the idle timeout. An invariants guard pins listener + both halves + order
  + no-stop(), proven against three planted regressions (including a commented-out call —
  the first guard version passed on that, the exact vacuous-guard trap).
- v1.0.32 — **RESUME PLAYBACK: a stopped video reopens where it stopped** (per-profile
  setting, OFF by default — a family that never opens the settings screen keeps today's
  start-from-zero exactly). The SETTING syncs (`resume`, safe-on-tie false); **THE
  POSITION IS DEVICE-LOCAL**: it changes every few seconds of watching, so
  `drive.serializeStateEntry` (pure, tested) never emits `posSec`/`durSec`/`posAt`, and
  the apply side folds through pure `mergeAppliedState`, which PRESERVES the local
  position and MIN-MERGES `unwrappedAt` — the old blind put erased the local record
  wholesale on every pull (and let a later remote unwrap beat an earlier local one).
  - The decisions are pure (`playerlogic.resumeStartAt` / `resumeSaveDecision` /
    `watchedFraction`): resume lands `RESUME_REWIND_SEC` (3s) before the stop point; a
    stop inside `RESUME_TAIL_SEC` (12s) of the end CLEARS the position (or every video
    "sticks" seconds before its end forever); below `RESUME_MIN_POS_SEC` (8s) nothing is
    saved and clearing is refused — a 2-second accidental tap must not erase progress; an
    unknown duration never saves (a wrong resume point is worse than none).
  - Saved every `RESUME_SAVE_MS` while playing (survives a process kill), plus in watch's
    `onLeave` (BEFORE `stop()` — the teardown takes the clock with it) and at the top of
    `openWatch` for the video→video path (`playItem` reuses the player, same reason).
    A video that ENDS clears its position in `onVideoFinished`.
  - The tile's red progress bar (`.tile-progress`, inside `.thumb`) is gated on the
    SETTING, not just the data — a stale position from an earlier ON period must not
    draw; a wrapped gift never shows one. `giftStates` mirrors every write so the next
    render needs no extra IDB read. **The folder view re-renders on BACK-restores**
    (`nav.register('folder')` gained onEnter, like the home view always had) or the tile
    the child just left keeps its stale bar.
  - `player.playbackState()` lends app.js the live clock (null after teardown, never a
    stale player's numbers); `opts.startAt` is the app's resume decision — a URL's t=
    hint still never chooses where a video starts (classifyLink keeps stripping it).
  - Verified in the browser end-to-end: save at 64s → bar at 44.4% → reopen at 61s →
    seek to the tail → ended → position cleared, bar gone, `unwrappedAt` intact.
- v1.0.32 — **THE HUD SHOWS ELAPSED / TOTAL TIME** (user request: like the YouTube app).
  `playerlogic.formatTime` is pure + tested: floored seconds (a second that has not
  finished must not show), `h:mm:ss` above an hour, and `0:00` for NaN/Infinity/negative —
  `getDuration()` answers 0 before metadata and Infinity for a live stream, and none of
  those may leak onto the child's screen. The labels live INSIDE the `.player-hud`
  container so they inherit its `pointer-events:none` ALWAYS (the HUD-bar invariant) and
  fade with the HUD. The `.seek-row` is `dir="ltr"` like the timeline itself — elapsed by
  the bar's start, total by its end. Text writes are guarded by value: `renderProgress`
  runs 4×/s and identical textContent writes still invalidate layout on cheap tablets.
- v1.0.31 — **A COLD-START SPLASH + A SCHEDULED PER-PROFILE LOCK.**
  - **SPLASH** (`#splash-overlay`): a FIXED overlay above the nav (not a view — a view would
    vanish the moment `nav.reset` runs behind it), shown for ~1.3s while the app boots, then
    faded. Cold-start-only is automatic: `init()` runs once per process; resume never
    re-enters. Inline emoji + CSS animation, self-contained.
  - **SCHEDULED LOCK** ("time to do something else"): after `lockAfterMin` minutes of a
    session the app locks for `lockDurationMin`, shows the child a calm sleeping-tablet
    screen with a live countdown, then returns to normal and re-arms on the next video.
    - **SETTINGS SYNC, LIVE TIMER IS DEVICE-LOCAL** (`schedlock:<pid>:armed`/`:until` in
      Preferences). A lock is about THIS device's session — syncing "locked until X" would
      lock a sibling's device on one account. `drive.js` must never carry these keys; a test
      pins it. Same split as PIN recovery.
    - The timer **ACCUMULATES** (armed by the first video, runs continuously, never resets on
      a later video — the user's decision; resetting would let continuous play defeat it) and
      counts wall-clock while the app is open. Pure `plan.evalScheduledLock` decides; a
      nonsense window falls back to the default (`scheduledLockDurationMs`, the
      `planRejectedPurge` rule — a 0 duration would unlock instantly).
    - **IT SURVIVES A RESTART** (persisted `:until`, checked on boot + resume + profile
      switch) so a child cannot bypass it by force-closing. The locked view swallows
      hardware-back.
    - **THE EXIT BUTTON IS GATED ON THE KIOSK LOCK**: shown only when the exit-lock is OFF
      (closing the app is then a legitimate escape); with the kiosk ON the child is fully
      contained. A discreet `פתיחה להורים` tap → parent code → unlock early (and re-arm).
      Both pinned by an invariants test. **Since v1.0.55 the gating is pure
      `lockScreenContainment`**: the kiosk still hides the button, and the per-profile
      `lockTablet` setting keeps it visible but code-gated while pinning the tablet for
      the break's duration — see the v1.0.55 entry.
    - lockAfter 0 = OFF (the default), so a family that never opens this setting sees nothing.
- v1.0.29 — **LAUNCH RESUMES THE LAST-USED PROFILE, PER DEVICE** (pure
  `plan.planBootProfile`). The stored id was ALREADY device-local (`prefGet('activeProfile')`
  — Preferences never sync; one account, several devices, a different child on each); the
  boot flow just never used it. Three fallbacks to the picker, each load-bearing: nothing
  stored; the stored profile no longer exists (deleted, possibly via a peer's tombstone);
  and a QUEUED COLD-START SHARE — the boot picker IS that share's routing question
  (v1.0.23, `alreadyRouted`), so auto-resuming would route a share nobody addressed.
  Combined with v1.0.28's chip gate, the model is now: the device belongs to its child;
  entering ANY other profile costs the parent code.
- v1.0.29 — **A POISONED HANDLE CACHE COULD NOT HEAL WITHOUT THE SHARED KEY**, and a
  DECOY `"channelId"` beat the real id (@BARDAK613, field — "הערוץ נוסף אבל אין בו
  סרטונים" on a channel full of videos). Two layers on top of the v1.0.28 fix:
  - v1.0.28 healed a poisoned `handleMap` entry only when the API succeeded, and the
    built-in key's quota is SHARED by every family — one exhausted afternoon left
    `channelId` null and the old order then returned the poisoned cache WITHOUT trying the
    scrape. `resolveChannelRef` now scrapes BEFORE the cache on any KEYED resolve (the add
    paths): API → live scrape → cache-as-last-resort. Healing is now independent of the
    shared key's quota. Keyless enrichment (`resolveChannelRef(ref, '')`, per-video) still
    hits the cache first — it must not scrape N times, and a stale id there only affects
    grouping. Browser-proven: a poisoned entry heals with BOTH a working and a broken key.
  - @BARDAK613's page carries a real `"channelId":"UC…"` — but it is a DECOY (the real id
    is in `externalId`). `extractChannelIdFromHtml` already tries `externalId` first, so
    the anchored order was already correct; a test now pins the decoy case explicitly.
- v1.0.31 — **A KEYLESS RELEASE COULD NOT HEAL A POISONED HANDLE CACHE** (@BARDAK613,
  reported STILL failing on v1.0.30 which already had the v1.0.29 heal). The v1.0.29 fix
  keyed the cache-first shortcut on `!key` — but `keys.local.js` is GITIGNORED, so a
  release built without it ships NO API key, and then the ADD path (`resolveChannelRef(ref,
  getApiKey())`) passes `''` too, hits the keyless cache-first shortcut, and returns the
  poisoned decoy forever. The scrape (which heals) was never reached. Now the shortcut is
  gated on an explicit `cacheFirst` OPT-IN that ONLY the per-video enrichment caller passes;
  every ADD/SHEET path resolves LIVE regardless of the key, so healing is key-independent.
  A test pins that exactly ONE caller opts into `cacheFirst`. The channel resolves and
  imports (98 via API, ~13 via keyless RSS) — verified; a device already carrying the bad
  SUBSCRIPTION still needs a delete + re-add, which now resolves correctly.
- v1.0.28 — **A HANDLE COULD RESOLVE TO A STRANGER'S CHANNEL, AND THE MISTAKE WAS
  PERMANENT** (@RabbiRosenblum, field). Current channel pages no longer carry
  `"channelId":"UC…"` at all, so the keyless scrape fell to its loose second pattern —
  the FIRST `channel/UC…` anywhere in ~1.2MB of HTML — and a decoy UC id appears BEFORE
  the real one (measured live). The wrong id was cached FOREVER (`handleMap` was consulted
  before the API), so the subscription stayed empty — "הערוץ נוסף, אבל אין בו סרטונים" —
  on every later attempt. The trigger is the BUILT-IN key's quota running out: it is
  shared by every family, so one heavy afternoon pushes resolves onto the scrape.
  - Pure `yt.extractChannelIdFromHtml`: ANCHORED shapes only (`externalId`, the canonical
    link, legacy `channelId`) and NO bare-UC fallback — an occasionally failed resolve
    beats an occasionally WRONG one; for this app a wrong channel is a safety hole.
  - **THE API NOW OUTRANKS THE CACHE** when a key is available, refreshing `handleMap` on
    every keyed resolve — which also HEALS devices already carrying a poisoned entry (the
    user's own tablet). Tests pin the order (API before the cache return) and the decoy
    case, both proven by planted regressions.
- v1.0.29 — **TV AUDIT: the grouped library's sections were focusable-but-INVISIBLE.**
  A full D-pad sweep of every surface added since v1.0.26 (verified in `tv=1` mode): all
  new controls are real `button`/`summary`/focusable, and the grouped-library `<details>`
  are fully reachable (each group summary opens on Enter). ONE real gap: `html.tv …:focus`
  ring covered `button`/`input`/`[tabindex]` but NOT `summary` or `[href]` — a native
  summary's `tabIndex` is a PROPERTY, not an attribute, so `[tabindex]` never matched it.
  On TV the remote could focus a library section or the privacy link with NO visible ring.
  Fixed in the ring rule; `invariants.test.mjs` now pins that both are covered. (The two
  whole-row `<li>` click handlers are convenience duplicates of a focusable checkbox, so
  they are reachable regardless.)
- v1.0.28 — **THE SIMPLIFICATION PASS** (parent's request: a user who knows no technical
  terms). Five changes, one chain:
  - **The YouTube-API-key form is GONE from the UI.** The target user cannot mint a Google
    Cloud key, so the form only frightened. A key saved in the PAST keeps working —
    `yt.getApiKey` still reads the stored `yt:apiKey` override first. Never re-add the form;
    developers have GOOGLE_CLOUD_SETUP.md.
  - **The parent's library list folds away** (`#library-box` + `plan.groupLibraryByFolder`,
    pure + tested): one closed line, inside it one `<details>` per folder the CHILD sees,
    all closed by default. Grouping is by HOME folder; unsubscribed leftovers group under
    their remembered title rather than vanish; the PARENT_LIST_CAP promise became
    per-section. A rebuild keeps whatever sections were open.
  - **Switching profiles MID-SESSION always asks for the code** — the `exitLockOn()`
    conditional is gone (a sibling switch changes whose library/gifts/settings are live;
    that is a parental act). The BOOT picker stays free, same decision. Still fails CLOSED;
    the invariants guard now bans any free-standing `backToProfiles` in `onProfileChip`.
  - **The landing page sells the app, not its permission model** — the scopes section is
    one plain privacy card (privacy/terms links KEPT — OAuth verification points at them),
    plus a new "איך מוסיפים תוכן" section. Functional warnings stay (Android's install
    prompts, Google's "we don't know this app" screen) — preparation, not jargon.
  - **`summary` joined the D-pad focusable selector** — every folded section (the rejected
    archive since v1.0.23, now the whole library list) was UNREACHABLE from a TV remote.
    Enter toggles natively; focus was the entire gap.
- v1.0.27 — **NO STEP OF ADDING A CHANNEL IS SILENT ANY MORE.** Field report: "the add
  takes a while — fine — but between clicks I cannot tell whether it is still working or
  waiting for me." Only the long import ever showed the loading screen; resolve, subscribe,
  the bulk approve, building the manual-pick list, saving the pick, and above all the
  SECOND full sync after the decision all ran behind the ordinary screen.
  - The texts are pure `plan.channelAddWait(stage, {count})` — a waiting screen with no
    explanation is the same ambiguity in a different colour, so the words ARE the feature
    and are test-pinned (never the generic "בטעינה…", the count in the sentence when known,
    and no NaN/0 leaking in). `invariants.test.mjs` pins that every stage `app.js` waits on
    via `withChannelWait` has an entry — a stage added without text fails the suite.
  - `withChannelWait` keeps `defer: 250`, so THE FAST PATH NEVER FLASHES — measured: an
    already-synced channel reaches the dialog in 150ms with zero screens, while the same
    flow with real work shows each step with its own words (and the finishing screen
    streams the sync's real progress labels via `onProgress`).
  - **`refreshAfterAdd` gained `wait: true` for exactly ONE caller** (`importChannelAndAsk`,
    which owns the waiting screen); the default stays silent because the v1.0.18 rule
    still holds everywhere else — covering the child's populated grid is the worse bug.
    BOTH dialog answers route through the same awaited 'finishing' wait: the manual pick
    used to fire its own silent sync, which was the exact gap on that branch.
  - **A blocking wait must not become a TRAP**: the loading view swallows back, so the
    post-decision sync is raced against `waitWithValve` (90s). The valve does not drop the
    screen silently — that would restore the ambiguity — it reports `backgrounded` so the
    caller can say the work continues.
  - **Found while verifying: the manual pick reported a queue the parent had just emptied**
    ("3 סרטונים ממתינים לאישור" after they kept 2 and rejected 1). `channelAddOutcome` now
    takes the pick result and says what was chosen; a missing pick keeps the honest
    "waiting" sentence because that queue is real.
- v1.0.26 — **AN EMPTY QUEUE SAYS SO** (`#pending-empty`, `.list-empty`). ממתינים rendered a
  blank area when nothing was waiting, which is indistinguishable from a list that has not
  loaded or a screen that is broken — and since v1.0.24 the BLUE attention dot deliberately
  sends the parent to exactly this tab, so "I followed the dot and found nothing" was the
  common case, not the rare one. The line is driven by `grandTotal`, the count that already
  spans BOTH scopes, so it can never disagree with the list beside it.
- v1.0.26 — **A PROFILE NAME MAY BE 20 CHARACTERS, AND THE LIMIT IS NOW REAL.** It was 12,
  and it lived ONLY as `maxlength` on `#create-name` — an attribute no test can see, which
  binds exactly one caller and which **does not bind that one either**: assigning `.value`
  from script sails straight past it (measured). So the cap now lives next to the write, in
  pure `store.normalizeProfileName` (trim, collapse whitespace, cap, fall back to 'ילד/ה'),
  and `invariants.test.mjs` pins the attribute to `store.PROFILE_NAME_MAX` so the two cannot
  drift — raise one alone and either long names reach storage unbounded or the parent cannot
  type what the tile is sized for.
  - **THE CAP SLICES BY CODE POINT.** "נועם 🦁" is a plausible name and a `.slice(0, 20)`
    cuts the surrogate pair in half, storing a replacement character forever. The test that
    pins this is also a lesson in writing the assertion right: the first version checked
    `/[\uD800-\uDFFF]$/`, which fires on the CORRECT result too — a kept 🦁 legitimately ends
    in its low half. It must look for an UNPAIRED surrogate.
  - **THE TILE IS THE ONLY PLACE A NAME IS DRAWN AT FULL LENGTH**, and it had no width bound
    at all, so a long name just widened its flex item and the picker went ragged. `9em`
    (=180px here) holds the widest possible 20 characters in exactly two lines — measured in
    the browser against an all-'מ' worst case, not guessed. `overflow-wrap: anywhere` is
    load-bearing (a 20-char name with no spaces is one unbreakable word); the 2-line clamp
    is INSURANCE for a longer name arriving from a peer, not the normal path. Everywhere
    else was already safe: `.chip-name` has been ellipsised at 90px all along (it truncated
    12-char names too), and the per-profile settings labels wrap — verified at 375px.
- v1.0.26 — **A FORGOTTEN PARENT CODE HAD NO WAY BACK, AND v1.0.25 IS WHAT CLOSED IT.**
  Until then the answer was "reinstall the app". Then the PIN hash moved into the synced
  settings channel and rides the Drive document, so a family WITH backup reinstalls,
  reconnects, and gets the forgotten code handed straight back on the first pull — the
  families who did the right thing were the ones with no door. [recovery.js](www/js/recovery.js)
  is the door: request → **24-hour wait** (`PIN_RECOVERY_DELAY_HOURS`) → choose a new code.
  - **THE WAIT IS THE UNIVERSAL PATH, ON PURPOSE.** It needs no device lock (a child's
    tablet often has none and Android TV never does), no permission, no network, and
    nothing the parent must have kept. It is the FLOOR, never an alternative.
  - **THE DEVICE CREDENTIAL IS THE FAST PATH ON TOP OF IT** (`KidsNative.canDeviceAuth` /
    `deviceAuth`, `androidx.biometric` — a fingerprint or the device's own lock code, which
    is the only identity claim this app can honestly check offline). Pure
    `plan.planRecoveryRoute` decides between them, and the ORDER is the rule:
    **an existing request always outranks the fast path.** A wait already running is state
    the parent deliberately created — possibly on a day the sensor would not cooperate —
    so a capable device must not hide it behind a prompt they may fail again, nor discard
    it silently.
  - **BOTH DIRECTIONS OF NATIVE FAILURE ARE CLOSED, and a test pins each.** Treating an
    absent/throwing bridge as SUCCESS would open the parent screen to anyone in the browser
    and on every APK built before the method existed, so both wrappers compare `=== true`;
    letting it THROW would blow up `onPinForgot` before it can offer the wait, turning a
    missing sensor into a permanent lockout, so both swallow. A FAILED prompt (cancelled,
    locked out, or unopenable) falls through to the wait — `BIOMETRIC_WEAK`, not STRONG,
    for the same reason: this gates a UI screen, not a crypto key.
  - **THE BANNER IS THE SAFEGUARD, NOT THE DELAY.** A wait nobody is told about just means
    the child waits a day and walks in, so the notice lives on the CHILD'S HOME — the
    screen that is on all day — and is shown for `ready` as well as `waiting` (going quiet
    right before the door opens would make the countdown a trap). `invariants.test.mjs`
    pins that `renderHome` still draws it; every `planPinRecovery` unit test passes without.
  - **CANCELLING IS FREE, DELIBERATELY.** A parent who did not request the reset cannot
    prove who they are — that is the exact situation the feature exists for — and a child
    cancelling only restores the status quo. For the same reason `requestRecovery` NEVER
    restamps a live request: re-tapping must not push the deadline away, or a child who
    found the button could keep the parent locked out for good.
  - **THE REQUEST IS DEVICE-LOCAL AND A TEST PINS IT.** The PIN hash syncs (that is why
    this exists); a *pending reset* must not, or one device starts everyone's clock and a
    peer's stale copy re-arms a cancelled request. `pinRecoveryAt` may appear in exactly
    one module.
  - **IT IS NOT A SECURITY BOUNDARY AND THE DOCS SAY SO**: moving the system clock forward
    skips the wait. Unavoidable without a server, and a different threat from the
    5-year-old this app has always defended against.
  - The affordance shows on EVERY `'verify'`-mode code screen — the parent-screen gate,
    the exit-lock gate, the profile-switch gate (parent's decision 2026-08-02) — and it is
    DELIBERATELY SMALL AND LOW-CONTRAST (12px, 0.55 opacity, tucked into the card's
    bottom corner): a reading child will find any text eventually, which is exactly why
    the SAFEGUARD is the 24-hour wait plus the home-screen banner, never this link's
    obscurity. Never in SETUP mode (there is no code to have forgotten, and offering a
    reset there would be a second way to pick the first PIN), and
    the reset uses `startPin('setup', { replace: true })` so hardware-back cannot land on
    the verify screen it just satisfied. `planPinRecovery` follows the `planRejectedPurge`
    rule — **a nonsense window falls back to the default, never to a short one** — which
    here means a typo cannot hand the parent screen to the child the same afternoon.
- v1.0.27 — **THE STANDALONE-PLAYLIST FEATURE SHIPPED WITH A DATA-DESTROYING LOOP, AND
  THREE MORE HOLES.** All review-caught, all demonstrated against the running code; the
  v1.0.26 entry below describes the design — this entry is what it missed.
  - **THE MIRROR'S ORPHAN GC DELETED EVERY PLAYLIST VIDEO ON EVERY PASS.** The GC's
    one-line predicate compared `rec.channelId` against subscriptions — but a playlist
    subscription carries `PL…` while its videos deliberately keep their OWNER (`UC…`), so
    every foreign-owner playlist video read as an orphan: imported, raw-deleted (NO
    tombstone), re-imported pending, with every approval and every REJECTION undone in a
    30-minute loop. The decision is now pure `plan.planOrphanGC`: membership is judged by
    the FOLDER too (`pl:<id>` of a subscribed playlist; parked records by `homeFolderId`),
    a record with no channelId is never touched, and deleting the playlist still orphans
    its videos for real. `invariants.test.mjs` pins that `applySheetMirror` delegates and
    that the inline predicate cannot come back.
  - **A PLAYLIST COULD NOT BE DELETED.** Its sheet row classifies as `kind:'playlist'`,
    which `matchRowsForDeletion` did not know — the delete matched nothing, `clearFlushed`
    dropped the op anyway, and the still-present row re-subscribed it on the next sync,
    while the confirm promised removal "מקובץ המקורות". AND the add/delete never
    reconciled: the append travels as `pl:<id>` but `opIdentity` stamped `ch:<id>`
    unconditionally, so the flush re-appended the row it had just deleted. `delchannel`
    ops now carry `kind`, both identity and row-matching are kind-aware, and
    `planSheetMirror` protects `pl:<id>` pending appends like `ch:<id>` ones (without
    that, a playlist added on a READ-ONLY joined sheet was unsubscribed by the very next
    mirror pass, permanently — the append can never land there).
  - **SHARING A PLAYLIST COULD NEVER SUCCEED.** `handleShareInteractive` branched only on
    `kind === 'channel'`, so a playlist fell into the video branch: PIN → "להוסיף את
    הסרטון?" → הוספה → and `handleSourceShare`, which accepts only the source decision,
    answered "ההוספה בוטלה". The parent CONFIRMED and was told it was cancelled. A
    playlist now gets the source branch with its own feminine wording, and `onShareAdded`
    finally reads the `isPlaylist` flag share.js has passed since v1.0.26.
  - **THE STANDALONE STAGE PUSHED PAGE ITEMS UNFILTERED** — unlike the channel-playlists
    stage, nothing rejected entries with a missing `videoOwnerChannelId`, which is what
    private/deleted videos look like (untappable "Private video" tiles). It now runs
    `acceptPlaylistItem(v, {})`: no owner check (foreign videos are the point) and no
    shortIds (no UUSH sibling exists), but malformed ids and ownerless entries are out.
- v1.0.26 — **A SHARE FROM YOUTUBE COULD FAIL IN SEVEN WAYS AND SAY NOTHING.** Reported
  from the field as "sharing does not add the video, the parent screen does". The native
  side was never at fault (intent-filter, `onNewIntent` for cold+warm, matching field
  names, retained event) and neither was the classifier — verified against the real
  YouTube-app payloads including the `?si=` parameter. `handleShare` simply had **seven
  silent `return`s and no success message either**, so added / parked-for-approval /
  duplicate / previously-deleted / cancelled / unsupported all looked identical: nothing.
  - **EVERY ROUTE NOW ENDS IN A REASON** (`routeShare` returns one, `handleShare` reports
    it) and pure `plan.shareOutcome` turns it into text. `ui/toast.js` is the app's first
    non-blocking feedback channel — it must never block, never need dismissing, and never
    fight the PIN screen or a confirm that is already up. `invariants.test.mjs` pins that
    routeShare contains **no bare `return;`** and that every reason it can answer has a
    message. That guard's first version anchored to the start of a line and so could not
    fail on `if (!c) return;` — the exact shape it exists to catch.
  - **THREE REAL DROPS, all in the channel path**: a `null` decision (which
    `handleShareInteractive` returns for a channel whenever the PIN screen or a modal is
    already up — easy to hit on a share into a running app); a profile with no `sources`
    record, which returned instead of creating one the way the parent screen always has;
    and a failed reference resolve that reported `channelFailed` to a handler that showed
    nothing.
  - **A SHARED PLAYLIST WORKS TOO.** `classifySourceRow` understood playlists since
    v1.0.12 but `classifyShared` never did, so sharing one answered "unsupported" while
    pasting the identical link worked. A watch link merely CARRYING `&list=` must stay a
    video — otherwise sharing one video imports hundreds.
  - **THE PROFILE QUESTION IS ASKED WHENEVER THERE IS A CHOICE** (parent's decision
    2026-08-02). v1.0.23 also skipped it when several profiles followed one sheet — same
    library row either way — but a parent reported not knowing where a shared video went,
    and "it does not matter" is only true of the DATA. One profile still skips.
    `plan.shouldAskShareProfile` is deleted, not left dangling.
- v1.0.26 — **THE REJECTED ARCHIVE EMPTIES ITSELF AFTER 30 DAYS** (`REJECTED_TTL_DAYS`).
  v1.0.23 made a rejection PARKED rather than deleted so the parent can pull it back — but
  that means the archive only grows, and a channel re-offers its whole catalogue every 30
  minutes, so it grows fast. After the window the record is purged for real: delete + deny
  tombstone, exactly what "מחק לצמיתות" does, which is also what stops the video returning
  on the next sync.
  - **IT IS IRREVERSIBLE, SO IT IS STATED.** For a video inside a channel there is no way
    back at all — only a SHEET re-add revokes a tombstone, and a channel video has no row.
    The archive therefore carries the rule up front AND a per-row countdown
    (`parentRow`'s `note`); pure `plan.planRejectedPurge` returns both the expired keys and
    the days left, so the sweep and the label can never disagree about the deadline.
  - **A RECORD WITH NO `rejectedAt` IS NEVER AUTO-PURGED** — rows written before this
    existed, or arriving from a peer on an older app. Showing an old video costs nothing;
    deleting one the parent still wants cannot be undone.
  - **A NONSENSE WINDOW FALLS BACK TO THE DEFAULT, never to a short one.** The first
    version used `Math.max(1, Number(days) || 30)`, so a negative value clamped to a
    ONE-DAY window and a config typo would have emptied the whole archive on the next
    sync. Caught by its own test.
  - The sweep lives in `doSync`, not in the parent screen: it has to happen whether or not
    anyone opens that screen, and ONE place means the deadline cannot drift. It covers
    BOTH scopes (a rejection can be parked in the shared library or the personal one) and
    is wrapped in try/catch — housekeeping must never take the sync down with it.
- v1.0.26 — **THE PARENT CAN WATCH A VIDEO WITHOUT LEAVING THE QUEUE** (preview bubble).
  Tapping a row's THUMBNAIL in ממתינים or in הוספה opens a floating player over the parent
  screen. It is an OVERLAY, never a view: the scroll position, the open tab and the ticked
  rows all survive, because triaging a queue means coming straight back to the list.
  - **IT IS NOT THE KID PLAYER, DELIBERATELY.** `setupHud` binds window/document listeners
    and must never run twice without a teardown, and the kid HUD hides the timeline and
    turns a centre tap into play/pause — exactly backwards for a parent jumping through a
    video to judge it. The bubble builds a plain iframe from pure
    `playerlogic.previewEmbedUrl`: `controls=1` (YouTube's real scrub bar), `mute=1`
    (a child is usually in the room, and browsers block unmuted autoplay anyway — parent's
    decision), `rel=0`. A direct file gets a `<video controls>`. All three params are
    silent when wrong, so they are test-pinned.
  - `closePreview` empties the host: tearing the iframe out is what actually STOPS
    playback, and the parent view's `onLeave` calls it so no player survives the screen.
    Hardware back closes the BUBBLE first (`nav.register('parent')`), or the parent is
    thrown out of the screen they were triaging in.
  - **A DECISION ADVANCES TO THE NEXT ITEM** rather than closing (parent's decision):
    thirty videos must not cost thirty open/close cycles. `previewDecide` treats a handler
    returning `false` as "nothing happened" — a cancelled delete confirm must not skip the
    video the parent is still looking at.
  - **`refreshPendingList` NOW KEEPS THE TICKS.** It used to clear the whole selection on
    every rebuild, which would have silently undone twenty ticks each time the parent
    decided one video — the exact opposite of "the screen behind stays as it was". The old
    reason (a tick could point at a row that is gone) is answered by filtering the carried
    ids against the REBUILT list. Doing it by parameter first was wrong and the browser
    proved it: `refreshAfterAdd` rebuilds the list a beat later and cleared them back.
  - `parentRow` gained `onPreview` on the thumbnail, so BOTH lists got this from one
    change; the thumbnail is excluded from the row's selection toggle for the same reason
    ✅ and 🗑️ are. "פתח ביוטיוב" is offered unconditionally — an embedding-disabled video
    is a black box with no cheap way to detect it, and is exactly what a parent most wants
    to inspect.
- v1.0.26 — **A PLAYLIST IS A SOURCE.** Reported from the field, repeatedly, as "the link
  is not supported". The classifier was never at fault: `classifySourceRow` has answered
  `{kind:'playlist', playlistId}` since v1.0.12, for `m.youtube.com` and `www` alike. The
  app then threw it away — `parentAdd` handled only 'video' and 'channel', and
  `parseSourceRows` pushed playlist rows into `invalid` as `'playlist-unsupported-yet'`.
  **A missing feature wearing the costume of a parse error**, which is why it kept
  recurring: the message listed what IS supported instead of naming what was not.
  - **STORED AS A SUBSCRIPTION IN THE SAME TABLE** — a `libraryChannels` row with
    `kind:'playlist'` and the playlist id in the `channelId` slot. No schema change, no
    `DB_VERSION` bump, and it inherits Drive sync, deletion, the parent's channel list and
    the auto-approve flag for free. `doSync` splits `allSubs` so every CHANNEL stage
    (channels.list, the logo scrape, RSS, the UULF backfill) keeps seeing only real
    channels; `quota.js` already guards those id derivations with `/^UC/`, so the split is
    belt and braces rather than the only defence.
  - **THE UNIFY RULE** (parent's decision, 2026-08-02): pure `plan.playlistVideoFolder`.
    A playlist video whose owner channel is ALSO subscribed lands in `ch:<owner>`, not
    `pl:<id>`. Duplicate RECORDS were never the risk — `planMutations` keys on
    `yt:<videoId>` — the FOLDER was: `folderId` is in `DIFF_FIELDS`, so two passes that
    disagreed would rewrite the record every sync and break the churn-free invariant. It
    is also order-free: add the playlist first and subscribe later, and the next sync
    moves those videos by itself. A playlist whose videos ALL went to channel folders has
    count 0 and shows no tile — exactly right, it would have been an empty duplicate.
  - Unlike a channel's own playlists tab (v1.0.21), **FOREIGN VIDEOS ARE THE POINT** here,
    so they are kept; and Shorts cannot be told apart (no UUSH sibling exists for an
    arbitrary playlist), so they are INCLUDED per the standing "an unknown signal means
    include" rule.
  - **`pendingKeysOfChannel` MATCHES THE PARKED HOME FOLDER TOO.** A playlist video keeps
    its OWNER in `channelId` (the title-dedupe index and the unify rule both need that),
    so matching on `channelId` alone found ZERO for a playlist and the approval dialog
    never appeared — the exact shape of the v1.0.22 bug, on the new path. Caught in the
    browser: all 30 videos had imported correctly and the dialog still said nothing.
  - The outcome sentence is gender-correct: ערוץ is masculine, רשימה feminine
    (`channelAddOutcome`'s `isPlaylist`), and `diagnoseEmptyChannel` reports it on EVERY
    path — returning `{}` on the common one made a successful playlist import announce
    itself as "הערוץ נוסף".
- v1.0.25 — **DELETING A PROFILE NOW DELETES IT, AND IT STAYS DELETED.** The confirm has
  always said "כל הסרטונים של הפרופיל יימחקו. פעולה זו אינה הפיכה" while
  `deleteCurrentProfile` removed only the row in the Preferences profile list —
  **`db.purgeProfile` had ZERO CALLERS.** Measured 2026-08-02: a throwaway profile with one
  channel kept all 500 videos, its subscription and its sources record. Two halves:
  - **WHAT MAY BE ERASED IS A DECISION** (pure `plan.planProfilePurge`). `prof:<id>` is
    always the profile's own; the LIBRARY scope only when no sibling still reads it —
    `lib:<fnv1a(sheet)>` is SHARED and erasing it would take a sibling's whole library,
    the same question `planScopeAdoption` asks before a move. A sheet-less profile owns
    `lib:p:<id>` outright, and THAT is where nearly all its content lives, which is why
    the old "personal scope only" purge was effectively a no-op. `purgeProfile` also drops
    the library's `libraryChannels` rows and its per-library `meta` keys — **deleted, not
    `putMeta(k, null)`**, which leaves the row in place.
  - **A DELETION MUST SURVIVE THE NEXT PULL.** Both merge paths union profiles by id and
    nothing filtered them, so a delete lasted exactly until another device's document
    arrived. `store` now keeps a GROW-ONLY tombstone map (`profilesDeleted`), travels it in
    the Drive doc (`deletedProfiles`, additive), filters it in `mergeProfileLists`, and
    `applyRemoteDoc` adopts a peer's tombstones AND purges anything an earlier pull already
    restored. Grow-only is safe here where the video deny-list needed revocation: a profile
    id is minted randomly and never reused, so "the sheet re-added it" cannot arise.
- **Release records: [docs/V1045.md](docs/V1045.md), [docs/V1038.md](docs/V1038.md), [docs/V1033.md](docs/V1033.md), [docs/V1032.md](docs/V1032.md),
  [docs/V1026.md](docs/V1026.md), [docs/V1025.md](docs/V1025.md)** — what changed in each
  and why, including which features ALREADY EXISTED and were broken. The per-feature
  invariants stay below; those files are the map.
- **[docs/TESTING.md](docs/TESTING.md) — read before trusting a green run.** What the suite
  covers, what it structurally CANNOT see (no DOM, no IndexedDB, no network), the four bugs
  that shipped past it, and the device checklist for everything a browser cannot prove
  (share intents, the kiosk lock, cross-device convergence).
- v1.0.25 — **CONTINUOUS PLAY: at the end of a video the next one starts, without leaving
  the player.** OFF by default, PER PROFILE, and synced (it rides the v1.0.25 settings
  channel) — "one more video" is a parenting decision, not a device preference, and one
  account can hold a 3-year-old and a 7-year-old. A family that never opens the settings
  screen keeps v1.0.16 behaviour exactly: a video that ends calls `leaveWatch()`.
  The decision is pure `playerlogic.planAutoplay` → `'next' | 'retry' | 'stop'`:
  - **`onExit` NOW CARRIES A REASON** (`'ended' | 'error'`). `finish()` fires for an
    embedding-disabled video too, so without it a chain skips silently through every
    broken video in the library and the failure ceiling can never trigger. Note the
    `<video>` element's `'ended'` listener MUST be wrapped — the DOM hands a listener an
    Event, which would arrive as the reason.
  - **A CHAIN CAN ALWAYS END.** One retry of the same video absorbs a blip
    (`AUTOPLAY_RETRY_MS`), then it is skipped, and `AUTOPLAY_MAX_FAILURES` (5) consecutive
    failures stop the chain — a run of unplayable videos must never flip through black
    screens forever. `failures` counts CONSECUTIVE failures; a video that plays resets it.
  - **NEITHER 🎁 FOLDER NOR 🎁 VIDEO IS EVER CHAINED.** The `'new'` folder is refused
    outright — but gift state lives per child ON THE VIDEO, so wrapped tiles appear inside
    channel folders too, and the chain stops when the NEXT video is still wrapped
    (`nextIsGift`, from `giftStates`: `giftRank && !unwrappedAt`, the same predicate
    `tileEl` renders by). Found in the browser, not by reasoning: the first tap on a gift
    unwraps it and deliberately does NOT play, so a chain that called `openWatch` would
    skip the ritual AND leave the tile wrapped forever with its video already watched.
  - **`nextAfter` IS A THIRD MEMBER OF THE PAGINATION FAMILY** and lives beside
    `pageAnyFolder` for the reason that rule exists — "next" must be the tile that FOLLOWS
    ON SCREEN, so it has to know the same folder kinds (`new`/`grp:`/`sheet`/`ch:`+absorbed).
    The invariants test now pins that both cover the same set; a kind added to one and not
    the other means the chain silently disagrees with the grid. It uses `db.pageFolder`'s
    KEYSET mode — which had no caller until now — because loading a 2000-record folder to
    find one index at the end of every video is not acceptable on a low-end tablet.
  - The countdown overlay lives INSIDE `#player-wrap` (the element that goes fullscreen;
    anything outside it is invisible while playing) and sits ABOVE `.tap-shield`, which
    otherwise swallows every tap. It is the child's ONLY visible way out of a chain: 🏠 is
    outside the player by design (v1.0.2) and Android's back needs an edge swipe in
    immersive mode. Opening any video cancels a pending countdown, and leaving the watch
    view resets the whole chain — a queued video must never follow the child out.
- v1.0.25 — **SETTINGS TRAVEL NOW, THROUGH ONE CHANNEL** ([settings.js](www/js/settings.js)).
  Until this, exactly ONE setting-like value crossed between a family's devices —
  `libraryChannels.autoApprove`, and only because it rides a record that carries a
  timestamp. Everything a parent could actually change was device-local, so a PIN set on
  the phone left the tablet on its old code. Shape:
  `{ account: { <name>:{v,at} }, profiles: { <pid>: { <name>:{v,at} } } }`, stored in
  **Preferences, not IndexedDB** — these are preferences, pin.js needs them before any DB
  work, and it keeps the whole channel node-testable behind the existing localStorage stub.
  `at` is stamped INSIDE `putSetting`, never at the call sites (the v1.0.22
  `putLibraryChannel` lesson). Merge is per key: later write wins, and an exact tie takes
  the SAFE direction (`exitLock`/`shareApproval` → true, `autoplay` → false; the PIN hash
  has no safe direction so it orders by value — still commutative). Tests pin
  `merge(A,B) === merge(B,A)` **and** idempotence; a doc from an older app carries no
  `settings` key and must never read as "the family cleared everything".
  **`getSetting`'s fallback cannot answer "was this ever written?"** — passing `undefined`
  triggers the `fallback = null` default. pin.js reads the ENTRY via `getAllSettings`.
  That exact mistake shipped in this branch and every unit test stayed green, because they
  all call `setPin` first and so never took the migration branch; the browser caught it.
  - **THE PIN MIGRATES, the other settings do not** (parent's decision 2026-08-02 was
    "start fresh", but that question named exitLock and shareApproval). An existing hash is
    lifted out of Preferences on first read, then the legacy key is dropped — channel
    first, so no failure leaves the PIN nowhere. Resetting it would leave every installed
    app with NO gate for one launch, and `startPin`'s SETUP flow lets whoever arrives first
    pick the new code — on a child's tablet, the child. `clearPin` writes an explicit `''`
    rather than deleting the entry, or the next read would lift the old hash straight back.
  - **EXIT LOCK AND SHARE-APPROVAL ARE PER PROFILE** and both toggles name their child in
    the UI (`labelProfileSettings`). ⚠️ Existing values do NOT carry over — a family with
    the kiosk on finds it off after the update. Must appear in the release notes.
  - **A PER-PROFILE LOCK OPENS A HOLE, closed in the same release.** (v1.0.28 supersedes
    the conditional: the chip now gates EVERY mid-session switch, locked or not — the
    parent's decision — and the boot picker stays free. The fail-closed rule is unchanged.) The lock contains
    HOME/recents/back and hides the exit button, but the profile chip went straight to
    `backToProfiles` — so a child on a locked profile could tap their avatar, pick a
    sibling who is NOT locked, and walk out. Two taps. `onProfileChip` now PIN-gates
    leaving a locked profile; the chip stays visible because it is also how the child sees
    whose library they are in. It **fails CLOSED**: a throw leaves the child where they are,
    because falling back to `backToProfiles` would make the lock escapable by whatever
    threw. The launch arming reads the LAST ACTIVE profile (`prefGet('activeProfile')`) —
    it runs before a profile is picked, and without that there is an unlocked window from
    launch until someone taps a tile. **`activateProfile` re-applies it on every profile
    switch** (`applyExitLock` — pin/unpin plus the exit button). Both directions were wrong
    without that, and one is a real escape: arriving at a LOCKED profile from an unlocked
    one left the device unpinned with the exit button on screen, so the child the lock
    exists for could simply walk out.
- v1.0.25 — **ENTERING THE HOME PULLS, THEN SYNCS — AND THAT IS FINALLY TRUE ON LAUNCH.**
  v1.0.22 declared the two SERIALIZED because both write the same video records, and
  `pullThenSync` did serialize them — but it was never the only pipeline.
  `activateProfile` calls `nav.reset('gallery')`, which fires the gallery's `onEnter`
  **synchronously**, so `homeEntryRefresh` had already started the forced launch sync by
  the time the very next line reached `pullThenSync`. The pull then ran against a library
  the sync was actively rewriting — on every launch, on every device with backup enabled.
  There is now ONE pipeline (`entryRefresh`) with ONE caller (the gallery's `onEnter`) and
  one promise; `activateProfile` awaits that promise purely to own its loading screen
  (`awaitEntryRefresh`), and `pullThenSync` is gone. Because the pull now sits on the home
  entry rather than on activation, it also runs on every LATER return to the home (still
  throttled 60s) — which is what "sync against the database on every entry" actually means.
  The gates are pure `plan.planEntryRefresh` → `{ pull, forceSync }`: the first entry of a
  launch bypasses BOTH throttles, because opening the app is not the same act as a child
  flipping between the home and a video. The invariants test pins the ORDER inside
  `entryRefresh` (pull before sync, and `await`ed — an un-awaited pull IS the race) and
  that `maybePullDrive` keeps at most two call sites, entry and resume.
- v1.0.25 — **BOTH WAYS TO ADD A CHANNEL NOW IMPORT IT AND THEN ASK.** v1.0.22 gave the
  parent screen the "what should I do with this catalogue?" question and CLAUDE.md recorded
  that it covered "parent screen + share". **The share path never had it.**
  `share.handleChannelShare` subscribed the channel, fired a sync it did NOT await, and
  immediately announced "הערוץ נוסף! ✅ … חדשים ימתינו לאישור" — an outcome reported before
  there was one, over a back catalogue that then sat in ממתינים unannounced. That is the
  v1.0.22 bug, still live on the other half of the feature. Both callers now go through
  `app.importChannelAndAsk` (loading screen → awaited forced sync → `loading.hide()` →
  dialog), and a test pins that it has EXACTLY two callers and that share.js no longer syncs
  behind `onAdded` — sharing the path is what stops the two from drifting again.
  The three answers are **אישור הכל / אישור ידני / אחר כך** (relabelled from
  אישור אוטומטי / בחירה ידנית; the parent's decision 2026-08-02 kept the third button —
  without it the only way out is the scrim or hardware back, neither discoverable).
  אישור הכל is what ticks the ✅ in the parent's channel list: `refreshChannelsList`
  renders `cb.checked = !!lc.autoApprove`, so the flag IS the checkbox.
  **The channel-approval paths resolve the library scope instead of reading the bare
  `libScope` global** (`currentLibScope`, the same fallback `pendingTotal` already used).
  That global is published by `buildFolders`, i.e. only after a home render — and a share
  can now reach `offerChannelApproval` / `pickChannelVideos` on a cold start, where a null
  scope reads as "this library is empty": no dialog, and a picker with no rows.
  The outcome sentence is pure `plan.channelAddOutcome`, and it NAMES A ZERO too: a
  Shorts-only channel and "nothing arrived" are different facts, the first one permanent
  (Shorts are excluded on purpose). A plain ✅ is left for the single case that earns it —
  nothing new, but the channel does have content the child can see. `diagnoseEmptyChannel`
  does the two IDB reads only when the count is 0, so the common path skips them.
- v1.0.25 — **A FORCED SYNC CHAINS, NEVER JOINS — AND NOW THE CODE ACTUALLY DOES IT.**
  v1.0.21 wrote that sentence in the comment above `syncLibrary` and then shipped
  `if (!opts.force || cur.force) return cur.promise`, which JOINS whenever the RUNNING sync
  is itself forced. The first sync of every launch IS forced (`launchSyncDone`, app.js) and
  takes minutes on a real library — a page fetch per channel logo, up to 40 backfill pages —
  so the collision was ROUTINE, not rare. Everything the parent did inside that window rode
  a run that had already read the library at [sync2.js:266](www/js/sync2.js:266):
  - **adding a channel imported NOTHING.** The run listed the channels before the new one
    existed, finished "successfully", `offerChannelApproval` found 0 pending videos so the
    three-way dialog never appeared, and the parent was told "הערוץ סונכרן ✅" over an empty
    import. Pressing "רענון נתונים" (no run in flight) fixed it — exactly how it was
    reported from the field.
  - **every `refreshAfterAdd` path silently regressed to the v1.0.21 bug**: no
    `srcChannelId` (the video sits in the loose list instead of its channel folder) and no
    `giftRank` (not a 🎁).
  The decision is now pure `plan.planSyncDispatch` → `'start'|'join-running'|'join-queued'|
  'queue'`. **`join-queued` is load-bearing, not an optimisation**: a QUEUED run has read
  nothing yet, so it is guaranteed to observe the caller's write — without it three adds in
  a row would queue three full library sweeps. Measured in the browser 2026-08-02: with the
  old code two overlapping forced calls returned the IDENTICAL promise; with the fix they
  are separate runs, the second starting after the first ends.
  **`onProgress` now fans out to every caller a run serves** (`entry.listeners`). A joined
  caller used to lose its callback entirely — measured: the second caller received zero
  progress events — which is why the add-a-channel loading screen sat frozen on its first
  step for the whole run. A comment cannot fail a test, so `invariants.test.mjs` pins that
  `syncLibrary` delegates to the helper and handles every branch it can return.
  Also: a channel add reporting ZERO now says WHICH zero instead of the reassuring
  "הערוץ סונכרן ✅" that hid this for a release — see `plan.channelAddOutcome` above, which
  is where that decision lives now, so BOTH add paths get it.
- v1.0.24 — **A CHANNEL FOLDER SHOWING 📺 IS A BUG, AND IT HAD TWO INDEPENDENT CAUSES.**
  Reported from the field on @rotemama4kids. NOT the channel and NOT the parser: both
  `yt.fetchChannelMeta` and the keyless `yt.scrapeChannelLogo` return a good avatar for it
  today (verified against the live page), and `extractChannelLogoFromHtml` matches the real
  HTML. The two defects, both now pinned by `plan.planChannelLogo`:
  - **`logoTriedAt` WAS STAMPED FOR AN ATTEMPT THAT NEVER HAPPENED.** The channels.list
    writer stamped it unconditionally — but `fetchChannelMeta` with no key returns empty
    logos WITHOUT making a request, and its error branch does the same. The keyless
    page-scrape fifteen lines below is gated on that field, so the ONLY working fallback was
    suppressed for a WEEK starting on a channel's very first sync — exactly when the parent
    is looking at the new tile. The scrape (the last resort) now owns `logoTriedAt`; the API
    path owns `logoApiTriedAt`; only a real URL stamps `logoFetchedAt`.
  - **A STORED URL THAT WILL NOT LOAD IS WORSE THAN NO URL.** `img.onerror` silently swaps
    in the emoji, and BOTH fetch paths skipped any channel that already had a `logoUrl` — so
    a channel that rebrands (old avatar URL 404s) loses its picture forever. The renderer now
    calls `noteLogoFailure`, and a failure newer than `logoFetchedAt` marks the URL known-bad.
    **The marker lives in `meta` (`db.getLogoFailedAt`/`setLogoFailedAt`), NOT on the channel
    record** — 13 sync call sites read a channel, spend seconds on the network and write the
    whole snapshot back, so a marker on the record is reverted by whichever stage is in
    flight. That is measured, not theoretical: it swallowed the first version of this fix.
    It is per-device by nature anyway. The scrape loop RE-READS the record before writing,
    for the same reason.
  `logoApiTriedAt` being a NEW field is the migration: every channel already on a device
  passes the API gate exactly once after the update, which heals the ones stranded by the
  first defect. Retry budgets differ by cost — API 24h (batched, ~1 unit), scrape 7 days (a
  1.5MB page fetch each). The parent's channel list rendered an EMPTY `<img>` for a
  logo-less channel (not even the 📺); it now shares the same fallback and reporting.
  DECISION (2026-08-01): the `fallbackThumbUrl` stage still requires a LIVE video — a
  thumbnail the parent has not approved must not appear anywhere, so a channel whose whole
  backlog is pending keeps 📺 in the parent's list until the first approval.
  NOT DONE, and deliberately: a candidate chain over the two Google avatar hosts
  (`yt3.ggpht.com` ⇄ `yt3.googleusercontent.com`). It looked necessary because the sandboxed
  preview browser loaded only one of them — but all four host×size forms answer 200 with
  real bytes over the real network, so that was an artifact of the test environment and the
  code would have been speculative complexity justified by a false measurement.
- v1.0.24 — **A DOT THAT MEANS TWO THINGS MEANS NOTHING.** A manual-approval channel already
  parked its new uploads in the queue (`plan.js` `needsApproval`, unchanged) — the failure was
  purely that nobody could TELL. The gate dot lit for `pending > 0 || updateReady` in the same
  red, and the parent screen landed on אודות, so the routine errand (a video the child cannot
  see until someone says yes) was indistinguishable from the rare one and got learned as
  ignorable. Now the dot's COLOUR IS ITS DESTINATION (pure `plan.attentionDot` →
  `'info'|'alert'|null`): **blue** (`.attn-dot-info`, `--brand`) = content waiting, and crossing
  the PIN lands on ממתינים; **red** (the default) = an app update, landing on אודות. A tie goes
  to the content — a child is waiting at the other end of it, and the update keeps its own
  `about-dot` regardless. The `#pending-badge` turned blue to match: a parent who followed a
  blue dot must not arrive at a red count.
  **THE LANDING TAB IS DECIDED BEFORE THE VIEW IS SHOWN.** `enterParent` awaits `pendingTotal()`
  and feeds pure `parentLandingTab(sticky, pending)`; deciding inside `refreshParent` would
  render אודות and visibly jump, because `setParentTab` runs there BEFORE the lists are
  awaited. The override fires on EVERY visit while the queue is non-empty (not once), and an
  empty queue restores the sticky tab so it can never strand a parent who lives in הגדרות.
  Two consequences of awaiting before navigating, both load-bearing: `enterParent` bails
  unless `nav.isActive('pin')` (hardware-back during that yield means the parent changed their
  mind, and replacing whatever is on top would be a real bug), and `pendingTotal` falls back to
  `db.getSources(...).libraryId` when `libScope` is still null — that global is published by
  `buildFolders`, i.e. only after a home render, so asking earlier counted ZERO and reported an
  empty queue that was full. `PARENT_TAB_IDS` moved to plan.js next to the helper that
  validates against it. `refreshPendingList` now ends with `refreshGateDot()`: rejecting the
  last waiting video used to leave the dot lit until something re-rendered the home.
- v1.0.24 — **THE ממתינים QUEUE HAS THE PICKER'S SELECTION, WITH ONE DELIBERATE DIFFERENCE.**
  Per-row `.pick-cb` checkboxes + `#pending-all`/`#pending-none` (סמן הכול / נקה בחירה), whole
  row as the tap target — the same mechanism as `view-pick`. It does NOT reuse `.pick-off`:
  there an unticked row is a video about to be REJECTED so the strike-through is the truth,
  here it is merely outside the current bulk action and dimming half the list would read as
  "already thrown out". Selected rows get `.li-sel` instead. **Nothing is ticked by default**,
  unlike the picker (a freshly added channel is presumed wanted; this queue is a drip being
  triaged, and pre-ticking puts a whole-queue action one tap away under a label that reads
  like a selection). `approve-all`/`reject-all` are SELECTION-AWARE via pure
  `plan.pendingBulkAction`: with nothing ticked they keep their v1.0.4 whole-queue meaning —
  the only way to reach rows past `PARENT_LIST_CAP` — and one tick narrows both and rewrites
  the label, so "דחיית הכול" can never throw out thirty when three are ticked. Selecting all
  200 rendered rows is still a SELECTION, never the 250-row queue. `collectPending` was split
  out of `refreshPendingList` so the handlers can read fresh records WITHOUT re-rendering:
  re-rendering clears the ticks, and cancelling the confirm dialog would then leave the parent
  with nothing selected. The row-click handler skips `e.target.closest('button')` — a tap on
  ✅/🗑️ must never also flip the selection. Selection ids are `scopeId \0 key`: one `yt:<id>`
  can sit in both the shared and the personal scope and `approvePending` takes ONE scope.
- v1.0.23 — **A SHARE FROM ANDROID ASKS WHICH PROFILE, BUT ONLY WHEN THAT CHANGES ANYTHING.**
  `share.handleShare` routed everything to `activeProfileId` with no question. It now consults
  an optional `profileChooser` callback (`app.chooseShareProfile`), gated by pure
  `plan.shouldAskShareProfile(targets)`: **two profiles that follow the same sheet share one
  library scope**, so the video is the same row either way and asking would be noise that
  trains the parent to tap through dialogs. One profile ⇒ never ask. A profile with no
  sources counts as its own destination.
  Choosing also SWITCHES to that profile (decision 2026-08-01), so the picker resolves
  through `activateProfile` and the share's PIN+confirm then runs inside it.
  `renderProfiles({ onPick, title })` is what made this possible — every tile used to
  hard-wire `activateProfile`, so selection and activation were inseparable and nothing could
  ask "which child?". In pick mode the ➕ tile is HIDDEN: creating a profile runs the sheet
  wizard and its own activation, which would abandon the share mid-flight.
  **THE COLD-START PATH DELIBERATELY DOES NOT ASK.** A share arriving with no active profile
  is stashed in Preferences and replayed by `drainShareQueue` — which passes
  `alreadyRouted:true` — because that boot lands on the profile picker anyway and the profile
  the parent taps IS the answer. Asking again would be the same question twice.
  Backing out of the picker writes NOTHING (no stash, no record): `nav.register('profiles')`
  gained an `onLeave`/`onBack` that resolves the chooser with null, so the awaiting share
  cannot hang forever.
- v1.0.23 — **A NEW CHANNEL ASKS THREE QUESTIONS, NOT TWO.** `offerChannelApproval` now
  raises a three-way choice (decision 2026-08-01): **אישור אוטומטי** (everything now and
  every future upload, + the auto-approve flag), **בחירה ידנית** (→ `view-pick`), or
  **אחר כך** (all stay waiting). The third option needed a REAL third modal button
  (`modal-third`, optional `third:` in `ui/modal.js`, `askKid` → `'third'`): mapping an
  answer onto an accidental dismiss would let a child poking the scrim decide what reaches
  them. `.modal-btns` wraps, because three Hebrew labels do not fit one phone row.
  `view-pick` lists every waiting video of that channel with **everything ticked** (a channel
  is usually added because it is wanted, so the job is unticking a few — only safe because
  unticking is now reversible), whole-row tap targets, סמן הכול / נקה בחירה, and a live count
  in the confirm button. Ticked → live; unticked → `'rejected'`. It reuses view-whatsnew's
  skeleton so only the list scrolls and 109 items can never push the confirm button
  off-screen — and **`#view-pick.active` must carry the centering flex**, or the fixed-width
  `.wn-wrap` pins itself to the RTL right edge (measured: 560px at left:720 of 1280).
  The rejected archive lives inside the ממתינים tab as a collapsed `<details>` (`#rejected-box`,
  hidden at zero) with per-row restore ✅ and per-row permanent delete 🗑️, plus
  "מחק לצמיתות" to empty it. `parentRow` renders 🗑️ only when given an `onDelete` — it used
  to bind `undefined` unconditionally, so a caller that omits it drew a dead button.
  Asking is scoped to the paths where the parent is PRESENT (parent screen + share). A channel
  from the SHEET keeps today's behaviour: column C already carries the auto/manual answer.
- v1.0.22 — **ADDING A CHANNEL ASKS ONCE, AND SAYS WHAT ACTUALLY HAPPENED.** A channel
  added in the parent screen is created `autoApprove:false`, so its ENTIRE back catalogue
  landed in the approval queue while the message read "הערוץ סונכרן ✅" — the parent had no
  reason to look in ממתינים, and the child's home stayed empty. Pasting a channel link
  behind the PIN is a deliberate parental act, so `offerChannelApproval()` (app.js) now asks
  once, right after the import: "yes" approves the backlog AND flips `autoApprove` so future
  uploads flow without another visit; "רק לסקירה" keeps them queued. Either way the status
  line reports the real outcome (`N אושרו` / `N ממתינים לאישור`) — a reassuring ✅ over an
  invisible backlog is how this survived to the field. Decision (2026-07-31): ASK, never
  auto-approve silently — it is the one moment before a stranger's whole catalogue reaches a
  5-year-old. The dialog is raised only AFTER `loading.hide()` (modals must never stack), so
  the channel add now awaits its sync instead of firing it into a `.then()`. The pending
  lookup + bulk approve are shared with the channel-list auto-approve toggle
  (`pendingKeysOfChannel` / `approveChannelBacklog`) so the two paths cannot drift.
- v1.0.21 — **A CHANNEL MEANS ITS "VIDEOS" TAB + ITS "PLAYLISTS" TAB. NOTHING ELSE.**
  No Shorts, no live streams. The mechanism is playlist membership, and it is the only
  correct one:
  - YouTube auto-generates siblings of the uploads playlist, addressed by swapping the
    prefix on the channel id: `UU…` all uploads, **`UULF…` long-form only (= the Videos
    tab)**, `UUSH…` Shorts only, `UULV…` live. `quota.longFormPlaylistIdFor` /
    `shortsPlaylistIdFor`. The backfill pages UULF instead of UU — same
    `playlistItems.list` call, **zero extra quota**. UNDOCUMENTED by Google; measured
    2026-07-31 on Cocomelon / Blippi / Super Simple Songs: `UULF ∪ UUSH = UU` exactly,
    no overlap, no leftovers.
  - **NEVER FILTER BY DURATION.** A Short is "≤3 minutes AND square-or-taller"; the API
    exposes no aspect ratio and no `isShort` field at all. 6 of the 15 most recent Super
    Simple Songs LONG-FORM uploads are under 3 minutes (3 of 15 for Cocomelon), so a
    length rule would delete real nursery rhymes — the app's core content. An invariants
    test rejects any ISO-8601 duration parser anywhere in `www/js`.
  - A variant playlist **does not exist** when the channel has no content of that type, so
    a Shorts-only channel answers `404 playlistNotFound` (`fetchUploadsPage(...).notFound`).
    That is information: the channel is marked `noLongForm`, the backfill is closed so we
    stop asking, and the parent's channel list SAYS SO. Deliberately NOT falling back to
    `UU` — that would import the very Shorts being excluded.
  - The RSS incremental path cannot see playlists, so it uses the other free signal: each
    entry's `<link rel="alternate">` is `/shorts/…` vs `/watch?v=…` vs `/live/…`
    (`ytrss.altLinkKind` → `isShort`/`isLive`). Measured 100% agreement with UUSH/UULF
    over 60 videos on 4 channels. Everything here rests on undocumented behaviour, so an
    UNKNOWN signal means INCLUDE: a wrongly hidden video is a bug the parent cannot
    explain, a leaked Short is cosmetic.
  - The **playlists tab is a SOURCE, not a folder layout** (decision 2026-07-31): its
    videos land in the channel's own `ch:<id>` folder, mixed by date. Own budget
    (`PLAYLIST_PAGE_BUDGET`) so it can never starve the uploads pass, walked only after
    `backfillDone`, and resumable per page via `playlistQueue`/`playlistCursor`.
    Two filters are load-bearing: **foreign videos are dropped** (`videoOwnerChannelId
    !== channelId` — the parent subscribed to THIS channel, not to whatever it curated),
    and the channel's own Shorts are dropped via UUSH membership, because
    `playlistItems` carries no Shorts flag. Playlists whose title matches `/shorts?/i`
    are skipped outright.
  - **Duplicates need no new code**: `planMutations` keys on `yt:<videoId>` and its
    per-channel title index also merges same-titled twins WITHIN a run, so the heavy
    Videos-tab∩playlists overlap collapses to one record and one gift (test-pinned).
    Note the price, also pinned: a same-title/DIFFERENT-id twin (an alt mix, a re-upload)
    merges too, and `mergedFrom` makes that permanent — the loser can never be imported.
  - Review fixes, each now a rule:
    - **A PAGE TOKEN BELONGS TO ONE PLAYLIST.** `backfillPlaylistId` travels with
      `backfillCursor`, and `quota.planBackfillPlaylist` RESETS the cursor on a mismatch.
      Reusing a `UU…` token against `UULF…` either skipped a slice of the back catalogue
      and latched `backfillDone`, or was rejected and written back — leaving the channel
      returning `'backfill'` forever, never delivering another video. `playlistId: null`
      means SKIP; substituting `UU…` is what the whole release exists to avoid.
    - **PAGING STATE NEVER TRAVELS TO DRIVE.** `serializeDb` strips `backfillCursor`,
      `backfillPlaylistId`, `playlistCursor`, `playlistQueue`, `playlistsDone`,
      `noLongForm`, and the apply side keeps the LOCAL values. A peer's "playlists
      finished" made another device skip pages it had never walked.
    - **`playlistsDone` REQUIRES A COMPLETE ENUMERATION** (`plan.planPlaylistAdvance`).
      Deriving it from "the queue is empty" made one throttled first call disable the
      source for that channel forever — nothing rearms it. `db.deleteLibraryChannel`
      now rearms the playlist walk and `noLongForm` alongside the backfill.
    - **A MISSING `videoOwnerChannelId` IS REJECTED** (`plan.acceptPlaylistItem`): that
      is what private and deleted playlist entries look like, and they reached the child
      as untappable "Private video" tiles. RSS fails OPEN, playlist items fail CLOSED.
    - **ONE 404 IS A CHANNEL, ALL 404s ARE AN OUTAGE** (`plan.planNoLongForm` +
      `planLongFormOutage`). Only a first-page 404 on a derived id means "Shorts-only";
      every channel 404ing at once means YouTube retired the alias, so nothing is closed
      and no parent is told something false. `noLongForm` is retracted the moment
      long-form content appears.
    - **A FORCED SYNC CHAINS, NEVER JOINS.** `inFlight` used to hand a forced caller the
      running promise and drop its opts, so a share landing inside the launch sync's
      window got no `srcChannelId` and no `giftRank` — the exact bug it was fixing.
    - **`planGifts` CAPS THE OUTSTANDING GIFTS AT `baseline` ON BOTH BRANCHES.** The
      incremental branch had no ceiling, so approve-all / a backfill going live / a
      baseline spent on a near-empty library gifted EVERYTHING. A runaway 🎁 folder is
      now unrepresentable rather than repairable, and the NEWEST arrivals get the ranks.
    - `refreshAfterAdd` refuses to run under a playing video (a forced sync also bypasses
      the per-channel RSS throttle, so it is a full sweep), `parentAdd` AWAITS its sheet
      row before syncing (its own mirror could otherwise tombstone it), and the
      channel-auto-approve bulk path calls it too.
    - Source-level guards may not pin SYNTAX. Three did, and all three broke on a
      refactor that improved the code while a dead filter would have passed them. The
      decisions live in pure `plan.js`/`quota.js` helpers with behavioural tests; the
      only greps left are the ones a test cannot express (no duration parser anywhere,
      no second caller of `db.pageGifts`).
- v1.0.21 field fixes — these are INVARIANTS now:
  - **`pageAnyFolder` PAGES 🎁 TOO.** 🎁 "חדשים" is not a stored folder — no record carries
    `folderId:'new'`, so `folderRange(scope,'new')` is an exact bound matching nothing.
    `renderGridPage` had its own gift branch and `renderWatchGrid` did not, so opening a
    gift left the UNDER-PLAYER GRID EMPTY: the child lost every way to reach the next
    video. The gift case now lives in `pageGiftFolder`, reached ONLY through
    `pageAnyFolder` (still THE one pagination entry point), and `renderGridPage` has no
    special case left. A test pins that nothing calls `db.pageGifts`/`db.pageFolder`
    outside it — a second renderer must never grow a private branch again.
  - **A FRESHLY ADDED RECORD IS INERT UNTIL A SYNC TOUCHES IT.** `srcChannelId` is written
    only by the sync's enrichment stage, and that field is what `groupSinglesByChannel`
    folds a single into its 🎞️/📺 folder by; `giftRank` is assigned only by
    `planProfileGifts`. So a video shared from YouTube (or pasted in the parent screen)
    sat in the loose "סרטונים נוספים" list and was NOT a 🎁 until the parent happened to
    press "רענון נתונים". Every path that makes a record live now calls
    `refreshAfterAdd()` — manual add, share, single approve, approve-all — which forces
    the sync (the 3-min `shouldSync` throttle is exactly what hid this), reloads gift
    state and re-renders. It is SILENT and non-blocking: covering a populated grid with
    the loading screen is the worse bug (v1.0.18). A channel share already synced itself;
    a PENDING share deliberately waits for approval, which syncs then.
  - **THE FIRST REFRESH OF EACH LAUNCH IS FORCED** (`launchSyncDone`, per process). The
    3-min content throttle and the 6h update-check throttle both exist for good reasons
    mid-session, but together they meant reopening the app minutes after the parent edited
    the sheet showed stale content, and a release could stay hidden for a whole day of
    launches. Later home entries keep both throttles. The update check stays `silent`, so
    `update.skip` still suppresses a version the parent declined — only the red dot shows.
    App RESUME also re-checks for a release now: coming back from the background does not
    re-fire the gallery's `onEnter`, so a device left running for days never looked.
- v1.0.4: launch update PROMPT (decline stores `update.skip` per version — the throttled
  check path honors it); one-time Google-connect screen before profiles (`gauth.introDone`
  pref; restores profiles + per-profile sheet via the Drive doc's additive `profileSources`);
  folder tiles restyled + keyless channel-logo scrape (`yt.scrapeChannelLogo`, weekly retry);
  real exit via `KidsNative.exitApp`; attention dots (`gate-dot`, `about-dot` + the pending
  badge inside the parent screen) — see v1.0.24 for what the colours mean now. There is no
  `settings-dot`: the update UI moved to the About tab in v1.0.8 and took the dot with it.
- v1.0.5: in-place delete from the watch page (`watch-delete` → parameterized PIN gate
  `startPin(mode, {onSuccess, replace, title})` — replace:true so back never lands on a
  torn-down player → confirm → deleteVideo in EVERY scope holding the key → home); share
  the app from parent settings (`KidsNative.shareText` chooser → Web Share → clipboard;
  message built by pure `update.buildAppShareMessage` — explainer page first, then the
  APK link, which since v1.0.20 is ALWAYS `update.latestApkUrl()`
  (`/releases/latest/download/kids-player.apk`, `STABLE_APK_ASSET`) and never
  `latest.assetUrl`: a forwarded WhatsApp message outlives its release and must not
  install a frozen build. `test/distribution.test.mjs` pins that link, the website
  button and both release scripts to ONE asset name).
- v1.0.14: parent screen LANDS on "אודות" (`PARENT_TABS[0]`; the panel's initial markup
  must match it or the screen flashes empty). Voluntary support block: two FREE ways to
  help (share / feedback) + `❤️ תרומה למפתח` → `askKid` payment-method choice (an
  accidental dismiss picks nothing) → `platform.openExternal` → `KidsNative.openUrl`
  (http(s) only; the WebView blocks external navigation by design). ALL links live in
  `www/js/donate.js` (`DONATE_LINKS`) — empty string = method not offered, both empty =
  donate button hidden entirely; pure `donateOptions`/`shouldShowDonateNudge` are tested.
  ONE-TIME nudge in the parent screen after 30 days of use (`install.firstSeenAt` stamped
  at first launch, `donate.nudgeDismissed` kills it forever). Never shown to the child.
- v1.0.13: what's-new is a real SCROLLING view (`view-whatsnew`), not the modal (the old
  `alertKid` card had no max-height, so long English bodies overflowed it). Only `.wn-body`
  scrolls — header and button stay put. Notes are PARENT-FACING Hebrew:
  `update.extractReleaseNotes` prefers the `## מה חדש` section of the release body and
  otherwise de-noises the whole body (drops headings, urls, @handles, PR refs, markdown,
  "Full Changelog"); `buildWhatsNew` groups EVERY version above the installed one
  (newest first, cap 8 + `moreCount`). `checkForUpdate` now fetches `/releases?per_page=30`
  (same single call) → `latest.whatsNew` + `update.notesAll` (all versions, for the About
  tab's 🎉 button after an update). Back / "לא עכשיו" CANCELS the update. release.sh /
  release.ps1 wrap the notes argument in a `## מה חדש` heading (default: Hebrew
  "שיפורים ותיקונים"); `scripts/backfill-release-notes.sh` adds Hebrew sections to
  pre-v1.0.13 releases (idempotent, keeps the original body below a divider; needs WRITE
  access — the local gh account has read-only on devfassaf).
- v1.0.12: (a) REMOVAL ROWS — a video inside a channel has no row of its own, so its
  deletion travels as a comment row `# הוסר: <link> — <title>` (`classify.parseRemovalRow`
  → `classifySourceRow` kind 'removed'; old app versions skip comments, so a removal can
  never resurrect content there). A removal row WINS over a video row of the same key in
  the same sheet; the mirror denies those keys and never un-denies them.
  `enqueueSheetRemovalRow` refuses rows that don't round-trip (no dead rows). Bulk
  reject-all deliberately writes NO rows (hundreds would wreck the sheet).
  (b) LOOSE-SINGLE GROUPING — `plan.groupSinglesByChannel` (pure) folds 2+ singles of the
  same channel into a VIRTUAL `grp:<channelId>` folder (🎞️ אוסף chip); one single stays
  loose, so deleting down to one un-groups by itself. Singles of an already-subscribed
  channel are absorbed into its 📺 folder instead. `srcChannelId/srcChannelTitle` come
  free from the videos.list(snippet)/oEmbed calls titles already make (sync enrichment
  stage, ≤100/run, weekly retry). `pageAnyFolder` is the ONE pagination entry point
  (group slices / trimmed flat list / channel+absorbed prepend).
  (c) The sheet wizard ALWAYS asks (no silent adopt): join `<profile>`'s file (one button
  per distinct sheet, PIN-gated) / create (`sheetwrite.sheetNameFor` → "<שם>_רשימת
  סרטונים") / paste link / skip.
- v1.0.11: exit lock (`exitLock` pref, PER-DEVICE, settings toggle) — OS screen-pinning
  kiosk via `KidsNative.lockTask/unlockTask` (HOME is uninterceptable by apps; lock-task
  is the sanctioned mechanism; native exitApp stopLockTask()s defensively first). Exit
  flow when on: confirm → PIN ("קוד הורים ליציאה") → unpin + exit; exit button hidden;
  re-armed at every launch. TV parent screens are D-pad-complete (OK toggles
  checkboxes — the text-field guard exempts checkbox/radio inputs). Google-verification
  kit: docs/site/ homepage+privacy for GitHub Pages + submission walkthrough in
  GOOGLE_CLOUD_SETUP.md שלב 3א (the unverified warning is scope-sensitivity, not code).
- v1.0.10: the sheet is the truth in BOTH directions — deletions too. sheetwrite ops
  queue (append/delvideo/delchannel, reconcileOps latest-intent, flush deletes rows
  bottom-up via batchUpdate then appends with sheet-presence dedupe); sync mirror stage
  (sheetSeen baseline diff, valve alert meta + sources-tab resolution UI); deny-list
  became revocable (see invariants). Channel remove = full cleanup everywhere.
- v1.0.9: Android TV support, same APK (manifest: LEANBACK_LAUNCHER + optional
  leanback/touchscreen + tv_banner drawable). `KidsNative.isTv` (UiModeManager) →
  `platform.isTv()` (dev override: localStorage tv=1) → `html.tv` class = 10-foot CSS
  (overscan padding, 4-col grid ≥900px, big focus ring) + `ui/dpad.js` D-pad focus
  manager (pure geometry in spatial.js — no wrap-around, orthogonal-drift penalty;
  fresh focus prefers GRID content over top-bar chrome). Watch-view remote model:
  top buttons ↕ PLAYER (nothing focused: OK=pause, ←→=seek via `player.handleTvKey`)
  ↕ under-player grid. Sideloading on TV needs the Downloader-app/adb path once.
- v1.0.8: onboarding tour (`view-tour`, once per install via `tour.done` pref; REAL app
  screenshots in www/assets/tour/ — the playwright staging script that made them was
  scratchpad tooling and is NOT in the repo, so they must be re-shot by hand; replay
  from the About tab); sheet-setup wizard after profile creation (`view-sheet-setup`:
  skip / create-a-sheet via `sheetwrite.createSourceSheet` — spreadsheets.create +
  anyone-reader permission + starter # row — / paste-link; PIN-gated; a new profile
  AUTO-ADOPTS an existing family sheet and skips the wizard; restored profiles never
  see it); About tab (app explanation, version+update UI moved from settings,
  `about-dot`, mailto contact, tour replay); what's-new dialog (release notes) before
  every install; data-migrations framework (`dataver.js`, meta dataVersion; step 1 =
  force sheet re-parse); duplicate profile names blocked (`profileNameExists`);
  clear-cache lives ONLY in the sources tab (was in the every-tab footer).
- v1.0.7: interactive share adds — a YouTube share (video OR channel, `classifyShared`)
  opens PIN → confirm → live + sheet row; cancel parks a video as pending, a channel is
  dropped (share.js falls back to silent pending without the handler). `startPin` gained
  `onDone` (fires exactly once — success consumes it before navigation, pin onLeave fires
  cancel). Home search (`search-open` → `view-search`): pure ranking in search.js over
  live records + channel folders, back-from-watch returns to results. Home entry syncs
  (shouldSync now 3 min) + re-offers updates (once per session); installing an update now
  requires the parent PIN. pin-cancel returns to the PREVIOUS view (nav.back), not
  hard-coded gallery.
- v1.0.6: the sheet is the single master list — sheetwrite.js appends manual adds,
  manual channels and approved shares back to it (requires the `spreadsheets` scope in
  GoogleAuthPlugin + edit rights; queue survives offline; published /d/e/ links can't be
  written to). ONE shared "סרטונים נוספים" folder: `absorbMineIntoShared` idempotently
  folds profile-scope 'mine' records into the library 'sheet' folder on every activation
  (deny lists union via `db.copyDenies`; share.js writes lib scope directly when sources
  exist). Channel auto-approve toggle now offers to approve that channel's PENDING videos
  (dialog with count). Channels without a logo get a PERSISTED `fallbackThumbUrl` (oldest
  live video's thumbnail) so folders stay visually distinct.
- The updater reads `devfassaf/kids_player` releases/latest (`UPDATE_REPO` in update.js).
  EVERY release carries **TWO copies of the same APK** (v1.0.19):
  `kids-player-v<X.Y.Z>.apk` (humans + `pickApkAsset`'s exact match) and
  `kids-player.apk` (a STABLE name, because GitHub's
  `/releases/latest/download/<asset>` redirect — what the website's download button
  uses — resolves only an exactly-named asset). Both release.sh and release.ps1
  upload both, and `test/distribution.test.mjs` pins the names together across the
  two scripts and docs/index.html. Publishing by hand with only one file silently
  404s the website button.
- v1.0.18: (a) EVERY BLOCKING WAIT uses the full-screen `view-loading` (horse/rocket/
  balloon/train), not a `.form-msg` line — Google connect, Drive enable/push, sheet
  creation, forced sync, add-channel. `loading.show({title, step, pct})` +
  `loading.progress(p)` consume the `pct` sync2 always emitted; an INDETERMINATE step
  hides the bar rather than freezing it. Always `hide()` in a `finally`, and hide
  BEFORE any modal (they must never stack). The 3-min background refresh on home entry
  deliberately does NOT show it — covering a populated grid is the worse bug.
  (b) TWO TOUR DECKS share `view-tour`: `TOUR_SLIDES` (landing page + 5 screens) and
  `ADD_GUIDE_SLIDES` (how to add content: YouTube share / in-app paste / the sheet).
  Content and ALL bounds arithmetic live in [tour.js](www/js/tour.js) (pure, no imports,
  unit-tested) — app.js holds only the DOM. Only the ONBOARDING deck may write
  `tour.done`. Guide illustrations are hand-authored SVGs in www/assets/guide/, all
  `viewBox="0 0 1280 800"` to match the screenshots (the slide CSS has no max-height,
  so a different ratio pushes the nav off-screen). See v1.0.20 for the guide deck's
  current form.
- v1.0.20 field fixes — these are INVARIANTS now:
  - **A LONE CHANNEL IS STILL A FOLDER.** `renderHome` flattens its single folder into a
    flat video list only for the loose lists (`plan.shouldFlattenHome` → `'sheet'`/`'mine'`).
    The old rule was "exactly one folder, whatever it is", so a library whose only content
    was ONE subscribed channel rendered the whole backfill flat — no 📺 tile, no logo,
    which is exactly what the parent subscribed for. 🎁 alone is never the whole home.
  - **HANDLES ARE NOT ASCII.** `parseChannelRef` accepts `\p{L}\p{N}._-` (YouTube's own
    3-30 rule) and percent-DECODES the segment first: `m.youtube.com/@חלומותחסידיים` and
    the `%D7%97…` form the YouTube app puts on the clipboard both used to be rejected as
    "unsupported link". The stored value is the readable handle, and `yt.channelPageUrl()`
    encodes it exactly once (encodeURI escapes `%`, so a still-encoded handle would become
    `%25D7%2597…` and 404 forever). Keep the literal `@`.
  - **THE GIFT BASELINE NEEDS SOMETHING TO BASELINE.** `plan.shouldRecordGiftBaseline`
    refuses to burn the flag when no record is live yet. Adding a channel syncs while
    everything is still pending, so the flag was spent on nothing: the child got NO gifts
    after approval, and the next sync took the incremental path and gifted the ENTIRE
    backfill. `dataver` step 2 (`plan.planGiftRunawayRepair`) retires such a pile on
    already-affected devices — only above an implausible floor (60), and `giftRank` must
    be DELETED not zeroed (the sparse by_gift index is the 🎁 folder).
    **RANK IS NOT RECENCY** on those piles: only `planGifts`' BASELINE branch sorts by
    `compareForDisplay`; the INCREMENTAL branch (the one that creates a runaway) stamps
    `maxRank+1` while walking `loadMergeIndex`, a cursor over the `[scopeId,key]` primary
    key — i.e. ALPHABETICAL. Ranking the repair by `giftRank` kept an arbitrary dozen and
    retired the genuinely newest videos, permanently (`unwrappedAt` is min-merged forever).
    So `planGiftRunawayRepair` takes `sortKeyOf` and the caller supplies the VIDEOS' own
    recency; giftRank is only the tie-break. STILL OPEN (see the review notes): the step
    runs at boot, before the sync that can create the pile, and nothing ever clears a
    burned `baselineDone`.
  - **THE HOME NO LONGER RE-READS THE LIBRARY PER RENDER.** `buildFolders` needs full
    records (they feed the tiles), and `renderHome` runs on every gallery entry, every
    return from a video and every page flip — a full-store deserialize each time. `db.dataVersion()`
    counts committed writes (bumped inside `tx()` itself, so no write path can forget)
    and `buildFolders` caches its whole derivation against it. Measured with 1020 videos:
    22ms → 1.8ms per render. NEVER cache derived home state against anything else.
    The cache key is `{seq, profileId}` and **BOTH are captured AT ENTRY**: switching
    profile writes only to Preferences, so `dataVersion()` does NOT change across a
    switch and `profileId` is the ONLY cross-profile guard. Reading it at cache-write
    time let a derivation that began as child A get stamped with child B, and B was then
    served A's library with `libScope` pointing at A's videos. For the same reason all
    the derived state (`libScope`, `singleGroups`, `absorbedSingles`, `looseSingles`)
    is built into LOCALS and published only if the profile is still current.
  - Also: the sync's deny set is read once per run instead of once per removed key (it was
    quadratic in accumulated deletions) — and it is `add()`ed to as the loop tombstones,
    because duplicate `# הוסר` rows otherwise re-ran `deleteVideo` and restamped the
    tombstone's LWW `at`. `update.currentVersion()` is memoized — the attention dot was
    making a native bridge round trip on every render.
  - Snapshot import: a PENDING record keeps its exported `homeFolderId` — UNLESS its
    `scopeId` was rejected and downgraded to `prof:`, in which case `'sheet'` becomes
    `'mine'`: the shared folder is raised only for `libScope`, so the record would be
    stored, approvable, and in no folder on any screen. Import also preserves
    `srcChannelId`/`srcChannelTitle`/`srcChannelTriedAt` (without them every 🎞️
    collection dissolves into the flat list) and REFUSES a non-finite `sortKey`
    (`by_folder_sort` takes no NaN key and a string sorts outside `folderRange`, so the
    row counted as imported and was invisible forever).
    Since v1.0.26 **ALL THREE curation states survive the round trip**: 'rejected' used
    to fall into the live branch (`pending ? 'pending' : 'live'`), so a restore put
    every video the parent threw out BACK ON THE CHILD'S HOME — live, in a real folder,
    giftable. A rejected record imports parked in `'~rejected'` with its ORIGINAL
    `rejectedAt`: restamping would restart `planRejectedPurge`'s 30-day clock on every
    restore, and a row exported without one imports without one (no `rejectedAt` =
    never auto-purged — the safe direction). The sheet→mine downgrade applies to it
    exactly as to pending. DENY rows travel as FULL records in both directions
    (`loadDenyRecords`, never `loadDenySet` — the `copyDenies` presence rule) and the
    import MERGES via `drive.mergeDenyRecord` in pure `planDenyImport` instead of
    blind-putting: the old `at: d.at || Date.now()` dropped `removedAt` and restamped
    the event, so a revoked tombstone imported as ACTIVE-and-newest, clobbered a local
    revocation, and the resurrected deny then won every Drive merge — the v1.0.22
    `copyDenies` bug replayed on the snapshot path. A row with no `at` gets 0, never
    "now": a timeless entry must lose to any real event.
  - `sheetwrite.interpretSheetResponse` is the ONE gate for EVERY `values.get` read,
    including the one inside `doFlush` — hand-rolling that one read let an error envelope
    or a sign-in page pass as an empty sheet, so no row matched for deletion, every append
    was re-appended, and `clearFlushed` then dropped the unsent `delvideo` ops whose rows
    were still in the sheet: the next mirror pass read that presence as a re-add and
    resurrected the deleted videos everywhere. An unreadable read ABORTS the flush with
    the queue intact. An error envelope may ride along only with ACTUAL ROWS.
  - **THE WRITES ARE GATED THE SAME WAY (v1.0.26): A WRITE MUST BE PROVEN, NOT MERELY
    NOT-REFUSED.** The batchUpdate and append calls in `doFlush` checked only
    `res.status !== 200` — but `platform.httpRequest` does `r.json().catch(() => null)`,
    so the sign-in interstitial the read gate exists for (a lost grant answering
    200 + HTML) arrived as `{status: 200, data: null}` and COUNTED AS A SUCCESSFUL
    WRITE; a proxied error envelope (200 + `{error:{…}}`) passed too. `clearFlushed`
    then dropped the append whose row never landed, leaving a record that is live +
    sheet-backed + rowless + absent from `pendingAppendKeys` — exactly what the next
    presence-mirror pass tombstones, on every device; and one lost append of a
    50-video library stays under the max(10, 5%) valve, so no parent was ever asked.
    A dropped un-landed DELETE is the mirror image: its row stays in the sheet and the
    next pass reads that presence as a re-add. `interpretWriteResponse(status, data,
    kind)` is the write twin of the read gate — SUCCESS MAY COME FROM EXACTLY ONE
    SHAPE: a 200 whose body is a real object, carries no `error` key, and carries the
    operation's own marker (`updates` for values.append; `spreadsheetId`/`replies` for
    batchUpdate — deleteDimension replies are empty objects, so only the array's
    EXISTENCE is a marker). An error envelope is NEVER proof, even beside a marker —
    unlike the read gate there are no "actual rows" to ride along with — and an
    unknown kind fails CLOSED. Anything else aborts the flush with the queue INTACT
    (the same `abortFlush` the column-A read uses; `clearFlushed` must never run for
    ops whose write was not proven). Retrying is idempotent: a landed delete matches
    no row, a landed append dedupes by sheet presence. Both call sites are pinned
    behaviourally through the real `flushSheetQueue` (a 200+null append and a
    200+envelope batchUpdate each leave their op queued), proven to fail on a
    planted status-only revert of either site.
  - Queue overflow is DATA LOSS and must outlive the next flush: it lives in a durable
    `dropped` counter (not `error`, which every `doFlush` exit overwrites) and the sources
    tab renders it ABOVE the reassuring "pending" line.
  - New test files: `invariants.test.mjs` (import graph acyclic, `tour.js` imports nothing,
    no `search.list`, no `spreadsheets` scope, no paste-a-sheet control, keys.local.js
    gitignored, `parseSourceSheet` has no production caller), `pin.test.mjs`, `yt.test.mjs`,
    `snapshot.test.mjs`. Guards in there must be PROVEN to fail on a planted regression —
    three of them were vacuous: `walk()` collected only `.js` so the `spreadsheets` sweep
    read ZERO Java files (and `native-reference/`, the canonical rebuild copy, still
    declared the scope), the `search.list` patterns matched nothing this repo can write,
    and `importsOf` was blind to `await import()`, which outnumbers static imports here.
- v1.0.20 — the ADD-CONTENT GUIDE is the app's real manual: **18 slides, chaptered.**
  Without it the app is worthless to a parent, so it gets the detail it needs.
  Same `view-tour` mechanism; every `ADD_GUIDE_SLIDES` slide now carries a `chapter`
  (לפני שמתחילים · דרך 1 · שיתוף מיוטיוב · דרך 2 · במסך ההורים · דרך 3 · קובץ הרשימה ·
  אישור ומחיקה). Pure `deckChrome(deck, idx)` picks the chrome: a deck longer than
  `DOTS_MAX` (8) HIDES the dot row and shows a chapter chip + "שלב N מתוך M" (18 dots
  are noise); the onboarding deck keeps its dots and shows no chip. `chapters(deck)`
  derives the chapter table FROM THE SLIDES — never a second hand-kept list — and the
  tests pin that the chapters are contiguous, uniquely titled, and cover every slide.
  IMAGES (decision, not taste): every APP screen is a REAL 1280x800 screenshot
  (`assets/guide/app-*.jpg` + `share-04-pin.jpg` / `share-05-confirm.jpg`), staged
  through the live UI with playwright — scratchpad tooling, NOT in the repo, so they
  must be re-shot by hand. ONLY what the app doesn't render stays a drawing: YouTube's
  share button, Android's chooser, the spreadsheet columns, the Drive folder. A drawn
  parent screen sends parents hunting for a button that looks like nothing on screen.
  A test pins that every slide's asset EXISTS in `www/` and that app steps are
  photographed rather than drawn. Entry points: the parent screen (`guide-add`), the
  last onboarding slide (`tour-more`), the About tab — and the child's EMPTY home
  (`#empty-guide`, no PIN: reading adds nothing), which is where a stuck parent is.
- v1.0.19 — ⚠️ **HISTORY: everything in this block about the sheet itself is GONE (v1.0.38).**
  `sheetwrite.js`, `starterRows`, `SHEETS_FOLDER_NAME`, `parseSourceSheet`, `sync.js` and the
  app-created spreadsheet no longer exist; the read gate lives on only inside `sunset.js`
  until 2026-09-10. **The one rule here that is still LIVE and load-bearing is the first
  sentence** — `drive.file` is the only OAuth scope, and it must never grow. The rest is kept
  for its lessons (an unreadable response is never an empty one; a write must be proven, not
  merely not-refused) — those doctrines still govern `interpretSheetResponse`,
  `interpretDriveDoc` and `parseLinksFile`.
- v1.0.19 — **`drive.file` IS THE ONLY OAUTH SCOPE.** `spreadsheets` is classified
  SENSITIVE and was the sole cause of the "Google hasn't verified this app" screen.
  Verification was not an option: it needs a DNS-level Search Console Domain
  Property and the site is on `github.io`, whose DNS we don't control. Consequences,
  all load-bearing:
  - The app writes ONLY to sheets it created itself — `drive.file` is per-file and a
    pasted third-party sheet returns `403 appNotAuthorizedToFile`. **Pasting a sheet
    link is therefore GONE** from both the wizard and the sources tab. Never re-add
    it, and never re-add the `spreadsheets` scope to make it work: that brings the
    warning screen back for every family.
  - The only two writable sources: create a new list, or join a list this app
    already created for another profile ON THIS DEVICE/ACCOUNT. A different Google
    account cannot write to it (read-only), by design.
  - READS ARE AUTHENTICATED (`sheetwrite.readSourceSheet` → Sheets API `values.get`),
    not a public CSV export. So sheets are **no longer shared "anyone with the link"**
    — previously every family's playlist was world-readable to anyone with the URL.
    `readSourceSheet` THROWS on any non-200 and that is load-bearing: the throw keeps
    `sheetParsed` false so the presence-mirror can't read "unreadable" as "emptied".
    Never soften it to a silent `[]`. Since v1.0.20 the whole decision is pure
    `interpretSheetResponse(status, data)`: **emptiness may come from exactly ONE input**
    — a clean 200 with no `values` key. A markup body (`looksLikeHtml`, a lost grant
    answering 200 with a sign-in page), a JSON error envelope on a 200, a non-array
    `values` and an unparseable body all THROW instead of guessing `[]`.
  - `parseSourceRows(rows)` is the parser. `parseSourceSheet(text)` has NO production
    caller (verified) and is kept only for the tokenizer tests — do not wire it back
    to a fetch. `sync.js` is likewise dead in production. Sheets-API rows are RAGGED (trailing empty cells
    omitted) — both must tolerate that without throwing.
  - `starterRows()` writes a real COLUMN HEADER (A=link, B=display name, C=auto/manual)
    plus how-to lines into every new sheet. Every one starts column A with `#` so
    `classifySourceRow` skips it. Three properties are test-pinned: A always starts
    with `#`; NO line may contain a removal marker (הוסר/removed/deleted) or
    `parseRemovalRow` would deny the example link's key for every device; and they
    never shift `rowIndex` (videoOrdinal counts video rows only, so sortKey is safe).
  - App-created sheets live in the Drive folder `רשימת השמעה לאפליקציה הסרטונים שלי`
    (`sheetwrite.SHEETS_FOLDER_NAME` / `ensureSheetsFolder`). The Drive DB
    (`kids-player-db.json`) deliberately stays OUT of it: the folder is what a parent
    would share with a partner, and sharing it would hand over the whole database.
    Share per FILE, never the folder.
- v1.0.18 data-loss fixes — these are INVARIANTS now, not just fixes:
  - A sheet body that `looksLikeHtml` (csv.js) is a FETCH FAILURE, never an empty
    sheet: an unshared sheet 302s to a permission page that returns HTTP 200 + HTML,
    and parsing that as "the parent emptied the sheet" deleted whole libraries.
  - `planSheetMirror` valves on `disappeared === localTotal` REGARDLESS of size. The
    old `> max(10, 5%)` floor meant a child owning ≤10 things was wiped silently.
  - `deleteLibraryChannel` rearms `backfillCursor/backfillDone` once no library
    subscribes — otherwise a re-added channel only ever returns its RSS window.
  - `flushSheetQueue` is serialized per library and clears ONLY the ops it wrote
    (pure `remainingAfterFlush`). Clearing the whole queue destroyed un-sent deletes,
    which resurrected deleted videos everywhere via the mirror's `unDenyKeys`.
  - `enqueueOp` reconciles BEFORE capping so the cap counts distinct ENTITIES, and the
    cap keeps the OLDEST intents (`planQueue`, pure): head-dropping discarded the
    parent's earliest deletions — their rows stayed in the sheet, the next mirror read
    that presence as a deliberate re-add and `unDenyKeys` resurrected everything, on
    every device. At capacity the op being REFUSED is the newest one, at the same moment
    `queue-overflow` reaches the sources tab. Bulk callers pass `{flush:false}`
    and flush ONCE at the end — a record that is live + sheet-backed + rowless is
    exactly what the mirror tombstones, so that window must close in one tick.
  - `adoptLibraryScope` refuses to migrate when ANOTHER profile still points at the
    old scope: `lib:<fnv1a(sheet)>` is shared, and `moveScope` deletes its source.
  - `moveScope` unions tombstones BEFORE deleting (an interruption used to lose the
    deny-list forever, and nothing retries).
  - `fsDownload` mkdirs its own parent directory — `downloadFile` ignores
    `recursive:true` on Android. This was the known-unaudited `media.js` item and it
    was real: direct-file video caching never worked on device.
  - `playItem` issues a monotonic `playSeq`; `playYouTube` bails if superseded after
    `await loadYouTubeApi()`. Otherwise a second tap during the API load mounted a
    second player+HUD (breaking the setupHud-twice invariant) and left an orphan
    firing a stale `onExit`.
  - The search index is derived from the SAME `folders` array the home screen renders
    — re-deriving it left absorbed-singles channel folders on screen but unfindable.
- Push access: the local `gh` account may be READ-only on `devfassaf/kids_player` → push a branch to
  the `AssafFaybish/kids_player` fork (`git push fork <branch>`) and open a PR.
