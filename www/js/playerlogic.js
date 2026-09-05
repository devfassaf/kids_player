// playerlogic.js — the PURE decisions behind player.js (v1.0.22).
//
// player.js is 400 lines of DOM, timers and two vendor adapters, so it had no tests at
// all while carrying the longest hard-invariant block in CLAUDE.md. The arithmetic and the
// exit decision are the parts that misbehave on a real device, and they are pure — so they
// live here and are node-tested. Exactly the same split as spatial.js ← ui/dpad.js.
//
// Imports NOTHING but config.js (which imports nothing), so this sits safely in the
// `store/classify/csv/util` band and can be imported by player.js and ui/dpad.js alike.
import { SEEK_STEP, AUTOPLAY_MAX_FAILURES, TAP_SLOP_PX,
  RESUME_REWIND_SEC, RESUME_MIN_POS_SEC, RESUME_TAIL_SEC,
  CALL_RESUME_MAX_MS } from './config.js';

/**
 * Clamp a seek target into the video.
 *
 * WHY: every forward seek was `getTime() + SEEK_STEP` with no upper bound. Seeking past
 * the end makes YouTube fire ENDED, which runs `finish()` → `onExit` → `leaveWatch()`, so
 * a child pressing ⏩ near the end was EJECTED from the video instead of arriving at its
 * last seconds. `endGuard` stops just short so the player does not treat the seek itself
 * as "finished".
 *
 * A non-finite or unknown duration (live stream, metadata not in yet) means "no upper
 * bound known" — clamp at 0 below and leave the target alone above.
 */
export function clampSeek(target, duration, { endGuard = 0.5 } = {}) {
  const t = Number(target);
  if (!Number.isFinite(t)) return 0;
  const lo = Math.max(0, t);
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return lo;
  return Math.min(lo, Math.max(0, d - endGuard));
}

/**
 * v1.0.52 — PURE: is a press-and-release still a TAP, or did the finger travel?
 *
 * WHY: the shield acts on `pointerup` and never asked. With `touch-action: pan-y`
 * (the landscape-scroll fix) a VERTICAL swipe the page claims ends in pointercancel
 * and can no longer look like a tap — but a horizontal swipe, and every swipe while
 * FULLSCREEN (nothing to scroll, so the browser never takes the gesture), still ends
 * in a pointerup on the shield, and a release in the center half PAUSED the video.
 *
 * Missing coordinates (an old WebView handing NaN/undefined) count as "did not move":
 * refusing the tap would make every tap dead on that device, and a wrongly accepted
 * tap is the pre-v1.0.52 status quo — the recoverable direction.
 */
export function isTapGesture(downX, downY, upX, upY, { slop = TAP_SLOP_PX } = {}) {
  const dx = Number(upX) - Number(downX);
  const dy = Number(upY) - Number(downY);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return true;
  return (dx * dx + dy * dy) <= slop * slop;
}

/**
 * v1.0.54 — PURE: what should the device orientation be after a fullscreen change?
 *
 * 'landscape' entering fullscreen, 'auto' (the system's own rule) leaving it, and null —
 * touch nothing — on TV: a television has no sensor and is landscape by construction, so
 * even a harmless request is a bridge call with no meaning there. The user's decision
 * (2026-08-25): every handheld device, phone and tablet alike — all content is 16:9
 * long-form (Shorts are excluded by design), so landscape is always the video's shape.
 *
 * The 'auto' branch deliberately does NOT depend on which view is active: leaveWatch (a
 * video that ENDED) exits fullscreen and then navigates away, and a restore gated on
 * "still watching" would leave the whole app stuck sideways after every finished video.
 */
export function fullscreenOrientation({ fullscreen = false, tv = false } = {}) {
  if (tv) return null;
  return fullscreen ? 'landscape' : 'auto';
}

/**
 * v1.0.53 — PURE: which channel line does the now-playing overlay show, if any?
 *
 * The user's rule: the channel appears only "when the video belongs to a channel".
 * Resolution order for the NAME — the family's own folder title first (a subscribed
 * channel, or a 🎞️ virtual group of singles; both carry `channelId` on the folder),
 * then the record's enrichment (`srcChannelTitle`). No name ⇒ no line at all: an id
 * alone could only render an unlabeled logo, which tells the child nothing.
 *
 * A playlist video keeps its OWNER in `channelId` (the v1.0.26 rule), so the line names
 * the actual creator — and the `pl:` folder can never match here because its folder
 * `channelId` slot holds the playlist id, and only `ch:`/`grp:` folders are consulted.
 * `id` may be null while a name exists (legacy enrichment): the logo just stays hidden.
 */
