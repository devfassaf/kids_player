// playerlogic.js — the pure decisions behind player.js (v1.0.22). Until now player.js had
// NO tests at all while carrying the longest hard-invariant block in CLAUDE.md, and every
// bug these cover was found by reading it, not by the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSeek, fractionFromX, formatTime, isTapGesture, progressPct, shouldFinishNearEnd, tvKeyIntent, fullscreenOrientation,
  planAutoplay, nextInOrder, previewEmbedUrl, previewBubbleButtons,
  resumeStartAt, resumeSaveDecision, watchedFraction, nowPlayingChannel } from '../www/js/playerlogic.js';
import { SEEK_STEP, TAP_DOUBLE_MS, TAP_SINGLE_DELAY, TAP_SLOP_PX,
  AUTOPLAY_MAX_FAILURES, AUTOPLAY_COUNTDOWN_MS, AUTOPLAY_RETRY_MS,
  RESUME_REWIND_SEC, RESUME_MIN_POS_SEC, RESUME_TAIL_SEC } from '../www/js/config.js';

test('clampSeek never runs past the end — a forward seek must not EJECT the child', () => {
  // Every forward seek was `getTime() + SEEK_STEP` unbounded. Past the end YouTube fires
  // ENDED, which runs finish() -> onExit -> leaveWatch(), so pressing ⏩ near the end threw
  // the child out of the video instead of taking them to its last seconds.
  assert.equal(clampSeek(195, 200), 195);
  assert.equal(clampSeek(200, 200), 199.5, 'landed exactly on the end');
  assert.equal(clampSeek(1e9, 200), 199.5);
  assert.equal(clampSeek(-5, 200), 0, 'and never before the start');
  // an UNKNOWN duration (live stream, metadata not in yet) must not clamp to 0 —
  // that would silently rewind instead of seeking
  assert.equal(clampSeek(120, 0), 120);
  assert.equal(clampSeek(120, NaN), 120);
  assert.equal(clampSeek(120, undefined), 120);
  // junk never produces NaN, which would make seekTo() throw inside the player adapter
  for (const junk of [NaN, undefined, null, 'x', {}]) assert.equal(clampSeek(junk, 200), 0, String(junk));
  // a very short video still yields something inside it
  assert.ok(clampSeek(99, 1) >= 0 && clampSeek(99, 1) <= 1);
});

test('fractionFromX and progressPct are NaN-proof (a zero-width rect is real)', () => {
  assert.equal(fractionFromX(50, 0, 100), 0.5);
  assert.equal(fractionFromX(-10, 0, 100), 0);
  assert.equal(fractionFromX(999, 0, 100), 1);
  // the seek bar is measured while the HUD is hidden / mid-layout, where width is 0.
  // NaN here would propagate into seekTo() and into the CSS width of the fill.
  assert.equal(fractionFromX(50, 0, 0), 0);
  assert.equal(fractionFromX(50, 0, NaN), 0);
  assert.equal(progressPct(50, 100), 50);
  assert.equal(progressPct(0, 0), 0);
  assert.equal(progressPct(10, NaN), 0);
  assert.equal(progressPct(999, 100), 100, 'never exceeds 100% (a bar wider than its track)');
  assert.equal(progressPct(-5, 100), 0);
});

test('shouldFinishNearEnd: leaves at the tail, but NEVER right after a video swap', () => {
  const base = { duration: 180, current: 179, now: 100000, swapAt: 0 };
  assert.equal(shouldFinishNearEnd(base), true, 'a real tail must end the video');

  // THE bug this guards: after loadVideoById, getDuration() briefly still reports the OLD
  // video while getCurrentTime() is ~0. Naively that reads as "1.5s from the end" and the
  // child is bounced out of the video they just picked.
  assert.equal(shouldFinishNearEnd({ ...base, current: 0.2 }), false, 'no real progress yet');
  assert.equal(shouldFinishNearEnd({ ...base, swapAt: 99500 }), false, 'inside the swap grace');

  // the id check is the authoritative guard — a SLOW swap outlives the wall clock
  assert.equal(shouldFinishNearEnd({ ...base, swapAt: 98000, expectedId: 'B', reportedId: 'A' }), false,
    'the player is still reporting the previous video');
  assert.equal(shouldFinishNearEnd({ ...base, swapAt: 98000, expectedId: 'B', reportedId: 'B' }), true);
  // …and an unknown id must fall back to the clock, never block playback forever
  assert.equal(shouldFinishNearEnd({ ...base, expectedId: 'B', reportedId: null }), true);

  // a live stream / not-ready metadata reports duration 0 — ending there would kick the
  // child out the instant they opened it
  assert.equal(shouldFinishNearEnd({ ...base, duration: 0 }), false);
  assert.equal(shouldFinishNearEnd({ ...base, duration: NaN }), false);
  assert.equal(shouldFinishNearEnd({ ...base, current: NaN }), false);
  // mid-video is not the tail
  assert.equal(shouldFinishNearEnd({ ...base, current: 90 }), false);
  assert.equal(shouldFinishNearEnd({}), false, 'junk in never ends a video');
});

