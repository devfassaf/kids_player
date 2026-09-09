// Quota math — the 111-unit figure is an executable assertion, not a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchIds, quotaCostFor, shouldThrottle, uploadsPlaylistIdFor, longFormPlaylistIdFor,
  shortsPlaylistIdFor, planBackfillPlaylist, planChannelFetch,
  planCapNote, planCapRearm } from '../www/js/quota.js';

test('batchIds: sizes, dedupe, order', () => {
  assert.deepEqual(batchIds([]), []);
  assert.equal(batchIds(Array.from({ length: 50 }, (_, i) => 'v' + i)).length, 1);
  const two = batchIds(Array.from({ length: 51 }, (_, i) => 'v' + i));
  assert.equal(two.length, 2);
  assert.equal(two[0].length, 50);
  assert.equal(two[1].length, 1);
  assert.deepEqual(batchIds(['a', 'b', 'a']), [['a', 'b']]);
});

test('10 channels × 500 videos costs exactly 111 units (1.1% of the daily quota)', () => {
  const cost = quotaCostFor({
    handleResolves: 10,                        // worst case, one-time ever (cached forever)
    channelBatches: 1,                         // 10 ids in ONE channels.list call
    backfillPages: 10 * Math.ceil(500 / 50),   // playlistItems.list, 50/page
    titleBatches: 0                            // titles ride along in playlistItems.snippet
  });
  assert.equal(cost, 111);
});

test('shouldThrottle boundary at the soft cap', () => {
  assert.equal(shouldThrottle(7999, 1), false);
  assert.equal(shouldThrottle(7999, 2), true);
  assert.equal(shouldThrottle(8001, 0), true);
});

test('uploads playlist derivation: UC->UU, rejects non-UC', () => {
  assert.equal(uploadsPlaylistIdFor('UCabcdefghijklmnopqrstuv'), 'UUabcdefghijklmnopqrstuv');
  assert.equal(uploadsPlaylistIdFor('PLwhatever'), null);
  assert.equal(uploadsPlaylistIdFor(''), null);
});

test('planChannelFetch truth table', () => {
  const now = 1000 * 60 * 60; // 1h
  assert.equal(planChannelFetch({}, now, true), 'resolve');
  assert.equal(planChannelFetch({ uploadsPlaylistId: 'UUx' }, now, true), 'backfill');
  assert.equal(planChannelFetch({ uploadsPlaylistId: 'UUx' }, now, false), 'rss');
  assert.equal(planChannelFetch({ uploadsPlaylistId: 'UUx', backfillDone: true, lastRssCheckedAt: now - 31 * 60 * 1000 }, now, true), 'rss');
  assert.equal(planChannelFetch({ uploadsPlaylistId: 'UUx', backfillDone: true, lastRssCheckedAt: now - 5 * 60 * 1000 }, now, true), 'skip');
});

test('v1.0.18: rearming the cursor on unsubscribe restores a full backfill', () => {
  const now = Date.now();
  // The state db.deleteLibraryChannel leaves behind once no library subscribes.
  // Before the fix the record kept backfillDone:true, so a re-subscribe planned
  // 'rss' and only the ~15 videos in the feed window ever returned — the rest of
  // the channel's back catalogue was unreachable forever.
  const exhausted = { uploadsPlaylistId: 'UUx', backfillDone: true, backfillCursor: 'CAUQAA', lastRssCheckedAt: now };
  assert.equal(planChannelFetch(exhausted, now, true), 'skip');

  const rearmed = { ...exhausted, backfillDone: false, backfillCursor: null };
  assert.equal(planChannelFetch(rearmed, now, true), 'backfill');
  // keyless installs still fall back to the free RSS path
  assert.equal(planChannelFetch(rearmed, now, false), 'rss');
  // the playlist id is deliberately KEPT, so re-subscribing costs no resolve call
  assert.notEqual(planChannelFetch(rearmed, now, true), 'resolve');
});

