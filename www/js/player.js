// player.js — plays an item in the watch host. Dispatches by type:
//   youtube -> YT IFrame (nocookie, controls:0) with a custom HUD; near-end auto-return.
//   file    -> <video> with the same custom HUD; hybrid streaming -> download+cache on failure.
//
// HUD state machine (F1): HIDDEN / VISIBLE (3s timer) / PINNED (paused or dragging).
// One class drives it: .hud-on on #player-wrap; when hidden, the overlays also get
// pointer-events:none so taps fall through to #tap-shield.
// Tap model is "reveal first, then pause": when controls are hidden a tap only reveals
// them; when visible, a single tap in the middle 50% toggles play/pause; a double tap
// on the left/right half seeks ∓/±SEEK_STEP. While PLAYING everything auto-hides after
// HUD_HIDE_MS — 🏠 and ⛶ included — leaving bare video, like YouTube. Paused never hides.
//
// INVARIANTS (do not break — see DEVELOPMENT.md §12):
//   stop() only tears down; it NEVER calls onExit. Only finish() may.
//   setupHud() binds window listeners — it must never run twice without teardown().
//   The YouTube→YouTube reuse path (loadVideoById) must not call cleanup()/setupHud();
//   it swaps the mutable `cb` so finish() never fires a stale onExit closure.

import { prepareStreamSrc, downloadAndCache, captureFrame } from './media.js';
import { stripTimeHints } from './classify.js';
import { HUD_HIDE_MS, SEEK_STEP, TAP_DOUBLE_MS, TAP_SINGLE_DELAY } from './config.js';
import { clampSeek, fractionFromX, formatTime, isTapGesture, shouldFinishNearEnd, tvKeyIntent } from './playerlogic.js';
import * as wake from './wake.js';

const $id = (id) => document.getElementById(id);
let ytApiPromise = null;
let current = null; // { cleanup, kind, reuse? }
let tvHud = null;   // v1.0.9: the live HUD's controls, for TV-remote keys (dpad.js)

/**
 * TV remote → player (v1.0.9): 'toggle' = play/pause, 'back'/'fwd' = ±SEEK_STEP,
 * 'reveal' = show the HUD. Returns false when no video is live (dpad ignores it).
 */
export function handleTvKey(action, { repeat = false } = {}) {
  if (!tvHud) return false;
  const { ctl, reveal, renderProgress, flash, toggleWithFlash } = tvHud;
  const intent = tvKeyIntent(action, { time: ctl.getTime(), duration: ctl.getDuration(), repeat });
  if (intent.kind === 'ignore') return false;
  if (intent.kind === 'toggle') toggleWithFlash();
  if (intent.kind === 'seek') { ctl.seekTo(intent.to); flash(intent.flash); renderProgress(); }
  reveal();
  return true;
}

/**
 * The IFrame API script. MUST be able to fail and be retried: it used to cache a promise
 * with no `reject`, no `onerror` and no timeout, so ONE failed load (offline, captive
 * portal — the normal state of a tablet that just woke up) left it pending forever. Every
 * later tap awaited the same dead promise, so `current` was never registered and there is
 * no onStatus on this path: the child stared at a black player with a stale HUD, and
 * every YouTube video stayed dead until the app was force-quit. Wi-Fi returning did not
 * help. A rejected attempt is NOT cached, so the next tap tries again.
 */
function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve();
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(t); fn(arg); } };
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch {} done(resolve); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => done(reject, new Error('yt-api-load-failed'));
    const t = setTimeout(() => done(reject, new Error('yt-api-timeout')), 15000);
    document.head.appendChild(s);
  }).catch((e) => { ytApiPromise = null; throw e; });
  return ytApiPromise;
}

export function stop() {
  if (current && current.cleanup) { try { current.cleanup(); } catch {} }
  current = null;
}

/**
 * v1.0.32 — the live playhead, for the resume feature (app.js owns the profile and the
 * database; this module only lends it the clock). Null when nothing is mounted — a
 * caller reading it after finish()/stop() gets null, never a stale player's numbers.
 */