test('tvKeyIntent: a HELD remote key reveals, it does not scrub minutes', () => {
  // Android TV auto-repeats at ~30/s. Each event was a full ±10s seek, so one second on
  // the arrow jumped ~4 minutes — and running past the end ejected the child.
  assert.deepEqual(tvKeyIntent('fwd', { time: 10, duration: 200, repeat: true }), { kind: 'reveal' });
  assert.deepEqual(tvKeyIntent('back', { time: 10, duration: 200, repeat: true }), { kind: 'reveal' });
  assert.deepEqual(tvKeyIntent('toggle', { repeat: true }), { kind: 'reveal' });

  const fwd = tvKeyIntent('fwd', { time: 10, duration: 200 });
  assert.equal(fwd.kind, 'seek');
  assert.equal(fwd.to, 10 + SEEK_STEP);
  // clamped, exactly like the touch path
  assert.equal(tvKeyIntent('fwd', { time: 199, duration: 200 }).to, 199.5);
  assert.equal(tvKeyIntent('back', { time: 2, duration: 200 }).to, 0);
  assert.equal(tvKeyIntent('toggle', {}).kind, 'toggle');
  assert.equal(tvKeyIntent('reveal', {}).kind, 'reveal');
  // an unknown action must be IGNORED: dpad.js relies on a falsy handleTvKey() to leave
  // the key to the browser instead of preventDefault()ing it
  assert.equal(tvKeyIntent('nope', {}).kind, 'ignore');
  assert.equal(tvKeyIntent(undefined, {}).kind, 'ignore');
});

test('the tap constants still make a slow double-tap unambiguous', () => {
  // Pinned in config.test.mjs too, restated here because playerlogic/player.js is what
  // consumes them: if the single-tap delay were shorter than the double-tap window, a slow
  // double-tap would BOTH pause and seek.
  assert.ok(TAP_SINGLE_DELAY >= TAP_DOUBLE_MS, `${TAP_SINGLE_DELAY} < ${TAP_DOUBLE_MS}`);
  assert.ok(SEEK_STEP > 0);
});

test('isTapGesture: a swipe releasing over the shield is NOT a tap (v1.0.52)', () => {
  // The shield acts on pointerup with no threshold, so a swipe that ended over it read as
  // a tap — and a center release PAUSED the video the child was trying to scroll past.
  // touch-action:pan-y removes the vertical case (pointercancel), but a horizontal swipe
  // and every swipe while FULLSCREEN (nothing to scroll) still end in a pointerup here.
  assert.equal(isTapGesture(100, 100, 100, 100), true, 'a perfectly still press is a tap');
  assert.equal(isTapGesture(100, 100, 100 + TAP_SLOP_PX, 100), true, 'wobble on the boundary still counts');
  assert.equal(isTapGesture(100, 100, 100 + TAP_SLOP_PX + 1, 100), false, 'past the slop it is a swipe');
  assert.equal(isTapGesture(100, 100, 100, 180), false, 'a vertical drag is a swipe');
  assert.equal(isTapGesture(100, 100, 30, 100), false, 'direction does not matter');
  // the diagonal must not slip through an axis-only check: 12px on each axis is ~17px
  const d = Math.ceil(TAP_SLOP_PX * 0.9);
  assert.equal(isTapGesture(100, 100, 100 + d, 100 + d), false, 'a diagonal past the slop is a swipe');
});

/* ---------------- fullscreen orientation (v1.0.54) ---------------- */

test('fullscreenOrientation: landscape in, system rule out, hands off a TV', () => {
  assert.equal(fullscreenOrientation({ fullscreen: true, tv: false }), 'landscape');
  // the restore must NOT depend on any view state: leaveWatch exits fullscreen and then
  // navigates away, and a conditional restore leaves the whole app stuck sideways
  assert.equal(fullscreenOrientation({ fullscreen: false, tv: false }), 'auto');
  // a television has no sensor and is landscape by construction — never touch it
  assert.equal(fullscreenOrientation({ fullscreen: true, tv: true }), null);
  assert.equal(fullscreenOrientation({ fullscreen: false, tv: true }), null);
  // junk input behaves like "not fullscreen, not tv" — the safe restore direction
  assert.equal(fullscreenOrientation({}), 'auto');
  assert.equal(fullscreenOrientation(), 'auto');
});

/* ---------------- the fullscreen now-playing overlay (v1.0.53) ---------------- */

test('nowPlayingChannel: the family\'s own folder name outranks the record\'s enrichment', () => {
  const folders = [
    { id: 'ch:UC1', channelId: 'UC1', title: 'ערוץ שירים', logoUrl: 'https://x/logo.jpg' },
    { id: 'grp:UC3', channelId: 'UC3', title: 'אוסף בלוני', logoUrl: '' },
    { id: 'pl:PL9', channelId: 'PL9', title: 'רשימת השמעה' }
  ];
  // a subscribed channel's video: the folder title + its logo url
  assert.deepEqual(nowPlayingChannel({ channelId: 'UC1', folderId: 'ch:UC1', srcChannelTitle: 'stale' }, folders),
    { id: 'UC1', name: 'ערוץ שירים', logoUrl: 'https://x/logo.jpg' });
  // a 🎞️ virtual group single: the group carries channelId too
  assert.deepEqual(nowPlayingChannel({ srcChannelId: 'UC3', folderId: 'sheet' }, folders),
    { id: 'UC3', name: 'אוסף בלוני', logoUrl: null });
  // a legacy record with no channelId of its own: the id derives from its ch: folder
  assert.deepEqual(nowPlayingChannel({ folderId: 'ch:UC1' }, folders),
    { id: 'UC1', name: 'ערוץ שירים', logoUrl: 'https://x/logo.jpg' });
});