test('the LONG-FORM and SHORTS sibling playlists are derived from the channel id', () => {
  // v1.0.21 — this is the whole Shorts-exclusion mechanism: `UULF…` is the channel's
  // "Videos" tab and `UUSH…` its Shorts, both reachable with the SAME
  // playlistItems.list call and zero extra quota. Measured 2026-07-31 on Cocomelon /
  // Blippi / Super Simple Songs: UULF ∪ UUSH == UU, no overlap, no leftovers.
  const CH = 'UCabcdefghijklmnopqrstuv';
  assert.equal(longFormPlaylistIdFor(CH), 'UULFabcdefghijklmnopqrstuv');
  assert.equal(shortsPlaylistIdFor(CH), 'UUSHabcdefghijklmnopqrstuv');
  // all three variants keep the channel's 22-char tail, so they address one channel
  const tail = CH.slice(2);
  for (const id of [uploadsPlaylistIdFor(CH), longFormPlaylistIdFor(CH), shortsPlaylistIdFor(CH)]) {
    assert.ok(id.endsWith(tail), id);
  }
  assert.notEqual(longFormPlaylistIdFor(CH), uploadsPlaylistIdFor(CH));
  // same strict guard as the uploads id — junk in must never become a playlist id
  for (const junk of ['PLwhatever', '', null, undefined, 'UCshort', 'UUabcdefghijklmnopqrstuv', 42]) {
    assert.equal(longFormPlaylistIdFor(junk), null, String(junk));
    assert.equal(shortsPlaylistIdFor(junk), null, String(junk));
  }
});

test('planBackfillPlaylist: a cursor earned on another playlist is RESET, never reused', () => {
  const CH = 'UCabcdefghijklmnopqrstuv';
  const UULF = 'UULFabcdefghijklmnopqrstuv';

  // a page token is POSITIONAL and belongs to ONE playlist. A device upgrading mid-backfill
  // held a UU… token; reusing it against UULF… either resumed at a meaningless offset
  // (skipping a slice of the back catalogue, then latching backfillDone) or was rejected,
  // writing the bad token back so the channel returned 'backfill' forever and never
  // delivered another video.
  assert.deepEqual(planBackfillPlaylist({ channelId: CH, backfillCursor: 'CAUQAA' }),
    { playlistId: UULF, resetCursor: true }, 'a legacy UU cursor was trusted');
  assert.deepEqual(planBackfillPlaylist({ channelId: CH, backfillCursor: 'CAUQAA', backfillPlaylistId: 'UUabcdefghijklmnopqrstuv' }),
    { playlistId: UULF, resetCursor: true });

  // a cursor earned against THIS playlist is kept — resuming is the whole point
  assert.deepEqual(planBackfillPlaylist({ channelId: CH, backfillCursor: 'CAUQAA', backfillPlaylistId: UULF }),
    { playlistId: UULF, resetCursor: false });
  // nothing to reset when there is no cursor
  assert.deepEqual(planBackfillPlaylist({ channelId: CH }), { playlistId: UULF, resetCursor: false });

  // NO UU FALLBACK. When no long-form id can be derived the caller must SKIP: substituting
  // the uploads playlist would import the very Shorts this release excludes.
  for (const junk of [{}, { channelId: 'PLnope' }, { channelId: '' }, { channelId: null }]) {
    const got = planBackfillPlaylist(junk);
    assert.equal(got.playlistId, null, JSON.stringify(junk));
    assert.ok(!String(got.playlistId || '').startsWith('UU') || got.playlistId === null);
  }
});

test('quotaCostFor accounts for the playlists stage', () => {
  // the stage can spend up to PLAYLIST_PAGE_BUDGET units per run; a cost model that
  // omits it under-estimates every capacity decision built on it
  assert.equal(quotaCostFor({ playlistPages: 20 }), 20);
  assert.equal(quotaCostFor({ handleResolves: 1, channelBatches: 1, backfillPages: 40, titleBatches: 2, playlistPages: 20 }), 64);
  assert.equal(quotaCostFor({}), 0);
});