/**
 * v1.0.72 — WAS THE CURRENT PAUSE A DELIBERATE HUMAN ACT?
 *
 * The call watcher needs this and cannot infer it: a video paused by a call and a video
 * paused by a child look identical from outside. Only the surfaces that a person actually
 * presses set it — the centre tap, the TV remote's OK and the notification's ⏯. An
 * app-initiated pause (screen-off, a scheduled break, the call itself) deliberately does
 * NOT, because those are exactly the ones a call may legitimately resume from.
 */
let userPausedAt = 0;

/** Called by the toggle surfaces. `paused` is the state the person just chose. */
export function markUserToggle(paused) { userPausedAt = paused ? Date.now() : 0; }

export function playbackState() {
  if (!current || !current.ctl) return null;
  const c = current.ctl;
  return { time: c.getTime(), duration: c.getDuration(), playing: c.isPlaying(),
    userPaused: userPausedAt > 0 };
}

/**
 * v1.0.32 — pause IN PLACE, no teardown: the screen-off / background handler.
 * The video stays mounted at its position, exactly like the YouTube app — screen back
 * on, the child taps play and continues. Deliberately NOT stop(): stop() destroys the
 * player, and coming back to a black hole is the "הסרטון נעלם" the user reported.
 */
/**
 * v1.0.68 — seek ±SEEK_STEP from OUTSIDE the player: the notification's ⏪/⏩ (user request,
 * replacing the track-skip buttons). -> the new position, or null when nothing is playing.
 *
 * ⚠️ IT GOES THROUGH `tvKeyIntent`, WHICH CLAMPS. That is not tidiness: an unclamped forward
 * seek runs past the end, the engine fires ENDED → `finish()` → `onExit`, and the child is
 * EJECTED from the video (the v1.0.22 bug this app has paid for once, on the TV remote). A
 * notification is a THIRD seek surface, and it must not be the one that reintroduces it.
 *
 * Works for both engines because it only ever touches `current.ctl`, the same handle the
 * HUD and the remote use.
 */
export function seekRelative(action) {
  if (!current || !current.ctl) return null;
  const c = current.ctl;
  const intent = tvKeyIntent(action, { time: c.getTime(), duration: c.getDuration() });
  if (intent.kind !== 'seek') return null;
  c.seekTo(intent.to);
  return intent.to;
}

export function pauseCurrent() {
  if (!current || !current.ctl || !current.ctl.pause) return;
  try { current.ctl.pause(); } catch {}
}

/**
 * v1.0.57 — the twin of pauseCurrent, for a video a CALL interrupted (user request: when
 * the call ends the video carries on by itself).
 *
 * Answers whether it actually acted, and that is the point: app.js arms a one-shot "resume
 * when the call is over", and it may only disarm on a real resume. A `false` here means
 * there is nothing mounted (the child left, the player was torn down), so the caller drops
 * the intent instead of firing it at whatever mounts next.
 */
export function resumeCurrent() {
  if (!current || !current.ctl || !current.ctl.play) return false;
  userPausedAt = 0;   // it is playing again: there is no deliberate pause left to protect
  try { current.ctl.play(); return true; } catch { return false; }
}

// v1.0.18 — supersession token. playYouTube can only register itself in `current`
// AFTER `await loadYouTubeApi()`, so a second tap while that script is still loading
// found current === null, made stop() a no-op, and mounted a SECOND player and HUD.
// That breaks the "never run setupHud twice without teardown()" invariant: the first
// HUD's window listeners leak for the session, and the orphaned player keeps its
// poll alive until it hits the near-end check and fires a stale onExit — yanking the
// child out of the video they are actually watching, with no way for stop() to kill it.
let playSeq = 0;

/** v1.0.32: sanitized resume offset from opts.startAt (app.js's decision). */
const startFrom = (opts) => {
  const s = Math.floor(Number(opts && opts.startAt));
  return Number.isFinite(s) && s > 0 ? s : 0;
};