test('nowPlayingChannel: a playlist video names its OWNER, never the playlist', () => {
  // v1.0.26: a playlist video keeps the creator in channelId; the pl: folder's channelId
  // slot holds the PLAYLIST id, so it can never match a UC owner here.
  const folders = [
    { id: 'pl:PL9', channelId: 'PL9', title: 'רשימת השמעה' },
    { id: 'ch:UC1', channelId: 'UC1', title: 'הערוץ האמיתי' }
  ];
  assert.equal(nowPlayingChannel({ channelId: 'UC1', folderId: 'pl:PL9' }, folders).name, 'הערוץ האמיתי');
  // owner NOT subscribed: fall back to the enrichment name, logo url unknown
  assert.deepEqual(nowPlayingChannel({ channelId: 'UC2', srcChannelTitle: 'Pinkfong', folderId: 'pl:PL9' }, folders),
    { id: 'UC2', name: 'Pinkfong', logoUrl: null });
});

test('nowPlayingChannel: no name means NO line — never an unlabeled logo', () => {
  // an id with no resolvable name would render a logo that tells the child nothing
  assert.equal(nowPlayingChannel({ channelId: 'UC9', folderId: 'ch:UC9' }, []), null);
  // a personal/file video belongs to no channel at all
  assert.equal(nowPlayingChannel({ folderId: 'mine' }, []), null);
  assert.equal(nowPlayingChannel(null, []), null);
  // junk folders input must not throw mid-watch
  assert.equal(nowPlayingChannel({ folderId: 'mine' }, null), null);
});

test('isTapGesture: missing coordinates fail OPEN — the tap must survive an odd WebView', () => {
  // Refusing would make every tap dead on a device whose pointer events carry no
  // coordinates; accepting is the pre-v1.0.52 status quo, the recoverable direction.
  assert.equal(isTapGesture(NaN, NaN, 100, 100), true);
  assert.equal(isTapGesture(undefined, undefined, 100, 100), true);
  assert.equal(isTapGesture(100, 100, undefined, undefined), true);
});

/* ---------------- continuous play (v1.0.25) ---------------- */

const chain = (over = {}) => planAutoplay({ enabled: true, folderId: 'ch:UC1', ...over });

test('continuous play is OFF unless the parent turned it on', () => {
  // Default off is the whole safety position: a family that never opens the settings
  // screen keeps today's behaviour, where a video ending returns the child to the folder.
  assert.deepEqual(planAutoplay(), { action: 'stop', reason: 'disabled' });
  assert.deepEqual(planAutoplay({}), { action: 'stop', reason: 'disabled' });
  assert.equal(planAutoplay({ enabled: false, folderId: 'ch:UC1' }).action, 'stop');
  // …and being off outranks everything else, including a perfectly good next video
  assert.equal(planAutoplay({ enabled: false, hasNext: true, reason: 'ended' }).action, 'stop');
});

test('the 🎁 folder is NEVER chained, whatever the setting says', () => {
  // Unwrapping is one-way and permanent (unwrappedAt is min-merged forever, on every
  // device), so an unattended chain would open the child's whole queue of new videos in
  // one sitting with no way to put them back. Parent's decision, 2026-08-02.
  assert.deepEqual(chain({ folderId: 'new' }), { action: 'stop', reason: 'gift' });
  assert.equal(chain({ folderId: 'new', hasNext: true }).action, 'stop');
  assert.equal(chain({ folderId: 'new', reason: 'error' }).action, 'stop',
    'even a failure in the gift folder must not start a chain');
});

test('a chain STOPS at a wrapped gift, in any folder', () => {
  // Gift state lives per child on the video, so wrapped tiles appear inside channel
  // folders too — not only in 🎁. The first TAP on one unwraps it and deliberately does
  // NOT play. A chain that opened it would skip that ritual AND leave the tile wrapped
  // forever while its video had already been watched.
  assert.deepEqual(chain({ nextIsGift: true }), { action: 'stop', reason: 'next-is-gift' });
  // it outranks a failure too — a broken video must not "skip" INTO a gift
  assert.equal(chain({ nextIsGift: true, reason: 'error' }).action, 'stop');
  assert.equal(chain({ nextIsGift: true, reason: 'error', retriedCurrent: true }).action, 'stop');
  // and it is only consulted when there IS a next video
  assert.deepEqual(chain({ nextIsGift: true, hasNext: false }),
    { action: 'stop', reason: 'end-of-folder' });
  // an already-unwrapped video is a normal video
  assert.deepEqual(chain({ nextIsGift: false }), { action: 'next', reason: 'ended' });
});

test('a normal end plays the next video, and the last one stops', () => {
  assert.deepEqual(chain(), { action: 'next', reason: 'ended' });
  assert.deepEqual(chain({ hasNext: false }), { action: 'stop', reason: 'end-of-folder' });
});