/* ---------------- v1.0.91: a backfill the ceiling latched can be walked again ---------------- */

const DAY = 24 * 60 * 60 * 1000;
const CH = 'UCabcdefghijklmnopqrstuv';
// a channel that finished its walk while the library was full — the reported shape
const latched = (extra = {}) => ({
  channelId: CH, uploadsPlaylistId: 'UU' + CH.slice(2),
  backfillCursor: null, backfillDone: true, backfillPlaylistId: 'UULF' + CH.slice(2),
  ...extra
});

test('planCapNote: a LATCHED walk that lost content to a cap is remembered — and only once', () => {
  // THE REPORTED DEFECT: sync2 persists backfillDone per PAGE, before planMutations has
  // judged anything, so a full library latches the walk and then refuses everything it
  // fetched. Nothing else can reconstruct that afterwards — a capped drop writes neither
  // a record nor a tombstone — so the loss has to be written down while it is known.
  const got = planCapNote(latched(), 34, 1000);
  assert.deepEqual(got, { note: true, fields: { backfillCappedAt: 1000 } });

  // the playlists tab latches the same way (planPlaylistAdvance) and feeds the same cap
  assert.equal(planCapNote({ channelId: CH, playlistsDone: true }, 5, 1000).note, true);

  // A WALK STILL IN PROGRESS IS NEVER NOTED: it has pages left and will fetch them, and
  // whichever run finishes it is the run that latches — and notes.
  assert.equal(planCapNote({ channelId: CH, backfillDone: false, backfillCursor: 'tok' }, 34).note, false);

  // no cap, nothing to remember
  assert.equal(planCapNote(latched(), 0).note, false);

  // IDEMPOTENT. A library sitting at the ceiling caps on every sync; re-stamping would
  // rewrite every channel record every run (the churn-free rule planMutations is held to).
  // Keeping the FIRST stamp is also the more informative value.
  assert.equal(planCapNote(latched({ backfillCappedAt: 500 }), 34, 9000).note, false);
});

test('planCapNote is TOTAL: junk is "nothing happened", never a throw', () => {
  for (const ch of [null, undefined, 0, '', 'nope', []]) {
    assert.deepEqual(planCapNote(ch, 34), { note: false, fields: null }, String(ch));
  }
  for (const n of [null, undefined, NaN, Infinity, -1, 0, '34', {}]) {
    assert.equal(planCapNote(latched(), n).note, false, String(n));
  }
  // a junk clock must still produce a USABLE stamp, or the re-arm can never read it
  const got = planCapNote(latched(), 3, NaN);
  assert.equal(got.note, true);
  assert.ok(Number.isFinite(got.fields.backfillCappedAt) && got.fields.backfillCappedAt > 0);
});

test('planCapRearm: THE HEADROOM GATE — a still-full library never buys a re-walk', () => {
  const ch = latched({ backfillCappedAt: 1000 });
  const base = { channel: ch, maxTotal: 20000, hasKey: true, headroom: 500, now: 10 * DAY };

  // the run that capped: the library is AT the ceiling, so there is nothing to walk into.
  // This is the whole reason the note and the re-arm are two separate questions.
  assert.equal(planCapRearm({ ...base, total: 20000 }).rearm, false);
  // and one video freed is not room — 40 pages per channel for one slot is the runaway
  assert.equal(planCapRearm({ ...base, total: 19999 }).rearm, false);
  // the boundary: exactly the margin qualifies, one short of it does not
  assert.equal(planCapRearm({ ...base, total: 19500 }).rearm, true);
  assert.equal(planCapRearm({ ...base, total: 19501 }).rearm, false);
  // real room
  assert.equal(planCapRearm({ ...base, total: 12000 }).rearm, true);
});