export async function playItem(item, host, opts = {}) {
  userPausedAt = 0;   // a new video inherits nobody's pause
  // Fast path: YouTube → YouTube switches reuse the live player (no black flash).
  if (item.type === 'youtube' && current && current.kind === 'youtube' && current.reuse) {
    try { current.reuse(item, opts); return; } catch { /* fall through to full restart */ }
  }
  const seq = ++playSeq;
  stop();
  host.innerHTML = '';
  if (item.type === 'youtube') return playYouTube(item, host, opts, seq);
  return playFile(item, host, opts, seq); // the file path needs the token too — see below
}

/* ---------------- Shared HUD ----------------
   ctl: { getTime(), getDuration(), seekTo(sec), isPlaying(), togglePlay() } */
function setupHud(ctl) {
  const wrap = $id('player-wrap');
  const shield = $id('tap-shield');
  const seek = $id('seek');
  const fill = $id('seek-fill');
  const knob = $id('seek-knob');
  const tCur = $id('time-cur');   // v1.0.32: elapsed / total flank the bar
  const tDur = $id('time-dur');
  const fb = $id('seek-feedback');
  let fbTimer = null;
  let hideTimer = null;
  let dragging = false;
  let wasVisible = true;   // HUD visibility at the START of the current touch
  let lastPlaying = null;  // detects play/pause transitions from the heartbeat

  const setHud = (on) => { if (wrap) wrap.classList.toggle('hud-on', on); };
  const hideNow = () => setHud(false);
  // The single timer entry point. Playing → visible for HUD_HIDE_MS then hidden;
  // paused or dragging → visible with no timer (PINNED).
  const reveal = () => {
    setHud(true);
    clearTimeout(hideTimer);
    if (ctl.isPlaying() && !dragging) hideTimer = setTimeout(hideNow, HUD_HIDE_MS);
  };

  // Text writes are guarded by value: this runs 4×/s and touching textContent with the
  // same string still invalidates layout on cheap tablets.
  const setTimes = (t, d) => {
    if (tCur) { const s = formatTime(t); if (tCur.textContent !== s) tCur.textContent = s; }
    if (tDur) { const s = formatTime(d); if (tDur.textContent !== s) tDur.textContent = s; }
  };

  const renderProgress = () => {
    const d = ctl.getDuration() || 0;
    const t = ctl.getTime() || 0;
    const pct = d > 0 ? Math.max(0, Math.min(100, (t / d) * 100)) : 0;
    if (fill) fill.style.width = pct + '%';
    if (knob) knob.style.left = pct + '%';
    setTimes(t, d);
    const playing = ctl.isPlaying();
    wake.set('play', playing); // F7 heartbeat — self-healing, can't miss a transition
    if (playing !== lastPlaying) { lastPlaying = playing; reveal(); } // pin on pause, re-arm on play
  };

  /**
   * The centre-screen confirmation. ONE element and ONE timer for both kinds, so a seek
   * landing on top of a pause cannot leave two badges fighting over the middle of the video.
   *
   * v1.0.71 — `kind: 'toggle'` is the play/pause badge (user request: the same YouTube
   * feedback the ±10 seek already had). It is a ROUND glyph rather than the seek's pill,
   * because the two must be told apart at a glance by a child who cannot read: the seek
   * says a number, and this says a shape.
   */
  const flash = (txt, kind = 'seek') => {
    if (!fb) return;
    fb.textContent = txt;
    fb.classList.toggle('is-toggle', kind === 'toggle');
    fb.classList.add('show');
    clearTimeout(fbTimer);
    fbTimer = setTimeout(() => fb.classList.remove('show'), 550);
  };

  /**
   * Pause/resume, with the badge. ⚠️ THE STATE IS READ BEFORE THE TOGGLE: `togglePlay()`
   * starts an ASYNCHRONOUS play on both engines, so asking afterwards can still answer
   * "paused" and the badge would contradict what just happened. What the child did is what
   * gets shown — which is also what YouTube shows.
   */
  const toggleWithFlash = () => {
    const wasPlaying = ctl.isPlaying();
    markUserToggle(wasPlaying);   // v1.0.72 — a call must not resume what a person stopped
    ctl.togglePlay();
    flash(wasPlaying ? '⏸' : '▶', 'toggle');
  };

  // Any touch anywhere in the player (buttons included — capture phase) reveals the
  // HUD and re-arms the timer. wasVisible is captured HERE, before reveal(), so the
  // tap handler below knows whether this tap started on a hidden HUD.
  // v1.0.52: the press coordinates are captured here too — onTap must know whether the
  // finger TRAVELED (a swipe releasing over the shield must never read as a tap).
  let downX = NaN, downY = NaN;
  const onAnyTouch = (e) => {
    downX = e.clientX; downY = e.clientY;
    wasVisible = wrap.classList.contains('hud-on');
    reveal();
  };

  // Seek bar (LTR timeline): tap or drag anywhere on it to jump. Dragging pins the HUD.
  const fracFrom = (e) => { const r = seek.getBoundingClientRect(); return fractionFromX(e.clientX, r.left, r.width); };
  const seekFrac = (f) => { const d = ctl.getDuration() || 0; if (d > 0) { ctl.seekTo(clampSeek(f * d, d)); renderProgress(); } };
  const onDown = (e) => { dragging = true; clearTimeout(hideTimer); setHud(true); seekFrac(fracFrom(e)); e.preventDefault(); };
  const onMove = (e) => { if (dragging) seekFrac(fracFrom(e)); };
  // pointercancel is NOT optional: the seek bar sits in Android's bottom gesture inset
  // and the app enables swipe-to-reveal system bars, so the OS routinely steals the
  // gesture and no `pointerup` ever arrives. `dragging` then stayed true FOREVER — every
  // later pointermove anywhere in the window seeked the video (scrolling the grid dragged
  // the playhead), and `reveal()` never re-armed the hide timer, pinning the HUD.
  const onUp = () => { if (dragging) { dragging = false; reveal(); } };

  // Video-area taps: double left/right = seek; single center = play/pause, but ONLY
  // when the HUD was already visible ("reveal first, then pause") — a child poking a
  // bare video reveals the controls instead of stopping the show.
  let lastTap = 0;
  let tapTimer = null;
  const onTap = (e) => {
    // v1.0.52: a press that moved is a SWIPE, not a tap. touch-action:pan-y already
    // hands vertical page-scrolls to the browser (they end in pointercancel), but a
    // horizontal swipe — and any swipe while fullscreen, where nothing scrolls — still
    // releases here, and a center release used to PAUSE the video mid-scroll-attempt.
    if (!isTapGesture(downX, downY, e.clientX, e.clientY)) return;
    const now = Date.now();
    const r = shield.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (now - lastTap < TAP_DOUBLE_MS) {
      clearTimeout(tapTimer);
      lastTap = 0;
      const d = ctl.getDuration();
      if (x < r.width / 2) { ctl.seekTo(clampSeek(ctl.getTime() - SEEK_STEP, d)); flash('⏪ ' + SEEK_STEP); }
      else { ctl.seekTo(clampSeek(ctl.getTime() + SEEK_STEP, d)); flash(SEEK_STEP + ' ⏩'); }
      renderProgress();
      reveal();
    } else {
      // clear FIRST: two taps in the TAP_DOUBLE_MS..TAP_SINGLE_DELAY window (260-279ms)
      // are too slow to be a seek but both armed a toggle, so the child's deliberate
      // double-tap paused and instantly resumed — no seek, no pause, just a HUD flicker.
      clearTimeout(tapTimer);
      lastTap = now;
      const visible = wasVisible;
      const center = x > r.width * 0.25 && x < r.width * 0.75;
      tapTimer = setTimeout(() => { if (visible && center) { toggleWithFlash(); reveal(); } }, TAP_SINGLE_DELAY);
    }
  };

  const onFsChange = () => reveal(); // show 🏠/⛶ for 3s on fullscreen enter/exit

  wrap.addEventListener('pointerdown', onAnyTouch, true);
  if (shield) shield.addEventListener('pointerup', onTap);
  if (seek) seek.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  tvHud = { ctl, reveal, renderProgress, flash, toggleWithFlash }; // v1.0.9: TV-remote hook

  const teardown = () => {
    tvHud = null;
    wrap.removeEventListener('pointerdown', onAnyTouch, true);
    if (shield) shield.removeEventListener('pointerup', onTap);
    if (seek) seek.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    clearTimeout(tapTimer);
    clearTimeout(fbTimer);
    clearTimeout(hideTimer);
    if (fill) fill.style.width = '0%';
    if (knob) knob.style.left = '0%';
    setTimes(0, 0);
    if (fb) fb.classList.remove('show');
    setHud(true); // next video starts with controls visible
    wake.release('play');
  };

  /** Used by the loadVideoById fast path — resets progress + shows the HUD. NEVER re-setup. */
  const reset = () => {
    lastTap = 0;
    lastPlaying = null;
    clearTimeout(tapTimer);
    if (fill) fill.style.width = '0%';
    if (knob) knob.style.left = '0%';
    setTimes(0, 0); // the new video's numbers arrive with its first heartbeat
    if (fb) fb.classList.remove('show');
    reveal();
  };

  renderProgress();
  reveal();
  return { renderProgress, teardown, reset, reveal };
}

