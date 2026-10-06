# ARCHITECTURE.md — module map, data model, and flows

> Testing: [docs/TESTING.md](docs/TESTING.md). Release records: [docs/V1032.md](docs/V1032.md), [docs/V1026.md](docs/V1026.md), [docs/V1025.md](docs/V1025.md).

Companion to [CLAUDE.md](CLAUDE.md) (invariants) and [DEVELOPMENT.md](DEVELOPMENT.md)
(original architecture + overhaul addendum §14-§18). This file answers "where does X
live and how does data flow".

## Module map (www/js/)

| Module | Role | Depends on |
|---|---|---|
| `platform.js` | Capacitor shim: Preferences, HTTP (`httpRequest` never throws on status), Filesystem (DATA + EXTERNAL; `fileUriToPath` decodes the percent-encoded URI `writeFile` answers, v1.0.93), app lifecycle, back button, exitApp, share (`shareText`/`shareFile` answer `'locked'`/copy under the kiosk lock) and `copyText` (native ClipboardManager → async Clipboard API → execCommand, v1.0.93) | — |
| `util.js` | fnv1a, canonicalSheetKey/libraryIdFor, mapWithConcurrency | — |
| `csv.js` | RFC4180 parser (quoted Hebrew titles with commas survive) | — |
| `classify.js` | **THE safety boundary**: classifyLink, parseChannelRef, classifySourceRow (watch-link-wins; kind 'removed' for `# הוסר` rows), parseRemovalRow, stripTimeHints, classifyFromSharedText/classifyShared | — |
| `order.js` | sortKeyFor domains (channel=publishedAt / sheet=BASE+rowIndex / manual=above-all), compareForDisplay | — |
| `normalize.js` | normalizeTitle (Hebrew: niqqud/bidi/emoji), mergeVideoRecord (survivor policy); v1.0.94 `homeOf` (where a parked record lives), `settlePlacement` + `mergeVideoCopies` (which FOLDER a video lives in is last-deliberate-placement-wins by `placedAt` — the merge every cross-device path uses; legacy records without the stamp are untouched, and an unstamped copy competes as zero), `placeInto` (THE parking rule for a move — a parked record moves only `homeFolderId`) | — |
| `store.js` | legacy Preferences layer (profiles, oEmbed title, thumb candidates hq-first); re-exports classify. v1.0.25: the PIN moved OUT to settings.js. v1.0.25 also added the grow-only DELETED-PROFILE tombstones (`markProfileDeleted`, pure `mergeDeletedProfiles`) — without them a Drive pull unions a deleted profile straight back in | platform, classify |
| `recovery.js` | **the way back in when the parent forgets the PIN** (v1.0.26): request -> 24h wait -> new code. Needed because v1.0.25 put the PIN hash in the synced settings channel, so reinstalling now RESTORES a forgotten code. The timestamp is DEVICE-LOCAL (a test allows the key in this module only) and a live request is never restamped. The countdown banner on the CHILD'S HOME is the actual safeguard, not the delay. v1.0.26 also adds the DEVICE-CREDENTIAL fast path (`KidsNative.canDeviceAuth`/`deviceAuth`, androidx.biometric) chosen by pure `plan.planRecoveryRoute` — an existing request outranks it, and every native failure falls back to the wait | platform, plan, config |
| `settings.js` | **the SYNCED settings channel** (v1.0.25): `{account:{name:{v,at}}, profiles:{pid:{name:{v,at}}}}` in Preferences — the parent PIN (account-wide) plus per-child exit lock / share approval / continuous play. `at` is stamped INSIDE `putSetting`, never by callers. Pure `mergeSettingEntry`/`mergeSettings`: per-key LWW, exact ties resolve the SAFE way. Before it, the only value that crossed devices was `libraryChannels.autoApprove` | platform |
| `db.js` | IndexedDB I/O ONLY (no business logic) — see schema below; `dataVersion()` is a committed-write counter bumped inside `tx()` (v1.0.20 derived-state cache key); v1.0.94 `customFolderUsage` (key-only scan of the `cf:` slice — which folders videos are filed under), `recordsFiledUnder`, `listAllCustomFolders`; `placeVideos` (every move: `placeInto` applied to the record AS IT IS inside the write transaction, with an `accept` precondition re-check — never a snapshot written back), `updateCustomFolder` (a folder row changed as a patch on the live row; `touch:false` = housekeeping, e.g. the Drive refresh stamp, which must not bump `updatedAt`) | normalize |
| `migrate.js` | one-time resumable Preferences→IDB migration (never deletes the legacy blob) | platform, db, order, util |
| `plan.js` | PURE decisions — mostly sync, some home: planMutations (merge/dedupe/deny/route/caps), planGifts (baseline-12 / incremental), groupSinglesByChannel, `isLooseRecord` (the ⭐ loose-list boundary; renamed from isSheetBacked in v1.0.38), shouldRecordGiftBaseline, planGiftRunawayRepair, shouldFlattenHome (home-render rule), and the v1.0.24 parent-attention rules: attentionDot (blue=content / red=update), parentLandingTab + PARENT_TAB_IDS, pendingBulkAction (what a bulk button acts on), planChannelLogo (when to (re)fetch a channel avatar, API vs scrape); v1.0.25 `planSyncDispatch` (start/join/queue a sync — a forced caller may never ride a run that already read), `planEntryRefresh` (pull+force gates on home entry), `channelAddOutcome`, `planProfilePurge` (which scopes a deleted profile may erase — never a SHARED library); v1.0.26 `playlistVideoFolder` (a playlist video whose channel is subscribed unifies into the channel folder) and `planRejectedPurge` (the 30-day archive expiry); v1.0.38 `orphanSweepValve`, `coveredBySubscription`, `channelRowSubscription` + `manualVideoRecord` (ONE record shape for every add path), `deniedReAddPrompt`/`deniedRestorePrompt`, `linksImportConfirm`/`linksImportOutcome`/`linksExportOutcome`, `hebCount`, and the migration's `planSheetSunset`/`planSheetFold`/`SUNSET_DEADLINE` (⏳ delete with sunset.js) | normalize, order |
| `sync2.js` | the staged pipeline (below); `gcOrphans` / `removeSubscription` (v1.0.38 — the orphan sweep and the channel-removal path that replaced applySheetMirror) | linksfile, plan, yt, db, quota |
| `linksfile.js` | **the links file** (v1.0.38): the row grammar (`parseSourceRows`, moved here from sync2 — the sheet stage died, the grammar did not), `parseLinksFile` (parseCsv → parseSourceRows → classifySourceRow, so there is no second parser and no second safety boundary), `serializeLinksFile`/`canonicalLinkFor`/`linksFileHeader`/`linksFileName`; v1.0.93: `serializeLinksExport` (one profile = the single-profile file byte-for-byte, several = one `# ===== פרופיל: X =====` section each — a marker an older app's `# פרופיל:` regex never matches), `sectionNameOf`, sections in `parseLinksFile` (+ the deduplicated union), `matchSectionTargets` (section → profile by NAME), and a link always followed by ` ,` so it stays clickable in a chat; plus the IDB glue `collectLinksExport`/`applyLinksPlan`. Pure half imports csv+classify only; consumed by app.js and (until the sunset) sunset.js | csv, classify, order, store, plan |
| `yt.js` | Data API client: handle resolution (cached forever + HTML-scrape fallback), channels.list batched, playlistItems backfill, videos.list titles, RSS fetch, quota ledger | platform, keys, db, quota |
| `quota.js` | batchIds, quotaCostFor, planChannelFetch truth table, playlist-id derivation: `UU` uploads / `UULF` long-form ("Videos" tab) / `UUSH` Shorts | — |
| `ytrss.js` | pure keyless parsers (never throw): Atom feed (incl. Short/live detection from the entry's alternate-link form) + channel-page logo extractor | — |
| `ytsearch.js` | **the parent's KEYLESS YouTube search + in-result browsing** (v1.0.33): pure parsers over the youtubei search AND browse endpoints (0 quota, no API key — ANY youtubei literal is guard-pinned to this one module) — videoRenderer/channelRenderer/lockup/officialCard (header-anchored), a channel's Videos tab / a playlist's contents, Shorts + RD-mix filtered, continuation shapes for both (an unparsable CONTINUATION = end-of-list, never the 'parse' alarm); suggestion parser (`oe=utf-8` load-bearing for Hebrew); pinned `searchMessage` texts; thin POST via `platform.httpPostJson` | platform |
| `keys.js` / `keys.local.js` | API-key resolution; keys.local is GITIGNORED, ships in APK via cap copy | — |
| `gauth.js` | KidsGoogleAuth JS side; access token in memory only (~55min) | — |
| `plan.js` (v1.0.56 additions) | the containment lock's pure half: `evalContainment` (device-local mode/folder/until → active|expired, and a corrupted value fails OPEN), `containmentChrome` (what the child loses, per mode — containment's half ONLY, OR-ed with the kiosk by the caller), `normalizeLockMinutes` (0 = until released, so the unset check precedes the coercion), `containConfirmText`, `containCountdownLabel` | normalize, order |
| `folderart.js` | **candidate PICTURES for a parent-created folder** (v1.0.56), searched by its name. Pure URL builders + TOTAL parsers, imports platform alone, and an invariant bans it from writing anything: it may only PROPOSE — the parent chooses, which is the whole safety model for an image search on a child's tablet. Wikimedia Commons leads and Openverse tops up, on a MEASUREMENT (Commons resolves Hebrew concepts; Openverse matched only Hebrew archive metadata) | platform |
| `gdrivepub.js` | **PUBLIC Drive metadata + folder listing** (v1.0.56) — the name/mimeType/size of a file a parent shared "anyone with the link", so a Drive mp3 gets a real caption and is known to be AUDIO. ONE module by rule (the ytsearch precedent): every keyed `drive/v3` call lives here, it never imports gauth, and it never sends an Authorization header — the app's only OAuth scope is `drive.file`, which cannot read a parent's own files and must never grow. Keyed `files.get`/`files.list` first, the public `/view` and `embeddedfolderview` pages scraped second; every parser TOTAL — an error envelope or a sign-in page answers null, never a caption and never an "empty folder". ⚠️ MEASURED: both keyed methods answer 403 `API_KEY_SERVICE_BLOCKED` with a YouTube-restricted key, so the keyless door is the live path until an operator widens the key; one refusal sets a session memo that skips the dead attempt | platform, keys |
| `sunset.js` | ⏳ **DELETE AFTER 2026-09-10** (`test/sunset.test.mjs` fails on that date and carries the checklist). The one-time migration off the Google-Sheets sources list: `runSheetSunset` (every profile, silent, 3 attempts across launches), `readFinalSheet` + `interpretSheetResponse` + the id/gid extractors (lifted out of the deleted sheetwrite.js), and exactly ONE Drive `files.delete` — a FILE id, never the folder | platform, gauth, csv, linksfile, plan, store, yt, db |
| `drive.js` | Drive DB per-LIBRARY: serializeDb/parseDb/mergeDbFiles (pure CRDT), `interpretDriveDoc`/`interpretDriveList`/`decidePush` (an unreadable remote NEVER writes), `stripPerDeviceChannel`/`mergeChannelForApply`, `mergeLibraryChannel` (autoApprove converges; tie → still-requires-approval) + push/pull I/O; v1.0.94: `serializeDb` CARRIES `customFolders`/`deletedCustomFolders` (it never did — the root cause of folders that existed on one device only) and strips `localUsedAt`; `newerRemoteRows` (a pull writes a remote row only if it wins the collection's own merge — subscriptions, websites, folders); `mergeCustomFolder` lets a real row beat a rebuilt placeholder; `travellingFolderRows` (a rebuilt placeholder and the per-device `driveSyncedAt` never leave the device) + `customFolderForApply` (the apply keeps this device's stamp and never inherits `placeholder`) | platform, gauth, normalize, db, csv |
| `snapshot.js` | full-state export/import (import re-classifies EVERYTHING) | classify, normalize, order, db |
| `share.js` | share-intent JS side: listener→drain→queue; v1.0.7 interactive PIN+confirm flow (videos AND channels) with silent-pending fallback; v1.0.23 optional profileChooser (asked only when profiles have DIFFERENT scopes; the drain path passes alreadyRouted and never asks) | classify, normalize, order, platform, db |
| `search.js` | PURE home-search ranking: normalized exact/starts/word/substring tiers | normalize |
| `dataver.js` | one-shot data migrations after an app update (meta dataVersion; pure pendingSteps) | db, store, plan (dynamic) |
| `links.js` | CONFIG ONLY (v1.0.15): every external address — donation links, contact mail, public site, update repo. Consumers: donate.js, update.js, app.js | — |
| `spatial.js` | PURE TV D-pad geometry: pickNextIndex / pickFirstIndex (no wrap, drift penalty) | — |
| `playerlogic.js` | PURE player decisions (player.js is untestable DOM): clampSeek, fractionFromX, progressPct, shouldFinishNearEnd, tvKeyIntent; v1.0.25 `planAutoplay` (continuous play: next/retry/stop, never in 🎁, never into a wrapped gift) + `nextInOrder`; v1.0.26 `previewEmbedUrl` (the parent's preview bubble — controls=1, mute=1, rel=0) | config |
| `ui/dpad.js` | Android TV focus manager (v1.0.9): spatial nav over the active view, watch-view player mode via player.handleTvKey | spatial, nav, modal, player |
| `update.js` | GitHub-releases updater: compareVersions, checkForUpdate (throttled; honors `update.skip` on silent checks), downloadAndInstall (size-verified) | platform |
| `wake.js` | ref-counted keep-screen-on (KidsNative → KeepAwake → wakeLock → noop) | — |
| `player.js` | YT IFrame + `<video>` engines, shared HUD state machine, loadVideoById reuse path | media, classify, config, wake |
| `media.js` | Drive URL normalize, stream→download-cache, captureFrame | platform, store |
| `nav.js` | explicit view stack, hardware-back precedence (fullscreen→modal→view→pop→swallow), scroll restore | ui/modal |
| `ui/*` | modal (confirmKid/alertKid), pager, tiles (in app.js currently), confetti (CSS), sound (WebAudio synth), loading (4 scenes) | — |
| `app.js` | boot + all views (connect/profiles/folders home/folder/watch/pin/parent) + launch update prompt + attention dots + wiring — the candidate for a future views/ split | everything above |
| `pin.js` | SHA-256 parent PIN. v1.0.25: the hash lives in the SYNCED settings channel, so one family code opens the parent screen on every device; an existing Preferences hash is lifted across on first read (the other settings deliberately do NOT migrate) | platform, settings |

Native (android/, canonical copies in native-reference/): `MainActivity.java`
(YouTube-nav blocking, real fullscreen, popups, share onNewIntent, and the site-viewer
back/pause/resume hooks), `KidsNativePlugin.java` (keepAwake, share inbox, APK installer),
`GoogleAuthPlugin.java` (AuthorizationClient drive.file), `KidsWebPlugin.java` (v1.0.45 —
the restricted site viewer: the ONLY place a child's web navigation is enforced; see
[docs/WEBSITES.md](docs/WEBSITES.md)), `PlaybackService.java` (v1.0.63 — the app's ONLY
service: a mediaPlayback foreground service so the family's own audio/video keeps playing
when the app is backgrounded. It runs only while a parent has turned the per-profile
`bgPlay` setting on, knows nothing about folders or gifts — every playback decision stays
in JS — and its notification deliberately carries NO content intent, because tapping it
open would be a way out of a containment lock).
`release/android-release.gradle` = versioning + signing + play-services dep + `.dev` debug suffix.

## IndexedDB schema (`kidsplayer` v3)

| Store | keyPath | Notes |
|---|---|---|
| `videos` | `[scopeId, key]` | scopeId: `lib:p:<profileId>` (a profile's own library) or `prof:<profileId>` (personal). `lib:<fnv1a(sheetKey)>` is LEGACY and still load-bearing — pre-v1.0.38 families derived it from a sheet URL and several profiles may SHARE one; nothing can change a scope any more (moveScope is gone). Indexes: by_folder_sort `[scope,folder,sortKey]`, by_state, by_channel_title, by_key. Parked rows live in `'~pending'` / `'~rejected'` (normalize.PARKED) + `homeFolderId`; state is one of live|pending|rejected, and 'rejected' is NOT a deletion (v1.0.23). |
| `profileVideoState` | `[profileId, key]` | gift state per CHILD: `{giftRank}` XOR `{unwrappedAt}`. by_gift index is SPARSE (deleting giftRank removes from index → the "חדשים" folder is a pure range scan). v1.0.32: also the DEVICE-LOCAL playback position `{posSec,durSec,posAt}` — never serialized to Drive (`drive.serializeStateEntry`), preserved on apply (`mergeAppliedState`). |
| `channels` | `channelId` | global metadata + backfillCursor/backfillDone/lastRssCheckedAt |
| `libraryChannels` | `[libraryId, channelId]` | subscription + autoApprove toggle (+ `autoApproveSource`: `file`/`sheet`/`ui`/`default`). **This table IS the source list** since v1.0.38 (`kind:'playlist'` for a playlist). v1.0.32: `addedAt` orders the parent's folded list; `decidedAt` (stamped by the three-way dialog's real answers / the toggle / an explicit sheet flag) is what clears a row out of "ערוצים חדשים" (`plan.planChannelSections`). |
| `thumbs` | `id` | Blob cache (legacy migrated thumbs + captured frames); by_lastUsed for LRU. v1.0.32: also channel-logo BYTES (`logo:<channelId>` + `srcUrl` meta) — folders render offline; `touchThumbs` on use keeps them off the LRU. |
| `denylist` | `[scopeId, key]` | grow-only tombstones = durable deletion |
| `sources` | `profileId` | `{libraryId, shareIntent.requireApproval, defaultAutoApprove, caps…}`. `sheetUrl`/`sheetHash`/`sheetFolderId` are LEGACY fields the migration clears and never writes again — `libraryId` is the one field that must never change. |
| `meta` | `id` | migration flag, sync timestamps, handleMap, quota:<date>, drive:{dbFileId…}, gift baselines, dedupe reports |
| `opLog` | autoInc | mutation ops (deny/undeny/unwrap) for future merge use |
| `customFolders` | `[scopeId, folderId]` | v1.0.56 — parent-created folders, on the LIBRARY scope. METADATA ONLY (`{title, emoji, artThumbId, artSrcUrl, order, createdAt, updatedAt}`, plus `driveFolderId`/`driveRootId`/`driveSyncedAt` on a self-refilling Drive folder and, since v1.0.61, `parentFolderId` — a `cf:` id, or absent for a root); MEMBERSHIP is the video's own `folderId` (`cf:<id>`), which is why paging, parking, search and the watch-grid chain needed no new branch — and NESTING kept it that way: `pageAnyFolder`/`nextAfter` never learned about `parentFolderId`, the child tiles are concatenated by the renderer. No index (the `listSiteEntries` lesson); readers range the primary key. Deletion writes a tombstone FIRST into `meta['cfDel:<scope>']`. The picture rides the `thumbs` store as `cfart:<folderId>`. |
| `siteEntries` | `[scopeId, entryId]` | v1.0.45 — approved websites, on a PROFILE scope (`prof:<id>`). ONE store, two kinds: `kind:'shortcut'` `{url,title,iconUrl}` is what the CHILD sees as a tile; `kind:'rule'` `{display,host,port,segments[],allowExternal}` is where they may navigate and is NEVER shown. `by_scope` `[scopeId,order]`. Deletion writes a tombstone FIRST into `meta['siteDel:<scope>']`. Icons ride the `thumbs` store as `siteicon:<entryId>`. |

v1.0.56 adds `media:'audio'|'video'|null` to the video record (a direct link's extension, a
Drive file's fetched mimeType, or null = unknown — the player re-detects it at
`loadedmetadata` anyway) and `driveMetaTriedAt` (the sync's weekly retry stamp for records
that arrived without a name: a share, a links-file row).

Video record: `{scopeId,key,type,id,url,srcUrl,driveId,title,titleSource(api>rss>sheet>oembed),
normTitle,folderId,homeFolderId?,channelId,sortKey,publishedAt,rowIndex,origin(channel|sheet-row|
manual|share-intent|legacy),state(live|pending),addedAt,approvedAt,thumbId,thumbUrl,localPath,
mergedFrom?,updatedAt}` — ~400B, NO base64.

⚠️ **The upgrade handler is version-guarded** (`if (ev.oldVersion < N)`). It ran
unconditionally for the whole life of v1, which was harmless only while the version never
moved: an unguarded `createObjectStore` on an existing install throws `ConstraintError`,
aborts the version-change transaction, and the app cannot open its database at all.

## Sync pipeline (sync2.syncLibrary — one in-flight per profile)

```
hydrate (views read IDB directly — the ONLY thing on the critical path)
└─ background: ORPHAN GC (v1.0.38, UNCONDITIONAL — content whose channel nobody
   subscribes to any more, e.g. a peer's deletion arriving over the Drive doc; pure
   planOrphanGC + orphanSweepValve, which parks a sweep above max(10,5%) or one that
   would take everything) → channel meta batched (1 unit/50) → logo fetch/scrape
   → per channel planChannelFetch:
        rss (free, latest 15, etag) | backfill (resumable cursor, 40-page budget, quota soft-cap)
   → planMutations (PURE: key-merge, intra-channel title dedupe, deny drop, pending routing,
     caps; quarantine on first post-migration sync) → putVideos (chunked)
     ↳ pending routing runs BEFORE the two merge branches, and `settleCuration` keeps every
       merged record self-consistent (pending ⇒ parked in '~pending'; live ⇒ never parked).
       A merge must never be able to approve content — see the v1.0.22 invariant in CLAUDE.md.
   → titles for still-untitled loose links (videos.list 50/unit or oEmbed conc-6)
   → planProfileGifts (baseline newest-12 once per profile+library, then incremental)
   → meta bookkeeping → (drive.schedulePush if enabled)
```

Cross-device convergence (v1.0.22) is the OTHER half, and a separate cadence from the
derive pipeline above:

```
profile activation (⇒ every launch) / resume from background
   → app.maybePullDrive()  SILENT · best-effort · 60s throttle · one in-flight promise
                           skipped entirely unless meta['drive'].enabled
     → drive.pullDrive → readDbFile → mergeDbFiles(local, remote) → applyRemoteDoc
        ↳ every video passes settleCuration: a peer's approval lands REACHABLE, and a
          record still pending stays parked
        ↳ libraryChannels via mergeLibraryChannel (LWW on updatedAt; tie → the row that
          still requires approval), applied with preserveTimestamp so devices don't ping-pong
     → re-render only if db.dataVersion() moved
   → THEN sunset.runSheetSunset()  ⏳ v1.0.38, DELETE AFTER 2026-09-10 — the one-time
        migration off the Google-Sheets list, for EVERY profile (entryRefresh is per-active-
        profile, and a child nobody opens here must not keep a sheetUrl forever). Reads the
        sheet once, folds it in, forgets it (libraryId UNTOUCHED), deletes the file.
   → THEN syncLibrary (serialized — all three write the same video records; a detached
        .then() here was the v1.0.25 race)
```

**Why between the pull and the sync, and not in `dataver`:** dataver runs before any profile
is active, blocks boot behind an already-faded splash with no progress UI, and means "run
once" where this needs "three attempts across launches". After the pull, because a restored
profile's `sheetUrl` arrives there; before the sync, because the fold writes the records the
launch's forced pass then enriches.

## Player HUD state machine

States via one class `.hud-on` on `#player-wrap`: HIDDEN / VISIBLE(3s timer) / PINNED
(paused or dragging). `reveal()` is the single timer entry point. Any pointerdown in the
wrap (capture) records `wasVisible` then reveals. Shield pointerup: double-tap(<260ms)
= ±10s seek; single tap after 280ms = togglePlay ONLY IF wasVisible && center-50%.
⛶ + the seek bar live inside the wrap and are the ONLY pointer-interactive parts of the
HUD bar. 🏠 sits OUTSIDE the player in `.watch-top` (top-right; v1.0.2 user request) —
going home requires exiting fullscreen first. Tapping any video tile calls
`enterPlayerFullscreen()` synchronously inside the tap gesture (auto-fullscreen);
exiting fullscreen (back / ⛶) lands on the watch page. The app rotates freely
(no screenOrientation lock since v1.0.2); narrow-width CSS lives in the 560px media query.

## Cross-device Drive model (decision 20)

One Drive JSON file per Google account, tagged appProperties{kpApp} (searchable after
reinstall). Document: `{profiles, libraries:{<libId|profScope>: {sheetUrl, videos(no
localPath/thumbId), denylist, channels(no cursor), libraryChannels}}, profileState:{pid:
{key:{unwrappedAt|giftRank}}}, profileSources:{pid:{libraryId,sheetUrl,updatedAt}}}`. **v1.0.38: `libraryId` travels** — a restored profile's scope is derivable from nothing else, and without it a fresh device restoring a migrated family gets every record and no sources row (empty home, full database; pure `drive.resolveRestoredLibraryId` decides). profileSources
(v1.0.4, additive) lets a fresh device rebuild each restored profile's sources record —
without it a restored profile pointed at an empty `lib:p:` library. mergeDbFiles is
commutative+idempotent: video union by key via mergeVideoRecord, deny UNION (denied never
travels), LWW-by-updatedAt for profiles/channel toggles/profileSources, unwrappedAt=min.
Push: version-probe → merge-if-changed → PATCH (multipart/media with explicit
Content-Type). Pull (v1.0.4) also merges doc.profiles into the local Preferences list
(union by id, local wins) and applies unwrappedAt states for EVERY profile in the doc —
the first-launch connect screen (app.js `view-connect`, one-time via `gauth.introDone`)
rides this to restore a whole device.

## Update flow (F14)

`releases/latest` of UPDATE_REPO → pickApkAsset(`kids-player-<tag>.apk`) → numeric
compare vs App.getInfo().version → parent panel shows/downloads (EXTERNAL/updates/,
mkdir first, size check) → KidsNative.installApk (FileProvider `app_updates` path).
Launch check: +4s, 1h throttle (was 6h — a release published right after a device's
check stayed invisible for hours). Since v1.0.4 an available update PROMPTS (never over
watch/pin/parent/connect/loading): accept = PIN → what's-new → download. ONLY the
explicit "לא עכשיו" button writes `update.skip:<version>` (askKid distinguishes it from
a scrim-tap/back dismiss — an accidental dismiss re-offers on the next home entry;
field bug: a child's stray tap used to silence the prompt for the whole version). The
red gate dot and the About tab keep offering a skipped version. Same signing key or
Android refuses.