test('a broken video is retried ONCE, then skipped', () => {
  // finish() fires for an embedding-disabled video too, so without this a chain skips
  // through dead content invisibly — the parent never learns the library has holes.
  assert.deepEqual(chain({ reason: 'error' }), { action: 'retry', reason: 'first-failure' });
  assert.deepEqual(chain({ reason: 'error', retriedCurrent: true }),
    { action: 'next', reason: 'skip-broken' });
  // a retried failure on the LAST video has nowhere to go
  assert.deepEqual(chain({ reason: 'error', retriedCurrent: true, hasNext: false }),
    { action: 'stop', reason: 'end-of-folder' });
});

test('a RUN of failures ends the chain — a black-screen loop is unrepresentable', () => {
  // THE ceiling. Without it a stretch of unplayable videos flips the screen forever.
  for (let f = 0; f < AUTOPLAY_MAX_FAILURES - 1; f++) {
    assert.notEqual(chain({ reason: 'error', failures: f, retriedCurrent: true }).action, 'stop',
      `gave up after only ${f} failures`);
  }
  assert.deepEqual(chain({ reason: 'error', failures: AUTOPLAY_MAX_FAILURES - 1, retriedCurrent: true }),
    { action: 'stop', reason: 'too-many-failures' });
  assert.equal(chain({ reason: 'error', failures: 99 }).action, 'stop');
  // the ceiling outranks the retry: at the limit we stop rather than retry forever
  assert.equal(chain({ reason: 'error', failures: AUTOPLAY_MAX_FAILURES - 1, retriedCurrent: false }).action,
    'stop', 'the retry branch let the chain past its own ceiling');
});

test('nextInOrder follows the ORDER THE CHILD SEES, and never wraps', () => {
  const list = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.equal(nextInOrder(list, 'a').key, 'b');
  assert.equal(nextInOrder(list, 'b').key, 'c');
  // the last video has no next — a chain must END, not loop back to the start
  assert.equal(nextInOrder(list, 'c'), null);
  // a video that is not in the list (deleted mid-play, or a different folder)
  assert.equal(nextInOrder(list, 'zzz'), null);
  assert.equal(nextInOrder([], 'a'), null);
  assert.equal(nextInOrder(null, 'a'), null, 'must never throw on a missing list');
  assert.equal(nextInOrder(undefined, undefined), null);
  // junk entries are skipped rather than counted as videos
  assert.equal(nextInOrder([{ key: 'a' }, null, { key: 'b' }], 'a').key, 'b');
});

test('the continuous-play timings are sane relative to each other', () => {
  // The countdown is the child's ONLY visible way out of a chain (the 🏠 button lives
  // outside the player and is invisible in fullscreen), so it must not be a blink.
  assert.ok(AUTOPLAY_COUNTDOWN_MS >= 3000, 'too short for a 5-year-old to notice and react');
  assert.ok(AUTOPLAY_COUNTDOWN_MS <= 10000, 'long enough to read as the video having frozen');
  assert.ok(AUTOPLAY_RETRY_MS > 0);
  assert.ok(Number.isInteger(AUTOPLAY_MAX_FAILURES) && AUTOPLAY_MAX_FAILURES >= 2,
    'a ceiling below 2 would give up on the first hiccup');
});

/* ---------------- the parent's preview bubble (v1.0.26) ---------------- */

test('the preview embed is MUTED, scrubbable, and never shows related videos', () => {
  // All three are silent when wrong. controls=1 is the reason the bubble exists at all —
  // the kid HUD hides the timeline and turns a centre tap into play/pause, which is
  // exactly backwards for a parent jumping through a video to check it. mute=1 is the
  // parent's decision (a child in the room, and browsers block unmuted autoplay anyway).
  const url = previewEmbedUrl({ type: 'youtube', id: 'dQw4w9WgXcQ' });
  assert.match(url, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.match(url, /(^|[?&])controls=1(&|$)/, 'no scrub bar — the parent cannot evaluate');
  assert.match(url, /(^|[?&])mute=1(&|$)/, 'it would blare in the room the child is in');
  assert.match(url, /(^|[?&])rel=0(&|$)/, "YouTube's related rail must never appear in-app");
  assert.match(url, /(^|[?&])autoplay=1(&|$)/);
  // the privacy host, like the kid player uses
  assert.ok(!url.includes('//www.youtube.com/'), 'the preview left the nocookie host');
});

test('previewBubbleButtons: the whole per-mode matrix, every cell load-bearing', () => {
  // v1.0.33 (review): the truth used to live in hand-ordered classList toggles inside
  // renderPreview — where the "live 🗑️ over a search result" bug was hand-avoided once
  // already. A wrong cell is a button that does nothing or destroys the wrong thing:
  //  - 'search' items have NO stored record → del there points at nothing;
  //  - approve/reject outside 'pending' would act on a record in the wrong state;
  //  - add outside 'search' would re-add something already stored.
  assert.deepEqual(previewBubbleButtons('pending'), { approve: true, reject: true, del: false, add: false });
  assert.deepEqual(previewBubbleButtons('library'), { approve: false, reject: false, del: true, add: false });
  assert.deepEqual(previewBubbleButtons('search'), { approve: false, reject: false, del: false, add: true });
  // an unknown mode must fail SAFE: nothing destructive, nothing additive
  assert.deepEqual(previewBubbleButtons('nonsense'), { approve: false, reject: false, del: false, add: false });
  assert.deepEqual(previewBubbleButtons(undefined), { approve: false, reject: false, del: false, add: false });
});

test('previewEmbedUrl refuses anything that is not a YouTube video', () => {
  // The caller falls back to a <video> element for a direct file, and must be able to
  // tell — a bogus embed URL is a permanently black box with no error.
  assert.equal(previewEmbedUrl({ type: 'file', url: 'https://x/a.mp4' }), null);
  assert.equal(previewEmbedUrl({ type: 'youtube', id: '' }), null);
  assert.equal(previewEmbedUrl({ type: 'youtube', id: 'too-short' }), null);
  assert.equal(previewEmbedUrl({ type: 'youtube', id: 'way-too-long-to-be-an-id' }), null);
  // an id carrying a query/fragment must never be pasted straight into the URL
  assert.equal(previewEmbedUrl({ type: 'youtube', id: 'abc&autoplay' }), null);
  assert.equal(previewEmbedUrl(null), null);
  assert.equal(previewEmbedUrl(), null);
});

/* ---------------- HUD time labels (v1.0.32) ---------------- */

test('formatTime renders m:ss below an hour and h:mm:ss above it', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(7), '0:07');
  assert.equal(formatTime(59.9), '0:59', 'floored — a second that has not finished must not show');
  assert.equal(formatTime(61), '1:01');
  assert.equal(formatTime(600), '10:00');
  assert.equal(formatTime(3599), '59:59');
  assert.equal(formatTime(3600), '1:00:00');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(7325), '2:02:05');
});

