# How this app is tested — and what the tests cannot see

`npm test` is ~402 node tests and it is the fastest, cheapest signal in the project. It is
also **not sufficient**, and this file exists because that gap has bitten repeatedly: in the
v1.0.25/v1.0.26 work, **four real bugs shipped past a fully green suite** and were caught by
driving the app in a browser.

Read this before adding a feature, and before believing a green run.

---

## 1. What the suite covers

| Layer | Where | Notes |
|---|---|---|
| Pure decisions | `plan.js`, `playerlogic.js`, `normalize.js`, `quota.js`, `settings.js`, `order.js`, `search.js`, `spatial.js`, `tour.js`, `update.js` | The real logic. If a rule matters, it belongs here as a pure function. |
| Parsers | `classify.js`, `csv.js`, `ytrss.js`, `sync2.parseSourceRows` | Fed the exact strings the field produces. |
| CRDT merges | `drive.js`, `settings.js` | Commutativity **and** idempotence, always. |
| Wiring | `invariants.test.mjs` | Source-level pins: the tested core is the LIVE one. |

**No DOM. No IndexedDB. No network.** There is no jsdom and no `fake-indexeddb`, deliberately
— the suite stays fast and dependency-free. The cost is section 2.

### The two rules for a new test

1. **Extract the decision into a pure function**, then test the function. If a rule lives
   inline in `app.js`, it is untestable and it will drift.
2. **Plant the regression and watch the test fail** before you keep it. This repo has shipped
   guards that could never fail — a `walk()` that matched zero files, patterns that matched
   nothing this codebase can write, an import scanner blind to `await import()`. A guard that
   has not been proven to fail is decoration.

### Wiring pins (`invariants.test.mjs`)

