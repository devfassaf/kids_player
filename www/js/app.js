// app.js — boot, global wiring, and (until the view split completes) the gallery,
// PIN and parent screens. Navigation goes through nav.js; dialogs through ui/modal.js.
import {
  loadItems, getSource, youtubeThumbCandidates,
  getProfiles, getActiveId, getActiveProfile, createProfile, deleteProfile,
  migrateLegacyIfNeeded, loadActiveId, setActiveId, fetchYouTubeTitle,
  profileNameExists, profileNameConflict, duplicateProfileNames
} from './store.js';
import * as wake from './wake.js';
import { hasPin, setPin, verifyPin, clearPin } from './pin.js';
import { getSetting, getSettings, putSetting } from './settings.js';
import { playItem, stop, playbackState, pauseCurrent, resumeCurrent, seekRelative, markUserToggle } from './player.js';
import { clearCache } from './media.js';
import { onAppResume, onAppPause, onBackButton, exitApp, prefGet, prefSet, prefRemove,
  siteViewerAvailable, openSiteViewer, closeSiteViewer, clearSiteData, onSiteEvent,
  setOrientation, httpGetBlob, audioMode, startBackgroundPlayback, stopBackgroundPlayback, onPlaybackCommand, ensureNotificationPermission } from './platform.js';
import { canonicalSitePrefix, ruleCandidatesFor, ruleIdFor, shortcutIdFor,
  extractSiteIconFromHtml, rulesForLockedSite } from './weblock.js';
import { runMigrationIfNeeded } from './migrate.js';
import { PAGE_VIDEOS, PAGE_WATCH, PAGE_FOLDERS, AVATARS,
  AUTOPLAY_COUNTDOWN_MS, AUTOPLAY_RETRY_MS, REJECTED_TTL_DAYS, RESUME_SAVE_MS,
  PIN_RECOVERY_DELAY_HOURS, SCHED_LOCK_DEFAULT_DURATION_MIN,
  SCREEN_OFF_DEFAULT_MIN, SCREEN_OFF_PROMPT_SEC, PRUNE_REVIEW_CAP,
  KEEP_NEWEST_SUGGESTED, SITE_PROBE_TIMEOUT_MS, CALL_RESUME_POLL_MS,
  RECENT_DEFAULT_LIMIT, RECENT_MAX_LIMIT, RECENT_MIN_PLAY_SEC,
  CACHE_SWEEP_EVERY_MS, FOLDER_SEARCH_MAX_PER_FOLDER, FOLDER_SEARCH_MAX_TOTAL, BG_ART_MAX_BYTES } from './config.js';
import { confirmKid, askKid, alertKid, mountModal, isModalOpen } from './ui/modal.js';
import { rankItems } from './search.js';
import { toast } from './ui/toast.js';
import { planAutoplay, nextInOrder, previewEmbedUrl, previewBubbleButtons,
  resumeStartAt, resumeSaveDecision, watchedFraction, nowPlayingChannel,
  fullscreenOrientation, planCallResume, backgroundPlayDecision, opensFullscreen } from './playerlogic.js';
import { groupSinglesByChannel, shouldFlattenHome, isLooseRecord,
  resolveWatchContext, attentionDot, parentLandingTab,
  pendingBulkAction, PARENT_TAB_IDS, channelAddOutcome, planEntryRefresh,
  planProfilePurge, planRejectedPurge, shareOutcome, groupLibraryByFolder, planBootProfile, evalScheduledLock, scheduledLockDurationMs, lockCountdownLabel, pinKeyAction, lockScreenContainment,
  planChannelSections, planLogoCache, logoFirstPaint, planLogoDelivery,
  screenOffMinutes, evalIdleSleep, sourceDrops,
  keepNewestPerChannel, planChannelWindow, pruneReviewList, protectedWindowKeys,
  pruneConfirmText, favActive, favouriteKeys, recentLimitFor, recentKeys,
  planCacheSweep, planEmptyFolderSweep, deleteLocalChoice, formatBytes, folderSearchScope,
  channelSyncModeDialog, channelSyncModeOutcome,
  folderPickOptions, normalizeFolderTitle, customFolderId, customFolderTitleClash,
  isCustomFolder, planFolderDeletion, planDriveFolderImport, planDriveTreeImport, driveFolderOutcome,
  evalContainment, containmentChrome, normalizeLockMinutes, containConfirmText, relockChoice,
  folderAncestry, folderSubtreeIds, folderWithinLock, homeFolderRows, folderPageSlots, folderPageTotal } from './plan.js';
import { makePager } from './ui/pager.js';
import { attachSwipePager } from './ui/swipe.js';
import * as loading from './ui/loading.js';
import * as nav from './nav.js';
import * as db from './db.js';
import { syncLibrary, shouldSync } from './sync2.js';
import { normalizeTitle } from './normalize.js';
import { burst } from './ui/confetti.js';
import { playUnwrap } from './ui/sound.js';
import { initShareTarget, drainShareQueue } from './share.js';
import { TOUR_SLIDES, ADD_GUIDE_SLIDES, nextIndex, slideState, deckChrome, backAction } from './tour.js';

const PAGE_SIZE = PAGE_VIDEOS;
const $ = (id) => document.getElementById(id);

const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">' +
  '<rect width="320" height="180" fill="#d8d5f0"/>' +
  '<circle cx="160" cy="90" r="42" fill="#8a84c8"/>' +
  '<polygon points="146,68 146,112 184,90" fill="#fff"/></svg>'
);

let items = [];                       // legacy Preferences list — parent screen only
let source = { mode: 'manual', url: '' };
let page = 0;                         // home page (folder tiles OR flat single-folder)
let homePages = 1;                    // v1.0.57: page COUNT, for the swipe (updateHomePager)
let currentWatch = null;
let profiles = [];
let createSel = null;

// IDB-backed kid views (F10)
let activeProfileId = null;
let libScope = null;                  // the shared library scope of this profile's sheet
let folders = [];                     // built by buildFolders()
let folderId = null;                  // open folder in #view-folder
let folderPage = 0;
let folderPagerObj = null;
let giftStates = new Map();           // key -> profileVideoState record (gifts F9, resume v1.0.32)
let resumeEnabled = false;            // the active profile's synced 'resume' setting (v1.0.32)
let bgPlayEnabled = false;            // v1.0.63: the active profile's synced 'bgPlay' setting
let bgPlayLive = false;               // …and whether the foreground service is running now
let recentLimit = RECENT_DEFAULT_LIMIT; // v1.0.57: 🕒 folder size, per profile, synced (0 = off)
// v1.0.12 grouping of loose singles — record arrays built by ONE bulk read in
// buildFolders and paginated directly (no per-key IDB reads on render).
let singleGroups = new Map();         // channelId -> records of its grouped singles
let absorbedSingles = new Map();      // channelId -> singles shown inside its 📺 folder
let looseSingles = [];                // what stayed in the flat "סרטונים נוספים" list
let customFolderRows = [];            // v1.0.61: the raw cf: rows — the ancestry walk's input
let watchCtx = { scope: null, folderId: null }; // which folder the watch grid pages

// PIN flow state
let pinMode = 'verify';
let pinStep = 1;
let pinFirst = '';
let pinBuffer = '';
let pinOnSuccess = null; // what a correct code unlocks (default: the parent screen)
let pinDone = null;      // v1.0.7: fires exactly once per pin session — success OR cancel

/** Resolve the pin session once. Success consumes it BEFORE navigation, so the
    onLeave that follows (enterParent replaces the view) can't double-fire as cancel. */
function consumePinDone(success) {
  const f = pinDone;
  pinDone = null;
  if (f) { try { f(success); } catch {} }
}

/* ---------------- Views (routing via nav.js) ---------------- */
const isGalleryActive = () => nav.isActive('gallery');

function goGallery() {
  stop();
  wake.releaseAll(); // hard safety net (F7): outside the player, the screen may sleep
  currentWatch = null;
  // v1.0.56 — UNDER A FOLDER LOCK THE HOME IS NOT A DESTINATION. This is the ONE funnel
  // every "go home" path uses (the in-place delete, the share flow, leaveWatch's floor,
  // the search/sites back buttons…), so containing it here covers all of them at once —
  // the same reasoning that made openFolder the boundary rather than each caller.
  if (containState.active && containState.mode === 'folder' && containState.folderId) {
    folderId = containState.folderId;
    renderFolderView().catch(() => {});
    nav.reset('folder');
    return;
  }
  // v1.0.67 — the same funnel, for the websites locks: "go home" under them means the
  // websites screen, never the videos. Covers every caller at once, which is why the
  // folder case lives here too rather than in each of them.
  if (containState.active && (containState.mode === 'sites' || containState.mode === 'site')) {
    nav.reset('sites');
    renderSitesView();
    return;
  }
  renderHome();
  nav.reset('gallery');
}

/* ---------------- Exit lock (v1.0.11; PER-PROFILE since v1.0.25) ---------------- */
// When ON: the app is OS-pinned (home/recents/back contained by Android — the only
// sanctioned way to catch the HOME button), the exit button disappears, and every
// exit path runs confirm → parent PIN → unpin + exit.
//
// v1.0.25 — it belongs to the CHILD, not the tablet: one account can hold a 3-year-old
// who must not get out and a 7-year-old who may. It also syncs, so setting it once
// covers every device that child uses.
//
// `pid` defaults to the active profile, but the launch arming runs BEFORE a profile is
// chosen and passes the last active one — otherwise the app sits unlocked from launch
// until someone taps a tile, which is exactly when an unattended child is holding it.
async function exitLockOn(pid = activeProfileId) { return boolSetting(pid, 'exitLock'); }

// v1.0.55 — full-tablet lock DURING THE SCHEDULED BREAK only (the kiosk above is the
// always-on variant). Per-profile, synced, OFF unless written: a family that never opens
// the settings keeps today's behaviour — the app locks, the tablet stays free.
async function lockTabletOn(pid = activeProfileId) { return boolSetting(pid, 'lockTablet'); }

// The fail-safe boolean read both containment settings share (v1.0.55, extracted from
// two identical bodies): junk, a throw, or no profile all read as OFF — a corrupted
// value must never lock a tablet nobody locked.
async function boolSetting(pid, name) {
  if (!pid) return false;
  try { return (await getSetting(pid, name, false)) === true; } catch { return false; }
}

async function applyExitLockUi() {
  const on = await exitLockOn();
  $('exit-btn').classList.toggle('hidden', on);
}

/**
 * Bring the OS pinning and the exit button in line with the ACTIVE profile's setting.
 *
 * Must run on every profile activation, not only at launch: once the lock belongs to a
 * child rather than to the tablet, switching children changes the answer. Both directions
 * were wrong without this, and one of them is a real escape — arriving at a LOCKED profile
 * from an unlocked one left the device unpinned with the exit button still on screen, so
 * the child the lock exists for could simply walk out. (The other direction merely leaves
 * a sibling pinned until the next launch.)
 */
async function applyExitLock() {
  const on = await exitLockOn();
  try {
    const { lockTask } = await import('./platform.js');
    // v1.0.36: PIN ONLY, NEVER UNPIN, on profile activation. stopLockTask() makes many
    // devices raise the DEVICE keyguard ("lock device when unpinning" — a system setting
    // we can neither read nor change), so switching from a locked child to an unlocked
    // sibling locked the whole TABLET mid-switch (field report). The pin is released only
    // where leaving the app is the point: the code-gated exits (pinGatedExit — askExit
    // and, since v1.0.55, the break screen's door), the settings toggle, the native
    // installer (installApk unpins itself), and the end of a scheduled break
    // (clearScheduledLock: breakPinHeld ownership + the kiosk veto, v1.0.55). Until then
    // an unlocked profile on a still-pinned session keeps the exit button as its way out
    // — containment may err STRICT, never loose, and the security direction
    // (unlocked→locked must pin NOW) still applies immediately.
    if (on) await lockTask();
  } catch { /* browser preview / plugin absent — the UI half still applies */ }
  await applyExitLockUi();
}

/* ---------------- Scheduled per-profile lock (v1.0.31) ---------------- */
// A screen-time limit: after N minutes of a session the app LOCKS for M minutes, then
// returns to normal and re-arms on the child's next video. SETTINGS sync per profile;
// the live timer state is DEVICE-LOCAL (Preferences, keyed by profile) — a lock is about
// THIS device's session, and syncing "locked until X" would lock a sibling's device.
// The pure decision lives in plan.evalScheduledLock; here is only the plumbing.
const lockArmedKey = (pid) => 'schedlock:' + pid + ':armed';
const lockUntilKey = (pid) => 'schedlock:' + pid + ':until';
let lockTicker = null;

async function schedLockSettings(pid) {
  let after = 0, dur = SCHED_LOCK_DEFAULT_DURATION_MIN;
  try { after = Number(await getSetting(pid, 'lockAfterMin', 0)) || 0; } catch {}
  try { dur = Number(await getSetting(pid, 'lockDurationMin', SCHED_LOCK_DEFAULT_DURATION_MIN)); } catch {}
  return { afterMin: after, durationMin: dur };
}

/** Read the device-local timer state + settings and let the pure helper decide. */
async function evalActiveLock() {
  const pid = activeProfileId;
  if (!pid) return { phase: 'off', msLeft: 0, pid: null };
  const { afterMin, durationMin } = await schedLockSettings(pid);
  const armedAt = Number(await prefGet(lockArmedKey(pid))) || 0;
  const lockedUntil = Number(await prefGet(lockUntilKey(pid))) || 0;
  return { ...evalScheduledLock({ armedAt, lockedUntil, afterMin, durationMin }), pid, durationMin };
}

/**
 * Arm the countdown on the child's FIRST video of a session (user's decision: the timer
 * ACCUMULATES — it never resets on a later video, or continuous play would defeat it).
 * Idempotent: only the first call while idle sets the stamp.
 */
async function armScheduledLock() {
  try {
    const e = await evalActiveLock();
    if (e.phase === 'idle') await prefSet(lockArmedKey(e.pid), String(Date.now()));
  } catch {}
}

/** Enter the lock: stamp the end time, drop the armed stamp, show the locked screen. */
async function enterScheduledLock(pid, durationMin) {
  await prefSet(lockUntilKey(pid), String(Date.now() + scheduledLockDurationMs(durationMin, SCHED_LOCK_DEFAULT_DURATION_MIN)));
  await prefRemove(lockArmedKey(pid)).catch(() => {});
  await showLockedScreen();
}

/**
 * v1.0.55: the break's containment decision, from ONE settings read — the 5s tick asks
 * while the break screen is up, and two getSetting calls were two full Preferences
 * round-trips each (review finding). The decision itself is pure lockScreenContainment;
 * junk reads as OFF (the boolSetting rule).
 */
async function breakContainment(pid = activeProfileId) {
  if (!pid) return lockScreenContainment({});
  try {
    const s = await getSettings(pid, ['exitLock', 'lockTablet'], false);
    return lockScreenContainment({ kiosk: s.exitLock === true, lockTablet: s.lockTablet === true });
  } catch { return lockScreenContainment({}); }
}

// v1.0.55: does the BREAK hold the OS pin right now? Runtime ownership, deliberately NOT
// a setting read: the lockTablet toggle can flip mid-break (settings sync), and the
// release must follow what this device actually pinned, not whatever the toggle says at
// release time — a mid-break toggle-off used to strand the pin for good (review finding).
// Process-local on purpose: a relaunch that lands back on the lock screen re-pins and
// re-learns it.
let breakPinHeld = false;

/** Clear the lock AND the armed stamp — the next video re-arms a fresh cycle. */
async function clearScheduledLock(pid = activeProfileId) {
  if (!pid) return;
  await prefRemove(lockUntilKey(pid)).catch(() => {});
  await prefRemove(lockArmedKey(pid)).catch(() => {});
  // v1.0.55: release the pin THE BREAK HOLDS (breakPinHeld — ownership, see above), and
  // ONLY when the kiosk is off: pure lockScreenContainment.unpinOnClear is the kiosk veto
  // (v1.0.36 — a kiosk session stays pinned; its release points are the code-gated exits).
  // When the kiosk vetoes, the flag still drops: the pin's ownership passes to the kiosk.
  // Known consequence, stated in the settings hint: on devices with the system "lock
  // device when unpinning" option, a break that expires by itself lands on the DEVICE's
  // own lock screen — the system's rule, which the app can neither read nor change.
  try {
    if (breakPinHeld && (await breakContainment(pid)).unpinOnClear) {
      const { unlockTask } = await import('./platform.js');
      await unlockTask();
    }
  } catch { /* browser preview / plugin absent */ }
  breakPinHeld = false;
}

/**
 * The one evaluator, run on a timer and on lifecycle events. Transitions:
 *   due    → start the lock (unless already showing it);
 *   locked → show the screen (or refresh the countdown) — expired clears and re-arms;
 *   else   → if the locked screen is up but the lock is gone, leave it.
 */
async function tickScheduledLock() {
  try {
    const e = await evalActiveLock();
    if (e.phase === 'due') { await enterScheduledLock(e.pid, e.durationMin); return; }
    if (e.phase === 'locked') {
      if (e.msLeft <= 0) { await clearScheduledLock(e.pid); if (nav.isActive('locked')) leaveLockedScreen(); return; }
      if (nav.isActive('locked')) {
        $('locked-countdown').textContent = lockCountdownLabel(e.msLeft);
        // v1.0.55: RE-APPLY containment on every tick while the break screen is up —
        // re-pin after the hold-back+recents unpin gesture (which never backgrounds the
        // app, so no resume event fires), and refresh the exit door after a settings
        // flip from another device (they sync). See refreshLockContainment.
        await refreshLockContainment();
      } else if (nav.isActive('pin') && breakPinHeld) {
        // A code screen (🚪 / פתיחה להורים) stacked over the lock: showLockedScreen bails
        // on its own pin-view guard, so without this branch the unpin GESTURE goes
        // unanswered for as long as the code screen sits there — leave it open, gesture,
        // HOME, and the whole break is escaped (review finding). Re-assert the pin only:
        // the exit door is not on screen, and a parent-gate PIN with no break pin held
        // must never get the OS ceremony (breakPinHeld is the difference).
        try { const { lockTask } = await import('./platform.js'); await lockTask(); } catch {}
      }
      else await showLockedScreen();
      return;
    }
    // Not locked any more but the screen is still up — the window vanished OUTSIDE
    // clearScheduledLock (the live case: a parent zeroing lockAfterMin on another device;
    // evalScheduledLock answers 'off' before it ever reads lockedUntil). Tear down
    // THROUGH clearScheduledLock (review finding): it releases the break's pin and drops
    // the stale `until` stamp, which would otherwise re-lock the child the moment the
    // feature is ever re-enabled.
    if (nav.isActive('locked')) { await clearScheduledLock(e.pid || activeProfileId); leaveLockedScreen(); }
  } catch {}
}

/** Draw + reveal the locked screen for the active profile; the exit door and the
 * full-tablet pin are refreshLockContainment's job (v1.0.55). */
async function showLockedScreen() {
  const e = await evalActiveLock();
  if (e.phase !== 'locked') return;
  // v1.0.45 — CLOSE THE SITE VIEWER FIRST. It is a native view laid OVER the whole app,
  // so `nav.reset('locked')` below would swap the screen underneath it and the child
  // would keep browsing with the lock invisible behind them. This is the one wiring step
  // that decides whether the browser respects screen time at all.
  if (siteViewerOpen) { await closeSiteViewer(); siteViewerOpen = false; }
  // v1.0.31: NEVER slam the lock over the parent mid-configuration. The parent screen and
  // its PIN sit behind the code, so a child is not there — and locking a parent out of the
  // very screen where they set the timer would be absurd. The next tick (or their return to
  // the gallery) shows it once they leave. The lock is stamped either way, so no time is lost.
  if (nav.isActive('parent') || nav.isActive('pin') || nav.isActive('connect') || nav.isActive('tour')) return;
  // v1.0.63 — A BREAK STOPS THE MUSIC TOO. Screen time that leaves a song playing is not a
  // break, and the notification would hand the child a ⏭ button that carried on through the
  // whole lock — the site-viewer lesson above, on the new surface. Placed AFTER the
  // parent-screen guard for the same reason it is: a parent mid-configuration is not a break.
  await disarmBackgroundPlayback().catch(() => {});
  pauseCurrent();
  $('locked-countdown').textContent = lockCountdownLabel(e.msLeft);
  // Containment BEFORE the reveal (review finding): the exit door's `hidden` class is
  // sticky DOM state from the PREVIOUS break, so painting first showed a stale — possibly
  // free — door for the duration of the settings read. Still AFTER the guards above,
  // deliberately: pinning while the parent-screen guard bailed would run the OS pinning
  // ceremony under a parent who is mid-configuration.
  await refreshLockContainment();
  if (!nav.isActive('locked')) nav.reset('locked');
}

/**
 * v1.0.55: apply the break screen's containment — the exit door's visibility AND the
 * full-tablet pin — from the CURRENT settings (pure lockScreenContainment: the kiosk
 * hides the door entirely, the v1.0.31 rule; the full-tablet lock keeps it visible but
 * behind the parent code, onLockedExitTap, and pins the task).
 *
 * Runs when the screen shows and AGAIN on every 5s tick while it is up, for two reasons,
 * both measured in the browser: the hold-back+recents gesture unpins WITHOUT
 * backgrounding the app, so no resume event ever re-arms the pin and the tick is the
 * only chance; and the settings SYNC, so a parent flipping them on another device
 * mid-break would otherwise leave a stale exit door on this screen until the next break.
 * Idempotent (the native pin is state-gated, v1.0.36) and swallowing — a hiccup must
 * never take the lock screen down with it.
 */
async function refreshLockContainment() {
  try {
    const contain = await breakContainment();
    $('locked-exit').classList.toggle('hidden', contain.hideExit);
    if (!contain.pinTask) return;
    const { lockTask } = await import('./platform.js');
    // a TRUE answer means the native call went through — record the break's ownership
    // of the pin, which is what clearScheduledLock's release is gated on
    if ((await lockTask()) === true) breakPinHeld = true;
  } catch { /* browser preview / plugin absent */ }
}

function leaveLockedScreen() {
  // back to where the child belongs. v1.0.56: under a FOLDER containment lock that is the
  // LOCKED FOLDER, not the gallery — a break that ends must not be a way out of the lock.
  if (!activeProfileId) { nav.reset('profiles'); return; }
  if (containState.active && containState.mode === 'folder' && containState.folderId) {
    folderId = containState.folderId;
    nav.reset('folder');
    renderFolderView().catch(() => {});
    return;
  }
  nav.reset('gallery');
}

/** The discreet פתיחה tap: parent code → unlock immediately (and re-arm on next video).
 * STACKED, not replace (v1.0.55 review): replace swapped the lock view out, so CANCELLING
 * the code landed the child on the gallery until the next 5s tick — a small escape hatch
 * that could be spammed. Cancel now lands back on the lock screen, like the exit door. */
async function onLockedParentTap() {
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: 'קוד הורים לפתיחת הנעילה',
    onSuccess: async () => { await clearScheduledLock(); leaveLockedScreen(); }
  });
}

/**
 * The ONE code-gated way out of a pinned session: parent code → unpin → exit. Shared by
 * askExit (the kiosk) and the break screen's exit door (v1.0.55) — the unpin-before-exit
 * order (Android refuses to finish a pinned task) and the keyguard consequence ("lock
 * device when unpinning", a system setting) live in ONE place. Not replace:true —
 * cancelling lands back where the tap came from (home / the lock screen).
 */
async function pinGatedExit() {
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: 'קוד הורים ליציאה מהאפליקציה',
    onSuccess: async () => {
      const { unlockTask } = await import('./platform.js');
      await unlockTask();
      exitApp();
    }
  });
}

/**
 * v1.0.55: the break screen's exit door — the FULL containment is read at tap time:
 *  - the kiosk hides the door, so a tap that beats the 5s refresh after a remote
 *    kiosk-flip SELF-HEALS (re-hide, do nothing) instead of exiting through a stale
 *    button (review finding);
 *  - the full-tablet lock gates it behind the parent code (pinGatedExit), and the break
 *    KEEPS RUNNING (user decision 2026-08-28): leaving is the parent's own way out, not
 *    the child's early release — reopening the app lands back on the lock;
 *  - neither ⇒ today's free exit (the native exitApp stops any lock-task defensively).
 */
async function onLockedExitTap() {
  const contain = await breakContainment();
  if (contain.hideExit) { $('locked-exit').classList.add('hidden'); return; }
  if (contain.gateExit) { await pinGatedExit(); return; }
  exitApp();
}

function startLockTicker() {
  if (lockTicker) return;
  lockTicker = setInterval(() => {
    tickScheduledLock().catch(() => {});
    tickContainment().catch(() => {}); // v1.0.56 — expire + re-assert the pin
  }, 5000);
}

/* ---------------- Containment lock (v1.0.56) ----------------
 * The parent locks the child INTO the app, or into ONE folder, with an optional timer.
 * Entering AND leaving both cost the parent code (the user's requirement).
 *
 * DEVICE-LOCAL (Preferences), exactly like the scheduled break above and for the same
 * reason: a lock is about the tablet in the child's hands, and syncing "locked until X"
 * would lock a sibling's device. It SURVIVES A RESTART (the mode/until stamps are read on
 * boot, on resume and on profile activation) — a child who force-closes the app must not
 * walk out of the lock.
 */
const containModeKey = (pid) => 'contain:' + pid + ':mode';
const containFolderKey = (pid) => 'contain:' + pid + ':folder';
const containUntilKey = (pid) => 'contain:' + pid + ':until';
const containSiteKey = (pid) => 'contain:' + pid + ':site';   // v1.0.67: the locked site's url
const CONTAIN_LAST_MIN = 'contain:lastMin'; // feature 5: the remembered default

// Runtime OWNERSHIP of the OS pin, the breakPinHeld pattern (v1.0.55): the release must
// follow what THIS lock actually pinned, never a re-read of some setting — and it must
// never unpin a session the kiosk owns.
let containPinHeld = false;
let containState = { active: false, mode: null, folderId: null, siteUrl: null, msLeft: 0 };

async function readContainment(pid = activeProfileId) {
  if (!pid) return evalContainment({});
  try {
    return evalContainment({
      mode: await prefGet(containModeKey(pid)),
      folderId: await prefGet(containFolderKey(pid)),
      siteUrl: await prefGet(containSiteKey(pid)),
      until: Number(await prefGet(containUntilKey(pid))) || 0
    });
  } catch { return evalContainment({}); }
}

async function clearContainment(pid = activeProfileId) {
  if (!pid) return;
  for (const k of [containModeKey(pid), containFolderKey(pid), containSiteKey(pid), containUntilKey(pid)]) {
    await prefRemove(k).catch(() => {});
  }
  // Release ONLY the pin this lock took, and NEVER under the kiosk (the v1.0.36 rule:
  // a kiosk session stays pinned; stopLockTask raises the device keyguard). When the
  // kiosk vetoes, ownership simply passes to it — the flag drops either way.
  try {
    if (containPinHeld && !(await exitLockOn(pid))) {
      const { unlockTask } = await import('./platform.js');
      await unlockTask();
    }
  } catch { /* browser preview / plugin absent */ }
  containPinHeld = false;
  containState = { active: false, mode: null, folderId: null, siteUrl: null, msLeft: 0 };
}

/**
 * Apply the lock to the chrome and pin the task. Called on boot, on profile activation,
 * on resume, on every home/folder render and from the 5s tick — the same "re-assert, do
 * not assume" cadence the break lock needs, for the same measured reason: the
 * hold-back+recents gesture unpins WITHOUT backgrounding the app, so no lifecycle event
 * ever fires and only a tick can notice.
 */
async function applyContainment() {
  const pid = activeProfileId;
  const c = await readContainment(pid);
  if (c.expired) { await clearContainment(pid); await refreshContainUi(); return; }
  containState = c;
  await refreshContainUi();
  if (!c.active) return;
  try {
    const { lockTask } = await import('./platform.js');
    if ((await lockTask()) === true) containPinHeld = true;
  } catch { /* browser preview / plugin absent */ }
}

/** Paint both padlocks and close every door the lock forbids. */
async function refreshContainUi() {
  // v1.0.61 — is the child standing AT the locked folder, or somewhere inside it? Only the
  // first is a place where 🏠 would be an escape.
  const atLockFolder = !containState.folderId || folderId === containState.folderId;
  const chrome = containmentChrome({ ...containState, atLockFolder });
  for (const id of ['lock-btn', 'folder-lock-btn', 'sites-lock-btn']) {
    const b = $(id);
    if (!b) continue;
    b.textContent = chrome.locked ? '🔒' : '🔓';
    b.classList.toggle('is-locked', chrome.locked);
    b.setAttribute('aria-label', chrome.locked ? 'שחרור הנעילה (קוד הורים)' : 'נעילה');
  }
  // The exit button is hidden by the kiosk OR by containment. It must be restored in BOTH
  // directions: only ever ADDING the class left a kiosk-off family with no exit button at
  // all once a containment lock had been used and released (measured in the browser).
  // The kiosk stays the authority for its own half — this never SHOWS a button it hid.
  const exitBtn = $('exit-btn');
  if (exitBtn) {
    let kiosk = false;
    try { kiosk = await exitLockOn(); } catch { kiosk = true; } // unreadable ⇒ stay hidden
    exitBtn.classList.toggle('hidden', chrome.hideExit || kiosk);
  }
  const chip = $('profile-chip');
  if (chip) chip.classList.toggle('hidden', chrome.hideChip || !activeProfileId);
  const home = $('folder-back');
  if (home) home.classList.toggle('hidden', chrome.hideHome);
  const inFolderLock = containState.active && containState.mode === 'folder';
  // ⚠️ The button needs NO new behaviour: its handler already tries `nav.back()` first,
  // which pops disc → collection, and `goGallery` (its fallback) resets to the LOCKED
  // folder under a lock. So showing it inside a subfolder is the whole fix, and it can
  // never reach outside the lock.
  // search reaches ANOTHER folder, so it goes away with the folder's own way out
  const search = $('search-open');
  if (search) search.classList.toggle('hidden', inFolderLock);
  // the WATCH screen's 🏠 goes straight to the gallery — under a folder lock that is an
  // escape from the folder. ⭐ and 🗑️ stay: neither leaves the folder.
  const watchHome = $('watch-home');
  if (watchHome) watchHome.classList.toggle('hidden', inFolderLock);
  // the approved-websites launcher is a whole second surface (refreshSitesLauncher
  // re-reads on every render, hence a re-assert here rather than a one-time toggle)
  const sites = $('sites-open');
  if (sites && chrome.hideSites) sites.classList.add('hidden');
  // v1.0.67 — the sites screen's own 🏠 goes back to the VIDEOS, so a websites lock closes
  // it exactly as a folder lock closes the watch screen's.
  const inSitesLock = containState.active && (containState.mode === 'sites' || containState.mode === 'site');
  const sitesBack = $('sites-back');
  if (sitesBack) sitesBack.classList.toggle('hidden', inSitesLock);
}

/**
 * Resolve the tapped padlock's target: { mode, fid, siteUrl } — or null when it cannot be
 * locked (a folder padlock with no folder), or { error:'site' } when a site padlock has no
 * describable page. Reads the module globals the caller stands on (folderId, the site
 * candidate), so it is not pure, but keeping it in ONE place means the engage and re-lock
 * paths can never compute the target differently.
 */
function computeLockTarget(scope) {
  const mode = ['folder', 'sites', 'site'].includes(scope) ? scope : 'app';
  const fid = mode === 'folder' ? folderId : null;
  if (mode === 'folder' && !fid) return null;
  // v1.0.67 — a SITE lock needs the page the child is on, and it must be describable as
  // rules: `rulesForLockedSite` answering [] would open a browser that blocks its own page,
  // so refusing to engage is the only safe direction.
  if (mode === 'site') {
    const siteUrl = lockCandidateSiteUrl;
    if (!siteUrl || !rulesForLockedSite(siteRulePayload(), siteUrl).length) return { error: 'site' };
    return { mode, fid: null, siteUrl };
  }
  return { mode, fid, siteUrl: null };
}

/** Open the "how long?" dialog for the tapped scope, or refuse with a toast. */
function engageLock(scope) {
  const t = computeLockTarget(scope);
  if (!t) return;
  if (t.error) { toast('אי אפשר לנעול על הדף הזה'); return; }
  askLockDuration(t.mode, t.fid, t.siteUrl).catch(() => {});
}

/**
 * The padlock tap.
 *
 * v1.0.76 — when a lock is ALREADY active, the code is followed by a CHOICE (pure
 * `relockChoice`): release it, or re-lock with a fresh duration. Before this the active
 * branch was release-only, so the "how long?" dialog appeared on the FIRST lock and never
 * again — a parent who had locked a site and wanted to lock the app (or just change the
 * timer) had no way to reach it (the reported bug). Re-lock uses the scope of the padlock
 * the parent tapped, and never asks for the code a second time — they just entered it.
 */
async function onLockTap(scope) {
  if (!activeProfileId) return;
  if (containState.active) {
    startPin((await hasPin()) ? 'verify' : 'setup', {
      title: 'קוד הורים',
      onSuccess: async () => {
        // LEAVE THE CODE SCREEN first (startPin's default onSuccess navigates by itself, so a
        // handler that only does work strands the parent on the keypad — v1.0.56), so the
        // choice modal renders over the child view, not the pad.
        if (nav.isActive('pin')) nav.back();
        const choice = relockChoice(await askKid({
          emoji: '🔒', title: 'כבר יש נעילה',
          text: 'לשחרר את הנעילה, או לנעול מחדש עם זמן חדש?',
          ok: 'שחרור הנעילה', third: 'נעילה מחדש', cancel: 'ביטול'
        }));
        if (choice === 'release') {
          await clearContainment();
          await refreshContainUi();
          toast('הנעילה שוחררה 🔓');
          renderHome();
        } else if (choice === 'relock') {
          engageLock(scope); // asks the duration again — the whole point of the fix
        }
        // 'none' (cancel / scrim): leave the lock exactly as it was
      }
    });
    return;
  }
  const titles = {
    folder: 'קוד הורים לנעילה על התיקיה', sites: 'קוד הורים לנעילה על אתרי האינטרנט',
    site: 'קוד הורים לנעילה על האתר', app: 'קוד הורים לנעילת האפליקציה'
  };
  const mode = ['folder', 'sites', 'site'].includes(scope) ? scope : 'app';
  // refuse early (folder with no fid / undescribable site) BEFORE the code, exactly as before
  const t = computeLockTarget(scope);
  if (!t) return;
  if (t.error) { toast('אי אפשר לנעול על הדף הזה'); return; }
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: titles[mode],
    onSuccess: () => { engageLock(scope); }
  });
}

let lockSetupCtx = null;

/**
 * "How long?" — asked EVERY time (the user's requirement), pre-filled with the last
 * answer, which is remembered per device. 0 is a real answer: until the parent unlocks.
 */
async function askLockDuration(mode, fid, siteUrl = null) {
  const last = normalizeLockMinutes(await prefGet(CONTAIN_LAST_MIN), 0);
  lockSetupCtx = { mode, folderId: fid, siteUrl, minutes: last };
  const title = { folder: 'נעילה על התיקיה', sites: 'נעילה על אתרי האינטרנט',
    site: 'נעילה על האתר', app: 'נעילת האפליקציה' }[mode];
  const f = mode === 'folder' ? (folders.find((x) => x.id === fid) || {}) : {};
  $('ls-title').textContent = 'לכמה זמן לנעול?';
  $('ls-sub').textContent = title
    + (mode === 'folder' && f.title ? ' — "' + f.title + '"' : '')
    + (mode === 'site' && siteUrl ? ' — ' + siteHostLabel(siteUrl) : '');
  $('ls-min').value = String(last);
  renderLockPresets();
  paintLockExplain();
  nav.go('locksetup');
}

const LOCK_PRESETS = [15, 30, 45, 60, 0];
function renderLockPresets() {
  const host = $('ls-presets');
  host.innerHTML = '';
  for (const m of LOCK_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ls-preset' + (lockSetupCtx && lockSetupCtx.minutes === m ? ' is-sel' : '');
    b.textContent = m === 0 ? 'עד שחרור' : m + ' דק׳';
    b.addEventListener('click', () => {
      if (!lockSetupCtx) return;
      lockSetupCtx.minutes = m;
      $('ls-min').value = String(m);
      renderLockPresets();
      paintLockExplain();
    });
    host.appendChild(b);
  }
}

function paintLockExplain() {
  if (!lockSetupCtx) return;
  const f = lockSetupCtx.mode === 'folder'
    ? (folders.find((x) => x.id === lockSetupCtx.folderId) || {}) : {};
  $('ls-explain').textContent = containConfirmText({
    mode: lockSetupCtx.mode, folderTitle: f.title || '', minutes: lockSetupCtx.minutes
  });
}

/** Engage the lock the dialog describes. */
async function commitLockSetup() {
  const ctx = lockSetupCtx;
  if (!ctx || !activeProfileId) return;
  const minutes = normalizeLockMinutes($('ls-min').value, ctx.minutes);
  const pid = activeProfileId;
  await prefSet(containModeKey(pid), ctx.mode);
  if (ctx.mode === 'folder') await prefSet(containFolderKey(pid), ctx.folderId);
  if (ctx.mode === 'site') await prefSet(containSiteKey(pid), ctx.siteUrl);
  await prefSet(containUntilKey(pid), String(minutes > 0 ? Date.now() + minutes * 60000 : 0));
  await prefSet(CONTAIN_LAST_MIN, String(minutes)); // remembered for next time
  lockSetupCtx = null;
  await applyContainment();
  // Land the child where the lock holds them.
  if (ctx.mode === 'folder') { folderId = ctx.folderId; nav.reset('folder'); await renderFolderView(); }
  else if (ctx.mode === 'sites') { nav.reset('sites'); renderSitesView(); }
  else if (ctx.mode === 'site') { nav.reset('sites'); renderSitesView(); await openLockedSite(ctx.siteUrl); }
  else { nav.reset('gallery'); renderHome(); }
  toast(minutes > 0 ? 'נעול ל-' + minutes + ' דקות 🔒' : 'נעול עד שחרור 🔒');
}

/**
 * The containment half of the 5s tick: expire a timed lock by itself, and RE-ASSERT the
 * pin (the hold-back+recents gesture unpins with no lifecycle event — the v1.0.55
 * measurement). Cheap: one Preferences read, and it does nothing when no lock is set.
 */
async function tickContainment() {
  try {
    const pid = activeProfileId;
    if (!pid) return;
    const c = await readContainment(pid);
    if (c.expired) {
      await clearContainment(pid);
      await refreshContainUi();
      toast('הנעילה הסתיימה 🔓');
      renderHome();
      return;
    }
    if (!c.active) return;
    containState = c;
    // a code screen stacked over the child's view still needs the pin re-asserted, but
    // the CHROME belongs to the view underneath — repaint only when it is on screen
    if (!nav.isActive('pin') && !nav.isActive('locksetup')) await refreshContainUi();
    if (containPinHeld) {
      const { lockTask } = await import('./platform.js');
      await lockTask();
    }
  } catch {}
}

/* ---------------- Interrupted by a call (v1.0.57) ---------------- */
//
// User request: a call comes in mid-video, the video pauses as it already does, and when
// the call ENDS it carries on by itself. User decision: CALLS ONLY — every other pause (the
// power button, HOME, the app switcher, the child's own tap) keeps the v1.0.32 behaviour,
// where the video waits paused and the child presses play.
//
// THE LIFECYCLE ALONE CANNOT TELL THESE APART, and on a modern Android an incoming call may
// not even background the app: it arrives as a heads-up notification, the WebView loses
// audio focus, and the media pauses itself with no `appStateChange` at all. So the signal is
// the DEVICE'S AUDIO MODE (`platform.audioMode` → AudioManager.getMode, no permission,
// catches VoIP), and the app watches for it on BOTH doors: the resume event, and a poll that
// only exists while a paused video is waiting on a call.
//
// The decision is pure (`playerlogic.planCallResume`); everything here is plumbing.
let callResume = null;   // { key, at } — the armed intent, one video, this session only
let callTicker = null;

function stopCallWatch() {
  if (callTicker) { clearInterval(callTicker); callTicker = null; }
}

/** Drop the intent AND its poll — one place, so a disarm can never leave the timer behind. */
function disarmCallResume() {
  callResume = null;
  stopCallWatch();
}

/**
 * One look at "is a call happening, and is this video waiting on it?".
 *
 * Runs on the app-resume event and, while armed, on its own short poll. Reading the audio
 * mode is an async bridge call, so the state is re-checked AFTER the await: the child can
 * leave, the video can be switched or a scheduled break can take the screen during it, and
 * acting on what was true before the await is how a video starts playing under a lock
 * screen. That is also why `resumeCurrent()`'s answer is honoured — a false means nothing
 * is mounted any more.
 */
async function checkCallResume() {
  const key = currentWatch && currentWatch.key;
  if (!callResume && !(nav.isActive('watch') && key)) return;
  const mode = await audioMode();
  const st = playbackState();
  const action = planCallResume({
    armed: callResume,
    mode,
    playing: !!(st && st.playing),
    // v1.0.72 — a call may resume only what a call stopped
    userPaused: !!(st && st.userPaused),
    inWatch: nav.isActive('watch'),
    key: currentWatch && currentWatch.key
  });
  if (action === 'arm') {
    callResume = { key, at: Date.now() };
    // the poll is what covers the call that never backgrounded the app
    if (!callTicker) callTicker = setInterval(() => { checkCallResume().catch(() => {}); }, CALL_RESUME_POLL_MS);
  } else if (action === 'resume') {
    // ONE SHOT, whether or not the player took it: a `false` means nothing is mounted any
    // more, and keeping the intent alive would aim it at whatever video mounts next.
    resumeCurrent();
    disarmCallResume();
  } else if (action === 'disarm') {
    disarmCallResume();
  }
}

/* ---------------- Idle screen-off (v1.0.34) ---------------- */
// After N minutes with no touch/remote key WHILE A VIDEO PLAYS: ask "עדיין צופים?",
// and if nobody answers — save the position, pause IN PLACE (never stop()), and let
// keep-awake go (the player heartbeat holds it only while playing). The DEVICE's own
// display timeout then turns the screen off; the app cannot and does not do that itself.
// Same on TV: remote keys count as input, and the pause lets the TV's own screensaver
// take over. The SETTING (`screenOffAfterMin`) is per-profile and synced — default ON at
// 10 minutes, explicit 0 = off; the live timer is in-memory, per device, per session.
// The pure decisions live in plan.screenOffMinutes / plan.evalIdleSleep.
let idleLastInputAt = Date.now();
let idlePromptAt = 0;
let idleTicker = null;
// v1.0.57: when the idle timer PARKED a video (nobody answered the prompt). A call must
// never un-park it — see the 'sleep' branch below and the call watcher above.
let idleParkedAt = 0;

function hideIdlePrompt() {
  idlePromptAt = 0;
  $('idle-prompt').classList.add('hidden');
}

/**
 * Every touch and every key lands here first (window CAPTURE listeners, registered in
 * init). While the prompt is up, the answering tap/key is CONSUMED — otherwise a TV
 * remote's OK would also toggle pause and ←/→ would seek ±10s, so "I'm here" would
 * scrub the very video the child is watching.
 *
 * THE WHOLE GESTURE IS CONSUMED, NOT JUST THE POINTERDOWN. Hiding the overlay on
 * pointerdown puts the tap-shield under the finger for the rest of the gesture, and the
 * shield's tap model acts on the END of a tap — so an answer tap paused the very video
 * it meant to keep playing (measured in the browser: prompt gone AND the clock frozen).
 * `idleSwallowGesture` therefore eats the matching pointerup/click; pointercancel clears
 * it too (Android steals gestures near the edges — the v1.0.22 pointercancel lesson —
 * and a stale flag would swallow the tail of the NEXT, innocent tap).
 */
let idleSwallowGesture = false;

function onUserInput(e) {
  const answeredPrompt = idlePromptAt > 0;
  idleLastInputAt = Date.now();
  idleParkedAt = 0; // v1.0.57: somebody IS here — the video is no longer app-parked
  if (!answeredPrompt) {
    if (e && e.type === 'pointerdown') idleSwallowGesture = false;
    return;
  }
  hideIdlePrompt();
  try { e.stopPropagation(); } catch {}
  if (e && e.type === 'pointerdown') idleSwallowGesture = true;
}

function swallowIdleGestureTail(e) {
  if (!idleSwallowGesture) return;
  try { e.stopPropagation(); } catch {}
  if (e && (e.type === 'click' || e.type === 'pointercancel')) idleSwallowGesture = false;
}

async function tickIdleSleep() {
  const pid = activeProfileId;
  if (!pid) return;
  // v1.0.63 — SUSPENDED WHILE PLAYING IN THE BACKGROUND (the user's decision). "עדיין
  // צופים?" exists for a child who fell asleep in front of a screen; with the screen off
  // and a parent's setting saying "keep playing", nobody is meant to be looking, and there
  // is nothing to show a prompt on. The counter is held at NOW rather than paused, so the
  // full window starts again the moment the app comes back to the foreground.
  if (bgPlayLive && document.hidden) { idleLastInputAt = Date.now(); idlePromptAt = 0; return; }
  const afterMin = screenOffMinutes(
    await getSetting(pid, 'screenOffAfterMin', null), SCREEN_OFF_DEFAULT_MIN);
  const st = playbackState();
  // v1.0.45 — a browsing session counts as "in use" too, or the idle timer is simply off
  // for the whole time a child sits in a website. The viewer reports activity through the
  // `webActivity` event, since its taps never reach this window's capture listeners.
  const phase = evalIdleSleep({
    lastInputAt: idleLastInputAt, promptAt: idlePromptAt, afterMin,
    playing: !!(st && st.playing) || siteViewerOpen, promptSec: SCREEN_OFF_PROMPT_SEC
  });
  if (phase === 'prompt') {
    // The "עדיין צופים?" overlay lives inside #player-wrap, i.e. UNDER the native site
    // view — asking a question nobody can see would just be a silent countdown. For a
    // site we skip straight to closing it: after this long with no touch at all the child
    // is not there, and back in the app the usual timers and the device's own display
    // timeout take over.
    if (siteViewerOpen) {
      await closeSiteViewer();
      siteViewerOpen = false;
      idleLastInputAt = Date.now();
      return;
    }
    if (!idlePromptAt) { idlePromptAt = Date.now(); $('idle-prompt').classList.remove('hidden'); }
    return;
  }
  if (phase === 'sleep') {
    // The v1.0.32 screen-off order, load-bearing: save FIRST (it reads the live
    // playhead), THEN pause. The player stays mounted at its spot — when the screen
    // comes back the child finds the video waiting, paused, exactly where it stopped.
    saveWatchPosition(currentWatch);
    pauseCurrent();
    // v1.0.57: THE APP parked this video because nobody answered "עדיין צופים?" — so a call
    // that happens to start and end afterwards must not un-park it. Without this flag the
    // call watcher would see a paused video during a call, arm, and start it again into the
    // empty room this feature exists to protect. Cleared by any real input (onUserInput).
    idleParkedAt = Date.now();
    hideIdlePrompt();
    return;
  }
  // 'off'/'counting' with a stale prompt: something else paused or stopped the video —
  // the question no longer applies.
  if (idlePromptAt) hideIdlePrompt();
}

function startIdleTicker() {
  if (idleTicker) return;
  idleTicker = setInterval(() => { tickIdleSleep().catch(() => {}); }, 5000);
}

/**
 * v1.0.25 — THE HOLE A PER-PROFILE LOCK OPENS, closed in the same release.
 *
 * The lock contains HOME, recents and back, and hides the exit button — but the profile
 * chip was never protected: `$('profile-chip')` went straight to `backToProfiles`. Once
 * the lock belongs to a profile rather than the device, a child on a locked profile could
 * tap their own avatar, pick a sibling whose profile is NOT locked, and walk out. Two
 * taps, and the lock becomes decoration.
 *
 * The chip stays VISIBLE on purpose — it is also how the child sees whose library they are
 * in — but leaving the locked profile is now the protected act, like the exit itself.
 */
async function onProfileChip() {
  // v1.0.28 (parent's decision): switching profiles MID-SESSION always asks for the
  // code — not only when the active profile is exit-locked. A child hopping to a
  // sibling's profile changes whose library, whose gift progress and whose settings
  // are in effect; that is a parental act. The BOOT picker stays free (same decision):
  // it is how each child enters their own profile, and a code at every app start would
  // mean the parent types it every morning.
  // Still fails CLOSED: a throw leaves the child where they are (v1.0.25 rule — the
  // pre-v1.0.28 unlocked branch called backToProfiles() directly, which was the escape
  // the per-profile lock had to close; now there is no unlocked branch at all).
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: 'קוד הורים להחלפת פרופיל',
    onSuccess: backToProfiles
  });
}

/**
 * Name the child that the per-profile toggles belong to. A settings screen that says
 * "נעילת יציאה" with no owner reads as a device switch, which is exactly what it used
 * to be — a parent would flip it for one child and expect it everywhere.
 */
async function labelProfileSettings() {
  const p = await getActiveProfile();
  const who = p ? ` — ${p.name}` : '';
  for (const id of ['exit-lock-owner', 'share-approval-owner', 'autoplay-owner', 'resume-owner', 'bgplay-owner', 'sched-lock-owner', 'screen-off-owner', 'keep-newest-owner', 'recent-limit-owner']) {
    const el = $(id);
    if (el) el.textContent = who;
  }
}

async function askExit() {
  const leave = await confirmKid({
    emoji: '👋', title: 'לצאת מהאפליקציה?', text: 'תמיד אפשר לחזור!',
    ok: 'צא', cancel: 'השאר', danger: true
  });
  if (!leave) return;
  // v1.0.32: on the BOOT picker no profile is active yet, but the kiosk was armed from
  // the LAST ACTIVE one (the launch rule) — the lock check must read the same answer,
  // or the picker's exit button walks straight through an armed lock.
  if (await exitLockOn(activeProfileId || await prefGet('activeProfile'))) {
    // the exit itself is the protected resource — PIN before unpinning (the shared
    // pinGatedExit ceremony; the break screen's door uses the same one, v1.0.55)
    await pinGatedExit();
    return;
  }
  exitApp();
}

/* ---------------- Attention (v1.0.4): dots for the parent ---------------- */
/**
 * How many records are waiting for a parental decision, across BOTH of the profile's
 * scopes (the shared library and the personal one). `limit: 1` because only `total`
 * is read — this runs on every home render and again on every parent-screen entry.
 */
/**
 * The shared library scope, safe to call before the first home render.
 *
 * `libScope` is published by buildFolders, i.e. only once a home render has completed.
 * Anything that asks earlier (the gate tapped while the profile is still activating, or a
 * share arriving on a cold start) would otherwise read null and quietly answer "nothing
 * here" about a library that is full. Falling back to the stored value costs one read,
 * and only in that window.
 */
async function currentLibScope() {
  if (libScope) return libScope;
  if (!activeProfileId) return null;
  try { return (await db.getSources(activeProfileId) || {}).libraryId || null; } catch { return null; }
}

async function pendingTotal() {
  let pending = 0;
  const lib = await currentLibScope();
  const scopes = [lib, activeProfileId ? db.profScope(activeProfileId) : null].filter(Boolean);
  for (const s of scopes) pending += (await db.pagePending(s, { limit: 1 })).total;
  return pending;
}

/** attention = pending approvals waiting OR an update ready to install. */
async function computeAttention() {
  let pending = 0;
  try { pending = await pendingTotal(); } catch {}
  let updateReady = false;
  try {
    const upd = await import('./update.js');
    const local = await upd.currentVersion(); // null in the browser preview
    if (local) {
      const latest = JSON.parse((await prefGet('update.latest')) || 'null');
      updateReady = !!(latest && upd.isNewer(latest.version, local));
    }
  } catch {}
  return { pending, updateReady };
}

/**
 * v1.0.7: fresh-on-home — fired on every gallery entry, never blocking the render.
 * Content sync self-throttles (shouldSync, 3 min); the update check self-throttles
 * (6h) and the prompt fires at most once per session. v1.0.21: the first pass of each
 * LAUNCH bypasses both throttles — see below.
 */
let launchSyncDone = false; // the forced launch refresh happens once per process
let entryRefreshInFlight = null; // activateProfile awaits this to own the loading screen
function homeEntryRefresh() {
  if (!activeProfileId) return;
  // v1.0.21: the FIRST refresh of a launch is forced. The 3-min throttle exists so a
  // child flipping between home and a video doesn't resync every few seconds — but it
  // also meant reopening the app minutes after the parent edited the sheet showed stale
  // content until something else happened to trip a sync. One forced pass per launch is
  // the fix; every later home entry keeps the throttle.
  const plan = planEntryRefresh({ launchDone: launchSyncDone, sinceLastPullMs: Date.now() - lastPullAt });
  launchSyncDone = true;
  entryRefreshInFlight = entryRefresh(activeProfileId, plan).catch(() => {});
  // …and so is the version check: the 6h throttle could hide a release for a whole day
  // of launches. `silent` still honors update.skip, so a version the parent declined
  // does not nag again — only the red dot stays lit.
  import('./update.js')
    .then((u) => u.checkForUpdate({ silent: true, force: plan.forceSync }))
    .then((r) => maybePromptUpdate(r))
    .catch(() => {});
}

/**
 * v1.0.25 — THE one place that refreshes the home, and it runs PULL THEN SYNC, in series.
 *
 * Both write the same video records, so interleaving them lets one clobber the other's
 * merge — CLAUDE.md has said so since v1.0.22. It was not true on launch: `nav.reset
 * ('gallery')` fires the gallery's onEnter SYNCHRONOUSLY, so the forced launch sync was
 * already running by the time `activateProfile` reached its own `pullThenSync` on the next
 * line, and the two raced on every single launch of every device with backup enabled.
 *
 * There is now exactly one caller (the gallery's onEnter) and one promise; activation
 * awaits that promise for its loading screen instead of starting a second pipeline.
 */
/**
 * Draw whatever the family's shared state just landed UNDER — not only the home.
 *
 * A pull lands wherever the parent happens to be standing, and the parent screen is
 * exactly where they go to check that what they added on the other device arrived. Both
 * branches of entryRefresh used to re-render the gallery alone, so every parent surface
 * kept showing pre-pull data and the parent pressed "רענון" to reveal rows that were
 * ALREADY in the database. Field-reported for approved websites; the pending queue, the
 * channel list and the library list had the same hole.
 *
 * ⚠️ The parent branch refreshes the LISTS ONLY — never `refreshParent()`. That one also
 * clears the status lines, re-applies the tab and re-runs the update check, so a silent
 * background pull would wipe a message the parent is still reading and could yank them
 * out of the tab they are working in. `refreshSitesPanel` carries the launcher with it.
 *
 * The folder view is deliberately NOT re-rendered: a child mid-browse would have the grid
 * redrawn under their thumb, and the folder's own onEnter already refreshes on the way in.
 */
async function renderAfterRemoteChange() {
  if (nav.isActive('gallery') || nav.isActive('loading')) { await renderHome(); return; }
  if (!nav.isActive('parent')) return;
  await Promise.all([
    refreshParentList(), refreshPendingList(), refreshChannelsList(), refreshSitesPanel(), refreshFoldersList()
  ]);
  await refreshGateDot();
}

async function entryRefresh(id, { pull = true, forceSync = false } = {}) {
  if (pull && await maybePullDrive()) {
    if (activeProfileId !== id) return; // switched profile under us — that render owns it
    await loadGiftStates();
    await renderAfterRemoteChange();
  }
  if (activeProfileId !== id) return;
  // v1.0.38 — THE SHEET SUNSET, between the pull and the sync, AWAITED. Between, because a
  // launch; before the sync, because the fold writes libraryChannels rows and video records
  // that the launch's forced pass then enriches (RSS, titles, gifts). Serialized for the
  // pullThenSync reason: all three write the same records, and a detached .then() here would
  // be the v1.0.25 race re-introduced. Silent and best-effort — it covers EVERY profile, not
  // just this one, so a child nobody opens on this device is not left behind.
  if (activeProfileId !== id) return;
  // v1.0.56 — Drive-backed folders pick up files the parent added there since. Before the
  // library sync and AWAITED, for the same reason the sunset was: it writes video records
  // that the sync then enriches and gifts, and a detached .then() here is the v1.0.25 race.
  // Silent and self-throttled; a failed listing changes nothing.
  // the SCOPE is resolved, never read off the bare global: `libScope` is published by
  // buildFolders (i.e. only after a home render), and this runs concurrently with that
  // render — the v1.0.25 rule the channel-approval paths already follow. A null scope
  // here would silently skip every Drive-backed folder on the first entry of a launch.
  if (await refreshDriveFolders(await currentLibScope())) {
    if (activeProfileId !== id) return;
    await renderAfterRemoteChange();
  }
  if (activeProfileId !== id) return;
  // v1.0.58 — housekeeping, AFTER the pull and the Drive refresh and never before them: both
  // of those ADD content, and a sweep that ran first would judge a folder empty a second
  // before its videos arrived, or delete a file a peer's record was about to claim. Both are
  // silent, best-effort and self-throttled; neither ever blocks the child's screen.
  await sweepEmptyFolders().catch(() => {});
  await sweepDownloadCache().catch(() => {});
  if (activeProfileId !== id) return;
  if (!forceSync && !(await shouldSync(id))) return;
  await syncLibrary(id, { force: forceSync, onProgress: (p) => loading.progress(p) });
  if (activeProfileId !== id) return;
  await absorbMineIntoShared(id); // the first sync may have just created sources
  await loadGiftStates();
  await renderAfterRemoteChange();
  maybeSchedulePush();
}

/**
 * v1.0.58 — "למחוק גם מזיכרון המכשיר?" (user request), asked ONCE and only when there is
 * something to ask about (their decision 2026-08-30).
 *
 * A video is downloaded only when STREAMING it failed, so most deletions have no local copy
 * and must raise NO dialog at all; and a 40-video rejection must raise one question, not
 * forty. `plan.deleteLocalChoice` decides both, and the caller passes the records it is
 * about to delete.
 *
 * Returns 'device' | 'app' | 'cancel'. GOOGLE DRIVE IS NEVER TOUCHED and the text says so:
 * this is the tablet's own copy, in the app's private storage, which no file manager can
 * see — which is also why "app only" is the secondary answer and not the default.
 */
async function askDeleteLocalCopies(records) {
  const local = (records || []).filter((r) => r && r.localPath);
  if (!local.length) return 'app';
  let bytes = 0;
  try {
    const { listCacheFiles, cacheBaseName } = await import('./media.js');
    const sizes = new Map((await listCacheFiles()).map((f) => [f.name, Number(f.size) || 0]));
    for (const r of local) bytes += sizes.get(cacheBaseName(r)) || 0;
  } catch {}
  const q = deleteLocalChoice({ total: (records || []).length, local: local.length, bytes });
  if (!q.ask) return 'app';
  const answer = await askKid({
    emoji: '🧹', title: 'למחוק גם מהמכשיר?', text: q.text,
    ok: 'כן, גם מזיכרון המכשיר', third: 'רק מהאפליקציה', cancel: 'ביטול'
  });
  if (answer === 'cancel' || answer === 'dismiss') return 'cancel';
  return answer === 'third' ? 'app' : 'device';
}

/** Perform the answer above. 'app' leaves the file, which the daily sweep collects as an
 *  orphan — so nothing is ever stranded on the tablet forever either way. */
async function applyDeleteLocalCopies(records, choice) {
  if (choice !== 'device') return { deleted: 0, bytes: 0 };
  try {
    const { deleteLocalFiles } = await import('./media.js');
    return await deleteLocalFiles(records);
  } catch { return { deleted: 0, bytes: 0 }; }
}

/**
 * v1.0.58 — AN EMPTY FOLDER IS DELETED, not merely hidden (user request).
 *
 * v1.0.56 chose to keep the row and hide the tile so the parent could still rename it and
 * file videos into it; the user has now asked for the opposite, so the row goes. Deletion
 * writes the ordinary `cfDel:` tombstone, which is what makes it stick on every device
 * instead of a peer re-adding the row on its next push.
 *
 * The two exemptions live in pure `plan.planEmptyFolderSweep`: a DRIVE ROOT anchor (empty by
 * design — it is what the refresh walks) and a folder created minutes ago (the destination
 * picker creates the row before the add finishes).
 *
 * Runs after the pull and the Drive refresh, never before: judging a folder empty a moment
 * before its videos arrive would delete a folder full of songs, on every device.
 */
async function sweepEmptyFolders() {
  const scope = await currentLibScope();
  if (!scope) return 0;
  const rows = await db.listCustomFolders(scope);
  if (!rows.length) return 0;
  const counts = new Map();
  for (const cf of rows) counts.set(cf.folderId, await db.countFolder(scope, cf.folderId));
  // ⚠️ REVIEW FIX — A FOLDER HOLDING ONLY PARKED VIDEOS IS NOT EMPTY. `countFolder` ranges
  // `by_folder_sort`, and a video waiting for approval (or sitting in the rejected archive)
  // carries `folderId: '~pending'|'~rejected'` with the REAL folder in `homeFolderId` — so
  // it counts as zero. The parent can put one there deliberately: moveVideoToFolder writes
  // `homeFolderId` for exactly these records. Deleting the folder then leaves the video
  // filed under a folder that no longer exists the moment it is approved — invisible on
  // every screen and unreachable forever, which is the failure deleteCustomFolderFlow's
  // own comment exists to prevent.
  // ⚠️ BOTH readers answer `{ items, total }`. Spreading the OBJECT throws "not iterable"
  // AFTER the promise's .catch has had its chance, so the throw escaped to the caller's
  // `.catch(() => {})` and the whole sweep silently did nothing — measured in the browser,
  // suite green (no node test executes app.js).
  const pending = await db.pagePending(scope, { offset: 0, limit: 5000 }).catch(() => ({ items: [] }));
  const rejected = await db.pageRejected(scope, { limit: 5000 }).catch(() => ({ items: [] }));
  const parked = [...(pending.items || []), ...(rejected.items || [])];
  for (const rec of parked) {
    const home = rec && rec.homeFolderId;
    if (home && counts.has(home)) counts.set(home, (counts.get(home) || 0) + 1);
  }
  const gone = planEmptyFolderSweep({ folders: rows, counts });
  for (const folderId of gone) await db.deleteCustomFolder(scope, folderId);
  if (gone.length) maybeSchedulePush();
  return gone.length;
}

/** REVIEW FIX (v1.0.58): the cache file a record actually owns, read off the path that was
 *  written at download time. Re-deriving it from the record drifts the moment `media` is
 *  corrected at playback, and a drifted name makes a live file look like an orphan. */
const localCacheName = (rec) => String((rec && rec.localPath) || '').split('/').pop();

/**
 * v1.0.58 — THE DOWNLOADED-FILE CACHE PRUNES ITSELF (user request: the tablet must not fill
 * up). Per file, by last play, because a blanket monthly wipe deletes the song the child
 * plays daily and the tablet re-downloads it on mobile data (the user's decision).
 *
 * The DECISION is pure (`plan.planCacheSweep`) and this only performs it — the db.js split.
 * Two things it frees that nothing else can: files whose record is gone (every deletion
 * before this version leaked one), and files nobody has played for a month.
 *
 * Throttled to daily through `meta`, so it costs one directory listing a day at most.
 */
async function sweepDownloadCache() {
  const { listCacheFiles, deleteCacheFiles, cacheBaseName } = await import('./media.js');
  const lastAt = Number(await db.getMeta('cacheSweptAt')) || 0;
  if (Date.now() - lastAt < CACHE_SWEEP_EVERY_MS) return 0;
  const files = await listCacheFiles();
  if (!files.length) { await db.putMeta('cacheSweptAt', Date.now()); return 0; }
  // own the files by RECORD, across every scope this device holds: the cache is per device
  // and one file can be referenced by a record in the shared library or in a personal scope
  const owned = new Map();
  const stampable = new Map();
  const idb = await db.openDb();
  await new Promise((resolve) => {
    const req = idb.transaction('videos').objectStore('videos').openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const rec = cur.value;
      if (rec && rec.localPath) {
        // ⚠️ REVIEW FIX — THE NAME COMES FROM `localPath`, THE PATH ACTUALLY WRITTEN, never
        // from re-deriving it. `cacheExtFor` picks the extension from `media`, and v1.0.56
        // CORRECTS `media` at loadedmetadata (a Drive file with no extension in its URL
        // starts null and becomes 'audio') — so a re-derived name flips .mp4 → .mp3 after
        // the first play, the real file stops matching any record, and the sweep deletes a
        // perfectly good cached file as an "orphan".
        const name = localCacheName(rec);
        owned.set(name, { usedAt: Number(rec.localUsedAt) || 0 });
        stampable.set(name, rec);
      }
      cur.continue();
    };
    req.onerror = () => resolve();
  });
  const plan = planCacheSweep({ files, owned });
  // A file downloaded before v1.0.58 carries NO use stamp. It is given a full window rather
  // than deleted on sight — reading "no stamp" as "never used" would wipe the whole cache
  // the first time this ran, which is the blanket behaviour the user's decision rejected.
  for (const name of plan.stampMissing) {
    const rec = stampable.get(name);
    if (rec) await db.setVideoFields(rec.scopeId, rec.key, { localUsedAt: Date.now() }).catch(() => {});
  }
  const removed = await deleteCacheFiles(plan.delete);
  // a record whose file we just expired must forget it, or every play stats a dead path
  for (const name of plan.delete) {
    const rec = stampable.get(name);
    if (rec) await db.setVideoFields(rec.scopeId, rec.key, { localPath: null, localUsedAt: null }).catch(() => {});
  }
  await db.putMeta('cacheSweptAt', Date.now());
  return removed;
}

/**
 * v1.0.21 — run after ANY content the parent just added (a share, a manual link, an
 * approval). A freshly written record is INERT until a sync touches it:
 *  - `srcChannelId` is filled only by the sync's enrichment stage, and that field is
 *    what `groupSinglesByChannel` folds a single into its 🎞️ collection / 📺 channel
 *    folder by — so without it the video sits in the loose "סרטונים נוספים" list;
 *  - `giftRank` is assigned only by `planProfileGifts`, so the video is not a 🎁 either.
 * Both used to appear only after the parent happened to press "רענון נתונים" (field bug).
 * Silent and non-blocking BY DEFAULT: the child may be looking at a populated grid, and
 * covering it with the loading screen is the worse bug (v1.0.18).
 *
 * v1.0.26 — `wait: true` RETURNS the promise instead, for the one context where the
 * opposite is true: the parent is standing in front of the screen having just answered
 * "what should I do with this catalogue?", and this is a SECOND full library sync that can
 * run for minutes. Silence there was read as "it finished" or "it is stuck" — the field
 * report this option exists for. The default is untouched precisely because the v1.0.18
 * reasoning still holds everywhere else; only the caller that owns a waiting screen may
 * ask to wait.
 */
function refreshAfterAdd({ parent = false, wait = false } = {}) {
  if (!activeProfileId) return wait ? Promise.resolve() : undefined;
  // NEVER while a video plays: a forced sync also bypasses the 30-min per-channel RSS
  // throttle, so this is a full sweep of every channel plus a whole-library re-plan —
  // on a low-end tablet, under a playing video. The gallery/parent screens are the only
  // safe places, and the next home entry re-runs it anyway.
  if (nav.isActive('watch')) return wait ? Promise.resolve() : undefined;
  // `onProgress` is passed ONLY when a caller is waiting: it fans out to a loading screen
  // that does not exist otherwise, and sync2 skips the work of building labels nobody reads.
  const run = syncLibrary(activeProfileId, {
    force: true,
    ...(wait ? { onProgress: (p) => loading.progress(p) } : {})
  }).then(async () => {
    await loadGiftStates();
    if (nav.isActive('gallery')) renderHome();
    if (parent && nav.isActive('parent')) {
      await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]).catch(() => {});
    }
    refreshGateDot();
  }).catch(() => {});
  return wait ? run : undefined;
}

/**
 * The dot on the 🔒 gate button — the parent's cue to come look.
 *
 * v1.0.24: its COLOUR names the errand (pure `plan.attentionDot`). Blue = content is
 * waiting for a decision, and crossing the PIN lands straight on ממתינים; red = an app
 * update. The two used to share one red dot, so the routine errand (a manual-approval
 * channel published something the child cannot see yet) was indistinguishable from the
 * rare one — and a signal that means two things gets learned as meaning nothing.
 */
async function refreshGateDot() {
  try {
    const kind = attentionDot(await computeAttention());
    const dot = $('gate-dot');
    dot.classList.toggle('hidden', !kind);
    dot.classList.toggle('attn-dot-info', kind === 'info');
  } catch {}
}

/**
 * v1.0.26 — the pending-reset banner on the child's home.
 *
 * THIS BANNER IS THE SAFEGUARD, not decoration: the 24-hour wait only protects the parent
 * if they learn that somebody asked. It therefore lives on the screen that is on all day,
 * not behind the PIN — a notice only the requester can see would protect nobody.
 *
 * Shown for 'waiting' AND for 'ready': a request that has matured is exactly when the
 * parent most needs to know, and hiding it then would turn the countdown into a trap that
 * goes quiet just before it opens.
 */
async function refreshRecoveryBanner() {
  const box = $('recovery-banner');
  try {
    const { recoveryState } = await import('./recovery.js');
    const { pinRecoveryLabel } = await import('./plan.js');
    const st = await recoveryState();
    if (st.state === 'none') { box.classList.add('hidden'); return; }
    $('recovery-banner-text').textContent = st.state === 'ready'
      ? '🔓 התבקש איפוס של קוד ההורים, וניתן לבצע אותו עכשיו'
      : '⏳ ' + pinRecoveryLabel(st);
    box.classList.remove('hidden');
  } catch { box.classList.add('hidden'); }
}

/* ---------------- Launch update prompt (v1.0.4) ---------------- */
/**
 * The deferred launch check now ASKS instead of staying silent. Declining snoozes
 * THIS version's prompt (update.skip) — the red dot and the parent screen keep
 * offering it; a newer release prompts again.
 */
let updatePromptedThisSession = false; // the ask fires at most once per launch

async function maybePromptUpdate(r) {
  if (!r || r.status !== 'available' || !r.latest) return;
  if (updatePromptedThisSession) return;
  // Never interrupt watching / PIN / parent work / first-launch connect — the red
  // dot still shows, and the next home entry or launch re-offers.
  if (nav.isActive('watch') || nav.isActive('pin') || nav.isActive('parent')
    || nav.isActive('connect') || nav.isActive('loading') || nav.isActive('tour')
    || isModalOpen()) return;
  updatePromptedThisSession = true;
  const answer = await askKid({
    emoji: '🚀', title: 'יש גירסה חדשה!',
    text: `גירסה ${r.latest.version} מוכנה להתקנה (במקום ${r.local}). לעדכן עכשיו?`,
    ok: 'עדכון עכשיו', cancel: 'לא עכשיו'
  });
  if (answer !== 'ok') {
    // Only the EXPLICIT "לא עכשיו" snoozes this version. A scrim tap / hardware
    // back (e.g. the child poking the screen) just closes the dialog — it comes
    // back on the next home entry. Real bug found in the field: an accidental
    // dismiss silently wrote update.skip and the parent never saw the offer again.
    if (answer === 'cancel') {
      await prefSet('update.skip', r.latest.version);
      refreshGateDot();
    } else {
      updatePromptedThisSession = false; // dismissed, not answered — re-offer
    }
    return;
  }
  // v1.0.7 (user request): installing requires the parent PIN — a child tapping
  // "עדכון עכשיו" can't launch the installer alone.
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: 'קוד הורים לעדכון הגירסה',
    onSuccess: async () => {
      if (!nav.back()) nav.reset(activeProfileId ? 'gallery' : 'profiles');
      await runUpdateInstall(r.latest);
    }
  });
}

/**
 * What's-new screen (v1.0.8 → rewritten v1.0.13). A real SCROLLING view, not the
 * modal: notes can span several versions, so the list scrolls while the button
 * stays reachable. Hebrew parent-facing lines only (update.extractReleaseNotes
 * strips GitHub's PR titles/handles/links). Resolves true = proceed to install.
 * Back / "לא עכשיו" cancel the update (user decision).
 */
let wnResolve = null;

function renderWhatsNew({ versions, moreCount }, { installMode }) {
  $('wn-title').textContent = installMode ? 'מה חדש בעדכון' : 'מה חדש בגירסה';
  const body = $('wn-body');
  body.innerHTML = '';
  for (const v of versions) {
    const h = document.createElement('div');
    h.className = 'wn-ver';
    h.textContent = 'גירסה ' + v.version;
    body.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'wn-list';
    const lines = v.lines && v.lines.length ? v.lines : ['שיפורים ותיקונים כלליים'];
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  if (moreCount > 0) {
    const p = document.createElement('p');
    p.className = 'wn-more';
    p.textContent = `ועוד ${moreCount} גרסאות קודמות`;
    body.appendChild(p);
  }
  $('wn-ok').textContent = installMode ? 'עדכון עכשיו' : 'סגירה';
  $('wn-cancel').classList.toggle('hidden', !installMode);
  body.scrollTop = 0;
}

/** installMode=true → resolves true only if the parent pressed "עדכון עכשיו". */
function showWhatsNew(data, { installMode = true } = {}) {
  const versions = (data && data.versions) || [];
  if (installMode && !versions.length) return Promise.resolve(true); // nothing to show — don't block the update
  renderWhatsNew({ versions, moreCount: (data && data.moreCount) || 0 }, { installMode });
  return new Promise((resolve) => {
    wnResolve = resolve;
    nav.go('whatsnew');
  });
}

/** Resolve the screen exactly once (button OR hardware back). */
function closeWhatsNew(proceed) {
  const f = wnResolve;
  wnResolve = null;
  if (f) f(proceed);
}

/** Download + hand off to the Android installer, with the loading screen as progress. */
async function runUpdateInstall(latest) {
  // v1.0.13: the what's-new screen is the last gate — back / "לא עכשיו" aborts
  const proceed = await showWhatsNew(latest && latest.whatsNew, { installMode: true });
  if (!proceed) { if (!nav.back()) goGallery(); return; }
  if (nav.isActive('whatsnew') && !nav.back()) goGallery();
  const upd = await import('./update.js');
  loading.show({ defer: 0, step: 'מורידים את העדכון…' });
  let res = null;
  try {
    res = await upd.downloadAndInstall(latest, {
      onProgress: (done, total) => {
        if (total) loading.setStep(`מורידים את העדכון… ${Math.round((done / total) * 100)}%`);
      }
    });
  } finally {
    await loading.hide();
  }
  if (!res || !res.ok) {
    await alertKid({
      emoji: '😕', title: 'העדכון לא הצליח',
      text: res && res.error === 'truncated' ? 'ההורדה לא הושלמה — נסו שוב מאוחר יותר.'
        : res && res.error === 'installed-app-only' ? 'עדכון זמין באפליקציה המותקנת בלבד.'
        : 'אפשר לנסות שוב דרך מסך ההורים ← הגדרות.',
      ok: 'בסדר'
    });
  }
}

function registerViews() {
  // Back precedence per view. Returning true = consumed; otherwise nav pops.
  nav.register('connect', { onBack: () => { askExit(); return true; } });
  // tour back = previous slide (or skip on the first one) — never exits the app
  nav.register('tour', {
    onBack: () => {
      if (backAction(tourIdx) === 'prev') tourStep(-1); else finishTour();
      return true;
    }
  });
  // v1.0.38: the sheet-setup wizard is GONE with the sheet itself — a new profile goes
  // straight to activateProfile, and there is no way to attach a sources sheet anywhere.
  // v1.0.13: back on the what's-new screen CANCELS the update (user decision)
  nav.register('whatsnew', { onLeave: () => closeWhatsNew(false) });
  // v1.0.23 — leaving the picker ANY way (back, hardware back, a later navigation) must
  // resolve its promise, or the caller awaits forever and the add flow never finishes.
  nav.register('pick', { onLeave: () => { const h = pickHandlers; pickHandlers = null; if (h) h.cancel(); } });
  nav.register('profiles', {
    // v1.0.23: while this screen is choosing a share's destination, back means "no
    // decision" — resolve the chooser instead of asking whether to exit the app.
    onBack: () => {
      if (shareProfileCancel) { const c = shareProfileCancel; shareProfileCancel = null; c(); nav.back(); return true; }
      askExit();
      return true;
    },
    onLeave: () => { const c = shareProfileCancel; shareProfileCancel = null; if (c) c(); }
  });
  nav.register('create-profile', {
    onBack: () => {
      if (profiles.length > 0) { renderProfiles(); nav.reset('profiles'); }
      return true; // no profiles yet → swallow (nowhere to go back to)
    }
  });
  nav.register('gallery', {
    // v1.0.56: under containment the child may not leave the app at all — askExit is the
    // door, so it must not even be offered (the exit BUTTON is hidden by the same rule).
    onBack: () => { if (!containState.active) askExit(); return true; },
    // Re-render on EVERY return home: after unwrapping gifts the "חדשים" folder must
    // update immediately — and disappear entirely when the last gift was opened
    // (home then falls back to the flat video grid).
    // v1.0.7: every home entry also refreshes content (3-min throttle in shouldSync)
    // and re-offers a pending update (6h check throttle; asked once per session).
    onEnter: () => { renderHome(); homeEntryRefresh(); }
  });
  // v1.0.32: onEnter fires on BACK-restores too (nav.transition), so returning from a
  // video re-renders the page the child left — the tile they just watched must show its
  // fresh progress bar, exactly like the home view's own onEnter re-render. Same page,
  // same scroll (nav restores it after the double-rAF).
  nav.register('folder', {
    // v1.0.61 — THE ENTRY'S OWN params ARE THE AUTHORITY, not the module global. With
    // folders nesting, `folder` sits on the stack more than once (collection → disc), and
    // popping back to the collection must re-render the COLLECTION: the global still holds
    // the disc the child just left, so an onEnter that trusted it would paint the wrong
    // grid under the right header. `folderPage` rides the entry's own state for the same
    // reason — the collection's page must survive a trip into a disc and back.
    onEnter: (entry) => {
      const p = (entry && entry.params) || {};
      if (p.folderId) { folderId = p.folderId; folderPage = Number(p.page) || 0; }
      if (folderId) renderFolderView().catch(() => {});
      refreshContainUi().catch(() => {});
    },
    // v1.0.56 — under a FOLDER lock the child may not leave this folder. Swallowing
    // back here is the other half of hiding the 🏠 button: without it the hardware
    // back (and the Escape stand-in) walks straight out to the gallery.
    // v1.0.61 — a lock now covers a SUBTREE, so back is swallowed only at the lock's own
    // folder: inside it the child must be able to walk back up to the disc list.
    onBack: () => (containState.active && containState.mode === 'folder'
      && !!containState.folderId && containState.folderId === folderId)
  });
  nav.register('search', {}); // default pop → home; watch pushed on top returns here
  // v1.0.56 — the destination picker. Leaving it by ANY route (hardware back, the cancel
  // button, a navigation from somewhere else) must resolve the awaiting add, or the caller
  // hangs forever holding a half-finished add — the chooseShareProfile lesson (v1.0.23).
  nav.register('folderpick', {
    // EVERY exit settles the awaiting add exactly once (the chooseShareProfile lesson: a
    // caller left holding a half-finished add hangs forever). v1.0.58: the art-editor mode
    // has nothing to resolve, but its own state must not survive the view either.
    onLeave: () => {
      fpArtEditing = null;
      const h = folderPickHandlers; folderPickHandlers = null; if (h) h.cancel();
    }
  });
  // v1.0.56 — the lock-duration dialog. Leaving it by ANY route abandons the pending
  // lock; nothing is written until the parent confirms.
  nav.register('locksetup', { onLeave: () => { lockSetupCtx = null; } });
  // v1.0.45: the websites grid re-renders on entry so a site removed in the parent screen
  // (or arriving from another device) is gone the moment the child comes back to it.
  nav.register('sites', {
    onEnter: () => { renderSitesView(); },
    // v1.0.67 — swallow hardware back while the child is locked to this screen (or to a
    // site whose viewer they just left through the app's own path), the same half of the
    // folder lock that hiding 🏠 cannot cover.
    onBack: () => containState.active && (containState.mode === 'sites' || containState.mode === 'site')
  });
  nav.register('watch', {
    onLeave: (prev, next) => {
      if (next && next.name === 'watch') return; // video→video: player.js reuses the iframe
      resetAutoplayChain(); // a queued next video must never follow the child out
      // v1.0.32: bank the stop point BEFORE stop() tears the clock down. openWatch's
      // save-previous covers the video→video path that returned above.
      saveWatchPosition(currentWatch);
      clearInterval(posTimer);
      posTimer = null;
      // v1.0.57 — the call-resume intent belongs to ONE video on THIS screen. Leaving the
      // watch view drops it AND its poll: without this, a child who walks away during a call
      // leaves a timer running for the rest of the session, and a late 'resume' would fire
      // at a torn-down player. (planCallResume also answers 'disarm' for a missing watch
      // view — this is the same rule enforced at the door instead of on the next tick.)
      disarmCallResume();
      // v1.0.63 — the notification belongs to the video on THIS screen. A control left on
      // the lock screen for a video that no longer exists is a button that does nothing,
      // and on a kiosk tablet it is a surface the child can reach for no reason at all.
      disarmBackgroundPlayback().catch(() => {});
      stop();
      wake.releaseAll();
      currentWatch = null;
    }
  });
  // Leaving the pin view WITHOUT success (cancel button / hardware back) resolves
  // the session as cancelled — waiting flows (share add, update) get their answer.
  nav.register('pin', { onLeave: () => consumePinDone(false) });
  nav.register('parent', {
    onBack: () => {
      // v1.0.26: the bubble is an overlay, not a view — back must close IT first, or the
      // parent is thrown out of the screen they were triaging in.
      if (isPreviewOpen()) { closePreview(); return true; }
      // v1.0.33: overlays inside the add tab close before the screen does — the
      // suggestion dropdown first, then a browse-inside-a-result. Both gated on the
      // add panel being VISIBLE: state left behind on another tab must not silently
      // eat a back press.
      if (!$('panel-add').classList.contains('hidden')) {
        if (!$('yts-suggest').classList.contains('hidden')) { ytsHideSuggest(); return true; }
        if (closeYtsBrowse()) return true;
      }
      goGallery();
      return true;
    },
    onLeave: () => closePreview() // never leave a player running behind another screen
  });
  loading.registerLoadingView();
  // v1.0.31: the scheduled-lock screen swallows hardware-back — a child must not escape it.
  nav.register('locked', { onBack: () => true });
}

/* ---------------- Tiles (IDB records) ---------------- */
function setThumb(img, item) {
  const chain = [];
  if (item.thumb) chain.push(item.thumb);          // legacy inline data URL
  if (item.thumbUrl) chain.push(item.thumbUrl);    // API/RSS-provided (guaranteed sizes)
  if (item.type === 'youtube' && item.id) chain.push(...youtubeThumbCandidates(item.id));
  chain.push(PLACEHOLDER);
  let i = 0;
  const tryNext = () => { img.src = chain[Math.min(i, chain.length - 1)]; };
  img.onerror = () => { i += 1; if (i < chain.length) tryNext(); else img.onerror = null; };
  tryNext();
  if (item.thumbId) { // migrated legacy Blob — upgrade in place when it loads
    db.getThumbBlob(item.thumbId)
      .then((b) => { if (b) { img.onerror = null; img.src = URL.createObjectURL(b); } })
      .catch(() => {});
  }
}

function tileEl(item) {
  const btn = document.createElement('button');
  btn.className = 'tile';
  btn.type = 'button';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const img = document.createElement('img');
  img.alt = item.title || '';
  img.loading = 'lazy';
  img.setAttribute('decoding', 'async');
  setThumb(img, item);
  thumb.appendChild(img);

  if (item.type === 'file') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    // v1.0.56: an audio file's tile says so — its thumb is the placeholder (no video
    // track ⇒ no captured frame), and 🎬 on a song reads as a broken video.
    badge.textContent = item.media === 'audio' ? '🎵' : '🎬';
    thumb.appendChild(badge);
  }
  const play = document.createElement('span');
  play.className = 'play-badge';
  play.textContent = '▶';
  thumb.appendChild(play);
  btn.appendChild(thumb);

  if (item.title) {
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = item.title;
    btn.appendChild(cap);
  }

  // F9: an un-unwrapped gift shows wrapped; the FIRST tap unwraps (confetti + jingle)
  // and does NOT play. From then on it's a normal tile.
  const st = giftStates.get(item.key);
  if (st && st.giftRank && !st.unwrappedAt) {
    btn.classList.add('tile-gift');
    const wrap = document.createElement('span');
    wrap.className = 'gift';
    // The 3D-looking 🎁 emoji (same one as the "חדשים" folder logo) — user request:
    // a dimensional gift instead of the flat CSS wrap.
    wrap.innerHTML = '<span class="gift-emoji">🎁</span>';
    thumb.appendChild(wrap);
    const cap = btn.querySelector('.cap');
    if (cap) cap.textContent = 'מתנה! 🎁';
  }

  // v1.0.32: watched-progress bar (red sliver at the thumb's bottom). Gated on the
  // profile's resume setting — no position is saved while it is off, and a stale one
  // from an earlier ON period must not draw. A wrapped gift never played, so no bar.
  if (resumeEnabled && !(st && st.giftRank && !st.unwrappedAt)) {
    const frac = watchedFraction(st && st.posSec, st && st.durSec);
    if (frac !== null) {
      const bar = document.createElement('span');
      bar.className = 'tile-progress';
      const fill = document.createElement('span');
      fill.className = 'tile-progress-fill';
      fill.style.width = (frac * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      thumb.appendChild(bar);
    }
  }

  btn.addEventListener('click', () => {
    const cur = giftStates.get(item.key);
    if (cur && cur.giftRank && !cur.unwrappedAt) { unwrapTileEl(btn, item); return; }
    openWatch(item);
  });
  return btn;
}

async function unwrapTileEl(btn, item) {
  playUnwrap();
  burst(btn);
  btn.classList.add('unwrapping');
  giftStates.set(item.key, { ...(giftStates.get(item.key) || {}), giftRank: undefined, unwrappedAt: Date.now() });
  try { await db.unwrapGift(activeProfileId, item.key); } catch {}
  setTimeout(() => {
    btn.querySelector('.gift')?.remove();
    btn.classList.remove('tile-gift', 'unwrapping');
    const cap = btn.querySelector('.cap');
    if (cap) cap.textContent = item.title || '';
  }, 340);
}

async function loadGiftStates() {
  giftStates = new Map();
  if (!activeProfileId) return;
  // v1.0.32: the resume flag rides the same load — tileEl is synchronous and needs both.
  try { resumeEnabled = (await getSetting(activeProfileId, 'resume', false)) === true; }
  catch { resumeEnabled = false; }
  // v1.0.63 — cached for the SAME reason: `onAppPause` must stay synchronous (it reads the
  // playhead before pausing), so the answer has to be in memory before the screen goes off.
  try { bgPlayEnabled = (await getSetting(activeProfileId, 'bgPlay', false)) === true; }
  catch { bgPlayEnabled = false; }
  // v1.0.57: and 🕒's size. buildFolders, the pager and the watch stamp all need it
  // synchronously, and it must be re-read HERE rather than cached once per launch — a peer
  // can change it (the number is synced) and a profile switch changes whose number it is.
  try { recentLimit = recentLimitFor(await getSetting(activeProfileId, 'recentLimit', null)); }
  catch { recentLimit = RECENT_DEFAULT_LIMIT; }
  const dbi = await db.openDb();
  await new Promise((resolve) => {
    const range = IDBKeyRange.bound([activeProfileId, ''], [activeProfileId, '￿']);
    const req = dbi.transaction('profileVideoState').objectStore('profileVideoState').openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      giftStates.set(cur.value.key, cur.value);
      cur.continue();
    };
    req.onerror = () => resolve();
  });
}

/* ---------------- Resume playback (v1.0.32) ----------------
 * The saving half. The DECISIONS are pure (resumeSaveDecision / resumeStartAt /
 * watchedFraction in playerlogic.js); this owns the profile, the database and the timer.
 * Positions are saved only while the profile's synced 'resume' setting is ON, and they
 * are DEVICE-LOCAL — drive.serializeStateEntry never lets them travel.
 * giftStates (the in-memory mirror of profileVideoState) is kept in step on every write,
 * so the tile bars are correct on the very next render without an extra IDB read. */
let posTimer = null;

/** Forget a video's position: it ended, so the next viewing starts fresh. */
function clearWatchPosition(item) {
  if (!item || !activeProfileId) return;
  const st = giftStates.get(item.key);
  if (st) {
    const { posSec, durSec, posAt, ...rest } = st;
    if (rest.giftRank !== undefined || rest.unwrappedAt) giftStates.set(item.key, rest);
    else giftStates.delete(item.key);
  }
  db.clearPlayPosition(activeProfileId, item.key).catch(() => {});
}

/**
 * v1.0.57 — 🕒: stamp this video as WATCHED once the child has actually watched some of it.
 *
 * The threshold is playback POSITION, not elapsed wall-clock, and that is the honest
 * measure: it survives a pause, it does not count a video sitting still on screen, and a
 * resumed video is already past it — which is right, the child is watching it again.
 *
 * Called from the same interval that banks the resume position, but NOT through it: that
 * one is gated on the resume SETTING, and this folder must work for a family that never
 * turns resume on. Stamped ONCE per opening (`stampedWatch`) — the interval fires every few
 * seconds and each write bumps `db.dataVersion()`, which is what the folder cache keys off,
 * so re-stamping would rebuild the home every 5 seconds for the whole video.
 *
 * Nothing is written while the feature is OFF: the same rule `saveWatchPosition` follows
 * for its position, so a family that set 0 gets no state they did not ask for.
 */
let stampedWatch = null; // key stamped for the CURRENT opening (cleared by openWatch)
function stampWatched(item, { force = false } = {}) {
  if (!item || !item.key || !activeProfileId || recentLimit <= 0) return;
  if (stampedWatch === item.key) return;
  if (!force) {
    const st = playbackState();
    if (!st || !(Number(st.time) >= RECENT_MIN_PLAY_SEC)) return;
  }
  stampedWatch = item.key;
  const at = Date.now();
  const prev = giftStates.get(item.key) || { profileId: activeProfileId, key: item.key };
  giftStates.set(item.key, { ...prev, playedAt: at }); // mirror first — the folder renders from here
  db.setPlayed(activeProfileId, item.key, at).catch(() => {});
}

/** Read the live playhead and persist it for `item`, per the pure decision. */
function saveWatchPosition(item, state = playbackState()) {
  if (!resumeEnabled || !item || !activeProfileId || !state) return;
  const decision = resumeSaveDecision({ pos: state.time, dur: state.duration });
  if (decision === 'ignore') return;
  if (decision === 'clear') { clearWatchPosition(item); return; }
  const pos = Math.floor(state.time);
  const dur = Math.floor(state.duration);
  const prev = giftStates.get(item.key) || { profileId: activeProfileId, key: item.key };
  giftStates.set(item.key, { ...prev, posSec: pos, durSec: dur, posAt: Date.now() });
  db.savePlayPosition(activeProfileId, item.key, pos, dur).catch(() => {});
}

/* ---------------- Home: folders (F10) ---------------- */

/**
 * v1.0.24 — the channel's avatar did not LOAD. Record it, so the next sync can go and get
 * a fresh URL (pure `plan.planChannelLogo`).
 *
 * Without this the failure is invisible AND permanent: `img.onerror` quietly swaps in the
 * 📺 emoji, and both fetch paths skipped any channel that already had a `logoUrl` — so a
 * channel that rebranded (its old avatar URL now 404s) lost its picture forever, and the
 * child lost the only thing that tells one folder from another. The stored URL is NOT
 * cleared here: a moment offline must not throw away a perfectly good avatar, and the
 * sync overwrites it only once it holds a replacement.
 *
 * Once per channel per session — the same tile re-renders on every home entry, and each
 * write bumps `db.dataVersion()`, which is what the folder cache keys off.
 */
const logoFailuresNoted = new Set();
function noteLogoFailure(channelId) {
  if (!channelId || logoFailuresNoted.has(channelId)) return;
  logoFailuresNoted.add(channelId);
  db.setLogoFailedAt(channelId, Date.now()).catch(() => {});
}

/** Show a channel avatar; on failure fall back to the emoji AND report it (see above). */
/* ---------------- Channel-logo byte cache (v1.0.32) ----------------
 * The avatar used to be re-fetched from the NETWORK on every render (<img src=url>), so
 * a flaky connection — or a rebranded channel whose old URL now 404s — showed 📺 even
 * though the app had the picture moments earlier. The bytes are now cached ONCE in the
 * thumbs store (`logo:<channelId>`, ~30KB) and rendered from the device from then on,
 * offline included; the cache refreshes in the background only when the URL changes
 * (pure plan.planLogoCache — render NEVER waits for the network). A folder whose bytes
 * are still missing retries on every home entry (user request): every render calls
 * resolveLogo again, deduped only while a fetch is in flight. */
const logoObjUrls = new Map();  // channelId -> { objUrl, srcUrl } (session-lifetime)
const logoFetching = new Set(); // channelId — dedupe of the NETWORK half only
const logoTarget = new Map();   // channelId -> { img, host } — the LATEST mounted img

/**
 * Deliver an object-URL into the channel's CURRENT img. The home re-renders freely
 * (boot alone renders several times), each render replacing the tile — so a fetch that
 * finishes must paint the LIVE img, not the detached one it started with. The emoji
 * fallback may have replaced the img entirely (onerror), so re-mount into the host.
 */
const showLogo = (channelId, objUrl) => {
  const t = logoTarget.get(channelId);
  if (!t || !t.img) return;
  // planLogoDelivery (pure): the re-mount branch must verify the host still shows THIS
  // channel — #folder-logo-top is one element shared by every folder view, and channel
  // A's late fetch used to plant A's logo into folder B's header (self-review catch).
  const action = planLogoDelivery({
    imgConnected: t.img.isConnected,
    hostConnected: !!(t.host && t.host.isConnected),
    hostChannelId: t.host && t.host.dataset ? (t.host.dataset.logoChannel || null) : null,
    channelId
  });
  if (action === 'skip') return;
  if (action === 'remount') { t.host.textContent = ''; t.host.appendChild(t.img); }
  if (t.img.isConnected) t.img.src = objUrl;
};

/** Serve cached bytes and/or refresh them. Serving NEVER dedupes — only the fetch does. */
async function resolveLogo(channelId, url, img, host) {
  if (!channelId) return;
  logoTarget.set(channelId, { img, host });
  let entry = logoObjUrls.get(channelId);
  if (!entry) {
    const rec = await db.getThumbRecord('logo:' + channelId);
    if (rec && rec.blob) {
      entry = { objUrl: URL.createObjectURL(rec.blob), srcUrl: rec.srcUrl || null };
      logoObjUrls.set(channelId, entry);
      db.touchThumbs(['logo:' + channelId]).catch(() => {}); // used logos never LRU out
    }
  }
  const plan = planLogoCache({ hasBlob: !!entry, blobSrcUrl: entry && entry.srcUrl, url });
  if (plan.render === 'blob') showLogo(channelId, entry.objUrl);
  // The first version deduped the WHOLE function on the in-flight set: a render that
  // arrived while a fetch ran got nothing, and the fetch then painted a detached img —
  // measured in the browser as 📺 tiles sitting on top of a full byte cache.
  if (!plan.fetch || !url || logoFetching.has(channelId)) return;
  logoFetching.add(channelId);
  try {
    const { httpGetBlob } = await import('./platform.js');
    const blob = await httpGetBlob(url);
    if (blob && blob.size > 0) {
      await db.putThumb('logo:' + channelId, blob, { origin: 'logo', srcUrl: url });
      // The OLD objectURL is deliberately NOT revoked (hardening): an img on a
      // background view may still display it, and revoking breaks that img the moment
      // it scrolls back — firing a spurious noteLogoFailure. One leaked URL per
      // rebrand-refresh is nothing; the session map keeps at most one per channel.
      const objUrl = URL.createObjectURL(blob);
      logoObjUrls.set(channelId, { objUrl, srcUrl: url });
      showLogo(channelId, objUrl);
    }
  } catch { /* rendering already has its url/emoji fallback */ }
  finally { logoFetching.delete(channelId); }
}

function mountChannelLogo(host, url, channelId, emoji) {
  if (channelId) host.dataset.logoChannel = channelId; // planLogoDelivery's re-mount guard
  const img = document.createElement('img');
  img.alt = '';
  img.onerror = () => { img.remove(); if (!host.firstChild) host.textContent = emoji; noteLogoFailure(channelId); };
  // Hardening: bytes already in MEMORY paint first (pure logoFirstPaint) — the
  // unconditional `img.src = url` hit the network on every render even with a full
  // cache, which is the exact waste this cache exists to remove.
  const cached = channelId ? logoObjUrls.get(channelId) : null;
  const paint = logoFirstPaint({ cachedObjUrl: cached && cached.objUrl, url });
  if (paint.kind !== 'emoji') { img.src = paint.src; host.appendChild(img); }
  else host.textContent = emoji; // until (maybe) IDB bytes arrive
  // v1.0.32: cached bytes outrank the network — swap in when found, fetch+store when not
  if (channelId) resolveLogo(channelId, url || null, img, host).catch(() => {});
}

/**
 * v1.0.40 — mount a BUNDLED folder illustration, with the emoji as its fallback.
 *
 * `onerror` matters even for a file that ships in the APK: a stale WebView cache or a
 * failed asset copy would otherwise leave an EMPTY circle where the child expects their
 * folder. Same rule as the channel logos (noteLogoFailure) — never show nothing.
 */
/**
 * v1.0.56 — a parent-created folder's picture. The bytes live in the thumbs store
 * (`cfart:<folderId>`), fetched ONCE when the parent picked the image, so the tile renders
 * offline and cannot be broken later by a dead source URL — the v1.0.32 logo lesson,
 * where a stored URL was exactly what failed. The emoji shows until the bytes paint, and
 * stays if they never do (an evicted or missing blob must degrade, never blank).
 */
function mountCustomArt(host, thumbId, emoji) {
  host.textContent = emoji || '📁';
  if (!thumbId) return;
  host.dataset.artId = thumbId; // a slow read must not paint into a tile that moved on
  db.getThumbBlob(thumbId).then((blob) => {
    if (!blob || host.dataset.artId !== thumbId) return;
    const img = document.createElement('img');
    img.className = 'folder-art';
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => { img.remove(); if (!host.firstChild) host.textContent = emoji || '📁'; }, { once: true });
    img.src = URL.createObjectURL(blob);
    host.textContent = '';
    host.appendChild(img);
    db.touchThumbs([thumbId]).catch(() => {}); // a folder in use must never LRU out
  }).catch(() => {});
}

function mountFolderArt(host, src, fallbackEmoji) {
  host.innerHTML = '';
  const img = document.createElement('img');
  img.className = 'folder-art';
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('error', () => { host.textContent = fallbackEmoji || '⭐'; }, { once: true });
  img.src = src;
  host.appendChild(img);
}

/* ==================== approved websites (v1.0.45) ====================
 * The child taps a SHORTCUT tile and the site opens in a native WebView laid over the
 * app; where they may navigate from there is decided by the RULES, which are never shown
 * as tiles (a rule is often a sub-path, or a different site entirely).
 *
 * Everything is scoped to the PROFILE, so two children on one account never inherit each
 * other's browsing surface. The whole viewer is device-only: the enforcement point is
 * `shouldOverrideUrlLoading` in the native plugin, and no browser API can stand in for it.
 */
let siteEntries = [];      // the active profile's rows (both kinds)
let siteViewerOpen = false;
let siteBlockedRecent = []; // {url, at} — surfaced in the parent panel, newest first
let sitesEnabledCache = true;

const siteScope = () => (activeProfileId ? db.profScope(activeProfileId) : null);
const siteShortcuts = () => siteEntries.filter((e) => e && e.kind === 'shortcut')
  .sort((a, b) => (a.order || 0) - (b.order || 0));
const siteRules = () => siteEntries.filter((e) => e && e.kind === 'rule');
/** The shape the native side enforces on — already canonical, never re-parsed there. */
const siteRulePayload = () => siteRules().map((r) => ({
  host: r.host, port: r.port || 443, segments: r.segments || [], allowExternal: !!r.allowExternal
}));

async function loadSiteEntries() {
  const scope = siteScope();
  siteEntries = scope ? await db.listSiteEntries(scope) : [];
  try {
    sitesEnabledCache = activeProfileId
      ? (await getSetting(activeProfileId, 'sitesEnabled', true)) !== false
      : true;
  } catch { sitesEnabledCache = true; }
  return siteEntries;
}

/**
 * The home launcher is shown only when the parent left the setting ON *and* there is at
 * least one shortcut — a button that opens an empty grid is the v1.0.21 bug — and never
 * on TV, where a remote cannot drive an arbitrary website (the parent tab still can).
 *
 * It RE-READS rather than trusting the cache, because both inputs travel: the setting and
 * the entries sync, so a parent who turns the button off (or adds a site) on the phone
 * must see the tablet agree on its next home render. Measured in the browser: with the
 * cached version a peer's change did not take effect until the profile was switched.
 * Fire-and-forget from renderHome, like refreshGateDot — a few indexed rows, and the grid
 * must never wait on it.
 */
async function refreshSitesLauncher() {
  const btn = $('sites-open');
  if (!btn) return;
  await loadSiteEntries();
  // `html.tv` is stamped once at boot (init), so this stays a synchronous read.
  const onTv = document.documentElement.classList.contains('tv');
  const show = sitesEnabledCache && siteShortcuts().length > 0 && !onTv;
  btn.classList.toggle('hidden', !show);
}

/* --- the icon byte-cache: the v1.0.32 channel-logo mechanism, own keyspace ---
   Deliberately NOT resolveLogo: that one stamps `logofail:<id>`, which the channel sync
   reads to decide whether to re-scrape a YouTube avatar. Feeding it site ids would put
   rows it will never understand into a channel-only signal. */
const siteIconUrls = new Map();   // entryId -> objUrl
const siteIconFetching = new Set();

async function resolveSiteIcon(entryId, iconUrl, img, host) {
  if (!entryId) return;
  let objUrl = siteIconUrls.get(entryId);
  if (!objUrl) {
    const rec = await db.getThumbRecord('siteicon:' + entryId);
    if (rec && rec.blob) {
      objUrl = URL.createObjectURL(rec.blob);
      siteIconUrls.set(entryId, objUrl);
      db.touchThumbs(['siteicon:' + entryId]).catch(() => {}); // used icons never LRU out
    }
  }
  if (objUrl) {
    // Re-mount when onerror already swapped the emoji in (the showLogo lesson).
    if (!img.isConnected && host && host.isConnected) { host.textContent = ''; host.appendChild(img); }
    if (img.isConnected) img.src = objUrl;
    return;
  }
  if (!iconUrl || siteIconFetching.has(entryId)) return;
  siteIconFetching.add(entryId);
  try {
    const { httpGetBlob } = await import('./platform.js');
    const blob = await httpGetBlob(iconUrl);
    if (blob && blob.size > 0) {
      await db.putThumb('siteicon:' + entryId, blob, { origin: 'siteicon', srcUrl: iconUrl });
      const u = URL.createObjectURL(blob);
      siteIconUrls.set(entryId, u);
      if (!img.isConnected && host && host.isConnected) { host.textContent = ''; host.appendChild(img); }
      if (img.isConnected) img.src = u;
    }
  } catch { /* the 🌐 fallback is already on screen */ }
  finally { siteIconFetching.delete(entryId); }
}

function mountSiteIcon(host, rec, emoji = '🌐') {
  const img = document.createElement('img');
  img.alt = '';
  img.onerror = () => { img.remove(); if (!host.firstChild) host.textContent = emoji; };
  const cached = siteIconUrls.get(rec.entryId);
  if (cached) { img.src = cached; host.appendChild(img); }
  else host.textContent = emoji;
  resolveSiteIcon(rec.entryId, rec.iconUrl || null, img, host).catch(() => {});
}

function siteTile(rec) {
  const btn = document.createElement('button');
  btn.className = 'tile tile-folder tile-site';
  const logo = document.createElement('span');
  logo.className = 'folder-logo';
  mountSiteIcon(logo, rec);
  btn.appendChild(logo);
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = rec.title || rec.url || 'אתר';
  btn.appendChild(name);
  btn.addEventListener('click', () => { openSiteForKid(rec).catch(() => {}); });
  return btn;
}

function renderSitesView() {
  const grid = $('sites-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const list = siteShortcuts();
  for (const rec of list) grid.appendChild(siteTile(rec));
  $('sites-empty').classList.toggle('hidden', list.length > 0);
}

async function openSitesView() {
  await loadSiteEntries();
  renderSitesView();
  nav.go('sites');
}

/* The browser preview has no native WebView, and standing in with an <iframe> would be a
   lie — an iframe cannot enforce the prefix at all. Say so instead of half-working. */
function siteViewerUnavailableNote() {
  return alertKid({
    emoji: '🌐', title: 'אתרי אינטרנט',
    text: 'פתיחת אתרים עובדת באפליקציה על הטאבלט, לא בתצוגה המקדימה בדפדפן.'
  });
}

/** Open one site for the CHILD: every rule applies, and the screen-time clock arms. */
async function openSiteForKid(rec) {
  if (!rec || !rec.url) return;
  if (!siteViewerAvailable()) {
    // The browser preview has no native WebView, and faking one with an iframe would be
    // a lie: an iframe cannot enforce the prefix at all. Say so instead.
    await siteViewerUnavailableNote();
    return;
  }
  // The lock counts a browsing session exactly like a video session (openWatch does this).
  await armScheduledLock();
  idleLastInputAt = Date.now();
  const ok = await openSiteViewer({
    url: rec.url, rules: siteRulePayload(), title: rec.title || '', parentMode: false
  });
  if (ok) { siteViewerOpen = true; lockCandidateSiteUrl = rec.url; }
}

// v1.0.67 — the page a site lock would be engaged on. Tracked from the viewer's own
// navigation, because the parent taps the padlock while standing on a page, and the app's
// JS cannot ask a native WebView where it is.
let lockCandidateSiteUrl = null;

/** A short, human label for a locked site — the host, which is what a parent recognises. */
function siteHostLabel(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url || ''; }
}

/**
 * Open the site the child is LOCKED into.
 *
 * Two narrowings, and both are the lock:
 *  - the RULES are cut to that site alone (`rulesForLockedSite`), so an approved link to
 *    another site cannot carry the child out — the user's decision 2026-08-31;
 *  - `locked: true` makes the native bar's button a padlock and stops hardware back from
 *    falling through to a close.
 *
 * If the site can no longer be described by any rule — the parent deleted it while the lock
 * stood — the lock is RELEASED rather than leaving a child staring at a blocked page they
 * cannot leave. Containment errs strict everywhere else; here it errs OPEN, the v1.0.56 rule
 * for a lock that can no longer be identified.
 */
async function openLockedSite(url) {
  // ⚠️ THE FAIL-OPEN CHECKS COME FIRST, BOTH OF THEM, AND THE ORDER IS THE WHOLE POINT.
  // Measured in the browser: with the viewer check on top, an orphaned lock never reached
  // the release below — the child was left on a locked websites screen, no 🏠, holding a
  // lock on a site that could never open. A lock the app CANNOT ENFORCE must not strand a
  // child (the v1.0.56 rule); containment errs strict everywhere except here.
  await loadSiteEntries();
  const rules = rulesForLockedSite(siteRulePayload(), url);
  const release = async (why) => {
    await clearContainment();
    await refreshContainUi();
    toast(why);
    return false;
  };
  if (!rules.length) return release('האתר הנעול כבר לא קיים — הנעילה שוחררה 🔓');
  if (!siteViewerAvailable()) return release('אי אפשר לפתוח אתרים כאן — הנעילה שוחררה 🔓');
  await armScheduledLock();
  idleLastInputAt = Date.now();
  const ok = await openSiteViewer({ url, rules, title: siteHostLabel(url), parentMode: false, locked: true });
  if (ok) { siteViewerOpen = true; lockCandidateSiteUrl = url; }
  return !!ok;
}

/** Reopen a page for the CHILD with the current rules — used after a parent approval. */
async function reopenForKid(url) {
  if (!siteViewerAvailable()) return;
  await loadSiteEntries();           // the rule was just written; open with it in hand
  idleLastInputAt = Date.now();
  const ok = await openSiteViewer({ url, rules: siteRulePayload(), title: '', parentMode: false });
  if (ok) siteViewerOpen = true;
}

/**
 * The padlock in the site viewer's bar (v1.0.67).
 *
 * ⚠️ THE VIEWER MUST CLOSE BEFORE THE CODE SCREEN, and that is not a preference: the viewer
 * is a NATIVE overlay laid over the whole app, so the PIN would render invisibly beneath it
 * — the same wiring the screen-time break already depends on (v1.0.45). The close goes
 * through the APP's own path, which a site lock never blocks.
 *
 * Backing out REOPENS the site. Without that, tapping the padlock and changing your mind
 * would be a way out of the lock — the child would simply be left in the app.
 */
async function onSiteLockTap() {
  if (!activeProfileId) return;
  const wasLocked = containState.active && containState.mode === 'site';
  const url = wasLocked ? containState.siteUrl : lockCandidateSiteUrl;
  await closeSiteViewer().catch(() => {});
  siteViewerOpen = false;
  let settled = false;   // onDone fires exactly once, for success AND for cancel
  if (wasLocked) {
    startPin((await hasPin()) ? 'verify' : 'setup', {
      title: 'קוד הורים',
      onSuccess: async () => {
        settled = true;
        if (nav.isActive('pin')) nav.back();
        // v1.0.76 — release OR re-lock with a fresh duration (the same fix as onLockTap: the
        // release-only branch meant the "how long?" dialog could never appear a second time).
        const choice = relockChoice(await askKid({
          emoji: '🔒', title: 'כבר יש נעילה',
          text: 'לשחרר את הנעילה, או לנעול מחדש עם זמן חדש?',
          ok: 'שחרור הנעילה', third: 'נעילה מחדש', cancel: 'ביטול'
        }));
        if (choice === 'release') {
          await clearContainment();
          nav.reset('sites');
          renderSitesView();
          await refreshContainUi();
          toast('הנעילה שוחררה 🔓');
        } else if (choice === 'relock' && url) {
          askLockDuration('site', null, url).catch(() => {});
        } else if (url) {
          // changed their mind — the child was inside the locked site, put them back
          await openLockedSite(url).catch(() => {});
        }
      },
      onDone: () => { if (!settled && url) openLockedSite(url).catch(() => {}); }
    });
    return;
  }
  if (!url || !rulesForLockedSite(siteRulePayload(), url).length) {
    toast('אי אפשר לנעול על הדף הזה');
    if (url) await openLockedSiteOrPlain(url);
    return;
  }
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: 'קוד הורים לנעילה על האתר',
    onSuccess: () => { settled = true; askLockDuration('site', null, url).catch(() => {}); },
    // the parent backed out of the code screen, or out of the duration dialog: the child
    // was browsing a moment ago and must be put back where they were
    onDone: () => { if (!settled) openLockedSiteOrPlain(url).catch(() => {}); }
  });
}

/** Reopen `url` under the lock if one is engaged, otherwise as an ordinary visit. */
async function openLockedSiteOrPlain(url) {
  if (containState.active && containState.mode === 'site') return openLockedSite(url);
  await loadSiteEntries();
  const ok = await openSiteViewer({ url, rules: siteRulePayload(), title: siteHostLabel(url), parentMode: false });
  if (ok) { siteViewerOpen = true; lockCandidateSiteUrl = url; }
  return !!ok;
}

/** Open for the PARENT: navigation unrestricted, so an SSO login can complete. */
async function openSiteForParent(url, title) {
  if (!siteViewerAvailable()) {
    await siteViewerUnavailableNote();
    return;
  }
  const ok = await openSiteViewer({ url, rules: siteRulePayload(), title: title || '', parentMode: true });
  if (ok) siteViewerOpen = true;
}

/**
 * A blocked page, turned into a fix. The child sees a calm message and stays put; the
 * discreet "הורים" button asks the native side to hand control back here, and THIS is
 * where the code is checked — a PIN must never be verified in Java, because that would
 * be a second implementation of the one check that protects the whole parent surface.
 */
async function onSiteAddRequest(url) {
  await closeSiteViewer();
  siteViewerOpen = false;
  const cands = ruleCandidatesFor(url);
  if (!cands.ok) {
    await alertKid({ emoji: '🚫', title: 'כתובת לא נתמכת', text: 'האפליקציה תומכת רק בכתובות https.' });
    return;
  }
  startPin((await hasPin()) ? 'verify' : 'setup', {
    replace: true, title: 'קוד הורים כדי לאשר את הדף',
    onSuccess: () => { askSiteRuleGrain(url, cands).catch(() => {}); }
  });
}

/**
 * Which slice of the site does the parent mean to allow? NEVER guess "the whole site":
 * the child hit one link, and silently opening a whole domain is more than was asked.
 * The default is the narrowest grain that still leaves the site usable (its section), and
 * the whole site is the deliberate second button. A single page can be added by pasting
 * its exact address in the panel — offering it here would just block the next tap.
 */
async function askSiteRuleGrain(url, cands) {
  const opts = cands.options;
  const def = opts[cands.defaultIndex];
  const wide = opts.find((o) => o.label === 'whole-site');
  const answer = await askKid({
    emoji: '🔓',
    title: 'לאשר את הדף לילד?',
    text: url + '\n\nמה לאשר?',
    ok: (def.label === 'whole-site' ? 'כל האתר' : def.label === 'section' ? 'החלק הזה באתר' : 'הדף הזה') +
      ' — ' + def.canon.display,
    third: (wide && wide !== def) ? 'כל האתר — ' + wide.canon.display : '',
    cancel: 'ביטול'
  });
  const chosen = answer === 'ok' ? def : answer === 'third' ? wide : null;
  if (!chosen) return;
  const res = await addSiteRule(chosen.canon);
  toast(res.ok ? 'האתר אושר ✅' : res.message);
  await refreshSitesPanel();
  // Straight back to the page they were on — a fix that dumps the parent somewhere else
  // makes them redo the navigation just to check it worked.
  //
  // ⚠️ IN CHILD MODE. This flow STARTS on the child's blocked page: the parent leans over,
  // types the code, approves, and hands the tablet back. Reopening in parent mode would
  // leave that child holding an unrestricted browser — the whole feature undone by the
  // very act of fixing it. The parent's own unrestricted door is the panel's "בדיקה".
  if (res.ok) await reopenForKid(url);
}

/* --- writes (all three add doors funnel through these two) --- */

async function addSiteRule(canon, { allowExternal = false } = {}) {
  const scope = siteScope();
  if (!scope) return { ok: false, message: 'אין פרופיל פעיל' };
  const entryId = ruleIdFor(canon);
  if (siteEntries.some((e) => e.entryId === entryId)) return { ok: false, message: 'הכתובת כבר מאושרת' };
  await db.putSiteEntry({
    scopeId: scope, entryId, kind: 'rule', display: canon.display, host: canon.host,
    port: canon.port, segments: canon.segments, allowExternal: !!allowExternal,
    order: siteEntries.length, addedAt: Date.now()
  });
  await loadSiteEntries();
  maybeSchedulePush();
  return { ok: true };
}

/**
 * Add a shortcut — and the matching RULE with it. Without the rule the tile would open
 * and then block the first link the child taps, which reads as a broken site rather than
 * as a setting they never made.
 */
async function addSiteShortcut(url, { title = '', iconUrl = '', allowExternal = false } = {}) {
  const scope = siteScope();
  if (!scope) return { ok: false, message: 'אין פרופיל פעיל' };
  const canon = canonicalSitePrefix(url);
  if (!canon.ok) return { ok: false, message: siteUrlError(canon.reason) };
  const entryId = shortcutIdFor(url);
  if (siteEntries.some((e) => e.entryId === entryId)) return { ok: false, message: 'האתר כבר ברשימה' };
  await db.putSiteEntry({
    scopeId: scope, entryId, kind: 'shortcut', url, title: title || canon.host,
    iconUrl: iconUrl || '', order: siteEntries.length, addedAt: Date.now()
  });
  await loadSiteEntries();
  const ruleId = ruleIdFor(canon);
  // The auto-created rule inherits the parent's answer — otherwise they would say "yes,
  // allow external content" and the rule that actually governs the page would still be
  // strict, which reads as the answer being ignored.
  if (!siteEntries.some((e) => e.entryId === ruleId)) await addSiteRule(canon, { allowExternal });
  maybeSchedulePush();
  return { ok: true, canon };
}

async function removeSiteEntry(entryId) {
  const scope = siteScope();
  if (!scope) return;
  await db.deleteSiteEntry(scope, entryId);
  await loadSiteEntries();
  maybeSchedulePush();
}

/** The refusal reasons, in the parent's words. */
function siteUrlError(reason) {
  if (reason === 'empty') return 'צריך להזין כתובת';
  if (reason === 'scheme') return 'רק כתובות https נתמכות (מטעמי בטיחות)';
  if (reason === 'host') return 'הכתובת לא נראית תקינה';
  if (reason === 'path') return 'הכתובת מכילה תווים שאינם נתמכים';
  return 'הכתובת לא נראית תקינה';
}

/**
 * Follow the address the parent typed to where it ACTUALLY lands, and read the page's
 * own title and icon on the way. A parent who pastes `example.com/kids/` on a site that
 * redirects to `www.` or into a different path would otherwise save a rule that matches
 * nothing the child can reach — the commonest way this feature can look broken.
 * Best-effort: an unreachable site is still addable, just without a title or a picture.
 */
async function probeSite(rawUrl) {
  const canon = canonicalSitePrefix(rawUrl);
  if (!canon.ok) return { ok: false, reason: canon.reason };
  const start = canon.display;
  try {
    const { httpRequest } = await import('./platform.js');
    const res = await Promise.race([
      httpRequest({ url: start, responseType: 'text' }),
      new Promise((r) => setTimeout(() => r(null), SITE_PROBE_TIMEOUT_MS))
    ]);
    if (!res) return { ok: true, canon, url: start, title: '', iconUrl: '' };
    const finalUrl = (res && res.url) || start;
    const finalCanon = canonicalSitePrefix(finalUrl);
    const html = typeof res?.data === 'string' ? res.data : '';
    const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
    const title = m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return {
      ok: true,
      canon: finalCanon.ok ? finalCanon : canon,
      url: finalCanon.ok ? finalCanon.display : start,
      title,
      iconUrl: extractSiteIconFromHtml(html, finalCanon.ok ? finalCanon.display : start)
    };
  } catch {
    return { ok: true, canon, url: start, title: '', iconUrl: '' };
  }
}

function folderTile(f) {
  const btn = document.createElement('button');
  btn.className = 'tile tile-folder' + (f.isNew ? ' folder-new' : '');
  btn.type = 'button';
  btn.style.position = 'relative';

  const logo = document.createElement('span');
  logo.className = 'folder-logo';
  // v1.0.32: a channelId alone is enough — cached bytes may exist even when the URL
  // is gone (rebrand) or was never fetched on this device.
  if (f.custom) mountCustomArt(logo, f.artThumbId, f.emoji);
  else if (f.art) mountFolderArt(logo, f.art, f.emoji);
  else if (f.logoUrl || f.channelId) mountChannelLogo(logo, f.logoUrl, f.channelId, f.emoji);
  else logo.textContent = f.emoji;
  const nm = document.createElement('span');
  nm.className = 'folder-name';
  nm.textContent = f.title;
  const cnt = document.createElement('span');
  cnt.className = 'folder-count';
  // v1.0.61 — a tile that opens FOLDERS counts folders. "32 תיקיות" describes what the tap
  // gives you; the song total describes something the child will never see on one screen,
  // and would be the only number on the home that does not match the grid it opens.
  cnt.textContent = f.children
    ? (f.children === 1 ? 'תיקיה אחת' : `${f.children} תיקיות`)
    : `${f.count} סרטונים`;
  btn.appendChild(logo);
  btn.appendChild(nm);
  btn.appendChild(cnt);
  // v1.0.4: channel folders carry an explicit chip — the child (and parent) must
  // never mistake a folder for a playable video tile. v1.0.12: grouped singles get
  // their OWN chip (🎞️ אוסף) so the two folder kinds never look alike.
  const fid = String(f.id);
  if (fid.startsWith('ch:') || fid.startsWith('grp:') || fid.startsWith('pl:') || f.custom) {
    const chip = document.createElement('span');
    chip.className = 'folder-chip';
    chip.textContent = f.custom ? '📁 תיקיה'
      : fid.startsWith('grp:') ? '🎞️ אוסף'
      : fid.startsWith('pl:') ? '🎵 רשימה' : '📺 ערוץ';
    btn.appendChild(chip);
  }
  if (f.isNew) {
    const badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.textContent = f.count;
    btn.appendChild(badge);
  }
  btn.addEventListener('click', () => openFolder(f.id));
  return btn;
}

/**
 * v1.0.6: ONE shared "extra videos" list. Profile-scope 'mine' records (manual adds,
 * approved shares) are absorbed into the library's 'sheet' folder — shared by every
 * profile on the sheet — and first-time moves are queued for the sheet write-back.
 * Idempotent and cheap when there is nothing to move; runs on every activation, so
 * copies resurrected by a Drive merge from a not-yet-updated device self-heal too.
 */
async function absorbMineIntoShared(profileId) {
  try {
    const src = await db.getSources(profileId);
    const lib = src && src.libraryId;
    if (!lib) return; // sources appear on first sync — the next activation absorbs
    const pScope = db.profScope(profileId);
    const mine = await db.loadMergeIndex(pScope);
    let moved = 0;
    for (const rec of mine.values()) {
      if ((rec.homeFolderId || rec.folderId) !== 'mine') continue;
      if (!(await db.getVideo(lib, rec.key))) {
        const pending = rec.state === 'pending';
        await db.putVideos([{
          ...rec, scopeId: lib,
          folderId: pending ? '~pending' : 'sheet',
          homeFolderId: pending ? 'sheet' : null,
          updatedAt: Date.now()
        }]);
        moved += 1;
      }
      await db.deleteVideoRaw(pScope, rec.key); // raw: a move, not a deletion — no tombstone
    }
    await db.copyDenies(pScope, lib); // personal deletions keep protecting the shared list
    if (moved) maybeSchedulePush(); // the absorb must reach the other devices
  } catch { /* absorbing must never block activation; next activation retries */ }
}

/**
 * Derived-home cache (v1.0.20 performance fix). buildFolders() has to read the WHOLE
 * library — the grouping needs full records, which then feed the tiles directly — and
 * renderHome() runs on every gallery entry, every return from a video and every home
 * page flip. On a real library that was a full-store deserialize per interaction, which
 * is what made the app feel sticky. `db.dataVersion()` changes on every committed write,
 * so a hit here is only possible when NOTHING has changed since the last derivation.
 */
let foldersCache = null;

async function buildFolders() {
  const cache = foldersCache;
  // v1.0.57 — `recentLimit` IS PART OF THE KEY, for the same reason `profileId` is: it is a
  // SETTING, and settings live in Preferences, so changing it does NOT move
  // `db.dataVersion()`. Without it the parent could set 🕒 to 0 (or to 20) and the child's
  // home would keep showing the folder exactly as it was until some unrelated write
  // happened to bump the counter — the cross-profile bug this cache already carries a
  // guard for, in a new disguise. The key must name everything the derivation reads.
  if (cache && cache.profileId === activeProfileId && cache.seq === db.dataVersion()
      && cache.recentLimit === recentLimit) {
    libScope = cache.libScope;
    singleGroups = cache.singleGroups;
    absorbedSingles = cache.absorbedSingles;
    looseSingles = cache.looseSingles;
    customFolderRows = cache.customFolderRows;
    return cache.folders.slice();
  }
  const seq = db.dataVersion();
  // Capture the profile ALONGSIDE the write counter. Switching profile writes only to
  // Preferences, so dataVersion() does NOT change across a switch — `profileId` is the
  // cache's only cross-profile guard, and reading it at cache-WRITE time (after every
  // await below) let a derivation that started as child A get stamped with child B's id.
  // B then hit the cache and was shown A's library, with libScope pointing at A's videos.
  const pid = activeProfileId;
  const out = [];
  let cfRows = [];   // published with the rest only if this profile is still current
  if (!pid) return out;
  const giftCount = await db.countGifts(pid);
  if (giftCount > 0) out.push({ id: 'new', title: 'חדשים', emoji: '🎁', count: giftCount, isNew: true });
  // v1.0.40 — ⭐ SECOND, immediately after 🎁 (the user's request: at the top of all the
  // folders, after "חדשים"). Hidden at zero, exactly like the gift folder: a tile that
  // opens an empty grid is the v1.0.21 bug.
  const favCount = favouriteKeys(giftStates).length;
  // v1.0.41 (user correction): ⭐ stays the favourites folder's mark — a star IS the
  // universal "favourite" sign, and it was never what collided. The DRAWING belongs to the
  // mixed-bag folder below, which is what used to wear this star.
  if (favCount > 0) out.push({ id: 'fav', title: 'מועדפים', emoji: '⭐', count: favCount, isFav: true });
  // v1.0.57 — 🕒 THIRD, after the app's two other derived views and before anything stored.
  // It is a SHORTCUT to carry on watching, so it belongs where the child's thumb already
  // goes. Hidden at zero like every other folder (the v1.0.21 rule), which also means a
  // family with the feature off never sees it at all.
  const recentCount = recentKeys(giftStates, recentLimit).length;
  if (recentCount > 0) {
    out.push({ id: 'recent', title: 'נצפה לאחרונה', emoji: '🕒', count: recentCount, isRecent: true });
  }

  const src = await db.getSources(pid);
  const lib = (src && src.libraryId) || null;
  // v1.0.56 — PARENT-CREATED FOLDERS, third: after 🎁/⭐ (the app's own two views) and
  // BEFORE the channels, because a parent who made a folder by hand put exactly what they
  // wanted in it. Ordered among themselves by `order` (creation time, ASCENDING — the ⭐
  // rule: a 5-year-old navigates by POSITION, so a new folder appends instead of pushing
  // every known tile sideways). Hidden at zero, like every other folder (v1.0.21) — the
  // ROW survives, so the parent can still see it, rename it and file videos into it.
  if (lib) {
    const custom = (await db.listCustomFolders(lib)).slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    cfRows = custom;
    // v1.0.61 — how many CHILD folders each row has. A folder that holds folders is shown
    // even with no songs of its own: it is the row a parent taps to reach 32 discs, and
    // hiding it at zero (the v1.0.21 rule) would hide the whole collection — which is the
    // bug this feature exists to fix.
    const childrenOf = new Map();
    for (const cf of custom) {
      if (!cf.parentFolderId) continue;
      childrenOf.set(cf.parentFolderId, (childrenOf.get(cf.parentFolderId) || 0) + 1);
    }
    for (const cf of custom) {
      const count = await db.countFolder(lib, cf.folderId);
      const children = childrenOf.get(cf.folderId) || 0;
      if (!count && !children) continue;
      out.push({
        id: cf.folderId, scope: lib, title: cf.title || 'תיקיה',
        emoji: cf.emoji || '📁', count, custom: true,
        // v1.0.61 — a tile that opens FOLDERS counts folders, not songs. "32 תיקיות" says
        // what the tap gives you; "751" describes something a pre-reader will never see on
        // one screen, and would be the only number on the home not matching its grid.
        children, parentFolderId: cf.parentFolderId || null,
        // the parent-picked picture rides the thumbs byte cache like a channel logo
        // (v1.0.32), so it renders offline and survives a dead source URL
        artThumbId: cf.artThumbId || null
      });
    }
  }
  // ALL grouping state is derived into LOCALS and published together at the very end.
  // A profile without sources used to keep the PREVIOUS profile's looseSingles, and a
  // derivation superseded mid-await by a profile switch used to publish its stale
  // globals over the new child's (latent leak, and the cross-profile cache hit above).
  let groups = new Map();
  let absorbed = new Map();
  let loose = [];
  if (lib) {
    const libChannels = await db.listLibraryChannels(lib); // read ONCE — this used
    const subscribedIds = new Set(libChannels.map((c) => c.channelId)); // to run twice
    for (const lc of libChannels) {
      if (lc.hidden) continue;
      const ch = (await db.getChannel(lc.channelId)) || {};
      // v1.0.26: a standalone playlist is a subscription in the same table, and gets its
      // own folder — except for the videos whose channel is ALSO subscribed, which
      // playlistVideoFolder files under the channel instead (the parent's unify rule).
      // A playlist whose videos ALL went to channel folders has count 0 and no tile,
      // which is exactly right: it would have been an empty duplicate.
      const isPl = lc.kind === 'playlist';
      const prefix = isPl ? 'pl:' : 'ch:';
      const count = await db.countFolder(lib, prefix + lc.channelId);
      if (!count) continue;
      out.push({
        id: prefix + lc.channelId, scope: lib,
        title: lc.titleOverride || ch.title || (isPl ? 'רשימת השמעה' : 'ערוץ'),
        // logo → persisted per-channel fallback thumbnail → 📺 emoji (v1.0.6):
        // every channel folder must stay visually distinct for a non-reading child.
        // v1.0.24: channelId rides along so a tile whose image FAILS TO LOAD can say so
        // (noteLogoFailure) — that failure is otherwise invisible and permanent.
        channelId: lc.channelId,
        logoUrl: ch.logoUrl || ch.fallbackThumbUrl || '', emoji: isPl ? '🎵' : '📺', count
      });
    }
    // v1.0.12: loose single links from the SAME channel collapse into one 🎞️ folder
    // (2+ = a group; a lone single stays in the flat list, so deleting down to one
    // un-groups it by itself). Singles of an already-subscribed channel are shown
    // inside that channel's 📺 folder instead of a second same-named folder.
    // All of it rides ONE bulk read — the record arrays feed pagination directly.
    const { compareForDisplay } = await import('./order.js');
    const sheetRecords = [...(await db.loadMergeIndex(lib)).values()].filter(isLooseRecord);
    const grouping = groupSinglesByChannel(sheetRecords.filter((r) => !r.channelId), subscribedIds);
    const byKey = new Map(sheetRecords.map((r) => [r.key, r]));
    const recsOf = (keys) => keys.map((k) => byKey.get(k)).filter(Boolean).sort(compareForDisplay);

    groups = new Map(grouping.groups.map((g) => [g.channelId, recsOf(g.keys)]));
    absorbed = new Map([...grouping.absorb].map(([id, keys]) => [id, recsOf(keys)]));
    for (const [chId, recs] of absorbed) {
      const f = out.find((x) => x.id === 'ch:' + chId);
      if (f) { f.count += recs.length; continue; }
      // subscribed but nothing imported yet — the singles still need a home
      const ch = (await db.getChannel(chId)) || {};
      out.push({
        id: 'ch:' + chId, scope: lib, title: ch.title || 'ערוץ', channelId: chId,
        logoUrl: ch.logoUrl || ch.fallbackThumbUrl || '', emoji: '📺', count: recs.length
      });
    }
    for (const g of grouping.groups) {
      const ch = (await db.getChannel(g.channelId)) || {};
      out.push({
        id: 'grp:' + g.channelId, scope: lib, title: g.title, channelId: g.channelId,
        logoUrl: ch.logoUrl || ch.fallbackThumbUrl || '', emoji: '🎞️',
        count: g.keys.length, grouped: true
      });
    }
    // the merged shared list — only what stayed loose after grouping (v1.0.12)
    const claimed = new Set([
      ...grouping.groups.flatMap((g) => g.keys),
      ...[...grouping.absorb.values()].flat()
    ]);
    loose = sheetRecords.filter((r) => !claimed.has(r.key)).sort(compareForDisplay);
    if (loose.length) {
      // v1.0.41 (user request): the mixed-bag folder gets a drawn scene — rainbow, rocket,
      // horse, children. It used to wear ⭐, which now reads as the favourites folder; 🎬 is
      // the FALLBACK if the asset ever fails to load, and is distinct from every other kind
      // (📺 channel, 🎞️ collection, 🎵 playlist, 🎁 new, ⭐ fav).
      out.push({
        id: 'sheet', scope: lib, title: 'סרטונים נוספים', emoji: '🎬', count: loose.length,
        art: 'assets/folders/extras.svg'
      });
    }
  }
  // legacy safety: pre-absorb profile-scope items (e.g. before the first sync creates
  // sources) stay reachable until absorbMineIntoShared picks them up
  const mineCount = await db.countFolder(db.profScope(pid), 'mine');
  if (mineCount) out.push({ id: 'mine', scope: db.profScope(pid), title: 'סרטונים נוספים', emoji: '💜', count: mineCount });
  // Superseded by a profile switch while we were awaiting? Publish NOTHING — not the
  // globals, not the cache. The switch does its own render and re-derives from scratch.
  if (pid !== activeProfileId) return out;
  libScope = lib;
  singleGroups = groups;
  absorbedSingles = absorbed;
  looseSingles = loose;
  customFolderRows = cfRows;
  // Cache against the write counter AND the profile READ AT ENTRY: if anything committed
  // while we were deriving, `seq` is already stale and the next render redoes the work
  // (never serves a list that never matched the store).
  foldersCache = {
    seq, profileId: pid, recentLimit, libScope: lib, folders: out.slice(),
    singleGroups: groups, absorbedSingles: absorbed, looseSingles: loose, customFolderRows: cfRows
  };
  return out;
}

function scopeForFolder(fid) {
  if (fid === 'mine') return db.profScope(activeProfileId);
  return libScope;
}

/**
 * Home = folder tiles. UX rule (pure `shouldFlattenHome`): when the only folder is the
 * shared loose list the home renders its videos flat — folders appear once there is
 * something to organize. A CHANNEL folder always keeps its tile, even alone (v1.0.20):
 * flattening it hid the channel's logo behind a 100-page flat list.
 */
async function renderHome() {
  folders = await buildFolders();
  // v1.0.61 — THE HOME SHOWS ROOTS; `folders` still holds every row. Three consumers look a
  // folder up by id (openFolder's header and both search indexes) and a missing entry is a
  // blank header, so the filter belongs HERE and nowhere upstream.
  const homeList = homeFolderRows(folders);
  const grid = $('grid');

  refreshGateDot(); // fire-and-forget — the red dot must never delay the grid
  refreshRecoveryBanner(); // same: the grid must never wait on a Preferences read
  // v1.0.45: BEFORE the empty-library early return below — a family may have approved
  // websites and no videos at all, and hiding their only content behind "עדיין אין
  // סרטונים" would be the app forgetting half of what the parent set up.
  refreshSitesLauncher().catch(() => {});
  refreshContainUi().catch(() => {}); // v1.0.56 — the padlock and what the lock hides

  const empty = homeList.length === 0;
  $('empty-state').classList.toggle('hidden', !empty);
  grid.classList.toggle('hidden', empty);
  // v1.0.57: homePages back to 1 here too — this early return skips updateHomePager, and a
  // count left over from the previous profile would let a swipe page an empty home.
  if (empty) { homePages = 1; $('pg-controls').classList.add('hidden'); grid.innerHTML = ''; return; }

  if (shouldFlattenHome(homeList)) {
    // shouldFlattenHome only says yes for a SINGLE non-🎁 folder, so homeList[0] is it
    await renderGridPage(grid, homeList[0].scope, homeList[0].id, 'home');
    return;
  }

  const total = Math.max(1, Math.ceil(homeList.length / PAGE_FOLDERS));
  if (page >= total) page = total - 1;
  if (page < 0) page = 0;
  paintHomePage(grid, page);
  announceGridRender(grid);   // v1.0.62 — a live swipe must drop a drag on a rebuilt grid
  updateHomePager(total);
}

/** v1.0.62 — one page of home tiles into ANY element, so the swipe can fill its ghost. */
function paintHomePage(target, pageIndex) {
  const homeList = homeFolderRows(folders);
  target.innerHTML = '';
  for (const f of homeList.slice(pageIndex * PAGE_FOLDERS, (pageIndex + 1) * PAGE_FOLDERS)) {
    target.appendChild(folderTile(f));
  }
}

function updateHomePager(total) {
  // v1.0.57: the swipe reads this. The home pager is hand-written markup (the exit button
  // lives inside its bar), so unlike the folder/watch pagers it has no object holding the
  // count — and a swipe that guessed the count could walk the child past the last page.
  homePages = Math.max(1, Number(total) || 1);
  const controls = $('pg-controls');
  if (total > 1) {
    controls.classList.remove('hidden');
    $('pg-info').textContent = `${page + 1} / ${total}`;
    $('pg-prev').disabled = page === 0;
    $('pg-next').disabled = page >= total - 1;
  } else {
    controls.classList.add('hidden');
  }
}

/**
 * 🎁 "חדשים" — the sparse by_gift index resolved to live records, rank order.
 * Kept out of pageAnyFolder's body only for readability; it is reached ONLY through it.
 */
async function pageGiftFolder({ offset, limit }) {
  const res = await db.pageGifts(activeProfileId, { offset, limit });
  const items = [];
  const prefer = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  for (const st of res.items) {
    // by-key lookup across ALL scopes: immune to library-id drift (a re-saved sheet
    // URL used to orphan gift states — badge counted them, the folder came up empty)
    const rec = await db.findLiveByKey(st.key, prefer);
    if (rec) {
      items.push(rec);
    } else {
      // self-heal: the video is gone everywhere — drop the orphaned state so the
      // "חדשים" badge converges with what the child actually sees
      try { await db.deleteVideoState(activeProfileId, st.key); giftStates.delete(st.key); } catch {}
    }
  }
  return { items, total: res.total };
}

/**
 * v1.0.40 — the child's ⭐ folder. Same shape as the gift folder above and for the same
 * reason: no record carries `folderId:'fav'`, so this is derived from the profile's state.
 *
 * Order is `favAt` ASCENDING — a new star is APPENDED (the user's decision). A pre-reader
 * navigates by POSITION, so putting the newest first would move every video they know.
 *
 * The self-heal drops only the FAVOURITE fields when the video is gone everywhere: the row
 * also carries gift/unwrap/resume state, and deleting it wholesale (as the gift folder may,
 * because a rank IS the whole point there) would re-gift a video the child already opened.
 */
async function pageFavFolder({ offset, limit }) {
  const keys = favouriteKeys(giftStates);
  const prefer = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const items = [];
  const slice = keys.slice(offset, offset + limit);
  for (const key of slice) {
    const rec = await db.findLiveByKey(key, prefer);
    if (rec) items.push(rec);
    else {
      try {
        await db.setFavourite(activeProfileId, key, false);
        const st = giftStates.get(key);
        if (st) giftStates.set(key, { ...st, favOffAt: Date.now() });
      } catch {}
    }
  }
  return { items, total: keys.length };
}

/**
 * v1.0.57 — 🕒 "נצפה לאחרונה", the third derived folder. Same shape as 🎁 and ⭐: no record
 * carries `folderId:'recent'`, so it is resolved from the profile's own state map.
 *
 * `keys` may be a FROZEN SNAPSHOT (the watch screen passes one) — see openWatch. The folder
 * view passes nothing and gets the live order, which is what a child opening 🕒 expects.
 *
 * The self-heal clears ONLY the watch stamp when the video is gone everywhere: this row
 * also carries the gift rank, the unwrap and the ⭐, and deleting it wholesale would re-gift
 * a video the child already opened (the ⭐ pager's lesson, and now `stateRowIsSpent` makes
 * the row survive correctly when something else is still on it).
 */
async function pageRecentFolder({ offset, limit, keys = null }) {
  const all = keys || recentKeys(giftStates, recentLimit);
  const prefer = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const items = [];
  for (const key of all.slice(offset, offset + limit)) {
    const rec = await db.findLiveByKey(key, prefer);
    if (rec) items.push(rec);
    else {
      try {
        await db.setPlayed(activeProfileId, key, null);
        const st = giftStates.get(key);
        if (st) { const next = { ...st }; delete next.playedAt; giftStates.set(key, next); }
      } catch {}
    }
  }
  return { items, total: all.length };
}

/**
 * One pagination entry point for every folder kind (v1.0.12):
 *   new      — 🎁 "חדשים": the sparse gift index, resolved to live records (v1.0.21);
 *   grp:<id> — a virtual folder of loose singles sharing a channel (array slice);
 *   sheet    — the flat list MINUS whatever grouping claimed (array slice);
 *   ch:<id>  — the channel's indexed range, with absorbed singles PREPENDED
 *              (they come first, then the channel's own videos, paged correctly);
 *   anything else — the plain by_folder_sort range.
 *
 * 🎁 lives HERE, not in renderGridPage, because it is not a stored folder: no record
 * carries `folderId:'new'`, so `folderRange(scope,'new')` is an exact bound that matches
 * nothing. renderGridPage had its own gift branch and renderWatchGrid did not, so opening
 * a gift left the UNDER-PLAYER GRID EMPTY (v1.0.21 field bug) — the child lost every way
 * to pick the next video. One entry point means one gift implementation.
 */
async function pageAnyFolder(scope, fid, { offset = 0, limit = PAGE_SIZE, recentSnapshot = null } = {}) {
  const slice = (arr) => ({ items: arr.slice(offset, offset + limit), total: arr.length });
  if (fid === 'new') return pageGiftFolder({ offset, limit });
  if (fid === 'fav') return pageFavFolder({ offset, limit });
  if (fid === 'recent') return pageRecentFolder({ offset, limit, keys: recentSnapshot });
  if (String(fid).startsWith('grp:')) return slice(singleGroups.get(String(fid).slice(4)) || []);
  if (fid === 'sheet' && looseSingles.length) return slice(looseSingles);

  const extras = (String(fid).startsWith('ch:') && absorbedSingles.get(String(fid).slice(3))) || [];
  if (!extras.length) return db.pageFolder(scope, fid, { offset, limit });
  const eSlice = extras.slice(offset, offset + limit);
  const consumed = Math.min(extras.length, offset);        // extras already shown
  const res = await db.pageFolder(scope, fid, { offset: offset - consumed, limit: limit - eSlice.length });
  return { items: [...eSlice, ...res.items], total: res.total + extras.length };
}

/**
 * v1.0.25 — the video AFTER `current`, in the order the child is looking at.
 *
 * Lives inside pageAnyFolder's region deliberately: that is the one pagination entry
 * point (invariants.test.mjs pins `db.pageFolder`/`db.pageGifts` to these lines), and a
 * second renderer growing its own private branch is the v1.0.21 bug that rule exists for.
 * "Next" must mean the tile that follows on screen, or the chain disagrees with the grid.
 *
 * The plain branch uses pageFolder's KEYSET mode — O(1) at any depth, and until now it
 * had no caller at all. Loading the whole folder to find one index would read 2000
 * records at the end of every video on a low-end tablet.
 */
async function nextAfter(scope, fid, current) {
  if (!scope || !fid || !current || !current.key) return null;
  // 🎁 is never chained (planAutoplay stops first); it is also not a stored folder, so
  // there is no cursor to advance here even if it were.
  if (fid === 'new') return null;
  // ⭐ IS chained: it is an ordinary list of live videos, and "watch my favourites one
  // after another" is the whole point of the folder. Derived from the same ordered keys
  // the grid renders, so the chain can never disagree with what is on screen.
  if (fid === 'fav') {
    const keys = favouriteKeys(giftStates);
    const at = keys.indexOf(current.key);
    if (at < 0 || at + 1 >= keys.length) return null;
    return db.findLiveByKey(keys[at + 1], [libScope, db.profScope(activeProfileId)].filter(Boolean));
  }
  // v1.0.57 — 🕒 IS CHAINED, BUT ONLY OFF THE FROZEN SNAPSHOT. This folder is ordered by
  // "most recently watched", so watching a video MOVES IT TO THE FRONT: a live re-read here
  // would find the just-watched video at index 0 and hand back index 1 — the video before
  // it — and the chain would rock between the same two videos forever. `watchCtx.recent` is
  // the order as it stood when the child entered, which is also the order the grid under
  // the player is showing them.
  if (fid === 'recent') {
    const keys = watchCtx.recent || [];
    const at = keys.indexOf(current.key);
    if (at < 0 || at + 1 >= keys.length) return null;
    return db.findLiveByKey(keys[at + 1], [libScope, db.profScope(activeProfileId)].filter(Boolean));
  }
  if (String(fid).startsWith('grp:')) return nextInOrder(singleGroups.get(String(fid).slice(4)) || [], current.key);
  if (fid === 'sheet' && looseSingles.length) return nextInOrder(looseSingles, current.key);

  // A channel folder shows its absorbed singles FIRST, then the channel's own videos.
  const extras = (String(fid).startsWith('ch:') && absorbedSingles.get(String(fid).slice(3))) || [];
  const at = extras.findIndex((v) => v && v.key === current.key);
  if (at >= 0) {
    if (at + 1 < extras.length) return extras[at + 1];
    const first = await db.pageFolder(scope, fid, { offset: 0, limit: 1 }); // cross into the channel's own
    return first.items[0] || null;
  }
  if (!Number.isFinite(Number(current.sortKey))) return null; // no cursor to resume from
  const res = await db.pageFolder(scope, fid, { after: { sortKey: current.sortKey, key: current.key }, limit: 1 });
  return res.items[0] || null;
}

/** Render one page of videos of (scope, folderId) into a grid ('home' or 'folder'). */
/**
 * v1.0.62 — `pageOverride`/`silent` exist for the swipe's GHOST: the neighbouring page is
 * rendered into a detached element while the finger is moving. `silent` is what keeps that
 * render from touching the pager — the ghost is a preview, and moving the pager before the
 * child has committed would say the page already turned.
 */
async function renderGridPage(grid, scope, fid, which, pageOverride = null, silent = false) {
  const pg = pageOverride == null ? (which === 'home' ? page : folderPage) : pageOverride;
  // v1.0.61 — A FOLDER MAY HOLD FOLDERS, and they share ONE pager with its videos, folders
  // first. `pageAnyFolder`/`nextAfter` are deliberately untouched: the concatenation lives
  // here, so neither grows a nesting branch and their "they cover the same kinds" invariant
  // stays literally true. The child tiles are taken from `folders` (already built, already
  // hidden-at-zero) rather than re-read, so the grid can never disagree with the home.
  const kids = which === 'home' ? [] : folders.filter((f) => f.parentFolderId === fid);
  const slots = folderPageSlots({ childCount: kids.length, page: pg, pageSize: PAGE_SIZE });
  // ⚠️ CALLED EVEN WHEN videoLimit IS 0 (a page of pure folder tiles): `res.total` is what
  // sizes the pager. db.pageFolder answers {items: [], total} for a zero limit — the
  // v1.0.58 zero-limit fix is what makes this shape safe.
  const res = await pageAnyFolder(scope, fid, { offset: slots.videoOffset, limit: slots.videoLimit });
  const total = which === 'home'
    ? Math.max(1, Math.ceil(res.total / PAGE_SIZE))
    : folderPageTotal({ childCount: kids.length, videoTotal: res.total, pageSize: PAGE_SIZE });
  grid.innerHTML = '';
  for (const f of kids.slice(slots.folderOffset, slots.folderOffset + slots.folderSlots)) {
    grid.appendChild(folderTile(f));
  }
  for (const rec of res.items) grid.appendChild(tileEl(rec));
  if (silent) return;
  // v1.0.62 — tell any live swipe that the grid it was translating has been rebuilt under
  // the finger (a sync landing, a Drive pull applying). Without it the drag would keep
  // moving a page that no longer exists, beside a ghost of one that never did.
  announceGridRender(grid);
  if (which === 'home') updateHomePager(total);
  else folderPagerObj.update(folderPage, total);
}

/** v1.0.62 — see ui/swipe.js: a grid rebuilt mid-gesture must drop the drag. */
function announceGridRender(grid) {
  // dispatched on the GRID, never its viewport: events bubble UP, and on the watch screen
  // the swipe host IS the grid — a viewport-level event would never reach the listener.
  try { grid.dispatchEvent(new CustomEvent('kp:gridrender', { bubbles: true })); } catch {}
}

/* ---------------- Search (v1.0.7) ---------------- */
// The kid searches the APPROVED library only (live records + visible channel folders)
// — no network, no external content; ranking is pure (search.js, node-tested).
let searchIndex = null; // { videos: [records], folders: [{...folder, normTitle}] }
let searchFolderId = null; // v1.0.58: set while the search screen is scoped to one folder
let searchTimer = null;

async function buildSearchIndex() {
  const videos = [];
  const scopes = [libScope, activeProfileId ? db.profScope(activeProfileId) : null].filter(Boolean);
  for (const s of scopes) {
    for (const rec of (await db.loadMergeIndex(s)).values()) {
      if (rec.state === 'live') videos.push(rec);
    }
  }
  // v1.0.18 — DERIVED FROM `folders`, THE SAME LIST THE HOME SCREEN RENDERS.
  //
  // This used to re-derive channel folders from listLibraryChannels + countFolder and
  // skip any whose count was 0. But buildFolders deliberately PUBLISHES such a folder
  // when absorbedSingles has entries for it ("subscribed, nothing imported yet, but
  // loose singles live here"), and it adds those singles to the count of the folders
  // that do have imports. So a folder could sit on the child's home screen holding two
  // videos and be unfindable by name, and every absorbed count was understated — the
  // v1.0.17 fix closed this for 🎞️ groups but left it open for 📺 channels.
  // One source of truth removes the whole class: if it is on the home screen, it is
  // searchable, with the count the child can see. `folders` already excludes hidden
  // channels (buildFolders), and non-channel tiles (🎁 חדשים, the shared 'sheet'
  // folder) are filtered out here because they are not channel names to search for.
  const folderEntries = [];
  if (libScope) {
    for (const f of folders) {
      const id = String(f.id || '');
      const isGroup = id.startsWith('grp:');
      // v1.0.26: playlist folders are searchable too — a parent looking for "שירי בוקר"
      // must find the playlist by name exactly as they find a channel.
      // v1.0.56: and a PARENT-CREATED folder, for the same reason — it is a name on the
      // home screen, and the one-source-of-truth rule above says anything on the home
      // screen must be findable by that name.
      if (!isGroup && !id.startsWith('ch:') && !id.startsWith('pl:') && !f.custom) continue;
      const title = f.title || '';
      if (!title) continue;
      folderEntries.push({
        id, scope: f.scope || libScope,
        key: (isGroup ? 'group:' : 'folder:') + id.slice(id.indexOf(':') + 1),
        title, normTitle: normalizeTitle(title),
        logoUrl: f.logoUrl || '', emoji: f.emoji || (isGroup ? '🎞️' : '📺'),
        count: f.count || 0,
        // the search result renders through the same tile path as the home
        custom: !!f.custom, artThumbId: f.artThumbId || null
      });
    }
  }
  searchIndex = { videos, folders: folderEntries };
}

/**
 * v1.0.58 — SEARCH INSIDE A FOLDER (user request), reusing the home's search screen rather
 * than growing a second one: same input, same ranking (`search.rankItems`), same result
 * tiles. Only the INDEX is different, and that is the whole feature.
 *
 * THE CANDIDATES COME FROM `pageAnyFolder`, NOT FROM A SECOND READING OF THE FOLDER RULES.
 * That function is THE pagination entry point and already knows every folder kind — the
 * gift and ⭐ views that carry no `folderId`, a channel's absorbed singles, the trimmed
 * loose list. Filtering the merge index by folderId instead would have been a second answer
 * to "what is in this folder", and the two would disagree exactly where it hurts (the
 * v1.0.21 lesson, which cost the child every way out of a gift).
 *
 * Bounded by config caps: a folder search must never become "load the family's library".
 */
async function buildFolderSearchIndex(fid) {
  const locked = !!(containState.active && containState.mode === 'folder');
  const customRows = libScope ? await db.listCustomFolders(libScope).catch(() => []) : [];
  const ids = folderSearchScope({ folderId: fid, customRows, locked });
  const seen = new Set();
  const videos = [];
  for (const id of ids) {
    if (videos.length >= FOLDER_SEARCH_MAX_TOTAL) break;
    let res = null;
    try {
      res = await pageAnyFolder(scopeForFolder(id), id, { offset: 0, limit: FOLDER_SEARCH_MAX_PER_FOLDER });
    } catch { res = null; }
    for (const rec of (res && res.items) || []) {
      if (!rec || !rec.key || seen.has(rec.key)) continue;   // one video, two folders: once
      seen.add(rec.key);
      videos.push(rec);
      if (videos.length >= FOLDER_SEARCH_MAX_TOTAL) break;
    }
  }
  // The NESTED FOLDERS are results too (the user's decision): in a 32-disc collection,
  // typing the disc's name should open it in one tap. Never under a folder lock — a folder
  // result is a way to reach another folder, which is the one thing the lock forbids, and
  // never the folder the child is already standing in.
  const folderEntries = [];
  if (!locked) {
    for (const id of ids) {
      if (id === fid) continue;
      const f = folders.find((x) => x.id === id);
      if (!f || !f.title) continue;
      folderEntries.push({
        id, scope: f.scope || libScope,
        key: 'folder:' + id.slice(id.indexOf(':') + 1),
        title: f.title, normTitle: normalizeTitle(f.title),
        logoUrl: f.logoUrl || '', emoji: f.emoji || '📁', count: f.count || 0,
        custom: !!f.custom, artThumbId: f.artThumbId || null
      });
    }
  }
  searchIndex = { videos, folders: folderEntries };
}

/**
 * v1.0.58 — open the shared search screen SCOPED to one folder. `searchFolderId` is what
 * every later render keys off, and it is cleared by the home's own search (openSearch), so
 * the two can never blur into each other.
 */
async function openFolderSearch() {
  if (!folderId) return;
  searchFolderId = folderId;
  searchIndex = null;
  nav.go('search');
  const f = folders.find((x) => x.id === folderId);
  const name = (f && f.title) || '';
  $('search-input').value = '';
  $('search-input').placeholder = name ? `חיפוש ב"${name}" 🔍` : 'מה מחפשים? 🔍';
  $('search-results').innerHTML = '';
  $('search-empty').classList.add('hidden');
  buildFolderSearchIndex(folderId).catch(() => {});
  setTimeout(() => { try { $('search-input').focus(); } catch {} }, 60);
}

async function openSearch() {
  searchIndex = null;
  searchFolderId = null; // v1.0.58: the home's search is never scoped to a folder
  nav.go('search');
  $('search-input').value = '';
  $('search-input').placeholder = 'מה מחפשים? 🔍';
  $('search-results').innerHTML = '';
  $('search-empty').classList.add('hidden');
  buildSearchIndex().catch(() => {});
  setTimeout(() => { try { $('search-input').focus(); } catch {} }, 60);
}

async function renderSearchResults() {
  if (!searchIndex) {
    // v1.0.58: whichever index this screen was opened for — a folder search that had to
    // rebuild must never silently fall back to the whole library.
    try { await (searchFolderId ? buildFolderSearchIndex(searchFolderId) : buildSearchIndex()); }
    catch { return; }
  }
  const q = $('search-input').value;
  // channel folders first (few, big targets), then videos by match accuracy
  const folderHits = rankItems(q, searchIndex.folders, { limit: 6 });
  const videoHits = rankItems(q, searchIndex.videos, { limit: 24 });
  const grid = $('search-results');
  grid.innerHTML = '';
  for (const { item } of folderHits) grid.appendChild(folderTile(item));
  for (const { item } of videoHits) grid.appendChild(tileEl(item));
  $('search-empty').classList.toggle(
    'hidden',
    !(normalizeTitle(q).length >= 2 && !folderHits.length && !videoHits.length)
  );
}

/* ---------------- Folder view ---------------- */
async function openFolder(fid) {
  // v1.0.56 — THE FOLDER LOCK IS ENFORCED HERE, not only by hiding buttons. A relaunch
  // renders the home for an instant, the TV remote can reach a tile, and a search result
  // carries a folder id — every one of those is a way into another folder unless the OPEN
  // itself refuses. Hiding chrome is the affordance; this is the boundary.
  // v1.0.61 — the test is ANCESTRY, not equality: a child locked into a collection must be
  // able to open the discs inside it, and nothing else. `folderWithinLock` errs strict — an
  // unknown folder is out of bounds — so a stale id still lands back on the locked folder.
  if (containState.active && containState.mode === 'folder' && containState.folderId
      && !folderWithinLock(fid, containState.folderId, customFolderRows)) {
    fid = containState.folderId;
  }
  folderId = fid;
  folderPage = 0;
  paintFolderHeader(fid);
  nav.go('folder', { folderId: fid, page: 0 }); // its onEnter renders the grid (v1.0.32)
}

/**
 * v1.0.61 — the folder's name and picture, painted from the folder id ALONE.
 *
 * It used to live inline in `openFolder`, which is fine while a folder screen is only ever
 * entered from a tile. Nested, `folder` sits on the stack twice and a back-pop re-renders
 * the grid WITHOUT going through openFolder — so the collection's discs appeared under the
 * disc's name. Found in the browser: the grid was right, the header lied.
 */
function paintFolderHeader(fid) {
  const f = folders.find((x) => x.id === fid)
    || (searchIndex && searchIndex.folders.find((x) => x.id === fid)); // opened from search
  $('folder-title').textContent = f ? (f.isNew ? 'חדשים 🎁' : f.isFav ? 'מועדפים ⭐' : f.title) : '';
  // v1.0.4: the channel's logo (or the folder emoji) next to the name — the child
  // always sees WHICH channel they're inside.
  const logoTop = $('folder-logo-top');
  logoTop.innerHTML = '';
  if (f && f.custom) { // v1.0.56 — the parent's own picture, from the byte cache
    mountCustomArt(logoTop, f.artThumbId, f.emoji || '📁');
    logoTop.classList.remove('hidden');
  } else if (f && f.art) { // v1.0.40 — the ⭐ folder's drawn scene, same art as its tile
    mountFolderArt(logoTop, f.art, f.emoji || '🎬');
    logoTop.classList.remove('hidden');
  } else if (f && (f.logoUrl || f.channelId)) { // v1.0.32: cached bytes render even URL-less
    mountChannelLogo(logoTop, f.logoUrl, f.channelId, f.emoji || '📺');
    logoTop.classList.remove('hidden');
  } else if (f && f.emoji && !f.isNew) {
    logoTop.textContent = f.emoji;
    logoTop.classList.remove('hidden');
  } else {
    logoTop.classList.add('hidden');
  }
}

async function renderFolderView() {
  if (!folderPagerObj) {
    folderPagerObj = makePager({
      mount: $('folder-pager'),
      // v1.0.61 — the page is written back onto the STACK ENTRY, so walking into a disc and
      // pressing back returns the parent to the page of discs they were on. Without it the
      // entry's params still say page 0 and its onEnter would drag the child to the top of
      // a 32-disc list every time they came out of one.
      onChange: async (p) => {
        folderPage = p;
        const e = nav.current();
        if (e && e.name === 'folder' && e.params) e.params.page = p;
        await renderFolderView();
      }
    });
  }
  paintFolderHeader(folderId);   // a back-pop never runs openFolder — see paintFolderHeader
  await renderGridPage($('folder-grid'), scopeForFolder(folderId), folderId, 'folder');
}

/* ---------------- Watch ---------------- */
// F4: the under-player grid is PAGINATED (6 tiles/page) — the old render-everything
// was the page's lag source with hundreds of tiles. The playing item stays in the
// grid (marked) so pagination is stable while switching videos.
let watchPage = 0;
let watchPager = null;

/**
 * v1.0.62 — one page of the under-player grid into ANY element, for the swipe's ghost.
 * It reuses the FROZEN recent snapshot (`watchCtx.recent`) for the same reason the live
 * grid does: 🕒 reorders itself after every video, and a preview that re-read the live
 * order would show the child a page they are not about to get.
 */
async function paintWatchPage(target, pageIndex, current) {
  const scope = watchCtx.scope;
  const fid = watchCtx.folderId;
  if (!scope || !fid) { target.innerHTML = ''; return; }
  const res = await pageAnyFolder(scope, fid, {
    offset: pageIndex * PAGE_WATCH, limit: PAGE_WATCH, recentSnapshot: watchCtx.recent || null
  });
  target.innerHTML = '';
  for (const rec of res.items) {
    const tile = tileEl(rec);
    if (current && rec.key === current.key) tile.classList.add('tile-current');
    target.appendChild(tile);
  }
}

async function renderWatchGrid(current) {
  if (!watchPager) watchPager = makePager({ mount: $('watch-pager'), onChange: (p) => { watchPage = p; renderWatchGrid(currentWatch); } });
  const grid = $('watch-grid');
  // Same-folder browsing (user decision): the grid pages the folder the child came
  // from. A gift opened from "חדשים" browses its ORIGIN folder (rec.folderId).
  const scope = watchCtx.scope;
  let fid = watchCtx.folderId;
  if (!scope || !fid) { grid.innerHTML = ''; watchPager.update(0, 1); return; }
  // v1.0.40 — ⭐ IS A VIEW, NOT A FOLDER, and the child can empty it from this very screen:
  // un-starring the video they are watching removes it from the list the grid is paging. If
  // that leaves ⭐ with nothing, fall back to where the video actually LIVES, so the child
  // keeps a populated grid instead of staring at an empty one. Exactly the fix the 🎁 folder
  // needed for the same reason (v1.0.21, resolveWatchContext) — a gift leaves 🎁 the moment
  // it is unwrapped.
  if (fid === 'fav' && !favouriteKeys(giftStates).length) {
    fid = (current && (current.homeFolderId || current.folderId)) || fid;
    watchCtx = { scope, folderId: fid };
  }
  // v1.0.57 — the same fallback for 🕒, reachable for a different reason: the folder can be
  // emptied under the child by the parent turning it off on ANOTHER device mid-video (the
  // setting is synced), or by its videos being deleted. An empty snapshot means an empty
  // grid, which is the v1.0.21 bug — the child loses every way to pick the next video.
  if (fid === 'recent' && !(watchCtx.recent || []).length) {
    fid = (current && (current.homeFolderId || current.folderId)) || fid;
    watchCtx = { scope, folderId: fid };
  }

  const res = await pageAnyFolder(scope, fid, {
    offset: watchPage * PAGE_WATCH, limit: PAGE_WATCH, recentSnapshot: watchCtx.recent || null
  });
  const total = Math.max(1, Math.ceil(res.total / PAGE_WATCH));
  if (watchPage >= total) watchPage = total - 1;

  grid.innerHTML = '';
  for (const rec of res.items) {
    const tile = tileEl(rec);
    if (current && rec.key === current.key) tile.classList.add('tile-current');
    grid.appendChild(tile);
  }
  announceGridRender(grid);   // v1.0.62
  watchPager.update(watchPage, total);
}

/**
 * v1.0.16: a video that ENDED returns the child to where they came from — the
 * folder, the search results, or home — never unconditionally to home (that was the
 * bug: a video finishing inside a folder dumped the child on the home screen).
 * Fullscreen is always released first, so the folder is actually visible.
 */
function leaveWatch() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {}
  }
  // nav.back() pops the watch entry and restores the previous view's scroll;
  // if watch is somehow the only entry, home is the safe floor.
  if (!nav.back()) goGallery();
}

/* ---------------- Continuous play (v1.0.25) ----------------
 * OFF by default, per child, synced. The decision itself is pure `planAutoplay`
 * (playerlogic.js) — read its comment for the 🎁 rule and the failure ceiling.
 * Everything here is the DOM half: a countdown the child can stop, and the chain state.
 */
let autoplayTimer = null;
let autoplayFailures = 0;   // CONSECUTIVE; a video that plays resets it
let autoplayRetriedKey = null;

/** Called on every exit from the watch view, and before every new video starts. */
function cancelAutoplay() {
  clearInterval(autoplayTimer);
  autoplayTimer = null;
  const el = $('autoplay-next');
  if (el) el.classList.add('hidden');
}

function resetAutoplayChain() {
  cancelAutoplay();
  autoplayFailures = 0;
  autoplayRetriedKey = null;
}

/**
 * Count down in front of the child, then play `item`.
 *
 * The countdown is not decoration: continuous play keeps the app in fullscreen, where the
 * 🏠 button lives OUTSIDE the player and is therefore invisible (v1.0.2). Without this the
 * only way out is Android's back gesture, which in immersive mode needs an edge swipe a
 * 5-year-old does not know. `retry` reuses the same overlay with no thumbnail change —
 * the child does not need to know a video failed, only that something is about to happen.
 */
function countdownThen(item, ms) {
  cancelAutoplay();
  const el = $('autoplay-next');
  const img = $('autoplay-thumb');
  img.src = item.thumbUrl || PLACEHOLDER;
  img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER; };
  $('autoplay-title').textContent = item.title || '';
  el.classList.remove('hidden');

  let left = Math.max(1, Math.ceil(ms / 1000));
  $('autoplay-count').textContent = String(left);
  autoplayTimer = setInterval(() => {
    left -= 1;
    if (left > 0) { $('autoplay-count').textContent = String(left); return; }
    cancelAutoplay();
    // The child may have navigated away while it ticked — never yank them back.
    if (!nav.isActive('watch')) { resetAutoplayChain(); return; }
    openWatch(item).catch(() => { resetAutoplayChain(); leaveWatch(); });
  }, 1000);
}

/**
 * A video finished. This replaces the old unconditional `leaveWatch()`.
 * @param reason 'ended' | 'error', from player.js
 */
async function onVideoFinished(reason = 'ended') {
  const item = currentWatch;
  if (!item) { leaveWatch(); return; }

  // v1.0.32: a video that ENDED starts fresh next time — its saved position (and the
  // tile's progress bar) is gone. Player teardown already ran, so playbackState() is
  // null and no later save can resurrect it. An 'error' exit keeps the position.
  if (reason === 'ended' && resumeEnabled) clearWatchPosition(item);

  // v1.0.57 — a video that ENDED was watched, whatever its length: the interval's
  // RECENT_MIN_PLAY_SEC threshold can never be reached by a 6-second clip, and the player
  // is already torn down here so `playbackState()` is null. `force` is what says "the
  // evidence is that it finished", not a bypass of the rule.
  if (reason === 'ended') stampWatched(item, { force: true });

  let enabled = false;
  try { enabled = (await getSetting(activeProfileId, 'autoplay', false)) === true; } catch {}
  // The child can leave during those awaits; anything after this point would act on a
  // screen they are no longer looking at.
  if (!nav.isActive('watch')) { resetAutoplayChain(); return; }

  let next = null;
  if (enabled) {
    try { next = await nextAfter(watchCtx.scope, watchCtx.folderId, item); } catch { next = null; }
    if (!nav.isActive('watch')) { resetAutoplayChain(); return; }
  }

  // A wrapped gift is a deliberate tap, never something a chain opens for the child.
  const nextState = next ? giftStates.get(next.key) : null;
  const plan = planAutoplay({
    enabled,
    folderId: watchCtx.folderId,
    reason,
    failures: autoplayFailures,
    retriedCurrent: autoplayRetriedKey === item.key,
    hasNext: !!next,
    nextIsGift: !!(nextState && nextState.giftRank && !nextState.unwrappedAt)
  });

  if (plan.action === 'stop') { resetAutoplayChain(); leaveWatch(); return; }
  // Count the failure only once the decision is made, so `failures` is what the NEXT
  // call sees rather than something this call already acted on.
  autoplayFailures = reason === 'error' ? autoplayFailures + 1 : 0;

  if (plan.action === 'retry') {
    autoplayRetriedKey = item.key;
    countdownThen(item, AUTOPLAY_RETRY_MS);
    return;
  }
  autoplayRetriedKey = null;
  countdownThen(next, AUTOPLAY_COUNTDOWN_MS);
}

/** Enter fullscreen on the player. MUST be called synchronously inside the tap's
    user-activation window — after an await the browser may deny the request. */
function enterPlayerFullscreen() {
  try {
    const el = $('player-wrap');
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    if (el.requestFullscreen) { const p = el.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch { /* embedded webviews may deny — playing inline is a fine fallback */ }
}

/* ---------------- favourites (v1.0.40) ---------------- */
/**
 * The ⭐ button's two states. `giftStates` mirrors the whole per-video state store, so this
 * is a synchronous lookup — the button must be correct in the same frame the video opens,
 * or the child sees an empty star over a video they already starred.
 */
function paintFavButton(key) {
  const btn = $('watch-fav');
  if (!btn) return;
  const on = favActive(giftStates.get(key));
  btn.textContent = on ? '⭐' : '☆';
  btn.classList.toggle('is-fav', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.setAttribute('aria-label', on ? 'להסיר מהמועדפים' : 'להוסיף למועדפים');
}

/**
 * The child's own toggle — no PIN, no confirm. It is not destructive in either direction:
 * the video stays exactly where it lives, ⭐ is an ADDITIONAL place to find it (the user's
 * request), and a second tap removes it again.
 *
 * The write goes through `db.setFavourite`, which records a REMOVAL as its own timestamp
 * rather than clearing the field — see plan.favActive for why an un-favourite has to be an
 * event that can travel between devices.
 */
async function toggleFavourite() {
  if (!activeProfileId || !currentWatch || !currentWatch.key) return;
  const key = currentWatch.key;
  const now = Date.now();
  const on = !favActive(giftStates.get(key));
  // mirror in memory FIRST so the button and the home agree immediately; the IDB write
  // and the render follow (the same order tileEl's gift state relies on)
  const st = giftStates.get(key) || { profileId: activeProfileId, key };
  giftStates.set(key, on ? { ...st, favAt: now } : { ...st, favOffAt: now });
  paintFavButton(key);
  try {
    await db.setFavourite(activeProfileId, key, on, now);
    maybeSchedulePush(); // a star is a child decision and belongs on every device
  } catch {
    giftStates.set(key, st); // put the memory back — the button must not lie
    paintFavButton(key);
    toast('לא הצלחנו לשמור. אפשר לנסות שוב');
    return;
  }
  toast(on ? 'נוסף למועדפים ⭐' : 'הוסר מהמועדפים');
  // the ⭐ folder's count and existence change with this, and the child may be looking at
  // the home behind the player (the under-player grid renders from the same folders)
  renderWatchGrid(currentWatch);
}

/* ---------------- background playback (v1.0.63) ---------------- */

/**
 * Arm or refresh the foreground service for the video now playing.
 *
 * ⚠️ CALLED WHILE THE APP IS FOREGROUND. Since API 31 a backgrounded app may not start a
 * foreground service at all, so this runs when an eligible video OPENS — not when the
 * screen goes off, which is already too late.
 */
/**
 * v1.0.65 — what the lock screen and a car display show BESIDE the title: the folder the
 * child is in. One helper, so the notification, the widget and the car can never disagree —
 * and it reuses `folders`, the list the home screen renders, rather than reading the folder
 * rules a second time.
 */
function backgroundSubtitle() {
  const fid = watchCtx.folderId;
  if (!fid) return '';
  const f = folders.find((x) => x.id === fid);
  return (f && f.title) || '';
}

/**
 * v1.0.66 — the picture for the notification, the lock-screen widget and a car display,
 * as base64. -> '' when there is nothing, and the system shows the app icon.
 *
 * ⚠️ MOST AUDIO FILES HAVE NO PICTURE OF THEIR OWN. `captureFrame` returns null for a track
 * with no video (v1.0.56), so an mp3 — the whole point of background playback — never gets a
 * thumbnail. The FOLDER's picture is the honest stand-in: the parent chose it, it is usually
 * present, and it is what the child sees on the tile they tapped.
 *
 * Read once per track. The bytes cross the bridge as base64 because the picture lives in
 * IndexedDB inside the WebView, which the service cannot open.
 */
async function backgroundArtwork(item) {
  const ids = [];
  if (item && item.thumbId) ids.push(item.thumbId);
  const f = folders.find((x) => x.id === watchCtx.folderId);
  if (f && f.artThumbId) ids.push(f.artThumbId);
  for (const id of ids) {
    try {
      const blob = await db.getThumbBlob(id);
      if (!blob) continue;
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (!buf.length || buf.length > BG_ART_MAX_BYTES) continue;
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin);
    } catch { /* a picture is a nicety — never let it break playback */ }
  }
  return '';
}

async function armBackgroundPlayback(item) {
  const want = backgroundPlayDecision({ enabled: bgPlayEnabled, playing: true, item });
  if (!want.play) { await disarmBackgroundPlayback(); return; }
  const st = playbackState();
  const ok = await startBackgroundPlayback(item.title || '', true, {
    subtitle: backgroundSubtitle(), artB64: await backgroundArtwork(item),
    posSec: st && st.time, durSec: st && st.duration
  });
  bgPlayLive = !!ok;
}

/**
 * v1.0.74 — republish the session state, so the lock-screen widget, the notification and a
 * car all show what is ACTUALLY happening.
 *
 * Reported from a device: the widget showed ⏸ (i.e. "playing, press to pause") over a track
 * that had finished — because the state was only ever published when the notification's own
 * buttons were pressed. A pause from the screen, a call, or a track ending changed nothing.
 *
 * Cheap and idempotent: it does nothing unless the service is actually running.
 */
async function republishBackgroundState(playing) {
  if (!bgPlayLive || !currentWatch) return;
  const st = playbackState();
  await startBackgroundPlayback(currentWatch.title || '', playing, {
    subtitle: backgroundSubtitle(), artB64: await backgroundArtwork(currentWatch),
    posSec: st && st.time, durSec: st && st.duration
  }).catch(() => {});
}

async function disarmBackgroundPlayback() {
  if (!bgPlayLive) return;
  bgPlayLive = false;
  await stopBackgroundPlayback().catch(() => {});
}

/**
 * A ⏮/⏯/⏭ tap on the notification. Every decision stays in JS — the service knows nothing
 * about folders, gifts or the end of a list.
 *
 * The state is RE-READ after the awaits (the v1.0.57 call-resume rule): the parent can tap
 * ⏭ seconds after the child left the video, a scheduled break can have taken the screen,
 * and starting a video then would be a surprise noise rather than a control.
 */
async function handlePlaybackCommand(action) {
  if (!bgPlayEnabled || !currentWatch) return;
  if (action === 'toggle') {
    const st = playbackState();
    if (!st) return;
    // v1.0.72 — the notification's ⏯ is a person pressing pause, exactly like the centre
    // tap: a call must not resume a song they deliberately stopped from the lock screen.
    markUserToggle(st.playing);
    // the republish rides the player's own play/pause event (onPlayState), so it reports
    // what actually happened rather than what we asked for — a play() the browser refuses
    // must not leave the widget claiming the track is running.
    if (st.playing) pauseCurrent(); else resumeCurrent();
    return;
  }
  // v1.0.68 — ⏪/⏩ move INSIDE the track (user request, replacing skip-track). The seek is
  // clamped inside player.seekRelative, which is the invariant this app has already paid
  // for once: an unclamped forward seek runs past the end and EJECTS the child from the
  // video. Nothing is awaited before it, so the position cannot go stale under us.
  if (action !== 'fwd' && action !== 'back') return;
  if (seekRelative(action) === null) return;
  const st = playbackState();
  if (!st) return;
  // republish, or the car's progress bar keeps extrapolating from the OLD position. A seek
  // fires no play/pause event, so this is the one place that still asks explicitly.
  await republishBackgroundState(st.playing);
}

async function openWatch(item) {
  // v1.0.32: switching video→video — bank the OLD video's stop point BEFORE playItem
  // reuses or tears down the player (the clock goes with it).
  if (currentWatch && currentWatch.key !== item.key) saveWatchPosition(currentWatch);
  currentWatch = item;
  armScheduledLock().catch(() => {}); // v1.0.31: first video arms the screen-time countdown
  // A tap during the continuous-play countdown wins over the queued video. Synchronous
  // and BEFORE the fullscreen request, so it cannot cost the tap its user activation.
  cancelAutoplay();
  // Tapping a video goes straight to fullscreen (user request). Synchronous — still
  // inside the tap gesture. Exiting fullscreen (back / ⛶) lands on the watch page,
  // where the 🏠 button lives.
  // v1.0.73 — an AUDIO file does not (user request): there is nothing to fill the screen
  // with but the music scene, and doing so hides the seek bar and the way back. The call
  // stays SYNCHRONOUS and unawaited either way — the tap's user activation is spent by the
  // first await, and a conditional costs nothing.
  if (opensFullscreen(item)) enterPlayerFullscreen();
  // watch-grid context: the record's own folder (or where the child was browsing)
  // v1.0.12: when the child came from a FOLDER view, browse THAT folder — virtual
  // 🎞️ group folders aren't stored on the record, so item.folderId can't express
  // them. video→video from the under-player grid keeps the existing context.
  // …and 🎁 'new' is a VIEW, not a folder: paging it after the gift is unwrapped came up
  // short or empty, so a gift browses where the video actually lives (resolveWatchContext).
  // captured BEFORE resolveWatchContext replaces the object (v1.0.57 — the 🕒 snapshot)
  const wasWatching = nav.isActive('watch');
  const prevRecent = watchCtx && watchCtx.recent;
  watchCtx = resolveWatchContext({
    item,
    isWatching: nav.isActive('watch'),
    prevFolderId: nav.isActive('watch') ? watchCtx.folderId : folderId,
    folderViewId: nav.isActive('folder') ? folderId : null,
    libScope,
    profileScope: db.profScope(activeProfileId)
  });
  // v1.0.57 — 🕒 IS FROZEN ON ENTRY AND CARRIED ACROSS VIDEO→VIDEO SWITCHES.
  //
  // This folder is ordered by "most recently watched", so every video the child finishes
  // REORDERS it — and the grid under the player, the ✋ chain and `nextAfter` all read it.
  // Re-reading it on a switch is what makes the chain rock: enter at [A,B,C], tap B, B moves
  // to the front → "next after B" becomes A, watch A → A moves to the front → "next after A"
  // is B again, forever. So the order is captured where the child's journey through this
  // folder STARTS, and `resolveWatchContext` (which replaces watchCtx wholesale, dropping
  // anything hung on it) must not be allowed to lose it mid-journey.
  watchCtx.recent = watchCtx.folderId !== 'recent' ? null
    : (wasWatching && prevRecent) || recentKeys(giftStates, recentLimit);
  stampedWatch = null; // a new opening earns its own stamp (the same video, watched again, counts)
  // replace() when already watching: back always returns to the gallery, never
  // through the chain of watched videos. nav scrolls to top — the F4 fix: the
  // user actually SEES the player instead of staying scrolled at the grid.
  if (nav.isActive('watch')) nav.replace('watch', { key: item.key }); // keep the child's grid page
  else { watchPage = 0; nav.go('watch', { key: item.key }); }
  const status = $('watch-status');
  status.classList.add('hidden');
  status.textContent = '';
  setWatchTitle(item);
  setWatchChannel(item); // v1.0.53 — the fullscreen overlay's channel line
  paintFavButton(item.key); // v1.0.40 — ⭐ on/off for THIS video
  renderWatchGrid(item);
  // v1.0.63 — arm (or tear down) the background service for THIS video, HERE, while the app
  // is provably foreground: API 31+ forbids starting a foreground service from the
  // background, so waiting for the screen to go off would be too late. A YouTube video, or
  // the setting being off, disarms instead — the notification must never outlive its video.
  armBackgroundPlayback(item).catch(() => {});

  // v1.0.32: resume — the pure decision; 0 whenever the setting is off, nothing usable
  // is stored, or the stored stop is inside the tail. giftStates mirrors the whole
  // profileVideoState store, so this is a sync lookup, not an IDB read.
  const stored = giftStates.get(item.key);
  const startAt = resumeStartAt({
    enabled: resumeEnabled,
    posSec: stored && stored.posSec,
    durSec: stored && stored.durSec
  });
  // …and while watching, bank the playhead every few seconds: a process killed while the
  // screen is off must still know where the child stopped.
  clearInterval(posTimer);
  posTimer = setInterval(() => {
    if (!nav.isActive('watch') || !currentWatch) return;
    saveWatchPosition(currentWatch);
    stampWatched(currentWatch); // v1.0.57 — 🕒, independent of the resume setting
    // v1.0.57 — THE CALL THAT NEVER BACKGROUNDS THE APP. On a modern Android an incoming
    // call is a heads-up notification: the ringtone takes audio focus, the WebView pauses
    // its media, and no `appStateChange` ever fires — so the lifecycle door above would
    // miss it entirely and the video would sit frozen. Asked only when the video is NOT
    // playing (a bridge call per tick while playing would be pure waste), never once armed
    // (the fast poll owns it from then on), and never for a video THIS APP parked because
    // nobody answered "עדיין צופים?".
    const st = playbackState();
    if (st && !st.playing && !callResume && !idleParkedAt) checkCallResume().catch(() => {});
  }, RESUME_SAVE_MS);

  await playItem(item, $('player-host'), {
    startAt,
    // v1.0.74 — the lock screen and the car follow the REAL state, not just the last button
    // pressed on the notification
    onPlayState: (playing) => { republishBackgroundState(playing).catch(() => {}); },
    onExit: (reason) => { if ($('view-watch').classList.contains('active')) onVideoFinished(reason).catch(() => leaveWatch()); },
    onStatus: (s) => {
      if (!s) { status.classList.add('hidden'); status.textContent = ''; return; }
      status.textContent = s === 'downloading' ? 'טוען את הסרטון… רגע אחד ⏳'
        : s === 'unsupported' ? 'הסרטון הזה יעבוד רק באפליקציה המותקנת'
        : 'אופס, לא הצלחנו לנגן את הסרטון';
      status.classList.remove('hidden');
    },
    onThumb: (data) => persistThumb(item, data)
  });
}

/* Captured first frame of a direct file → Blob in the thumbs store (never base64 in a record). */
async function persistThumb(item, dataUrl) {
  try {
    if (item.thumbId || item.thumbUrl) return;
    const { dataUrlToBytes } = await import('./migrate.js');
    const dec = dataUrlToBytes(dataUrl);
    if (!dec) return;
    const { fnv1a } = await import('./util.js');
    const id = 'file:' + fnv1a(item.key);
    await db.putThumb(id, new Blob([dec.bytes], { type: dec.mime }), { origin: 'capture' });
    await db.setVideoFields(item.scopeId, item.key, { thumbId: id });
    item.thumbId = id;
  } catch {}
}

/* F5: the playing video's title under the player, YouTube-style.
   v1.0.53: the fullscreen now-playing overlay (#np-title) mirrors every write — driven
   from HERE, not from the player, because openWatch runs on every open AND every
   video→video switch (including the YouTube reuse path, which never re-runs setupHud),
   and the async oEmbed fallback below already carries the stale-fetch guard both need. */
function setWatchTitle(item) {
  const el = $('watch-title');
  const np = $('np-title');
  const setBoth = (t) => { el.textContent = t; np.textContent = t; };
  setBoth(item.title || '');
  el.classList.toggle('hidden', !item.title);
  if (!item.title && item.type === 'youtube') {
    setBoth('…');
    el.classList.remove('hidden');
    fetchYouTubeTitle(item.id).then((t) => {
      if (!currentWatch || currentWatch.key !== item.key) return; // stale fetch
      if (t) { setBoth(t); persistTitle(item, t); }
      else { setBoth(''); el.classList.add('hidden'); }
    });
  }
}

/* v1.0.53 — the overlay's channel line (fullscreen only; the CSS owns WHEN it shows).
   Pure nowPlayingChannel decides WHAT: the family's own folder title (ch:/grp:) first,
   then srcChannelTitle, or nothing — a video that belongs to no channel shows no line.
   The logo rides the existing byte cache: mountChannelLogo sets dataset.logoChannel so
   planLogoDelivery's guard keeps a slow video-A fetch out of video B's overlay, and an
   empty host stays hidden (CSS :empty) until real bytes actually paint. */
function setWatchChannel(item) {
  const row = $('np-channel-row');
  const host = $('np-logo-host');
  const info = nowPlayingChannel(item, folders);
  row.classList.toggle('hidden', !info);
  host.textContent = '';                 // never leak the previous video's logo
  delete host.dataset.logoChannel;
  if (!info) return;
  $('np-channel').textContent = info.name;
  if (info.id) mountChannelLogo(host, info.logoUrl, info.id, '');
}

async function persistTitle(item, title) {
  try {
    if (!item.scopeId) return;
    await db.setVideoFields(item.scopeId, item.key, {
      title, titleSource: 'oembed', normTitle: normalizeTitle(title)
    });
    item.title = title;
  } catch {}
}

/* ---------------- Delete from the watch page (v1.0.5) ---------------- */
/**
 * User-specified order: tap 🗑️ → parent PIN (EVERY tap — no session caching) →
 * an explicit "delete this video?" confirm → delete → home. Deletion goes through
 * db.deleteVideo (atomic delete + deny-list tombstone), so the video never comes
 * back — not on the next sync, not on other devices (the tombstone travels via
 * the Drive backup).
 */
async function onDeleteWatch() {
  const item = currentWatch;
  if (!item || !item.key) return;
  // Capture the item BEFORE navigating: entering the pin view tears the player
  // down (watch onLeave) and clears currentWatch.
  startPin((await hasPin()) ? 'verify' : 'setup', {
    replace: true,
    title: 'קוד הורים למחיקת הסרטון',
    onSuccess: () => { confirmDeleteWatch(item); }
  });
}

async function confirmDeleteWatch(item) {
  const yes = await confirmKid({
    emoji: '🗑️', title: 'למחוק את הסרטון הזה?',
    text: item.title || 'הסרטון יוסר מהספרייה לצמיתות',
    ok: 'מחיקה', cancel: 'ביטול', danger: true
  });
  if (yes) {
    try {
      // Delete EVERY copy of this key: the same video can live both in the shared
      // library (channel/sheet) and in the profile scope (manual add) — removing
      // just the played copy would leave the other one visible on the home grid.
      const scopes = new Set([item.scopeId, libScope,
        activeProfileId ? db.profScope(activeProfileId) : null].filter(Boolean));
      // v1.0.58 — ask about the downloaded copy FIRST, while the records still exist:
      // afterwards there is nothing left to read a localPath from. Asked once for every
      // copy of this key together, because they share one file on disk.
      const copies = [];
      for (const scope of scopes) {
        const r = await db.getVideo(scope, item.key);
        if (r) copies.push(r);
      }
      const localChoice = await askDeleteLocalCopies(copies);
      if (localChoice === 'cancel') return;
      await applyDeleteLocalCopies(copies, localChoice);
      let deleted = false;
      let sheetBacked = false;
      let channelVideo = null;
      for (const scope of scopes) {
        const rec = await db.getVideo(scope, item.key);
        if (rec) {
          if ((rec.homeFolderId || rec.folderId) === 'sheet') sheetBacked = true;
          if (rec.channelId) channelVideo = rec;
          await db.deleteVideo(scope, item.key); // atomic delete + deny tombstone
          deleted = true;
        }
      }
      if (deleted) {
        giftStates.delete(item.key);
        if (activeProfileId) { try { await db.deleteVideoState(activeProfileId, item.key); } catch {} }
        // v1.0.38: the deny tombstone db.deleteVideo just wrote is what carries this to
        // every device, through the Drive document. There is no second channel.
        maybeSchedulePush();
      }
    } catch { /* a failed delete must never strand the child outside the gallery */ }
  }
  goGallery();
}

/* ---------------- Interactive share add (v1.0.7) ---------------- */
/**
 * A share from YouTube now opens the ASK flow (user-specified order): parent PIN →
 * "add this video / whole channel?" → added live + registered in the sheet.
 * Returns share.js's decision: 'live' | 'pending' | 'channel' | null.
 * PIN cancel or a "not now" answer parks a VIDEO as pending (never lost); a channel
 * share is simply not added. When a PIN/modal is already up we don't interrupt —
 * the share falls back to the silent pending route.
 */
function handleShareInteractive(c) {
  // v1.0.27: a PLAYLIST is a source, here too. It fell into the video branch below, so
  // the parent typed the PIN, was asked "להוסיף את הסרטון?", tapped הוספה — and
  // handleSourceShare, which accepts only the 'channel' decision, answered "ההוספה
  // בוטלה". The v1.0.26 share-a-playlist feature could not succeed on ANY path.
  const isSource = c.kind === 'channel' || c.kind === 'playlist';
  const isPl = c.kind === 'playlist';
  if (nav.isActive('pin') || isModalOpen()) return Promise.resolve(isSource ? null : 'pending');
  return new Promise((resolve) => {
    (async () => {
      startPin((await hasPin()) ? 'verify' : 'setup', {
        replace: nav.isActive('watch'), // never leave a torn-down player behind
        title: isPl ? 'קוד הורים להוספת רשימת ההשמעה'
          : c.kind === 'channel' ? 'קוד הורים להוספת הערוץ' : 'קוד הורים להוספת הסרטון',
        onDone: (success) => { if (!success) resolve(isSource ? null : 'pending'); },
        onSuccess: async () => {
          if (isSource) {
            // ערוץ is masculine, רשימה feminine — the same rule channelAddOutcome follows.
            const yes = await confirmKid(isPl
              ? { emoji: '🎵', title: 'להוסיף את רשימת ההשמעה כולה?',
                  text: (c.title ? c.title + ' — ' : '') + 'כל הסרטונים שבה ימתינו לאישור הורים.',
                  ok: 'הוספת הרשימה', cancel: 'לא עכשיו' }
              : { emoji: '📺', title: 'להוסיף את הערוץ כולו?',
                  text: (c.title ? c.title + ' — ' : '') + 'סרטונים חדשים שלו ימתינו לאישור הורים.',
                  ok: 'הוספת הערוץ', cancel: 'לא עכשיו' });
            // 'channel' is the SOURCE-decision token handleSourceShare keys on — one
            // token for both kinds, because the routing question is the same.
            resolve(yes ? 'channel' : null);
          } else {
            const yes = await confirmKid({
              emoji: '▶️', title: 'להוסיף את הסרטון?',
              text: c.title || c.srcUrl || '', ok: 'הוספה', cancel: 'לא עכשיו'
            });
            resolve(yes ? 'live' : 'pending');
          }
          goGallery();
        }
      });
    })().catch(() => resolve(isSource ? null : 'pending'));
  });
}

/* v1.0.10's sheet write-back helpers (enqueueSheetDeleteVideo / …DeleteChannel /
 * …Removal) lived here until v1.0.38. A deletion now travels the ONE way it always
 * should have: the record is deleted and a deny tombstone rides the Drive document to
 * every device (db.deleteVideo + maybeSchedulePush). There is no second channel. */

/* ---------------- PIN ---------------- */
async function openParentGate() {
  startPin((await hasPin()) ? 'verify' : 'setup');
}
function updateDots() {
  const dots = $('pin-dots').children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('filled', i < pinBuffer.length);
}
/**
 * PIN gate (parameterized since v1.0.5 — it also guards in-place deletion).
 * onSuccess runs once after a correct code (or after setup completes).
 * replace=true swaps the CURRENT view for the pin view instead of stacking on
 * top of it — the delete flow uses it so hardware-back never lands on a watch
 * page whose player was already torn down.
 */
function startPin(mode, { onSuccess = enterParent, replace = false, title = '', onDone = null } = {}) {
  pinMode = mode; pinBuffer = ''; pinFirst = ''; pinStep = 1;
  pinOnSuccess = onSuccess;
  pinDone = onDone;
  $('pin-msg').textContent = '';
  $('pin-title').textContent = mode === 'setup' ? 'בחרו קוד הורים חדש' : (title || 'הזינו קוד הורים');
  updateDots();
  // The recovery affordance belongs to 'verify' only — in SETUP there is no code yet to
  // have forgotten, and offering a reset there would be a second way to choose the first
  // PIN. Refreshed on every entry because a wait started yesterday may now be ready.
  refreshPinRecovery().catch(() => {});
  if (replace) nav.replace('pin'); else nav.go('pin');
}

/**
 * Draw the "שכחתי את הקוד" affordance for the CURRENT state of a recovery request.
 *
 * Three states, three different things to offer: nothing asked yet (a button that starts
 * the wait), waiting (the countdown plus a way to call it off), and ready (a button that
 * goes straight to choosing a new code). Failure here must never take the PIN screen down
 * with it — the gate still has to work — so every caller swallows.
 */
async function refreshPinRecovery() {
  const btn = $('pin-forgot');
  const note = $('pin-recovery-note');
  if (pinMode !== 'verify') {
    btn.classList.add('hidden');
    note.classList.add('hidden');
    return;
  }
  const { recoveryState } = await import('./recovery.js');
  const { pinRecoveryLabel, planRecoveryRoute } = await import('./plan.js');
  const { canDeviceAuth } = await import('./platform.js');
  const st = await recoveryState();
  const route = planRecoveryRoute({ deviceAuth: await canDeviceAuth(), recovery: st });
  btn.classList.remove('hidden');
  if (route === 'wait-ready') {
    btn.textContent = 'איפוס הקוד — מוכן ✅';
    note.textContent = `תמו ${PIN_RECOVERY_DELAY_HOURS} השעות. אפשר לקבוע קוד הורים חדש.`;
    note.classList.remove('hidden');
  } else if (route === 'wait-pending') {
    btn.textContent = 'ביטול בקשת האיפוס';
    note.textContent = pinRecoveryLabel(st);
    note.classList.remove('hidden');
  } else {
    // 'device' and 'wait-start' share a label on purpose: the parent is answering "I forgot
    // it", not choosing a mechanism. Which one they get is the device's business, and if
    // the prompt fails they are offered the wait without ever having to understand why.
    btn.textContent = 'שכחתי את הקוד';
    note.classList.add('hidden');
  }
}

/**
 * The one handler behind that button — what it does depends on the state it is showing.
 *
 * The RESET itself runs `startPin('setup', { replace: true })`: `replace` so hardware-back
 * cannot land on the verify screen we just satisfied, and the request is cleared BEFORE
 * the new code is chosen so an abandoned setup cannot leave a spent request armed.
 */
async function onPinForgot() {
  const { recoveryState, requestRecovery, cancelRecovery } = await import('./recovery.js');
  const { planRecoveryRoute } = await import('./plan.js');
  const { canDeviceAuth, deviceAuth } = await import('./platform.js');
  const st = await recoveryState();
  const route = planRecoveryRoute({ deviceAuth: await canDeviceAuth(), recovery: st });

  if (route === 'wait-ready') {
    await cancelRecovery();
    startPin('setup', { replace: true, onSuccess: enterParent });
    return;
  }
  if (route === 'wait-pending') {
    const stop = await confirmKid({
      emoji: '🔓', title: 'לבטל את בקשת האיפוס?',
      text: 'קוד ההורים הנוכחי יישאר בתוקף.', ok: 'ביטול הבקשה', cancel: 'להשאיר'
    });
    if (stop) { await cancelRecovery(); await refreshPinRecovery(); }
    return;
  }
  if (route === 'device') {
    // The one-second path. A SUCCESS goes straight to choosing a new code — the device
    // just proved an adult is present, which is a stronger claim than any wait can make.
    const ok = await deviceAuth('אימות הורה', 'אישור בעזרת נעילת המכשיר כדי לקבוע קוד הורים חדש');
    if (ok) { startPin('setup', { replace: true, onSuccess: enterParent }); return; }
    // A FAILURE is not a dead end. Cancelled, no finger enrolled after all, locked out,
    // or a prompt that could not open under screen pinning — the parent still gets the
    // wait, which is the whole reason it is the floor and not an alternative.
    const useWait = await confirmKid({
      emoji: '⏳', title: 'האימות לא הושלם',
      text: `אפשר במקום זאת לבקש איפוס בהמתנה: בעוד ${PIN_RECOVERY_DELAY_HOURS} שעות אפשר יהיה לקבוע קוד חדש.`,
      ok: 'בקשת איפוס בהמתנה', cancel: 'לא עכשיו'
    });
    if (!useWait) return;
    await requestRecovery();
    await refreshPinRecovery();
    await refreshRecoveryBanner();
    return;
  }

  const go = await confirmKid({
    emoji: '⏳', title: 'לאפס את קוד ההורים?',
    text: `מטעמי בטיחות האיפוס לא מיידי: בעוד ${PIN_RECOVERY_DELAY_HOURS} שעות אפשר יהיה לקבוע קוד חדש. ` +
          'עד אז תופיע הודעה במסך הבית, וכל אחד יוכל לבטל את הבקשה.',
    ok: 'בקשת איפוס', cancel: 'לא עכשיו'
  });
  if (!go) return;
  await requestRecovery();
  await refreshPinRecovery();
  await refreshRecoveryBanner();
}
async function onPinComplete() {
  if (pinMode === 'setup') {
    if (pinStep === 1) {
      pinFirst = pinBuffer; pinBuffer = ''; pinStep = 2;
      $('pin-title').textContent = 'הקלידו שוב לאישור';
      updateDots();
      return;
    }
    if (pinBuffer === pinFirst) { await setPin(pinBuffer); consumePinDone(true); pinOnSuccess(); }
    else {
      $('pin-msg').textContent = 'הקודים לא תואמים, נסו שוב';
      pinBuffer = ''; pinFirst = ''; pinStep = 1;
      $('pin-title').textContent = 'בחרו קוד הורים חדש';
      updateDots();
    }
  } else {
    if (await verifyPin(pinBuffer)) { consumePinDone(true); pinOnSuccess(); }
    else { $('pin-msg').textContent = 'קוד שגוי'; pinBuffer = ''; updateDots(); }
  }
}
function onKey(k) {
  if (k === 'del') { pinBuffer = pinBuffer.slice(0, -1); updateDots(); return; }
  if (pinBuffer.length >= 4) return;
  pinBuffer += k;
  updateDots();
  if (pinBuffer.length === 4) setTimeout(onPinComplete, 130);
}

/* ---------------- Voluntary support (v1.0.14) ---------------- */
// Everything here lives behind the parent PIN: a child can never reach a payment
// page. Links open in the SYSTEM browser (the WebView blocks external navigation).

/** Tap "תרומה" → choose HOW to pay (only configured methods are offered). */
async function openDonateFlow() {
  const msg = $('donate-msg');
  msg.textContent = ''; msg.className = 'form-msg';
  const { donateOptions } = await import('./donate.js');
  const opts = donateOptions();
  if (!opts.length) return;

  let chosen = opts[0];
  if (opts.length > 1) {
    // confirmKid gives exactly two big choices — enough for PayBox vs PayPal, and
    // an accidental dismiss must NOT pick a payment method (askKid tells them apart).
    const answer = await askKid({
      emoji: '💜', title: 'איך נוח לכם לתרום?',
      text: `${opts[0].label} — ${opts[0].hint}\n${opts[1].label} — ${opts[1].hint}`,
      ok: opts[0].label, cancel: opts[1].label
    });
    if (answer === 'dismiss') return;
    chosen = answer === 'ok' ? opts[0] : opts[1];
  }
  const { openExternal } = await import('./platform.js');
  const opened = await openExternal(chosen.url);
  msg.textContent = opened
    ? 'נפתח דף התרומה בדפדפן — תודה מכל הלב 💜'
    : 'לא הצלחנו לפתוח את הדפדפן. הקישור: ' + chosen.url;
  msg.className = opened ? 'form-msg ok' : 'form-msg err';
}

/** Show the donate button only when a link is actually configured. */
async function refreshDonateUi() {
  try {
    const { donateAvailable, shouldShowDonateNudge } = await import('./donate.js');
    const available = donateAvailable();
    $('donate-btn').classList.toggle('hidden', !available);
    $('help-block').classList.toggle('hidden', false); // free ways to help always apply
    const show = shouldShowDonateNudge({
      firstSeenAt: Number(await prefGet('install.firstSeenAt')) || 0,
      dismissed: (await prefGet('donate.nudgeDismissed')) === '1'
    });
    $('donate-nudge').classList.toggle('hidden', !show);
  } catch {}
}

/* ---------------- Parent screen (tabs: about / approve / add / sources / settings) ---------------- */
/**
 * v1.0.24 — the landing tab is DECIDED before the view is shown, never corrected after.
 * `refreshParent` calls `setParentTab` before it awaits the lists, so choosing the tab
 * from the pending count inside it would render אודות and then visibly jump.
 *
 * The count is one indexed COUNT per scope, but awaiting it still yields to the event
 * loop — if hardware-back left the pin view in that window the parent changed their mind,
 * and replacing whatever is on top now with the parent screen would be a real bug.
 */
async function enterParent() {
  let total = 0;
  try { total = await pendingTotal(); } catch {}
  parentTab = parentLandingTab(parentTab, total);
  if (!nav.isActive('pin')) return;
  refreshParent();
  nav.replace('parent'); // replaces 'pin' on the stack
}

// v1.0.14: "אודות" is the first tab AND the default landing tab of the parent screen.
// v1.0.24: the list itself lives in plan.js, next to `parentLandingTab` which validates
// against it — two hand-kept copies would let the override name a tab that does not exist.
const PARENT_TABS = PARENT_TAB_IDS;
let parentTab = 'about';

function setParentTab(name) {
  parentTab = name;
  for (const t of PARENT_TABS) {
    $('tab-' + t).classList.toggle('active', t === name);
    $('panel-' + t).classList.toggle('hidden', t !== name);
  }
}

/**
 * The sources panel — v1.0.38: the sheet section is GONE (the "connected list" status
 * line, the copy button, the connect door). Content lives in the database and travels in
 * the Drive backup; the links file is the bulk door. What remains here is honest state:
 * a parked orphan sweep, and the TV default for the paste box.
 */
async function refreshSourcesPanel() {
  // v1.0.38: a PARKED orphan sweep. The valve holds an unusually large sweep back (the first
  // unconditional pass on an old install can find months of accumulated orphans, and
  // deleteVideoRaw writes no tombstone), and it must not be a meta key nobody reads — the
  // v1.0.37 lesson. Nothing to decide: it says what is being kept and why.
  const gc = libScope ? await db.getMeta('gcAlert:' + libScope) : null;
  const st = $('remote-status');
  if (gc && gc.count && st) {
    st.textContent = `${gc.count} סרטונים שייכים לערוצים שאינם מנויים יותר. הם נשמרו ולא נמחקו — `
      + 'הסירו את הערוץ מהרשימה למטה כדי למחוק אותם, או התעלמו.';
    st.className = 'form-msg';
  }
  // v1.0.38: on Android TV there is NO file picker, so the paste door is the only import
  // door — open it by default there instead of leaving the parent to discover it.
  const box = $('links-paste-box');
  if (box && !box.dataset.tvChecked) {
    box.dataset.tvChecked = '1';
    try {
      const { isTv } = await import('./platform.js');
      if (await isTv()) box.open = true;
    } catch {}
  }
  // v1.0.39 — the rolling window's notice. Derived here, per visit: nothing about it is
  // stored, so it can never disagree with the library it describes.
  await refreshWindowBox().catch(() => {});
}

/* ---------------- the אתרים tab (v1.0.45) ---------------- */

function siteRow({ title, sub, onDelete, buttons = [], icon = null }) {
  const li = document.createElement('li');
  li.className = 'parent-row';
  if (icon) {
    const host = document.createElement('span');
    host.className = 'li-thumb li-site-icon';
    mountSiteIcon(host, icon);
    li.appendChild(host);
  }
  const body = document.createElement('div');
  body.className = 'li-body';
  const t = document.createElement('div');
  t.className = 'li-title';
  t.textContent = title;
  body.appendChild(t);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'li-note';
    s.textContent = sub;
    body.appendChild(s);
  }
  li.appendChild(body);
  const btns = document.createElement('div');
  btns.className = 'row-btns';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = 'btn btn-small';
    el.type = 'button';
    el.textContent = b.label;
    el.addEventListener('click', b.onClick);
    btns.appendChild(el);
  }
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'btn btn-small';
    del.type = 'button';
    del.textContent = '🗑️';
    del.addEventListener('click', onDelete);
    btns.appendChild(del);
  }
  li.appendChild(btns);
  return li;
}

async function refreshSitesPanel() {
  if (!$('panel-sites')) return;
  await loadSiteEntries();
  $('sites-enabled').checked = sitesEnabledCache;
  $('sites-off-note').classList.toggle('hidden', sitesEnabledCache);
  $('sites-body').classList.toggle('hidden', !sitesEnabledCache);

  const scList = $('sites-shortcuts');
  scList.innerHTML = '';
  const shortcuts = siteShortcuts();
  for (const rec of shortcuts) {
    scList.appendChild(siteRow({
      icon: rec,
      title: rec.title || rec.url,
      sub: rec.url,
      buttons: [
        // The login door. Navigation is UNRESTRICTED here so an SSO round-trip to another
        // host can complete; the cookies it leaves are what let the child skip the login.
        { label: 'כניסה / בדיקה', onClick: () => { openSiteForParent(rec.url, rec.title).catch(() => {}); } },
        { label: 'ניתוק', onClick: async () => {
          const canon = canonicalSitePrefix(rec.url);
          if (!canon.ok) return;
          if (!await confirmKid({ emoji: '🚪', title: 'לנתק מהאתר?', text: 'החיבור והנתונים השמורים של ' + canon.host + ' יימחקו מהמכשיר הזה.' })) return;
          await clearSiteData(canon.host);
          toast('הנתונים נמחקו');
        } }
      ],
      onDelete: async () => {
        if (!await confirmKid({ emoji: '🗑️', title: 'להסיר את האתר?', text: 'האייקון ייעלם מהמסך של הילד. הכתובת תישאר מאושרת לגלישה עד שתסירו אותה גם מהרשימה השנייה.' })) return;
        await removeSiteEntry(rec.entryId);
        await refreshSitesPanel();
        await refreshSitesLauncher();
      }
    }));
  }
  $('sites-shortcuts-empty').classList.toggle('hidden', shortcuts.length > 0);

  const rlList = $('sites-rules');
  rlList.innerHTML = '';
  for (const rec of siteRules()) {
    const li = siteRow({
      title: rec.display,
      sub: rec.allowExternal ? 'תוכן חיצוני מותר באתר הזה' : 'רק תוכן מהאתר עצמו',
      onDelete: async () => {
        if (!await confirmKid({ emoji: '🗑️', title: 'להסיר את ההרשאה?', text: rec.display + '\nהילד לא יוכל יותר לגלוש לכתובת הזו.' })) return;
        await removeSiteEntry(rec.entryId);
        await refreshSitesPanel();
      }
    });
    // The external-content toggle lives on the RULE, so one strict site stays strict
    // while another is opened up.
    const lab = document.createElement('label');
    lab.className = 'li-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!rec.allowExternal;
    cb.addEventListener('change', async () => {
      if (cb.checked && !await confirmKid({
        emoji: '⚠️', title: 'לאפשר תוכן חיצוני?',
        text: 'הדפים באתר הזה יוכלו לטעון פרסומות, סרטונים מוטמעים ותמונות מאתרים אחרים. הילד עלול לראות תוכן שאף אחד לא אישר. להפעיל רק אם האתר נראה שבור.'
      })) { cb.checked = false; return; }
      await db.putSiteEntry({ ...rec, allowExternal: cb.checked });
      await loadSiteEntries();
      maybeSchedulePush();
      await refreshSitesPanel();
    });
    lab.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = 'תוכן חיצוני';
    lab.appendChild(span);
    li.querySelector('.row-btns').prepend(lab);
    rlList.appendChild(li);
  }

  // Blocked pages, newest first — each one turns into a fix with a single tap.
  const blockedBox = $('sites-blocked-box');
  const blocked = $('sites-blocked');
  blocked.innerHTML = '';
  const known = new Set(siteRules().map((r) => r.display));
  const pending = siteBlockedRecent.filter((b) => {
    const c = ruleCandidatesFor(b.url);
    return c.ok && !known.has(c.options[c.defaultIndex].canon.display);
  });
  for (const b of pending.slice(0, 8)) {
    blocked.appendChild(siteRow({
      title: b.url,
      sub: 'נחסם',
      buttons: [{ label: 'לאשר', onClick: () => { askSiteRuleGrain(b.url, ruleCandidatesFor(b.url)).catch(() => {}); } }]
    }));
  }
  blockedBox.classList.toggle('hidden', pending.length === 0);
}

/** The shared add flow: probe → normalize → show what will REALLY be saved → confirm. */
let siteAddBusy = false;

async function addSiteFromInput(kind) {
  if (siteAddBusy) return;
  const inputId = kind === 'shortcut' ? 'site-sc-url' : 'site-rule-url';
  const btnId = kind === 'shortcut' ? 'site-sc-add' : 'site-rule-add';
  const msgId = kind === 'shortcut' ? 'site-sc-msg' : 'site-rule-msg';
  const raw = ($(inputId).value || '').trim();
  const msg = $(msgId);
  const canon = canonicalSitePrefix(raw);
  if (!canon.ok) { msg.textContent = siteUrlError(canon.reason); msg.className = 'form-msg err'; return; }
  siteAddBusy = true;
  $(btnId).disabled = true;
  try {
    await runSiteAdd(kind, raw, inputId, msg);
  } finally {
    siteAddBusy = false;
    $(btnId).disabled = false;
  }
}

async function runSiteAdd(kind, raw, inputId, msg) {
  const canon = canonicalSitePrefix(raw);
  msg.textContent = 'בודקים את הכתובת…';
  msg.className = 'form-msg';
  const probe = await probeSite(raw);
  const finalCanon = probe.canon;
  // Say what will actually be stored. A site that redirects (bare domain → www, or a
  // section → its index) otherwise saves a rule that matches nothing the child reaches,
  // and the feature looks broken for a reason the parent cannot see.
  const changed = finalCanon.display !== canon.display;
  // ONE dialog, three answers (the v1.0.23 three-way pattern). The external-content
  // decision is asked HERE rather than left to a toggle further down the panel, because
  // it is decided per site and the parent is thinking about that site right now — and
  // because a site whose videos will not play looks broken long before anyone goes
  // hunting for a switch. Embedded players are named explicitly: they are third-party
  // resources, so the strict answer is precisely what stops a YouTube embed loading.
  //
  // The SAFE answer is the primary button; an accidental dismiss adds nothing at all.
  const answer = await askKid({
    emoji: kind === 'shortcut' ? '🌐' : '🔒',
    title: kind === 'shortcut' ? 'להוסיף את האתר?' : 'לאשר את הכתובת?',
    text: (changed ? 'הכתובת מפנה אל:\n' : '') + finalCanon.display
      + (kind === 'shortcut' ? '\n\nהילד יוכל לגלוש בכל הכתובות שמתחילות כך.' : '')
      + '\n\nתוכן חיצוני = סרטונים מוטמעים, תמונות ופרסומות מאתרים אחרים.'
      + '\nבלעדיו בטוח יותר, אבל ייתכן שסרטונים לא יתנגנו וחלקים מהדף יחסרו.'
      + '\nאפשר לשנות בכל רגע ברשימת האתרים המורשים.',
    ok: 'הוספה — בלי תוכן חיצוני',
    third: 'הוספה — עם תוכן חיצוני',
    cancel: 'ביטול'
  });
  if (answer !== 'ok' && answer !== 'third') { msg.textContent = ''; return; }
  const allowExternal = answer === 'third';
  const res = kind === 'shortcut'
    ? await addSiteShortcut(probe.url, { title: probe.title, iconUrl: probe.iconUrl, allowExternal })
    : await addSiteRule(finalCanon, { allowExternal });
  if (!res.ok) { msg.textContent = res.message; msg.className = 'form-msg err'; return; }
  $(inputId).value = '';
  msg.textContent = (kind === 'shortcut' ? 'האתר נוסף ✅' : 'הכתובת אושרה ✅')
    + (allowExternal ? ' (עם תוכן חיצוני)' : ' (בלי תוכן חיצוני)');
  msg.className = 'form-msg ok';
  await refreshSitesPanel();
  await refreshSitesLauncher();
}

async function refreshParent() {
  const src = await db.getSources(activeProfileId);
  await refreshSourcesPanel();
  $('share-approval-toggle').checked = await getSetting(activeProfileId, 'shareApproval', true) !== false;
  $('exit-lock-toggle').checked = await exitLockOn();
  $('autoplay-toggle').checked = (await getSetting(activeProfileId, 'autoplay', false)) === true;
  $('resume-toggle').checked = (await getSetting(activeProfileId, 'resume', false)) === true;
  $('bgplay-toggle').checked = (await getSetting(activeProfileId, 'bgPlay', false)) === true;
  // v1.0.31: scheduled lock — load both numbers (0 after = off)
  $('lock-after-min').value = String(Number(await getSetting(activeProfileId, 'lockAfterMin', 0)) || 0);
  $('lock-duration-min').value = String(Number(await getSetting(activeProfileId, 'lockDurationMin', SCHED_LOCK_DEFAULT_DURATION_MIN)) || SCHED_LOCK_DEFAULT_DURATION_MIN);
  $('lock-tablet-toggle').checked = await lockTabletOn(); // v1.0.55

  // v1.0.34: never-written reads as the DEFAULT (10), explicit 0 shows as 0 — the
  // distinction is screenOffMinutes' whole job (Number(null) is 0, the wrong answer).
  $('screen-off-min').value = String(screenOffMinutes(
    await getSetting(activeProfileId, 'screenOffAfterMin', null), SCREEN_OFF_DEFAULT_MIN));
  // v1.0.39: the OPPOSITE default — never-written reads as 0 (off), because this is the
  // one setting that deletes the child's videos.
  $('keep-newest').value = String(keepNewestPerChannel(await getSetting(activeProfileId, 'keepNewest', null)));
  // v1.0.57: back to the screenOffMinutes direction — never-written is the DEFAULT (10),
  // and only an explicit 0 turns 🕒 off. Nothing here deletes anything.
  $('recent-limit').value = String(recentLimitFor(await getSetting(activeProfileId, 'recentLimit', null)));
  await labelProfileSettings();
  // v1.0.22: a same-name collision that ALREADY happened (both devices offline at once)
  // cannot be blocked retroactively, and merging or renaming it silently would be worse —
  // so tell the parent and let them rename or delete. Nothing is touched automatically.
  const dups = duplicateProfileNames(await getProfiles());
  const dupEl = $('dup-profiles');
  dupEl.classList.toggle('hidden', !dups.length);
  if (dups.length) {
    const names = dups.map((d) => `"${d.name}" (${d.ids.length})`).join(', ');
    dupEl.textContent = `⚠️ יש יותר מפרופיל אחד באותו שם: ${names}. זה קורה כששני מכשירים יצרו את אותו שם בלי חיבור לאינטרנט. הילד רואה שני אווטארים זהים, וההתקדמות שלו (מתנות וסרטונים אישיים) מתפצלת ביניהם — כדאי לשנות שם לאחד מהם, או למחוק את המיותר.`;
  }
  $('add-msg').textContent = '';
  $('remote-status').textContent = '';
  $('approve-msg').textContent = '';
  setParentTab(parentTab);
  refreshDonateUi().catch(() => {});
  refreshDriveStatus();
  runUpdateCheck().catch(() => {});
  await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList(), refreshSitesPanel(), refreshFoldersList()]);
}

/* refreshSheetWriteStatus (v1.0.6/v1.0.10) lived here until v1.0.38 — it surfaced the
 * sheet write-queue state and the mirror safety valve. Both are gone: there is no
 * queue, and no presence-mirror that can delete a library. */

/** Update panel state (settings tab). manual=true bypasses the 6h throttle. */
async function runUpdateCheck({ manual = false } = {}) {
  const msg = $('update-msg');
  const upd = await import('./update.js');
  const local = await upd.currentVersion();
  $('ver-current').textContent = local || 'דפדפן';
  if (manual) { msg.textContent = 'בודק…'; msg.className = 'form-msg'; }
  const r = await upd.checkForUpdate({ silent: !manual, force: manual });
  if (r.latest) $('ver-latest').textContent = r.latest.version;
  // 'skipped' = the launch prompt was declined — still installable from here, and it
  // keeps the red dot on the ABOUT tab (the update UI's home since v1.0.8).
  const installable = r.status === 'available' || r.status === 'skipped';
  $('update-install').classList.toggle('hidden', !installable);
  $('about-dot').classList.toggle('hidden', !installable);
  if (!manual) return;
  msg.className = 'form-msg';
  msg.textContent =
    r.status === 'available' ? `יש גירסה חדשה: ${r.latest.version} 🎉`
    : r.status === 'up-to-date' ? 'האפליקציה מעודכנת ✅'
    : r.status === 'browser' ? 'בדיקת עדכון זמינה באפליקציה המותקנת בלבד'
    : r.status === 'no-asset' ? 'לא נמצא קובץ התקנה בגירסה האחרונה'
    : 'לא הצלחנו לבדוק (אין רשת?)';
}

async function refreshDriveStatus() {
  // v1.0.32: an ACTIVE backup shows NOTHING (user request — it is automatic, and a
  // status line + manual button only invited fiddling). The block survives solely as
  // the enable path for a family that skipped the first-launch Google connect; hiding
  // it for them too would leave no way to ever turn backup on.
  const meta = (await db.getMeta('drive')) || {};
  $('drive-block').classList.toggle('hidden', !!meta.enabled);
}

/** Push local state to Drive soon — no-op until the parent enabled backup. */
/* v1.0.22 — SHARED STATE TRAVELS BOTH WAYS.
 *
 * The app scheduled a PUSH on every mutation but called `pullDrive` from exactly three
 * places — the first-launch Google connect, profile creation, and the enable-backup
 * button. So an approval made on the phone reached Drive and sat there: the tablet had no
 * code path that read it, and the same profile showed a different library on every device.
 * Pulled here on profile activation (which covers every launch — a launch ends in one) and
 * on resume from the background.
 *
 * Non-negotiables:
 *  - SILENT and best-effort. Covering a populated grid with the loading screen is the
 *    worse bug (v1.0.18), and a network failure must never stop a child from watching.
 *  - ONE pull at a time. Two callers share the in-flight promise, the way `authorize()`
 *    shares a token request so two taps cannot pop two dialogs.
 *  - Throttled, because resume + activation can fire together.
 *  - Answers whether local data actually CHANGED, via the `db.dataVersion()` write
 *    counter, so the caller re-renders only when there is something new to show.
 */
const PULL_THROTTLE_MS = 60 * 1000;
let pullInFlight = null;
let lastPullAt = 0;

async function maybePullDrive({ force = false } = {}) {
  const meta = await db.getMeta('drive');
  if (!meta || !meta.enabled) return false; // Drive is opt-in, and not connected here
  if (pullInFlight) return pullInFlight;
  if (!force && Date.now() - lastPullAt < PULL_THROTTLE_MS) return false;
  const before = db.dataVersion();
  pullInFlight = (async () => {
    try {
      const { pullDrive } = await import('./drive.js');
      const r = await pullDrive(activeProfileId);
      lastPullAt = Date.now();
      return !!(r && r.ok) && db.dataVersion() !== before;
    } catch {
      return false;
    } finally {
      pullInFlight = null;
    }
  })();
  return pullInFlight;
}

/**
 * After activation: wait for the home-entry refresh that `nav.reset('gallery')` just
 * started, then put the loading screen away.
 *
 * This used to run its own pull-then-sync pipeline, which is the bug: the gallery's
 * onEnter had ALREADY started one synchronously, so the pull here raced the sync there.
 * All this owns now is the loading screen the caller raised — the work itself belongs to
 * `entryRefresh`, and there is only ever one of those.
 */
async function awaitEntryRefresh() {
  try {
    await entryRefreshInFlight;
  } finally {
    await loading.hide(); // idempotent; the ONLY guarantee the child depends on
    if (!nav.isActive('gallery') && nav.isActive('loading')) nav.reset('gallery');
  }
}

async function maybeSchedulePush() {
  const meta = (await db.getMeta('drive')) || {};
  if (!meta.enabled) return;
  const { schedulePush } = await import('./drive.js');
  schedulePush(profiles);
}

/**
 * One row of a parent list.
 *
 * `select` (v1.0.24, ממתינים only) turns the row into a selectable one: `{ id, checked,
 * onToggle }`. It reuses the picker's `.pick-cb` and its whole-row tap target, but NOT
 * `.pick-off` — see the CSS note: an unticked row here is simply outside the current bulk
 * action, not a video about to be thrown out.
 */
/* ---------------- Preview bubble (v1.0.26) ----------------
 * The parent needs to WATCH a video — scrub it, jump around — before deciding. Doing that
 * in the kid player would mean leaving the parent screen and losing the queue, the open
 * tab and the ticked rows, so this is an OVERLAY that changes nothing behind it.
 *
 * It deliberately does NOT reuse player.js:
 *  - `setupHud` binds window/document listeners and the invariant is that it must never
 *    run twice without a teardown; the parent screen is the wrong place to risk that;
 *  - the kid HUD hides the timeline and turns a centre tap into play/pause. For a parent
 *    EVALUATING content that is exactly backwards — they need YouTube's own scrub bar.
 * So: a plain iframe with `controls=1`, and a <video controls> for a direct file.
 *
 * MUTED on open (parent's decision): checking a video usually happens with the child in
 * the room, and a nursery rhyme at full volume is the one thing guaranteed to summon
 * them. Browsers also block autoplay WITH sound, so unmuted would often just not start.
 */
let previewCtx = null; // { items, idx, mode, onDecision }

function closePreview() {
  previewCtx = null;
  const host = $('pv-host');
  if (host) host.innerHTML = ''; // tearing out the iframe is what actually stops playback
  const el = $('preview-bubble');
  if (el) el.classList.add('hidden');
}

function isPreviewOpen() {
  const el = $('preview-bubble');
  return !!el && !el.classList.contains('hidden');
}

function renderPreview() {
  const ctx = previewCtx;
  if (!ctx) return closePreview();
  const rec = ctx.items[ctx.idx];
  if (!rec) return closePreview();

  $('preview-bubble').classList.remove('hidden');
  $('pv-title').textContent = (rec.title || '(ללא שם)')
    + (ctx.items.length > 1 ? `  ·  ${ctx.idx + 1}/${ctx.items.length}` : '');
  const host = $('pv-host');
  host.innerHTML = '';
  const src = previewEmbedUrl(rec);
  if (src) {
    const f = document.createElement('iframe');
    f.src = src;
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.setAttribute('allowfullscreen', '');
    host.appendChild(f);
  } else if (rec.url || rec.localPath) {
    const v = document.createElement('video');
    v.src = rec.localPath || rec.url;
    v.controls = true; v.muted = true; v.autoplay = true; v.playsInline = true;
    host.appendChild(v);
  }
  // Always offered, never conditional: an embedding-disabled video shows a black box
  // inside the iframe and there is no reliable, cheap way to detect that from here — and
  // a blocked video is exactly the kind a parent most wants to look at before deciding.
  $('pv-note').textContent = rec.type === 'youtube'
    ? 'לא מתנגן? ייתכן שהערוץ חסם הטמעה — אפשר לפתוח ביוטיוב.' : '';
  $('pv-open').classList.toggle('hidden', rec.type !== 'youtube');

  // the per-mode button matrix is PURE and node-tested (playerlogic.previewBubbleButtons)
  // — the hand-ordered toggles that used to live here are where the "live 🗑️ over a
  // search result" bug had to be hand-avoided
  const btns = previewBubbleButtons(ctx.mode);
  $('pv-approve').classList.toggle('hidden', !btns.approve);
  $('pv-reject').classList.toggle('hidden', !btns.reject);
  $('pv-delete').classList.toggle('hidden', !btns.del);
  $('pv-add').classList.toggle('hidden', !btns.add);
}

/** Open the bubble on `items[idx]`. `mode` is 'pending' (approve/reject) or 'library'. */
function openPreview(items, idx, mode) {
  previewCtx = { items: (items || []).filter(Boolean), idx: Math.max(0, idx | 0), mode };
  renderPreview();
}

/**
 * The parent decided from inside the bubble. Advance to the next item rather than closing
 * (parent's decision): triaging thirty videos must not cost thirty open/close cycles.
 * The decided row is dropped from the local list so the counter stays honest.
 *
 * RE-ENTRANCY GUARDED (review finding, v1.0.33): a double-tap used to run TWO
 * decisions on the same ctx — the `previewCtx !== ctx` check cannot catch it because
 * splice MUTATES the shared object — so the second splice removed the NEXT video,
 * which the parent never saw. The window is real for ➕ הוספה: its handler awaits a
 * whole add round-trip (putVideos + sheet append + list refresh).
 */
let previewDeciding = false;
async function previewDecide(fn) {
  const ctx = previewCtx;
  if (!ctx || previewDeciding) return;
  const rec = ctx.items[ctx.idx];
  if (!rec) return closePreview();
  previewDeciding = true;
  let done = true;
  // `false` means the parent backed out (a cancelled confirm) — the video is untouched, so
  // advancing past it would silently skip the one they were still looking at.
  try { done = (await fn(rec)) !== false; } catch { done = false; } finally { previewDeciding = false; }
  if (previewCtx !== ctx) return;          // the parent closed it while we awaited
  if (!done) return;
  ctx.items.splice(ctx.idx, 1);
  if (ctx.idx >= ctx.items.length) ctx.idx = ctx.items.length - 1;
  if (!ctx.items.length) return closePreview();
  renderPreview();
}

function parentRow({ rec, onDelete, onApprove, onPreview = null, onMove = null, note = '', select = null }) {
  const li = document.createElement('li');
  if (select) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'pick-cb';
    cb.checked = !!select.checked;
    li.dataset.sel = select.id;
    li.classList.toggle('li-sel', cb.checked);
    const apply = (on) => {
      cb.checked = on;
      li.classList.toggle('li-sel', on);
      select.onToggle(rec, on);
    };
    cb.addEventListener('change', () => apply(cb.checked));
    // The whole row toggles (a bare checkbox is a cruel target on a tablet) — but this row
    // also carries ✅ and 🗑️, and a tap on either must NEVER also flip the selection.
    li.addEventListener('click', (e) => {
      if (e.target === cb || e.target === img || (e.target.closest && e.target.closest('button'))) return;
      apply(!cb.checked);
    });
    li.appendChild(cb);
  }
  const img = document.createElement('img');
  img.className = 'li-thumb';
  setThumb(img, rec);
  // v1.0.26: the thumbnail is the preview target — the obvious thing to tap when you want
  // to SEE the video. It is excluded from the row's selection toggle below for the same
  // reason ✅ and 🗑️ are: one tap must mean one thing.
  if (onPreview) {
    img.classList.add('li-thumb-play');
    img.setAttribute('role', 'button');
    img.title = 'צפייה מהירה';
    img.addEventListener('click', (e) => { e.stopPropagation(); onPreview(rec); });
    // v1.0.29 (TV): a bare <img> is invisible to the D-pad. tabIndex puts it in the
    // focus scan; Enter needs explicit handling because only buttons activate natively.
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onPreview(rec); }
    });
  }
  const body = document.createElement('div');
  body.className = 'li-body';
  const title = document.createElement('div');
  title.className = 'li-title';
  title.textContent = rec.title || '(ללא שם)';
  const badge = document.createElement('span');
  badge.className = 'badge-type ' + (rec.type === 'youtube' ? 'badge-yt' : 'badge-file');
  badge.textContent = rec.type === 'youtube' ? 'YouTube' : 'קובץ';
  title.appendChild(badge);
  const sub = document.createElement('div');
  sub.className = 'li-sub';
  sub.textContent = rec.srcUrl || rec.url || '';
  body.appendChild(title);
  body.appendChild(sub);
  // v1.0.26: the rejected archive's per-row countdown to permanent deletion
  if (note) {
    const n = document.createElement('div');
    n.className = 'li-note li-ttl';
    n.textContent = '⏳ ' + note;
    body.appendChild(n);
  }
  li.appendChild(img);
  li.appendChild(body);
  if (onApprove) {
    const ok = document.createElement('button');
    ok.className = 'li-ok'; ok.type = 'button'; ok.textContent = '✅';
    ok.addEventListener('click', onApprove);
    li.appendChild(ok);
  }
  // v1.0.56 — "move to a folder", the door for every video that did NOT come through the
  // add form (a share, a links-file import, a library that predates custom folders).
  // Same rule as the buttons around it: rendered only when a handler exists.
  if (onMove) {
    const mv = document.createElement('button');
    mv.className = 'btn btn-small'; mv.type = 'button'; mv.textContent = '📁';
    mv.setAttribute('aria-label', 'העברה לתיקיה');
    mv.addEventListener('click', onMove);
    li.appendChild(mv);
  }
  // v1.0.23: only when there IS a handler. It used to bind `undefined` unconditionally, so
  // a caller that omits onDelete rendered a 🗑️ that looks live and does nothing.
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'li-del'; del.type = 'button'; del.textContent = '🗑️';
    del.addEventListener('click', onDelete);
    li.appendChild(del);
  }
  return li;
}

const PARENT_LIST_CAP = 200;

/** The library list — reads IndexedDB; deletion writes a TOMBSTONE (durable forever). */
async function refreshParentList() {
  const scopes = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const all = [];
  for (const s of scopes) {
    for (const rec of (await db.loadMergeIndex(s)).values()) {
      if (rec.state === 'live') all.push(rec);
    }
  }
  all.sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0));
  $('list-count').textContent = `📚 הסרטונים הקיימים (${all.length})`;

  // v1.0.28 — grouped and folded (parent's request): one sub-section per folder the
  // child actually sees, all CLOSED by default so the tab opens onto the add form, not
  // onto hundreds of already-approved rows. Grouping is pure plan.groupLibraryByFolder;
  // the per-folder cap keeps the old PARENT_LIST_CAP promise per section instead of
  // globally, so a huge channel can no longer hide the small folders behind the cap.
  const shownLive = all.slice(0, PARENT_LIST_CAP * 4); // preview/delete work over this order
  const subsList = libScope ? await db.listLibraryChannels(libScope) : [];
  // v1.0.56: the parent's own folders get their own sections, with their real names
  const cfList = libScope ? await db.listCustomFolders(libScope) : [];
  const groups = groupLibraryByFolder(shownLive, subsList, cfList);
  const host = $('parent-groups');
  const openIds = new Set([...host.querySelectorAll('details[open]')].map((d) => d.dataset.gid));
  host.innerHTML = '';
  const rowFor = (rec) => parentRow({
    rec,
    // v1.0.26: same quick-look here. These videos are already approved, so the bubble
    // offers DELETE — the one action this list has — after the parent has actually seen
    // what they are about to remove.
    onPreview: () => openPreview(shownLive, shownLive.indexOf(rec), 'library'),
    // v1.0.56 — only for records that live in a FOLDER OF SINGLES. A channel's video
    // cannot be filed by hand: the sync owns `ch:<id>` membership and would put it
    // straight back, so offering the button there would be a lie.
    onMove: isLooseRecord(rec) || isCustomFolder(rec.homeFolderId || rec.folderId)
      ? () => { moveVideoToFolder(rec).catch(() => {}); }
      : null,
    onDelete: async () => {
      // v1.0.58 — the downloaded copy goes with it, if the parent says so
      const choice = await askDeleteLocalCopies([rec]);
      if (choice === 'cancel') return;
      await applyDeleteLocalCopies([rec], choice);
      await db.deleteVideo(rec.scopeId, rec.key); // atomic delete + deny tombstone
      await refreshParentList();
      renderHome();
      maybeSchedulePush();
    }
  });
  for (const g of groups) {
    const box = document.createElement('details');
    box.className = 'library-group';
    box.dataset.gid = g.id;
    // a rebuild after a delete keeps whatever the parent had open — the same
    // "the screen behind stays as it was" rule the pending list follows for ticks
    if (openIds.has(g.id)) box.open = true;
    const sum = document.createElement('summary');
    sum.className = 'library-group-head';
    const cap = Math.min(g.records.length, PARENT_LIST_CAP);
    sum.textContent = `${g.title} (${g.records.length})`;
    box.appendChild(sum);
    const ul = document.createElement('ul');
    ul.className = 'parent-list';
    for (const rec of g.records.slice(0, PARENT_LIST_CAP)) ul.appendChild(rowFor(rec));
    if (g.records.length > cap) {
      const more = document.createElement('li');
      more.className = 'li-note';
      more.textContent = `מוצגים ${cap} מתוך ${g.records.length}`;
      ul.appendChild(more);
    }
    box.appendChild(ul);
    host.appendChild(box);
  }
}

/* enqueueApprovedForSheet (v1.0.6) lived here until v1.0.38: an approved share used to
 * get a sheet row so the family's master list stayed complete. The database IS the
 * master list now, and approval already travels in the Drive document. */

/**
 * v1.0.24 — which rows of the ממתינים queue are ticked.
 *
 * Keyed by scope AND key: the same `yt:<id>` can sit in the shared library and in the
 * personal scope at once, and `db.approvePending` takes ONE scope — acting on the wrong
 * copy would silently leave the other one waiting. NUL is the separator because it is the
 * one character a scopeId (`lib:…`/`prof:…`) and a key (`yt:…`) can never contain, so two
 * different pairs can never collide into a single id.
 */
const pendingSel = new Set();
const selIdOf = (rec) => rec.scopeId + '\u0000' + rec.key;
let pendingShownTotal = 0;

/** Bulk buttons follow the selection; the label always names what will actually happen. */
function paintPendingBulk() {
  const act = pendingBulkAction(pendingSel.size, pendingShownTotal);
  $('approve-all').textContent = act.approve;
  $('reject-all').textContent = act.reject;
  $('pending-bulk').classList.toggle('hidden', pendingShownTotal === 0);
  // "סמן הכול / נקה בחירה" needs at least two rows to mean anything
  $('pending-sel').classList.toggle('hidden', pendingShownTotal < 2);
}

/**
 * Tick or clear every RENDERED row. Rows past `PARENT_LIST_CAP` have no checkbox and so
 * can never be selected — covering those is exactly what the unselected "אישור הכול" /
 * "דחיית הכול" scope is for.
 */
function setPendingSelection(on) {
  pendingSel.clear();
  for (const li of $('pending-list').children) {
    const cb = li.querySelector('.pick-cb');
    if (!cb) continue;
    cb.checked = on;
    li.classList.toggle('li-sel', on);
    if (on) pendingSel.add(li.dataset.sel);
  }
  paintPendingBulk();
}

/**
 * Read the queue WITHOUT touching the DOM. Split out in v1.0.24 so the bulk handlers can
 * see fresh records before a confirm dialog: re-rendering first would clear the parent's
 * ticks, and cancelling the dialog would leave them with nothing selected.
 */
async function collectPending() {
  const scopes = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const all = [];
  let total = 0;
  for (const s of scopes) {
    const r = await db.pagePending(s, { limit: 500 });
    all.push(...r.items);
    total += r.total;
  }
  return { all, total };
}

/** Pending queue (channel discoveries / quarantined sheet rows / shares). */
async function refreshPendingList() {
  const { all, total: grandTotal } = await collectPending();
  const badge = $('pending-badge');
  badge.textContent = grandTotal;
  badge.classList.toggle('hidden', grandTotal === 0);
  const ul = $('pending-list');
  ul.innerHTML = '';
  // v1.0.26: say it out loud. An empty list looked identical to a list that had not
  // loaded, on the very screen the blue dot sends the parent to.
  $('pending-empty').classList.toggle('hidden', grandTotal > 0);
  // A rebuild always follows a mutation, so a surviving tick could point at a row that is
  // gone (or is now live) — which is why this used to clear the whole selection.
  //
  // v1.0.26 keeps the ticks that are STILL THERE instead. Filtering against the rebuilt
  // list gives the same guarantee (no id can survive its row) while not throwing away work
  // the parent did: deciding one video — from its own ✅, or from the preview bubble —
  // must not silently untick the twenty rows they had lined up. Doing this by parameter
  // first was wrong and the browser showed it: `refreshAfterAdd` rebuilds the list too, a
  // beat later, and cleared them right back.
  const carried = new Set(pendingSel);
  pendingSel.clear();
  pendingShownTotal = grandTotal;
  const shown = all.slice(0, PARENT_LIST_CAP);
  const alive = new Set(shown.map((r) => selIdOf(r)));
  for (const id of carried) if (alive.has(id)) pendingSel.add(id);
  for (const rec of shown) {
    ul.appendChild(parentRow({
      rec,
      onPreview: () => openPreview(all, all.indexOf(rec), 'pending'),
      select: {
        id: selIdOf(rec),
        checked: pendingSel.has(selIdOf(rec)),
        onToggle: (r, on) => {
          if (on) pendingSel.add(selIdOf(r)); else pendingSel.delete(selIdOf(r));
          paintPendingBulk();
        }
      },
      onApprove: async () => {
        await db.approvePending(rec.scopeId, [rec.key]);
        await refreshPendingList();
        renderHome();
        // approval is what makes the record LIVE, so this is the moment it becomes
        // eligible for enrichment and for a gift rank — see refreshAfterAdd
        refreshAfterAdd({ parent: true });
        maybeSchedulePush();
      },
      onDelete: async () => {
        // v1.0.23: parked in '~rejected', NOT tombstoned — the parent can pull it back out
        // of the rejected list below. No '# הוסר' sheet row either: that denies the key on
        // every device permanently and would defeat the restore. Emptying the rejected list
        // is what makes it final.
        await db.rejectPending(rec.scopeId, [rec.key]);
        await refreshPendingList();
      }
    }));
  }
  paintPendingBulk();
  // v1.0.24: the queue and the gate dot must never disagree. Rejecting the last waiting
  // video used to leave the dot lit until something happened to re-render the home.
  refreshGateDot();
  await refreshRejectedList();
  return all;
}

/** Every rejected record across the profile's scopes, newest rejection first. */
async function collectRejected() {
  const scopes = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const out = [];
  for (const s of scopes) out.push(...(await db.pageRejected(s, { limit: 500 })).items);
  return out.sort((a, b) => (b.rejectedAt || 0) - (a.rejectedAt || 0));
}

/**
 * v1.0.23 — the rejected archive. Rendered from inside refreshPendingList so the two lists
 * can never disagree about what is where: one rejection moves a row from one to the other.
 */
async function refreshRejectedList() {
  const rej = await collectRejected();
  const box = $('rejected-box');
  box.classList.toggle('hidden', rej.length === 0);
  $('rejected-summary').textContent = `דחויים (${rej.length})`;
  // v1.0.26 — the archive empties itself, and that deletion CANNOT be undone (for a video
  // inside a channel there is no way back at all: only a sheet re-add revokes a tombstone,
  // and a channel video has no row). So say it, and give every row its own countdown.
  const { daysLeft } = planRejectedPurge(rej, { days: REJECTED_TTL_DAYS });
  $('rejected-ttl').textContent = `סרטון שנדחה נמחק לצמיתות אוטומטית אחרי ${REJECTED_TTL_DAYS} יום.`;
  const ul = $('rejected-list');
  ul.innerHTML = '';
  for (const rec of rej.slice(0, PARENT_LIST_CAP)) {
    const left = daysLeft.get(rec.key);
    ul.appendChild(parentRow({
      rec,
      note: left ? (left === 1 ? 'נמחק מחר' : `נמחק בעוד ${left} ימים`) : '',
      // ↩️ back to the approval queue — deliberately NOT straight to live: the parent is
      // reconsidering, and the queue is where a decision gets made.
      onApprove: async () => {
        await db.restoreRejected(rec.scopeId, [rec.key]);
        await refreshPendingList();
        maybeSchedulePush();
      },
      // per-item permanent delete, confirmed: this is the one action here with no way back
      onDelete: async () => {
        const yes = await confirmKid({
          emoji: '🗑️', title: 'למחוק את הסרטון לצמיתות?',
          text: 'הוא לא יחזור — גם לא בסנכרון הבא ולא במכשירים האחרים.',
          ok: 'מחיקה', cancel: 'ביטול', danger: true
        });
        if (!yes) return;
        await db.purgeRejected(rec.scopeId, [rec.key]);
        await refreshPendingList();
        maybeSchedulePush();
      }
    }));
  }
}

/**
 * v1.0.32 — stamp "the parent made this channel's sync decision". What clears a row out
 * of the "ערוצים חדשים" section (pure plan.planChannelSections reads it). Stamped by the
 * three-way dialog's REAL answers and by the auto-approve toggle — never by "אחר כך".
 */
async function markChannelDecided(channelId) {
  const scope = await currentLibScope();
  if (!scope) return;
  const lc = (await db.listLibraryChannels(scope)).find((c) => c.channelId === channelId);
  if (lc && !lc.decidedAt) await db.putLibraryChannel({ ...lc, decidedAt: Date.now() });
}

/** A tap on a row in "ערוצים חדשים": the same three-way dialog the add flow raises. */
async function decideNewChannel(lc) {
  // ⚠️ v1.0.61 — THE QUESTION IS THE SUBSCRIPTION MODE, ASKED ALWAYS (user report: the
  // button hid the row and asked nothing, leaving the channel on manual forever).
  //
  // It used to delegate to `offerChannelApproval`, which asks about the BACKLOG and returns
  // BEFORE opening any dialog when the queue is empty — and then this function read
  // `count === 0` as "the tap was the review", stamped `decidedAt` and moved the row on. Six
  // different states reach an empty queue: a Shorts-only channel, a peer's row this device
  // has not synced yet, an auto-approved default, a pending record parked in the PROFILE
  // scope, `pagePending`'s 5000 cap — and a null library scope, which is the exact failure
  // an invariant was already written about. In every one of them the parent answered
  // nothing and the channel silently stayed manual.
  //
  // A MODE is a property of the subscription and can always be asked; the backlog is a
  // consequence, and the same answer settles it.
  const scope = await currentLibScope();
  if (!scope) { toast('לא הצלחנו לקרוא את הספרייה — נסו שוב בעוד רגע'); return; }
  const ch = (await db.getChannel(lc.channelId)) || {};
  const name = lc.titleOverride || ch.title || (lc.kind === 'playlist' ? 'רשימת ההשמעה' : 'הערוץ');
  const keys = await pendingKeysOfChannel(lc.channelId);
  const q = channelSyncModeDialog({ name, pending: keys.length });
  const answer = await askKid({ emoji: '⚙️', title: q.title, text: q.text, ok: q.ok, third: q.third, cancel: q.cancel });
  // 'אחר כך' — and a dismiss, which is also what askKid answers when another modal is
  // already open — writes NOTHING, so the row stays where the parent can find it again.
  if (answer !== 'ok' && answer !== 'third') return;

  const auto = answer === 'ok';
  const row = (await db.listLibraryChannels(scope)).find((c) => c.channelId === lc.channelId);
  // BOTH fields, always: `autoApprove` is the sync mode (and IS the ✅ in the channel list),
  // `decidedAt` is what clears the row out of "ערוצים חדשים". The old empty-queue path wrote
  // only the second, which is precisely why the row vanished while nothing was decided.
  if (row) {
    await db.putLibraryChannel({
      ...row, autoApprove: auto, autoApproveSource: 'ui', decidedAt: row.decidedAt || Date.now()
    });
  }
  let approved = 0;
  if (keys.length) {
    if (auto) { await approveChannelBacklog(keys); approved = keys.length; }
    else await pickChannelVideos(lc.channelId, '"' + name + '"');
  }
  maybeSchedulePush();
  toast(channelSyncModeOutcome({ auto, approved, name }));
  await Promise.all([refreshChannelsList(), refreshPendingList()]);
  renderHome();
}

/** One subscription row. `fresh` rows trade the auto-approve toggle for the decision button. */
/* ---------------- custom folders: the parent's management list (v1.0.56) ------------- */

/**
 * EVERY folder, including the EMPTY ones. The child's home hides a folder at zero (the
 * v1.0.21 rule — a tile that opens an empty grid is a bug), so without this list a parent
 * who emptied a folder could never reach it again to rename, re-picture or delete it.
 */
async function refreshFoldersList() {
  const ul = $('folders-list');
  ul.innerHTML = '';
  $('folders-count').textContent = 'תיקיות';
  if (!libScope) return;
  const rows = (await db.listCustomFolders(libScope)).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  $('folders-count').textContent = rows.length ? `תיקיות (${rows.length})` : 'תיקיות';
  // v1.0.61 — THE LIST SHOWS THE TREE. 34 flat rows for one imported collection is the same
  // clutter the child's home just stopped having, and it hides which folder a disc belongs
  // to — which is exactly what a parent about to DELETE one needs to see. Children are
  // listed under their parent and indented; an orphan (a peer's row whose parent has not
  // arrived) is listed at the top level rather than dropped.
  const kidsOf = new Map();
  const ids = new Set(rows.map((r) => r.folderId));
  for (const r of rows) {
    const parent = r.parentFolderId && ids.has(r.parentFolderId) ? r.parentFolderId : null;
    if (!parent) continue;
    if (!kidsOf.has(parent)) kidsOf.set(parent, []);
    kidsOf.get(parent).push(r);
  }
  const emit = async (cf, depth) => {
    ul.appendChild(await customFolderRow(cf, depth, (kidsOf.get(cf.folderId) || []).length));
    for (const kid of kidsOf.get(cf.folderId) || []) await emit(kid, depth + 1);
  };
  for (const cf of rows) {
    if (cf.parentFolderId && ids.has(cf.parentFolderId)) continue; // emitted under its parent
    await emit(cf, 0);
  }
}

async function customFolderRow(cf, depth = 0, children = 0) {
  const li = document.createElement('li');
  if (depth) li.style.paddingInlineStart = Math.min(depth, 3) * 18 + 'px';
  const ico = document.createElement('span');
  ico.className = 'fp-ico';
  mountCustomArt(ico, cf.artThumbId, cf.emoji || '📁');
  const body = document.createElement('div');
  body.className = 'li-body';
  const title = document.createElement('div');
  title.className = 'li-title';
  title.textContent = cf.title || 'תיקיה';
  const sub = document.createElement('div');
  sub.className = 'li-note';
  const count = await db.countFolder(libScope, cf.folderId);
  // v1.0.61 — a folder that holds FOLDERS is neither empty nor hidden from the child, and
  // the old note said both. Measured on the real 32-disc collection: the row for the
  // collection itself read "ריקה — לא מוצגת לילד" while it sat on the child's home.
  const kids = children ? (children === 1 ? 'תיקיה אחת' : `${children} תיקיות`) : '';
  sub.textContent = kids && count ? `${kids} · ${count} סרטונים`
    : kids ? kids
    : count ? `${count} סרטונים`
    : 'ריקה — לא מוצגת לילד עד שיהיה בה תוכן';
  body.appendChild(title);
  body.appendChild(sub);

  const rename = document.createElement('button');
  rename.className = 'btn btn-small';
  rename.type = 'button';
  rename.textContent = '✏️ שם';
  rename.addEventListener('click', () => renameCustomFolder(cf).catch(() => {}));
  // v1.0.58 — CHANGE THE PICTURE (user request). It sits beside the rename because they are
  // the same kind of act: the folder exists, and this is how the parent adjusts it.
  const art = document.createElement('button');
  art.className = 'btn btn-small';
  art.type = 'button';
  art.textContent = '🖼️ תמונה';
  art.addEventListener('click', () => openFolderArtEditor(cf).catch(() => {}));

  const del = document.createElement('button');
  del.className = 'li-del';
  del.type = 'button';
  del.textContent = '🗑️';
  del.setAttribute('aria-label', 'מחיקת התיקיה');
  del.addEventListener('click', () => deleteCustomFolderFlow(cf).catch(() => {}));

  li.appendChild(ico);
  li.appendChild(body);
  li.appendChild(rename);
  li.appendChild(art);
  li.appendChild(del);
  return li;
}

async function renameCustomFolder(cf) {
  const next = normalizeFolderTitle(window.prompt('שם חדש לתיקיה', cf.title || '') || '');
  if (!next || next === cf.title) return;
  const clash = customFolderTitleClash(next, await db.listCustomFolders(libScope), { exceptId: cf.folderId });
  if (clash) { toast('כבר יש תיקיה בשם הזה'); return; }
  await db.putCustomFolder({ ...cf, title: next });
  await refreshFoldersList();
  renderHome();
  maybeSchedulePush();
  toast('השם עודכן ✅');
}

/**
 * Deleting a folder asks what happens to what is INSIDE it — the one question the
 * `siteEntries` precedent could not answer for us, because a site entry holds nothing.
 * The orphan GC will NOT clean up after a wrong answer here: it never touches records with
 * no channelId (plan.planOrphanGC), which is every manual single — so a folder deleted
 * without re-homing its videos would leave them filed under a folder that no longer
 * exists, invisible on every screen and un-reachable forever. Hence: MOVE by default.
 */
async function deleteCustomFolderFlow(cf) {
  // v1.0.61 — DELETING A COLLECTION DELETES THE FOLDERS INSIDE IT (the user's decision: it
  // behaves like Drive). Without the cascade the discs survive with a parent that no longer
  // exists — `homeFolderRows` would put all 32 of them back on the home screen, which is
  // both a mess and precisely the shape this whole feature removes.
  const allRows = await db.listCustomFolders(libScope).catch(() => []);
  const subtree = folderSubtreeIds(cf.folderId, allRows);
  const descendants = subtree.filter((id) => id !== cf.folderId);
  // Every folder of the subtree is counted, not just this one — the confirm must name what
  // the tap actually destroys, and the purge branch must reach every video inside it.
  let count = 0;
  for (const id of subtree) count += await db.countFolder(libScope, id).catch(() => 0);
  const plan = planFolderDeletion({ title: cf.title, count, children: descendants.length });
  const dropRows = async () => {
    // The children go FIRST: each gets its own `cfDel:` tombstone, because absence alone is
    // re-added by any peer that has not pulled (the v1.0.36 rule).
    for (const id of descendants) await db.deleteCustomFolder(libScope, id);
    await db.deleteCustomFolder(libScope, cf.folderId);
  };
  if (!plan.needsChoice) {
    if (!(await confirmKid({ emoji: '🗑️', title: 'מחיקת תיקיה', text: plan.text, ok: 'מחיקה', cancel: 'ביטול', danger: true }))) return;
    await dropRows();
  } else {
    const answer = await askKid({
      emoji: '🗑️', title: 'מחיקת תיקיה', text: plan.text,
      ok: 'העברה ומחיקת התיקיה', cancel: 'ביטול', third: 'מחיקת הכול לצמיתות'
    });
    if (answer === 'cancel' || answer === 'dismiss') return;
    if (answer === 'third') {
      const purge = planFolderDeletion({ title: cf.title, count, mode: 'purge' });
      if (!(await confirmKid({ emoji: '⚠️', title: 'למחוק לצמיתות?', text: purge.text, ok: 'כן, למחוק', cancel: 'ביטול', danger: true }))) return;
      const inSubtree = new Set(subtree);
      const recs = [...(await db.loadMergeIndex(libScope)).values()]
        .filter((r) => inSubtree.has(r.folderId === '~pending' || r.folderId === '~rejected' ? r.homeFolderId : r.folderId));
      // v1.0.58 — ONE question for the whole folder, never one per video (the user's
      // decision), and only if any of them was actually downloaded.
      const localChoice = await askDeleteLocalCopies(recs);
      if (localChoice === 'cancel') return;
      await applyDeleteLocalCopies(recs, localChoice);
      // WITH tombstones (the v1.0.39 rule): a raw delete is pure absence, and every Drive
      // merge is a union — a peer that has not pulled would re-push every one of them.
      await db.deleteVideosWithTombstones(libScope, recs.map((r) => r.key), 'folder-delete');
      await dropRows();
    } else {
      for (const id of subtree) await db.moveFolderVideos(libScope, id, 'sheet');
      await dropRows();
    }
  }
  await refreshFoldersList();
  await refreshParentList();
  renderHome();
  maybeSchedulePush();
  toast('התיקיה נמחקה');
}

/**
 * v1.0.56 — import a public Drive FOLDER as a self-refilling custom folder.
 *
 * `first` distinguishes the parent's add (creates the folder row, names it after the Drive
 * folder) from the periodic refresh (adds only what is new). Shared by both so the two can
 * never drift — the importChannelAndAsk lesson.
 *
 * ADDITIVE ONLY: a file that vanished from Drive is never deleted here. An unreadable
 * listing is reported, NEVER treated as an empty folder — that mistake is what deleted
 * families' libraries in the sheet era (interpretSheetResponse doctrine).
 */
async function importDriveFolder(scope, driveFolderId, { folder = null, first = true, onNote = null } = {}) {
  const { fetchDriveFolderTree } = await import('./gdrivepub.js');
  const cls = await import('./classify.js');
  const tree = await fetchDriveFolderTree(driveFolderId, {
    onProgress: (done, seen) => { if (onNote) try { onNote(done, seen); } catch {} }
  });
  if (!tree.ok) return { ok: false, message: driveFolderOutcome({ ok: false }), added: 0 };

  const index = await db.loadMergeIndex(scope);
  const denySet = await db.loadDenySet(scope);
  const existingFolders = await db.listCustomFolders(scope);
  let plan = planDriveTreeImport({
    folders: tree.folders,
    existingFolders,
    existingKeys: new Set(index.keys()),
    denyKeys: denySet,
    rootId: driveFolderId,
    // the icon URL gives a real mimeType keylessly; the filename is the fallback
    mediaKindOf: (f) => cls.mediaKindFromMime(f.mimeType) || cls.mediaKindFromName(f.name)
  });

  // v1.0.61 — CONTENT THE PARENT REMOVED BEFORE IS OFFERED BACK, ONCE FOR THE WHOLE IMPORT
  // (user request). Until now a Drive folder holding files that had been deleted here just
  // skipped them, and said so only when NOTHING else arrived — so a folder that imported 30
  // new songs never mentioned the 12 it silently refused.
  //
  // The parent is asked while they are standing here, behind the code gate they already
  // crossed to reach the add form, and one question covers the batch (the links-file
  // precedent). Answering yes revokes the tombstones and re-runs the SAME plan, so nothing
  // downstream has to know this happened.
  if (plan.deniedKeys && plan.deniedKeys.length && first) {
    const { deniedReAddPrompt } = await import('./plan.js');
    const q = deniedReAddPrompt({ denied: true, exists: false, source: 'drive-folder', count: plan.deniedKeys.length });
    if (q.ask && await confirmKid({ emoji: q.emoji, title: q.title, text: q.text, ok: q.ok, cancel: q.cancel })) {
      const scopes = [...new Set([scope, activeProfileId ? db.profScope(activeProfileId) : null])].filter(Boolean);
      for (const key of plan.deniedKeys) for (const sc of scopes) await db.unDeny(sc, key);
      plan = planDriveTreeImport({
        folders: tree.folders,
        existingFolders: await db.listCustomFolders(scope),
        existingKeys: new Set((await db.loadMergeIndex(scope)).keys()),
        denyKeys: await db.loadDenySet(scope),
        rootId: driveFolderId,
        mediaKindOf: (f) => cls.mediaKindFromMime(f.mimeType) || cls.mediaKindFromName(f.name)
      });
    }
  }

  const { sortKeyFor } = await import('./order.js');
  const now = Date.now();
  let rootFolderId = folder ? folder.folderId : null;
  let step = 0;
  // v1.0.61 — Drive id → the `cf:` id of the row that represents it, so a child can name its
  // parent. `plan.folders` follows the walk's BREADTH-FIRST order, so a parent is always
  // filled in before the children that look it up (the walk is breadth-first for its own
  // reason — see gdrivepub — and this now depends on it, which the tests pin).
  const cfOf = new Map();
  for (const node of plan.folders) {
    // The row the parent's ADD created (if any) is the root's row — reuse it rather than
    // minting a second folder for the same Drive id.
    let target = node.existing || (node.isRoot ? folder : null);
    const parentFolderId = node.parentDriveId ? (cfOf.get(node.parentDriveId) || null) : null;
    if (!target) {
      const order = now + (step += 1);
      target = {
        scopeId: scope, folderId: customFolderId(order), title: node.title, emoji: '📂',
        artThumbId: null, artSrcUrl: null, driveFolderId: node.driveFolderId,
        // v1.0.58 — a DESCENDANT names the root it came from. The refresh walks ROOTS only:
        // the root's own walk re-lists this folder anyway, so without this marker a tree of
        // 33 folders would re-list itself 33 times over, every half hour.
        driveRootId: node.isRoot ? null : driveFolderId,
        parentFolderId,
        order, createdAt: order
      };
      await db.putCustomFolder(target);
    } else if ((target.parentFolderId || null) !== parentFolderId) {
      // THE MIGRATION, and it is the whole of it: every row of a tree imported before
      // v1.0.61 is matched here by its driveFolderId and gains its parent in place, so the
      // discs leave the home screen by themselves on the next add or refresh. It also
      // repairs a row whose parent was deleted and re-made.
      target = { ...target, parentFolderId };
      await db.putCustomFolder(target);
    }
    cfOf.set(node.driveFolderId, target.folderId);
    if (node.isRoot) rootFolderId = target.folderId;
    if (!node.add.length) continue;
    const recs = node.add.map((f, i) => ({
      scopeId: scope, key: 'file:drive:' + f.driveId, type: 'file', id: null,
      url: `https://drive.google.com/uc?export=download&id=${f.driveId}`,
      srcUrl: `https://drive.google.com/file/d/${f.driveId}/view`,
      driveId: f.driveId, media: f.media,
      title: cls.titleFromFileName(f.name),
      titleSource: 'sheet', normTitle: normalizeTitle(cls.titleFromFileName(f.name)),
      folderId: target.folderId, channelId: null,
      // `i` keeps the folder's NATURAL name order (planDriveFolderImport sorted them):
      // sortKey renders DESC, so the later index must be the smaller key
      sortKey: sortKeyFor({ origin: 'manual', addedAt: now }) - i,
      publishedAt: null, rowIndex: null, origin: 'manual', state: 'live',
      addedAt: now, approvedAt: now,
      thumbId: null, thumbUrl: null, localPath: null, updatedAt: now
    }));
    await db.putVideos(recs);
    // stamp EVERY folder we just refilled, not only the root: each one carries its own
    // driveFolderId, and the stamp is what the throttle reads
    await db.putCustomFolder({ ...target, driveSyncedAt: Date.now() });
  }
  // the root is stamped even when nothing landed in it — it is the anchor the refresh walks
  const rootRow = plan.folders.find((n) => n.isRoot);
  if (rootRow) {
    const row = rootRow.existing || (folder && folder.driveFolderId === driveFolderId ? folder : null)
      || (await db.listCustomFolders(scope)).find((f) => f.driveFolderId === driveFolderId);
    if (row) await db.putCustomFolder({ ...row, driveSyncedAt: Date.now() });
  }
  return {
    ok: true, added: plan.added, folderId: rootFolderId,
    message: driveFolderOutcome({
      ok: true, added: plan.added, skipped: plan.skipped, first,
      folders: plan.folders.filter((n) => !n.isRoot || n.add.length).length,
      truncated: tree.truncated, partial: tree.partial
    })
  };
}

/**
 * v1.0.56 — the SUBSCRIPTION half: re-list every Drive-backed folder and pick up files the
 * parent has since added there (the user's decision: additive, never a mirror).
 *
 * It lives in app.js rather than sync2 deliberately — it is not a YouTube stage, it must
 * not join the quota/backfill machinery, and it is bounded by its own throttle. Silent and
 * best-effort: a failed listing leaves everything exactly as it was.
 */
const DRIVE_FOLDER_REFRESH_MS = 30 * 60 * 1000;
async function refreshDriveFolders(scope) {
  if (!scope) return 0;
  let added = 0;
  try {
    // v1.0.58 — ROOTS ONLY. Every folder of an imported TREE carries its own
    // driveFolderId (that is what makes each one refill itself), but the root's walk
    // already re-lists the whole tree — so refreshing the descendants too would list a
    // 33-folder tree 33 times over, every half hour, on a family's mobile data. A row
    // whose root row is GONE (the parent deleted it) refreshes itself again, or the
    // parent's remaining folders would quietly stop updating.
    const all = await db.listCustomFolders(scope);
    const roots = new Set(all.map((f) => f && f.driveFolderId).filter(Boolean));
    const rows = all.filter((f) => f && f.driveFolderId && !(f.driveRootId && roots.has(f.driveRootId)));
    for (const f of rows) {
      if (f.driveSyncedAt && Date.now() - f.driveSyncedAt < DRIVE_FOLDER_REFRESH_MS) continue;
      const res = await importDriveFolder(scope, f.driveFolderId, { folder: f, first: false });
      if (res.ok) added += res.added;
    }
  } catch { /* housekeeping must never take the entry refresh down with it */ }
  return added;
}

/** Move ONE existing video into a folder — the door for anything that did not arrive
 *  through the add form (a share from YouTube, a links-file import, an old library). */
async function moveVideoToFolder(rec) {
  const chosen = await askFolderDestination({ title: 'להעביר לאיזו תיקיה?', sub: rec.title || '' });
  if (!chosen) return false;
  const parked = rec.folderId === '~pending' || rec.folderId === '~rejected';
  await db.setVideoFields(rec.scopeId, rec.key, parked
    ? { homeFolderId: chosen }
    : { folderId: chosen, homeFolderId: rec.homeFolderId ? chosen : rec.homeFolderId });
  await refreshParentList();
  await refreshFoldersList();
  renderHome();
  maybeSchedulePush();
  toast('הסרטון הועבר ✅');
  return true;
}

async function channelRow(lc, { fresh = false } = {}) {
  const ch = (await db.getChannel(lc.channelId)) || {};
  const li = document.createElement('li');
  const logo = document.createElement('img');
  logo.className = 'li-thumb';
  logo.style.width = '46px';
  logo.style.aspectRatio = '1';
  logo.style.borderRadius = '50%';
  // v1.0.24: a channel with no avatar used to render an EMPTY <img> here — a blank hole,
  // not even the 📺 the home screen falls back to. And a URL that failed to load was
  // never reported, so it could never be replaced.
  // v1.0.32: cached bytes swap in (and get fetched when missing) — same cache the
  // child's folder tiles use, so this list heals the same way. Memory-cached bytes
  // paint FIRST (hardening): no network <img> when the cache is already warm.
  const cachedLogo = logoObjUrls.get(lc.channelId);
  const firstPaint = logoFirstPaint({ cachedObjUrl: cachedLogo && cachedLogo.objUrl, url: ch.logoUrl || null });
  if (firstPaint.kind !== 'emoji') logo.src = firstPaint.src;
  if (firstPaint.kind === 'url') {
    logo.onerror = () => { logo.removeAttribute('src'); noteLogoFailure(lc.channelId); };
  }
  resolveLogo(lc.channelId, ch.logoUrl || null, logo, null).catch(() => {});
  const body = document.createElement('div');
  body.className = 'li-body';
  const title = document.createElement('div');
  title.className = 'li-title';
  title.textContent = lc.titleOverride || ch.title || lc.channelId;
  body.appendChild(title);
  if (fresh) {
    // v1.0.32: the decision affordance — a real <button> (the TV remote needs one).
    const decide = document.createElement('button');
    decide.className = 'btn btn-small btn-primary';
    decide.type = 'button';
    decide.textContent = '⚙️ איך לסנכרן את הערוץ?';
    decide.addEventListener('click', () => decideNewChannel(lc).catch(() => {}));
    body.appendChild(decide);
  } else {
    const toggle = document.createElement('label');
    toggle.className = 'li-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!lc.autoApprove;
    cb.addEventListener('change', async () => {
      // flipping the toggle IS the sync decision (v1.0.32) — in either direction
      await db.putLibraryChannel({
        ...lc, autoApprove: cb.checked, autoApproveSource: 'ui',
        decidedAt: lc.decidedAt || Date.now()
      });
      if (!cb.checked) return;
      // v1.0.6: turning auto-approve ON offers to flush the channel's WAITING videos
      // too — otherwise they'd sit in ממתינים forever ("approved the channel, why is
      // the queue still full?"). Declining keeps them for one-by-one review.
      const keys = await pendingKeysOfChannel(lc.channelId);
      if (!keys.length) return;
      const yes = await confirmKid({
        emoji: '✅', title: `לאשר גם ${keys.length} סרטונים שממתינים?`,
        text: 'הם ייכנסו מיד לתיקיית הערוץ אצל הילד. "רק מהיום" ישאיר אותם ברשימת הממתינים.',
        ok: 'אישור הכול', cancel: 'רק מהיום והלאה'
      });
      if (!yes) return;
      await approveChannelBacklog(keys);
    });
    toggle.appendChild(cb);
    toggle.appendChild(document.createTextNode('אישור אוטומטי לסרטונים חדשים'));
    body.appendChild(toggle);
  }
  const del = document.createElement('button');
  del.className = 'li-del'; del.type = 'button'; del.textContent = '🗑️';
  del.addEventListener('click', async () => {
    const yes = await confirmKid({
      emoji: '📺', title: 'להסיר את הערוץ?',
      text: 'הערוץ וכל הסרטונים שלו יימחקו — גם מקובץ המקורות, אצל כל מי שמשתמש בו. אפשר להוסיף אותו שוב בעתיד.',
      ok: 'הסרה', cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    // v1.0.38: the subscription + everything it orphans. `removeSubscription` replaces the
    // channel half of applySheetMirror (which goes away with the sheet); the tombstone that
    // carries the removal to every device is written inside db.deleteLibraryChannel (v1.0.36).
    const { removeSubscription } = await import('./sync2.js');
    await removeSubscription(libScope, lc.channelId);
    await loadGiftStates();
    await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList()]);
    renderHome();
    maybeSchedulePush();
  });
  // v1.0.21: a channel with NO long-form videos yields nothing, because Shorts are
  // excluded on purpose. Say it here — otherwise the parent sees an empty folder and
  // reasonably concludes the app is broken.
  if (ch.noLongForm) {
    const note = document.createElement('div');
    note.className = 'li-note';
    note.textContent = 'הערוץ הזה מפרסם רק Shorts — לא נמשכו ממנו סרטונים.';
    body.appendChild(note);
  }
  li.appendChild(logo);
  li.appendChild(body);
  li.appendChild(del);
  return li;
}

/* ---------------- rolling window (v1.0.39) ---------------- */
/**
 * The parent's window size for the ACTIVE profile. Per-profile and SYNCED (a screen-time
 * style decision belongs to the child, not the tablet), 0 = off — see plan.keepNewestPerChannel
 * for why every unusable value also reads as off.
 */
async function keepNewestSetting() {
  if (!activeProfileId) return 0;
  try { return keepNewestPerChannel(await getSetting(activeProfileId, 'keepNewest', null)); } catch { return 0; }
}

/**
 * Which channels currently sit OVER the window — DERIVED on demand, never stored.
 *
 * Nothing is persisted deliberately: a stored proposal is a second source of truth that
 * would go stale the moment a sync, a peer's pull or the parent's own deletion changed the
 * folder (the whole class of bug v1.0.38 removed). The derivation is one library read,
 * which the parent screen does anyway.
 *
 * The protected set is the parent's own marks (`keepForever`) plus a saved playback
 * position — see plan.protectedWindowKeys for why `unwrappedAt` is NOT in that list
 * (the gift baseline stamps it library-wide, which made the window a measured no-op).
 */
async function channelsOverWindow() {
  const keep = await keepNewestSetting();
  if (!keep) return { keep: 0, byChannel: {}, total: 0 };
  const scope = await currentLibScope();
  if (!scope) return { keep, byChannel: {}, total: 0 };
  const records = [...(await db.loadMergeIndex(scope)).values()];
  // pure, and deliberately so: the first version of this read `giftStates` — a MAP — with
  // Object.entries, so the "the child watched it" half of the protection matched NOTHING
  // and nothing but the parent's own ticks was ever safe. The browser caught it; the pure
  // helper is what makes it testable.
  // v1.0.40 — the SIBLINGS' stars count too. A legacy shared library (`lib:<hash>`) is read
  // by several profiles, so pruning under child A's window would otherwise delete a video
  // child B had starred — the same cross-profile rule db.deleteVideoStates follows.
  // v1.0.57: the profile ID is kept ALONGSIDE its state map — 🕒's size is per profile, so
  // protecting a sibling's recent list needs to know whose list it is (and how long).
  const siblings = [];
  for (const p of await getProfiles()) {
    if (p.id === activeProfileId) continue; // the active one is `giftStates`, already loaded
    const src = await db.getSources(p.id).catch(() => null);
    if (!src || src.libraryId !== scope) continue;
    const states = await db.loadVideoStates(p.id).catch(() => null);
    if (states) siblings.push({ pid: p.id, states });
  }
  const statesByProfile = siblings.map((s) => s.states);
  // v1.0.57 — and whatever is in 🕒 RIGHT NOW, for this child AND for every sibling reading
  // this library. The keys are computed here rather than inside the pure helper because the
  // limit is per profile: `recentLimit` is the active child's, and each sibling's own number
  // decides how much of their history is protected. A sibling whose 🕒 is off protects
  // nothing, which is correct — they have no such folder.
  const recent = recentKeys(giftStates, recentLimit);
  for (const s of siblings) {
    const lim = recentLimitFor(await getSetting(s.pid, 'recentLimit', null).catch(() => null));
    recent.push(...recentKeys(s.states, lim));
  }
  const guarded = protectedWindowKeys({ records, states: giftStates, statesByProfile, recent });
  const plan = planChannelWindow({ records, keep, protectedKeys: guarded });
  return { keep, ...plan };
}

/** The מקורות tab's notice: name the channels that are over, never delete on our own. */
async function refreshWindowBox() {
  const box = $('window-box');
  const ul = $('window-list');
  if (!box || !ul) return;
  ul.innerHTML = '';
  let over;
  try { over = await channelsOverWindow(); } catch { over = { total: 0, byChannel: {} }; }
  const ids = Object.keys(over.byChannel || {});
  box.classList.toggle('hidden', ids.length === 0);
  if (!ids.length) return;
  // hoisted: the subscription list is per LIBRARY, and reading it inside the loop made the
  // notice quadratic in the number of channels over the window
  const subs = await db.listLibraryChannels(await currentLibScope()).catch(() => []);
  for (const id of ids) {
    const entry = over.byChannel[id];
    const ch = await db.getChannel(id).catch(() => null);
    const lc = subs.find((c) => c.channelId === id) || null;
    const name = (lc && lc.titleOverride) || (ch && ch.title) || id;
    const li = document.createElement('li');
    const img = document.createElement(ch && ch.logoUrl ? 'img' : 'span');
    img.className = 'li-thumb';
    if (ch && ch.logoUrl) img.src = ch.logoUrl; else img.textContent = '📺';
    const body = document.createElement('div');
    body.className = 'li-body';
    const t = document.createElement('div');
    t.className = 'li-title';
    t.textContent = name;
    const note = document.createElement('div');
    note.className = 'li-note';
    note.textContent = `${entry.total} סרטונים · ${entry.over.length} מעל המגבלה`;
    body.appendChild(t);
    body.appendChild(note);
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.type = 'button';
    btn.textContent = 'בדיקה';
    btn.addEventListener('click', () => { reviewChannelWindow(id, name).catch(() => {}); });
    li.appendChild(img);
    li.appendChild(body);
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

/**
 * THE REVIEW. The one place the rolling window may delete anything, and it deletes only
 * what the parent just answered for.
 *
 * Rows arrive UNTICKED — they are the videos PROPOSED for deletion, and a tick means "keep
 * this one forever" (the user's request: "let me mark what not to delete"). That is the
 * mirror image of the approval picker, where everything starts ticked because a freshly
 * added channel is presumed wanted; here the parent is confirming a removal they enabled,
 * so the safe default is that a tick is an act.
 *
 * Two answers, both explicit:
 *   pick-ok  → delete the ones over the window that are NOT ticked
 *   pick-alt → delete EVERY video of this channel except the ticked ones ("start over, and
 *              from now on only new uploads arrive" — the backfill is finished for a
 *              subscribed channel, so RSS is all that is left, which IS "only new")
 * A tick always wins over both, so a protected favourite is never in danger.
 */
let windowReviewOpening = false;
async function reviewChannelWindow(sourceId, name) {
  // ONE review at a time. The prelude does two full library reads before it navigates, so a
  // double-tap on 🧺 בדיקה (or a tap on a second over-limit row) used to let a SECOND review
  // finish behind the first: it repainted the list and replaced `pickHandlers`, and the
  // resulting `nav.go('pick')` fired the pick view's onLeave, which nulls whatever
  // pickHandlers currently holds — the LIVE one. The screen was then a zombie: B's rows with
  // dead buttons, two 'pick' entries on the stack, and a confirm that could name channel A
  // over channel B's list. Reachable only because `keepOpen` deliberately keeps the handlers
  // alive while the screen is up.
  if (windowReviewOpening || nav.isActive('pick')) return false;
  windowReviewOpening = true;
  try {
    return await openWindowReview(sourceId, name);
  } finally {
    windowReviewOpening = false;
  }
}

async function openWindowReview(sourceId, name) {
  const scope = await currentLibScope();
  if (!scope) return false;
  const over = await channelsOverWindow();
  const entry = (over.byChannel || {})[sourceId];
  if (!entry || !entry.over.length) { await refreshWindowBox(); return false; }

  const index = await db.loadMergeIndex(scope);
  const records = [...index.values()];
  // ONE protected set for BOTH buttons, and ONE list of records behind every number on the
  // screen. Two separate defects came from not doing this:
  //  · `allLive` excluded only `keepForever`, so pick-alt tombstoned the OTHER protected
  //    half (a saved playback position). Identical shape to the bug that exclusion fixed:
  //    a protected video is never proposed, so it is never rendered, so it cannot be
  //    ticked — the parent has no way to save it.
  //  · the labels counted records found in THIS read while the delete pool used the keys
  //    from the earlier one, so the button could say 38 and the confirm 40.
  const guarded = protectedWindowKeys({ records, states: giftStates });
  const proposed = entry.over.map((k) => index.get(k)).filter((r) => r && !guarded.has(r.key));
  const { rows, hidden, total } = pruneReviewList(proposed, PRUNE_REVIEW_CAP);
  const proposedKeys = proposed.map((r) => r.key);
  // What pick-alt ("start this channel over") acts on: every live video of the source that
  // is not protected at all.
  const allLive = records.filter((r) => r && r.state === 'live' && !guarded.has(r.key)
    && (r.folderId === 'ch:' + sourceId || r.folderId === 'pl:' + sourceId));

  const keepTicked = new Set();
  const ul = $('pick-list');
  const paint = () => {
    const willDelete = total - keepTicked.size;
    $('pick-sub').textContent = hidden
      ? `${name} · ${total} סרטונים מוצעים למחיקה (מוצגים ${rows.length} החדשים שביניהם; ${hidden} נוספים לא מוצגים) · סומנו להשארה: ${keepTicked.size}`
      : `${name} · ${total} סרטונים מוצעים למחיקה · סומנו להשארה: ${keepTicked.size}`;
    $('pick-ok').textContent = `מחיקת ${Math.max(0, willDelete)} הישנים`;
    $('pick-alt').textContent = `מחיקת כל ${Math.max(0, allLive.length - keepTicked.size)} הסרטונים של הערוץ`;
  };
  $('pick-title').textContent = 'מה למחוק מהערוץ?';
  // the borrowed chrome, retargeted: a green ✅ over a deletion screen and "סמן הכול"
  // (which here means "keep everything") both read backwards
  $('pick-emoji').textContent = '🧺';
  $('pick-all').textContent = 'להשאיר הכול';
  $('pick-none').textContent = 'לא להשאיר אף אחד';
  $('pick-alt').classList.remove('hidden');
  ul.innerHTML = '';
  const boxes = new Map();
  for (const rec of rows) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'pick-cb';
    cb.checked = false;
    const img = document.createElement('img');
    img.className = 'li-thumb';
    setThumb(img, rec);
    const body = document.createElement('div');
    body.className = 'li-body';
    const title = document.createElement('div');
    title.className = 'li-title';
    title.textContent = rec.title || '(ללא שם)';
    body.appendChild(title);
    const sync = () => {
      if (cb.checked) keepTicked.add(rec.key); else keepTicked.delete(rec.key);
      li.classList.toggle('pick-off', !cb.checked);
      paint();
    };
    li.classList.add('pick-off'); // unticked = on its way out, and it should look like it
    li.addEventListener('click', (e) => { if (e.target !== cb) { cb.checked = !cb.checked; sync(); } });
    cb.addEventListener('change', sync);
    boxes.set(rec.key, { cb, li });
    li.appendChild(cb);
    li.appendChild(img);
    li.appendChild(body);
    ul.appendChild(li);
  }
  const setAll = (on) => {
    keepTicked.clear();
    for (const [key, { cb, li }] of boxes) {
      cb.checked = on;
      li.classList.toggle('pick-off', !on);
      if (on) keepTicked.add(key);
    }
    paint();
  };
  paint();

  let settled = false;
  const commit = async (everything) => {
    if (settled) return;
    settled = true;
    // EVERY release of `settled` goes through here. It used to be released only on a
    // cancelled confirm, so ANY rejection inside the work below (a tx-aborted write, a
    // quota failure, a chunk of the delete) left the parent on the review with both delete
    // buttons permanently inert, no message, and possibly the marks written but nothing
    // deleted — the `.catch(() => {})` on the handlers swallowed the reason.
    try {
      const pool = everything ? allLive.map((r) => r.key) : proposedKeys;
      const doomed = pool.filter((k) => !keepTicked.has(k));
      if (!doomed.length) { // ticking every row is a legitimate answer: nothing to do
        toast(keepTicked.size ? 'לא נמחק כלום — כל הסרטונים סומנו להשארה' : 'אין מה למחוק');
        settled = false;
        return;
      }
      // `emptied`: this wipe leaves the channel with no live video, so its tile disappears
      // from the child's home — and the tombstones mean the current RSS window will NOT
      // come back, only a genuinely new upload.
      const emptied = everything && !allLive.some((r) => keepTicked.has(r.key))
        && !records.some((r) => r.state === 'live' && guarded.has(r.key)
          && (r.folderId === 'ch:' + sourceId || r.folderId === 'pl:' + sourceId));
      const { title, text } = pruneConfirmText({
        name, count: doomed.length, kept: keepTicked.size, emptied,
        // only the window answer hides rows; the wipe acts on everything either way
        hidden: everything ? 0 : hidden
      });
      const yes = await confirmKid({ emoji: '🧺', title, text, ok: 'מחיקה', cancel: 'ביטול', danger: true });
      if (!yes) { settled = false; return; } // stay on the screen — nothing happened
      let removed = 0;
      await withChannelWait('saving', { count: doomed.length }, async () => {
        // the marks FIRST: a crash between the two must leave the favourites protected,
        // never leave them deletable with the deletion already done
        if (keepTicked.size) await db.markKeepForever(scope, [...keepTicked]);
        // RE-READ before deleting. The proposal was computed when the screen opened, and a
        // sync, a Drive pull or the parent's own action in another tab can have moved a video
        // since: approved into pending, rejected, protected, or deleted outright. Writing a
        // tombstone for something that is no longer a prunable live record would delete
        // (and permanently deny) a video nobody in this dialog was asked about.
        const fresh = await db.loadMergeIndex(scope);
        const live = doomed.filter((k) => {
          const r = fresh.get(k);
          return r && r.state === 'live' && !r.keepForever;
        });
        if (live.length) await db.deleteVideosWithTombstones(scope, live, 'window-prune');
        // …AND their per-child state. Not bookkeeping: planGifts counts outstanding gifts
        // straight out of that store, records or none, and stops gifting at
        // `outstanding >= baseline` — so orphan un-opened ranks would jam 🎁 FOREVER
        // (planGiftRunawayRepair no-ops below its 60-record floor). The 🎁 tile counts the
        // same index, so they would also promise a folder that resolves to nothing, and
        // drive.serializeStateEntry would carry them in the family document indefinitely.
        // Cleared for every profile that READS this library, not just the active one: a
        // legacy shared scope means a sibling's gift counter is jammed just as easily.
        if (live.length) {
          const pids = [];
          for (const p of await getProfiles()) {
            const src = await db.getSources(p.id).catch(() => null);
            if (src && src.libraryId === scope) pids.push(p.id);
          }
          if (activeProfileId && !pids.includes(activeProfileId)) pids.push(activeProfileId);
          await db.deleteVideoStates(pids, live);
          for (const k of live) giftStates.delete(k);
        }
        removed = live.length;
        await loadGiftStates();
        await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList(), refreshWindowBox()]);
        renderHome();
        maybeSchedulePush();
      });
      if (nav.isActive('pick')) nav.back();
      toast(`נמחקו ${removed} סרטונים מ"${name}"`);
    } catch (e) {
      // Say so, and let them try again — a silent dead end is the worse failure.
      settled = false;
      toast('המחיקה נכשלה — אפשר לנסות שוב');
      throw e;
    }
  };

  pickHandlers = {
    keepOpen: true, // a cancelled confirm must not throw the parent out of the list
    ok: () => commit(false).catch(() => {}),
    alt: () => commit(true).catch(() => {}),
    cancel: () => { settled = true; },
    all: () => setAll(true),
    none: () => setAll(false)
  };
  nav.go('pick');
  return true;
}

async function refreshChannelsList() {
  const ul = $('channels-list');
  const newUl = $('channels-new-list');
  ul.innerHTML = '';
  newUl.innerHTML = '';
  $('channels-new-box').classList.add('hidden');
  $('channels-count').textContent = 'ערוצים';
  if (!libScope) return;
  // v1.0.32: "ערוצים חדשים" above, the folded regular list below — pure
  // plan.planChannelSections decides membership (undecided + ≤24h) and the
  // newest-first order in both.
  const { fresh, rest } = planChannelSections(await db.listLibraryChannels(libScope));
  $('channels-new-box').classList.toggle('hidden', fresh.length === 0);
  $('channels-count').textContent = rest.length ? `ערוצים (${rest.length})` : 'ערוצים';
  for (const lc of fresh) newUl.appendChild(await channelRow(lc, { fresh: true }));
  for (const lc of rest) ul.appendChild(await channelRow(lc, { fresh: false }));
}

/* v1.0.17's adoptLibraryScope + db.moveScope lived here until v1.0.38. They existed for
 * exactly one act — attaching/changing a SHEET moves the profile to a different scope —
 * and that act is gone with the wizard. Deleting them is what makes the sunset's
 * "libraryId never changes" rule enforceable rather than aspirational: no code path can
 * change a profile's scope any more. (planScopeAdoption and its tests died with them.) */

/** The profile's sources record, created on first use (stable library even without a sheet). */
/** The WAITING videos of one channel, in the shared library scope (channel content
    never lands anywhere else). One read — the caller decides what to do with them. */
async function pendingKeysOfChannel(sourceId) {
  const scope = await currentLibScope();
  if (!scope) return [];
  const { items } = await db.pagePending(scope, { limit: 5000 });
  // v1.0.26 — a source is a channel OR a standalone playlist. A playlist video keeps its
  // OWNER in `channelId` (that is what the title-dedupe index and the unify rule need), so
  // matching on channelId alone found ZERO for a playlist and the approval dialog never
  // appeared — the exact shape of the v1.0.22 bug, on the new path. A parked record
  // remembers where it will live in `homeFolderId`, and that is the honest test.
  return items
    .filter((r) => r.channelId === sourceId || r.homeFolderId === 'pl:' + sourceId)
    .map((r) => r.key);
}

/** Approve a channel's whole backlog + refresh everything that shows it. */
async function approveChannelBacklog(keys) {
  await db.approvePending(await currentLibScope(), keys);
  await loadGiftStates();
  await Promise.all([refreshPendingList(), refreshParentList(), refreshChannelsList()]);
  renderHome();
  // approvePending assigns no giftRank — planProfileGifts is the only assigner, so
  // without this the newly-approved videos arrive with no 🎁 at all
  refreshAfterAdd({ parent: true });
  maybeSchedulePush();
}

/**
 * v1.0.22 — ASK, once, right after a hand-added channel finishes importing.
 *
 * The channel is created `autoApprove:false`, so its ENTIRE back catalogue lands in the
 * approval queue and the child sees NOTHING — while the message said "הערוץ סונכרן ✅".
 * A real channel (@rotemama4kids) put 109 videos there and the parent reasonably
 * concluded the app had imported 2 of them. Pasting a channel link behind the PIN is a
 * deliberate parental act, so the backlog should not need 109 more taps; but it is also
 * the one moment before a stranger's whole catalogue reaches a 5-year-old, so we ask
 * instead of silently approving (parent's decision, 2026-07-31).
 * "Yes" also flips autoApprove, so future uploads flow without another visit here.
 * -> { approved, count } — count is the backlog size either way, for the message.
 */
async function offerChannelApproval(channelId) {
  const scope = await currentLibScope();
  const keys = await pendingKeysOfChannel(channelId);
  if (!keys.length) return { approved: false, count: 0 };
  const ch = (await db.getChannel(channelId)) || {};
  const name = ch.title ? '"' + ch.title + '"' : 'הערוץ';
  // v1.0.23 — THREE answers, because "yes / no" could not express the middle one. The
  // third button is a real button: mapping an answer onto an accidental dismiss would let
  // a child poking the scrim decide what reaches them.
  const answer = await askKid({
    emoji: '📺',
    title: `${keys.length} סרטונים ב${name}. מה לעשות איתם?`,
    text: 'אישור הכל: הכול נכנס מיד, וגם כל סרטון חדש שיעלה בערוץ בעתיד — בלי לשאול שוב. '
      + 'אישור ידני: תראו את כל הסרטונים ותסמנו אילו להשאיר. '
      + 'אחר כך: הכול ממתין בטאב "ממתינים" עד שתחליטו.',
    ok: 'אישור הכל', third: 'אישור ידני', cancel: 'אחר כך'
  });

  if (answer === 'ok') {
    // The dialog has closed, so the loading screen may come up without stacking on it.
    await withChannelWait('approve', { count: keys.length }, async () => {
      const lc = (await db.listLibraryChannels(scope)).find((c) => c.channelId === channelId);
      // The ✅ in the parent's channel list IS this flag — refreshChannelsList renders
      // `cb.checked = !!lc.autoApprove`, so approving here is what ticks it.
      // decidedAt (v1.0.32): this answer is THE sync decision — the row leaves "ערוצים חדשים".
      if (lc) await db.putLibraryChannel({ ...lc, autoApprove: true, autoApproveSource: 'ui', decidedAt: lc.decidedAt || Date.now() });
      await db.approvePending(scope, keys);
    });
    return { approved: true, count: keys.length };
  }

  if (answer === 'third') {
    const picked = await pickChannelVideos(channelId, name);
    // v1.0.32: a SAVED pick is a sync decision; backing out of the picker is not —
    // exactly like "אחר כך", the row stays in "ערוצים חדשים".
    if (picked) await markChannelDecided(channelId);
    return { approved: false, count: keys.length, picked, kept: picked ? picked.kept : 0 };
  }
  // 'cancel' (אחר כך) and 'dismiss' both leave everything waiting — the safe default.
  return { approved: false, count: keys.length };
}

/**
 * v1.0.25 — ONE path for "a channel was just subscribed": import it, then ask.
 *
 * Both places a parent can add a channel must behave the same, and until now only the
 * parent screen did. A channel SHARED from YouTube subscribed it, fired a sync it never
 * waited for, and immediately reported success — so the entire back catalogue landed in
 * ממתינים with no dialog and no count, which is precisely the v1.0.22 bug that the parent
 * screen was fixed for. CLAUDE.md already claimed the question covered "parent screen +
 * share"; the code only ever covered one of them. Sharing them here is what stops the two
 * from drifting again.
 *
 * The wait is unavoidable: the dialog needs the backlog, and the backlog needs the sync.
 * loading.hide() runs in a `finally` and BEFORE the dialog — modals must never stack.
 */
/**
 * v1.0.26 — run one step of the channel-add flow behind a waiting screen that SAYS which
 * step it is (pure `plan.channelAddWait`).
 *
 * `defer: 250` is what makes this safe to wrap around short steps too: a fast path never
 * flashes a screen, so a two-video channel behaves exactly as it did before, while a
 * 500-video one has no silent gap left anywhere.
 *
 * ALWAYS hides in a `finally`, and every caller must hide BEFORE raising a modal — a
 * loading screen under a dialog is the stacking bug v1.0.18 called out.
 */
async function withChannelWait(stage, opts, fn) {
  const { channelAddWait } = await import('./plan.js');
  const text = channelAddWait(stage, opts) || {};
  loading.show({ defer: 250, title: text.title, step: text.step });
  try { return await fn(); } finally { await loading.hide(); }
}

// The blocking wait on the post-decision sync must not become a TRAP: nav swallows back on
// the loading view, so a sync that never settles would hold the parent there forever. The
// valve does not silently drop the screen — that would restore the exact ambiguity this
// feature removes — it hands back control and SAYS the work continues in the background.
const CHANNEL_FINISH_MAX_MS = 90000;

/** -> true if the work finished, false if the valve fired and it is still running. */
async function waitWithValve(promise, ms = CHANNEL_FINISH_MAX_MS) {
  let timer = null;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(false), ms); });
  try { return await Promise.race([promise.then(() => true).catch(() => true), timeout]); }
  finally { clearTimeout(timer); }
}

async function importChannelAndAsk(channelId) {
  // A brand-new channel backfills up to ~2000 videos — by far the longest wait a parent
  // triggers by hand, and it used to run behind a one-line message (v1.0.18).
  loading.show({ title: 'מושכים את הסרטונים של הערוץ', step: 'מתחילים…', pct: 0 });
  let synced = false;
  let drops = null; // v1.0.37: the run's per-source drop attribution — see diagnoseEmptyChannel
  try {
    const res = await syncLibrary(activeProfileId, { force: true, onProgress: (p) => loading.progress(p) });
    drops = res && res.drops;
    synced = true;
  } catch { /* reported by the caller */ } finally {
    await loading.hide();
  }
  if (!synced) return { synced: false, approved: false, count: 0, picked: null, empty: {} };

  const { approved, count, kept = 0, picked = null } = await offerChannelApproval(channelId);
  // Everything below used to run with the ORDINARY screen showing and no indication at
  // all — the field report. The heavy part is the second full sync inside refreshAfterAdd.
  let backgrounded = false;
  await withChannelWait('finishing', {}, async () => {
    await loadGiftStates();
    await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList()]);
    renderHome();
    // AWAITED here, silent everywhere else — see refreshAfterAdd's own comment. BOTH
    // answers need it: "אישור הכל" approves the backlog, and the manual picker keeps a
    // subset — either way those records are live but have no gift rank yet.
    if (approved || kept > 0) {
      backgrounded = !(await waitWithValve(refreshAfterAdd({ parent: true, wait: true })));
    }
    maybeSchedulePush();
  });
  return {
    synced: true, approved, count, backgrounded, picked,
    empty: await diagnoseEmptyChannel(channelId, count, drops)
  };
}

/**
 * A channel that produced NOTHING: say which nothing it is.
 *
 * Until the planSyncDispatch fix a zero here was usually a LIE — the forced sync had
 * joined the launch run and never looked at this channel at all. Now that a zero is real,
 * the parent still deserves better than a reassuring ✅ over an empty folder: a
 * Shorts-only channel is a permanent fact about the channel (Shorts are excluded on
 * purpose, v1.0.21) and is worth saying out loud, which is what the parent's channel list
 * already does with `noLongForm`.
 *
 * Only read when there is nothing to report — two IDB reads that the common path skips.
 */
async function diagnoseEmptyChannel(channelId, count, drops = null) {
  // v1.0.37 — the SYNC's own drop attribution is the missing fact. Read whatever the
  // count is: a PARTIAL cap ("12 waiting" out of 98) is the same misreport in miniature.
  const { capped, denied, deniedKeys } = sourceDrops(drops, channelId);
  const ch0 = count ? await db.getChannel(channelId).catch(() => null) : null;
  // `isPlaylist` is needed for the WORDING whatever the count is — returning {} on the
  // common path made a successful playlist import announce itself as "הערוץ נוסף".
  if (count) return { isPlaylist: !!(ch0 && ch0.kind === 'playlist'), capped, denied, deniedKeys };
  const ch = await db.getChannel(channelId).catch(() => null);
  const scope = await currentLibScope();
  const prefix = ch && ch.kind === 'playlist' ? 'pl:' : 'ch:';
  const live = await db.countFolder(scope, prefix + channelId).catch(() => 0);
  return {
    noLongForm: !!(ch && ch.noLongForm), hasLive: live > 0, isPlaylist: prefix === 'pl:',
    capped, denied, deniedKeys
  };
}

/**
 * v1.0.37 — the way back for a source whose videos were all removed before.
 *
 * A deny tombstone is revoked by exactly one thing: the SHEET re-adding the key
 * (v1.0.10). A video inside a channel has no sheet row of its own, so once its key was
 * denied — a single in-place delete, or the 30-day purge of a rejected record (v1.0.26) —
 * re-adding the channel imported it never again, on any device, forever. That is a
 * permanent dead end reached by ordinary parental actions, and it reports as
 * "אין בו סרטונים".
 *
 * It is NOT revoked automatically: a parent who removed three bad videos from a channel
 * must not get them back for re-subscribing (the v1.0.23 rule — showing rejected content
 * is the betrayal, hiding wanted content is a complaint). So the parent is ASKED, with
 * the count, while they are standing right here — an explicit answer, exactly like the
 * sheet re-add it stands in for.
 */
async function offerDeniedRestore(sourceId, empty) {
  const keys = (empty && empty.deniedKeys) || [];
  if (!keys.length) return false;
  // v1.0.38: the wording lives in pure plan.deniedRestorePrompt, next to
  // deniedReAddPrompt — BOTH revive dialogs are pinned in one place, so the two cannot
  // drift into saying different things about the same act. (They already had: this
  // function kept its own inline copy for one commit.)
  const { deniedRestorePrompt } = await import('./plan.js');
  const prompt = deniedRestorePrompt(keys.length, { isPlaylist: !!(empty && empty.isPlaylist) });
  if (!prompt.ask) return false;
  const yes = await confirmKid({
    emoji: prompt.emoji, title: prompt.title, text: prompt.text,
    ok: prompt.ok, cancel: prompt.cancel
  });
  if (!yes) return false;
  const scope = await currentLibScope();
  await withChannelWait('finishing', {}, async () => {
    for (const key of keys) await db.unDeny(scope, key).catch(() => {});
    // the un-denied keys only become records on the next pass over the source
    await syncLibrary(activeProfileId, { force: true }).catch(() => {});
    await loadGiftStates();
    await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList()]);
    renderHome();
    maybeSchedulePush();
  });
  return true;
}


/**
 * v1.0.23 — the MANUAL choice: show every waiting video of one channel and keep only the
 * ticked ones. Everything unticked becomes 'rejected' — parked, invisible to the child, and
 * recoverable from the parent's rejected list (decision 2026-08-01: the parent asked for a
 * list they can pull things back out of, so this must NOT tombstone).
 *
 * Everything starts TICKED (the parent's choice): a channel is usually added because it is
 * wanted, so the common job is unticking a few. That is only safe BECAUSE unticking is
 * reversible — with the old permanent rejection, defaulting to "all" would have been a trap.
 * -> { kept, rejected } | null when the parent backed out
 */
function pickChannelVideos(channelId, name) {
  return new Promise((resolve) => {
    (async () => {
      const { compareForDisplay } = await import('./order.js');
      // Resolved, not the bare global: since v1.0.25 a channel SHARED from YouTube can
      // reach this picker before any home render has published `libScope`.
      const scope = await currentLibScope();
      // v1.0.26: reading up to 5000 pending records and building a row + thumbnail for
      // each is the step that looked most like "my tap did nothing" — the parent screen
      // simply stayed put for seconds after they chose "אישור ידני".
      const recs = await withChannelWait('building', {}, async () => {
        const { items } = await db.pagePending(scope, { limit: 5000 });
        return items.filter((r) => r.channelId === channelId).sort(compareForDisplay);
      });
      const chosen = new Set(recs.map((r) => r.key)); // all ticked
      const ul = $('pick-list');
      const boxes = new Map();
      // v1.0.39: the view is shared with the rolling-window review, which retitles it and
      // shows a third button. Restore this screen's own chrome rather than inheriting it.
      $('pick-title').textContent = 'אילו סרטונים להשאיר?';
      $('pick-emoji').textContent = '✅';
      $('pick-all').textContent = 'סמן הכול';
      $('pick-none').textContent = 'נקה בחירה';
      $('pick-alt').classList.add('hidden');

      const paint = () => {
        $('pick-sub').textContent = `${name} · נבחרו ${chosen.size} מתוך ${recs.length}`;
        $('pick-ok').textContent = chosen.size === recs.length ? 'להשאיר את כולם' : `להשאיר ${chosen.size}`;
      };
      ul.innerHTML = '';
      for (const rec of recs) {
        const li = document.createElement('li');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.className = 'pick-cb';
        const img = document.createElement('img');
        img.className = 'li-thumb';
        setThumb(img, rec);
        const body = document.createElement('div');
        body.className = 'li-body';
        const title = document.createElement('div');
        title.className = 'li-title';
        title.textContent = rec.title || '(ללא שם)';
        body.appendChild(title);
        // the whole row toggles — a checkbox alone is a cruel target on a tablet
        const toggle = () => {
          cb.checked = !cb.checked;
          if (cb.checked) chosen.add(rec.key); else chosen.delete(rec.key);
          li.classList.toggle('pick-off', !cb.checked);
          paint();
        };
        li.addEventListener('click', (e) => { if (e.target !== cb) toggle(); });
        cb.addEventListener('change', () => {
          if (cb.checked) chosen.add(rec.key); else chosen.delete(rec.key);
          li.classList.toggle('pick-off', !cb.checked);
          paint();
        });
        boxes.set(rec.key, { cb, li });
        li.appendChild(cb);
        li.appendChild(img);
        li.appendChild(body);
        ul.appendChild(li);
      }
      const setAll = (on) => {
        chosen.clear();
        for (const [key, { cb, li }] of boxes) {
          cb.checked = on;
          li.classList.toggle('pick-off', !on);
          if (on) chosen.add(key);
        }
        paint();
      };
      paint();

      let settled = false;
      const finish = async (commit) => {
        if (settled) return;
        settled = true;
        if (!commit) { resolve(null); return; }
        const keep = recs.filter((r) => chosen.has(r.key)).map((r) => r.key);
        const drop = recs.filter((r) => !chosen.has(r.key)).map((r) => r.key);
        // v1.0.26: the same silent gap as the bulk path — the parent tapped "להשאיר N"
        // and got the parent screen back while hundreds of records were still being
        // written. `importChannelAndAsk` owns the 'finishing' wait that follows.
        await withChannelWait('saving', { count: keep.length }, async () => {
          if (keep.length) {
            await db.approvePending(scope, keep);
          }
          if (drop.length) await db.rejectPending(scope, drop); // parked, NOT tombstoned
          await loadGiftStates();
          await Promise.all([refreshPendingList(), refreshParentList(), refreshChannelsList()]);
          renderHome();
        });
        // NO refreshAfterAdd here: `importChannelAndAsk` runs the one blocking
        // 'finishing' wait for BOTH answers. Firing a second, silent sync from this
        // branch is what left the manual path with the very gap this release removes.
        maybeSchedulePush();
        resolve({ kept: keep.length, rejected: drop.length });
      };

      pickHandlers = {
        ok: () => finish(true).catch(() => resolve(null)),
        cancel: () => finish(false),
        all: () => setAll(true),
        none: () => setAll(false)
      };
      nav.go('pick');
    })().catch(() => resolve(null));
  });
}

let pickHandlers = null;

/* ---------------- custom folders: the destination picker (v1.0.56) ---------------- */

let folderPickHandlers = null;   // { resolve, cancel } — see nav.register('folderpick')
let fpArtChoice = null;          // { thumbUrl } | null — the parent's picked picture
let fpEmojiChoice = '📁';
let fpArtSeq = 0;                // a stale image search must never paint over a newer one
let fpArtEditing = null;         // v1.0.58: the folder whose PICTURE is being changed
let fpEmojiPicked = false;       // …and whether an emoji was EXPLICITLY tapped in it

const FOLDER_EMOJI = ['📁', '🎵', '🚗', '🦁', '⚽', '🎨', '🚀', '🧸', '🍎', '🌙'];

/**
 * Ask the parent WHERE a single video should go, and let them create a folder on the spot.
 * Resolves a folderId ('sheet' = the default mixed list) or null when they backed out.
 *
 * It is a VIEW, not a modal: it holds a name field and an image chooser, and the add flows
 * it is called from already raise modals of their own (modals never stack — ui/modal.js).
 */
function askFolderDestination({ title = 'לאיזו תיקיה להוסיף?', sub = '' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); };
    folderPickHandlers = {
      resolve: (fid) => { done(fid); },
      cancel: () => done(null)
    };
    $('fp-title').textContent = title;
    $('fp-sub').textContent = sub;
    renderFolderPick().catch(() => {});
    nav.go('folderpick');
  });
}

/** The rows: the default, then the parent's folders, then "＋ תיקיה חדשה". */
async function renderFolderPick() {
  // v1.0.58: the art editor hides the destination list and the name field — restore both,
  // or the next add would open a picker with nothing to pick from.
  fpArtEditing = null;
  fpEmojiPicked = false;
  $('fp-list').classList.remove('hidden');
  setFolderNameFieldVisible(true);
  const scope = (await ensureSources()).libraryId;
  const custom = await db.listCustomFolders(scope);
  const rows = folderPickOptions(custom);
  const list = $('fp-list');
  list.innerHTML = '';
  fpSelected = rows[0] ? rows[0].folderId : 'sheet';
  fpCreating = false;
  $('fp-create').classList.add('hidden');
  $('fp-name').value = '';
  $('fp-name-msg').textContent = '';
  $('fp-art-msg').textContent = '';
  $('fp-art-row').innerHTML = '';
  fpArtChoice = null;
  fpEmojiChoice = '📁';
  renderFolderEmojiRow();

  const counts = new Map();
  for (const r of rows) {
    if (r.isDefault) continue;
    counts.set(r.folderId, await db.countFolder(scope, r.folderId));
  }

  const mkRow = (r) => {
    const li = document.createElement('li');
    li.style.padding = '0';
    li.style.background = 'transparent';
    li.style.boxShadow = 'none';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fp-row' + (r.folderId === fpSelected ? ' is-sel' : '');
    btn.dataset.fid = r.folderId;
    const ico = document.createElement('span');
    ico.className = 'fp-ico';
    const cf = custom.find((c) => c.folderId === r.folderId);
    if (cf && cf.artThumbId) mountCustomArt(ico, cf.artThumbId, r.emoji);
    else ico.textContent = r.emoji;
    const nm = document.createElement('span');
    nm.className = 'fp-name';
    nm.textContent = r.title;
    btn.appendChild(ico);
    btn.appendChild(nm);
    if (!r.isDefault) {
      const c = document.createElement('span');
      c.className = 'fp-count';
      c.textContent = `${counts.get(r.folderId) || 0} סרטונים`;
      btn.appendChild(c);
    }
    btn.addEventListener('click', () => {
      fpSelected = r.folderId;
      fpCreating = false;
      $('fp-create').classList.add('hidden');
      for (const el of list.querySelectorAll('.fp-row')) el.classList.toggle('is-sel', el.dataset.fid === r.folderId);
    });
    li.appendChild(btn);
    return li;
  };
  for (const r of rows) list.appendChild(mkRow(r));

  // …and the create row
  const li = document.createElement('li');
  li.style.padding = '0';
  li.style.background = 'transparent';
  li.style.boxShadow = 'none';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'fp-row';
  add.dataset.fid = '__new__';
  add.innerHTML = '<span class="fp-ico">＋</span><span class="fp-name">תיקיה חדשה</span>';
  add.addEventListener('click', () => {
    fpCreating = true;
    fpSelected = '__new__';
    for (const el of list.querySelectorAll('.fp-row')) el.classList.toggle('is-sel', el.dataset.fid === '__new__');
    $('fp-create').classList.remove('hidden');
    $('fp-name').focus();
  });
  li.appendChild(add);
  list.appendChild(li);
}

function renderFolderEmojiRow() {
  const row = $('fp-emoji-row');
  row.innerHTML = '';
  for (const e of FOLDER_EMOJI) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fp-emoji' + (e === fpEmojiChoice && !fpArtChoice ? ' is-sel' : '');
    b.textContent = e;
    b.addEventListener('click', () => {
      fpEmojiChoice = e;
      fpEmojiPicked = true; // an EXPLICIT choice — the only thing that may drop a picture
      fpArtChoice = null; // an emoji REPLACES a picked picture — one folder, one face
      for (const el of $('fp-art-row').querySelectorAll('.fp-art')) el.classList.remove('is-sel');
      renderFolderEmojiRow();
    });
    row.appendChild(b);
  }
}

/**
 * Search the web for pictures matching the folder's NAME and show them for the parent to
 * choose (user decision 2026-08-29: never install one automatically — an arbitrary image
 * search on a 5-year-old's tablet is only safe with a human in the loop).
 */
async function searchFolderArt() {
  const name = normalizeFolderTitle($('fp-name').value);
  const msg = $('fp-art-msg');
  if (!name) { msg.textContent = 'קודם כתבו שם לתיקיה'; msg.className = 'form-msg err'; return; }
  const seq = ++fpArtSeq;
  msg.textContent = 'מחפשים תמונות…';
  msg.className = 'form-msg';
  $('fp-art-row').innerHTML = '';
  let items = [];
  try {
    const { fetchArtCandidates } = await import('./folderart.js');
    items = await fetchArtCandidates(name);
  } catch { items = []; }
  if (seq !== fpArtSeq) return; // a newer search owns the row now (the logoTarget lesson)
  if (!items.length) {
    msg.textContent = 'לא נמצאו תמונות לשם הזה — אפשר לבחור אימוג׳י למטה';
    msg.className = 'form-msg';
    return;
  }
  msg.textContent = 'בחרו תמונה (או אימוג׳י למטה)';
  msg.className = 'form-msg';
  renderArtCandidates(items);
}

/**
 * v1.0.58 — ONE renderer for every source of a folder picture: the name search, and the
 * link the parent pasted. A second copy of this loop is a second answer to "what happens
 * when the picture will not load", and that answer is load-bearing — a candidate that
 * cannot render must not be offerable, or the parent picks a picture the folder can
 * never show.
 */
function renderArtCandidates(items, { append = false } = {}) {
  const row = $('fp-art-row');
  if (!append) row.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fp-art';
    b.title = it.title || '';
    const img = document.createElement('img');
    img.alt = it.title || '';
    img.loading = 'lazy';
    img.src = it.thumbUrl;
    // a candidate that will not load must not be offerable — the parent would pick a
    // picture the folder can never show
    img.addEventListener('error', () => b.remove(), { once: true });
    b.appendChild(img);
    b.addEventListener('click', () => {
      fpArtChoice = { thumbUrl: it.thumbUrl };
      for (const el of row.querySelectorAll('.fp-art')) el.classList.toggle('is-sel', el === b);
      renderFolderEmojiRow(); // the emoji row loses its selection ring
    });
    row.appendChild(b);
  }
}

/** v1.0.58: the create-time name field is hidden while the picture of an EXISTING folder
 *  is being changed, and must come back for the next creation (one place, both directions). */
function setFolderNameFieldVisible(on) {
  const input = $('fp-name');
  if (input) input.classList.toggle('hidden', !on);
  const label = document.querySelector('label[for="fp-name"]');
  if (label) label.classList.toggle('hidden', !on);
}

/**
 * v1.0.58 — the pasted-link door (user request). Validation is pure and lives in
 * `folderart.artUrlCandidate` (https only, no userinfo, not a bare host); whether the bytes
 * are really an image is settled where it can be — by the `<img>` that renders the
 * candidate, exactly as a searched picture is. Nothing is stored until the parent picks it,
 * so a bad link costs one failed thumbnail and no folder ever wears it.
 */
async function addFolderArtFromUrl() {
  const msg = $('fp-art-msg');
  const raw = $('fp-art-url').value;
  const { artUrlCandidate } = await import('./folderart.js');
  const cand = artUrlCandidate(raw);
  if (!cand) {
    msg.textContent = 'צריך קישור שמתחיל ב-https ומצביע על תמונה';
    msg.className = 'form-msg err';
    return;
  }
  msg.textContent = 'בחרו תמונה (או אימוג׳י למטה)';
  msg.className = 'form-msg';
  $('fp-art-url').value = '';
  // APPENDED, never replacing: a parent who searched and then pasted should see both.
  renderArtCandidates([cand], { append: true });
  // …and it is selected straight away — pasting a link IS the choice
  fpArtChoice = { thumbUrl: cand.thumbUrl };
  const row = $('fp-art-row');
  const last = row.lastElementChild;
  for (const el of row.querySelectorAll('.fp-art')) el.classList.toggle('is-sel', el === last);
  renderFolderEmojiRow();
}

/**
 * v1.0.58 — CHANGE THE PICTURE OF AN EXISTING FOLDER (user request). Until now the picture
 * could only be chosen at creation, and the parent's folder row offered nothing but ✏️ שם
 * and 🗑️.
 *
 * It REUSES the create-time chooser rather than growing a second one: the same three doors
 * (search by name, paste a link, a fixed icon), the same byte cache, the same rules. Only
 * the destination list and the name field are hidden, because the folder already exists and
 * renaming has its own button.
 */
async function openFolderArtEditor(cf) {
  const scope = await currentLibScope();
  if (!scope || !cf) return;
  fpArtChoice = null;
  fpEmojiChoice = cf.emoji || '📁';
  fpEmojiPicked = false;
  fpArtEditing = cf;
  fpArtSeq += 1; // a search still in flight from a previous folder must not paint here
  $('fp-title').textContent = 'תמונה לתיקיה';
  $('fp-sub').textContent = cf.title || '';
  $('fp-list').classList.add('hidden');
  $('fp-create').classList.remove('hidden');
  $('fp-name').value = cf.title || '';
  // the name field belongs to CREATION — renaming has its own button on the parent's row
  setFolderNameFieldVisible(false);
  $('fp-name-msg').textContent = '';
  $('fp-art-msg').textContent = 'חפשו תמונה לפי השם, הדביקו קישור, או בחרו אייקון';
  $('fp-art-msg').className = 'form-msg';
  $('fp-art-row').innerHTML = '';
  $('fp-art-url').value = '';
  renderFolderEmojiRow();
  folderPickHandlers = null;
  nav.go('folderpick');
}

/** Save the picture chosen in the editor onto an EXISTING folder row. */
async function saveFolderArtEdit() {
  const cf = fpArtEditing;
  if (!cf) return;
  const scope = await currentLibScope();
  let artThumbId = cf.artThumbId || null;
  let artSrcUrl = cf.artSrcUrl || null;
  if (fpArtChoice && fpArtChoice.thumbUrl) {
    try {
      const blob = await httpGetBlob(fpArtChoice.thumbUrl);
      if (blob) {
        artThumbId = 'cfart:' + cf.folderId;
        artSrcUrl = fpArtChoice.thumbUrl;
        await db.putThumb(artThumbId, blob, { origin: 'folder-art', srcUrl: artSrcUrl });
      }
    } catch { /* the emoji stands in — the same rule creation follows */ }
  } else if (fpEmojiPicked) {
    // ⚠️ REVIEW FIX — ONLY AN EXPLICIT EMOJI TAP DROPS THE PICTURE. This branch used to run
    // whenever no image was chosen, and `fpArtChoice` starts null every time the editor
    // opens — so a parent who opened 🖼️, looked, and tapped שמירה silently ERASED the
    // folder's picture. The comment claimed "an emoji was chosen" and nothing checked it.
    artThumbId = null;
    artSrcUrl = null;
  }
  await db.putCustomFolder({ ...cf, emoji: fpEmojiChoice || '📁', artThumbId, artSrcUrl });
  fpArtEditing = null;
  maybeSchedulePush();
  await refreshFoldersList();
  renderHome();
  toast('התמונה עודכנה');
}

/**
 * Create the folder the parent just described. The PICTURE IS STORED AS BYTES
 * (`cfart:<folderId>` in the thumbs store, the v1.0.32 channel-logo pattern): a stored URL
 * is exactly what broke channel logos — it 404s on a rebrand, needs the network on every
 * render, and cannot work offline. A fetch that fails is not fatal; the emoji stands in.
 */
async function createCustomFolder(scope, rawTitle) {
  const title = normalizeFolderTitle(rawTitle);
  const now = Date.now();
  const folderId = customFolderId(now);
  let artThumbId = null;
  if (fpArtChoice && fpArtChoice.thumbUrl) {
    try {
      const blob = await httpGetBlob(fpArtChoice.thumbUrl);
      if (blob && blob.size) {
        artThumbId = 'cfart:' + folderId;
        await db.putThumb(artThumbId, blob, { origin: 'folder-art', srcUrl: fpArtChoice.thumbUrl });
      }
    } catch { artThumbId = null; }
  }
  await db.putCustomFolder({
    scopeId: scope, folderId, title,
    emoji: fpEmojiChoice || '📁',
    artThumbId, artSrcUrl: (fpArtChoice && fpArtChoice.thumbUrl) || null,
    order: now, createdAt: now
  });
  maybeSchedulePush();
  return folderId;
}

/** OK on the picker: resolve with an existing folder, or create the new one first. */
async function onFolderPickOk() {
  const h = folderPickHandlers;
  if (!h) return;
  const scope = (await ensureSources()).libraryId;
  if (!fpCreating) {
    folderPickHandlers = null;
    h.resolve(fpSelected === '__new__' ? 'sheet' : fpSelected);
    nav.back();
    return;
  }
  const title = normalizeFolderTitle($('fp-name').value);
  const msg = $('fp-name-msg');
  if (!title) { msg.textContent = 'צריך שם לתיקיה'; msg.className = 'form-msg err'; return; }
  const clash = customFolderTitleClash(title, await db.listCustomFolders(scope));
  if (clash) { msg.textContent = 'כבר יש תיקיה בשם הזה'; msg.className = 'form-msg err'; return; }
  let fid;
  try {
    fid = await createCustomFolder(scope, title);
  } catch {
    msg.textContent = 'לא הצלחנו ליצור את התיקיה — נסו שוב';
    msg.className = 'form-msg err';
    return;
  }
  folderPickHandlers = null;
  h.resolve(fid);
  nav.back();
}

let fpSelected = 'sheet';
let fpCreating = false;

async function ensureSources() {
  let src = await db.getSources(activeProfileId);
  if (!src) {
    src = {
      profileId: activeProfileId, schema: 1, sheetUrl: null, libraryId: 'lib:p:' + activeProfileId,
      shareIntent: { enabled: true, requireApproval: true }, defaultAutoApprove: false,
      maxItemsPerChannel: 500, maxItemsTotal: 5000, drive: { enabled: false }, updatedAt: Date.now()
    };
    await db.putSources(src);
  }
  libScope = src.libraryId;
  return src;
}

/**
 * v1.0.33 — THE one add path, shared by pasting a link and by picking a search
 * result. The v1.0.25 lesson: two callers with private copies of "add" is exactly
 * how the share path once shipped without the import-and-ask flow — sharing the
 * path is what stops the drift. share.js stays SEPARATE on purpose: its videos
 * park as PENDING (requireApproval), a different curation policy.
 *
 * `row` must come from classifySourceRow — classifyLink is THE safety boundary,
 * and search results are normalized to canonical URLs precisely so they pass
 * through it like any pasted link. `title` is a display name the caller already
 * knows (search results carry one), which also skips the async oEmbed fetch.
 * `onNote(text, ok)` carries the intermediate progress lines to whichever status
 * element the caller owns (#add-msg vs #yts-msg — the two flows must not fight
 * over one line).
 *
 * -> { status: 'added'|'exists'|'error'|'unsupported', message, subscribed? }
 */
async function addClassifiedRow(row, { title = '', onNote = () => {}, askFolder = false } = {}) {
  if (row && row.kind === 'video') {
    // v1.0.6: manual adds live in the SHARED library folder (single list for the
    // whole family) and are appended to the sheet — one master list, everywhere.
    const scope = (await ensureSources()).libraryId;
    // the SAME helper the search rows precompute "✓ קיים" with — the row must agree
    // with what this add answers (v1.0.33 review)
    if (await libraryHasVideo(scope, row.key)) return { status: 'exists', message: 'הסרטון כבר קיים ברשימה' };
    // v1.0.38 — A RE-ADDED DELETED VIDEO MUST BE ANSWERED FOR, NOT SILENTLY DESTROYED.
    // This path never consulted the deny set: the record was written, shown to the child,
    // and then deleted by the next Drive pull (mergeDbFiles drops any video whose tombstone
    // is active). The sheet's un-deny used to repair that behind our backs, and the sheet is
    // gone — so the parent is asked, which is the explicit act the sheet re-add stood in for.
    if (!(await offerDeniedReAdd(scope, row.key, 'paste'))) {
      return { status: 'denied', message: 'הסרטון נשאר מוסר — לא נוסף' };
    }
    const now = Date.now();
    // v1.0.32: the name/image form is gone (user request) — the name comes from the
    // content itself. YouTube: fetched below, like an empty field always was. A direct
    // file's DISPLAY NAME derives from the filename in the link (pure
    // classify.titleFromFileUrl; Hebrew percent-encoding included) and its thumbnail
    // from the captured first frame (persistThumb, since v1.0.5).
    // v1.0.56 — a DRIVE file's link carries no filename at all (the old fallback stored
    // the literal path segment "view" as the child's caption), so its metadata is
    // fetched here, while the parent is standing right there: name + audio-or-video.
    // Best-effort — and an unreadable answer doubles as the honest signal that the file
    // is probably NOT shared "anyone with the link", which playback needs anyway, so
    // the outcome message says that instead of a reassuring ✅.
    const known = String(title || '').trim();
    let display = known;
    let media = row.media ?? null;
    let driveUnread = false;
    if (row.type === 'file' && row.driveId) {
      onNote('קוראים את פרטי הקובץ מדרייב…');
      const { fetchDriveFileMeta } = await import('./gdrivepub.js');
      const cls = await import('./classify.js');
      const meta = await fetchDriveFileMeta(row.driveId);
      if (meta) {
        if (!display) display = cls.titleFromFileName(meta.name);
        media = cls.mediaKindFromMime(meta.mimeType) || cls.mediaKindFromName(meta.name) || media;
      } else {
        driveUnread = true;
      }
    } else if (!display && row.type === 'file') {
      display = (await import('./classify.js')).titleFromFileUrl(row.srcUrl || row.url);
    }
    // v1.0.56 — WHERE SHOULD THIS GO? Asked only on the paths where the parent is
    // standing right here (paste / search / a single Drive file), and only after every
    // refusal above has passed — a duplicate or a denied key must never make someone
    // choose a folder for a video that is not going to be added. Backing out of the
    // picker CANCELS the add: it is a question, and "no answer" is not "the default".
    let destFolder = 'sheet';
    if (askFolder) {
      const chosen = await askFolderDestination({ sub: display || '' });
      if (!chosen) return { status: 'cancelled', message: 'ההוספה בוטלה' };
      destFolder = chosen;
    }
    const rec = {
      scopeId: scope, key: row.key, type: row.type, id: row.id ?? null, url: row.url ?? null,
      srcUrl: row.srcUrl, driveId: row.driveId ?? null, media,
      title: display, titleSource: display ? 'sheet' : null, normTitle: normalizeTitle(display),
      folderId: destFolder, channelId: null,
      sortKey: (await import('./order.js')).sortKeyFor({ origin: 'manual', addedAt: now }),
      publishedAt: null, rowIndex: null, origin: 'manual', state: 'live',
      addedAt: now, approvedAt: now,
      thumbId: null, thumbUrl: null, localPath: null, updatedAt: now
    };
    await db.putVideos([rec]);
    if (!rec.title && rec.type === 'youtube') {
      fetchYouTubeTitle(rec.id).then((t) => t && persistTitle(rec, t)).catch(() => {});
    }
    // the record is live but not yet enriched or gifted — see refreshAfterAdd
    refreshAfterAdd({ parent: true });
    await refreshParentList();
    renderHome();
    maybeSchedulePush();
    if (driveUnread) {
      return {
        status: 'added',
        message: 'נוסף — אבל לא הצלחנו לקרוא את הקובץ מדרייב. ודאו שהקובץ משותף "לכל מי שיש לו הקישור", אחרת הנגינה תיכשל'
      };
    }
    return { status: 'added', message: 'נוסף! ✅' };
  }

  // v1.0.56 — A WHOLE DRIVE FOLDER. It becomes a CUSTOM FOLDER that knows how to refill
  // itself (`driveFolderId` on the row): everything PR-B built — the tile, paging, the
  // watch-grid chain, search, deletion with tombstones, the Drive sync — applies unchanged.
  if (row && row.kind === 'drivefolder') {
    const scope = (await ensureSources()).libraryId;
    const existing = (await db.listCustomFolders(scope))
      .find((f) => f.driveFolderId === row.driveFolderId);
    if (existing) return { status: 'exists', message: 'התיקיה הזו כבר נוספה' };
    const res = await withChannelWait('resolve', {}, () => importDriveFolder(scope, row.driveFolderId));
    if (!res.ok) return { status: 'error', message: res.message };
    await refreshFoldersList();
    refreshAfterAdd({ parent: true });
    await refreshParentList();
    renderHome();
    maybeSchedulePush();
    return { status: 'added', message: res.message };
  }

  if (row && row.kind === 'channel') {
    onNote('מזהה את הערוץ…');
    // v1.0.26: a @handle resolve is a real network step (up to a 1.5MB page scrape when
    // keyless) that used to run behind that one line of small text. defer:250 means a raw
    // /channel/UC… link — which resolves instantly — never flashes a screen for it.
    const channelId = await withChannelWait('resolve', {}, async () => {
      await ensureSources();
      const ytApi = await import('./yt.js');
      return ytApi.resolveChannelRef(row.channelRef, await ytApi.getApiKey());
    });
    if (!channelId) return { status: 'error', message: 'לא הצלחנו לזהות את הערוץ' };
    await withChannelWait('subscribe', {}, async () => {
      const k = (await db.listLibraryChannels(libScope)).some((c) => c.channelId === channelId);
      await db.putLibraryChannel({
        libraryId: libScope, channelId, autoApprove: false, autoApproveSource: 'ui',
        order: Date.now(), addedAt: Date.now(), hidden: false, sourceRow: false, titleOverride: ''
      });
    });
    onNote('הערוץ נוסף! מושכים סרטונים…', true);
    await refreshChannelsList();
    const { synced, approved, count, empty, picked } = await importChannelAndAsk(channelId);
    if (!synced) return { status: 'error', message: 'שגיאה במשיכת הערוץ', subscribed: true };
    // v1.0.37 offered the way back only when NOTHING arrived. v1.0.61 drops that gate (user
    // request): a channel where 12 of 40 videos were removed here before imported the 28 and
    // told the parent nothing at all — `channelAddOutcome` returns from its `if (n)` branch
    // before it ever reaches the denied clause, so a PARTIAL denial was reported nowhere.
    if (await offerDeniedRestore(channelId, empty)) {
      return { status: 'added', message: 'שוחזרו! הסרטונים ממתינים לאישור ברשימת "ממתינים" 👀', subscribed: true };
    }
    return { status: 'added', message: channelAddOutcome(approved, count, empty, picked), subscribed: true };
  }

  if (row && row.kind === 'playlist') {
    // v1.0.26 — a playlist is a SUBSCRIPTION, stored in the same table as a channel with
    // `kind:'playlist'`. classifySourceRow has recognised these since v1.0.12 and the app
    // then dropped them on the floor here, which is why pasting one has always answered
    // "הלינק לא נתמך" — a missing feature wearing the costume of a parse error.
    onNote('מזהה את רשימת ההשמעה…');
    await ensureSources();
    const plId = row.playlistId;
    const known = (await db.listLibraryChannels(libScope)).some((c) => c.channelId === plId);
    await db.putLibraryChannel({
      libraryId: libScope, channelId: plId, kind: 'playlist',
      autoApprove: false, autoApproveSource: 'ui',
      order: Date.now(), addedAt: Date.now(), hidden: false, sourceRow: false, titleOverride: ''
    });
    onNote('רשימת ההשמעה נוספה! מושכים סרטונים…', true);
    await refreshChannelsList();
    const { synced, approved, count, empty, picked } = await importChannelAndAsk(plId);
    if (!synced) return { status: 'error', message: 'שגיאה במשיכת רשימת ההשמעה', subscribed: true };
    if (await offerDeniedRestore(plId, empty)) { // v1.0.37, same as the channel path
      return { status: 'added', message: 'שוחזרו! הסרטונים ממתינים לאישור ברשימת "ממתינים" 👀', subscribed: true };
    }
    return { status: 'added', message: channelAddOutcome(approved, count, empty, picked), subscribed: true };
  }

  return { status: 'unsupported', message: 'הלינק לא נתמך (סרטון YouTube, ערוץ, רשימת השמעה, קובץ וידאו/שמע, או תיקיה בגוגל דרייב)' };
}

/** Add a single video (live immediately — the parent is right here) or a whole channel. */
async function parentAdd() {
  const url = $('add-url').value.trim();
  const msg = $('add-msg');
  if (!url) { msg.textContent = 'הדביקו קודם לינק'; msg.className = 'form-msg err'; return; }
  msg.textContent = 'מוסיף…'; msg.className = 'form-msg';

  const { classifySourceRow } = await import('./classify.js');
  const row = classifySourceRow(url);
  const r = await addClassifiedRow(row, {
    askFolder: true, // v1.0.56 — pasting is one of the three "the parent is here" paths
    onNote: (text, ok) => { msg.textContent = text; msg.className = ok ? 'form-msg ok' : 'form-msg'; }
  });
  // the input clears once something was actually stored (a video record or a
  // subscription) — a refused/duplicate link stays put for the parent to fix
  if (r.status === 'added' || r.subscribed) $('add-url').value = '';
  msg.textContent = r.message;
  msg.className = r.status === 'added' ? 'form-msg ok' : 'form-msg err';
}

/* ---------------- v1.0.33: YouTube search in the add tab ----------------
   The network + parsing live in ytsearch.js (keyless, quota-free, Shorts/mixes
   filtered in the pure parser); adding routes through addClassifiedRow — the SAME
   path pasting a link takes, behind the same classifySourceRow safety boundary. */

// Results state + TWO monotonic seq counters. Search and suggestions are separate
// races — one shared counter would let a keystroke's suggestion fetch invalidate an
// in-flight search. A response paints only while its seq is still current (the
// v1.0.32 logoTarget lesson: a late async result must never paint a newer query's
// screen). `state` maps 'type:id' -> 'added'|'exists' so re-renders keep the ✓s.
let ytsCtx = { query: '', filter: 'all', items: [], continuation: null, state: new Map() };
// v1.0.33: browsing INSIDE one channel/playlist result. Non-null = the list area is
// showing that source's own videos; the search results stay untouched in ytsCtx and
// closing the browse re-renders them exactly as they were. ONE state map (ytsCtx.state)
// serves both lists — a video's key is global, so a ✓ earned in the browse view must
// still show when the parent goes back to the results (and vice versa).
let ytsBrowse = null;
let ytsSearchSeq = 0;
let ytsSuggestSeq = 0;
let ytsSuggestTimer = 0;

/** Whichever list currently owns the results area. */
function activeYtsItems() { return ytsBrowse ? ytsBrowse.items : ytsCtx.items; }

/** Profile switch wipes the whole search area (results, browse, marks, input). */
function resetYtsUi() {
  ytsSearchSeq++;
  ytsSuggestSeq++;
  ytsCtx = { query: '', filter: 'all', items: [], continuation: null, state: new Map() };
  ytsBrowse = null;
  const input = $('yts-input');
  if (!input) return; // callable before the DOM exists (unit-less boot paths)
  input.value = '';
  $('yts-results').innerHTML = '';
  $('yts-browse-head').classList.add('hidden');
  $('yts-chips').classList.add('hidden');
  $('yts-more').classList.add('hidden');
  ytsHideSuggest();
  ytsMsg('');
  const all = document.querySelector('#yts-chips .yts-chip[data-f="all"]');
  for (const c of document.querySelectorAll('#yts-chips .yts-chip')) {
    c.classList.toggle('chip-on', c === all);
  }
}

/**
 * Is this video anywhere the CURRENT profile can see it? ONE helper for both the
 * "✓ קיים" precompute and addClassifiedRow's dedupe — the row must agree with what
 * the add would answer, and two hand-copied scope pairs is how they drift apart.
 */
async function libraryHasVideo(libraryId, key) {
  return !!((await db.getVideo(libraryId, key)) || (await db.getVideo(db.profScope(activeProfileId), key)));
}

/* ==================== v1.0.38 — the links file ====================
 *
 * One plain-text file carrying a profile's whole source list. It replaced the
 * Google-Sheets sources list as the bulk-add door, and it is how a library moves to
 * another tablet or another Google account.
 *
 * The pure half — the format, the dialogs, the outcome sentences — lives in linksfile.js
 * and plan.js. This is only the glue: dialogs, waiting screens, and ONE forced sync.
 */

/**
 * v1.0.38 — a single key the parent is re-adding. Was it deleted before, and if so, does
 * the parent want it back?
 *
 * The ONLY revocation path used to be the sheet re-adding the key (v1.0.10
 * planSheetMirror.unDenyKeys). This is its replacement — an explicit answer, never
 * automatic (the v1.0.23 rule: showing rejected content is the betrayal). Un-denies in
 * BOTH scopes, because a key can carry a tombstone in the shared library and in the
 * personal one, and `db.unDeny` writes `removedAt` so the revocation out-merges a peer's
 * stale ACTIVE tombstone.
 *
 * -> true to proceed with the add, false to abort it.
 */
async function offerDeniedReAdd(scope, key, source = 'paste') {
  const scopes = [...new Set([scope, db.profScope(activeProfileId)])].filter(Boolean);
  let denied = false;
  for (const s of scopes) if ((await db.loadDenySet(s)).has(key)) { denied = true; break; }
  const { deniedReAddPrompt } = await import('./plan.js');
  const prompt = deniedReAddPrompt({ denied, exists: false, source, count: 1 });
  if (!prompt.ask) return true;
  const yes = await confirmKid({
    emoji: prompt.emoji, title: prompt.title, text: prompt.text, ok: prompt.ok, cancel: prompt.cancel
  });
  if (!yes) return false;
  for (const s of scopes) await db.unDeny(s, key);
  return true;
}

function linksMsg(text, cls = '') {
  const el = $('links-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'form-msg' + (cls ? ' ' + cls : '');
}

/** Where an exported file lands, shown to the parent verbatim so they can find it. */
const LINKS_EXPORT_DIR = 'Android/data/com.assaf.kidsplayer/files/exports/';

/**
 * Export the active profile's sources as a links file: write it, then offer the OS share
 * sheet on the FILE.
 *
 * Both halves are needed. The write is the artifact a device transfer needs and the only
 * thing that survives a cancelled share; the share is how the parent actually gets it off
 * the tablet, because Android 11+ hides Android/data from the Files app. Every rung of the
 * degradation reports WHERE the file is (plan.linksExportOutcome).
 */
async function linksExport() {
  const lf = await import('./linksfile.js');
  const { linksExportOutcome } = await import('./plan.js');
  const p = await getActiveProfile();
  const name = (p && p.name) || '';
  let built = null;
  try {
    built = await withChannelWait('exporting', {}, async () => {
      const { subscriptions, channelMeta, videos } = await lf.collectLinksExport(activeProfileId);
      const version = await (await import('./update.js')).currentVersion().catch(() => '');
      return lf.serializeLinksFile({ subscriptions, channelMeta, videos, profileName: name, appVersion: version || '' });
    });
  } catch { linksMsg('הייצוא נכשל — נסו שוב', 'err'); return; }

  const totalRows = built.counts.channels + built.counts.playlists + built.counts.videos;
  if (!totalRows) {
    const r = linksExportOutcome({ delivery: 'nothing' });
    linksMsg(r.text, 'err');
    return;
  }

  const fileName = lf.linksFileName(name);
  const plat = await import('./platform.js');
  lastLinksExportText = built.text; // for the "send as text" fallback rung
  $('links-share-text').classList.add('hidden');

  let delivery = 'none';
  const path = await plat.fsWriteTextExternal('exports/' + fileName, built.text);
  if (path) {
    delivery = (await plat.shareFile(path, { mimeType: 'text/plain', subject: fileName })) === 'native'
      ? 'native' : 'file-only';
  } else if ((await plat.downloadTextFile(fileName, built.text)) === 'download') {
    delivery = 'download';
  } else {
    try { await navigator.clipboard.writeText(built.text); delivery = 'clipboard'; }
    catch { delivery = 'shown'; }
  }

  const out = linksExportOutcome({ delivery, name: fileName, dir: LINKS_EXPORT_DIR, counts: built.counts });
  linksMsg(out.text, out.ok ? 'ok' : 'err');
  if (out.shareTextFallback) $('links-share-text').classList.remove('hidden');
  if (out.shown) await alertKid({ emoji: '📄', title: fileName, text: built.text, ok: 'סגירה' });
}

let lastLinksExportText = '';

/**
 * v1.0.38 — the name-uniqueness gate, extracted from createNewProfile so the links
 * import's "create a new profile from this file" branch cannot be the one path that skips
 * it. A PROFILE NAME IS UNIQUE PER GOOGLE ACCOUNT, NOT PER DEVICE (v1.0.22): two devices
 * each minting "נועם" splits that child's gift progress and personal videos while the
 * parent just sees two identical avatars. Best-effort pull, then decide.
 * -> 'remote' | 'local' | null
 */
async function profileNameClash(name, { quiet = false } = {}) {
  const localBefore = await getProfiles();
  let merged = localBefore;
  try {
    if (((await db.getMeta('drive')) || {}).enabled) {
      const { pullDrive } = await import('./drive.js');
      if (!quiet) loading.show({ title: 'בודקים שהשם פנוי…', step: 'קוראים את הגיבוי בגוגל דרייב' });
      try { await pullDrive(activeProfileId); } finally { if (!quiet) loading.hide(); }
      merged = await getProfiles();
    }
  } catch { /* offline / not connected — the local check below still applies */ }
  return profileNameConflict(localBefore, merged, name);
}

const PROFILE_CLASH_MSG = {
  remote: 'שם הפרופיל קיים כבר בחשבון הגוגל, במכשיר אחר — בחרו שם אחר.',
  local: 'כבר יש פרופיל בשם הזה — בחרו שם אחר'
};

/**
 * Import a links file into the active profile — or into a NEW profile named by the file.
 *
 * Deliberately NOT routed through addClassifiedRow: its channel branch raises
 * importChannelAndAsk (loading screen + approval dialog + a 90s finishing wait) PER
 * channel, and its video branch fires refreshAfterAdd + renderHome + a push PER video. A
 * 16-channel file would raise 16 dialogs and a 300-line file 300 syncs. Instead: one
 * confirm, one denied question, one batch of writes, ONE forced sync.
 */
async function linksImportFromText(text) {
  const lf = await import('./linksfile.js');
  const { linksImportConfirm, linksImportOutcome } = await import('./plan.js');
  const parsed = lf.parseLinksFile(text);
  if (!parsed.ok) {
    // An unreadable input is never an empty one — each refusal names itself.
    linksMsg({
      empty: 'הקובץ ריק',
      html: 'זה לא קובץ לינקים — נראה כמו דף אינטרנט שנשמר. בחרו את קובץ הטקסט שיצא מהאפליקציה.',
      'too-big': 'הקובץ גדול מדי',
      'no-links': 'לא נמצאו לינקים נתמכים בקובץ — כל שורה צריכה להיות לינק לערוץ, לרשימת השמעה או לסרטון'
    }[parsed.error] || 'לא הצלחנו לקרוא את הקובץ', 'err');
    return;
  }

  const p = await getActiveProfile();
  const fileName = parsed.profileName;
  const canCreate = !!fileName && !(await getProfiles()).some((x) => x && x.name === fileName);
  const ask = linksImportConfirm(parsed.counts, {
    targetName: (p && p.name) || '', profileName: fileName, canCreateProfile: canCreate
  });
  const answer = await askKid(ask);
  if (answer !== 'ok' && answer !== 'third') return;

  if (answer === 'third') {
    const clash = await profileNameClash(fileName);
    if (clash) { linksMsg(PROFILE_CLASH_MSG[clash], 'err'); renderProfiles(); return; }
    const np = await createProfile(fileName, '🙂', '#eceaff');
    profiles = await getProfiles();
    // activateProfile owns the loading screen and the first sync — exactly the adoption
    // context a fresh library needs. From here the import runs against the new profile,
    // so there is ONE import path whichever answer the parent gave.
    await activateProfile(np.id);
  }

  // The denied question, ONCE for the whole file. A channel's removed backlog is a
  // different question and reaches offerDeniedRestore on its own — asking in both places
  // is the "asked twice" bug.
  const { deniedReAddPrompt } = await import('./plan.js');
  const scope = (await ensureSources()).libraryId;
  const activeDeny = new Set([
    ...(await db.loadDenySet(scope)),
    ...(await db.loadDenySet(db.profScope(activeProfileId)))
  ]);
  const hits = parsed.videos.filter((v) => activeDeny.has(v.key)).map((v) => v.key);
  const reviveKeys = new Set();
  if (hits.length) {
    const prompt = deniedReAddPrompt({ denied: true, source: 'import', count: hits.length });
    if (await confirmKid({ emoji: prompt.emoji, title: prompt.title, text: prompt.text, ok: prompt.ok, cancel: prompt.cancel })) {
      for (const k of hits) reviveKeys.add(k);
    }
  }

  let res = null;
  await withChannelWait('importing', { count: parsed.counts.total }, async () => {
    const key = await (await import('./yt.js')).getApiKey();
    res = await lf.applyLinksPlan(activeProfileId, parsed, {
      reviveKeys,
      resolveRef: async (ref) => (await import('./yt.js')).resolveChannelRef(ref, key)
    });
  });

  // ONE forced sync for the whole import: it is what resolves channels into videos (RSS +
  // backfill + playlists), fills titles and assigns gift ranks. Forced because a
  // non-forced call could JOIN a launch run that has already read the library (v1.0.25).
  let pending = 0;
  let backgrounded = false;
  await withChannelWait('finishing', {}, async () => {
    backgrounded = !(await waitWithValve(refreshAfterAdd({ parent: true, wait: true })));
    try { pending = await pendingTotal(); } catch { pending = 0; }
    await loadGiftStates();
    await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList()]);
    renderHome();
    maybeSchedulePush();
  });

  const msg = linksImportOutcome({ ...res, pending, invalid: parsed.counts.invalid });
  linksMsg(backgrounded ? msg + ' · הסנכרון ממשיך ברקע' : msg, res && (res.channels + res.playlists + res.videos) ? 'ok' : 'err');
  await refreshGateDot();
}

function ytsMsg(text, cls = '') {
  const el = $('yts-msg');
  el.textContent = text || '';
  el.className = 'form-msg' + (cls ? ' ' + cls : '');
}

function ytsHideSuggest() {
  // hiding INVALIDATES any in-flight fetch (review finding): blur/Escape used to hide
  // without bumping the seq, so a resolving fetch re-opened the dropdown over an
  // unfocused input — and nothing short of picking a suggestion could dismiss it
  ytsSuggestSeq++;
  const host = $('yts-suggest');
  host.classList.add('hidden');
  host.innerHTML = '';
}

async function ytsShowSuggestions() {
  const q = $('yts-input').value.trim();
  if (q.length < 2) { ytsHideSuggest(); return; }
  const seq = ++ytsSuggestSeq;
  const { fetchSuggestions } = await import('./ytsearch.js');
  const list = await fetchSuggestions(q);
  if (seq !== ytsSuggestSeq) return; // a newer keystroke (or a submitted search) owns the field
  const host = $('yts-suggest');
  host.innerHTML = '';
  if (!list.length) { ytsHideSuggest(); return; }
  for (const s of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s;
    // pointerdown fires BEFORE the input's blur (which closes the dropdown 150ms
    // later) — a click-only handler loses that race and a tap picks nothing. But a
    // TV remote's OK produces a native click and NO pointerdown (review finding), so
    // both are bound, latched against double-fire.
    let fired = false;
    const pick = () => {
      if (fired) return;
      fired = true;
      $('yts-input').value = s;
      ytsSearch().catch(() => {});
    };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); pick(); });
    b.addEventListener('click', pick);
    host.appendChild(b);
  }
  host.classList.remove('hidden');
}

/**
 * Which results already exist in the library, so a row says "✓ קיים" up front
 * instead of answering it only after a tap (a button that lies about being
 * available is the v1.0.26 empty-queue ambiguity in miniature). Videos are checked
 * in BOTH scopes — addClassifiedRow dedupes against both, and the row must agree
 * with what the add will answer.
 */
async function ytsMarkExisting(items) {
  const scope = (await ensureSources()).libraryId;
  const subs = new Set((await db.listLibraryChannels(scope)).map((c) => c.channelId));
  for (const it of items) {
    const k = it.type + ':' + it.id;
    if (ytsCtx.state.has(k)) continue;
    if (it.type === 'video') {
      if (await libraryHasVideo(scope, 'yt:' + it.id)) ytsCtx.state.set(k, 'exists');
    } else if (subs.has(it.id)) {
      ytsCtx.state.set(k, 'exists');
    }
  }
}

/** One result row. Reuses .parent-list classes; the thumb is the preview trigger. */
function ytsRow(item) {
  const li = document.createElement('li');
  li.dataset.yts = item.type + ':' + item.id;

  const wrap = document.createElement('div');
  wrap.className = 'yts-thumbwrap';
  const img = document.createElement('img');
  img.className = 'li-thumb' + (item.type === 'channel' ? ' yts-round' : '');
  img.loading = 'lazy';
  img.alt = '';
  if (item.thumbUrl) img.src = item.thumbUrl;
  wrap.appendChild(img);
  if (item.type === 'video' && item.durationText) {
    const d = document.createElement('span');
    d.className = 'yts-dur';
    d.textContent = item.durationText;
    wrap.appendChild(d);
  }
  // the parentRow preview-thumb pattern, verbatim: role/tabIndex/Enter are what
  // make a bare <img> reachable from a TV remote (v1.0.29). A video's tap target is
  // the preview bubble; a channel/playlist's tap target BROWSES INTO it (v1.0.33).
  const tapAction = item.type === 'video'
    ? () => openYtsPreview(item)
    : () => { openYtsBrowse(item).catch(() => {}); };
  img.classList.add('li-thumb-play');
  img.setAttribute('role', 'button');
  img.title = item.type === 'video' ? 'צפייה מהירה' : 'דפדוף בתוכן';
  img.tabIndex = 0;
  const open = (e) => { e.preventDefault(); e.stopPropagation(); tapAction(); };
  img.addEventListener('click', open);
  img.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });

  const body = document.createElement('div');
  body.className = 'li-body';
  const title = document.createElement('div');
  title.className = 'li-title';
  title.textContent = item.title || '(ללא שם)';
  if (item.type !== 'video') {
    // the NAME is a browse trigger too (the user's request: tap the picture or the name)
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    title.style.cursor = 'pointer';
    title.addEventListener('click', open);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
  }
  const badge = document.createElement('span');
  badge.className = 'badge-type ' + (item.type === 'video' ? 'badge-yt' : item.type === 'channel' ? 'badge-ch' : 'badge-pl');
  badge.textContent = item.type === 'video' ? 'סרטון' : item.type === 'channel' ? 'ערוץ' : 'פלייליסט';
  title.appendChild(badge);
  // metadata line, not a URL — .li-note wraps and aligns naturally in RTL where
  // .li-sub (built for URLs) forces ltr + ellipsis
  const sub = document.createElement('div');
  sub.className = 'li-note';
  sub.textContent = item.type === 'video'
    ? [item.channelTitle, item.viewCountText, item.publishedText].filter(Boolean).join(' · ')
    : (item.subText || '');
  body.appendChild(title);
  body.appendChild(sub);

  const add = document.createElement('button');
  add.className = 'li-add';
  add.type = 'button';
  const st = ytsCtx.state.get(item.type + ':' + item.id);
  if (st) {
    add.disabled = true;
    add.textContent = st === 'adding' ? '⏳' : st === 'exists' ? '✓ קיים' : '✓ נוסף';
  } else {
    add.textContent = '➕';
    add.title = 'הוספה לספרייה';
    add.addEventListener('click', async () => {
      add.disabled = true; // one tap = one add; re-enabled only on failure
      const r = await ytsAdd(item).catch(() => null);
      if (!r || (r.status !== 'added' && r.status !== 'exists')) add.disabled = false;
    });
  }

  li.appendChild(wrap);
  li.appendChild(body);
  li.appendChild(add);
  return li;
}

function ytsRenderResults() {
  const host = $('yts-results');
  host.innerHTML = '';
  for (const it of activeYtsItems()) host.appendChild(ytsRow(it));
}

/** Flip one rendered row to its decided state (by key — indexes shift, keys don't). */
function ytsMarkRow(item, status) {
  ytsCtx.state.set(item.type + ':' + item.id, status);
  const li = $('yts-results').querySelector('li[data-yts="' + item.type + ':' + item.id + '"]');
  const btn = li && li.querySelector('.li-add');
  if (btn) {
    btn.disabled = true;
    btn.textContent = status === 'exists' ? '✓ קיים' : '✓ נוסף';
  }
}

/**
 * Add one search result through the shared pipeline. The result's canonical URL is
 * re-classified first — classifyLink stays THE safety boundary, and the classifier
 * must agree with the renderer about what this item is (a mismatch is refused, not
 * guessed). -> addClassifiedRow's result, or null on refusal.
 */
async function ytsAdd(item) {
  // one add per source at a time, ACROSS surfaces (review finding): the browse-head ➕
  // disables itself, but going back mid-flight exposed the same source's still-enabled
  // row button — two concurrent channel imports away from stacked dialogs. 'adding' in
  // the shared state map is the cross-surface latch; re-renders draw it as ⏳.
  const k = item.type + ':' + item.id;
  const prior = ytsCtx.state.get(k) || null;
  if (prior === 'adding') return null;
  ytsCtx.state.set(k, 'adding');
  const restore = () => {
    if (ytsCtx.state.get(k) !== 'adding') return;
    if (prior) ytsCtx.state.set(k, prior); else ytsCtx.state.delete(k);
  };
  const { classifySourceRow } = await import('./classify.js');
  const row = classifySourceRow(item.url);
  if (!row || row.kind !== item.type) {
    restore();
    ytsMsg('הקישור לא עבר את בדיקת הבטיחות של האפליקציה', 'err');
    return null;
  }
  let r = null;
  try {
    r = await addClassifiedRow(row, {
      title: item.title,
      askFolder: true, // v1.0.56 — adding a search result asks too (the user's request)
      onNote: (t, ok) => ytsMsg(t, ok ? 'ok' : '')
    });
  } finally {
    if (r && (r.status === 'added' || r.status === 'exists')) ytsMarkRow(item, r.status);
    else restore(); // a failed/thrown add must not leave a ⏳ button stuck forever
  }
  ytsMsg(r.message, r.status === 'added' ? 'ok' : r.status === 'exists' ? '' : 'err');
  return r;
}

/** A fresh search from the input + the active chip. */
async function ytsSearch() {
  const q = $('yts-input').value.trim();
  ytsHideSuggest();
  clearTimeout(ytsSuggestTimer);
  if (!q) return;
  // a new search always returns the area to RESULTS mode — through closeYtsBrowse,
  // never by hand (review finding: the manual two-line teardown left the OLD browse
  // rows rendered and tappable while the fetch ran — and FOREVER when it failed —
  // so a thumbnail tap previewed the WRONG video via activeYtsItems()'s fallback,
  // and hardware back, with no browse to close, threw the parent out of the screen)
  closeYtsBrowse();
  const seq = ++ytsSearchSeq;
  const yts = await import('./ytsearch.js');
  ytsMsg(yts.searchMessage('searching'));
  try {
    const { items, continuation } = await yts.searchYouTube(q, { filter: ytsCtx.filter });
    if (seq !== ytsSearchSeq) return;
    ytsCtx.query = q;
    ytsCtx.items = items;
    ytsCtx.continuation = continuation;
    ytsCtx.state = new Map();
    await ytsMarkExisting(items);
    if (seq !== ytsSearchSeq) return;
    ytsRenderResults();
    ytsMsg(items.length ? '' : yts.searchMessage('empty', { query: q }));
    $('yts-chips').classList.remove('hidden');
    $('yts-more').classList.toggle('hidden', !continuation);
  } catch (e) {
    if (seq !== ytsSearchSeq) return;
    // whatever list was showing stays — a failed refresh must not blank the screen
    ytsMsg(yts.searchMessage(e && e.message === 'parse' ? 'parse' : 'network'), 'err');
  }
}

/* ---- browsing inside a channel/playlist result (v1.0.33) ---- */

/** The browse header mirrors the source row: avatar, name, sub, and one ➕/✓. */
function renderYtsBrowseHead() {
  const b = ytsBrowse;
  if (!b) { $('yts-browse-head').classList.add('hidden'); return; }
  const thumb = $('yts-browse-thumb');
  thumb.classList.toggle('yts-wide', b.item.type !== 'channel');
  if (b.item.thumbUrl) thumb.src = b.item.thumbUrl; else thumb.removeAttribute('src');
  $('yts-browse-title').textContent = b.item.title || '(ללא שם)';
  $('yts-browse-sub').textContent = b.item.subText || '';
  const add = $('yts-browse-add');
  const st = ytsCtx.state.get(b.item.type + ':' + b.item.id);
  add.disabled = !!st;
  add.textContent = !st ? '➕' : st === 'adding' ? '⏳' : st === 'exists' ? '✓ קיים' : '✓ נוסף';
  add.title = b.item.type === 'channel' ? 'הוספת כל הערוץ' : 'הוספת כל הרשימה';
  $('yts-browse-head').classList.remove('hidden');
}

/**
 * Open a channel/playlist result for browsing: the list area shows the source's own
 * videos (a channel = its Videos tab — exactly what a subscription would import),
 * the chips give way to the header, and the search results wait untouched in ytsCtx.
 */
async function openYtsBrowse(item) {
  const seq = ++ytsSearchSeq;
  const yts = await import('./ytsearch.js');
  ytsBrowse = { target: { kind: item.type, id: item.id }, item, items: [], continuation: null };
  renderYtsBrowseHead();
  $('yts-chips').classList.add('hidden');
  $('yts-results').innerHTML = '';
  $('yts-more').classList.add('hidden');
  ytsMsg(yts.searchMessage('browse'));
  try {
    const { items, continuation } = await yts.browseYouTube(ytsBrowse.target);
    if (seq !== ytsSearchSeq || !ytsBrowse || ytsBrowse.item !== item) return;
    ytsBrowse.items = items;
    ytsBrowse.continuation = continuation;
    await ytsMarkExisting(items);
    if (seq !== ytsSearchSeq || !ytsBrowse || ytsBrowse.item !== item) return;
    ytsRenderResults();
    ytsMsg(items.length ? '' : yts.searchMessage('empty', { query: item.title }));
    $('yts-more').classList.toggle('hidden', !continuation);
  } catch (e) {
    if (seq !== ytsSearchSeq) return;
    ytsMsg(yts.searchMessage(e && e.message === 'parse' ? 'parse' : 'network'), 'err');
  }
}

/** Back to the search results, exactly as they were. -> false when nothing was open. */
function closeYtsBrowse() {
  if (!ytsBrowse) return false;
  ytsBrowse = null;
  ytsSearchSeq++; // a late browse response must not paint over the restored results
  $('yts-browse-head').classList.add('hidden');
  ytsMsg('');
  ytsRenderResults();
  $('yts-chips').classList.toggle('hidden', !ytsCtx.query);
  $('yts-more').classList.toggle('hidden', !ytsCtx.continuation);
  return true;
}

async function ytsBrowseMore() {
  const b = ytsBrowse;
  if (!b || !b.continuation) return;
  const seq = ++ytsSearchSeq;
  const yts = await import('./ytsearch.js');
  ytsMsg(yts.searchMessage('more'));
  try {
    const r = await yts.browseYouTube(b.target, { continuation: b.continuation });
    if (seq !== ytsSearchSeq || ytsBrowse !== b) return;
    const seen = new Set(b.items.map((i) => i.type + ':' + i.id));
    const fresh = r.items.filter((i) => !seen.has(i.type + ':' + i.id));
    b.items = b.items.concat(fresh);
    b.continuation = r.continuation;
    await ytsMarkExisting(fresh);
    if (seq !== ytsSearchSeq || ytsBrowse !== b) return;
    ytsRenderResults();
    ytsMsg('');
    $('yts-more').classList.toggle('hidden', !r.continuation);
  } catch (e) {
    if (seq !== ytsSearchSeq) return;
    ytsMsg(yts.searchMessage(e && e.message === 'parse' ? 'parse' : 'network'), 'err');
  }
}

/** The next continuation page, appended without duplicates. */
async function ytsMore() {
  if (ytsBrowse) return ytsBrowseMore();
  const { query, filter, continuation } = ytsCtx;
  if (!continuation) return;
  const seq = ++ytsSearchSeq;
  const yts = await import('./ytsearch.js');
  ytsMsg(yts.searchMessage('more'));
  try {
    const r = await yts.searchYouTube(query, { continuation });
    // seq AND query/filter unchanged — a chip tap or a new search reset the list
    if (seq !== ytsSearchSeq || ytsCtx.query !== query || ytsCtx.filter !== filter) return;
    const seen = new Set(ytsCtx.items.map((i) => i.type + ':' + i.id));
    const fresh = r.items.filter((i) => !seen.has(i.type + ':' + i.id));
    ytsCtx.items = ytsCtx.items.concat(fresh);
    ytsCtx.continuation = r.continuation;
    await ytsMarkExisting(fresh);
    if (seq !== ytsSearchSeq) return;
    ytsRenderResults();
    ytsMsg('');
    $('yts-more').classList.toggle('hidden', !r.continuation);
  } catch (e) {
    if (seq !== ytsSearchSeq) return;
    ytsMsg(yts.searchMessage(e && e.message === 'parse' ? 'parse' : 'network'), 'err');
  }
}

/**
 * Preview a video result in the bubble. The bubble gets rec-shaped COPIES of the
 * video results only (previewEmbedUrl needs {type:'youtube', id}); previewDecide
 * splices its own array, so it must never share ytsCtx.items — row state is synced
 * back by key through ytsMarkRow, never by index.
 */
function openYtsPreview(item) {
  const vids = activeYtsItems().filter((i) => i.type === 'video');
  const idx = Math.max(0, vids.findIndex((i) => i.id === item.id));
  const recs = vids.map((v) => ({ type: 'youtube', id: v.id, title: v.title, srcUrl: v.url, _yts: v }));
  openPreview(recs, idx, 'search');
}

async function doSyncAndRefresh() {
  const status = $('remote-status');
  status.textContent = 'טוען…'; status.className = 'form-msg';
  // v1.0.18: a forced sync re-reads every channel feed and every logo — minutes on a big
  // library. The .form-msg line stays (it holds the RESULT once we are done); the
  // full-screen view is what carries the wait itself.
  loading.show({ title: 'בודקים את רשימת הסרטונים', step: 'טוען…', pct: 0 });
  try {
    // v1.0.49 — PULL FIRST, FORCED. This button says "רענון נתונים" and the parent presses
    // it meaning "fetch whatever is new", but it only ever ran the local sync: a site, an
    // approval or a channel added on another device could not arrive through it at all.
    // Reported from the field as "I had to press רענון to get the sites" — which worked
    // only because the button ends in a re-render of data an earlier pull had already
    // landed. Forced, because the parent asked explicitly; SERIALIZED before the sync for
    // the pullThenSync reason (both write the same records).
    loading.setStep('בודקים מה חדש במכשירים האחרים…');
    await maybePullDrive({ force: true });
    const res = await syncLibrary(activeProfileId, {
      force: true,
      onProgress: (p) => { status.textContent = p.label || 'טוען…'; loading.progress(p); }
    });
    if (res.ok) {
      status.textContent = `עודכן ✅ ${res.added ? `נוספו ${res.added}` : ''} ${res.pending ? `• ממתינים לאישור: ${res.pending}` : ''}`;
      status.className = 'form-msg ok';
    } else {
      status.textContent = 'שגיאה בסנכרון: ' + (res.error || '');
      status.className = 'form-msg err';
    }
  } catch (e) {
    status.textContent = 'שגיאה בסנכרון';
    status.className = 'form-msg err';
  }
  try {
    loading.setStep('מרעננים את הרשימות…');
    await loadGiftStates();
    // refreshSitesPanel belongs here too: without it the button whose whole job is
    // "fetch what is new" pulled the family's sites and then left the sites tab —
    // the tab the parent is most likely standing in — showing the old rows.
    await Promise.all([
      refreshParentList(), refreshPendingList(), refreshChannelsList(), refreshSitesPanel()
    ]);
    renderHome();
  } finally {
    await loading.hide(); // the caller must ALWAYS reach hide()
  }
  maybeSchedulePush();
}

/* ---------------- Onboarding tour (v1.0.8; two decks since v1.0.18) ----------------
   Slide content and all bounds arithmetic live in tour.js (pure + unit-tested).
   This half is only the DOM. `tourDeck` is whichever deck is on screen, so the
   first-run tour and the "how do I add videos" guide share one view and one
   renderer. `tour.done` is written only by the FIRST-RUN deck — replaying the
   guide must never look like the onboarding was completed. */
let tourDeck = TOUR_SLIDES;
let tourIdx = 0;
let tourOnDone = null;
let tourIsOnboarding = true;

function renderTourSlide() {
  const s = tourDeck[tourIdx];
  if (!s) return;
  const st = slideState(tourIdx, tourDeck.length);
  const ch = deckChrome(tourDeck, tourIdx);
  $('tour-img').src = s.img;
  $('tour-img').alt = s.title;
  $('tour-title').textContent = s.title;
  $('tour-text').textContent = s.text;
  $('tour-next').textContent = st.nextLabel;
  $('tour-prev').disabled = st.prevDisabled;
  // The first-run deck hands off to the guide instead of just ending: a parent who
  // never learns how to add a link cannot use the app at all.
  const more = $('tour-more');
  if (more) more.classList.toggle('hidden', !(st.isLast && tourIsOnboarding));
  // Chapter chip + "שלב N מתוך M" replace the dots once a deck is too long to count
  // (18 dots read as noise); the short onboarding deck keeps its dots untouched.
  const chip = $('tour-chapter');
  chip.textContent = ch.chapter;
  chip.classList.toggle('hidden', !ch.chapter);
  const step = $('tour-step');
  step.textContent = ch.stepLabel;
  step.classList.toggle('hidden', ch.useDots);
  const dots = $('tour-dots');
  dots.classList.toggle('hidden', !ch.useDots);
  dots.innerHTML = '';
  if (!ch.useDots) return;
  for (const on of st.dots) {
    const d = document.createElement('span');
    if (on) d.classList.add('on');
    dots.appendChild(d);
  }
}

/**
 * Boot shows the onboarding deck once ever (tour.done); the About tab replays it,
 * and the parent screen opens the add-videos guide directly.
 * @param deck        which slide deck to show
 * @param onboarding  does finishing this deck mark the onboarding as done?
 */
function startTour({ replay = false, onDone = null, deck = TOUR_SLIDES, onboarding = true } = {}) {
  tourDeck = Array.isArray(deck) && deck.length ? deck : TOUR_SLIDES;
  tourIsOnboarding = onboarding;
  tourIdx = 0;
  tourOnDone = onDone;
  renderTourSlide();
  if (replay) nav.go('tour'); else nav.reset('tour');
}

/** The add-videos chapter — from the last tour slide, the parent screen, About. */
function startAddGuide({ replay = true } = {}) {
  startTour({ replay, deck: ADD_GUIDE_SLIDES, onboarding: false });
}

function tourStep(delta) {
  const n = nextIndex(tourIdx, tourDeck.length, delta);
  if (n === tourIdx) return;
  tourIdx = n;
  renderTourSlide();
}

async function finishTour() {
  // Only the onboarding deck may retire the first-run tour.
  if (tourIsOnboarding) await prefSet('tour.done', '1');
  const done = tourOnDone;
  tourOnDone = null;
  if (done) { done(); return; }     // boot flow continues (connect / profiles)
  if (!nav.back()) goGallery();      // replay from the About tab — go back there
}

/* ---------------- (the sheet-setup wizard lived here, v1.0.8–v1.0.37) ----------------
 * v1.0.38 removed it with the Google-Sheets sources list itself. A new profile goes
 * straight into the app (createNewProfile → activateProfile); bulk adding and moving a
 * library between devices is the links file (sources tab). NEVER re-add a way to attach
 * a sheet: the sunset migration deletes the family's sheet files, so a re-attached URL
 * would point at a file nothing maintains — and re-adding the whole write layer is the
 * two-sources-of-truth design v1.0.38 exists to end. */

/* ---------------- First-launch Google connect (v1.0.4) ---------------- */
/** Maps a gauth failure to the parent-facing message (shared: connect + settings). */
function gauthErrorText(err) {
  err = err || '';
  return /auth-unavailable:10\b/.test(err)
    ? 'האפליקציה לא רשומה ב-Google Cloud — השלימו את צעדים 3-4 במדריך GOOGLE_CLOUD_SETUP.md (ודאו שה-SHA-1 של גרסת ה-release רשום)'
    : /auth-unavailable/.test(err)
      ? `שירותי Google לא זמינים במכשיר (${err})`
      : err === 'no-plugin'
        ? 'זמין באפליקציה המותקנת בלבד (לא בדפדפן)'
        : 'ההתחברות בוטלה';
}

/** The normal boot landing: profiles picker, or profile creation when none exist. */
function startAtProfiles() {
  if (profiles.length === 0) { openCreateProfile(); return; }
  // v1.0.29: resume the LAST-USED profile (device-local — prefGet, never the synced
  // channel: one account, several devices, a different child on each). The decision is
  // pure planBootProfile; a queued cold-start share still gets the picker, because the
  // picker IS that share's routing question (v1.0.23). Falls back to the picker on any
  // doubt — auto-entering a deleted profile would be worse than one extra tap.
  (async () => {
    const { prefGet } = await import('./platform.js');
    const { hasQueuedShares } = await import('./share.js');
    const id = planBootProfile({
      storedId: await prefGet('activeProfile'),
      profileIds: profiles.map((pr) => pr.id),
      hasQueuedShare: await hasQueuedShares()
    });
    if (id) { await activateProfile(id); return; }
    renderProfiles(); nav.reset('profiles');
  })().catch(() => { renderProfiles(); nav.reset('profiles'); });
}

/**
 * Offer the Google connect ONCE, before profile selection: not in the browser
 * preview (no Google services), not after it was answered, not when backup is
 * already on. Skipping is always available — the parent screen keeps the flow.
 */
async function shouldOfferConnect() {
  try {
    const { gauthAvailable } = await import('./gauth.js');
    if (!gauthAvailable()) return false;
    if (await prefGet('gauth.introDone')) return false;
    return !((await db.getMeta('drive')) || {}).enabled;
  } catch { return false; }
}

async function connectGoogleFirstLaunch() {
  const msg = $('connect-msg');
  const btn = $('connect-google');
  btn.disabled = true;
  msg.textContent = 'מתחברים…'; msg.className = 'form-msg';
  let pulled = null;
  try {
    const { signIn, lastAuthError } = await import('./gauth.js');
    const { pullDrive, pushDrive } = await import('./drive.js');
    if (!(await signIn())) {
      msg.textContent = gauthErrorText(lastAuthError());
      msg.className = 'form-msg err';
      return;
    }
    // v1.0.18: reading and merging the Drive backup is the LONGEST blocking wait in
    // the app, and it used to report itself only through this 22px line at the very
    // bottom of the screen — parents read that as a freeze. Give it the full-screen
    // animation, and hide it again before any modal so the two never stack.
    msg.textContent = 'בודקים אם יש גיבוי קיים…';
    loading.show({ title: 'בודקים את הגיבוי בגוגל', step: 'מחפשים גיבוי קיים…' });
    pulled = await pullDrive(activeProfileId);
    loading.setStep('שומרים את הפרופילים…');
    profiles = await getProfiles(); // pullDrive may have restored profiles
    await pushDrive(profiles);      // enables the backup even without a prior file
    await prefSet('gauth.introDone', 'connected');
  } catch {
    msg.textContent = 'שגיאה בהתחברות — אפשר לדלג ולנסות שוב מאוחר יותר דרך מסך ההורים';
    msg.className = 'form-msg err';
    return;
  } finally {
    await loading.hide();
    btn.disabled = false;
  }
  if (pulled && pulled.ok && !pulled.empty) {
    await alertKid({
      emoji: '☁️', title: 'הגיבוי חובר ✅',
      text: pulled.profilesRestored
        ? `נמצא גיבוי קיים: שוחזרו ${pulled.profilesRestored} פרופילים והספרייה סונכרנה.`
        : 'נמצא גיבוי קיים והספרייה סונכרנה למכשיר.',
      ok: 'מעולה'
    });
  }
  startAtProfiles();
}

/* ---------------- Profiles ---------------- */
/**
 * The profile picker. `onPick` (v1.0.23) makes it a SELECTION screen instead of the
 * activation screen — used to route an Android share. Selection and activation used to be
 * inseparable (every tile hard-wired `activateProfile`), so there was no way to ask "which
 * child?" about anything.
 */
function renderProfiles({ onPick = null, title = null } = {}) {
  $('profiles-title').textContent = title || 'מי צופה? 🍿';
  const grid = $('profiles-grid');
  grid.innerHTML = '';
  for (const p of profiles) {
    const btn = document.createElement('button');
    btn.className = 'profile-tile';
    btn.type = 'button';
    const av = document.createElement('span');
    av.className = 'avatar avatar-lg';
    av.textContent = p.avatar;
    av.style.background = p.color;
    const nm = document.createElement('span');
    nm.className = 'profile-name';
    nm.textContent = p.name;
    btn.appendChild(av);
    btn.appendChild(nm);
    btn.addEventListener('click', () => (onPick ? onPick(p.id) : activateProfile(p.id)));
    grid.appendChild(btn);
  }
  // No "new profile" tile while choosing a share target: creating a profile runs the sheet
  // wizard and its own activation, which would abandon the share mid-flight.
  if (onPick) return;
  const add = document.createElement('button');
  add.className = 'profile-tile profile-add';
  add.type = 'button';
  const addAv = document.createElement('span');
  addAv.className = 'avatar avatar-lg avatar-add';
  addAv.textContent = '➕';
  const addNm = document.createElement('span');
  addNm.className = 'profile-name';
  addNm.textContent = 'פרופיל חדש';
  add.appendChild(addAv);
  add.appendChild(addNm);
  add.addEventListener('click', openCreateProfile);
  grid.appendChild(add);
}

/**
 * WHICH profile does this shared link go to?
 *
 * v1.0.26: asked whenever there is MORE THAN ONE profile. v1.0.23 also skipped the question
 * when several profiles followed the same sheet — the video lands in the same library row
 * either way — but a parent reported not knowing where a shared video had gone, and "it
 * does not matter" is only true of the DATA, not of what they can see. A single profile
 * still skips: there is nothing to ask, and a one-tile picker teaches tapping without
 * reading.
 *
 * The parent's decision (2026-08-01) is that choosing also SWITCHES the app into that
 * profile — so the picker resolves through `activateProfile`, and the share's own PIN +
 * confirm flow then runs inside the chosen profile.
 * -> profileId | null (backed out)
 */
async function chooseShareProfile() {
  // v1.0.26 — ASK WHENEVER THERE IS A CHOICE. v1.0.23 also skipped the question when two
  // profiles happened to share one sheet (same library scope, same row either way), but a
  // parent reported not knowing where a shared video had gone — and the answer "it does not
  // matter" is only true of the DATA, not of what the parent can see. One profile still
  // skips: there is nothing to ask, and a one-tile picker teaches tapping without reading.
  if (profiles.length < 2) return activeProfileId || (profiles[0] && profiles[0].id) || null;

  return new Promise((resolve) => {
    let settled = false;
    const done = (id) => { if (settled) return; settled = true; shareProfileCancel = null; resolve(id); };
    shareProfileCancel = () => done(null); // back / any navigation away = no decision
    renderProfiles({
      title: 'לאיזה פרופיל להוסיף?',
      onPick: async (id) => {
        if (settled) return;
        settled = true;
        shareProfileCancel = null;
        await activateProfile(id); // resets nav to that profile's gallery
        resolve(id);
      }
    });
    nav.go('profiles');
  });
}
let shareProfileCancel = null;

function renderAvatarGrid() {
  const grid = $('avatar-grid');
  grid.innerHTML = '';
  for (const a of AVATARS) {
    const b = document.createElement('button');
    b.className = 'avatar-opt';
    b.type = 'button';
    b.textContent = a.e;
    b.style.background = a.c;
    b.addEventListener('click', () => {
      createSel = a;
      $('create-preview-av').textContent = a.e;
      $('create-preview-av').style.background = a.c;
      for (const x of grid.children) x.classList.remove('sel');
      b.classList.add('sel');
    });
    grid.appendChild(b);
  }
}

function openCreateProfile() {
  createSel = null;
  $('create-name').value = '';
  $('create-preview-av').textContent = '🙂';
  $('create-preview-av').style.background = '#eceaff';
  $('create-msg').textContent = '';
  $('create-back').classList.toggle('hidden', profiles.length === 0);
  renderAvatarGrid();
  if (profiles.length === 0) nav.reset('create-profile');
  else nav.go('create-profile');
}

async function createNewProfile() {
  const name = $('create-name').value.trim();
  const msg = $('create-msg');
  if (!name) { msg.textContent = 'בחרו שם'; msg.className = 'form-msg err'; return; }
  if (!createSel) { msg.textContent = 'בחרו תמונה'; msg.className = 'form-msg err'; return; }

  // v1.0.22 — the name must be unique across the whole GOOGLE ACCOUNT, not just this
  // device. The gate lives in profileNameClash (v1.0.38) so the links import's
  // "create a new profile from this file" branch shares it instead of skipping it.
  const clash = await profileNameClash(name);
  if (clash) {
    msg.textContent = PROFILE_CLASH_MSG[clash];
    msg.className = 'form-msg err';
    renderProfiles(); // the pull may have added profiles — show them
    return;
  }
  const p = await createProfile(name, createSel.e, createSel.c);
  profiles = await getProfiles();
  // v1.0.38: straight into the app — the sheet-setup wizard is gone. ensureSources /
  // doSync mint `lib:p:<id>` on first use, and the empty home's guide button is the
  // honest answer to "where will the videos come from?".
  await activateProfile(p.id);
}

async function activateProfile(id) {
  // v1.0.63 — a sibling's video must never keep playing into the next child's session, and
  // `bgPlay` is a PER-PROFILE answer: the new profile may not have it on at all. Torn down
  // before the switch, and re-armed by the next openWatch if the new child's setting says so.
  await disarmBackgroundPlayback().catch(() => {});
  await setActiveId(id);
  activeProfileId = id;
  source = await getSource();
  items = await loadItems(); // legacy list — parent screen only
  page = 0;
  // v1.0.33 (review finding): the search area is PER PROFILE — its "✓ קיים" marks were
  // computed against the previous child's scopes, and rendered rows would keep lying
  // (disabled buttons over videos the new child does NOT have). Same profile-identity
  // rule as the buildFolders cache key (v1.0.20).
  resetYtsUi();
  // v1.0.45: same profile-identity rule — the approved sites and the enable toggle are
  // per profile, so a sibling must never inherit the previous child's tiles for even one
  // render. The launcher is repainted from the fresh list by renderHome below.
  siteEntries = [];
  siteBlockedRecent = [];
  await loadSiteEntries();

  // HYDRATE first: render whatever IndexedDB has, instantly. Sync runs after.
  await absorbMineIntoShared(id); // v1.0.6: fold personal adds into the shared list
  await loadGiftStates();
  await renderHome();
  await updateProfileChip();
  // v1.0.25: the exit lock belongs to the CHILD now, so switching children changes the
  // answer — re-arm (or release) it and repaint the exit button for whoever this is.
  await applyExitLock();
  await applyContainment(); // v1.0.56 — survives a restart and a profile switch
  // …and a relaunch under a FOLDER lock lands INSIDE that folder, not on the home where
  // every other tile is on screen (the openFolder guard refuses the tap, but showing the
  // child a home they cannot use is not the promise).
  const containLanding = containState.active && containState.mode === 'folder'
    ? containState.folderId : null;
  // v1.0.31: a persisted scheduled lock survives a restart AND a profile switch — check it
  // now (it overrides the gallery), and keep the ticker running for this session.
  startLockTicker();
  await tickScheduledLock();
  // v1.0.34: the idle screen-off timer runs for the whole session; a profile switch is
  // itself user input, so the fresh child never inherits the previous child's idle time.
  idleLastInputAt = Date.now();
  startIdleTicker();

  const hasContent = folders.length > 0;
  if (!hasContent) {
    // Nothing cached (fresh profile with a sheet): the child needs the loading screen.
    // A child who DOES have cached content keeps browsing while the sync runs behind
    // them — covering a populated grid every 3 minutes would be the worse bug.
    loading.show({ title: 'מכינים את הסרטונים', step: 'מביאים סרטונים חדשים…', pct: 0 });
  }
  // Fires the gallery's onEnter SYNCHRONOUSLY, which is what starts the refresh below.
  // Cleared first so a bail-out inside homeEntryRefresh cannot leave us awaiting the
  // PREVIOUS profile's refresh.
  entryRefreshInFlight = null;
  nav.reset('gallery');
  // v1.0.56 — …and then straight into the locked folder. AFTER the gallery reset, not
  // instead of it: the gallery's onEnter is what starts the entry refresh (the pull + the
  // sync), and skipping it would leave a contained child on stale content forever.
  // AWAIT the home render first — `folders` is what openFolder reads the title and the
  // picture from, and navigating before it exists landed the child in a folder with a
  // BLANK header (measured in the browser).
  if (containLanding) {
    await renderHome().catch(() => {});
    await openFolder(containLanding).catch(() => {});
  }
  // v1.0.67 — THE WEBSITE LOCKS SURVIVE A RESTART TOO, which is what makes them a lock
  // rather than a suggestion: force-closing the app is the first thing a child tries.
  // A 'site' lock REOPENS the site (the user's decision 2026-08-31) — landing on the list
  // would let them simply not tap it and sit outside the lock; openLockedSite releases the
  // lock by itself if the parent has since deleted the site.
  if (containState.active && (containState.mode === 'sites' || containState.mode === 'site')) {
    nav.reset('sites');
    renderSitesView();
    if (containState.mode === 'site') await openLockedSite(containState.siteUrl).catch(() => {});
  }

  // v1.0.7: shares queued before a profile was active drain AFTER the gallery is up —
  // their interactive PIN flow must not fight the activation navigation.
  drainShareQueue().catch(() => {});

  // Background: pull the family's shared state, then sync the sheet — one pipeline,
  // started by the line above. Never blocks the grid; re-renders when either one lands
  // something new (v1.0.22).
  awaitEntryRefresh().catch(async () => { await loading.hide(); });
}

async function updateProfileChip() {
  const p = await getActiveProfile();
  const chip = $('profile-chip');
  if (!p) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  $('chip-av').textContent = p.avatar;
  $('chip-av').style.background = p.color;
  $('chip-name').textContent = p.name;
}

async function backToProfiles() {
  stop();
  currentWatch = null;
  profiles = await getProfiles();
  renderProfiles();
  nav.reset('profiles');
}

async function deleteCurrentProfile() {
  const p = await getActiveProfile();
  if (!p) return;
  const yes = await confirmKid({
    emoji: '🗑️', title: `למחוק את הפרופיל "${p.name}"?`,
    text: 'כל הסרטונים של הפרופיל יימחקו. פעולה זו אינה הפיכה.',
    ok: 'מחיקה', cancel: 'ביטול', danger: true
  });
  if (!yes) return;
  // v1.0.25: actually erase it. The confirm has always said the deletion is permanent,
  // but only the row in the profile list was removed — db.purgeProfile had zero callers.
  // The library scope goes too, unless a sibling profile still reads the same sheet.
  try {
    const src = await db.getSources(p.id);
    const others = [];
    for (const other of profiles) {
      if (!other || other.id === p.id) continue;
      const os = await db.getSources(other.id).catch(() => null);
      others.push({ profileId: other.id, libraryId: os && os.libraryId });
    }
    const { scopes } = planProfilePurge(p.id, src && src.libraryId, others);
    await db.purgeProfile(p.id, scopes);
  } catch { /* the profile still goes; leftover rows are invisible without it */ }
  await deleteProfile(p.id);   // also writes the tombstone that stops a Drive pull reviving it
  maybeSchedulePush();
  items = [];
  source = { mode: 'manual', url: '' };
  profiles = await getProfiles();
  if (profiles.length > 0) { renderProfiles(); nav.reset('profiles'); }
  else openCreateProfile();
}

/* ---------------- Wiring ---------------- */
function wire() {
  // v1.0.8: onboarding tour
  $('tour-next').addEventListener('click', () => {
    if (slideState(tourIdx, tourDeck.length).isLast) finishTour();
    else tourStep(1);
  });
  $('tour-prev').addEventListener('click', () => tourStep(-1));
  $('tour-skip').addEventListener('click', finishTour);
  // v1.0.18: last slide of the onboarding deck → straight into the add-videos
  // guide, without losing the "onboarding finished" mark on the way.
  $('tour-more').addEventListener('click', async () => {
    await prefSet('tour.done', '1');
    const done = tourOnDone;
    tourOnDone = null;
    tourDeck = ADD_GUIDE_SLIDES;
    tourIsOnboarding = false;
    tourIdx = 0;
    tourOnDone = done; // the boot flow still continues once the guide ends
    renderTourSlide();
  });


  $('connect-google').addEventListener('click', connectGoogleFirstLaunch);
  $('connect-skip').addEventListener('click', async () => {
    await prefSet('gauth.introDone', 'skipped');
    startAtProfiles();
  });

  // Fails CLOSED: if anything in the gate throws, the child stays put. Falling back to
  // backToProfiles() would make a locked profile escapable by whatever made it throw.
  $('profile-chip').addEventListener('click', () => { onProfileChip().catch(() => {}); });
  $('create-back').addEventListener('click', backToProfiles);
  $('create-save').addEventListener('click', createNewProfile);
  $('delete-profile').addEventListener('click', deleteCurrentProfile);
  $('parent-gate-btn').addEventListener('click', openParentGate);

  $('pg-prev').addEventListener('click', () => { page -= 1; renderHome(); });
  $('pg-next').addEventListener('click', () => { page += 1; renderHome(); });

  // v1.0.57 — THE SAME PAGE TURN, BY FINGER (user request). Bound ONCE here, on elements
  // that live in index.html and are never replaced, so no render can leak a listener.
  //
  // The home and the folder listen on the WHOLE VIEW: the user asked to swipe "on the app
  // screen", and a child's flick starts wherever their hand is — over the grid, over the
  // gap beside it, over the pager bar. The WATCH view deliberately listens on its GRID
  // ALONE: the player above it owns its own gesture language (centre tap pauses, double
  // tap seeks ±10s, and the shield is the surface v1.0.52 spent three releases getting
  // right), and a page flip must never be a fourth meaning for a finger crossing it.
  //
  // Every state getter reads the LIVE numbers at gesture end — the pager object for the
  // two that have one, `homePages` for the hand-written home pager (its markup predates
  // makePager and carries the exit button, so it is not one).
  // v1.0.62 — the fourth argument is the LIVE TRACK: the page follows the finger and the
  // neighbour slides in beside it (user request). It is optional by design — every grid
  // still turns pages through the same `onSwipe` the arrows use, so a missing viewport or
  // a ghost that never rendered degrades to the v1.0.57 flick, never to nothing.
  attachSwipePager($('view-gallery'), (dir) => {
    page += dir === 'next' ? 1 : -1;
    // v1.0.75 — RETURNED, not fired: ui/swipe.js awaits this before it clears the
    // transform, so the new page is on screen before the grid comes back to rest.
    return renderHome();
  }, () => ({ page, total: homePages }), {
    viewport: $('grid-vp'), grid: $('grid'),
    renderPage: (n, target) => { paintHomePage(target, n); }
  });

  attachSwipePager($('view-folder'), (dir) => {
    folderPage += dir === 'next' ? 1 : -1;
    return renderFolderView().catch(() => {});   // v1.0.75 — awaited before the reset
  }, () => (folderPagerObj ? folderPagerObj.state() : null), {
    viewport: $('folder-grid-vp'), grid: $('folder-grid'),
    renderPage: (n, target) =>
      renderGridPage(target, scopeForFolder(folderId), folderId, 'folder', n, true)
  });

  attachSwipePager($('watch-grid'), (dir) => {
    watchPage += dir === 'next' ? 1 : -1;
    return renderWatchGrid(currentWatch);        // v1.0.75 — awaited before the reset
  }, () => (watchPager ? watchPager.state() : null), {
    viewport: $('watch-grid-vp'), grid: $('watch-grid'),
    renderPage: (n, target) => paintWatchPage(target, n, currentWatch)
  });
  $('exit-btn').addEventListener('click', askExit);
  // v1.0.32: the picker's exit button — same flow as hardware back there (user request)
  $('profiles-exit').addEventListener('click', askExit);
  $('folder-back').addEventListener('click', () => { if (!nav.back()) goGallery(); });

  // v1.0.7: home search
  $('search-open').addEventListener('click', openSearch);
  $('folder-search').addEventListener('click', () => { openFolderSearch().catch(() => {}); });
  $('search-back').addEventListener('click', () => { if (!nav.back()) goGallery(); });
  $('sites-open').addEventListener('click', () => { openSitesView().catch(() => {}); });
  $('sites-back').addEventListener('click', () => {
    // v1.0.67 — under a websites lock the videos are not a destination. The button is
    // hidden by containmentChrome, but hiding is the affordance and THIS is the boundary:
    // a TV remote can reach a hidden-but-present control, and a stale render can show it.
    if (containState.active && (containState.mode === 'sites' || containState.mode === 'site')) return;
    if (!nav.back()) goGallery();
  });
  $('sites-enabled').addEventListener('change', async () => {
    await putSetting(activeProfileId, 'sitesEnabled', $('sites-enabled').checked);
    await refreshSitesPanel();
    await refreshSitesLauncher();
    maybeSchedulePush();
  });
  $('site-sc-add').addEventListener('click', () => { addSiteFromInput('shortcut').catch(() => {}); });
  $('site-rule-add').addEventListener('click', () => { addSiteFromInput('rule').catch(() => {}); });
  for (const [id, kind] of [['site-sc-url', 'shortcut'], ['site-rule-url', 'rule']]) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addSiteFromInput(kind).catch(() => {}); }
    });
  }
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { renderSearchResults().catch(() => {}); }, 180);
  });

  // ✋ — the child's way out of a chain. Same destination a video END has with continuous
  // play OFF: the folder they came from, not the home screen.
  $('autoplay-stop').addEventListener('click', () => { resetAutoplayChain(); leaveWatch(); });
  // v1.0.31/v1.0.55: the break screen's two doors — the exit button (hidden under the
  // kiosk; free today, code-gated under the full-tablet lock — onLockedExitTap reads the
  // containment at tap time) and the discreet parent-unlock tap.
  $('locked-exit').addEventListener('click', () => { onLockedExitTap().catch(() => {}); });
  $('locked-parent').addEventListener('click', () => { onLockedParentTap().catch(() => {}); });
  /* preview bubble (v1.0.26) */
  $('pv-close').addEventListener('click', closePreview);
  $('pv-open').addEventListener('click', async () => {
    const rec = previewCtx && previewCtx.items[previewCtx.idx];
    if (!rec) return;
    const { openExternal } = await import('./platform.js');
    openExternal(rec.srcUrl || ('https://www.youtube.com/watch?v=' + rec.id)).catch(() => {});
  });
  $('pv-approve').addEventListener('click', () => previewDecide(async (rec) => {
    await db.approvePending(rec.scopeId, [rec.key]);
    await refreshPendingList();
    renderHome();
    refreshAfterAdd({ parent: true }); // approval is what makes it live — enrich + gift it
    maybeSchedulePush();
  }));
  $('pv-reject').addEventListener('click', () => previewDecide(async (rec) => {
    // Parked in '~rejected', exactly like the row's 🗑️ — recoverable, no sheet removal row.
    await db.rejectPending(rec.scopeId, [rec.key]);
    await refreshPendingList();
  }));
  $('pv-delete').addEventListener('click', () => previewDecide(async (rec) => {
    const yes = await confirmKid({
      emoji: '🗑️', title: 'למחוק את הסרטון?', text: rec.title || '',
      ok: 'מחיקה', cancel: 'ביטול', danger: true
    });
    if (!yes) return false; // backed out — stay on this video
    await db.deleteVideo(rec.scopeId, rec.key);
    await refreshParentList();
    renderHome();
    maybeSchedulePush();
  }));
  // v1.0.33: ➕ from inside the bubble — the triage flow previewDecide was built for:
  // added/exists both count as decided (advance to the next result), a failure stays.
  $('pv-add').addEventListener('click', () => previewDecide(async (rec) => {
    const it = rec._yts;
    if (!it) return false;
    const r = await ytsAdd(it).catch(() => null);
    return !!r && (r.status === 'added' || r.status === 'exists');
  }));
  $('watch-home').addEventListener('click', goGallery);
  // v1.0.43 (user request) — LEAVING FULLSCREEN LANDS ON THE TOP OF THE PAGE.
  //
  // Exiting fullscreen is NOT a navigation: `nav.handleBack` answers 'exit-fullscreen' and
  // returns, and the HUD's ⛶ does the same — so nothing ever scrolled, and the child came
  // back to wherever they had scrolled to (usually the grid below, with the small player
  // off-screen above). The F4 fix gave that guarantee to nav.go; this gives it to the one
  // way out that never goes through nav.
  //
  // Reuses nav.transition's proven DOUBLE rAF: the layout reflows as the element leaves
  // fullscreen, and a scroll issued in the same frame is undone by that reflow.
  //
  // The `isActive('watch')` check is re-tested INSIDE the rAF on purpose: `leaveWatch`
  // (a video that ended) exits fullscreen and THEN calls nav.back(), which restores the
  // folder's scroll — scrolling to the top after that would clobber it and drop the child
  // at the top of a folder they were half-way down.
  // v1.0.51 — the landing must also SURVIVE the platform's own scroll restore.
  // Field report ("בגירסה האחרונה", 2026-08-18): the child exits fullscreen and lands
  // mid-page again. The double rAF below beats the REFLOW, but Android's WebView also
  // RESTORES the pre-fullscreen scroll offset as the native custom view tears down, and
  // that restore can land well after two rAFs on a real tablet. The scenario that banks a
  // non-zero offset: the child taps the NEXT video from halfway down the under-player
  // grid — fullscreen banks that offset at entry (nav.replace scrolls to 0 underneath,
  // invisibly), and the exit restore drops them back at the grid with the playing video
  // off-screen above. A longer timer would just be a slower bet on the same race; the fix
  // is a PIN: for a short window after the exit, any scroll away from the top while still
  // watching is snapped back by the 'scroll' listener — it fires exactly when the restore
  // lands, whenever that is. Passive and permanently registered: outside the window it is
  // one timestamp compare per scroll event.
  const FS_EXIT_PIN_MS = 700;
  let fsExitPinUntil = 0;
  const onFsExitPinScroll = () => {
    if (Date.now() > fsExitPinUntil) return;                                    // not pinned
    if (document.fullscreenElement || document.webkitFullscreenElement) return; // re-entered
    if (!nav.isActive('watch')) return; // leaveWatch → nav.back restores the FOLDER's scroll
    if ((window.scrollY || 0) !== 0) window.scrollTo(0, 0);
  };
  window.addEventListener('scroll', onFsExitPinScroll, { passive: true });
  // v1.0.52 — THE CHILD'S OWN FINGER DISARMS THE PIN. The pin exists to defeat the
  // WebView's PROGRAMMATIC scroll restore, which arrives with no pointer event; a child
  // who starts scrolling inside the 700ms window was having their gesture snapped back
  // to the top ("יוצאים ממסך מלא ואי אפשר לגלול"). Every touch that could arm the exit
  // (the HUD's ⛶, the system back gesture) completes BEFORE fullscreenchange fires, so
  // any pointerdown seen while pinned is a NEW, deliberate gesture — and it wins.
  // Capture phase: no handler's stopPropagation may keep the pin alive.
  window.addEventListener('pointerdown', () => { fsExitPinUntil = 0; }, { capture: true, passive: true });
  const onFullscreenChange = () => {
    // v1.0.54 — a fullscreen video plays LANDSCAPE, always (user request: like YouTube;
    // decision 2026-08-25: every handheld device — all content is 16:9 long-form). The
    // activity-level request is what overrides the SYSTEM rotation lock; hooked HERE so
    // every door is covered by one line: the tile tap's auto-fullscreen, the ⛶ button,
    // hardware back, and a video that ends. Pure fullscreenOrientation returns null on
    // TV (no sensor, landscape by construction) — then nothing is touched.
    const entering = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const want = fullscreenOrientation({ fullscreen: entering,
      tv: document.documentElement.classList.contains('tv') });
    if (want) setOrientation(want).catch(() => {});
    if (entering) return; // the scroll pin below is exit-only
    // NOTE: the 'auto' restore above deliberately ran BEFORE this watch guard —
    // leaveWatch (a video that ENDED) exits fullscreen and then navigates away, and a
    // restore gated on "still watching" would leave the whole app stuck sideways.
    if (!nav.isActive('watch')) return;
    fsExitPinUntil = Date.now() + FS_EXIT_PIN_MS;
    // TWICE, and both are load-bearing. The immediate call is what makes this correct when
    // rAF cannot run — callbacks are SUSPENDED while the document is hidden (measured), so
    // fullscreen exiting as the app goes to the background would otherwise leave the page
    // scrolled. The deferred pair is what makes it STICK: the reflow as the element leaves
    // fullscreen lands after the immediate scroll and would undo it on its own.
    window.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (nav.isActive('watch')) window.scrollTo(0, 0);
    }));
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  $('watch-fav').addEventListener('click', () => { toggleFavourite().catch(() => {}); });
  $('watch-delete').addEventListener('click', onDeleteWatch);
  $('ctl-fs').addEventListener('click', () => {
    const el = $('player-wrap');
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
      else if (el.requestFullscreen) { const p = el.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch { /* some embedded webviews deny fullscreen — never throw at the child */ }
  });

  document.querySelector('.keypad').addEventListener('click', (e) => {
    const b = e.target.closest('.key'); if (!b || !b.dataset.k) return;
    onKey(b.dataset.k);
  });
  // v1.0.55: the code can be TYPED — TV-remote digit buttons and hardware keyboards —
  // so on TV nothing on screen lights up while the parent enters it (D-pad walking the
  // on-screen pad shows the child the code one focus ring at a time; the pad itself
  // STAYS, because many Android TV remotes carry no digit buttons at all). Gated hard:
  // only while the PIN view is the active view, never under a modal (the recovery flow
  // stacks confirms over this screen), and never out of a text field. The mapping is
  // pure plan.pinKeyAction; everything it refuses (Enter, Escape, arrows) keeps its
  // existing owner — the D-pad manager and hardware-back.
  window.addEventListener('keydown', (e) => {
    if (!nav.isActive('pin') || isModalOpen()) return;
    // A HELD key must not type (dpad.js's ~30/s lesson): in SETUP mode a held remote
    // digit would fill step 1 with '7777' and the still-repeating key would confirm
    // step 2 with the same digits — the family's code set without anyone choosing it.
    if (e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const act = pinKeyAction(e.key);
    if (!act) return;
    e.preventDefault();
    onKey(act);
  });
  // v1.0.7: cancel returns to WHERE THE PIN OPENED FROM (profiles/gallery/folder) —
  // the pin view can now open over the profiles screen too (update flow).
  $('pin-cancel').addEventListener('click', () => { if (!nav.back()) goGallery(); });
  $('pin-forgot').addEventListener('click', () => { onPinForgot().catch(() => {}); });
  $('recovery-banner-cancel').addEventListener('click', async () => {
    // Free to cancel, by design (recovery.js): whoever did NOT ask for the reset cannot
    // prove who they are, and that is precisely the situation this feature exists for.
    // A child cancelling only restores the status quo.
    try {
      const { cancelRecovery } = await import('./recovery.js');
      await cancelRecovery();
    } catch {}
    await refreshRecoveryBanner();
  });

  for (const t of PARENT_TABS) $('tab-' + t).addEventListener('click', () => setParentTab(t));
  $('add-btn').addEventListener('click', parentAdd);

  // v1.0.33: the YouTube search block above the paste field
  $('yts-go').addEventListener('click', () => { ytsSearch().catch(() => {}); });
  $('yts-more').addEventListener('click', () => { ytsMore().catch(() => {}); });
  $('yts-browse-back').addEventListener('click', () => { closeYtsBrowse(); });
  $('yts-browse-add').addEventListener('click', async () => {
    const b = ytsBrowse;
    if (!b) return;
    const btn = $('yts-browse-add');
    btn.disabled = true; // one tap = one add; the re-render below restores it on failure
    await ytsAdd(b.item).catch(() => {});
    renderYtsBrowseHead();
  });
  $('yts-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ytsSearch().catch(() => {}); }
    else if (e.key === 'Escape' && !$('yts-suggest').classList.contains('hidden')) {
      // close ONLY the dropdown: in the browser Escape doubles as the hardware-back
      // stand-in, and without stopPropagation one press would also pop the view
      e.stopPropagation();
      ytsHideSuggest();
    }
  });
  $('yts-input').addEventListener('input', () => {
    clearTimeout(ytsSuggestTimer);
    ytsSuggestTimer = setTimeout(() => { ytsShowSuggestions().catch(() => {}); }, 250);
  });
  // delayed so a suggestion's pointerdown (which fires before blur) wins the race;
  // skipped when focus moved INTO the dropdown (TV: arrowing down blurs the input,
  // and hiding would destroy the very node the remote just focused)
  $('yts-input').addEventListener('blur', () => {
    setTimeout(() => {
      if ($('yts-suggest').contains(document.activeElement)) return;
      ytsHideSuggest();
    }, 150);
  });
  for (const chip of document.querySelectorAll('#yts-chips .yts-chip')) {
    chip.addEventListener('click', () => {
      // an emptied input re-runs the LAST query under the new filter (review finding:
      // flipping the chip without searching left the highlight and ytsCtx.filter
      // claiming channels-only over mixed results, and 'עוד תוצאות' then appended
      // under the wrong chip)
      if (!$('yts-input').value.trim() && ytsCtx.query) $('yts-input').value = ytsCtx.query;
      if (!$('yts-input').value.trim()) return;
      for (const c of document.querySelectorAll('#yts-chips .yts-chip')) {
        c.classList.toggle('chip-on', c === chip);
      }
      ytsCtx.filter = chip.dataset.f || 'all';
      ytsSearch().catch(() => {});
    });
  }

  $('pending-all').addEventListener('click', () => setPendingSelection(true));
  $('pending-none').addEventListener('click', () => setPendingSelection(false));

  /**
   * v1.0.24 — what the two bulk buttons act on: the ticked rows, or the WHOLE queue when
   * nothing is ticked (their original v1.0.4 meaning, which also reaches the rows past the
   * display cap). `plan.pendingBulkAction` writes that scope into the button labels, so the
   * two can never disagree about what a press is about to do.
   */
  const bulkTargets = async () => {
    const sel = new Set(pendingSel);
    const { all } = await collectPending(); // read only — the ticks must survive a cancel
    // A ticked row that vanished meanwhile (another device approved it, a sync moved it)
    // simply drops out — never fall back to the whole queue.
    return sel.size ? all.filter((r) => sel.has(selIdOf(r))) : all;
  };

  $('approve-all').addEventListener('click', async () => {
    const pend = await bulkTargets();
    if (!pend.length) return;
    const byScope = new Map();
    for (const r of pend) {
      if (!byScope.has(r.scopeId)) byScope.set(r.scopeId, []);
      byScope.get(r.scopeId).push(r.key);
    }
    for (const [s, keys] of byScope) await db.approvePending(s, keys);
    $('approve-msg').textContent = `אושרו ${pend.length} סרטונים ✅`;
    $('approve-msg').className = 'form-msg ok';
    await loadGiftStates();
    await Promise.all([refreshPendingList(), refreshParentList()]);
    renderHome();
    refreshAfterAdd({ parent: true }); // newly-live records need enrichment + gift ranks
  });
  $('reject-all').addEventListener('click', async () => {
    const pend = await bulkTargets();
    if (!pend.length) return;
    const yes = await confirmKid({
      emoji: '🗑️', title: `לדחות ${pend.length} סרטונים?`,
      // v1.0.23: no longer a one-way door — say so, or the parent won't dare press it
      text: 'הם יעברו לרשימת הדחויים ולא יופיעו אצל הילד. אפשר להחזיר אותם משם בכל עת.',
      ok: `דחייה (${pend.length})`, cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    const byScope = new Map();
    for (const r of pend) {
      if (!byScope.has(r.scopeId)) byScope.set(r.scopeId, []);
      byScope.get(r.scopeId).push(r.key);
    }
    for (const [scope, keys] of byScope) await db.rejectPending(scope, keys); // one tx per scope
    await refreshPendingList();
  });

  // v1.0.23 — the ONLY destructive step in the rejected flow: empty the list for real.
  $('purge-rejected').addEventListener('click', async () => {
    const rej = await collectRejected();
    if (!rej.length) return;
    const yes = await confirmKid({
      emoji: '🗑️', title: `למחוק ${rej.length} סרטונים לצמיתות?`,
      text: 'רשימת הדחויים תתרוקן. זו מחיקה סופית — הסרטונים לא יחזרו, גם לא בסנכרון '
        + 'ובשאר המכשירים. כדי לשמור על אחד מהם, החזירו אותו לתור האישורים לפני המחיקה.',
      ok: 'מחיקה לצמיתות', cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    const byScope = new Map();
    for (const r of rej) {
      if (!byScope.has(r.scopeId)) byScope.set(r.scopeId, []);
      byScope.get(r.scopeId).push(r.key);
    }
    for (const [scope, keys] of byScope) await db.purgeRejected(scope, keys);
    await refreshPendingList();
    maybeSchedulePush(); // the tombstones must reach the other devices
  });

  // v1.0.39: `keepOpen` handlers own their own navigation — the rolling-window review
  // raises a confirm, and a CANCELLED confirm must leave the parent on the list with the
  // buttons still live. Nulling pickHandlers here (as the approval picker wants) would
  // strand that screen with dead buttons.
  $('pick-ok').addEventListener('click', () => {
    const h = pickHandlers;
    if (!h) { if (nav.isActive('pick')) nav.back(); return; }
    if (h.keepOpen) { h.ok(); return; }
    pickHandlers = null;
    h.ok();
    if (nav.isActive('pick')) nav.back();
  });
  $('pick-alt').addEventListener('click', () => { const h = pickHandlers; if (h && h.alt) h.alt(); });
  $('pick-cancel').addEventListener('click', () => { if (nav.isActive('pick')) nav.back(); }); // onLeave cancels
  $('pick-all').addEventListener('click', () => pickHandlers && pickHandlers.all());
  $('pick-none').addEventListener('click', () => pickHandlers && pickHandlers.none());

  // v1.0.56 — the destination picker. Cancel just navigates; the view's own onLeave is
  // what resolves the awaiting add with null, so EVERY way out (button, hardware back,
  // a navigation from elsewhere) settles it exactly once.
  $('fp-ok').addEventListener('click', () => {
    // v1.0.58: the same OK serves two jobs — creating/choosing a destination, and changing
    // an existing folder's picture. One button, and the mode decides, so the view can never
    // be left with two live confirm paths.
    if (fpArtEditing) { saveFolderArtEdit().then(() => { if (nav.isActive('folderpick')) nav.back(); }).catch(() => {}); return; }
    onFolderPickOk().catch(() => {});
  });
  // The sources tab's "＋ תיקיה חדשה": the SAME picker, opened straight on its create
  // form. It resolves a folderId nothing is filed into — creating a folder up front is a
  // legitimate act (fill it later from any video's 📁 button).
  $('folder-new').addEventListener('click', async () => {
    const fid = await askFolderDestination({
      title: 'תיקיה חדשה', sub: 'אפשר להוסיף אליה סרטונים אחר כך מכפתור 📁 שליד כל סרטון'
    });
    if (fid && fid !== 'sheet') { await refreshFoldersList(); renderHome(); }
  });
  $('fp-cancel').addEventListener('click', () => { if (nav.isActive('folderpick')) nav.back(); });
  $('fp-art-search').addEventListener('click', () => { searchFolderArt().catch(() => {}); });
  $('fp-art-url-go').addEventListener('click', () => { addFolderArtFromUrl().catch(() => {}); });
  $('fp-art-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addFolderArtFromUrl().catch(() => {}); }
  });

  // v1.0.56 — the containment padlocks (home + folder header) and the duration dialog.
  $('lock-btn').addEventListener('click', () => { onLockTap('app').catch(() => {}); });
  $('folder-lock-btn').addEventListener('click', () => { onLockTap('folder').catch(() => {}); });
  $('sites-lock-btn').addEventListener('click', () => { onLockTap('sites').catch(() => {}); });
  $('ls-ok').addEventListener('click', () => { commitLockSetup().catch(() => {}); });
  $('ls-cancel').addEventListener('click', () => { if (nav.isActive('locksetup')) nav.back(); });
  $('ls-min').addEventListener('input', () => {
    if (!lockSetupCtx) return;
    lockSetupCtx.minutes = normalizeLockMinutes($('ls-min').value, lockSetupCtx.minutes);
    renderLockPresets();
    paintLockExplain();
  });

  // v1.0.38: both snapshot buttons moved to the SETTINGS tab, so they report into
  // #backup-msg — #add-msg belongs to the add form and is no longer on screen with them.
  $('export-btn').addEventListener('click', async () => {
    const msg = $('backup-msg');
    try {
      const { exportProfileSnapshot } = await import('./snapshot.js');
      const p = await getActiveProfile();
      const json = await exportProfileSnapshot(activeProfileId, p);
      await navigator.clipboard.writeText(json);
      msg.textContent = 'גיבוי מלא הועתק ללוח (שמרו אותו בקובץ)'; msg.className = 'form-msg ok';
    } catch { msg.textContent = 'הייצוא נכשל'; msg.className = 'form-msg err'; }
  });
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const msg = $('backup-msg');
    try {
      const { importProfileSnapshot } = await import('./snapshot.js');
      const res = await importProfileSnapshot(activeProfileId, await f.text());
      if (res.ok) {
        msg.textContent = `יובאו ${res.imported} סרטונים ✅${res.rejected ? ` (${res.rejected} נדחו — לינק לא נתמך)` : ''}`;
        msg.className = 'form-msg ok';
        await loadGiftStates();
        await refreshParentList();
        renderHome();
      } else { msg.textContent = 'קובץ לא תקין'; msg.className = 'form-msg err'; }
    } catch { msg.textContent = 'קובץ לא תקין'; msg.className = 'form-msg err'; }
    e.target.value = '';
  });

  /* v1.0.38 — the links file. Two import doors (file picker AND paste) because Android TV
     has no file picker at all and the WebView's is unverified on some devices; a fallback
     you can only find after a silent failure is not a fallback. */
  $('links-export').addEventListener('click', () => { linksExport().catch(() => linksMsg('הייצוא נכשל — נסו שוב', 'err')); });
  $('links-share-text').addEventListener('click', async () => {
    if (!lastLinksExportText) return;
    const { shareText } = await import('./platform.js');
    const how = await shareText(lastLinksExportText, 'רשימת הלינקים');
    linksMsg(how === 'clipboard' ? 'הרשימה הועתקה ללוח' : how === 'none' ? 'לא הצלחנו לשתף' : 'נפתחה חלונית שיתוף', how === 'none' ? 'err' : 'ok');
  });
  $('links-import').addEventListener('click', () => $('links-file').click());
  $('links-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = ''; // reset first: re-picking the same file must re-fire `change`
    if (!f) return;
    try { await linksImportFromText(await f.text()); }
    catch { linksMsg('לא הצלחנו לקרוא את הקובץ', 'err'); }
  });
  $('links-paste-go').addEventListener('click', async () => {
    const ta = $('links-paste');
    const text = ta.value;
    if (!text.trim()) { linksMsg('הדביקו את הרשימה בתיבה', 'err'); return; }
    try { await linksImportFromText(text); ta.value = ''; }
    catch { linksMsg('לא הצלחנו לקרוא את הרשימה', 'err'); }
  });

  // v1.0.38: the remote-copy / remote-connect controls are GONE with the sheet. There is
  // deliberately NO way to attach a sources sheet any more — the sunset migration deletes
  // the family's sheet files, so a re-attached URL would point at a file nothing maintains,
  // and it would undo the migration. The links file is the bulk door now.
  $('remote-refresh').addEventListener('click', doSyncAndRefresh);

  // v1.0.38: the mirror safety-valve handlers (#mirror-apply / #mirror-ignore) are gone
  // with the presence-mirror itself — no sheet parse can delete a library any more.
  // v1.0.28: the API-key form is gone from the UI; a stored 'yt:apiKey' override is
  // still honored by yt.getApiKey, so past users lose nothing.

  // v1.0.11: exit lock — applying is immediate (Android may show its own one-time
  // pinning confirmation); turning it off unpins right away (we're behind the PIN).
  $('autoplay-toggle').addEventListener('change', async (e) => {
    await putSetting(activeProfileId, 'autoplay', e.target.checked);
    maybeSchedulePush(); // per-profile and synced, like the exit lock
    const msg = $('settings-msg');
    msg.textContent = e.target.checked
      ? 'ניגון רציף הופעל ✅ — בסוף כל סרטון יתחיל הבא בתור'
      : 'ניגון רציף כובה — בסוף סרטון חוזרים לתיקייה';
    msg.className = 'form-msg ok';
  });
  // v1.0.32: resume playback — per-profile and synced; the position itself never leaves
  // the device (drive.serializeStateEntry never emits it).
  $('resume-toggle').addEventListener('change', async (e) => {
    await putSetting(activeProfileId, 'resume', e.target.checked);
    resumeEnabled = e.target.checked; // tileEl and the save loop read the cached flag
    maybeSchedulePush();
    const msg = $('settings-msg');
    msg.textContent = e.target.checked
      ? 'המשך צפייה הופעל ✅ — סרטון שנעצר ייפתח מאותה נקודה'
      : 'המשך צפייה כובה — כל סרטון מתחיל מההתחלה';
    msg.className = 'form-msg ok';
  });
  // v1.0.63 — background playback. Turning it OFF must take effect NOW, not at the next
  // video: a parent switching it off is answering "the tablet is making noise in my bag".
  $('bgplay-toggle').addEventListener('change', async (e) => {
    await putSetting(activeProfileId, 'bgPlay', e.target.checked);
    bgPlayEnabled = e.target.checked;
    if (!bgPlayEnabled) disarmBackgroundPlayback().catch(() => {});
    maybeSchedulePush();
    const msg = $('settings-msg');
    // v1.0.64 — ASK FOR THE NOTIFICATION PERMISSION HERE, at the one moment it has context:
    // the parent has just said they want playback to continue with the screen off, and the
    // notification is how they control it. v1.0.63 declared the permission and never
    // requested it, so on Android 13+ it was denied by default on every device — the audio
    // continued and the control never appeared.
    let notif = true;
    if (e.target.checked) notif = await ensureNotificationPermission().catch(() => true);
    msg.textContent = !e.target.checked
      ? 'ניגון ברקע כובה — סגירת המסך עוצרת את הניגון'
      : notif
        ? 'ניגון ברקע הופעל ✅ — קבצים שלכם ימשיכו להתנגן כשהמסך כבוי'
        : 'ניגון ברקע הופעל, אבל בלי הרשאת הודעות לא יופיעו כפתורי הניגון. אפשר לאשר בהגדרות המכשיר ← אפליקציות ← הסרטונים שלי ← התראות';
    msg.className = notif ? 'form-msg ok' : 'form-msg warn';
  });
  // v1.0.31: scheduled per-profile lock — two synced numbers. Clamp to sane bounds and
  // reflect the outcome. A change takes effect on the child's next armed cycle.
  const saveSchedLock = async () => {
    const after = Math.max(0, Math.min(600, parseInt($('lock-after-min').value, 10) || 0));
    const dur = Math.max(1, Math.min(600, parseInt($('lock-duration-min').value, 10) || SCHED_LOCK_DEFAULT_DURATION_MIN));
    $('lock-after-min').value = String(after);
    $('lock-duration-min').value = String(dur);
    await putSetting(activeProfileId, 'lockAfterMin', after);
    await putSetting(activeProfileId, 'lockDurationMin', dur);
    maybeSchedulePush();
    // v1.0.31: apply to the CURRENT session at once (the timer accumulates against a fixed
    // armedAt, so reducing the minutes shortens the ongoing countdown). Safe to run from the
    // parent screen: showLockedScreen refuses to reveal the lock while the parent is here.
    startLockTicker();
    await tickScheduledLock();
    await tickContainment(); // v1.0.56 — a lock that expired while backgrounded
    const msg = $('settings-msg');
    msg.textContent = after > 0
      ? `נעילה מתוזמנת: אחרי ${after} דקות, למשך ${dur} דקות ✅`
      : 'נעילה מתוזמנת כבויה';
    msg.className = 'form-msg ok';
  };
  $('lock-after-min').addEventListener('change', () => saveSchedLock().catch(() => {}));
  $('lock-duration-min').addEventListener('change', () => saveSchedLock().catch(() => {}));
  // v1.0.55: full-tablet lock during the break — per-profile, synced (tie → locked).
  // Takes effect the next time the break SCREEN shows; a break already on screen picks
  // it up on the next 5s tick's re-assert. Turning it OFF mid-break deliberately does
  // NOT unpin (containment errs strict — the v1.0.36 direction): the pin releases when
  // the break ends, or through the code-gated exit.
  $('lock-tablet-toggle').addEventListener('change', async (e) => {
    await putSetting(activeProfileId, 'lockTablet', e.target.checked);
    maybeSchedulePush();
    const msg = $('settings-msg');
    msg.textContent = e.target.checked
      ? 'בזמן ההפסקה כל הטאבלט יינעל 🔒 — יציאה או ביטול רק עם קוד הורים'
      : 'בזמן ההפסקה אפשר לצאת מהאפליקציה (כמו עד היום)';
    msg.className = 'form-msg ok';
  });
  // v1.0.34: idle screen-off minutes — per-profile, synced. A nonsense entry falls back
  // to the DEFAULT (never to a short window); an explicit 0 is a real answer: never off.
  $('screen-off-min').addEventListener('change', async () => {
    const raw = parseInt($('screen-off-min').value, 10);
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(600, raw)) : SCREEN_OFF_DEFAULT_MIN;
    $('screen-off-min').value = String(v);
    await putSetting(activeProfileId, 'screenOffAfterMin', v);
    maybeSchedulePush();
    const msg = $('settings-msg');
    msg.textContent = v > 0
      ? `כיבוי מסך: אחרי ${v} דקות בלי שימוש הסרטון יושהה והמסך יכבה לפי הגדרת המכשיר ✅`
      : 'כיבוי המסך בוטל — המסך יישאר דולק כל עוד סרטון מתנגן';
    msg.className = 'form-msg ok';
  });
  // v1.0.39 — the rolling window. Saving it deletes NOTHING; it only decides what the
  // מקורות tab will offer for review. A value below the minimum reads as OFF (see
  // plan.keepNewestPerChannel: a mistyped 1 must not propose emptying a folder), and the
  // message says which of the two happened so a silent "off" can never look like a save.
  $('keep-newest').addEventListener('change', async () => {
    const v = keepNewestPerChannel($('keep-newest').value);
    $('keep-newest').value = String(v);
    await putSetting(activeProfileId, 'keepNewest', v);
    maybeSchedulePush();
    const msg = $('settings-msg');
    msg.textContent = v > 0
      ? `נשמור את ${v} הסרטונים החדשים בכל ערוץ. כשערוץ יעבור את המגבלה תופיע התראה בלשונית "מקורות" — שום דבר לא יימחק בלי אישורכם ✅`
      : `המגבלה כבויה — שום סרטון לא יימחק. להפעלה הקלידו מספר מ-10 ומעלה (מומלץ ${KEEP_NEWEST_SUGGESTED})`;
    msg.className = 'form-msg ok';
    await refreshWindowBox();
  });
  // v1.0.57 — 🕒's size. Writing it must also REBUILD THE HOME: the folder appears,
  // disappears or changes count on the child's screen the moment this changes, and the
  // parent is standing right here expecting to see that.
  $('recent-limit').addEventListener('change', async () => {
    const v = recentLimitFor($('recent-limit').value);
    $('recent-limit').value = String(v);
    await putSetting(activeProfileId, 'recentLimit', v);
    recentLimit = v; // buildFolders and the stamp read the cached number
    maybeSchedulePush();
    const msg = $('settings-msg');
    msg.textContent = v > 0
      ? `התיקייה "נצפה לאחרונה" תציג את ${v} הסרטונים האחרונים שנצפו במכשיר הזה 🕒`
      : 'התיקייה "נצפה לאחרונה" כבויה ולא תופיע במסך הבית';
    msg.className = 'form-msg ok';
    await renderAfterRemoteChange();
  });
  $('exit-lock-toggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await putSetting(activeProfileId, 'exitLock', on);
    maybeSchedulePush(); // it travels now — the other device must hear about it
    const { lockTask, unlockTask, isNative } = await import('./platform.js');
    let note = on ? 'נעילת היציאה הופעלה ✅' : 'נעילת היציאה כובתה';
    if (on) {
      const locked = await lockTask();
      if (!locked && !isNative) note = 'נשמר ✅ (הנעילה עצמה פועלת רק באפליקציה המותקנת)';
      else if (!locked) note = 'נשמר, אך ההצמדה נכשלה — ננסה שוב בכניסה הבאה';
      else note = 'נעילת היציאה הופעלה ✅ — יציאה תדרוש קוד הורים';
    } else {
      await unlockTask();
    }
    await applyExitLockUi();
    $('settings-msg').textContent = note;
    $('settings-msg').className = 'form-msg ok';
  });

  $('share-approval-toggle').addEventListener('change', async (e) => {
    const src = (await db.getSources(activeProfileId));
    if (!src) return;
    await putSetting(activeProfileId, 'shareApproval', e.target.checked);
    maybeSchedulePush();
    $('settings-msg').textContent = 'נשמר ✅';
    $('settings-msg').className = 'form-msg ok';
  });

  $('drive-enable').addEventListener('click', async () => {
    const msg = $('drive-msg');
    msg.textContent = 'מתחברים…'; msg.className = 'form-msg';
    try {
      const { signIn, lastAuthError } = await import('./gauth.js');
      const { pullDrive, pushDrive } = await import('./drive.js');
      if (!(await signIn())) {
        msg.textContent = gauthErrorText(lastAuthError());
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = 'בודקים אם יש גיבוי קיים…';
      loading.show({ title: 'בודקים את הגיבוי בגוגל', step: 'מחפשים גיבוי קיים…' });
      const pulled = await pullDrive(activeProfileId);
      loading.setStep('מגבים את המצב הנוכחי…');
      await pushDrive(profiles);
      loading.setStep('מרעננים את הרשימות…');
      await loadGiftStates();
      await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]);
      renderHome();
      await refreshDriveStatus();
      msg.textContent = pulled.ok && !pulled.empty ? 'גיבוי קיים מוזג למכשיר ✅' : 'הגיבוי הופעל ✅';
      msg.className = 'form-msg ok';
    } catch {
      msg.textContent = 'שגיאה בהפעלת הגיבוי';
      msg.className = 'form-msg err';
    } finally {
      await loading.hide();
    }
  });
  // v1.0.32: the manual "גיבוי עכשיו" button is gone (user request) — backup is
  // automatic: a push is scheduled on every mutation and a pull runs on entry/resume.

  // v1.0.5: share a download link for the latest release (OS share sheet; the
  // browser preview falls back to Web Share / clipboard).
  $('share-app').addEventListener('click', async () => {
    const msg = $('share-msg');
    msg.textContent = 'מכינים את הלינק…'; msg.className = 'form-msg';
    try {
      const upd = await import('./update.js');
      const text = upd.buildAppShareMessage(await upd.latestKnownRelease());
      const { shareText } = await import('./platform.js');
      const how = await shareText(text, 'הסרטונים שלי — אפליקציה לילדים');
      msg.textContent =
        how === 'native' || how === 'web' ? 'חלון השיתוף נפתח 📤'
        : how === 'clipboard' ? 'ההודעה עם הלינק הועתקה ללוח — הדביקו איפה שנוח'
        : 'השיתוף לא זמין במכשיר הזה';
      msg.className = how === 'none' ? 'form-msg err' : 'form-msg ok';
    } catch {
      msg.textContent = 'השיתוף נכשל — נסו שוב';
      msg.className = 'form-msg err';
    }
  });

  $('update-check').addEventListener('click', () => runUpdateCheck({ manual: true }));
  $('update-install').addEventListener('click', async () => {
    const msg = $('update-msg');
    const upd = await import('./update.js');
    const latest = JSON.parse((await import('./platform.js').then((p) => p.prefGet('update.latest'))) || 'null');
    if (!latest) return;
    // v1.0.13: what's-new first; the parent may still back out here
    if (!(await showWhatsNew(latest.whatsNew, { installMode: true }))) { if (!nav.back()) goGallery(); return; }
    if (nav.isActive('whatsnew') && !nav.back()) goGallery();
    if (!(await upd.canInstall())) {
      msg.textContent = 'נדרש אישור חד-פעמי: "התקנת אפליקציות לא ידועות" — נפתח את ההגדרה';
      msg.className = 'form-msg';
      await upd.openInstallSettings(); // advisory only — we still attempt the install after
    }
    msg.textContent = 'מוריד…'; msg.className = 'form-msg';
    const r = await upd.downloadAndInstall(latest, {
      onProgress: (done, total) => {
        if (total) msg.textContent = `מוריד… ${Math.round((done / total) * 100)}%`;
      }
    });
    if (r.ok) { msg.textContent = 'נפתח מסך ההתקנה של אנדרואיד…'; msg.className = 'form-msg ok'; }
    else {
      msg.textContent = r.error === 'truncated' ? 'ההורדה לא הושלמה — נסו שוב'
        : r.error === 'installed-app-only' ? 'עדכון זמין באפליקציה המותקנת בלבד'
        : r.error === 'no-installer' ? 'לא נמצא מתקין חבילות במכשיר'
        : 'ההתקנה נכשלה — נסו שוב';
      msg.className = 'form-msg err';
    }
  });

  // v1.0.8: About tab — contact the developer (opens the mail app; the address is
  // visible in the hint if no mail app handles mailto) + tour replay.
  $('contact-dev').addEventListener('click', async () => {
    // v1.0.15: addresses come from links.js (one config file for every external link)
    const { LINKS } = await import('./links.js');
    const { email, cc, subject } = LINKS.contact;
    $('contact-msg').textContent = email; // visible fallback if no mail app handles mailto
    $('contact-msg').className = 'form-msg';
    try {
      window.location.href = `mailto:${email}?cc=${encodeURIComponent(cc || '')}&subject=${encodeURIComponent(subject || '')}`;
    } catch {}
  });
  // v1.0.19: the landing page — what the app is, the install walkthrough, and the
  // link a parent forwards to another parent. Same openExternal path as the policy
  // buttons: the WebView blocks external navigation by design, so it must leave
  // the app; if that fails, show the address so it can still be copied by hand.
  $('site-btn').addEventListener('click', async () => {
    const { LINKS } = await import('./links.js');
    const { openExternal } = await import('./platform.js');
    const ok = await openExternal(LINKS.site.home);
    if (!ok) {
      $('contact-msg').textContent = LINKS.site.home;
      $('contact-msg').className = 'form-msg';
    }
  });
  // v1.0.32: the privacy/terms buttons are gone (user request) — the policies live on
  // the site as nav tabs, one tap behind site-btn; OAuth verification keeps pointing at
  // the same URLs (LINKS.site.privacy/terms stay in links.js as the record of them).
  $('tour-replay').addEventListener('click', () => { startTour({ replay: true }); });
  $('guide-add').addEventListener('click', () => { startAddGuide(); });
  // v1.0.20: the same guide from the child's EMPTY home — the one moment a parent is
  // guaranteed to be looking at the app and stuck. Reading it needs no PIN (it adds
  // nothing); back returns to the empty home because startAddGuide uses nav.go.
  $('empty-guide').addEventListener('click', () => { startAddGuide(); });
  // v1.0.32: the "מה חדש בגירסה" button is gone (user request) — the notes show in the
  // one place that matters: the update prompt, before every install (showWhatsNew there).
  // v1.0.14: voluntary support — donate + the two free ways to help
  $('donate-btn').addEventListener('click', () => { openDonateFlow().catch(() => {}); });
  $('nudge-donate').addEventListener('click', async () => {
    await prefSet('donate.nudgeDismissed', '1'); // shown once, whatever the answer
    $('donate-nudge').classList.add('hidden');
    openDonateFlow().catch(() => {});
  });
  $('nudge-dismiss').addEventListener('click', async () => {
    await prefSet('donate.nudgeDismissed', '1');
    $('donate-nudge').classList.add('hidden');
  });
  $('help-share').addEventListener('click', () => { $('share-app').click(); });

  $('wn-ok').addEventListener('click', () => { closeWhatsNew(true); if (nav.isActive('whatsnew')) nav.back(); });
  $('wn-cancel').addEventListener('click', () => { closeWhatsNew(false); if (nav.isActive('whatsnew')) nav.back(); });

  $('parent-exit').addEventListener('click', goGallery);
  // v1.0.58 — the manual cleaner now MEASURES what it freed, and it counts the FILES ON
  // DISK rather than only the records that point at them. The old version reported the
  // record count and called everything "קבצי וידאו" — but audio has been cacheable since
  // v1.0.56, and a file left behind by a deletion has no record at all, so a parent could
  // free 300 MB and be told "נמחקו 0". The listing is taken BEFORE the wipe: afterwards
  // there is nothing left to measure.
  $('clear-cache').addEventListener('click', async () => {
    let before = { files: 0, bytes: 0 };
    try { const { cacheUsage } = await import('./media.js'); before = await cacheUsage(); } catch {}
    const cleared = await clearCache();
    const files = Math.max(before.files, cleared);
    await alertKid({
      emoji: '🧹',
      title: files > 0 ? `נוקו ${files} קבצים` : 'אין מה לנקות',
      text: files > 0
        ? `פינינו ${formatBytes(before.bytes)} מזיכרון המכשיר. הסרטונים והשירים עצמם נשארו ברשימה — הם פשוט יורדו שוב בעת הצורך.`
        : 'קובץ יורד למכשיר רק כשההזרמה שלו נכשלת, ולכן ברוב המקרים אין מה לנקות. מה שכן יורד נמחק גם לבד אחרי חודש בלי שימוש.',
      ok: 'סבבה'
    });
  });
  $('reset-pin').addEventListener('click', async () => {
    const yes = await confirmKid({
      emoji: '🔓', title: 'לאפס את קוד ההורים?',
      text: 'תתבקשו להגדיר קוד חדש בכניסה הבאה למסך ההורים.',
      ok: 'איפוס', cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    await clearPin();
    goGallery();
  });
}

/* ---------------- Init ---------------- */
async function init() {
  // v1.0.31: the cold-start splash. init() runs once per process, so this fires only on a
  // real launch, never on resume. The app boots behind it; ~1.3s later it fades away.
  const splash = document.getElementById('splash-overlay');
  if (splash) setTimeout(() => splash.classList.add('splash-hide'), 1300);
  mountModal();
  registerViews();
  wire();
  onBackButton(nav.handleBack);

  /* v1.0.45 — the site viewer's events. Two of these close real holes:
     - `webActivity`: a tap inside a NATIVE WebView never reaches this window, so the
       capture listeners that feed `idleLastInputAt` are blind while a site is open and
       the idle timer would fire on a child who is actively browsing.
     - `webClosed`: the flag gates tickIdleSleep; leaving it stuck true would make the
       idle timer count forever against a viewer that is gone. */
  onSiteEvent('webActivity', () => { idleLastInputAt = Date.now(); });
  // v1.0.67 — the padlock in the viewer's bar asks JS to run the code screen. The viewer is
  // a NATIVE overlay sitting ON TOP of this WebView, so the code screen is invisible beneath
  // it: it must be closed first (by the app, which a lock never blocks) and reopened if the
  // parent backs out.
  onSiteEvent('webLockRequest', () => { onSiteLockTap().catch(() => {}); });
  onSiteEvent('webClosed', () => { siteViewerOpen = false; });
  onSiteEvent('webBlocked', (e) => {
    const url = e && e.url;
    if (!url) return;
    siteBlockedRecent = [{ url, at: Date.now() }, ...siteBlockedRecent.filter((b) => b.url !== url)].slice(0, 20);
  });
  onSiteEvent('webAddRequest', (e) => { if (e && e.url) onSiteAddRequest(e.url).catch(() => {}); });

  // v1.0.9: Android TV — 10-foot layout + D-pad focus mode. Same APK as the tablet;
  // browser preview can force it with localStorage['tv']='1'.
  try {
    const { isTv } = await import('./platform.js');
    if (await isTv()) {
      document.documentElement.classList.add('tv');
      (await import('./ui/dpad.js')).initDpad();
    }
  } catch {}

  // v1.0.11: re-arm the exit lock on every launch (pinning does not survive restarts).
  // v1.0.25: the lock is per-profile now, and this runs BEFORE a profile is picked — so
  // it arms from the LAST active one. Without that there is an unlocked window between
  // launch and the profile tap, which is precisely when an unattended child is holding it.
  try {
    if (await exitLockOn(await prefGet('activeProfile'))) {
      const { lockTask } = await import('./platform.js');
      lockTask().catch(() => {});
    }
    await applyExitLockUi();
  } catch {}

  // v1.0.32 — the physical screen-off button (and HOME / the app switcher): stop the
  // sound, bank the spot. Android does not pause the WebView, so until this listener a
  // playing video kept its soundtrack running behind a dark screen — with the kiosk lock
  // ON and OFF alike. The order is load-bearing: save FIRST (it reads the live playhead),
  // THEN pause. The player stays mounted at its position, so when the screen comes back
  // the child finds the video waiting, paused, exactly where it stopped (the HUD's
  // heartbeat notices the pause and pins itself). saveWatchPosition is a no-op while the
  // resume setting is off — the in-session position lives in the paused player itself.
  onAppPause(() => {
    // v1.0.57: read the playhead ONCE, BEFORE pausing — `saveWatchPosition` needs the live
    // clock, and the call watcher needs to know whether the video was actually PLAYING when
    // the app was taken away. After `pauseCurrent()` that answer is always "no", and arming
    // on it would resume a video the child had deliberately paused before the call.
    const st = playbackState();
    saveWatchPosition(currentWatch, st);
    // v1.0.63 — KEEP PLAYING (user request, opt-in per profile). Decided from CACHED state,
    // never an await: this handler reads the live playhead and must stay synchronous, and by
    // the time a bridge call returned the video would already be paused. The position is
    // banked above either way, so a process killed in the background loses nothing.
    const bg = backgroundPlayDecision({ enabled: bgPlayEnabled && bgPlayLive, playing: !!(st && st.playing), item: currentWatch });
    if (!bg.play) pauseCurrent();
    // Was it a CALL that took the app away? Asked HERE, while the reason is still current:
    // by the time the child comes back the mode has returned to normal and nothing would
    // distinguish a call from the power button. Not awaited — the pause must not wait on a
    // bridge call.
    // ⚠️ ARMED EVEN WHEN THE VIDEO KEEPS PLAYING (v1.0.63). A call takes audio focus and the
    // WebView pauses its own media regardless of our service, so an early return above this
    // line would leave a background-playing video stopped for good once the call ended.
    if (st && st.playing) checkCallResume().catch(() => {});
  });

  // v1.0.63 — ⏮/⏯/⏭ on the notification. Registered once, at boot, like every other native
  // listener: a command retained natively while the WebView was frozen is delivered as soon
  // as it thaws, so nothing is lost with the screen off.
  onPlaybackCommand((action) => { handlePlaybackCommand(action).catch(() => {}); });

  // v1.0.34 idle screen-off: every touch and every remote key is "someone is here".
  // CAPTURE phase, so a handler that stops propagation cannot hide input from the
  // timer — and so the prompt-answering tap is consumed before the HUD/TV handlers
  // can act on it (onUserInput stops propagation only while the prompt is up).
  window.addEventListener('pointerdown', onUserInput, true);
  window.addEventListener('keydown', onUserInput, true);
  // the answering tap's TAIL: the shield acts on the end of a tap, so the up/click of
  // the gesture that answered the prompt must be eaten too, or "I'm here" pauses the video
  window.addEventListener('pointerup', swallowIdleGestureTail, true);
  window.addEventListener('click', swallowIdleGestureTail, true);
  window.addEventListener('pointercancel', swallowIdleGestureTail, true);

  onAppResume(async () => {
    // v1.0.31: a scheduled lock may have matured while backgrounded — check before anything.
    await tickScheduledLock().catch(() => {});
    // v1.0.57 — the call is over and the child is back: carry on with the video. AFTER the
    // scheduled-lock check on purpose, and that ORDER is the invariant: a break that matured
    // during the call resets nav to the lock screen, and planCallResume then answers 'disarm'
    // because the watch view is gone. Resuming first would leave a video playing behind the
    // lock. (The armed poll covers the call that never backgrounded the app at all.)
    checkCallResume().catch(() => {});
    // v1.0.36: re-arm the exit lock. The update flow unpins natively (installApk), and a
    // CANCELLED install resumes right back here — still unpinned, on a locked profile.
    // Safe on every resume: applyExitLock never unpins, and the native lockTask is a
    // no-op when already pinned.
    applyExitLock().catch(() => {});
    // v1.0.22 — pull the family's shared state FIRST: the parent very often approves on
    // the phone and then hands the tablet to the child, and resume does not re-fire the
    // gallery's onEnter. Same guards as the resync below (never mid-video, home only),
    // and serialized before it so the two never write the same records at once.
    // v1.0.49: the PULL also runs when the parent screen is up. It used to share the
    // resync's "home only" gate, but the parent screen is where a parent resumes TO in
    // order to check that what they added on the phone arrived — and nothing else on that
    // screen pulls, so they were stuck pressing a button that could not help them.
    // Still never mid-video (the watch view is neither).
    if (activeProfileId && (isGalleryActive() || nav.isActive('parent'))) {
      try {
        if (await maybePullDrive()) {
          await loadGiftStates();
          await renderAfterRemoteChange();
        }
      } catch {}
    }
    // resync on foreground — but never while a video plays, and only from the home
    if (activeProfileId && isGalleryActive() && await shouldSync(activeProfileId)) {
      syncLibrary(activeProfileId).then(async () => {
        await loadGiftStates();
        if (isGalleryActive()) renderHome();
      }).catch(() => {});
    }
    // v1.0.21: also re-check for a release here. Coming back from the background does
    // NOT re-fire the gallery's onEnter, so a device left running for days never looked.
    if (activeProfileId && isGalleryActive()) {
      import('./update.js')
        .then((u) => u.checkForUpdate({ silent: true }))
        .then((r) => maybePromptUpdate(r))
        .catch(() => {});
    }
  });

  // v1.0.14: stamp the first launch once — the gentle support reminder waits a month
  try { if (!(await prefGet('install.firstSeenAt'))) await prefSet('install.firstSeenAt', String(Date.now())); } catch {}

  await migrateLegacyIfNeeded();
  // Preferences → IndexedDB (idempotent, resumable, non-destructive).
  try { await runMigrationIfNeeded(); } catch (e) { console.warn('idb migration failed', e); }
  // v1.0.8: one-shot data-structure migrations after an app update (dataver.js).
  try { const { runDataMigrations } = await import('./dataver.js'); await runDataMigrations(); } catch {}

  // F12b + v1.0.7: videos AND channels shared from the YouTube app go through the
  // interactive PIN+confirm flow (listener first, then drain — see share.js).
  initShareTarget({
    profileIdGetter: () => activeProfileId,
    interactiveHandler: handleShareInteractive,
    // v1.0.61 — a share of content the parent removed before now ASKS instead of being
    // refused (user request). share.js calls this only AFTER its PIN+confirm, so the
    // question — and the un-deny behind it — can never be reached by the child.
    deniedHandler: (key, scope) => offerDeniedReAdd(scope, key, 'share'),

    // v1.0.26: EVERY outcome is reported. Sharing used to be silent on all of its routes —
    // added, parked, duplicate, previously deleted, dropped — so "sharing does not work"
    // could not be told apart from "it worked and you are looking at the wrong screen".
    resultHandler: (reason) => {
      const { kind, text } = shareOutcome(reason);
      toast(text, kind);
    },
    profileChooser: chooseShareProfile, // v1.0.23 — asked only when it changes the outcome
    onShareAdded: async ({ pending, channelAdded, channelFailed, title, isPlaylist }) => {
      if (channelFailed) {
        await alertKid({ emoji: '😕', title: 'לא הצלחנו לזהות את הערוץ', text: 'אפשר לנסות דרך מסך ההורים ← הוספה.', ok: 'בסדר' });
        return;
      }
      if (channelAdded) {
        // v1.0.25: the SAME import-then-ask path the parent screen uses. This used to be a
        // bare "הערוץ נוסף! ✅ … חדשים ימתינו לאישור" over a catalogue that was still
        // downloading — the parent was told the outcome before there was one, and the
        // backlog then sat in ממתינים unannounced.
        const { synced, approved, count, empty, picked } = await importChannelAndAsk(channelAdded);
        // share.js has passed `isPlaylist` since v1.0.26 — this handler ignored it, so a
        // shared playlist (once the confirm above let one through at all) announced
        // itself as "הערוץ נוסף". `picked` rides to channelAddOutcome so a manual pick
        // reports what was chosen, not a queue the parent just emptied (v1.0.27).
        const addedWhat = isPlaylist ? 'רשימת ההשמעה נוספה' : 'הערוץ נוסף';
        await alertKid(synced
          ? { emoji: isPlaylist ? '🎵' : '📺', title: `${addedWhat}! ✅`, text: `${title || (isPlaylist ? 'הרשימה' : 'הערוץ')} — ${channelAddOutcome(approved, count, empty, picked)}`, ok: 'מעולה' }
          : { emoji: '😕', title: `${addedWhat}, אבל המשיכה נכשלה`, text: 'אפשר לנסות שוב ממסך ההורים ← מקורות ← רענון נתונים.', ok: 'בסדר' });
        if (nav.isActive('gallery')) renderHome();
        return; // importChannelAndAsk already re-rendered and scheduled the push
      }
      if (nav.isActive('gallery')) renderHome();
      // A video shared from YouTube lands with no srcChannelId and no gift rank, so it
      // showed up in the loose list and was not a 🎁 until the parent happened to press
      // "רענון נתונים" (v1.0.21 field bug). A PENDING video waits for approval, which
      // syncs then.
      if (!pending) refreshAfterAdd();
    }
  });
  await loadActiveId();
  profiles = await getProfiles();

  // Boot order (v1.0.8): onboarding tour (once per install) → Google-connect offer
  // (once) → profiles. The tour never blocks a returning user.
  const bootContinue = async () => {
    if (await shouldOfferConnect()) nav.reset('connect');
    else startAtProfiles();
  };
  if (!(await prefGet('tour.done'))) startTour({ onDone: () => { bootContinue().catch(() => startAtProfiles()); } });
  else await bootContinue();

  // F14 launch check — un-awaited, throttled, all paths caught. NEVER blocks startup.
  // v1.0.4: when an update exists, ASK whether to install (maybePromptUpdate).
  setTimeout(() => {
    import('./update.js')
      .then((u) => u.cleanupPendingApk().then(() => u.checkForUpdate({ silent: true })))
      .then((r) => maybePromptUpdate(r))
      .catch(() => {});
  }, 4000);
}

init();