test('formatTime never leaks NaN/Infinity onto the child\'s screen', () => {
  // getDuration() answers 0 before metadata and Infinity for a live stream; getTime()
  // can answer NaN mid-teardown. Every one of those must read as the neutral 0:00.
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(Infinity), '0:00');
  assert.equal(formatTime(-5), '0:00');
  assert.equal(formatTime(undefined), '0:00');
  assert.equal(formatTime(null), '0:00');
  assert.equal(formatTime('90'), '1:30', 'numeric strings pass through Number()');
});

/* ---------------- Resume playback (v1.0.32) ---------------- */

test('resumeStartAt: rewinds a few seconds, and 0 whenever resuming makes no sense', () => {
  // The user's spec: re-entering a stopped video continues from RESUME_REWIND_SEC before
  // the stop point — a moment of context, like the YouTube app.
  assert.equal(resumeStartAt({ enabled: true, posSec: 60, durSec: 300 }), 60 - RESUME_REWIND_SEC);
  // OFF is the default and must behave exactly like today: always from the top.
  assert.equal(resumeStartAt({ enabled: false, posSec: 60, durSec: 300 }), 0);
  assert.equal(resumeStartAt({}), 0);
  // a stop too early to matter starts over (also mirrors what the save side refuses)
  assert.equal(resumeStartAt({ enabled: true, posSec: RESUME_MIN_POS_SEC - 1, durSec: 300 }), 0);
  // a STALE near-end position (app died before the 'ended' clear) must not drop the
  // child onto YouTube's end screen — start over instead
  assert.equal(resumeStartAt({ enabled: true, posSec: 295, durSec: 300 }), 0);
  // garbage never becomes a seek target
  assert.equal(resumeStartAt({ enabled: true, posSec: NaN, durSec: 300 }), 0);
  assert.equal(resumeStartAt({ enabled: true, posSec: undefined, durSec: undefined }), 0);
  // rewind can never produce a negative start
  assert.equal(resumeStartAt({ enabled: true, posSec: RESUME_MIN_POS_SEC, durSec: 300 }),
    Math.max(0, RESUME_MIN_POS_SEC - RESUME_REWIND_SEC));
});

test('resumeSaveDecision: save mid-video, clear in the tail, ignore the unusable', () => {
  assert.equal(resumeSaveDecision({ pos: 60, dur: 300 }), 'save');
  // inside the tail = effectively finished: clear, or every video "sticks" at its end
  assert.equal(resumeSaveDecision({ pos: 300 - RESUME_TAIL_SEC, dur: 300 }), 'clear');
  assert.equal(resumeSaveDecision({ pos: 299, dur: 300 }), 'clear');
  // a 2-second accidental tap must not throw away real progress -> ignore, not clear
  assert.equal(resumeSaveDecision({ pos: 2, dur: 300 }), 'ignore');
  // an unknown duration cannot tell the tail from the middle: never save a wrong point
  assert.equal(resumeSaveDecision({ pos: 60, dur: 0 }), 'ignore');
  assert.equal(resumeSaveDecision({ pos: 60, dur: Infinity }), 'ignore');
  assert.equal(resumeSaveDecision({ pos: NaN, dur: 300 }), 'ignore');
  assert.equal(resumeSaveDecision({}), 'ignore');
  // a SHORT video: the tail rule wins over the minimum, in both orders of magnitude
  assert.equal(resumeSaveDecision({ pos: 5, dur: 10 }), 'clear', 'a 10s clip is finished at 5s? no — inside the 12s tail');
});