A pure function nobody calls is worthless, so the suite also pins that production uses it.
The pattern (see `nav.test.mjs`'s `handleBack` test):

```js
const app = MODULES.get('www/js/app.js');
const fn  = app.slice(app.indexOf('async function onVideoFinished('));
assert.match(fn, /planAutoplay\(/, 'app.js re-implements the decision inline');
```

Match **call shapes**, never prose — several of these tests describe the bug they prevent in
a comment that names the very function or endpoint being banned.

---

## 2. What the suite CANNOT see

Everything below is invisible to `npm test`. All four bugs listed here were green.

| Blind spot | Real bug it hid |
|---|---|
| **Module wiring at runtime** | `syncLibrary` joined a forced run when the running one was also forced. Its own comment said the opposite. Adding a channel imported nothing and the approval dialog never appeared. |
| **Migration / upgrade paths** | The PIN migration never ran: `getSetting(scope, name, undefined)` triggers the `fallback = null` default, so "never written" read as "already migrated". **Every pin test called `setPin()` first, so none took the lift branch.** A real install would have lost its parent gate. |
| **Real stored data** | The autoplay chain would have opened WRAPPED GIFTS — gift state lives per child *on the video*, so wrapped tiles exist inside channel folders, not only in 🎁. |
| **Cross-function state** | Selection preservation done by parameter looked right; `refreshAfterAdd` rebuilt the list a beat later and cleared the ticks straight back. |
| **A swallowed throw in app.js** | v1.0.58: the empty-folder sweep spread `{items,total}` as an array. The throw escaped the promise's `.catch` into the caller's `.catch(() => {})`, so the whole sweep silently did NOTHING — suite green, because no node test executes `app.js`. |
| **A comment asserting a precondition nobody checks** | v1.0.58: the folder-picture editor's `else` branch said "an emoji was chosen" and nothing verified it, so opening 🖼️ and tapping save ERASED the picture. |
| **A name re-derived instead of read** | v1.0.58: the cache sweep re-derived a file name from `media`, which v1.0.56 corrects at playback — so a live cached file stopped matching its record and was deleted as an orphan. |

**The pattern:** tests set up the NEW state and skip the branch that converts the OLD one.

**And the v1.0.58 pattern, which is different: VERIFY THE NEGATIVE TOO.** Three of the four
defects above showed up as a feature doing *nothing* rather than doing something wrong. When
you check a fix in the browser, check the CONTROL as well — the empty-folder sweep looked
correct because the folder that had to survive survived, and the folder that had to be
deleted was still there.
When you add a feature that changes where something is stored, the migration branch is the
one with no coverage.

---

## 3. Browser verification (`npm run serve`)

The dev server is at `http://localhost:5173` (fixed port, no-store, `/__proxy` for CORS).

```bash
npm run serve
```

**Before you touch anything, check the blast radius.** The browser profile is a real
IndexedDB with real data:

```js
// in the console — is this sandbox connected to a real Drive / sheet?
(await (await import('/js/db.js')).getMeta('drive'))   // null ⇒ no backup, safe
```

If Drive or a sheet is connected, writes leave the machine. Prefer a **throwaway profile**
for anything destructive, and purge it afterwards.

- Escape stands in for the hardware back button.
- **Fullscreen is DENIED in embedded panes** — not an app bug.
- Modules are live: `await import('/js/plan.js')` gives you the same instance the app uses,
  so you can call pure helpers against real data.
- Leave the sandbox as you found it. Record the counts before you start.

---

## 4. Device checklist (`npm run apk` → the `.dev` app)

**Never install a debug build over the release app.** These cannot be verified any other way.

### Android intents and native APIs
- [ ] **Share a video from the YouTube app** → PIN → confirm → it appears, **and a toast at
      the bottom says what happened** (added / waiting for approval / why it failed). Since
      v1.0.26 no share route is silent: if nothing is added, the toast names the reason.
- [ ] Share a link that was **deleted before** → the toast must say so, not stay silent.
- [ ] Share a **playlist** from the YouTube app (v1.0.26).
- [ ] With TWO+ profiles, every share must **ask which profile first**.
- [ ] **Share a CHANNEL** → loading screen → the three-way dialog (`אישור הכל` / `אישור ידני` /
      `אחר כך`) with a real count. *(v1.0.25 rewrote this path; it does not exist in a browser.)*
- [ ] Share with **no profile active** (cold start) → lands on the profile picker, and the
      profile you tap is the destination — it must not ask twice.
- [ ] **Exit lock**: turn it on for one child → the OS pinning confirmation appears, HOME is
      contained, the exit button is hidden, exiting asks for the PIN.
- [ ] **Per-profile lock** (v1.0.25): with a locked child active, tapping the profile chip
      asks for the PIN. Switch to an UNLOCKED sibling → the device unpins and the exit button
      returns. Switch back → it re-pins. *(Both directions; the second one is the escape.)*
- [ ] **Silent keypad** (v1.0.55): on the PIN screen, tap and press-and-HOLD a digit — the
      key must not change color, scale, or ripple; only the dots fill. *(The suite pins the
      CSS rule's absence; only a finger on glass proves no OS-level highlight sneaks in.)*
- [ ] **TV: type the code with the remote's digit buttons** (v1.0.55) — digits fill the dots
      with NOTHING highlighted on screen; the on-screen pad must STAY walkable with the
      D-pad (many remotes have no digit buttons — that path is the only one they have).
- [ ] **Full-tablet break lock** (v1.0.55): turn on "בזמן ההפסקה לנעול את כל הטאבלט" with a
      short break → when the break screen shows, the OS pinning engages (toast); HOME and
      recents are contained; 🚪 asks for the parent code and exits with the break STILL
      RUNNING (reopening the app lands back on the lock); פתיחה להורים cancels the break
      and unpins.
- [ ] The same break with the toggle OFF → 🚪 exits freely, no code (today's behaviour).
- [ ] Let the break **expire on its own** while pinned → the tablet unpins by itself; on a
      device with the system "ask PIN before unpinning" option the DEVICE's own lock screen
      appears — confirm the settings hint matches what the device actually does.
- [ ] **Gesture-unpin during the break** (hold back+recents) → within ~5 seconds the app
      re-pins (the tick re-assert; no resume event fires for this gesture). **Repeat with
      the 🚪 code screen left open on top of the lock** — the re-assert must keep running
      there too (the v1.0.55 review's escape: gesture under the code screen, then HOME).
- [ ] Break lock + KIOSK both on → the break screen shows NO exit button at all, and when
      the break ends the session stays pinned (the kiosk owns the pin).
- [ ] **Toggle the tablet-lock OFF on a second device DURING a pinned break** → the break
      screen keeps its pin until the break ends (containment errs strict), and at break
      end the pin is still RELEASED (ownership, not a setting re-read — the v1.0.55
      review's stranded-pin case).
- [ ] **Zero the scheduled lock on a second device DURING a pinned break** → the tablet
      leaves the break screen within ~5s, unpins, and does NOT re-lock when the feature
      is later re-enabled (the stale-`until` case).
- [ ] **Parent-code recovery, device path** (v1.0.26) — NEVER RUN ON HARDWARE. On a device
      WITH a lock screen: "שכחתי את הקוד" must raise the system prompt; success goes straight
      to choosing a new code; cancelling must still offer the 24-hour wait.
- [ ] The same on a device with **no lock screen** → no prompt at all, straight to the wait.
- [ ] ⚠️ **With the exit lock ON (screen pinning)** — the open question. If the keyguard
      cannot appear under lock-task, the wait is the only route there and the UI must still
      reach it rather than dead-ending.
- [ ] Real fullscreen on tap, and 🏠 only after leaving fullscreen.
- [ ] **Landscape scroll after leaving fullscreen** (v1.0.52): hold the tablet SIDEWAYS,
      play a video, exit fullscreen, then swipe up ON THE VIDEO ITSELF — the page must
      scroll down to the grid and the pager (the shield is `touch-action: pan-y` now).
      The swipe must NOT pause the video; a clean tap still toggles pause and a double
      tap still seeks. Try immediately after the exit too (the first ~700ms used to be
      snapped back to the top by the v1.0.51 pin — a finger now disarms it).
- [ ] **Fullscreen forces landscape** (v1.0.54): on a PHONE with auto-rotate OFF, tap a
      video → the screen rotates to landscape by itself, and flipping the phone 180°
      follows (SENSOR_LANDSCAPE); exit fullscreen → back to portrait. Let a video PLAY
      TO ITS END → the app returns to the folder in PORTRAIT — never stuck sideways
      (the restore-before-guard invariant). Same behavior on the tablet; on TV nothing
      changes. *(An activity-level request the browser cannot exercise at all.)*
- [ ] **Fullscreen now-playing overlay** (v1.0.53): enter fullscreen, tap the screen —
      the video's title (and for channel content the channel line, logo included when
      the family is subscribed) fades in at the TOP with the HUD and out with it.
      Taps / double-taps still work through it, and in the SMALL player it must never
      appear. *(Embedded browser panes deny fullscreen, so only a device can show it.)*
- [ ] Keep-awake during playback.
- [ ] **Physical power button mid-video** (v1.0.32): the soundtrack STOPS with the screen;
      screen back on → the video is waiting, PAUSED, at the same second — not gone, not
      restarted. Repeat with the exit lock ON: identical. *(The browser only simulates
      `visibilitychange`; the real button and lock-task interplay exist only on a device.)*
- [ ] **Picker exit button** (v1.0.32): with the kiosk armed for the last-used child,
      reach the profile picker (cold-start share is the honest route) → 🚪 must ask for
      the parent code before leaving. With the kiosk off: confirm → straight out.

### Cross-device (needs TWO devices on one Google account)
> Nothing here has ever been verified end to end. The merge logic and local storage are
> tested; **the full round trip is not.**
- [ ] Approve a video on device A → it appears on device B after a launch or a resume.
- [ ] Change the **parent PIN** on A → B opens with the new code.
- [ ] Toggle a per-child setting on A → B agrees.
- [ ] **Delete a profile on A → it stays deleted on B** (v1.0.25 tombstones), and does not
      reappear after several syncs.
- [ ] Add a channel on A → B gets it without duplicating its videos.

### Content sources
- [ ] Add a channel by **Hebrew @handle** (e.g. `@חלומותחסידיים`) — CORS blocks the keyless
      page scrape in a browser, so only a device proves this.
- [ ] **Add `@BARDAK613` from the tablet** (v1.0.32). The device's HTTP layer gets the
      MOBILE page (m.youtube.com), which has none of the desktop identity keys — v1.0.29–31
      all passed in a desktop browser and failed here. The channel must import its real
      videos (~97 long-form), not "הערוץ נוסף, אבל לא נמצאו בו סרטונים".
      **Any scrape-parsing fix must be probed against the mobile page variant.**
- [ ] Add a **playlist** link, `m.youtube.com` form (v1.0.26).
- [ ] Add a channel **and** a playlist of that same channel → one folder, no duplicates.
- [ ] **YouTube search on the device** (v1.0.33): a Hebrew query in the add tab returns
      results through the NATIVE CapacitorHttp POST (Dalvik UA — the live probes say the
      API is UA-safe, but the @BARDAK613 lesson makes device verification mandatory; a
      silently-dropped POST body would surface here as the network/parse message over
      working Wi-Fi). Suggestions appear in HEBREW (not ����), the chips filter, a video
      adds from the bubble ➕ and advances, a channel add reaches the three-way dialog,
      'עוד תוצאות' appends, and airplane mode shows the network message while the
      existing results stay.
- [ ] **Browsing inside a result** (v1.0.33): tap a CHANNEL result's picture/name → its
      Videos-tab list appears with a back header; add one video from inside (✓ נוסף);
      hardware back returns to the intact search results (never out of the screen);
      same for a PLAYLIST result; 'עוד תוצאות' inside a big channel appends pages, and
      on a small playlist the button simply disappears at the end (no error).

### Playback
- [ ] **Continuous play** (v1.0.25): enable it for one child, let a video end → the countdown
      overlay appears and the next video starts without leaving the player. ✋ returns to the
      folder. With it OFF, a video ending returns to the folder as before.
- [ ] Continuous play must **stop** at the 🎁 folder and before a wrapped gift.
- [ ] **Resume playback** (v1.0.32): enable the setting, stop a video mid-way, force-close
      the app, reopen the video → it continues ~3s before the stop point, and the tile
      carries the red progress sliver. Let a video END → next opening starts at 0, no bar.
- [ ] **Channel logos offline** (v1.0.32): open the app once online, then again in airplane
      mode → the channel folders keep their pictures (served from the byte cache).
      *(CapacitorHttp's `responseType:'blob'` base64 answer is assumed from its docs — the
      first device run of the logo fetch is what proves it.)*
- [ ] TV: D-pad through the parent screens, OK toggles checkboxes.
- [ ] **Idle screen-off** (v1.0.34): set the profile to 1 minute, play a video, don't
      touch anything → after ~1 min the "עדיין צופים?" overlay shows (also in native
      fullscreen — it lives inside `#player-wrap`); ~45s later the video pauses, and the
      TABLET's own display timeout then turns the screen off. Answering (any tap or
      remote key) must ONLY dismiss the prompt — the video must not pause/seek from that
      key. With 0 the screen stays on through a whole long video. **Only a device proves
      the screen actually darkens** — the browser cannot.
- [ ] Idle screen-off on TV: same flow with the remote untouched; after the pause the
      TV's own screensaver/sleep takes over (the app cannot power a panel down).

### Picture-in-picture (v1.0.76 — the browser proved the JS with a stubbed bridge; these are
### the parts only a real device can answer, and the whole feature is device-only)
- [ ] **The window itself**: enable "מסך קטן" for one child, play a video (a file AND a
      YouTube one), press HOME → the video shrinks into a floating window instead of pausing,
      and keeps playing. Pressing HOME on a PAUSED video backgrounds normally (no window).
- [ ] **YouTube keeps playing in the window** — the one thing the excluded-from-bgPlay
      rationale said it could not do off-screen; here the activity is visible, so it must.
- [ ] **The three buttons**: ⏮/⏭ change track (grid order, no wrap at either end), ⏯ pauses
      and resumes, and the ⏯ icon matches the real state. A wrapped 🎁 in the grid is
      SKIPPED, not opened.
- [ ] **The X** dismisses the window → the video pauses in place and banks its spot (reopen
      the app, the same video is waiting where it stopped). With background playback ALSO on
      for an audio file, the X leaves the sound going (that is bgPlay's job, not PiP's).
- [ ] **The event order** (the one link no browser can prove): entering PiP must NOT pause
      the video — if it pauses the instant it shrinks, `pipChanged` is arriving after the
      onPause instead of before it.
- [ ] **Every lock refuses it**: with the kiosk exit-lock on, OR a folder/sites/site
      containment lock engaged, OR during a scheduled break, pressing HOME must NOT float a
      window — it backgrounds (or the lock holds) as before. This is the safety property.
- [ ] **Not on TV / old Android**: the "מסך קטן" row is hidden on a device that cannot PiP
      (pre-8) and on Android TV.

### Search inside a folder (v1.0.58 — the browser proved the scoping; these need a device)
- [ ] **TV**: the 🔍 in the folder header is reachable with the D-pad, and typing works with
      the remote (the folder header now has four controls — check none is unreachable).
- [ ] On a phone in **portrait**, the folder header still fits: 🏠 · name · 🔍 · 🔒.
- [ ] Search inside a 700-song imported collection and tap a result **from another disc** →
      it plays, and the under-player grid pages THAT disc.

### Downloads, cache and folder pictures (v1.0.58 — the browser proved the logic against a
### simulated device; only a real tablet proves the filesystem)
- [ ] **A real download**: play a direct/Drive file whose streaming fails → it downloads,
      plays from the device, and plays again OFFLINE.
- [ ] **Delete that video** → the dialog offers "גם מזיכרון המכשיר"; choosing it frees the
      space (check Android's app-storage screen), and the file in **Google Drive is
      untouched**. Choosing "רק מהאפליקציה" leaves the file — and the daily sweep collects
      it within a day as an orphan.
- [ ] **Delete a video that was NEVER downloaded** → no dialog at all.
- [ ] **Delete a whole folder with several downloaded files** → ONE question, not one per
      video.
- [ ] **The manual cleaner** reports a real count and a real size, and the app-storage
      screen agrees.
- [ ] **The month-old sweep**: set the device clock forward a month (or wait), open the app →
      files not played in that window are gone, the ones being played are not. *(Only a
      device has a filesystem; the browser can only simulate one.)*
- [ ] **A folder emptied by deleting its last video** disappears from the parent's list on
      the next home entry — and a nested Drive ROOT folder does NOT, so new discs keep
      arriving.
- [ ] **🖼️ תמונה on an existing folder**: search by name, paste an https link, or pick an
      icon → the tile changes, and it still renders in airplane mode (the bytes are cached).

### Nested Drive folders (v1.0.58 — the browser proved the walk against the real folder;
### these need a device, a second account, or both)
- [ ] **The reported folder on a DEVICE**: paste a Drive folder of folders → one app folder
      per subfolder, named as in Drive, and the songs play. *(The browser proves the import;
      only a device proves the CapacitorHttp transport reads the same pages.)*
- [ ] **An unwidened / keyless build**: the same paste must still work through the public
      page. This is the door most families are on, and the one the "empty folder" bug hid.
- [ ] **A folder that is genuinely empty** still says "התיקיה ריקה", and an UNSHARED folder
      says to check the sharing — the two must never swap.
- [ ] **A subfolder shared differently from its parent** (open the parent, restrict one
      child) → the import must report "חלק מתת-התיקיות לא נקראו", keep the folders it could
      read, and delete nothing.
- [ ] **Add a song to a disc in Drive**, wait for the refresh (30 min) or reopen the home →
      it arrives in that folder. **Add a whole new disc folder** → a new tile appears.
- [ ] **Delete the ROOT folder in the app** → the discs stay and keep refreshing themselves.
- [ ] Watch the mobile-data cost of one refresh on a 33-folder tree: it must be ONE walk
      (~33 listings), not 33 walks.

### Swipe paging (v1.0.57 — the browser proved the decision and the wiring; these are the
### parts only a real finger on a real panel can answer)
- [ ] **A flick turns the page in all three grids**: home, a folder, and the grid under the
      player. RTL — a swipe to the RIGHT goes to the NEXT page (the ◀ arrow's direction),
      left goes back. The blue arrows still work and still disable at the ends.
- [ ] **A vertical scroll never turns a page** — with a real finger on a scrolling folder,
      including a scroll that drifts sideways. This is browser gesture ARBITRATION
      (`touch-action: pan-y`), which no synthetic pointer event can prove.
- [ ] **The flick that ends on a tile does not open that video**, and an ordinary tap still
      does. Try both fast and slow flicks — the ceiling is deliberately loose (2500ms), so
      an unhurried deliberate drag must still turn the page.
- [ ] **A swipe across the PLAYER changes nothing**: centre tap still pauses, double tap
      still seeks ±10s, and the under-player grid keeps its page.
- [ ] **In the bottom gesture inset**: a flick started at the very bottom of the screen
      belongs to Android (back / home). It must not leave the app in a state where the NEXT
      swipe is ignored — the v1.0.57 lost-end bug, whose fix is pinned but whose trigger is
      the OS.
### 🕒 נצפה לאחרונה (v1.0.57 — the browser proved the folder; these need a device or two)
- [ ] **The stamp survives a force-close**: watch a video past ~10 seconds, kill the app from
      the recents switcher, reopen → the video is in 🕒. *(The write is immediate, but only a
      real process kill proves nothing was buffered.)*
- [ ] **Two devices, one account**: watch different videos on the tablet and on the phone →
      each keeps its OWN 🕒 list, and neither pull empties the other's. Then change the
      NUMBER on one device → the other device's 🕒 resizes after its next pull, while its
      contents stay its own. *(This is the whole device-local/synced split in one check.)*
- [ ] **The number is per child**: set 🕒 to 3 for one profile and 0 for a sibling → the
      sibling's home has no 🕒 tile at all, and the first child's holds 3.
- [ ] **An incoming CALL mid-video** (with feature 3): the stamp must still land — the pause
      does not reset the playhead, so a video already past 10 seconds stays watched.
### Interrupted by a call (v1.0.57 — the browser proved the machinery with a stubbed
### bridge; only a real call proves these)
- [ ] **A real incoming call mid-video**: answer it → the video pauses; hang up → the video
      carries on by itself, from where it stopped, with no tap. Try it both ways round: with
      the call ANSWERED (the call app takes over and the video app backgrounds) and DECLINED
      from the heads-up notification (the app never backgrounds at all — that path is the
      poll, and it is the one a lifecycle-only implementation would miss).
- [ ] **A WhatsApp / Messenger call** does the same. This is the important one on a tablet
      with no SIM, and it is why the app reads the audio mode instead of telephony state.
- [ ] **The power button is NOT a call**: press it mid-video, wait, wake the tablet → the
      video is still PAUSED and waits for the child. Same for HOME and the app switcher.
      *(Auto-resuming any backgrounding is exactly what the user's "calls only" decision
      rules out.)*
- [ ] **A video the child paused THEMSELVES before a call** must still be paused after it.
- [ ] **A very long call** (over 15 minutes) → the video stays paused. By then it is a
      surprise noise, not a convenience.
- [ ] **A scheduled break that matured during the call** → the lock screen wins, and nothing
      plays behind it.
- [ ] **Older APK / no bridge**: nothing auto-resumes and nothing breaks — the pre-v1.0.57
      behaviour, which is what an 'unknown' audio mode must always fall back to.

### Drive files + audio (v1.0.56 — the browser proves the scene and the parsers, NOT these)
- [ ] **A Drive mp3 plays and looks like music**: share an mp3 in Drive as "anyone with the
      link", paste the link in הוספה → the tile carries its REAL name (from the file's
      metadata, not "view") and a 🎵 badge; opening it shows the music scene, not a black
      rectangle, and the HUD/seek/⛶ behave exactly as for a video.
- [ ] **A Drive mp4 still works** (the regression risk of the same path): name from the
      file, 🎬 badge, normal picture.
- [ ] **A NOT-shared Drive file is honest**: paste a link to a private file → the add
      succeeds but the message says to check the "anyone with the link" sharing. (Playback
      of that file will legitimately fail — the app cannot read a parent's private files;
      `drive.file` is the only OAuth scope and must stay that way.)
- [ ] **The download fallback caches with the right extension**: play a Drive mp3 where the
      stream fails (airplane mode mid-play, or a large file) → after "טוען את הסרטון…" it
      plays from `DATA/videos/*.mp3`, and plays again OFFLINE. *(An mp3 cached as `.mp4` is
      a decode gamble — Android guesses the MIME from the extension. Only a device shows it.)*
- [ ] **No black thumbnail is ever burned**: after playing an audio file, its tile keeps the
      placeholder + 🎵 — never a solid black picture. (This is permanent damage when wrong:
      persistThumb never retries a record that already has a thumb.)
- [ ] **A keyless build still names Drive files**: build without `keys.local.js` → the name
      still arrives (the public-page scrape), just slower.
- [ ] Audio behaves like video by design (v1.0.56 decision): the screen-off/background pause
      and the "עדיין צופים?" prompt apply to a song exactly as to a video.

### Links file (v1.0.38 — device only; the suite cannot see any of this)
- [ ] מקורות → **📤 ייצוא רשימת לינקים**: a real `.txt` lands in
      `Android/data/com.assaf.kidsplayer/files/exports/`, the message NAMES that path, and
      Android's share sheet opens on the FILE (not on 400 links pasted as message text).
      Cancelling the share must leave the file behind.
- [ ] Open the exported file: one link per line, `#` header carrying `# פרופיל: <name>`, a
      subscribed channel is ONE line (not its 500 videos), and no `&list=` / `?si=` anywhere.
- [ ] Send it to the OTHER tablet and **📥 ייבוא מקובץ**: the confirm names the target
      profile and the counts by kind; importing reproduces the library; a channel's videos
      land in ממתינים. Try the `לפרופיל חדש בשם …` button too — it must refuse a name that
      already exists on the account.
- [ ] **Android TV**: no file picker exists, so the paste box must be OPEN by default and
      the whole flow must work from the remote.
- [ ] Delete a video, then paste its link again: the ♻️ dialog must appear, "לא" must leave
      it deleted, and "החזרה" must bring it back and SURVIVE the next launch (that is the
      tombstone revocation reaching Drive).

### Sheet sunset (v1.0.38 — needs a legacy profile that HAD a sheet; ⏳ delete after 2026-09-10)
- [ ] First launch after the update, with the Google account connected: the sheet is read
      once, its rows appear in the app, מקורות no longer mentions a list, and the
      spreadsheet is GONE from Drive — while the folder it sat in still exists.
- [ ] `meta['sunset:<profileId>']` ends at `phase:'done'`, and `sources.libraryId` is
      **byte-identical** to what it was before. This is the one that matters: a changed
      scope strands the whole library with no tool left to repair it.
- [ ] Offline / account not connected: nothing is forgotten, nothing is deleted, no attempt
      is burned (`attempts` stays put), and the next launch tries again.
- [ ] A channel the parent had REMOVED but whose row is still in the sheet must NOT come
      back (`planSheetFold` skips any channel with a tombstone).
- [ ] Two devices, one upgraded and one not: the old one's library stays intact (its sheet
      read now 404s, and with no mirror nothing deletes), and it migrates itself when updated.

---

## 5. Verifying each v1.0.25 / v1.0.26 / v1.0.32 feature

| Feature | Fastest honest check |
|---|---|
| Forced sync chains | Two overlapping forced `syncLibrary` calls must return **different** promises and run in series. Both must receive progress events. |
| Channel/share dialog | Add a channel **immediately after launch**, while the launch sync is still running — that window is what used to break it. |
| Pull before sync | `entryRefresh` awaits `maybePullDrive()` before `syncLibrary`; there must be exactly one pipeline. |
| Synced settings | `merge(A,B) === merge(B,A)` and idempotence, plus the doc round trip in `gdrive.test.mjs`. An older doc with no `settings` key must not wipe anything. |
| Continuous play | Seek to the end with `player.handleTvKey('fwd')` (~80ms apart — faster and YouTube reports a stale time). |
| Profile delete | Create a throwaway profile with content, delete it through the UI, then feed `mergeRestoredProfiles` a doc that still lists it. Nothing may come back. |
| Playlist source | The exact field URL, in an isolated profile. Check the folder title, the 🎵 chip and the video count. |
| Preview bubble | Tick two rows, preview a third, decide → **the ticks must survive**. |
| 30-day purge | Age one rejected record past the window in IndexedDB, run a sync, confirm it is gone, a tombstone exists with `reason: 'rejected-expired'`, and fresher rows survive. |
| PIN recovery | Request a reset, then age `pinRecoveryAt` back past 24h in Preferences. Check BOTH the PIN screen and the child's home — the banner is the actual safeguard. Restore the sandbox PIN afterwards. |
| Share feedback | `plan.shareOutcome` covers every reason `routeShare` can return (pinned). On a device, the toast is the diagnostic — read it before assuming the share was lost. |
| Channel-add waits | Add an already-synced channel: the dialog must appear in <300ms with ZERO loading flashes (defer:250). Then stage pending videos and answer each dialog button — every step must name itself, and the finishing screen must stream the sync's real labels. |
| Empty queue | Approve or reject the last waiting video **without leaving the tab** — the line must appear and the badge must clear on the same rebuild. |
| 20-char names | Create a profile with a 20-character name: the tile wraps to two lines and the picker stays aligned. Note `maxlength` does **not** bind a scripted `.value` — test the stored name, not the input. |
| Resume playback (v1.0.32) | Save at ~60s, reopen → `playbackState().time ≈ 57`. Seek into the tail with `player.handleTvKey('fwd')`, let it end → the position record is GONE, `unwrappedAt` intact, no tile bar. The position must never appear in a serialized Drive doc (`serializeStateEntry` is the pin). |
| Screen-off pause (v1.0.32) | In the browser: `Object.defineProperty(document,'hidden',{value:true,configurable:true})` + dispatch `visibilitychange` → `playbackState().playing === false`, same `time`, position banked. The invariants guard pins listener + order + no-`stop()`. |
| ערוצים חדשים (v1.0.32) | Plant a `libraryChannels` row with `addedAt: Date.now()`, no `decidedAt` → it renders in the new section with the ⚙️ button; answering the dialog (or an empty queue tap) stamps `decidedAt` and moves it. `planChannelSections` covers the clock-skew and legacy-row rules. |
| Logo byte cache (v1.0.32) | After one online render: the folder `<img>` src starts with `blob:` and `performance.getEntriesByType('resource')` shows ZERO new ggpht requests on re-render. The two traps are pinned pure: `logoFirstPaint` (warm memory never touches the network) and `planLogoDelivery` (a late fetch may not paint into a host that moved on — `#folder-logo-top` is shared). |
| Website locks (v1.0.67) | Browser covers the SITES lock (engage, 🏠 refusing, back swallowed, relaunch landing, release). **The SITE lock is DEVICE-ONLY** — the viewer is a native overlay. On a device: open a site, tap 🔒 in its bar, enter the code, choose a duration → the bar's button becomes 🔒 הורים, hardware back walks the site's history and then STOPS, and a link to another approved site is blocked. Tap 🔒 and cancel → the site must REOPEN, not leave the child in the app. Force-close and relaunch → the site reopens. ⚠️ A scheduled break must still close the viewer, and deleting the site in the parent screen must release the lock. |
| Browser back/forward (v1.0.76) | **DEVICE ONLY** — the viewer is a native overlay. Open a site, follow a couple of links: the ▶/◀ buttons at the LEFT of the bar must go back and forward through the pages, and each must be GREYED when there is nowhere to go (▶ on the very first page, ◀ until you have gone back). Going back must never reach a page the site was not allowed to show. Check both child mode and parent mode. |
| Page-prefix lock (v1.0.76) | **DEVICE ONLY** — the viewer is native. Open a site, tap 🔒, enter the code → the "כל האתר / רק הדף הזה" question appears. Choose **רק הדף הזה**: the child may then follow links UNDER that page (`/abc/1/efg/…`) but a link to a SIBLING section (`/other`) or the site root must be blocked. Choose **כל האתר**: the whole approved site stays reachable (the v1.0.67 behaviour). **Dive in**: while page-locked, navigate deeper, tap 🔒 → נעילה מחדש → רק הדף הזה → the lock narrows to the deeper prefix. Force-close and relaunch → it reopens page-locked. ⚠️ Also confirm re-lock on an ALREADY-locked site shows the release/re-lock choice (feature 3) and never reopens the site on top of the duration dialog. |
| Swipe smoothness (v1.0.75) | Swipe through a multi-page folder: the page must NEVER flash the one you left after the turn completes. ⚠️ Sampling on a timer will not catch this — the window is shorter than a frame. Use a MutationObserver on the grid's `style` (it fires before paint) and assert zero frames where transform is 0, the ghost is gone, and the grid still holds the old first tile. |
| Lock-screen state (v1.0.74) | **DEVICE ONLY.** Play a song, pause it FROM THE SCREEN, then open the lock screen: the widget must show ▶ (play), not ⏸. Same after a track ENDS — the notification should be gone entirely. ⚠️ The bug was that the state was published only when the notification's own buttons were pressed, so any other pause left it claiming the track was still running. |
| Call resume (v1.0.72) | **DEVICE ONLY.** Two cases, and the second is the regression: (a) play a song, take a call → it must pause and RESUME when the call ends; (b) **pause the song yourself**, wait, then take a call → when the call ends it must stay PAUSED. Case (b) was the bug: the lifecycle door checked it, the poll did not, and the poll is the path a modern heads-up call actually takes. |
| Site lock button (v1.0.70) | **DEVICE ONLY, and this is where v1.0.67 shipped dead.** Open a site: a 🔓 must sit in the viewer's bar beside the name. Tap it → code → duration → it becomes 🔒 and the 🏠 close button DISAPPEARS. ⚠️ Verify the ENGAGE path explicitly, not just the release — the original bug was that only release existed. Parent mode must show no padlock at all. |
| Lock-screen icons (v1.0.70) | The lock screen and the car draw the SESSION's actions, not the notification's. Check the ring-with-10 icons appear THERE too, not only in the shade — v1.0.69 fixed the shade alone and the lock screen kept the system triangles. |
| Audio scene freeze (v1.0.70) | Play an mp3, press pause: the radio and the notes must stop **where they are**, not jump back to the start, and resume from that position. Test the pause from the notification too, not only from the screen. |
| Seek icons (v1.0.69) | On a DEVICE, look at the notification: the outer buttons must be a RING WITH "10" in it (like Spotify's ⟲15), not plain triangles, and the two must be mirrored. ⚠️ Check on the LOCK SCREEN and in the car too — those are separate surfaces. If a very old (pre-24) device ever shows a blank action icon, the cause is the vector having no raster fallback; see the note in the drawable. |
| Notification seek (v1.0.68) | On a DEVICE: the notification's outer buttons must be ⏪/⏩ and move the playhead **10 seconds**, not change track. ⚠️ Seek FORWARD repeatedly near the END of a track: it must stop short and never eject the child back to the grid — that is the v1.0.22 bug, and the notification is a third surface for it. A car's own ⏮/⏭ must also jump ten seconds rather than doing nothing. |
| Notification artwork (v1.0.66) | On a DEVICE: the status-bar glyph must be the app's screen-and-play mark, not a generic ▶. Play a song in a folder that HAS a picture → that picture fills the notification's large icon and the lock-screen widget; play one in a folder without → the app icon. ⚠️ An mp3 never has its own thumbnail, and a Drive-imported folder has no picture until a parent sets one, so the app-icon fallback is the COMMON case, not the rare one. Tap play/pause: the picture must not vanish. |
| Car / MediaSession (v1.0.65) | **DEVICE + CAR.** With background playback on, start a song and connect the phone to the car over Bluetooth: the track name and the folder must appear on the head unit, and the steering-wheel play/pause and next/previous must work. On the phone, the lock screen must show the STANDARD media widget (not a plain notification). ⚠️ Android Auto is NOT covered by this — the app serves no content tree, so it will not appear on the Auto launcher, and video on a car screen is impossible by platform design. |
| Background playback (v1.0.63/64) | **DEVICE ONLY.** ⚠️ FIRST: turning the setting on must raise the Android notification prompt — v1.0.63 shipped without ever asking, so the audio played and the control never appeared. Allow it, then: Turn the setting on for one profile, play an mp3, press the POWER button: the audio must continue and a notification must appear with ⏮/⏯/⏭. Test all three buttons with the screen off. Then: a YouTube video must NOT keep playing; HOME must behave like the power button (Android cannot distinguish them — that is the documented cost); a scheduled break must SILENCE it; switching profiles must stop it; and tapping the notification body must do NOTHING (a content intent would be a hole in the containment lock). On Android 13+ deny POST_NOTIFICATIONS once: playback must still work, only the control disappears. |
| Live swipe feedback (v1.0.62) | On a DEVICE: drag slowly — the grid must follow the finger 1:1 and the next page must be visible coming in from the other side. Release past ⅓ of the width → it completes; below → it springs back. On the first/last page it must give a little and bounce (never freeze). A vertical scroll must not move it sideways at all, and a tap must not nudge it. Flip twice fast: BOTH turns must land (a gesture inside the 220ms settle used to eat the first). ⚠️ In a hidden Browser pane timers are throttled ~6× and transitions may not run — poll for the change, never sleep once and conclude. |
| Nested Drive folders (v1.0.61) | Import a tree: ONE tile on the home reading "N תיקיות"; open it → the discs; open a disc → its songs; back → the collection **on the page you left**, with the collection's name in the header (the header used to be painted only in openFolder, which a back-pop never runs). Lock the COLLECTION: its discs must open, 🏠 hidden at the top and visible inside a disc. A disc deleted in-app must NOT be swept — the refresh re-creates it, so sweeping is a loop. Delete the collection: the confirm names the folders, and the songs move rather than vanish. |
| Re-adding removed content (v1.0.61) | Delete a video, then share the same link back. The PIN and the ordinary confirm must come FIRST and the "הוסר בעבר" question only after them — asking earlier would let a child revoke a deletion by sharing the video back, on every device. Verify BOTH answers: "החזרה" adds it and clears the tombstone; "לא, להשאיר מוסר" leaves the tombstone and stores nothing. For a Drive folder, delete 2–3 of its files and re-import: ONE question carrying the honest count, wording that says **בתיקיה** (the plural copy was written for the links file), and on "yes" exactly those files arrive. A background refresh must never raise it. |
| Mobile channel resolve (v1.0.32) | `extractChannelIdFromHtml` against an m.youtube.com page body: decoy `"channelId"`s must lose to the RSS-alternate link / og:url / twitter:url. Probe fixes with a MOBILE UA — a desktop browser cannot reproduce the failure. |

---

## 6. Release verification

See [PUBLISHING.md](../PUBLISHING.md). The two that keep going wrong:

0. **A four-component version reaches nobody.** `parseVersion` reads three, so `1.0.26.1`
   compares EQUAL to an installed `1.0.26` and every app answers "up-to-date". Both release
   scripts now refuse one before building (`update.versionIsDeliverable`) — it had already
   happened four times, most recently to the release carrying the field-reported share fix.
1. **Every release needs BOTH APK names** — `kids-player-v<X.Y.Z>.apk` (humans + the
   updater's exact match) **and** `kids-player.apk` (the stable name the website button
   redirects to). v1.0.24 shipped only the first; v1.0.25 only the second.
   ```bash
   gh release view v<X.Y.Z> --repo devfassaf/kids_player --json assets -q '[.assets[].name]|join(", ")'
   ```
2. **Bump the version in its own PR, before building.** `release.sh` tags at main's HEAD, so
   building first makes the tag and the artifact disagree.

Release notes are parent-facing Hebrew and get de-noised by `update.extractReleaseNotes`
(12 lines, 160 chars, no markdown/URLs/PR refs). Check what a parent will actually see:

```bash
node -e "import('./www/js/update.js').then(m=>console.log(m.extractReleaseNotes(require('fs').readFileSync('/tmp/notes.txt','utf8')).join('\n')))"
```

### Custom folders (v1.0.56 — the browser proves the flow; these need a device or two)
- [ ] **The v2→v3 database upgrade on a REAL install**: update over an existing app (never a
      debug build over the release one) → the app opens, the library is intact. *(An
      unguarded `createObjectStore` aborts the version-change transaction and the app cannot
      open its database at all — a bricked install, not a bug.)*
- [ ] **A folder made on one device appears on the other** (needs two devices, one account):
      create a folder + file a video into it on the phone → the tablet shows the folder after
      its next pull. The PICTURE will show as an emoji there until that device fetches it
      itself — `artThumbId` names a local blob and deliberately never travels.
- [ ] **A folder deleted on one device stays deleted on the other** — the tombstone, not
      absence, is what carries it (every Drive merge is a union).
- [ ] **The image search on a real tablet**: create a folder with a Hebrew name → candidates
      appear and the chosen one renders offline afterwards (it is stored as bytes). No
      network → no candidates and the emoji row still works.
- [ ] TV: the picker's rows, the create form and the emoji row are all reachable with the
      D-pad (they are real `<button>`s), and the folder tile shows its focus ring.

### Drive folders (v1.0.56 — device items; the browser proved the rest)
- [ ] **A real folder of songs on a device**: share a Drive folder holding mp3/mp4 as
      "anyone with the link", paste it in הוספה → a folder appears named after the Drive
      folder, holding the media files in their natural name order, and they PLAY.
- [ ] **Add a file in Drive, come back later** → it appears by itself (the refresh is
      throttled to 30 minutes and runs on entering the home).
- [ ] **Delete a file in Drive** → it must STAY in the app (additive by design). Deleting
      it in the parent screen is what removes it.
- [ ] **A folder that is NOT shared** → the add says so and points at the sharing setting,
      instead of creating an empty folder.
- [ ] **After the operator adds the Drive API to the key's restrictions**, the keyed
      listing should take over (it is faster and paginates); the app must behave the same.
      *(Until then every install uses the public-page path — that is the measured default.)*

### Containment lock (v1.0.56 — the browser proved the chrome; these need a device)
- [ ] **Folder lock on a device**: open a folder → padlock → code → 15 min → the child is
      inside that folder, the OS pinning confirmation appears, HOME and recents are
      contained, and 🏠 / the profile chip / search are gone.
- [ ] **Force-close and relaunch** → the app comes back INSIDE the locked folder, still
      locked. (A child who kills the app must not walk out of it.)
- [ ] **The timer expires by itself** → the lock releases, the tablet unpins, and every
      control returns. On a device with the system "ask PIN before unpinning" option this
      lands on the DEVICE's own lock screen — the same bound the kiosk always had.
- [ ] **Release by hand**: padlock → code → released, and the exit button comes back for a
      family whose kiosk is OFF.
- [ ] **Lock + KIOSK together**: releasing the containment lock must NOT unpin the session
      (the kiosk owns it) and must not raise the keyguard.
- [ ] **A scheduled break during a folder lock** → when the break ends the child returns to
      the LOCKED FOLDER, not the gallery.
- [ ] TV: the padlock is reachable with the D-pad on both the home and a folder, and the
      duration presets are focusable.