export function nowPlayingChannel(rec, folders) {
  if (!rec || typeof rec !== 'object') return null;
  const fid = typeof rec.folderId === 'string' ? rec.folderId : '';
  const derived = (fid.startsWith('ch:') || fid.startsWith('grp:'))
    ? fid.slice(fid.indexOf(':') + 1) : null;
  const id = rec.channelId || rec.srcChannelId || derived || null;
  const list = Array.isArray(folders) ? folders : [];
  const folder = id ? list.find((f) => f && f.channelId === id && typeof f.id === 'string'
    && (f.id.startsWith('ch:') || f.id.startsWith('grp:'))) : null;
  const name = (folder && folder.title) || rec.srcChannelTitle || null;
  if (!name) return null;
  return { id, name, logoUrl: (folder && folder.logoUrl) || null };
}

/** Fraction along the seek bar for a pointer x. Zero-width rect ⇒ 0, never NaN. */
export function fractionFromX(clientX, rectLeft, rectWidth) {
  const w = Number(rectWidth);
  if (!Number.isFinite(w) || w <= 0) return 0;
  const f = (Number(clientX) - Number(rectLeft)) / w;
  if (!Number.isFinite(f)) return 0;
  return Math.max(0, Math.min(1, f));
}

/**
 * v1.0.32 — PURE: seconds → "m:ss" / "h:mm:ss" for the HUD time labels.
 *
 * YouTube-style: elapsed on one side of the bar, total on the other. Digits are floored
 * (58.9s reads 0:58 — a countdown that briefly shows a second that has not finished yet
 * reads as a stutter). Anything unusable — NaN, negative, a live stream's Infinity —
 * renders as the neutral "0:00" rather than leaking "NaN:NaN" onto the child's screen.
 */
export function formatTime(sec) {
  const s = Math.floor(Number(sec));
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** Progress percentage for the HUD fill. Unknown duration ⇒ 0. */
export function progressPct(time, duration) {
  const d = Number(duration);
  const t = Number(time);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(100, (t / d) * 100));
}

/**
 * Should the near-end poll end this video and return the child to where they came from?
 *
 * The point is to leave BEFORE YouTube's end-screen recommendations — the app exists to
 * keep the child away from those. The hard part is the YouTube→YouTube reuse path: right
 * after `loadVideoById`, `getDuration()` briefly still reports the PREVIOUS video while
 * `getCurrentTime()` is ~0, so a naive tail check fires instantly and bounces the child
 * out of the video they just chose.
 *
 * Two independent guards, because the wall clock alone is a bet on network latency:
 *  - `now - swapAt > graceMs` — a swap that just happened is never trusted;
 *  - `reportedId === expectedId` — when the player can tell us WHICH video it is playing,
 *    that is authoritative and a slow swap can no longer be mistaken for a tail. Unknown
 *    ids fall back to the clock rather than blocking playback forever.
 */
export function shouldFinishNearEnd({
  duration, current, now, swapAt = 0, expectedId = null, reportedId = null,
  graceMs = 1200, tailSec = 1.5, minProgressSec = 0.5
} = {}) {
  const d = Number(duration);
  const c = Number(current);
  if (!Number.isFinite(d) || d <= 0) return false;   // live stream / metadata not ready
  if (!Number.isFinite(c) || c <= minProgressSec) return false; // no real progress yet
  if (d - c > tailSec) return false;                 // not in the tail
  if (expectedId && reportedId && expectedId !== reportedId) return false; // stale swap
  return Number(now) - Number(swapAt || 0) > graceMs;
}