test('watchedFraction: a bar only when both numbers are usable, clamped to [0,1]', () => {
  assert.equal(watchedFraction(150, 300), 0.5);
  assert.equal(watchedFraction(400, 300), 1, 'clamped — a stale over-long position');
  // mirrors the save floor: a position too small to resume never draws a sliver
  assert.equal(watchedFraction(RESUME_MIN_POS_SEC - 1, 300), null);
  assert.equal(watchedFraction(60, 0), null);
  assert.equal(watchedFraction(60, Infinity), null);
  assert.equal(watchedFraction(undefined, undefined), null);
});

/* ---------------- interrupted by a call (v1.0.57) ---------------- */

test('isCallAudioMode: telephony AND VoIP count, and ringing already counts', async () => {
  const { isCallAudioMode } = await import('../www/js/playerlogic.js');
  // MODE_IN_COMMUNICATION is what WhatsApp/Messenger report — the common case on a tablet
  // with no SIM at all, and precisely what a TelephonyManager listener would never see
  // (which is also why the native side reads AudioManager and needs no permission).
  assert.equal(isCallAudioMode('in_call'), true);
  assert.equal(isCallAudioMode('in_communication'), true);
  assert.equal(isCallAudioMode('ringtone'), true, 'the ring already interrupted the video');
  assert.equal(isCallAudioMode('IN_CALL'), true, 'case must not decide behaviour');
  assert.equal(isCallAudioMode('normal'), false);
  assert.equal(isCallAudioMode('other'), false);
  assert.equal(isCallAudioMode('unknown'), false);
  assert.equal(isCallAudioMode(null), false);
  assert.equal(isCallAudioMode(undefined), false);
});

test('planCallResume: a call arms, and ONLY an affirmative "normal" resumes', async () => {
  const { planCallResume } = await import('../www/js/playerlogic.js');
  const now = 1_000_000;
  const armed = { key: 'k', at: now - 5000 };
  assert.equal(planCallResume({ mode: 'ringtone', key: 'k', now }), 'arm');
  assert.equal(planCallResume({ mode: 'in_call', key: 'k', now }), 'arm');
  assert.equal(planCallResume({ armed, mode: 'normal', key: 'k', now }), 'resume');
  assert.equal(planCallResume({ armed, mode: 'in_call', key: 'k', now }), null, 'still on the call — wait');
  // ⚠️ THE HOLE THE MATRIX FOUND, and the reason this test exists: the first version read
  // "not a call mode ⇒ the call ended", which made 'unknown' — a failed bridge, an APK
  // built before the native method existed, a browser — mean "play it". Then ANY pause
  // would resume, which is the exact opposite of the user's "calls only" decision.
  assert.equal(planCallResume({ armed, mode: 'unknown', key: 'k', now }), null,
    'unknown is not evidence that a call ended');
  assert.equal(planCallResume({ armed, mode: 'other', key: 'k', now }), null,
    'an unrecognised mode (call screening) is not evidence either');
  // and nothing arms without evidence of a call
  assert.equal(planCallResume({ mode: 'normal', key: 'k', now }), null);
  assert.equal(planCallResume({ mode: 'unknown', key: 'k', now }), null);
});

test('planCallResume: every way for the intent to go stale disarms it', async () => {
  const { planCallResume } = await import('../www/js/playerlogic.js');
  const { CALL_RESUME_MAX_MS } = await import('../www/js/config.js');
  const now = 1_000_000;
  const armed = { key: 'k', at: now - 5000 };
  // playing = the child pressed play themselves (or we already resumed). A live intent
  // left behind would fire at some unrelated later pause.
  assert.equal(planCallResume({ armed, mode: 'in_call', key: 'k', playing: true, now }), 'disarm');
  // the child left the video, or a scheduled break took the screen
  assert.equal(planCallResume({ armed, mode: 'normal', key: 'k', inWatch: false, now }), 'disarm');
  assert.equal(planCallResume({ armed, mode: 'normal', key: null, now }), 'disarm');
  // a DIFFERENT video is up now — the intent belongs to one video
  assert.equal(planCallResume({ armed, mode: 'normal', key: 'other', now }), 'disarm');
  // it expires: after a quarter of an hour the call is no longer "what just interrupted
  // us", and starting the video then is a surprise noise, not a convenience
  assert.equal(planCallResume({ armed: { key: 'k', at: now - CALL_RESUME_MAX_MS - 1 }, mode: 'normal', key: 'k', now }), 'disarm');
  assert.equal(planCallResume({ armed: { key: 'k', at: now - CALL_RESUME_MAX_MS + 1 }, mode: 'normal', key: 'k', now }), 'resume');
  assert.equal(planCallResume({ armed: { key: 'k', at: 'nonsense' }, mode: 'normal', key: 'k', now }), 'disarm');
  // nothing armed and nothing to do
  assert.equal(planCallResume({ inWatch: false }), null);
  assert.equal(planCallResume({}), null);
  assert.equal(planCallResume(), null);
});

/* ---------------- background playback (v1.0.63) ---------------- */