test('planCapRearm: the re-armed record is the walk reset AND the note consumed', () => {
  const ch = latched({ backfillCappedAt: 1000, playlistsDone: true, playlistQueue: ['PL1'], noLongForm: true });
  const { rearm, fields } = planCapRearm({
    channel: ch, total: 1000, maxTotal: 20000, hasKey: true, now: 7 * DAY
  });
  assert.equal(rearm, true);
  assert.deepEqual(fields, {
    backfillCursor: null, backfillDone: false, backfillPlaylistId: null,
    playlistCursor: null, playlistQueue: null, playlistsDone: false,
    backfillCappedAt: null, backfillRearmedAt: 7 * DAY
  });
  // THE NOTE IS CONSUMED, or the next run re-arms a walk that is already running.
  assert.equal(fields.backfillCappedAt, null);
  // `noLongForm` IS NOT TOUCHED: it records a 404 on the derived long-form playlist — a
  // fact about the channel, nothing to do with the cap — and clearing it would buy a
  // probe on every recovery for a genuinely Shorts-only channel.
  assert.ok(!('noLongForm' in fields));
});

test('planCapRearm: every refusal fails toward the STATUS QUO (doing nothing)', () => {
  const ok = { total: 1000, maxTotal: 20000, hasKey: true, now: 7 * DAY };

  // nothing was ever lost here — the overwhelming majority of channels
  assert.equal(planCapRearm({ ...ok, channel: latched() }).rearm, false);

  // NO API KEY ⇒ planChannelFetch can only answer 'rss' ⇒ a re-armed walk fetches
  // nothing at all. Refusing keeps the note for the day a key arrives; re-arming would
  // spend it for nothing.
  assert.equal(planCapRearm({ ...ok, hasKey: false, channel: latched({ backfillCappedAt: 1 }) }).rearm, false);

  // an unreadable library size or ceiling cannot be gated on — refuse rather than guess
  const ch = latched({ backfillCappedAt: 1 });
  for (const bad of [null, undefined, NaN, Infinity, -1, '1000', {}]) {
    assert.equal(planCapRearm({ ...ok, channel: ch, total: bad }).rearm, false, 'total ' + String(bad));
  }
  for (const bad of [null, undefined, NaN, Infinity, 0, -5, '20000']) {
    assert.equal(planCapRearm({ ...ok, channel: ch, maxTotal: bad }).rearm, false, 'maxTotal ' + String(bad));
  }
  for (const bad of [null, undefined, 0, '', 'nope', []]) {
    assert.deepEqual(planCapRearm({ ...ok, channel: bad }), { rearm: false, fields: null }, String(bad));
  }
  assert.deepEqual(planCapRearm(), { rearm: false, fields: null });
  assert.deepEqual(planCapRearm({}), { rearm: false, fields: null });
});

test('planCapRearm: a junk margin falls back to the CONFIGURED one, never to zero', () => {
  // ZERO IS THE RUNAWAY ITSELF — "re-arm the moment one slot opens" is exactly what this
  // gate exists to prevent — so it can only ever be a typo. The planRejectedPurge rule:
  // a nonsense config value falls back to the default, never to the dangerous end.
  const ch = latched({ backfillCappedAt: 1 });
  const near = { channel: ch, total: 19999, maxTotal: 20000, hasKey: true, now: 7 * DAY };
  for (const bad of [0, -1, null, NaN, Infinity, '500', {}, undefined]) {
    assert.equal(planCapRearm({ ...near, headroom: bad }).rearm, false,
      'a ' + String(bad) + ' margin re-armed on one free slot');
  }
  // a deliberate, larger margin is honoured in the other direction
  assert.equal(planCapRearm({ ...near, total: 18000, headroom: 5000 }).rearm, false);
  assert.equal(planCapRearm({ ...near, total: 14000, headroom: 5000 }).rearm, true);
});