/**
 * v1.0.25 — PURE: a video just ended. Play the next one, retry this one, or stop?
 *
 * Continuous play is OFF by default and set per child, because "one more video" is a
 * parenting decision and not a device preference.
 *
 * THE 🎁 RULE. The gift folder is never chained, whatever the setting says. Opening a
 * gift is a one-way, permanent act (`unwrappedAt` is min-merged forever, across every
 * device), so an unattended chain would unwrap the child's entire queue of new videos in
 * one sitting with no way to put them back. The parent's decision, 2026-08-02.
 *
 * FAILURE HANDLING. `finish()` fires for a broken video too, so a naive chain skips
 * through dead content invisibly. One retry of the same video absorbs a blip; after that
 * we move on; and a RUN of failures ends the chain rather than flipping through black
 * screens. `failures` counts CONSECUTIVE failures — a video that plays resets it.
 *
 * @param enabled        the profile's continuous-play setting
 * @param folderId       the folder the under-player grid is paging ('new' is 🎁)
 * @param reason         'ended' | 'error', straight from player.js
 * @param failures       consecutive failures so far in this chain
 * @param retriedCurrent has this video already been retried once?
 * @param hasNext        is there another video after this one in the folder?
 * @param nextIsGift     is the next video still a WRAPPED gift?
 */
/**
 * v1.0.63 — PURE: may THIS video keep playing while the app is in the background?
 * -> { play: boolean, why: 'off'|'not-playing'|'youtube'|'no-item'|'ok' }
 *
 * ⚠️ **ANDROID CANNOT TELL THE POWER BUTTON FROM `HOME`.** `appStateChange` carries no
 * reason, so this setting really means "keep playing when the app goes to the background",
 * and a child who taps HOME will also keep hearing it. That cannot be fixed — it can only
 * be said plainly, which the setting's own hint does.
 *
 * YOUTUBE IS EXCLUDED BY DESIGN (the user's decision): the IFrame player is a WebView that
 * Android may throttle or evict the moment the app is not foreground, so "background
 * YouTube" would be a promise the app cannot keep — and it is not a use YouTube's terms
 * invite. Only the family's OWN audio/video files continue.
 *
 * `playing:false` answers 'not-playing' rather than 'off': a video the child had already
 * paused before the screen went dark must stay paused, or the app starts making noise in a
 * pocket for a video nobody was watching (the v1.0.57 call-resume rule, same reasoning).
 */
/**
 * v1.0.73 — PURE: should opening this item go straight to FULLSCREEN? (user request: an
 * audio file should not.)
 *
 * Fullscreen exists so a video fills the screen. An audio file has no picture of its own —
 * it plays behind the CSS music scene (v1.0.56) — so filling the screen with that scene
 * hides the seek bar, the ⭐ and the way back for no gain at all.
 *
 * ⚠️ ONLY A KNOWN 'audio' OPTS OUT. `media` is null for a record nothing has enriched yet
 * (a share, a links-file row, a peer on an older app), and it is CORRECTED at
 * `loadedmetadata` from `videoWidth` — long after the tap. Treating "unknown" as audio
 * would open real videos windowed; treating it as video keeps exactly today's behaviour,
 * which is the safe direction for a guess. A video that turns out to be audio simply keeps
 * the fullscreen it was given — the alternative, dropping out of fullscreen a second later,
 * is a jump the child did not ask for.
 */
export function opensFullscreen(item) {
  if (!item) return false;
  return !(item.type === 'file' && item.media === 'audio');
}

export function backgroundPlayDecision({ enabled = false, playing = false, item = null } = {}) {
  if (!enabled) return { play: false, why: 'off' };
  if (!item) return { play: false, why: 'no-item' };
  if (item.type !== 'file') return { play: false, why: 'youtube' };
  if (!playing) return { play: false, why: 'not-playing' };
  return { play: true, why: 'ok' };
}

/**
 * v1.0.76 — PURE: may the HOME button shrink this session into a Picture-in-Picture
 * window? The answer is PUSHED to the native side ahead of time (`setPipState`) because
 * `onUserLeaveHint` is synchronous — the same cached-decision shape as `bgPlayEnabled`.
 *
 * Unlike backgroundPlayDecision, YOUTUBE IS INCLUDED (user decision 2026-09-06): in PiP
 * the activity stays VISIBLE, so the WebView is never throttled or evicted — the reason
 * YouTube is excluded from background playback does not apply here.
 *
 * ⚠️ EVERY LOCK REFUSES PiP, and that is the safety half of this feature: a PiP window
 * floats over the LAUNCHER, i.e. pressing HOME with PiP armed walks the child out of the
 * app with the video in tow. Under the kiosk (exitLock), any containment lock, or a
 * scheduled break, that is exactly the door those locks exist to close. (Android itself
 * also refuses PiP in lock-task mode — the native side re-checks `inLockTask` — but the
 * kiosk flag must refuse here too: the OS pin can fail while the setting stands.)
 *
 * `playing` is required, like YouTube's own app: HOME on a paused video backgrounds
 * normally — a frozen frame floating over the launcher is clutter, not playback.
 */