test('backgroundPlayDecision: opt-in, own files only, and never a paused video', async () => {
  const { backgroundPlayDecision } = await import('../www/js/playerlogic.js');
  const file = { type: 'file', title: 'שיר' };
  const yt = { type: 'youtube', id: 'abc' };
  // the default is today's behaviour: a family that never opens the setting keeps the pause
  assert.deepEqual(backgroundPlayDecision({ enabled: false, playing: true, item: file }),
    { play: false, why: 'off' });
  assert.deepEqual(backgroundPlayDecision({ enabled: true, playing: true, item: file }),
    { play: true, why: 'ok' });
  // ⚠️ YOUTUBE IS EXCLUDED BY DESIGN (the user's decision): the IFrame player is a WebView
  // Android may throttle or evict once the app is backgrounded, so "background YouTube"
  // would be a promise the app cannot keep.
  assert.deepEqual(backgroundPlayDecision({ enabled: true, playing: true, item: yt }),
    { play: false, why: 'youtube' });
  // a video the child had ALREADY PAUSED must stay paused — otherwise the app starts making
  // noise in a pocket for a video nobody was watching (the v1.0.57 call-resume rule)
  assert.deepEqual(backgroundPlayDecision({ enabled: true, playing: false, item: file }),
    { play: false, why: 'not-playing' });
  assert.deepEqual(backgroundPlayDecision({ enabled: true, playing: true, item: null }),
    { play: false, why: 'no-item' });
  assert.equal(backgroundPlayDecision({}).play, false);
  assert.equal(backgroundPlayDecision().play, false);
});

test('seekRelative goes through the CLAMP, on every engine (v1.0.68)', async () => {
  const { tvKeyIntent } = await import('../www/js/playerlogic.js');
  const { SEEK_STEP } = await import('../www/js/config.js');
  // ⚠️ The notification's ⏪/⏩ are a THIRD seek surface (touch, remote, now this), and the
  // clamp is what stops a forward seek running past the end — where the engine fires ENDED
  // → finish() → onExit and the child is EJECTED from the video (v1.0.22, paid for once).
  const near = tvKeyIntent('fwd', { time: 100, duration: 101 });
  assert.equal(near.kind, 'seek');
  assert.ok(near.to < 101, 'a forward seek near the end must be clamped, or the child is ejected');
  // …and the step is the SAME ten seconds a double-tap on the video gives, so the
  // notification and the screen can never disagree about what a skip means
  assert.equal(tvKeyIntent('fwd', { time: 10, duration: 600 }).to, 10 + SEEK_STEP);
  assert.equal(tvKeyIntent('back', { time: 60, duration: 600 }).to, 60 - SEEK_STEP);
  assert.equal(tvKeyIntent('back', { time: 2, duration: 600 }).to, 0, 'never before the start');
  // an unknown action must not seek at all — the notification can only ever send two
  assert.equal(tvKeyIntent('sideways', { time: 10, duration: 600 }).kind, 'ignore');
});

test('planCallResume: a call resumes only what a CALL stopped (v1.0.72)', async () => {
  const { planCallResume } = await import('../www/js/playerlogic.js');
  const base = { inWatch: true, key: 'yt:a', now: 1000 };

  // THE REPORTED BUG, as a test. A parent paused the audio, went off to do something else,
  // took a call — and the song played when the call ended. The lifecycle door always checked
  // "was it playing?"; the POLL (which exists because a heads-up call fires no lifecycle
  // event at all) saw only "not playing" and could not tell the two pauses apart.
  assert.equal(planCallResume({ ...base, armed: null, mode: 'in_call', playing: false, userPaused: true }), null,
    'a call armed a resume for a video the person had deliberately paused');

  // …while a call that really did interrupt playback still arms
  assert.equal(planCallResume({ ...base, armed: null, mode: 'in_call', playing: false, userPaused: false }), 'arm');
  assert.equal(planCallResume({ ...base, armed: null, mode: 'in_communication', playing: false }), 'arm',
    'VoIP (WhatsApp) is a call too');

  // and once armed, the end of the call still resumes: the flag guards ARMING, which is
  // where the two pauses are indistinguishable
  const armed = { key: 'yt:a', at: 900 };
  assert.equal(planCallResume({ ...base, armed, mode: 'normal', playing: false }), 'resume');

  // the rules that were already true stay true
  assert.equal(planCallResume({ ...base, armed: null, mode: 'normal', playing: false }), null,
    'no call, no arming');
  assert.equal(planCallResume({ ...base, armed, mode: 'unknown', playing: false }), null,
    'only an affirmative "normal" resumes — a failed bridge must never mean "play it"');
  assert.equal(planCallResume({ ...base, armed, mode: 'normal', playing: false, key: 'yt:b' }), 'disarm',
    'a different video is up now');
  assert.equal(planCallResume({ ...base, armed, mode: 'normal', playing: false, inWatch: false }), 'disarm');
});