test('planCapRearm: the COOLDOWN bounds the loop, not just the data (v1.0.58 rule)', () => {
  // The page budget already bounds ONE run at 40 pages across every channel. This bounds
  // the DAY: a library oscillating around the ceiling must not buy a sweep on every home
  // entry, and the guarantee must not rest on an argument about deny tombstones.
  const ch = latched({ backfillCappedAt: 1, backfillRearmedAt: 10 * DAY });
  const base = { channel: ch, total: 1000, maxTotal: 20000, hasKey: true };
  assert.equal(planCapRearm({ ...base, now: 10 * DAY + 1000 }).rearm, false);
  assert.equal(planCapRearm({ ...base, now: 11 * DAY - 1 }).rearm, false);
  assert.equal(planCapRearm({ ...base, now: 11 * DAY }).rearm, true);
  // A channel that has NEVER re-armed is not held back: an absent stamp reads as 0, and
  // any real clock is decades past the cooldown. (A device whose clock says 1970 refuses
  // its first recovery for a day — the harmless direction, and the only one available:
  // an absent stamp cannot be told from a broken clock.)
  assert.equal(planCapRearm({ ...base, channel: latched({ backfillCappedAt: 1 }), now: Date.now() }).rearm, true);
  assert.equal(planCapRearm({ ...base, channel: latched({ backfillCappedAt: 1 }), now: 400 * DAY }).rearm, true);
});

test('v1.0.91 end to end: cap → remember → wait → recover → and it TERMINATES', () => {
  // The reported field sequence, played out against the real helpers.
  let ch = latched();                       // the walk completed; the library was full
  const cap = 20000;

  // run 1 — 34 brand-new records refused at the ceiling
  const n1 = planCapNote(ch, 34, 1 * DAY);
  assert.equal(n1.note, true);
  ch = { ...ch, ...n1.fields };
  assert.equal(planCapRearm({ channel: ch, total: cap, maxTotal: cap, hasKey: true, now: 1 * DAY }).rearm,
    false, 'a full library must not re-walk');

  // run 2 — the parent has not freed anything yet. Nothing is written, nothing is fetched.
  assert.equal(planCapNote(ch, 34, 2 * DAY).note, false, 'the record must not churn every sync');
  assert.equal(planCapRearm({ channel: ch, total: cap, maxTotal: cap, hasKey: true, now: 2 * DAY }).rearm, false);

  // run 3 — the rolling window pruned 3000 videos. NOW the walk is re-armed.
  const r = planCapRearm({ channel: ch, total: 17000, maxTotal: cap, hasKey: true, now: 3 * DAY });
  assert.equal(r.rearm, true);
  ch = { ...ch, ...r.fields };
  assert.equal(ch.backfillDone, false, 'planChannelFetch must answer "backfill" again');
  assert.equal(planChannelFetch(ch, 3 * DAY, true), 'backfill');

  // run 4 — the re-walk is under way; a run mid-walk neither notes nor re-arms
  assert.equal(planCapNote(ch, 12, 3 * DAY).note, false);
  assert.equal(planCapRearm({ channel: ch, total: 17500, maxTotal: cap, hasKey: true, now: 4 * DAY }).rearm,
    false, 'the note was consumed — nothing may re-arm a walk that is already running');

  // run 5 — the walk finishes and fills the library again, so it is remembered again…
  ch = { ...ch, backfillDone: true, backfillCursor: null };
  const n5 = planCapNote(ch, 900, 5 * DAY);
  assert.equal(n5.note, true);
  ch = { ...ch, ...n5.fields };
  // …and the COOLDOWN, not just the ceiling, is what stops the next sweep the same day
  assert.equal(planCapRearm({ channel: ch, total: 10000, maxTotal: cap, hasKey: true, now: 3 * DAY + 60000 }).rearm,
    false, 'two full page budgets in one day');
  assert.equal(planCapRearm({ channel: ch, total: 10000, maxTotal: cap, hasKey: true, now: 5 * DAY }).rearm, true);

  // run 6 — the channel is whole: no drops, so no note, so nothing ever re-arms again.
  const done = { ...latched(), backfillRearmedAt: 5 * DAY };
  assert.equal(planCapNote(done, 0, 9 * DAY).note, false);
  assert.equal(planCapRearm({ channel: done, total: 10000, maxTotal: cap, hasKey: true, now: 99 * DAY }).rearm,
    false, 'the recovery must reach a fixed point, or it walks the catalogue for ever');
});