export function pipEligibility({
  enabled = false, supported = false, tv = false, watching = false,
  playing = false, item = null, kiosk = false, contained = false
} = {}) {
  if (!supported || tv) return { eligible: false, why: 'unsupported' };
  if (!enabled) return { eligible: false, why: 'off' };
  if (kiosk || contained) return { eligible: false, why: 'locked' };
  if (!watching || !item) return { eligible: false, why: 'no-video' };
  if (!playing) return { eligible: false, why: 'paused' };
  return { eligible: true, why: 'ok' };
}

/**
 * v1.0.76 — PURE: which video does the PiP window's ⏮/⏭ land on?
 *
 * `keys` is the FROZEN grid order (built once from pageAnyFolder, THE pagination entry
 * point — the v1.0.63 precedent, so the window can never disagree with the grid under the
 * player). A WRAPPED GIFT IS SKIPPED, NEVER OPENED: its whole ritual is that the first TAP
 * unwraps it and deliberately does not play (v1.0.25), so starting it from a floating
 * window would consume the video while leaving the tile wrapped forever. NO WRAP-AROUND —
 * a chain that loops would play all night; past either end the answer is null and the
 * button does nothing.
 */
export function pipSkipTarget({ keys = [], currentKey = null, dir = 1, isGift = () => false } = {}) {
  const list = Array.isArray(keys) ? keys : [];
  const i = list.indexOf(currentKey);
  if (i < 0) return null;
  const step = dir < 0 ? -1 : 1;
  for (let j = i + step; j >= 0 && j < list.length; j += step) {
    let gift = false;
    try { gift = !!isGift(list[j]); } catch { gift = true; } // unknown ⇒ skip, never open
    if (!gift) return list[j];
  }
  return null;
}


export function planAutoplay({
  enabled = false, folderId = null, reason = 'ended',
  failures = 0, retriedCurrent = false, hasNext = true, nextIsGift = false
} = {}) {
  if (!enabled) return { action: 'stop', reason: 'disabled' };
  if (folderId === 'new') return { action: 'stop', reason: 'gift' };
  // A wrapped gift can sit in ANY folder, not just 🎁 — the gift state lives per child on
  // the video, so a channel folder shows wrapped tiles too. The first TAP on one unwraps
  // it and deliberately does not play; a chain that just played it would both skip the
  // ritual and leave the tile wrapped forever while its video had already been watched.
  // Stopping hands the choice back to the child, which is what a gift is for.
  if (hasNext && nextIsGift) return { action: 'stop', reason: 'next-is-gift' };
  if (reason === 'error') {
    const n = Number(failures) || 0;
    if (n + 1 >= AUTOPLAY_MAX_FAILURES) return { action: 'stop', reason: 'too-many-failures' };
    if (!retriedCurrent) return { action: 'retry', reason: 'first-failure' };
    if (!hasNext) return { action: 'stop', reason: 'end-of-folder' };
    return { action: 'next', reason: 'skip-broken' };
  }
  if (!hasNext) return { action: 'stop', reason: 'end-of-folder' };
  return { action: 'next', reason: 'ended' };
}

/**
 * PURE: the video after `key` in the order the child is actually looking at.
 * The grid renders newest-first, so "next" is the tile that follows on screen — any other
 * order would make the chain disagree with what the child can see.
 * A key that is not in the list (deleted mid-play, or a different folder) has no next.
 */
export function nextInOrder(items, key) {
  const list = Array.isArray(items) ? items.filter((v) => v && v.key) : [];
  const i = list.findIndex((v) => v.key === key);
  if (i < 0 || i + 1 >= list.length) return null;
  return list[i + 1];
}

/**
 * v1.0.26 — PURE: the embed URL for the parent's PREVIEW bubble.
 *
 * Not the kid player. Three of these params are the whole point and are silent when wrong:
 *  - `controls=1` — the parent is EVALUATING, so they need YouTube's real scrub bar. The
 *    kid HUD deliberately hides the timeline and turns a centre tap into play/pause, which
 *    is exactly backwards for someone jumping through a video to check it.
 *  - `mute=1` — checking a video usually happens with the child in the room, and a nursery
 *    rhyme at full volume is what summons them. Browsers also block autoplay WITH sound,
 *    so unmuted would often simply not start (parent's decision, 2026-08-02).
 *  - `rel=0` — never surface YouTube's related-video rail inside this app.
 * Returns null for anything that is not a YouTube video; the caller falls back to <video>.
 */