test('opensFullscreen: only a KNOWN audio file opts out (v1.0.73)', async () => {
  const { opensFullscreen } = await import('../www/js/playerlogic.js');
  // the request: an audio file plays in the ordinary player, not fullscreen
  assert.equal(opensFullscreen({ type: 'file', media: 'audio' }), false);
  // …everything else keeps the v1.0.2 behaviour
  assert.equal(opensFullscreen({ type: 'file', media: 'video' }), true);
  assert.equal(opensFullscreen({ type: 'youtube', id: 'abc' }), true);
  // ⚠️ UNKNOWN IS TREATED AS VIDEO, and that is the safe direction. `media` is null for a
  // record nothing has enriched yet (a share, a links-file row, a peer on an older app) and
  // is only CORRECTED at loadedmetadata — long after the tap. Reading null as audio would
  // open real videos windowed; reading it as video keeps exactly today's behaviour.
  assert.equal(opensFullscreen({ type: 'file', media: null }), true);
  assert.equal(opensFullscreen({ type: 'file' }), true);
  // a YouTube record can never be 'audio' — the field belongs to files
  assert.equal(opensFullscreen({ type: 'youtube', media: 'audio' }), true);
  assert.equal(opensFullscreen(null), false);
  assert.equal(opensFullscreen(), false);
});

/* ---------------- picture-in-picture (v1.0.76) ---------------- */

test('pipEligibility: opt-in, both engines, playing only — and EVERY lock refuses it', async () => {
  const { pipEligibility } = await import('../www/js/playerlogic.js');
  const file = { type: 'file', title: 'שיר' };
  const yt = { type: 'youtube', id: 'abc' };
  const base = { enabled: true, supported: true, tv: false, watching: true, playing: true };
  // ⚠️ YOUTUBE IS INCLUDED (user decision 2026-09-06) — the opposite of bgPlay, and the
  // reason is structural: in PiP the activity stays VISIBLE, so the WebView is never
  // throttled or evicted. The bgPlay exclusion rationale does not apply.
  assert.deepEqual(pipEligibility({ ...base, item: yt }), { eligible: true, why: 'ok' });
  assert.deepEqual(pipEligibility({ ...base, item: file }), { eligible: true, why: 'ok' });
  // the default is today's behaviour: HOME pauses, nothing floats
  assert.deepEqual(pipEligibility({ ...base, item: file, enabled: false }),
    { eligible: false, why: 'off' });
  // ⚠️ EVERY LOCK REFUSES PiP — the floating window sits over the LAUNCHER, i.e. it is a
  // door out of the app, which is exactly what these locks exist to close.
  assert.deepEqual(pipEligibility({ ...base, item: file, kiosk: true }),
    { eligible: false, why: 'locked' });
  assert.deepEqual(pipEligibility({ ...base, item: file, contained: true }),
    { eligible: false, why: 'locked' });
  // a lock outranks the setting being on AND a video playing — order of refusals is safety-first
  assert.equal(pipEligibility({ ...base, item: file, kiosk: true, enabled: true }).eligible, false);
  // a paused video backgrounds normally (YouTube's own behaviour): no frozen frame floats
  assert.deepEqual(pipEligibility({ ...base, item: file, playing: false }),
    { eligible: false, why: 'paused' });
  // no watch view / no item = nothing to shrink
  assert.deepEqual(pipEligibility({ ...base, item: null }), { eligible: false, why: 'no-video' });
  assert.deepEqual(pipEligibility({ ...base, item: file, watching: false }),
    { eligible: false, why: 'no-video' });
  // unsupported device / TV: refused before anything else, whatever the setting says
  assert.deepEqual(pipEligibility({ ...base, item: file, supported: false }),
    { eligible: false, why: 'unsupported' });
  assert.deepEqual(pipEligibility({ ...base, item: file, tv: true }),
    { eligible: false, why: 'unsupported' });
  assert.equal(pipEligibility({}).eligible, false);
  assert.equal(pipEligibility().eligible, false);
});

test('pipSkipTarget: grid order, gifts skipped never opened, no wrap-around', async () => {
  const { pipSkipTarget } = await import('../www/js/playerlogic.js');
  const keys = ['a', 'b', 'c', 'd'];
  assert.equal(pipSkipTarget({ keys, currentKey: 'b', dir: 1 }), 'c');
  assert.equal(pipSkipTarget({ keys, currentKey: 'b', dir: -1 }), 'a');
  // ⚠️ A WRAPPED GIFT IS SKIPPED, NEVER OPENED (the v1.0.63 rule): its first TAP unwraps
  // and deliberately does not play — starting it from a floating window would consume the
  // video while leaving the tile wrapped forever.
  const gift = (k) => k === 'c';
  assert.equal(pipSkipTarget({ keys, currentKey: 'b', dir: 1, isGift: gift }), 'd');
  // a run of gifts to the end = nothing to skip to
  assert.equal(pipSkipTarget({ keys, currentKey: 'b', dir: 1, isGift: (k) => k === 'c' || k === 'd' }), null);
  // NO WRAP-AROUND — a chain that loops would play all night
  assert.equal(pipSkipTarget({ keys, currentKey: 'd', dir: 1 }), null);
  assert.equal(pipSkipTarget({ keys, currentKey: 'a', dir: -1 }), null);
  // a current video not on the track (folder changed under us) = dead button, not a jump
  assert.equal(pipSkipTarget({ keys, currentKey: 'zz', dir: 1 }), null);
  // a THROWING gift predicate reads as "gift" — unknown must skip, never open (fail closed)
  assert.equal(pipSkipTarget({ keys: ['a', 'b'], currentKey: 'a', dir: 1, isGift: () => { throw new Error('x'); } }), null);
  assert.equal(pipSkipTarget({}), null);
  assert.equal(pipSkipTarget(), null);
});