/* ---------------- YouTube ---------------- */
async function playYouTube(item, host, opts = {}, seq = playSeq) {
  try {
    await loadYouTubeApi();
  } catch {
    // The script could not load (offline / captive portal). SAY SO instead of leaving the
    // child in front of a black rectangle — and the next tap retries, because a failed
    // attempt is no longer cached.
    if (seq === playSeq && opts.onStatus) opts.onStatus('error');
    return;
  }
  // Superseded while the API script loaded: a newer playItem already owns the host.
  // Bail BEFORE mounting anything — there is no `current` entry for stop() to reach.
  if (seq !== playSeq) return;
  const mount = document.createElement('div');
  mount.id = 'yt-player-' + Date.now();
  host.appendChild(mount);

  let cb = opts;      // MUTABLE — reuse() swaps it (stale-onExit trap, see header)
  let player = null;
  let timer = null;
  let torn = false;
  let hud = null;
  let swapAt = 0;     // last loadVideoById time; guards the near-end check during swaps
  let ccLast = 0;
  let errTimer = null; // MUST be cancellable — see onError
  let curId = item.id; // which video we BELIEVE is loaded; reuse() swaps it

  const ctl = {
    getTime: () => { try { return player.getCurrentTime(); } catch { return 0; } },
    getDuration: () => { try { return player.getDuration(); } catch { return 0; } },
    seekTo: (s) => { try { player.seekTo(Math.max(0, s), true); } catch {} },
    isPlaying: () => { try { const st = player.getPlayerState(); return st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING; } catch { return false; } },
    pause: () => { try { player.pauseVideo(); } catch {} }, // screen-off (v1.0.32)
    play: () => { try { player.playVideo(); } catch {} },   // after a call (v1.0.57)
    togglePlay: () => {
      try {
        const st = player.getPlayerState();
        if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) player.pauseVideo();
        else player.playVideo();
      } catch {}
    }
  };

  // F2: kill captions/auto-translate overlays. Four ops, each in its own try/catch,
  // debounced (each is a cross-origin postMessage). Re-applied from onApiChange —
  // the canonical hook that fires exactly when the captions module loads — plus
  // onReady, PLAYING, and after every loadVideoById. NOT from the 250ms poll.
  const killCaptions = (force = false) => {
    const now = Date.now();
    if (!force && now - ccLast < 400) return;
    ccLast = now;
    try { player.unloadModule('captions'); } catch {}
    try { player.unloadModule('cc'); } catch {}
    try { player.setOption('captions', 'track', {}); } catch {}
    try { player.setOption('cc', 'track', {}); } catch {}
  };

  const cleanup = () => {
    if (torn) return;
    torn = true;
    if (timer) clearInterval(timer);
    if (errTimer) clearTimeout(errTimer);
    if (hud) hud.teardown();
    try { player && player.stopVideo && player.stopVideo(); } catch {}
    try { player && player.destroy && player.destroy(); } catch {}
  };
  // v1.0.25: onExit now says WHY. finish() fires for a clean end AND for an
  // embedding-disabled video, and an autoplay chain hooked to it would skip silently
  // through every broken video in the library — the parent would never learn the content
  // is dead, and the child would watch the grid flicker.
  const finish = (reason = 'ended') => { const first = !torn; cleanup(); if (first && cb.onExit) cb.onExit(reason); };

  const reuse = (nextItem, nextOpts) => {
    if (torn || !player || !player.loadVideoById) throw new Error('not-reusable');
    cb = nextOpts || {};
    swapAt = Date.now();
    curId = nextItem.id; // so the near-end guard can tell a slow swap from a real tail
    if (errTimer) { clearTimeout(errTimer); errTimer = null; } // A's error must not exit B
    // startSeconds is OUR resume decision (v1.0.32) — never the link's (classifyLink
    // still strips t= hints; F3's "always from 0" became "always from what app.js says").
    player.loadVideoById({ videoId: nextItem.id, startSeconds: startFrom(cb) });
    killCaptions(true);
    hud.reset();
  };

  current = { cleanup, kind: 'youtube', reuse, ctl }; // ctl: playbackState (v1.0.32)
  hud = setupHud(ctl);

  player = new YT.Player(mount.id, {
    videoId: item.id,
    host: 'https://www.youtube-nocookie.com',
    width: '100%', height: '100%',
    playerVars: {
      // controls:0 hides YouTube's whole bar; we draw our own HUD.
      rel: 0, iv_load_policy: 3, disablekb: 1, playsinline: 1,
      fs: 0, controls: 0, autoplay: 1, enablejsapi: 1,
      modestbranding: 1, origin: window.location.origin,
      cc_load_policy: 0, // F2 (do NOT set cc_lang_pref/hl — they can enable a track)
      // v1.0.32: OUR resume decision, never the link's (classifyLink already dropped t=,
      // and that stays true — a URL must not choose where a video starts).
      start: startFrom(opts)
    },
    events: {
      onReady: (e) => {
        try { e.target.unMute(); e.target.setVolume(100); e.target.playVideo(); } catch {}
        killCaptions(true);
        hud.renderProgress();
        timer = setInterval(() => {
          try {
            const d = player.getDuration();
            const c = player.getCurrentTime();
            hud.renderProgress();
            // Leave before the end-screen recommendations (pure: shouldFinishNearEnd).
            // The reported video id is the authoritative swap guard when the player
            // offers it — the wall-clock grace alone is a bet on network latency.
            let reportedId = null;
            try { reportedId = (player.getVideoData() || {}).video_id || null; } catch {}
            if (shouldFinishNearEnd({
              duration: d, current: c, now: Date.now(), swapAt,
              expectedId: curId, reportedId
            })) finish();
          } catch {}
        }, 250);
      },
      onApiChange: () => killCaptions(),
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) { finish(); return; }
        if (e.data === YT.PlayerState.PLAYING) killCaptions();
        // v1.0.76 — report play/pause like the file engine does (v1.0.74), THROUGH `cb`
        // (reuse() swaps it — `opts` here would report into the PREVIOUS video's callbacks).
        // PiP needs the real state for its ⏯ icon on BOTH engines; the background service
        // is unaffected because republish is gated on `bgPlayLive`, which YouTube never arms.
        // BUFFERING is deliberately not reported either way — it would flicker the icon.
        if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED) {
          try { if (cb.onPlayState) cb.onPlayState(e.data === YT.PlayerState.PLAYING); } catch {}
        }
        hud.renderProgress();
      },
      // An embedding-disabled video (error 101/150 — routine in a curated kids library)
      // exits after a beat. The handle and the swapAt re-check are load-bearing: `reuse()`
      // deliberately leaves `torn === false`, so an uncancelled timer from video A fired
      // AFTER the child had already picked B, destroying the iframe playing B and firing
      // onExit — yanking them out of the video they just chose, 400ms in.
      onError: () => {
        if (errTimer) clearTimeout(errTimer);
        const firedFor = swapAt;
        errTimer = setTimeout(() => { if (!torn && swapAt === firedFor) finish('error'); }, 400);
      }
    }
  });
}