export function previewEmbedUrl(rec) {
  const id = rec && rec.type === 'youtube' ? String(rec.id || '') : '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return 'https://www.youtube-nocookie.com/embed/' + id
    + '?rel=0&modestbranding=1&playsinline=1&autoplay=1&mute=1&controls=1&iv_load_policy=3';
}

/**
 * PURE (v1.0.33): which action buttons the preview bubble shows per mode. The truth
 * used to live in hand-ordered classList toggles inside renderPreview — exactly where
 * the "live 🗑️ over a search result" bug was hand-avoided once already: a 'search'
 * item has NO stored record, so a delete button there points at nothing, and
 * approve/reject belong only to the pending queue's triage. Every wrong cell in this
 * table is a button that either does nothing or destroys the wrong thing, so the
 * whole matrix is node-tested.
 */
export function previewBubbleButtons(mode) {
  const pending = mode === 'pending';
  return {
    approve: pending,
    reject: pending,
    del: mode === 'library', // the ONE mode whose items are stored records — an unknown
    add: mode === 'search'   // mode fails safe: nothing destructive, nothing additive
  };
}

/* ---------------- Resume playback (v1.0.32) ----------------
 * The parent's per-profile setting decides WHETHER; these decide WHERE. The saved
 * position is device-local (drive.js never serializes it) and rides the same
 * profileVideoState record as the gift state. */

/**
 * PURE: what to do with the playhead we just read.
 *  'clear'  — the child effectively finished the video (inside the tail): the next
 *             viewing starts fresh and the tile's progress bar disappears. Without this
 *             every video "sticks" seconds before its end forever.
 *  'save'   — a real mid-video stop, worth coming back to.
 *  'ignore' — too early to matter (or unreadable): keep whatever is stored. Clearing on
 *             a 2-second accidental tap would throw away real progress.
 * An unknown duration cannot distinguish the tail from the middle, so it never saves —
 * a wrong resume point is worse than none.
 */
export function resumeSaveDecision({ pos, dur } = {}) {
  const p = Number(pos);
  const d = Number(dur);
  if (!Number.isFinite(p) || p < 0) return 'ignore';
  if (!Number.isFinite(d) || d <= 0) return 'ignore';
  if (d - p <= RESUME_TAIL_SEC) return 'clear';
  if (p < RESUME_MIN_POS_SEC) return 'ignore';
  return 'save';
}

/**
 * PURE: where a video should start. 0 unless the profile's resume setting is ON and a
 * usable position is stored. Resumes RESUME_REWIND_SEC before the stop point (the
 * user's spec — a few seconds of context, like the YouTube app). A stale near-end
 * position (written by an app that died before the 'ended' clear) starts over rather
 * than dropping the child onto the end screen.
 */
export function resumeStartAt({ enabled = false, posSec, durSec } = {}) {
  if (!enabled) return 0;
  const p = Number(posSec);
  if (!Number.isFinite(p) || p < RESUME_MIN_POS_SEC) return 0;
  const d = Number(durSec);
  if (Number.isFinite(d) && d > 0 && d - p <= RESUME_TAIL_SEC) return 0;
  return Math.max(0, p - RESUME_REWIND_SEC);
}

/**
 * PURE: the tile progress-bar fraction, or null when no bar should show.
 * Mirrors resumeSaveDecision's floor so a position too small to resume never draws a
 * sliver, and a fraction is only computable when BOTH numbers are usable.
 */
export function watchedFraction(posSec, durSec) {
  const p = Number(posSec);
  const d = Number(durSec);
  if (!Number.isFinite(p) || p < RESUME_MIN_POS_SEC) return null;
  if (!Number.isFinite(d) || d <= 0) return null;
  return Math.max(0, Math.min(1, p / d));
}

/**
 * The TV remote's intent for one key press. Kept here so the repeat rule and the seek
 * clamp cannot drift between the touch and remote paths.
 * A HELD key auto-repeats at ~30/s on Android TV; scrubbing on every one of those jumped
 * minutes per second and could run past the end (see clampSeek), so a repeat only reveals.
 */
export function tvKeyIntent(action, { time = 0, duration = 0, repeat = false } = {}) {
  if (repeat) return { kind: 'reveal' };
  if (action === 'toggle') return { kind: 'toggle' };
  if (action === 'reveal') return { kind: 'reveal' };
  if (action === 'back') {
    return { kind: 'seek', to: clampSeek(Number(time) - SEEK_STEP, duration), flash: '⏪ ' + SEEK_STEP };
  }
  if (action === 'fwd') {
    return { kind: 'seek', to: clampSeek(Number(time) + SEEK_STEP, duration), flash: SEEK_STEP + ' ⏩' };
  }
  return { kind: 'ignore' }; // dpad relies on a falsy result to NOT preventDefault
}

/* ---------------- interrupted by a call (v1.0.57) ---------------- */

/** The audio modes that mean a call is happening, ringing included. */
const CALL_MODES = new Set(['in_call', 'in_communication', 'ringtone']);
export const isCallAudioMode = (mode) => CALL_MODES.has(String(mode || '').toLowerCase());

/**
 * v1.0.57 — PURE: what to do about a video that is not playing while a call is (or was)
 * happening. User request: "a call comes in mid-video, the video pauses as it does today,
 * and when the call ends it carries on by itself." User decision: CALLS ONLY — every other
 * pause (the power button, HOME, the app switcher, the child's own tap) keeps the v1.0.32
 * behaviour, where the video waits and the child presses play.
 *
 *   'arm'     — a call is happening and the video is not playing: remember to come back.
 *   'resume'  — armed, the call is over, still paused: play it.
 *   'disarm'  — the intent is stale and must be dropped.
 *   null      — nothing to do.
 *
 * THE RULES THAT MATTER, each closing a way for a video to start itself in a quiet room:
 *  - 'unknown' IS NOT 'normal'. A browser, an APK built before the native method existed
 *    and a device that refuses the getter all report unknown, and treating that as "the
 *    call ended" would resume after ANY pause. Unknown never arms and never resumes.
 *  - PLAYING DISARMS. If the video is playing, either the child pressed play or we already
 *    resumed; a live intent left behind would fire at some unrelated later pause.
 *  - LEAVING THE VIDEO DISARMS. The intent belongs to one video on one screen: a different
 *    key, or the watch view gone (the child left, a scheduled break took over), drops it.
 *  - IT EXPIRES. After `maxWaitMs` a call is no longer "the thing that just interrupted
 *    us" — the tablet has been sitting on a paused video for a quarter of an hour, and
 *    starting it then would surprise whoever is in the room.
 */
export function planCallResume({
  armed = null, mode = 'unknown', playing = false, inWatch = true, userPaused = false,
  key = null, now = Date.now(), maxWaitMs = CALL_RESUME_MAX_MS
} = {}) {
  const call = isCallAudioMode(mode);
  if (!inWatch || !key) return armed ? 'disarm' : null;
  if (armed && armed.key !== key) return 'disarm';        // a different video is up now
  if (playing) return armed ? 'disarm' : null;            // playing: nothing to come back to
  if (armed) {
    const waited = Number(now) - Number(armed.at);
    if (!Number.isFinite(waited) || waited > maxWaitMs) return 'disarm';
    // ONLY AN AFFIRMATIVE 'normal' RESUMES. The first version read this as "not a call mode
    // ⇒ the call ended", which quietly made 'unknown' — a failed bridge, an older APK — mean
    // "play it", against the rule stated above; and 'other' covers modes we do not know
    // (call screening among them), which is not evidence of an ended call either. Caught by
    // running the matrix, not by reading it.
    return String(mode).toLowerCase() === 'normal' ? 'resume' : null;
  }
  // ⚠️ ONLY A CALL THAT INTERRUPTED PLAYBACK MAY ARM. Reported from the field: a parent
  // paused the audio, went off to do something else, took a call — and the song started
  // playing when the call ended. The lifecycle door has always checked this (it arms only
  // when the playhead said `playing`), but the POLL — which exists because a heads-up call
  // fires no lifecycle event at all — saw only "not playing" and could not tell a call's
  // pause from a deliberate one. `userPaused` is that missing distinction, and it belongs
  // in the decision rather than in one of its two callers.
  if (userPaused) return null;
  return call ? 'arm' : null;
}