/* ---------------- Direct file ---------------- */
async function playFile(item, host, opts = {}, seq = 0) {
  const { onExit, onStatus, onThumb } = opts;
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.controls = false; // we provide our own HUD
  video.autoplay = true;
  video.preload = 'auto';
  video.volume = 1;     // always full; the tablet's volume buttons control loudness
  video.muted = false;
  host.appendChild(video);

  let torn = false;
  let hud = null;
  let forcedZero = false;
  // v1.0.56 — AUDIO files (mp3 from Drive, שירי ערש) play through the same <video>
  // element, which renders as a black rectangle. `.is-audio` on the wrap shows the CSS
  // music scene (#audio-scene, pointer-events:none — the HUD-container invariant).
  // Known upfront from the record when metadata was fetched; CORRECTED at loadedmetadata
  // either way (videoWidth 0 = no video track), so an unenriched Drive mp3 still gets the
  // scene and a mislabeled video never hides its picture. cleanup() always clears it —
  // the YouTube engine and the next file must never inherit the scene.
  const wrap = $id('player-wrap');
  const setAudioScene = (on) => { if (wrap) wrap.classList.toggle('is-audio', !!on); };
  setAudioScene(item.media === 'audio');
  // v1.0.70 — THE SCENE MOVES ONLY WHILE THE SOUND DOES (user request). Driven by the media
  // element's OWN play/pause events rather than by whoever called pause, so it follows every
  // source at once: the tap-shield, the HUD, the notification's ⏯, a call, screen-off, and
  // the pause the browser performs by itself when a track ends.
  const setPausedScene = () => { if (wrap) wrap.classList.toggle('is-paused', !!video.paused); };
  setPausedScene();
  // v1.0.74 — TELL THE APP WHENEVER PLAYBACK STARTS OR STOPS, so the lock-screen widget and
  // the car can be republished. Until now the session state was only ever refreshed when the
  // NOTIFICATION itself was pressed, so a pause from the screen — or a track simply ending —
  // left it advertising STATE_PLAYING, and the widget showed ⏸ over a silent track.
  const notifyPlayState = () => { try { if (opts.onPlayState) opts.onPlayState(!video.paused); } catch {} };
  const ctl = {
    getTime: () => video.currentTime || 0,
    getDuration: () => video.duration || 0,
    seekTo: (s) => { try { video.currentTime = Math.max(0, s); } catch {} },
    isPlaying: () => !video.paused,
    pause: () => { try { video.pause(); } catch {} }, // screen-off (v1.0.32)
    // after a call (v1.0.57) — the promise MUST be caught: a play() the browser refuses
    // (no user activation, a device still holding audio focus) rejects, and an unhandled
    // rejection here would surface as an error with the video simply staying paused
    play: () => { try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch {} },
    togglePlay: () => { if (video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } else video.pause(); }
  };
  const onTime = () => { if (hud) hud.renderProgress(); };

  const cleanup = () => {
    if (torn) return;
    torn = true;
    setAudioScene(false);
    // the wrap is shared with the YouTube engine and the next file — a stale `is-paused`
    // would freeze the NEXT track's scene (the same reason cleanup always clears is-audio)
    if (wrap) wrap.classList.remove('is-paused');
    if (hud) hud.teardown();
    video.removeEventListener('timeupdate', onTime);
    video.removeEventListener('loadedmetadata', onTime);
    video.removeEventListener('play', onTime);
    video.removeEventListener('pause', onTime);
    video.removeEventListener('play', setPausedScene);
    video.removeEventListener('pause', setPausedScene);
    video.removeEventListener('ended', setPausedScene);
    video.removeEventListener('play', notifyPlayState);
    video.removeEventListener('pause', notifyPlayState);
    video.removeEventListener('ended', notifyPlayState);
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
  };
  const finish = (reason = 'ended') => { const first = !torn; cleanup(); if (first && onExit) onExit(reason); };
  current = { cleanup, kind: 'file', ctl }; // ctl: playbackState (v1.0.32)
  hud = setupHud(ctl);

  video.addEventListener('timeupdate', onTime);
  video.addEventListener('loadedmetadata', onTime);
  video.addEventListener('play', onTime);
  video.addEventListener('pause', onTime);
  video.addEventListener('play', setPausedScene);
  video.addEventListener('pause', setPausedScene);
  video.addEventListener('ended', setPausedScene);
  video.addEventListener('play', notifyPlayState);
  video.addEventListener('pause', notifyPlayState);
  video.addEventListener('ended', notifyPlayState);
  // wrapped: the DOM hands the listener an Event, which would arrive as the exit REASON
  video.addEventListener('ended', () => finish('ended'));
  // F3 + v1.0.32: the start is OUR decision (the resume offset, usually 0) — a
  // media-fragment (#t=30) that survived somewhere WILL seek, so force ours once.
  video.addEventListener('loadedmetadata', () => {
    // the runtime truth about the media kind — corrects a missing/wrong `media` field
    setAudioScene(!(video.videoWidth > 0));
    const want = startFrom(opts);
    if (!forcedZero && Math.abs((video.currentTime || 0) - want) > 0.5) {
      try { video.currentTime = want; } catch {}
    }
    forcedZero = true; // once-only: never stomp a legitimate later seek
  });

  const play = (src) => { video.src = stripTimeHints(src); const p = video.play(); if (p && p.catch) p.catch(() => {}); };
  const first = await prepareStreamSrc(item);
  // SUPERSESSION — the same guard playYouTube has, and for a worse failure. `prepareStreamSrc`
  // awaits a native Filesystem round trip; a tap on another tile during it runs stop() +
  // `host.innerHTML = ''`, DETACHING this <video>. A detached media element still decodes
  // audio, and `current` no longer references it, so stop()/goGallery()/wake.releaseAll()
  // cannot reach it: two soundtracks at once until the app is killed.
  if (torn || (seq && seq !== playSeq)) return;
  let downloading = false;
  play(first.src);

  // A LOCAL file needs the error listener too: the cache is written with no integrity
  // check and `localPath` is recorded before anything ever plays it, so a truncated or
  // unsupported cached file was a silent black screen the child could never escape —
  // and the bad entry is preferred on every later attempt.
  video.addEventListener('error', () => {
    if (torn || downloading) return;
    if (first.local && onStatus) onStatus('error');
  });

  if (!first.local) {
    video.addEventListener('error', async () => {
      if (downloading || torn) return;
      downloading = true;
      if (onStatus) onStatus('downloading');
      await wake.acquire('download'); // a long first-download must not let the screen sleep
      try {
        const res = await downloadAndCache(item);
        if (torn) return;
        if (onStatus) onStatus('');
        play(res.src);
      } catch (e) {
        if (onStatus) onStatus(String(e && e.message) === 'download-unsupported' ? 'unsupported' : 'error');
      } finally {
        wake.release('download');
      }
    });
  }

  if (!item.thumb && onThumb) {
    video.addEventListener('loadeddata', () => {
      const data = captureFrame(video);
      if (data) onThumb(data);
    }, { once: true });
  }
}
