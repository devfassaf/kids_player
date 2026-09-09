// planMutations/planGifts — the sync brain. The most valuable assertion in the whole
// suite: running the plan twice yields an EMPTY second diff (no churn, no re-gifting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planMutations, planGifts, shouldFlattenHome, shouldRecordGiftBaseline,
  isLooseRecord, planGiftRunawayRepair,
  acceptRssEntry, acceptPlaylistItem, planPlaylistAdvance, planNoLongForm, planLongFormOutage,
  attentionDot, parentLandingTab, pendingBulkAction, PARENT_TAB_IDS,
  planChannelLogo, LOGO_API_RETRY_MS, LOGO_SCRAPE_RETRY_MS,
  resolveWatchContext, planSyncDispatch, channelAddOutcome, planEntryRefresh,
  playlistVideoFolder, planRejectedPurge, shareOutcome, SHARE_REASONS,
  planChannelSections, NEW_CHANNEL_WINDOW_MS, planLogoCache, logoFirstPaint, planLogoDelivery,
  effectiveCaps, sourceDrops, keepNewestPerChannel, planChannelWindow, pruneReviewList, protectedWindowKeys, pruneConfirmText,
  favActive, mergeFavState, favouriteKeys, pinKeyAction, lockScreenContainment,
  externalContentChoice
} from '../www/js/plan.js';

import { MAX_ITEMS_TOTAL, MAX_ITEMS_PER_CHANNEL } from '../www/js/config.js';

const CH = 'UCabcdefghijklmnopqrstuv';
const cand = (over = {}) => ({
  scopeId: 'lib:1', key: 'yt:' + (over.id || 'aaaaaaaaaaa'), type: 'youtube',
  id: over.id || 'aaaaaaaaaaa', srcUrl: 'https://youtu.be/x', title: 'שיר',
  titleSource: 'rss', thumbUrl: 'https://i.ytimg.com/x.jpg', channelId: CH,
  folderId: 'ch:' + CH, origin: 'channel', publishedAt: 1000, autoApprove: true,
  ...over
});

test('denied keys are dropped and STAY dropped (defect-4 regression, 5 rounds)', () => {
  const deny = new Set(['yt:aaaaaaaaaaa']);
  let existing = new Map();
  for (let round = 0; round < 5; round++) {
    const plan = planMutations({ candidates: [cand()], existing, denySet: deny, now: 5000 });
    assert.equal(plan.puts.length, 0, `round ${round}`);
    assert.equal(plan.counts.denied, 1);
  }
});

test('autoApprove=false routes new videos to pending; approval survives re-sync', () => {
  const c = cand({ autoApprove: false });
  const p1 = planMutations({ candidates: [c], existing: new Map(), denySet: new Set(), now: 1 });
  assert.equal(p1.puts[0].state, 'pending');
  assert.deepEqual(p1.pendingKeys, ['yt:aaaaaaaaaaa']);

  // parent approved it since (existing shows live); re-sync must NOT flip it back
  const existing = new Map([[c.key, { ...p1.puts[0], state: 'live', approvedAt: 2, folderId: '~pending' }]]);
  const p2 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 3 });
  const put = p2.puts.find((p) => p.key === c.key);
  // `!put || put.state === 'live'` used to be the whole assertion — a disjunction that
  // PASSES WHEN NOTHING IS EMITTED. Deleting the un-park branch entirely left p2.puts
  // empty and the test green, while the real consequence is a record that is live,
  // approved, in the parent's list, and invisible to the child forever (by_folder_sort has
  // no state component, so nothing ever surfaces '~pending').
  assert.ok(put, 'an approved-but-parked record must be re-emitted so it can be un-parked');
  assert.equal(put.state, 'live');
  assert.notEqual(put.folderId, '~pending', 'the record was left parked — invisible to the child');
  assert.equal(put.folderId, 'ch:' + CH);
});

test('a REJECTED record survives every later sync (v1.0.23)', () => {
  // THE guard for the rejected list. A channel video is re-offered by the RSS pass every
  // 30 minutes and by every backfill page, so if the `prior` branch did not pin 'rejected'
  // the way it pins 'pending', each sync would quietly hand the child back everything the
  // parent threw out — and the parent would have no idea why.
  const c = cand({ autoApprove: true }); // even an auto-approving channel must not revive it
  const existing = new Map([[c.key, {
    ...cand(), key: c.key, state: 'rejected', rejectedAt: 500, approvedAt: null,
    folderId: '~rejected', homeFolderId: 'ch:' + CH, normTitle: 'שיר', addedAt: 10,
    sortKey: 1000, title: 'שיר', titleSource: 'rss', thumbUrl: 'x', thumbId: null,
    localPath: null, url: null, srcUrl: '', publishedAt: 1000, rowIndex: null, origin: 'channel'
  }]]);
  for (let round = 0; round < 3; round++) {
    const p = planMutations({ candidates: [c], existing, denySet: new Set(), now: 1000 + round });
    for (const put of p.puts) {
      assert.equal(put.state, 'rejected', `round ${round}: the sync revived a rejected video`);
      assert.equal(put.folderId, '~rejected', `round ${round}: it left the parking slot`);
      existing.set(put.key, put);
    }
    assert.ok(!p.newLiveKeys.includes(c.key), `round ${round}: counted as newly live`);
  }
});


test('planChannelLogo: a keyless sync must NOT suppress the scrape (v1.0.24)', () => {
  const now = 1_000_000_000_000;
  // THE FIELD BUG. A brand-new channel: channels.list ran (or, keyless, answered instantly
  // with nothing) and the old code stamped `logoTriedAt` either way, which gated the
  // page-scrape — the one path that demonstrably works without a key. The channel then
  // showed 📺 for a WEEK, starting the moment the parent added it.
  assert.deepEqual(planChannelLogo({}, { hasKey: false, now }), { api: false, scrape: true },
    'no key ⇒ no API call is possible, but the scrape is exactly what must run');
  assert.deepEqual(planChannelLogo({}, { hasKey: true, now }), { api: true, scrape: true });
  // An API attempt that came back empty may gate the API path — never the scrape.
  const apiTried = { logoApiTriedAt: now - 60_000 };
  assert.deepEqual(planChannelLogo(apiTried, { hasKey: true, now }), { api: false, scrape: true });

  // A logo we HAVE is left alone: existing libraries are never re-scraped wholesale.
  const good = { logoUrl: 'https://yt3/x=s240', logoFetchedAt: now - 90 * 86400_000 };
  assert.deepEqual(planChannelLogo(good, { hasKey: true, now }), { api: false, scrape: false },
    'an old but working avatar is not stale — age alone is not a reason to refetch');
});

test('planChannelLogo: an avatar that FAILS TO LOAD becomes fetchable again (v1.0.24)', () => {
  const now = 1_000_000_000_000;
  const url = 'https://yt3/x=s240';
  // The channel rebranded: the stored URL 404s, `img.onerror` swapped in 📺, and both
  // fetch paths used to skip any channel that already had a logoUrl — permanently.
  const broken = { logoUrl: url, logoFetchedAt: now - 86400_000 };
  const failedAt = now - 1000;
  assert.deepEqual(planChannelLogo(broken, { hasKey: true, failedAt, now }), { api: true, scrape: true });

  // A failure that PREDATES the current URL is already answered — that logo was replaced.
  const healed = { logoUrl: url, logoFetchedAt: now - 1000 };
  assert.deepEqual(planChannelLogo(healed, { hasKey: true, failedAt: now - 86400_000, now }),
    { api: false, scrape: false });

  // The retry windows still bound the traffic: the scrape is a full page fetch, so a
  // channel whose avatar simply cannot be loaded here re-scrapes weekly, not every sync.
  assert.equal(planChannelLogo({ ...broken, logoTriedAt: now - 60_000 },
    { hasKey: true, failedAt, now }).scrape, false);
  assert.equal(planChannelLogo({ ...broken, logoTriedAt: now - LOGO_SCRAPE_RETRY_MS - 1 },
    { hasKey: true, failedAt, now }).scrape, true);
  assert.equal(planChannelLogo({ ...broken, logoApiTriedAt: now - LOGO_API_RETRY_MS - 1 },
    { hasKey: true, failedAt, now }).api, true, 'the batched API call retries a full day sooner');

  // `logoApiTriedAt` is a NEW field on purpose: every channel already on a device passes
  // the API gate exactly once after the update, which heals the ones the old bug stranded.
  const stranded = { logoUrl: '', logoTriedAt: now - 86400_000 }; // falsely "tried" yesterday
  assert.equal(planChannelLogo(stranded, { hasKey: true, now }).api, true);
  assert.equal(planChannelLogo(stranded, { hasKey: true, now }).scrape, false, 'weekly gate holds');

  assert.deepEqual(planChannelLogo(null, { hasKey: false, now }), { api: false, scrape: true },
    'never throws on a channel record that does not exist yet');
});

test('planSyncDispatch: a FORCED sync never rides a run that already read (v1.0.25)', () => {
  // THE field bug. v1.0.21 wrote "a forced sync CHAINS, NEVER JOINS" in the comment above
  // syncLibrary but shipped `if (!opts.force || cur.force) return cur.promise` — which
  // joins whenever the RUNNING sync is itself forced. The first sync of every launch is
  // forced and takes minutes, so a parent adding a channel inside that window rode a run
  // that had listed the channels before their channel existed: it finished "successfully",
  // offerChannelApproval found 0 pending videos, the three-way dialog never appeared, and
  // the parent was told "הערוץ סונכרן ✅" over an empty import.
  assert.equal(planSyncDispatch({ running: true, queued: false, force: true }), 'queue',
    'a forced caller joined a forced run — the exact shipped bug');

  // nothing in flight
  assert.equal(planSyncDispatch({ running: false, force: false }), 'start');
  assert.equal(planSyncDispatch({ running: false, force: true }), 'start');
  assert.equal(planSyncDispatch({ running: false, queued: true, force: true }), 'start',
    'a queue with nothing running is not a state that can block a fresh run');

  // unforced callers are cheap and may always ride
  assert.equal(planSyncDispatch({ running: true, force: false }), 'join-running');
  assert.equal(planSyncDispatch({ running: true, queued: true, force: false }), 'join-running');

  // a QUEUED run has read nothing yet, so it is guaranteed to observe our write. This is
  // what keeps three adds in a row from queueing three full library sweeps.
  assert.equal(planSyncDispatch({ running: true, queued: true, force: true }), 'join-queued');

  assert.equal(planSyncDispatch(), 'start', 'must never throw on junk input');
  assert.equal(planSyncDispatch({}), 'start');
});

test('channelAddOutcome: never a bare ✅ over a backlog the child cannot see (v1.0.25)', () => {
  // THE v1.0.22 field bug in one line. A channel added in the parent screen is
  // autoApprove:false, so its whole catalogue lands in ממתינים — and the message said
  // "הערוץ סונכרן ✅". The parent had no reason to open ממתינים, so the child's home
  // simply stayed empty and the app looked broken.
  assert.match(channelAddOutcome(false, 109), /109/, 'a waiting backlog must state its size');
  assert.match(channelAddOutcome(false, 109), /ממתינים/, 'and name where to find it');
  assert.equal(channelAddOutcome(true, 109), 'הערוץ נוסף ו-109 סרטונים אושרו ✅');

  // A ZERO gets named too, because "nothing arrived" and "this channel publishes only
  // Shorts" are different facts — and the second is PERMANENT (Shorts are excluded on
  // purpose, v1.0.21), so a parent staring at an empty folder deserves to hear it.
  assert.match(channelAddOutcome(false, 0, { noLongForm: true }), /Shorts/);
  assert.match(channelAddOutcome(false, 0, { noLongForm: false, hasLive: false }),
    /לא נמצאו בו סרטונים/);
  // The one zero that earns a plain ✅: nothing NEW, but the child can already see content.
  assert.equal(channelAddOutcome(false, 0, { hasLive: true }), 'הערוץ סונכרן ✅');
  // noLongForm wins over hasLive — it is a fact about the channel, not about this run
  assert.match(channelAddOutcome(false, 0, { noLongForm: true, hasLive: true }), /Shorts/);
  // …and "approved" with nothing to approve is still a zero: claiming "0 סרטונים אושרו"
  // would be nonsense.
  assert.equal(channelAddOutcome(true, 0, { hasLive: true }), 'הערוץ סונכרן ✅');

  // Junk input must never throw, and must never invent a scary message: with no diagnosis
  // at all the optimistic default is the right one.
  assert.equal(channelAddOutcome(), 'הערוץ סונכרן ✅');
  assert.equal(channelAddOutcome(false, 0), 'הערוץ סונכרן ✅');
  assert.equal(channelAddOutcome(false, 0, null), 'הערוץ סונכרן ✅');
  assert.equal(channelAddOutcome(false, -5), 'הערוץ סונכרן ✅');

  // v1.0.26 — a PLAYLIST is a source too, and calling it "הערוץ" is the kind of small lie
  // that makes a parent doubt the app understood what they pasted.
  assert.match(channelAddOutcome(false, 30, { isPlaylist: true }), /רשימת ההשמעה/);
  assert.match(channelAddOutcome(true, 30, { isPlaylist: true }), /רשימת ההשמעה/);
  assert.doesNotMatch(channelAddOutcome(false, 30, { isPlaylist: true }), /הערוץ/);
  assert.equal(channelAddOutcome(false, 0, { isPlaylist: true, hasLive: true }), 'רשימת ההשמעה סונכרנה ✅');
  assert.match(channelAddOutcome(false, 0, { isPlaylist: true, hasLive: false }), /לא נמצאו בה סרטונים/);
});

test('channelAddOutcome: a capped import names the count AND the way back (v1.0.90)', () => {
  // Field report 2026-09-09: a library at MAX_ITEMS_TOTAL imported a 36-video channel as
  // "2 videos" (the 2 were title-twin merges, which bypass the cap). The old advice ended
  // "ונסו שוב" — but the backfill cursor advances and latches `backfillDone` while the
  // plan drops everything as capped, so after freeing space a plain retry brings back only
  // the RSS window. The honest instruction is remove-and-re-add, and it is pinned here.
  const full = channelAddOutcome(false, 0, { capped: 34 });
  assert.match(full, /34/, 'the dropped count must be named');
  assert.match(full, /למגבלת/, 'the cause is the LIBRARY ceiling, and the message says so');
  assert.match(full, /הסירו את הערוץ והוסיפו אותו מחדש/,
    'freeing space alone recovers only the RSS window — the message must say re-add');
  // Gender follows the noun (the v1.0.26 rule): a playlist is feminine.
  const pl = channelAddOutcome(false, 0, { capped: 34, isPlaylist: true });
  assert.match(pl, /הסירו את הרשימה והוסיפו אותה מחדש/);
  assert.doesNotMatch(pl, /הערוץ/);
  // A PARTIAL cap still appends its clause to the waiting-backlog sentence.
  assert.match(channelAddOutcome(false, 12, { capped: 86 }), /86 סרטונים לא נוספו/);
  assert.match(channelAddOutcome(false, 12, { capped: 86 }), /12 סרטונים ממתינים/);
  // Junk `capped` never invents the scary message.
  assert.equal(channelAddOutcome(false, 0, { capped: -3, hasLive: true }), 'הערוץ סונכרן ✅');
  assert.equal(channelAddOutcome(false, 0, { capped: NaN, hasLive: true }), 'הערוץ סונכרן ✅');
});

test('planEntryRefresh: the first entry of a launch is unconditional (v1.0.25)', () => {
  // Opening the app is not "flipping between the home and a video". Both throttles exist
  // for the second case, and applying them to the first is how the tablet showed content
  // the parent had already changed on the phone.
  assert.deepEqual(planEntryRefresh({ launchDone: false, sinceLastPullMs: 0 }),
    { pull: true, forceSync: true }, 'the launch pass must bypass BOTH throttles');

  // Later entries: the sync is never forced again, and the pull obeys its quiet period.
  assert.deepEqual(planEntryRefresh({ launchDone: true, sinceLastPullMs: 0 }),
    { pull: false, forceSync: false });
  assert.deepEqual(planEntryRefresh({ launchDone: true, sinceLastPullMs: 59_999 }),
    { pull: false, forceSync: false });
  assert.deepEqual(planEntryRefresh({ launchDone: true, sinceLastPullMs: 60_000 }),
    { pull: true, forceSync: false }, 'the boundary is inclusive — 60s means "due"');
  assert.deepEqual(planEntryRefresh({ launchDone: true, sinceLastPullMs: 10 * 60_000 }),
    { pull: true, forceSync: false });

  // A caller-supplied throttle is honoured (the constant lives in app.js).
  assert.equal(planEntryRefresh({ launchDone: true, sinceLastPullMs: 5000, pullThrottleMs: 1000 }).pull, true);

  // Never throws, and with nothing known it behaves like a launch — the safe direction is
  // to refresh, not to serve a stale library.
  assert.deepEqual(planEntryRefresh(), { pull: true, forceSync: true });
  assert.deepEqual(planEntryRefresh({}), { pull: true, forceSync: true });
});

test('attentionDot: CONTENT wins the dot, and the colour names the errand (v1.0.24)', () => {
  // One red dot used to mean both "videos are waiting for you" and "an app update is
  // ready". The parent could not tell them apart, so the routine errand — a manual-approval
  // channel published something the child cannot see yet — looked like the rare one.
  assert.equal(attentionDot({ pending: 3, updateReady: false }), 'info', 'content → blue');
  assert.equal(attentionDot({ pending: 0, updateReady: true }), 'alert', 'update only → red');
  assert.equal(attentionDot({ pending: 0, updateReady: false }), null, 'nothing → no dot');
  // A TIE goes to the content: a child is waiting at the other end of it, and the update
  // keeps its own dot on the אודות tab either way.
  assert.equal(attentionDot({ pending: 1, updateReady: true }), 'info');
  // never throws on a missing/partial attention object — this runs on every home render
  assert.equal(attentionDot(), null);
  assert.equal(attentionDot({}), null);
  assert.equal(attentionDot({ pending: 2 }), 'info');
});

test('parentLandingTab: a waiting queue overrides the sticky tab, EVERY visit (v1.0.24)', () => {
  assert.equal(parentLandingTab('about', 4), 'approve', 'pending → land on the queue');
  assert.equal(parentLandingTab('settings', 1), 'approve', 'the override beats stickiness');
  // …and it is not a one-shot: the same parent coming back to a still-full queue lands
  // there again. The queue is the only tab whose content is blocking a child.
  assert.equal(parentLandingTab('approve', 1), 'approve');
  // Empty queue ⇒ the sticky tab is restored, so the override can never strand a parent
  // who lives in הגדרות.
  assert.equal(parentLandingTab('settings', 0), 'settings');
  assert.equal(parentLandingTab('about', 0), 'about', 'v1.0.14 default survives');
  // A sticky value that is not a real tab would hide every panel (setParentTab matches by
  // name), so it falls back to the first tab rather than rendering an empty screen.
  assert.equal(parentLandingTab('nope', 0), PARENT_TAB_IDS[0]);
  assert.equal(parentLandingTab(null, 0), 'about');
  assert.equal(parentLandingTab(undefined, 0), 'about');
  // the tab list is the one app.js renders from — a second hand-kept copy could name a
  // tab that does not exist
  assert.ok(PARENT_TAB_IDS.includes('approve'));
  assert.deepEqual(PARENT_TAB_IDS, ['about', 'approve', 'add', 'sources', 'sites', 'settings']);
});

test('pendingBulkAction: the button SAYS what it is about to act on (v1.0.24)', () => {
  // Nothing ticked ⇒ the buttons keep their original whole-queue meaning, which is also
  // the only way to reach rows past the 200-row display cap.
  const none = pendingBulkAction(0, 30);
  assert.equal(none.scope, 'all');
  assert.equal(none.count, 30);
  assert.match(none.approve, /הכול/);
  assert.match(none.reject, /הכול/);

  // One tick narrows BOTH buttons. This is the whole point: "דחיית הכול" pressed while
  // three rows are ticked must not throw out thirty.
  const some = pendingBulkAction(3, 30);
  assert.equal(some.scope, 'selected');
  assert.equal(some.count, 3);
  assert.match(some.approve, /3/);
  assert.match(some.reject, /3/);
  assert.ok(!some.approve.includes('הכול'), 'a narrowed action must not read as "all"');
  assert.ok(!some.reject.includes('הכול'));

  // Selecting every row is still a SELECTION, not the whole queue: with 250 pending and
  // 200 rendered rows, ticking all 200 must not silently act on 250.
  const capped = pendingBulkAction(200, 250);
  assert.equal(capped.scope, 'selected');
  assert.equal(capped.count, 200);

  // garbage in never produces a whole-queue action by accident
  assert.equal(pendingBulkAction(-5, 10).scope, 'all');
  assert.equal(pendingBulkAction().scope, 'all');
  assert.equal(pendingBulkAction().count, 0);
});

test('THE CHURN INVARIANT holds for rejected records too (v1.0.23)', () => {
  // The most valuable assertion in this suite is "run the plan twice ⇒ empty second diff",
  // and a third curation state is exactly the kind of change that quietly breaks it. What
  // this pins is that `state` and `folderId` SETTLE: if a re-seen rejected candidate flipped
  // between 'rejected' and something else, or between '~rejected' and its home, every sync
  // would rewrite every rejected row and re-push the whole library to Drive.
  // NOTE, measured: a drifting `rejectedAt` does NOT churn here — it is not in DIFF_FIELDS,
  // so `changed()` never sees it. That drift is caught by settleCuration's own idempotence
  // test in normalize.test.mjs; do not expect this test to cover it.
  const c = cand({ autoApprove: true });
  const existing = new Map();
  const p1 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 1000 });
  for (const put of p1.puts) existing.set(put.key, put);
  // the parent rejects it (what db.rejectPending writes)
  const rec = existing.get(c.key);
  existing.set(c.key, {
    ...rec, state: 'rejected', rejectedAt: 2000, approvedAt: null,
    homeFolderId: rec.folderId, folderId: '~rejected'
  });
  const p2 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 3000 });
  for (const put of p2.puts) existing.set(put.key, put);
  const p3 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 4000 });
  assert.deepEqual(p3.puts, [], 'a re-seen REJECTED video rewrote its record (churn)');
  assert.equal(existing.get(c.key).state, 'rejected');
  assert.equal(existing.get(c.key).rejectedAt, 2000, 'the decision timestamp must not drift');
});

test('quarantine forces pending regardless of autoApprove (post-migration first sync)', () => {
  const p = planMutations({ candidates: [cand({ autoApprove: true })], existing: new Map(), denySet: new Set(), quarantine: true });
  assert.equal(p.puts[0].state, 'pending');
});

test('title dedupe within a channel; NOT across channels; empty normTitle never dedupes', () => {
  const a = cand({ id: 'aaaaaaaaaaa', title: 'שיר הבוקר' });
  const sameChannelTwin = cand({ id: 'bbbbbbbbbbb', title: 'שיר, הבוקר!' }); // same after normalize
  const otherChannel = cand({ id: 'ccccccccccc', title: 'שיר הבוקר', channelId: 'UCother0000000000000000', folderId: 'ch:other' });
  const untitled1 = cand({ id: 'ddddddddddd', title: '' });
  const untitled2 = cand({ id: 'eeeeeeeeeee', title: '' });

  const p = planMutations({ candidates: [a, sameChannelTwin, otherChannel, untitled1, untitled2], existing: new Map(), denySet: new Set() });
  const keys = p.puts.map((x) => x.key).sort();
  assert.ok(!keys.includes('yt:bbbbbbbbbbb'), 'twin merged into survivor');
  assert.ok(keys.includes('yt:ccccccccccc'), 'cross-channel twin kept');
  assert.ok(keys.includes('yt:ddddddddddd') && keys.includes('yt:eeeeeeeeeee'), 'untitled never dedupe');
  assert.equal(p.mergeReport.length, 1);
  const survivor = p.puts.find((x) => x.key === 'yt:aaaaaaaaaaa');
  assert.ok(survivor.mergedFrom.includes('yt:bbbbbbbbbbb'));
});

test('a same-titled twin can NEVER auto-approve its survivor (v1.0.22 safety hole)', () => {
  // The bug, measured on a real channel (@rotemama4kids, 109 long-form videos added from
  // the parent screen ⇒ autoApprove:false): `base.state` defaulted to 'live' and the
  // approval routing lived only in the brand-new branch, so the titleTwin branch
  // short-circuited past it. mergeVideoRecord promotes a pending survivor when the LOSER
  // is live — so the 2 same-titled pairs in that backfill became live in the child's
  // folder with approvedAt still null, and they were the ONLY 2 videos the child could
  // see. Unapproved content reaching a 5-year-old is the worst failure this app has.
  const a = cand({ id: 'aaaaaaaaaaa', title: 'שמח, עצוב או כועס?', autoApprove: false });
  const twin = cand({ id: 'bbbbbbbbbbb', title: 'שמח עצוב או כועס!', autoApprove: false });
  const p = planMutations({ candidates: [a, twin], existing: new Map(), denySet: new Set(), now: 7 });

  assert.equal(p.puts.length, 1, 'the twin still merges — dedupe is not what changed');
  const survivor = p.puts[0];
  assert.equal(survivor.state, 'pending', 'a merge must never approve what the parent has not seen');
  assert.equal(survivor.folderId, '~pending', 'and it must stay parked out of the child folder');
  assert.ok(survivor.mergedFrom.includes('yt:bbbbbbbbbbb'));
  assert.ok(!p.newLiveKeys.length, 'nothing became live');
});

test('quarantine also survives the twin-merge path', () => {
  const a = cand({ id: 'aaaaaaaaaaa', title: 'שיר', autoApprove: true });
  const twin = cand({ id: 'bbbbbbbbbbb', title: 'שיר!', autoApprove: true });
  const p = planMutations({ candidates: [a, twin], existing: new Map(), denySet: new Set(), quarantine: true });
  assert.equal(p.puts.length, 1);
  assert.equal(p.puts[0].state, 'pending', 'post-migration quarantine outranks autoApprove everywhere');
  assert.equal(p.puts[0].folderId, '~pending');
});

test('a twin merge that DOES go live is never left parked (mirror of the leak)', () => {
  // The legitimate direction: the parent has since switched the channel to auto-approve,
  // so an incoming candidate really is approved and promoting the waiting twin is right.
  // mergeVideoRecord flips state but never folderId, and a live record still parked in
  // '~pending' is invisible in the child's folder AND gone from the approval queue.
  const existing = new Map([['yt:aaaaaaaaaaa', {
    key: 'yt:aaaaaaaaaaa', channelId: CH, normTitle: 'שיר', state: 'pending',
    title: 'שיר', titleSource: 'rss', addedAt: 1, sortKey: 1000, origin: 'channel',
    folderId: '~pending', homeFolderId: 'ch:' + CH, publishedAt: 1000, rowIndex: null,
    thumbUrl: 'x', thumbId: null, localPath: null, srcUrl: '', url: null, approvedAt: null
  }]]);
  const p = planMutations({
    candidates: [cand({ id: 'bbbbbbbbbbb', title: 'שיר!', autoApprove: true })],
    existing, denySet: new Set(), now: 99
  });
  const survivor = p.puts.find((x) => x.key === 'yt:aaaaaaaaaaa');
  assert.ok(survivor, 'the promotion must be emitted');
  assert.equal(survivor.state, 'live');
  assert.equal(survivor.folderId, 'ch:' + CH, 'un-parked, or the child can never reach it');
  assert.equal(survivor.approvedAt, 99, 'it became live now — the record must say so');
});

test('a reappearing merged-away link resolves to its survivor, not a new record', () => {
  const existing = new Map([['yt:aaaaaaaaaaa', {
    key: 'yt:aaaaaaaaaaa', channelId: CH, normTitle: 'שיר', state: 'live',
    title: 'שיר', titleSource: 'rss', addedAt: 1, sortKey: 1000, origin: 'channel',
    folderId: 'ch:' + CH, publishedAt: 1000, rowIndex: null, thumbUrl: 'x', thumbId: null,
    localPath: null, srcUrl: '', url: null, mergedFrom: ['yt:bbbbbbbbbbb']
  }]]);
  const p = planMutations({ candidates: [cand({ id: 'bbbbbbbbbbb' })], existing, denySet: new Set() });
  assert.ok(!p.puts.some((x) => x.key === 'yt:bbbbbbbbbbb'), 'loser did not resurrect');
});

test('caps: per-channel and total', () => {
  const many = Array.from({ length: 30 }, (_, i) => cand({ id: String(i).padStart(11, 'x'), title: 't' + i }));
  const p = planMutations({ candidates: many, existing: new Map(), denySet: new Set(), caps: { maxPerChannel: 10, maxTotal: 100 } });
  assert.equal(p.puts.length, 10);
  assert.equal(p.counts.capped, 20);

  // maxTotal was never actually exercised: with maxPerChannel:10 the total never reached
  // 100, so `if (total >= maxTotal)` never ran and the 5000-record library ceiling could
  // have been deleted with the suite green — one large sheet then imports without bound
  // onto a tablet. Bind it explicitly, and across TWO channels so it is the total that caps.
  const twoChannels = [
    ...Array.from({ length: 5 }, (_, i) => cand({ id: 'a' + String(i).padStart(10, '0'), title: 'a' + i })),
    ...Array.from({ length: 5 }, (_, i) => cand({ id: 'b' + String(i).padStart(10, '0'), title: 'b' + i, channelId: 'UCother0000000000000000', folderId: 'ch:other' }))
  ];
  const capped = planMutations({
    candidates: twoChannels, existing: new Map(), denySet: new Set(),
    caps: { maxPerChannel: 99, maxTotal: 4 }
  });
  assert.equal(capped.puts.length, 4, 'maxTotal did not bind');
  assert.equal(capped.counts.capped, 6);
  // and EXISTING records count toward the total, or the cap resets every sync
  const nearFull = new Map(Array.from({ length: 4 }, (_, i) => ['yt:pre' + i, { key: 'yt:pre' + i, state: 'live' }]));
  const full = planMutations({
    candidates: twoChannels, existing: nearFull, denySet: new Set(), caps: { maxPerChannel: 99, maxTotal: 4 }
  });
  assert.equal(full.puts.length, 0, 'a library already at the cap kept importing');

  // v1.0.91 — `counts.total` is the size the run LEAVES BEHIND, and it is the number the
  // cap-recovery gate (quota.planCapRearm) reads. It must come from here and nowhere
  // else: a second answer to "how full is the library" would let the cap and the gate
  // that undoes it disagree, and the channel would re-walk 40 pages into no room at all.
  assert.equal(capped.counts.total, 4, 'a capped run must report the ceiling it hit');
  assert.equal(full.counts.total, 4, 'existing records count toward the reported total');
  // merges and updates do NOT grow it — only brand-new records do
  const grew = planMutations({
    candidates: twoChannels, existing: new Map(), denySet: new Set(),
    caps: { maxPerChannel: 99, maxTotal: 4000 }
  });
  assert.equal(grew.counts.total, 10);
  const again = planMutations({
    candidates: twoChannels,
    existing: new Map(grew.puts.map((r) => [r.key, r])),
    denySet: new Set(), caps: { maxPerChannel: 99, maxTotal: 4000 }
  });
  assert.equal(again.counts.total, 10, 're-offering the same videos must not inflate the total');
});

test('THE assertion: second run over the same inputs yields an empty diff', () => {
  const candidates = [
    cand({ id: 'aaaaaaaaaaa', title: 'שיר 1' }),
    cand({ id: 'bbbbbbbbbbb', title: 'שיר 2' }),
    cand({ id: 'ccccccccccc', title: 'שיר, 1' }) // dedupes into aaaa
  ];
  const p1 = planMutations({ candidates, existing: new Map(), denySet: new Set(), now: 100 });
  const existing = new Map(p1.puts.map((r) => [r.key, r]));
  const p2 = planMutations({ candidates, existing, denySet: new Set(), now: 200 });
  assert.equal(p2.puts.length, 0, 'no churn on identical inputs');
  assert.equal(p2.newLiveKeys.length, 0, 'nothing re-gifts');
});

test('planGifts baseline: exactly the newest 12 become gifts, the rest are pre-unwrapped', () => {
  const live = Array.from({ length: 20 }, (_, i) => ({
    key: 'yt:' + String(i).padStart(11, 'v'), sortKey: 1000 + i, thumbUrl: 'x', type: 'youtube'
  }));
  const puts = planGifts({ profileId: 'p1', liveRecords: live, newLiveKeys: [], existingStates: new Map(), firstSync: true, now: 5 });
  const gifts = puts.filter((s) => s.giftRank);
  const unwrapped = puts.filter((s) => s.unwrappedAt);
  assert.equal(gifts.length, 12);
  assert.equal(unwrapped.length, 8);
  assert.deepEqual(gifts.map((g) => g.giftRank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  // rank 1 = the newest (highest sortKey)
  assert.equal(gifts[0].key, live[19].key);
});

test('planGifts incremental: only NEW live keys gift; unwrapped never re-gifts; ranks continue', () => {
  const live = [
    { key: 'yt:old00000000', sortKey: 1, thumbUrl: 'x' },
    { key: 'yt:new00000000', sortKey: 2, thumbUrl: 'x' },
    { key: 'yt:seen0000000', sortKey: 3, thumbUrl: 'x' }
  ];
  const states = new Map([
    ['yt:old00000000', { giftRank: 4 }],
    ['yt:seen0000000', { unwrappedAt: 10 }]
  ]);
  const puts = planGifts({ profileId: 'p1', liveRecords: live, newLiveKeys: ['yt:new00000000', 'yt:seen0000000'], existingStates: states, firstSync: false });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, 'yt:new00000000');
  assert.equal(puts[0].giftRank, 5); // continues after the existing max
});

/* ---- v1.0.20 FIELD BUGS: the home flattened a lone channel, and the gift baseline
        was spent on an empty library ---- */

test('shouldFlattenHome: only the LOOSE list may render flat — a channel keeps its tile', () => {
  // Reported live: the parent added one channel and the child's home became a
  // hundred-page flat wall of its backfill, with no 📺 tile and no channel logo.
  assert.equal(shouldFlattenHome([{ id: 'ch:UCabcdefghijklmnopqrstuv', count: 300 }]), false);
  assert.equal(shouldFlattenHome([{ id: 'grp:UCabcdefghijklmnopqrstuv', count: 4, grouped: true }]), false);
  // the case the rule exists for: the shared loose list as the ONLY folder
  assert.equal(shouldFlattenHome([{ id: 'sheet', count: 12 }]), true);
  assert.equal(shouldFlattenHome([{ id: 'mine', count: 3 }]), true, 'legacy profile-scope list too');
});

test('shouldFlattenHome: never flattens when there is something to organize', () => {
  assert.equal(shouldFlattenHome([{ id: 'sheet' }, { id: 'ch:UC1' }]), false);
  // 🎁 is a view over other folders — alone it must not become the whole home, and
  // next to the loose list it means there ARE two tiles to show
  assert.equal(shouldFlattenHome([{ id: 'new', isNew: true, count: 5 }]), false);
  assert.equal(shouldFlattenHome([{ id: 'new', isNew: true }, { id: 'sheet' }]), false);
  // junk in, no crash out (an empty home renders its empty state, not a flat page)
  for (const junk of [[], null, undefined, [null], [{}]]) {
    assert.equal(shouldFlattenHome(junk), false, JSON.stringify(junk));
  }
});

test('shouldRecordGiftBaseline: an EMPTY first sync must not spend the baseline', () => {
  // Adding a channel syncs while every video is still pending, so liveRecords is empty.
  // Spending the flag there gave the child no gifts after approval, and made the NEXT
  // sync gift the entire backfill at once.
  assert.equal(shouldRecordGiftBaseline(true, 0), false);
  assert.equal(shouldRecordGiftBaseline(true, 1), true);
  assert.equal(shouldRecordGiftBaseline(true, 2000), true);
  assert.equal(shouldRecordGiftBaseline(false, 0), false, 'already baselined stays baselined');
  assert.equal(shouldRecordGiftBaseline(false, 50), false);
  for (const junk of [undefined, null, NaN, 'x']) assert.equal(shouldRecordGiftBaseline(true, junk), false);
});

test('the gift baseline still works the moment content becomes live', () => {
  // End-to-end of the fix: sync #1 (all pending) records nothing, sync #2 after the
  // parent approves takes the BASELINE path — newest 12 gifted, the rest never gift.
  const live = Array.from({ length: 30 }, (_, i) => ({ key: 'yt:k' + i, sortKey: i, thumbUrl: 'x' }));
  assert.equal(shouldRecordGiftBaseline(true, 0), false);
  const puts = planGifts({ profileId: 'p1', liveRecords: live, newLiveKeys: live.map((r) => r.key), existingStates: new Map(), firstSync: true });
  assert.equal(puts.filter((p) => p.giftRank).length, 12, 'twelve gifts, not thirty');
  assert.equal(puts.filter((p) => p.unwrappedAt).length, 18);
  assert.equal(shouldRecordGiftBaseline(true, live.length), true);
});

/* ---- the two extracted safety boundaries (v1.0.20) ---- */

test('isLooseRecord: only LIVE records in the shared ⭐ bucket (v1.0.38 rename)', () => {
  const recs = [
    { key: 'yt:live0000000', state: 'live', folderId: 'sheet' },
    { key: 'yt:pending0000', state: 'pending', folderId: '~pending', homeFolderId: 'sheet' },
    { key: 'yt:approved000', state: 'live', folderId: '~pending', homeFolderId: 'sheet' },
    { key: 'yt:chvideo0000', state: 'live', folderId: 'ch:UC1' }
  ];
  // a PENDING share is parked in the bucket but is not part of the child's list yet
  assert.deepEqual(recs.filter(isLooseRecord).map((r) => r.key), ['yt:live0000000', 'yt:approved000']);
  // the folder test must read homeFolderId FIRST — a parked record's folderId is '~pending'
  assert.equal(isLooseRecord(recs[2]), true);
  // channel content is never loose: the channel folder owns it
  assert.equal(isLooseRecord(recs[3]), false);
  for (const junk of [null, undefined, {}, 0, 'x']) assert.equal(isLooseRecord(junk), false);
});

/* The planScopeAdoption tests lived here. v1.0.38 deleted the function with db.moveScope and
 * the sheet wizard: nothing can change a profile's libraryId any more, which is exactly what
 * makes the sunset migration's "libraryId never changes" rule enforceable. */

test('planGiftRunawayRepair keeps the newest 12 and retires an implausible pile', () => {
  // The state devices are in after the burned-baseline bug: the whole library gifted.
  // giftRank here IS recency only because this fixture says so — see the next test.
  const states = Array.from({ length: 1020 }, (_, i) => ({ profileId: 'p1', key: 'yt:k' + i, giftRank: i + 1 }));
  const { keep, retire } = planGiftRunawayRepair(states);
  assert.equal(keep.length, 12);
  assert.equal(retire.length, 1008);
  assert.deepEqual(keep.slice(0, 3), ['yt:k0', 'yt:k1', 'yt:k2'], 'no recency data: rank order is the fallback');
  assert.equal(new Set([...keep, ...retire]).size, 1020, 'every ranked gift is accounted for exactly once');
});

test('planGiftRunawayRepair ranks by the VIDEOS’ recency, not by giftRank', () => {
  // THE bug this signature exists for: a runaway pile is created by planGifts'
  // INCREMENTAL branch, which stamps maxRank+1 while walking loadMergeIndex — a cursor
  // over the [scopeId,key] primary key, i.e. ALPHABETICAL. So giftRank is uncorrelated
  // with recency exactly on the piles this repairs, and retiring is PERMANENT
  // (unwrappedAt is min-merged forever). Here rank order is the REVERSE of recency.
  const n = 100;
  const states = Array.from({ length: n }, (_, i) => ({ key: 'yt:k' + i, giftRank: i + 1 }));
  const sortKeyOf = new Map(states.map((s, i) => [s.key, i])); // k99 newest, k0 oldest
  const { keep, retire } = planGiftRunawayRepair(states, { sortKeyOf });
  assert.equal(keep.length, 12);
  assert.deepEqual(keep.slice(0, 3), ['yt:k99', 'yt:k98', 'yt:k97'], 'newest first');
  assert.ok(!keep.includes('yt:k0'), 'the oldest video must not survive as a gift');
  assert.ok(retire.includes('yt:k0'));
  assert.equal(new Set([...keep, ...retire]).size, n);

  // a plain object and a function are accepted too (the caller builds whatever it has)
  assert.deepEqual(planGiftRunawayRepair(states, { sortKeyOf: (k) => Number(k.slice(4)) }).keep[0], 'yt:k99');

  // a video we cannot date must never be retired just for missing a sortKey: datable
  // records sort first, and the undatable ones fall back to rank among themselves
  const partial = new Map([['yt:k5', 1000]]);
  const res = planGiftRunawayRepair(states, { sortKeyOf: partial });
  assert.equal(res.keep[0], 'yt:k5');
  assert.equal(res.keep.length, 12);
});

test('planGiftRunawayRepair leaves a plausible gift pile completely alone', () => {
  // A child who simply has not opened their gifts must not be "repaired".
  for (const n of [0, 1, 12, 13, 40, 60]) {
    const states = Array.from({ length: n }, (_, i) => ({ key: 'yt:k' + i, giftRank: i + 1 }));
    assert.deepEqual(planGiftRunawayRepair(states), { keep: [], retire: [] }, `${n} gifts`);
  }
  // already-unwrapped items are not gifts and never count toward the pile
  const mixed = Array.from({ length: 300 }, (_, i) => ({ key: 'yt:u' + i, giftRank: i + 1, unwrappedAt: 5 }));
  assert.deepEqual(planGiftRunawayRepair(mixed), { keep: [], retire: [] });
  for (const junk of [null, undefined, [], [null, {}, 0]]) {
    assert.deepEqual(planGiftRunawayRepair(junk), { keep: [], retire: [] }, JSON.stringify(junk));
  }
});

test('planGiftRunawayRepair is idempotent — the repaired state repairs to nothing', () => {
  const states = Array.from({ length: 500 }, (_, i) => ({ key: 'yt:k' + i, giftRank: i + 1 }));
  const first = planGiftRunawayRepair(states);
  const after = states
    .filter((s) => first.keep.includes(s.key))
    .concat(states.filter((s) => first.retire.includes(s.key)).map((s) => ({ key: s.key, unwrappedAt: 9 })));
  assert.deepEqual(planGiftRunawayRepair(after), { keep: [], retire: [] });
});

test('the Videos tab and a PLAYLIST holding the same video yield ONE record', () => {
  // v1.0.21 — a channel's playlists are pulled as an extra SOURCE, and they mostly
  // contain videos the Videos tab already gave us, so the same id arrives twice in a
  // single run. Both arrivals must collapse: two records would mean two tiles of the
  // same video in the child's folder, and two gifts.
  // The two arrivals must DIFFER the way the real sources do, or the test proves nothing:
  // `snippet.publishedAt` on a playlist item is when it was ADDED TO THE PLAYLIST, so the
  // same video can reach us with a different date and a different title revision.
  const dup = [
    cand({ id: 'vvvvvvvvvvv', titleSource: 'api', publishedAt: 1000, title: 'שיר הבוקר' }),
    cand({ id: 'vvvvvvvvvvv', titleSource: 'api', publishedAt: 7777, title: 'שיר הבוקר (מתוך אוסף)' })
  ];
  const plan = planMutations({ candidates: dup, existing: new Map(), denySet: new Set(), now: 5000 });
  // `puts` is a Map keyed by key, so its LENGTH is structurally guaranteed and proves
  // nothing. What matters is that the video is gifted ONCE and gets ONE sortKey.
  assert.equal(plan.newLiveKeys.filter((k) => k === 'yt:vvvvvvvvvvv').length, 1,
    'one video became two gifts');
  assert.equal(plan.puts.length, 1);
  assert.equal(plan.puts[0].key, 'yt:vvvvvvvvvvv');
  assert.equal(typeof plan.puts[0].sortKey, 'number');

  // and again against an ALREADY-STORED copy (the steady state: uploads imported last
  // run, the playlists stage reaches the same video this run)
  const existing = new Map(plan.puts.map((r) => [r.key, r]));
  const second = planMutations({
    candidates: [cand({ id: 'vvvvvvvvvvv', titleSource: 'api' })],
    existing, denySet: new Set(), now: 6000
  });
  assert.deepEqual(second.puts, [], 'a re-seen video rewrote its record (churn)');
  assert.deepEqual(second.newLiveKeys, [], 'a re-seen video was gifted a second time');
});

/* ---- v1.0.21: Shorts/live exclusion and the playlists-tab source ---- */

const OWN = 'UCabcdefghijklmnopqrstuv';
const OTHER = 'UCzzzzzzzzzzzzzzzzzzzzzz';
const item = (over = {}) => ({ videoId: 'aaaaaaaaaaa', ownerChannelId: OWN, ...over });

test('acceptRssEntry: Shorts and live streams never enter, normal videos do', () => {
  // A grep for the word "isShort" passed for `if (!v.isShort) continue`, which imports
  // ONLY Shorts — the maximally-bad inversion in a child-safety app. A predicate cannot
  // be inverted without failing here.
  assert.equal(acceptRssEntry({ isShort: false, isLive: false }), true);
  assert.equal(acceptRssEntry({ isShort: true, isLive: false }), false);
  assert.equal(acceptRssEntry({ isShort: false, isLive: true }), false);
  assert.equal(acceptRssEntry({ isShort: true, isLive: true }), false);
  // unknown = INCLUDE: everything here rests on undocumented feed behaviour, and a
  // wrongly hidden video is a bug the parent cannot explain
  assert.equal(acceptRssEntry({}), true);
  for (const junk of [null, undefined, 0, '']) assert.equal(acceptRssEntry(junk), false, String(junk));
});

test('acceptPlaylistItem: own uploads only, no Shorts, and PRIVATE entries rejected', () => {
  const shortIds = new Set(['sssssssssss']);
  // the happy path
  assert.equal(acceptPlaylistItem(item(), { channelId: OWN, shortIds }), true);
  // a curated playlist routinely holds OTHER channels' videos — the parent subscribed to
  // this channel, not to whatever it collected
  assert.equal(acceptPlaylistItem(item({ ownerChannelId: OTHER }), { channelId: OWN, shortIds }), false);
  // a Short of this channel, caught by UUSH membership (playlistItems has no flag)
  assert.equal(acceptPlaylistItem(item({ videoId: 'sssssssssss' }), { channelId: OWN, shortIds }), false);
  // PRIVATE / DELETED entries come back with no uploader at all, and rendered as an
  // untappable "Private video" tile for the child. Unlike RSS, unknown here fails CLOSED.
  assert.equal(acceptPlaylistItem(item({ ownerChannelId: '' }), { channelId: OWN, shortIds }), false);
  assert.equal(acceptPlaylistItem({ videoId: 'aaaaaaaaaaa' }, { channelId: OWN, shortIds }), false);
  // junk ids never become records
  for (const bad of ['', 'short', null, undefined, 42, 'aaaaaaaaaaaa']) {
    assert.equal(acceptPlaylistItem(item({ videoId: bad }), { channelId: OWN, shortIds }), false, String(bad));
  }
  // an EMPTY shorts set only ever leaks (documented) — it must not hide own uploads
  assert.equal(acceptPlaylistItem(item(), { channelId: OWN, shortIds: new Set() }), true);
  assert.equal(acceptPlaylistItem(item(), { channelId: OWN }), true);
});

test('planPlaylistAdvance: an INCOMPLETE enumeration never marks the walk done', () => {
  // THE wedge: `playlistsDone` used to be "the queue is empty", which is also true when
  // the enumeration was throttled or errored. One quota blip on the first pass disabled
  // the playlists source for that channel for the life of the install — nothing rearms it.
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: [] }, { listComplete: false }),
    { playlistQueue: [], playlistCursor: null, playlistsDone: false });
  // a COMPLETE enumeration that genuinely found nothing IS done
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: [] }, { listComplete: true }),
    { playlistQueue: [], playlistCursor: null, playlistsDone: true });
  assert.equal(planPlaylistAdvance({ playlistQueue: ['PL1'] }, { listComplete: true }).playlistsDone, false);
});

test('planPlaylistAdvance: pages, playlist hand-off, and a broken playlist', () => {
  // more pages of the head playlist
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: ['A', 'B'], playlistCursor: null }, { nextPageToken: 'T1' }),
    { playlistQueue: ['A', 'B'], playlistCursor: 'T1', playlistsDone: false });
  // last page of A → move to B, cursor cleared (a stale cursor against B would page
  // from the wrong offset)
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: ['A', 'B'], playlistCursor: 'T1' }, { nextPageToken: null }),
    { playlistQueue: ['B'], playlistCursor: null, playlistsDone: false });
  // last page of the last playlist → done
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: ['B'], playlistCursor: 'T9' }, {}),
    { playlistQueue: [], playlistCursor: null, playlistsDone: true });
  // a private/deleted playlist is DROPPED, never retried forever
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: ['A', 'B'] }, { pageError: 'http-404' }),
    { playlistQueue: ['B'], playlistCursor: null, playlistsDone: false });
  // feeding the result back in is a fixed point (the repo's idempotence convention)
  const done = planPlaylistAdvance({ playlistQueue: ['B'] }, {});
  assert.deepEqual(planPlaylistAdvance(done, {}), done);
  for (const junk of [undefined, {}, { playlistQueue: null }]) {
    assert.doesNotThrow(() => planPlaylistAdvance(junk, {}), JSON.stringify(junk));
  }
});

test('planNoLongForm: only a FIRST-page 404 means "this channel posts only Shorts"', () => {
  assert.deepEqual(planNoLongForm({ notFound: true, isFirstPage: true, derived: true }),
    { noLongForm: true, closeBackfill: true });
  // deeper in the walk a 404 is not a verdict about the channel
  assert.equal(planNoLongForm({ notFound: true, isFirstPage: false, derived: true }).noLongForm, false);
  // and a 403 / quota / network failure must NEVER close a backfill
  assert.equal(planNoLongForm({ notFound: false, isFirstPage: true, derived: true }).closeBackfill, false);
  assert.equal(planNoLongForm({}).noLongForm, false);
});

test('planLongFormOutage: every channel 404ing is an OUTAGE, not a fact about them', () => {
  // UULF is undocumented. If YouTube retires it, page 1 answers 404 for EVERY channel at
  // once; acting on that would close every backfill in every family's library in one sync
  // and tell each parent something false. Same spirit as the sheet-mirror valve.
  const all404 = [{ channelId: 'a', notFound: true }, { channelId: 'b', notFound: true }, { channelId: 'c', notFound: true }];
  assert.equal(planLongFormOutage(all404).outage, true);
  // a genuinely Shorts-only channel among healthy ones is NOT an outage
  const mixed = [{ channelId: 'a', notFound: true }, { channelId: 'b', notFound: false }];
  assert.equal(planLongFormOutage(mixed).outage, false);
  assert.equal(planLongFormOutage(mixed).notFoundCount, 1);
  // a single channel can never establish an outage (too small a sample to act on)
  assert.equal(planLongFormOutage([{ channelId: 'a', notFound: true }]).outage, false);
  assert.equal(planLongFormOutage([]).outage, false);
  assert.equal(planLongFormOutage().outage, false);
});

test('planGifts caps the OUTSTANDING gifts, so a bulk arrival is never a wall', () => {
  // v1.0.21. The incremental branch had no ceiling, so approve-all, a channel backfill
  // going live, or a baseline spent on a nearly-empty library gifted EVERYTHING — the
  // v1.0.20 field bug (a "חדשים" folder holding the whole library). Now unrepresentable
  // rather than repairable.
  const live = Array.from({ length: 300 }, (_, i) => ({
    key: 'yt:' + String(i).padStart(11, 'v'), sortKey: 1000 + i, thumbUrl: 'x', type: 'youtube'
  }));
  const puts = planGifts({
    profileId: 'p1', liveRecords: live, newLiveKeys: live.map((r) => r.key),
    existingStates: new Map(), firstSync: false
  });
  assert.equal(puts.length, 12, 'a 300-video bulk approval produced ' + puts.length + ' gifts');
  // and the NEWEST are the ones that got them
  assert.equal(puts[0].key, live[299].key);
  assert.ok(puts.every((p) => p.giftRank));

  // already-outstanding gifts count against the cap
  const states = new Map(Array.from({ length: 10 }, (_, i) => ['yt:old' + i, { giftRank: i + 1 }]));
  const some = planGifts({
    profileId: 'p1', liveRecords: live, newLiveKeys: live.map((r) => r.key),
    existingStates: states, firstSync: false
  });
  assert.equal(some.length, 2, 'the cap ignored the 10 gifts already waiting');
  // an OPENED gift frees a slot again, so the folder keeps refilling over time
  const opened = new Map(Array.from({ length: 10 }, (_, i) => ['yt:old' + i, { giftRank: i + 1, unwrappedAt: 5 }]));
  assert.equal(planGifts({
    profileId: 'p1', liveRecords: live, newLiveKeys: live.map((r) => r.key),
    existingStates: opened, firstSync: false
  }).length, 12);
});

test('a same-titled DIFFERENT video from a playlist merges — and stays merged', () => {
  // The playlists tab is exactly the source that multiplies same-title/different-id pairs
  // (an alt mix or re-upload of a song the Videos tab already has), and both tabs feed the
  // SAME run, so this is the realistic shape. planMutations merges them per channel and
  // records the loser in `mergedFrom`, which PERMANENTLY resolves to the survivor — the
  // second video can never be imported again. Pinned so the trade-off is visible.
  const plan = planMutations({
    candidates: [
      cand({ id: 'aaaaaaaaaaa', title: 'Baby Shark', publishedAt: 1000 }),   // Videos tab
      cand({ id: 'bbbbbbbbbbb', title: 'Baby Shark!', publishedAt: 7777 })   // a playlist
    ],
    existing: new Map(), denySet: new Set(), now: 1
  });
  const survivor = plan.puts.find((r) => r.key === 'yt:aaaaaaaaaaa');
  assert.ok(survivor, 'the survivor was not written');
  assert.ok((survivor.mergedFrom || []).includes('yt:bbbbbbbbbbb'), 'the loser was not recorded');
  assert.ok(!plan.puts.some((r) => r.key === 'yt:bbbbbbbbbbb'), 'a duplicate record was created');
  assert.equal(plan.newLiveKeys.length, 1, 'the twin was gifted as a second video');
  assert.equal(plan.mergeReport.length, 1);

  // …and the loser does not resurrect on a later run: mergedFromIndex resolves it back
  const third = planMutations({
    candidates: [cand({ id: 'bbbbbbbbbbb', title: 'Baby Shark!' })],
    existing: new Map(plan.puts.map((r) => [r.key, r])), denySet: new Set(), now: 3
  });
  assert.ok(!third.puts.some((r) => r.key === 'yt:bbbbbbbbbbb'), 'the merged-away id came back');
  assert.deepEqual(third.newLiveKeys, [], 'the merged-away id was gifted again');
});

test('resolveWatchContext: 🎁 is a VIEW, so a gift browses where the video really lives', () => {
  // The under-player grid is how the child reaches the next video, so an empty one is a
  // dead end. Opening a gift UNWRAPS it, which removes it from the sparse by_gift index —
  // so paging 'new' returned fewer items than the child could see, and NOTHING at all when
  // it was the last gift.
  const gift = { key: 'yt:aaaaaaaaaaa', scopeId: 'lib:1', folderId: 'ch:' + CH };
  const fromGift = resolveWatchContext({ item: gift, folderViewId: 'new', libScope: 'lib:1', profileScope: 'prof:p1' });
  assert.equal(fromGift.folderId, 'ch:' + CH, "the gift folder was paged instead of the video's own");
  assert.equal(fromGift.scope, 'lib:1');

  // a REAL folder view still wins over the record: a virtual 🎞️ group folder is not
  // stored on the record, so item.folderId cannot express it (v1.0.12)
  assert.equal(resolveWatchContext({ item: gift, folderViewId: 'grp:' + CH, libScope: 'lib:1' }).folderId, 'grp:' + CH);
  assert.equal(resolveWatchContext({ item: gift, folderViewId: 'sheet', libScope: 'lib:1' }).folderId, 'sheet');

  // video→video from the under-player grid keeps the context it already had
  assert.equal(resolveWatchContext({
    item: { key: 'yt:bbbbbbbbbbb', scopeId: 'lib:1', folderId: 'sheet' },
    isWatching: true, prevFolderId: 'grp:' + CH, libScope: 'lib:1'
  }).folderId, 'grp:' + CH);

  // '~pending' is a parking slot and must NEVER be browsed — it is in no index
  const parked = { key: 'yt:ccccccccccc', scopeId: 'lib:1', folderId: '~pending', homeFolderId: 'sheet' };
  assert.equal(resolveWatchContext({ item: parked, libScope: 'lib:1' }).folderId, 'sheet');
  assert.equal(resolveWatchContext({ item: { ...parked, homeFolderId: '~pending' }, libScope: 'lib:1' }).folderId, null);

  // opened from SEARCH (no folder view): the record's own folder
  assert.equal(resolveWatchContext({ item: gift, folderViewId: null, libScope: 'lib:1' }).folderId, 'ch:' + CH);
  // 'mine' resolves against the PROFILE scope, not the library
  assert.equal(resolveWatchContext({
    item: { key: 'yt:ddddddddddd', folderId: 'mine' }, libScope: 'lib:1', profileScope: 'prof:p1'
  }).scope, 'prof:p1');
  assert.doesNotThrow(() => resolveWatchContext({}));
  assert.doesNotThrow(() => resolveWatchContext());
});

/* ---------------- standalone playlists as a source (v1.0.26) ---------------- */

test('a playlist video whose channel is ALSO subscribed lands in the CHANNEL folder', () => {
  // The parent's rule: adding a channel and a playlist of that same channel must not
  // produce two folders holding the same videos. Duplicate RECORDS were never the risk
  // (planMutations keys on yt:<videoId>); the FOLDER is, because folderId is in
  // DIFF_FIELDS — two passes that disagreed would rewrite the record on every sync,
  // flipping it between folders and breaking the churn-free invariant.
  const subs = ['UCaaaaaaaaaaaaaaaaaaaaaa'];
  assert.equal(playlistVideoFolder({
    ownerChannelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', playlistId: 'PL123', subscribedChannelIds: subs
  }), 'ch:UCaaaaaaaaaaaaaaaaaaaaaa');

  // a FOREIGN video in the same playlist keeps the playlist folder — a curated playlist
  // mixes creators, and that is the whole point of adding one
  assert.equal(playlistVideoFolder({
    ownerChannelId: 'UCbbbbbbbbbbbbbbbbbbbbbb', playlistId: 'PL123', subscribedChannelIds: subs
  }), 'pl:PL123');

  // playlistItems omits videoOwnerChannelId for private/deleted entries — no owner means
  // no unification claim, so it stays with the playlist
  assert.equal(playlistVideoFolder({ ownerChannelId: '', playlistId: 'PL123', subscribedChannelIds: subs }), 'pl:PL123');

  // a Set is accepted as well as an array (sync2 passes a Set)
  assert.equal(playlistVideoFolder({
    ownerChannelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', playlistId: 'PL123', subscribedChannelIds: new Set(subs)
  }), 'ch:UCaaaaaaaaaaaaaaaaaaaaaa');

  // no subscriptions at all
  assert.equal(playlistVideoFolder({ ownerChannelId: 'UCaaa', playlistId: 'PL1' }), 'pl:PL1');
  // never throws, and never invents a folder id out of nothing
  assert.equal(playlistVideoFolder(), null);
  assert.equal(playlistVideoFolder({ ownerChannelId: 'UCaaa' }), null);
});

test('the unify rule is ORDER-FREE — playlist first or channel first, same answer', () => {
  // The self-healing property. Add the playlist, then subscribe to the channel: the next
  // sync re-plans those videos and folderId moves them into the channel folder by itself.
  const before = playlistVideoFolder({ ownerChannelId: 'UCx', playlistId: 'PL1', subscribedChannelIds: [] });
  const after = playlistVideoFolder({ ownerChannelId: 'UCx', playlistId: 'PL1', subscribedChannelIds: ['UCx'] });
  assert.equal(before, 'pl:PL1');
  assert.equal(after, 'ch:UCx');
  // and it is STABLE once there: re-running with the same inputs never flips back
  assert.equal(playlistVideoFolder({ ownerChannelId: 'UCx', playlistId: 'PL1', subscribedChannelIds: ['UCx'] }), after);
});

test('one video reached from BOTH a channel and a playlist collapses to ONE record', () => {
  // The duplicate check the parent asked for. Both passes emit the same key, and the
  // second candidate must not create a second row — nor churn the first one.
  const CHAN = 'UCabcdefghijklmnopqrstuv';
  const fromChannel = cand({ id: 'dup12345678', channelId: CHAN, folderId: 'ch:' + CHAN, origin: 'channel' });
  const fromPlaylist = cand({ id: 'dup12345678', channelId: CHAN, folderId: 'ch:' + CHAN, origin: 'playlist' });
  const p1 = planMutations({ candidates: [fromChannel, fromPlaylist], existing: new Map(), denySet: new Set(), now: 1 });
  assert.equal(p1.puts.filter((x) => x.key === 'yt:dup12345678').length, 1, 'the same video was stored twice');

  // …and a SECOND sync over both sources emits nothing at all (the churn invariant)
  const existing = new Map(p1.puts.map((x) => [x.key, x]));
  const p2 = planMutations({ candidates: [fromChannel, fromPlaylist], existing, denySet: new Set(), now: 2 });
  assert.deepEqual(p2.puts, [], 'the two sources fight over the record on every sync');
});

/* ---------------- the rejected archive expires (v1.0.26) ---------------- */

const DAY = 24 * 60 * 60 * 1000;

test('a rejection is recoverable for exactly the window, then purged', () => {
  const now = 1_700_000_000_000;
  const recs = [
    { key: 'old', rejectedAt: now - 31 * DAY },
    { key: 'edge', rejectedAt: now - 30 * DAY },   // exactly at the deadline
    { key: 'nearly', rejectedAt: now - 29 * DAY },
    { key: 'fresh', rejectedAt: now - 1 * DAY }
  ];
  const { expired, daysLeft } = planRejectedPurge(recs, { now, days: 30 });
  assert.deepEqual(expired.sort(), ['edge', 'old'], 'the deadline must be inclusive');
  assert.equal(daysLeft.get('nearly'), 1, 'the last day must read as 1, never 0');
  assert.equal(daysLeft.get('fresh'), 29);
  // a purged row has no countdown — it is gone, not "0 days left"
  assert.equal(daysLeft.has('old'), false);
});

test('a record with NO rejectedAt is NEVER auto-purged', () => {
  // The safe direction, and it is reachable: rows written before this existed, and rows
  // arriving from a peer still running an older app. Showing an old video in the archive
  // costs nothing; deleting one the parent might still want back cannot be undone — for a
  // video inside a channel there is no way back at all, since only a SHEET re-add revokes
  // a tombstone and a channel video has no row of its own.
  const now = 1_700_000_000_000;
  const recs = [
    { key: 'nodate' },
    { key: 'null', rejectedAt: null },
    { key: 'zero', rejectedAt: 0 },
    { key: 'junk', rejectedAt: 'yesterday' },
    { key: 'nan', rejectedAt: NaN }
  ];
  const { expired, daysLeft } = planRejectedPurge(recs, { now, days: 30 });
  assert.deepEqual(expired, [], 'a record of unknown age was deleted permanently');
  assert.equal(daysLeft.size, 0, 'and it must not claim a countdown either');
});

test('planRejectedPurge never throws, and a future timestamp is not "expired"', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(planRejectedPurge().expired, []);
  assert.deepEqual(planRejectedPurge(null).expired, []);
  assert.deepEqual(planRejectedPurge([null, {}, { rejectedAt: 5 }]).expired, []); // no key
  // clock skew between two devices must not delete something early
  const skewed = planRejectedPurge([{ key: 'future', rejectedAt: now + 5 * DAY }], { now, days: 30 });
  assert.deepEqual(skewed.expired, []);
  assert.ok(skewed.daysLeft.get('future') >= 30);
  // the window is configurable
  assert.deepEqual(planRejectedPurge([{ key: 'a', rejectedAt: now - 8 * DAY }], { now, days: 7 }).expired, ['a']);
  // …and a NONSENSE window falls back to the default rather than meaning "delete
  // everything now". A zero here would be a config typo, and the cost of obeying it is
  // the whole archive, permanently.
  const old8 = [{ key: 'a', rejectedAt: now - 8 * DAY }];
  assert.deepEqual(planRejectedPurge(old8, { now, days: 0 }).expired, [], 'days:0 wiped the archive');
  assert.deepEqual(planRejectedPurge(old8, { now, days: -5 }).expired, []);
  assert.deepEqual(planRejectedPurge(old8, { now, days: 'x' }).expired, []);
});

/* ---------------- sharing tells the parent what happened (v1.0.26) ---------------- */

test('EVERY share outcome has a message — silence is what the bug was', () => {
  // handleShare had seven silent `return`s and no success message either, so a parent
  // sharing from YouTube saw the same nothing whether the video was added, parked for
  // approval, a duplicate, previously deleted, or dropped. "Sharing does not work" could
  // not be diagnosed from inside the app.
  for (const reason of SHARE_REASONS) {
    const o = shareOutcome(reason);
    assert.ok(o && o.text, `no message for '${reason}'`);
    assert.ok(['ok', 'warn', 'err'].includes(o.kind), `bad kind for '${reason}': ${o.kind}`);
  }
  assert.ok(SHARE_REASONS.length >= 10, 'the outcome table lost routes');
});

test('a share that WORKED and one that failed never read the same', () => {
  assert.equal(shareOutcome('added').kind, 'ok');
  assert.equal(shareOutcome('channel-added').kind, 'ok');
  assert.equal(shareOutcome('playlist-added').kind, 'ok');
  // parked for approval is NOT a failure, but it is not "done" either — the parent has to
  // know to go and look, which is exactly the case that read as "nothing happened".
  assert.equal(shareOutcome('pending').kind, 'warn');
  assert.match(shareOutcome('pending').text, /ממתינים/, 'it must say WHERE to find it');
  // a previously deleted video is refused on purpose — say so, and say what to do
  assert.equal(shareOutcome('denied').kind, 'warn');
  assert.match(shareOutcome('denied').text, /נמחק/);
  for (const r of ['unsupported', 'no-library', 'resolve-failed', 'failed']) {
    assert.equal(shareOutcome(r).kind, 'err', `${r} should read as a failure`);
  }
});

test('an UNKNOWN reason still produces a failure message, never silence', () => {
  // The whole point is that no route can be silent — including one added later that
  // forgets to register itself here.
  assert.equal(shareOutcome('something-new-someone-added').kind, 'err');
  assert.ok(shareOutcome(undefined).text);
  assert.ok(shareOutcome(null).text);
  assert.ok(shareOutcome('').text);
});

/* ---------------- PIN recovery (v1.0.26) ---------------- */

test('planPinRecovery: no request is "none", and only a real timestamp starts a clock', async () => {
  const { planPinRecovery } = await import('../www/js/plan.js');
  const now = 1_000_000_000_000;
  for (const bad of [undefined, null, 0, -1, NaN, 'nonsense', {}]) {
    const p = planPinRecovery({ requestedAt: bad, now });
    assert.equal(p.state, 'none', `requestedAt=${JSON.stringify(bad)}`);
    assert.equal(p.msLeft, 0);
  }
  assert.equal(planPinRecovery({}).state, 'none');      // no argument at all
  assert.equal(planPinRecovery().state, 'none');
});

test('planPinRecovery: waits the full window, then goes ready', async () => {
  const { planPinRecovery } = await import('../www/js/plan.js');
  const at = 1_000_000_000_000;
  const H = 3600000;
  assert.deepEqual(planPinRecovery({ requestedAt: at, now: at }),
    { state: 'waiting', msLeft: 24 * H, hoursLeft: 24 });
  assert.equal(planPinRecovery({ requestedAt: at, now: at + 23 * H }).state, 'waiting');
  assert.equal(planPinRecovery({ requestedAt: at, now: at + 23 * H }).hoursLeft, 1);
  // the boundary itself opens the door
  assert.equal(planPinRecovery({ requestedAt: at, now: at + 24 * H }).state, 'ready');
  assert.equal(planPinRecovery({ requestedAt: at, now: at + 99 * H }).state, 'ready');
});

test('planPinRecovery: a nonsense window falls back to 24h, NEVER to a short one', async () => {
  const { planPinRecovery } = await import('../www/js/plan.js');
  const at = 1_000_000_000_000;
  // A `Math.max(1, Number(hours) || 24)` would clamp these to a ONE-HOUR wait — which for
  // this feature means handing the parent screen to the child the same afternoon.
  for (const bad of [0, -5, NaN, undefined, null, 'x', Infinity, -Infinity]) {
    const p = planPinRecovery({ requestedAt: at, now: at + 2 * 3600000, hours: bad });
    assert.equal(p.state, 'waiting', `hours=${JSON.stringify(bad)} must still be waiting`);
    assert.equal(p.hoursLeft, 22, `hours=${JSON.stringify(bad)} must fall back to 24h`);
  }
  // an explicit, sane override is honoured
  assert.equal(planPinRecovery({ requestedAt: at, now: at + 2 * 3600000, hours: 1 }).state, 'ready');
});

test('planPinRecovery: a clock moved BACKWARDS only ever lengthens the wait', async () => {
  const { planPinRecovery } = await import('../www/js/plan.js');
  const at = 1_000_000_000_000;
  // requestedAt in the future — the safe direction, and it must not go negative or ready.
  const p = planPinRecovery({ requestedAt: at + 50 * 3600000, now: at });
  assert.equal(p.state, 'waiting');
  assert.ok(p.msLeft > 24 * 3600000, 'a future request must not shorten the wait');
  assert.ok(p.msLeft >= 0);
});

test('pinRecoveryLabel: never says "0 שעות", switches to minutes near the end', async () => {
  const { planPinRecovery, pinRecoveryLabel } = await import('../www/js/plan.js');
  const at = 1_000_000_000_000, H = 3600000;
  assert.equal(pinRecoveryLabel(planPinRecovery({ requestedAt: at, now: at })),
    'אפשר יהיה לאפס את קוד ההורים בעוד 24 שעות');
  assert.match(pinRecoveryLabel(planPinRecovery({ requestedAt: at, now: at + 23.5 * H })), /30 דקות/);
  // one second left must read as a minute, never as zero of anything
  const nearly = pinRecoveryLabel(planPinRecovery({ requestedAt: at, now: at + 24 * H - 1000 }));
  assert.match(nearly, /1 דקות/);
  assert.doesNotMatch(nearly, /\b0\b/);
  // states with no countdown produce no text at all
  assert.equal(pinRecoveryLabel(planPinRecovery({ requestedAt: at, now: at + 25 * H })), '');
  assert.equal(pinRecoveryLabel(planPinRecovery({ requestedAt: 0, now: at })), '');
  assert.equal(pinRecoveryLabel(null), '');
});

test('planRecoveryRoute: the device credential is only ever an ADDITION', async () => {
  const { planRecoveryRoute, planPinRecovery } = await import('../www/js/plan.js');
  const at = 1_000_000_000_000, H = 3600000;
  const none    = planPinRecovery({ requestedAt: 0, now: at });
  const waiting = planPinRecovery({ requestedAt: at, now: at + 2 * H });
  const ready   = planPinRecovery({ requestedAt: at, now: at + 30 * H });

  // nothing requested yet: the device decides which route the parent gets
  assert.equal(planRecoveryRoute({ deviceAuth: true,  recovery: none }), 'device');
  assert.equal(planRecoveryRoute({ deviceAuth: false, recovery: none }), 'wait-start');

  // AN EXISTING REQUEST ALWAYS WINS. A wait already running is state the parent created —
  // possibly on a day the sensor would not cooperate — so a capable device must not hide
  // it behind a prompt they may fail again, and must never silently discard it.
  for (const dev of [true, false]) {
    assert.equal(planRecoveryRoute({ deviceAuth: dev, recovery: waiting }), 'wait-pending', `dev=${dev}`);
    assert.equal(planRecoveryRoute({ deviceAuth: dev, recovery: ready }), 'wait-ready', `dev=${dev}`);
  }
});

test('planRecoveryRoute: anything but an explicit TRUE falls back to the wait', async () => {
  const { planRecoveryRoute } = await import('../www/js/plan.js');
  // canDeviceAuth() is a native round trip. A browser, an APK built before the plugin
  // method existed, or a bridge that threw must never be mistaken for a capable device —
  // that would offer a route the parent cannot take and hide the one they can.
  for (const junk of [undefined, null, 0, '', 'yes', 1, {}, NaN]) {
    assert.equal(planRecoveryRoute({ deviceAuth: junk, recovery: null }), 'wait-start',
      `deviceAuth=${JSON.stringify(junk)}`);
  }
  // and a missing/!junk recovery object is simply "nothing requested"
  for (const junk of [undefined, null, {}, { state: 'none' }, 'nonsense']) {
    assert.equal(planRecoveryRoute({ deviceAuth: false, recovery: junk }), 'wait-start');
  }
  assert.equal(planRecoveryRoute({}), 'wait-start');
  assert.equal(planRecoveryRoute(), 'wait-start');
});

/* ---------------- the channel-add waiting screen (v1.0.26) ---------------- */

test('channelAddWait: every stage has real text, and unknown stages say nothing', async () => {
  const { channelAddWait, CHANNEL_ADD_STAGES } = await import('../www/js/plan.js');
  assert.ok(CHANNEL_ADD_STAGES.length >= 5, 'the flow lost most of its steps');
  for (const stage of CHANNEL_ADD_STAGES) {
    const t = channelAddWait(stage);
    assert.ok(t && t.title && t.step, `${stage} has no text`);
    // A waiting screen with no explanation is the same ambiguity in a different colour —
    // the whole point of the field report. The default title must never leak through.
    assert.notEqual(t.title, 'בטעינה…', `${stage} falls back to the generic title`);
    assert.ok(t.title.length > 3 && t.step.length > 3, `${stage} text is too thin`);
  }
  // An unknown stage answers null so the caller shows the generic screen rather than
  // `undefined` — but the invariants test is what stops one being introduced silently.
  for (const junk of ['nope', '', null, undefined, 0, {}]) {
    assert.equal(channelAddWait(junk), null, JSON.stringify(junk));
  }
});

test('channelAddWait: the COUNT is part of the sentence when we know it', async () => {
  const { channelAddWait } = await import('../www/js/plan.js');
  // "מאשרים 109 סרטונים" tells the parent what is happening AND why it is not instant.
  assert.match(channelAddWait('approve', { count: 109 }).title, /109/);
  assert.match(channelAddWait('building', { count: 42 }).step, /42/);
  // …and a missing or nonsense count must never render "מאשרים 0 סרטונים" or "NaN"
  for (const bad of [0, -3, NaN, null, undefined, 'x', {}]) {
    const a = channelAddWait('approve', { count: bad });
    const b = channelAddWait('building', { count: bad });
    for (const t of [a.title, a.step, b.title, b.step]) {
      assert.doesNotMatch(t, /NaN|undefined|null/, `count=${JSON.stringify(bad)} leaked into "${t}"`);
      assert.doesNotMatch(t, /\b0\b/, `count=${JSON.stringify(bad)} rendered a zero: "${t}"`);
    }
  }
  assert.deepEqual(channelAddWait('approve'), channelAddWait('approve', {}));
});

test('channelAddOutcome: after a MANUAL pick the message reports the pick, not a queue', async () => {
  const { channelAddOutcome } = await import('../www/js/plan.js');
  // THE BUG (browser-caught while verifying the waiting screens): the parent chose
  // "אישור ידני", kept 2 and rejected 1 — and was told "3 סרטונים ממתינים לאישור",
  // a queue they had just emptied by hand.
  assert.match(channelAddOutcome(false, 3, {}, { kept: 2, rejected: 1 }), /2 סרטונים אושרו ו-1 נדחו/);
  assert.match(channelAddOutcome(false, 3, {}, { kept: 3, rejected: 0 }), /3 סרטונים אושרו/);
  assert.match(channelAddOutcome(false, 3, {}, { kept: 0, rejected: 3 }), /נדחו/);
  assert.doesNotMatch(channelAddOutcome(false, 3, {}, { kept: 2, rejected: 1 }), /ממתינים/);
  // the playlist wording carries through the pick branch too
  assert.match(channelAddOutcome(false, 3, { isPlaylist: true }, { kept: 2, rejected: 1 }), /^רשימת ההשמעה/);
  // no pick (אחר כך / dismiss) keeps the honest "waiting" sentence — that queue is real
  assert.match(channelAddOutcome(false, 3, {}, null), /ממתינים לאישור/);
  assert.match(channelAddOutcome(false, 3, {}, { kept: 0, rejected: 0 }), /ממתינים לאישור/);
});

/* ---------------- the folded parent library (v1.0.28) ---------------- */

test('groupLibraryByFolder: groups by the folder the CHILD sees, titles from the subs', async () => {
  const { groupLibraryByFolder } = await import('../www/js/plan.js');
  const subs = [
    { channelId: 'UCaaa', kind: 'channel', title: 'ערוץ הדינוזאורים', order: 2 },
    { channelId: 'PLbbb', kind: 'playlist', titleOverride: 'שירי שינה', order: 1 }
  ];
  const recs = [
    { key: 'yt:1', folderId: 'ch:UCaaa' },
    { key: 'yt:2', folderId: 'pl:PLbbb' },
    { key: 'yt:3', folderId: 'sheet' },
    { key: 'yt:4', folderId: 'mine' },
    // parked-shape leftovers group by their HOME, like everywhere else in the app
    { key: 'yt:5', folderId: '~pending', homeFolderId: 'ch:UCaaa' }
  ];
  const g = groupLibraryByFolder(recs, subs);
  assert.deepEqual(g.map((x) => x.id), ['pl:PLbbb', 'ch:UCaaa', 'sheet', 'mine']);
  assert.deepEqual(g.map((x) => x.title), ['שירי שינה', 'ערוץ הדינוזאורים', 'סרטונים נוספים', 'סרטונים אישיים']);
  assert.deepEqual(g.find((x) => x.id === 'ch:UCaaa').records.map((r) => r.key), ['yt:1', 'yt:5']);
  // order inside a group is the CALLER's order — this helper must never re-sort
  const flipped = groupLibraryByFolder([recs[4], recs[0]], subs);
  assert.deepEqual(flipped[0].records.map((r) => r.key), ['yt:5', 'yt:1']);
});

test('groupLibraryByFolder: an unsubscribed leftover is grouped, never lost', async () => {
  const { groupLibraryByFolder } = await import('../www/js/plan.js');
  // a video whose channel was deleted moments ago, mid-refresh: it must still render
  // somewhere the parent can find and delete it
  const g = groupLibraryByFolder(
    [{ key: 'yt:1', folderId: 'ch:UCgone', srcChannelTitle: 'ערוץ ישן' }], []);
  assert.equal(g.length, 1);
  assert.equal(g[0].title, 'ערוץ ישן');
  assert.deepEqual(groupLibraryByFolder([], []), []);
  assert.deepEqual(groupLibraryByFolder(null, null), []);
  // junk records are skipped, not thrown on
  assert.deepEqual(groupLibraryByFolder([null, {}], []), []);
});

/* ---------------- resume the last profile on launch (v1.0.29) ---------------- */

test('planBootProfile: resumes the stored profile, device-locally', async () => {
  const { planBootProfile } = await import('../www/js/plan.js');
  const ids = ['p1', 'p2'];
  assert.equal(planBootProfile({ storedId: 'p2', profileIds: ids }), 'p2');
  // the three fallbacks, each load-bearing:
  assert.equal(planBootProfile({ storedId: '', profileIds: ids }), null, 'nothing stored');
  assert.equal(planBootProfile({ storedId: 'pGone', profileIds: ids }), null,
    'a deleted (possibly peer-tombstoned) profile must not auto-enter');
  assert.equal(planBootProfile({ storedId: 'p2', profileIds: ids, hasQueuedShare: true }), null,
    'a cold-start share gets the PICKER — it is that share\'s routing question (v1.0.23)');
  // junk never throws
  assert.equal(planBootProfile(), null);
  assert.equal(planBootProfile({ storedId: null, profileIds: null }), null);
});

/* ---------------- scheduled per-profile lock (v1.0.31) ---------------- */

test('evalScheduledLock: the five phases, and off when disabled', async () => {
  const { evalScheduledLock } = await import('../www/js/plan.js');
  const M = 60000;
  // afterMin 0 (default) or nonsense ⇒ the feature is OFF
  for (const a of [0, -5, NaN, null, undefined, 'x']) {
    assert.equal(evalScheduledLock({ afterMin: a, armedAt: 1, now: 9e9 }).phase, 'off', `after=${a}`);
  }
  // armed but not elapsed ⇒ counting, with the real remaining time
  assert.deepEqual(evalScheduledLock({ afterMin: 10, armedAt: 1000, now: 1000 + 3 * M }),
    { phase: 'counting', msLeft: 7 * M });
  // not armed ⇒ idle (waiting for the first video)
  assert.equal(evalScheduledLock({ afterMin: 10, armedAt: 0 }).phase, 'idle');
  // elapsed ⇒ due (the caller must start the lock)
  assert.equal(evalScheduledLock({ afterMin: 10, armedAt: 1000, now: 1000 + 10 * M }).phase, 'due');
  assert.equal(evalScheduledLock({ afterMin: 10, armedAt: 1000, now: 1000 + 99 * M }).phase, 'due');
  // locked wins over everything while it runs, and never reports negative
  assert.deepEqual(evalScheduledLock({ afterMin: 10, armedAt: 1000, lockedUntil: 5000, now: 2000 }),
    { phase: 'locked', msLeft: 3000 });
  assert.equal(evalScheduledLock({ afterMin: 10, lockedUntil: 5000, now: 9000 }).msLeft, 0,
    'an expired lock reports 0, not a negative — the caller then clears it');
  assert.equal(evalScheduledLock().phase, 'off');
});

test('scheduledLockDurationMs: nonsense falls back to the DEFAULT, never 0', async () => {
  const { scheduledLockDurationMs } = await import('../www/js/plan.js');
  assert.equal(scheduledLockDurationMs(15), 15 * 60000);
  for (const bad of [0, -3, NaN, null, undefined, 'x', Infinity]) {
    assert.equal(scheduledLockDurationMs(bad, 20), 20 * 60000, `dur=${bad} must default, a 0 would unlock instantly`);
  }
  assert.equal(scheduledLockDurationMs(0, -1), 20 * 60000, 'a nonsense default itself falls back to 20');
});

test('lockCountdownLabel: mm:ss, never negative, never blank', async () => {
  const { lockCountdownLabel } = await import('../www/js/plan.js');
  assert.equal(lockCountdownLabel(65000), '1:05');
  assert.equal(lockCountdownLabel(600000), '10:00');
  assert.equal(lockCountdownLabel(999), '0:01');
  for (const z of [0, -1, NaN, null, undefined]) assert.equal(lockCountdownLabel(z), '0:00', String(z));
});

/* ---------------- the sources tab's primary action (v1.0.34) ---------------- */

test('screenOffMinutes: never-written = the DEFAULT, explicit 0 = off, nonsense = the default', async () => {
  const { screenOffMinutes } = await import('../www/js/plan.js');
  // never written (getSetting fallback) ⇒ the feature is ON out of the box.
  // Number(null) === 0, so a coerce-first implementation reads these as "off" — the bug
  // this function exists to prevent.
  for (const unset of [null, undefined, '']) {
    assert.equal(screenOffMinutes(unset, 10), 10, `unset=${String(unset)}`);
  }
  // an explicit 0 is a real parental answer: never turn off (today's behavior)
  assert.equal(screenOffMinutes(0, 10), 0);
  assert.equal(screenOffMinutes('0', 10), 0);
  // nonsense falls back to the DEFAULT, never to a short window (the planRejectedPurge rule)
  for (const bad of [-1, -99, NaN, 'abc', Infinity, -Infinity]) {
    assert.equal(screenOffMinutes(bad, 10), 10, `bad=${String(bad)}`);
  }
  // real values pass through, floored and capped at the input's own bound (600)
  assert.equal(screenOffMinutes(25, 10), 25);
  assert.equal(screenOffMinutes(7.9, 10), 7);
  assert.equal(screenOffMinutes(9999, 10), 600);
  // a nonsense default itself falls back to 10
  assert.equal(screenOffMinutes(null, -1), 10);
  assert.equal(screenOffMinutes(null, 'x'), 10);
});

test('evalIdleSleep: off while nothing plays or the feature is disabled — wake is not held there', async () => {
  const { evalIdleSleep } = await import('../www/js/plan.js');
  const M = 60000;
  // disabled (0) or nonsense minutes ⇒ off, whatever else says
  for (const a of [0, -5, NaN, null, undefined, 'x']) {
    assert.equal(evalIdleSleep({ afterMin: a, playing: true, lastInputAt: 1, now: 9e9 }), 'off', `after=${a}`);
  }
  // not playing ⇒ off even mid-prompt: something else paused the video, the question
  // no longer applies (and the OS already owns the screen while nothing plays)
  assert.equal(evalIdleSleep({ afterMin: 10, playing: false, lastInputAt: 1, now: 1 + 60 * M }), 'off');
  assert.equal(evalIdleSleep({ afterMin: 10, playing: false, promptAt: 1, now: 9e9 }), 'off');
});

test('evalIdleSleep: counting → prompt at N minutes → sleep after the unanswered window', async () => {
  const { evalIdleSleep } = await import('../www/js/plan.js');
  const M = 60000;
  const base = { afterMin: 10, playing: true, promptSec: 45 };
  // input fresh ⇒ counting
  assert.equal(evalIdleSleep({ ...base, lastInputAt: 1000, now: 1000 + 9 * M }), 'counting');
  // N minutes of silence ⇒ prompt (the caller shows the overlay and stamps promptAt)
  assert.equal(evalIdleSleep({ ...base, lastInputAt: 1000, now: 1000 + 10 * M }), 'prompt');
  // prompt up, window not over ⇒ still prompt
  assert.equal(evalIdleSleep({ ...base, lastInputAt: 1000, promptAt: 5000, now: 5000 + 44000 }), 'prompt');
  // window over ⇒ sleep: save position, THEN pause in place — never stop()
  assert.equal(evalIdleSleep({ ...base, lastInputAt: 1000, promptAt: 5000, now: 5000 + 45000 }), 'sleep');
  // an answered prompt (caller reset promptAt and stamped fresh input) ⇒ counting again
  assert.equal(evalIdleSleep({ ...base, lastInputAt: 5000 + 46000, promptAt: 0, now: 5000 + 47000 }), 'counting');
  // no input observed yet ⇒ counting, never an instant prompt
  assert.equal(evalIdleSleep({ ...base, lastInputAt: 0, now: 9e9 }), 'counting');
  assert.equal(evalIdleSleep(), 'off');
});

/* ---------------- the parent's channel list sections (v1.0.32) ---------------- */

test('planChannelSections: fresh = undecided AND inside the 24h window, newest first', () => {
  const now = 1000 * NEW_CHANNEL_WINDOW_MS; // any fixed clock
  const H = 60 * 60 * 1000;
  const rows = [
    { channelId: 'A', addedAt: now - 2 * H },                        // fresh, newer
    { channelId: 'B', addedAt: now - 20 * H },                       // fresh, older
    { channelId: 'C', addedAt: now - 2 * H, decidedAt: now - H },    // decided -> rest
    { channelId: 'D', addedAt: now - 30 * H },                       // window passed -> rest
    { channelId: 'E' },                                              // pre-v1.0.21 row, no addedAt
  ];
  const { fresh, rest } = planChannelSections(rows, { now });
  assert.deepEqual(fresh.map((c) => c.channelId), ['A', 'B'], 'undecided + in-window only, newest first');
  // rest is newest-first too, and the age-less legacy row sinks to the END — surprising
  // an old subscription into "חדשים" (or to the top of the list) would read as a bug
  assert.deepEqual(rest.map((c) => c.channelId), ['C', 'D', 'E']);
});

test('planChannelSections: "אחר כך" is not a decision, and 24h drains the section by itself', () => {
  const now = 1000 * NEW_CHANNEL_WINDOW_MS;
  const undecided = { channelId: 'A', addedAt: now - NEW_CHANNEL_WINDOW_MS + 1000 };
  assert.equal(planChannelSections([undecided], { now }).fresh.length, 1, 'still inside the window');
  // …and the SAME row a little later has drained into the regular list, untouched
  assert.equal(planChannelSections([undecided], { now: now + 2000 }).fresh.length, 0);
  assert.equal(planChannelSections([undecided], { now: now + 2000 }).rest.length, 1);
});

test('planChannelSections: a peer clock slightly AHEAD still reads as new; a broken one does not', () => {
  const now = 1000 * NEW_CHANNEL_WINDOW_MS;
  // a phone 10 minutes ahead adds a channel; the tablet must still show it as new
  assert.equal(planChannelSections([{ channelId: 'A', addedAt: now + 10 * 60 * 1000 }], { now }).fresh.length, 1);
  // a stamp a year in the future must not pin a row into the section until then
  assert.equal(planChannelSections([{ channelId: 'A', addedAt: now + 365 * 24 * 3600 * 1000 }], { now }).fresh.length, 0);
});

test('planChannelSections never throws on junk and never drops a real row', () => {
  const now = 1000 * NEW_CHANNEL_WINDOW_MS;
  const { fresh, rest } = planChannelSections(
    [null, {}, { channelId: 'A', addedAt: 'garbage' }, { channelId: 'B', addedAt: now }], { now });
  assert.equal(fresh.length + rest.length, 2, 'junk skipped, real rows kept');
  assert.deepEqual(planChannelSections(undefined, { now }), { fresh: [], rest: [] });
});

/* ---------------- channel-logo byte cache (v1.0.32) ---------------- */

test('planLogoCache: cached bytes always render, and the render never waits for the network', () => {
  // no cache yet: paint the URL and go fetch the bytes
  assert.deepEqual(planLogoCache({ hasBlob: false, url: 'https://yt3/x.jpg' }),
    { render: 'url', fetch: true });
  // cached and current: the device serves itself, zero network
  assert.deepEqual(planLogoCache({ hasBlob: true, blobSrcUrl: 'https://yt3/x.jpg', url: 'https://yt3/x.jpg' }),
    { render: 'blob', fetch: false });
  // REBRAND (new URL): keep showing the picture we have, refresh in the background —
  // waiting for the network here is exactly the flakiness this cache exists to remove
  assert.deepEqual(planLogoCache({ hasBlob: true, blobSrcUrl: 'https://yt3/old.jpg', url: 'https://yt3/new.jpg' }),
    { render: 'blob', fetch: true });
  // dead/absent URL with cached bytes: the picture SURVIVES (the v1.0.24 lesson —
  // a stored URL that will not load is worse than no URL; stored BYTES beat both)
  assert.deepEqual(planLogoCache({ hasBlob: true, blobSrcUrl: 'https://yt3/old.jpg', url: null }),
    { render: 'blob', fetch: false });
  // nothing at all: the emoji fallback, and nothing to fetch
  assert.deepEqual(planLogoCache({ hasBlob: false, url: null }), { render: 'emoji', fetch: false });
  assert.deepEqual(planLogoCache({}), { render: 'emoji', fetch: false });
  // junk url types never trigger a fetch
  assert.deepEqual(planLogoCache({ hasBlob: false, url: 42 }), { render: 'emoji', fetch: false });
  assert.deepEqual(planLogoCache({ hasBlob: true, blobSrcUrl: 'x', url: '' }), { render: 'blob', fetch: false });
});

test('logoFirstPaint: warm memory paints the blob — the network <img> never fires', () => {
  // The unconditional `img.src = url` hit the network on EVERY render even with a full
  // byte cache (self-review catch) — the exact waste the cache exists to remove.
  assert.deepEqual(logoFirstPaint({ cachedObjUrl: 'blob:x', url: 'https://yt3/a.jpg' }),
    { kind: 'blob', src: 'blob:x' });
  assert.deepEqual(logoFirstPaint({ cachedObjUrl: null, url: 'https://yt3/a.jpg' }),
    { kind: 'url', src: 'https://yt3/a.jpg' });
  assert.deepEqual(logoFirstPaint({}), { kind: 'emoji', src: null });
  // junk never becomes a src
  assert.deepEqual(logoFirstPaint({ cachedObjUrl: 42, url: '' }), { kind: 'emoji', src: null });
});

test('planLogoDelivery: a late fetch may NEVER paint into a host that moved on', () => {
  // #folder-logo-top is ONE element shared by every folder view: channel A's fetch
  // finishing after the child opened folder B used to re-mount A's logo into B's
  // header. The hostChannelId comparison is the guard.
  assert.equal(planLogoDelivery({ imgConnected: true }), 'set', 'mounted img: just point it at the bytes');
  assert.equal(planLogoDelivery({
    imgConnected: false, hostConnected: true, hostChannelId: 'UCA', channelId: 'UCA'
  }), 'remount', 'the emoji fallback replaced the img, host still ours');
  assert.equal(planLogoDelivery({
    imgConnected: false, hostConnected: true, hostChannelId: 'UCB', channelId: 'UCA'
  }), 'skip', "the header belongs to folder B now — channel A's logo must not land there");
  assert.equal(planLogoDelivery({ imgConnected: false, hostConnected: false, channelId: 'UCA' }), 'skip');
  // a host that never carried a channel stamp is not ours either (channelRow passes no host)
  assert.equal(planLogoDelivery({ imgConnected: false, hostConnected: true, hostChannelId: null, channelId: 'UCA' }), 'skip');
  assert.equal(planLogoDelivery({}), 'skip');
});

/* ---------------- the silent import ceiling (v1.0.37) ---------------- */
// FIELD BUG, reported across four releases as "הערוץ נוסף אבל אין בו סרטונים"
// (@BARDAK613 — a channel with 97 long-form videos). Resolution was never at fault: the
// caps were literals frozen into each profile's sources row at creation, config.js carried
// the same two names with ZERO consumers, and a library at the ceiling dropped every
// candidate of every new channel SILENTLY — measured, 98 real candidates in, 0 out.

test('effectiveCaps: config is the FLOOR, so a row frozen at the old 5000 is healed', () => {
  const frozen = { maxItemsPerChannel: 500, maxItemsTotal: 5000 }; // what every profile carries
  const caps = effectiveCaps(frozen);
  assert.equal(caps.maxTotal, MAX_ITEMS_TOTAL);
  assert.ok(caps.maxTotal > 5000, 'the stored literal still wins — every existing profile stays capped');
  assert.equal(caps.maxPerChannel, MAX_ITEMS_PER_CHANNEL);
  // a HIGHER stored value is honoured (never shrink a family's library from a stale row)
  assert.equal(effectiveCaps({ maxItemsTotal: 99999 }).maxTotal, 99999);
  // …and garbage falls back to the config value rather than to 0, which would import NOTHING
  for (const bad of [null, undefined, {}, { maxItemsTotal: 0 }, { maxItemsTotal: -5 }, { maxItemsTotal: 'x' }]) {
    assert.equal(effectiveCaps(bad).maxTotal, MAX_ITEMS_TOTAL, JSON.stringify(bad));
    assert.equal(effectiveCaps(bad).maxPerChannel, MAX_ITEMS_PER_CHANNEL, JSON.stringify(bad));
  }
});

test('a capped drop is ATTRIBUTED to its source, not just counted (v1.0.37)', () => {
  // A library already at the ceiling: every candidate of the new channel is dropped.
  const existing = new Map();
  for (let i = 0; i < 20; i++) existing.set('yt:old' + i, { key: 'yt:old' + i, channelId: 'UCold', normTitle: 'old' + i });
  const cands = [];
  for (let i = 0; i < 4; i++) cands.push(cand({ id: 'new' + i, autoApprove: false }));
  const p = planMutations({ candidates: cands, existing, denySet: new Set(), caps: { maxPerChannel: 500, maxTotal: 20 } });
  assert.equal(p.puts.length, 0, 'the ceiling let something through');
  assert.equal(p.counts.capped, 4);
  assert.equal(p.drops.capped, 4);
  assert.equal(p.drops.byChannel[CH].capped, 4, 'without attribution a zero cannot name its cause');
  assert.equal(p.drops.byChannel[CH].denied, 0);
});

test('drop attribution counts UNIQUE keys, not drop events (v1.0.37)', () => {
  // One sync offers the same video several times over (the RSS window, the UULF backfill
  // and the playlists pass all cover it). Counting events reported "250 מהסרטונים שלו
  // הוסרו" for a 98-video channel — measured against the live channel.
  const deny = new Set(['yt:dup']);
  const cands = [cand({ id: 'dup' }), cand({ id: 'dup' }), cand({ id: 'dup' })];
  const p = planMutations({ candidates: cands, existing: new Map(), denySet: deny });
  assert.equal(p.counts.denied, 3, 'the raw event count is unchanged');
  assert.equal(p.drops.byChannel[CH].denied, 1, 'the number shown to the parent must be the video count');
  assert.deepEqual(p.drops.byChannel[CH].deniedKeys, ['yt:dup']);
});

test('a PLAYLIST video is attributed to the playlist too (the pendingKeysOfChannel trap)', () => {
  // A playlist video keeps its OWNER in channelId (v1.0.26), so matching on channelId
  // alone finds ZERO for a playlist — the exact shape of the v1.0.22/v1.0.26 bug.
  const PL = 'PLabcdefghijklmnopqrst';
  const c = cand({ id: 'plv', channelId: 'UCowner1234567890123456', folderId: 'pl:' + PL });
  const p = planMutations({ candidates: [c], existing: new Map(), denySet: new Set(['yt:plv']) });
  assert.equal(p.drops.byChannel[PL].denied, 1, 'the playlist itself was not attributed — its zero stays mute');
  assert.equal(p.drops.byChannel['UCowner1234567890123456'].denied, 1, 'the owner channel is attributed as well');
});

test('sourceDrops: a caller with no drop info degrades to "no drops", never to a wrong claim', () => {
  assert.deepEqual(sourceDrops(null, 'UCx'), { capped: 0, denied: 0, deniedKeys: [] });
  assert.deepEqual(sourceDrops({ byChannel: {} }, 'UCx'), { capped: 0, denied: 0, deniedKeys: [] });
  assert.deepEqual(sourceDrops({ byChannel: { UCx: { capped: 2, denied: 3, deniedKeys: ['a'] } } }, 'UCx'),
    { capped: 2, denied: 3, deniedKeys: ['a'] });
  assert.deepEqual(sourceDrops({ byChannel: { UCx: {} } }, null), { capped: 0, denied: 0, deniedKeys: [] });
});

test('channelAddOutcome: a ZERO names ITS OWN cause — library full vs removed-before (v1.0.37)', () => {
  // These two, and a channel that genuinely has nothing, produced the IDENTICAL sentence
  // "אבל לא נמצאו בו סרטונים". Both are facts about the LIBRARY, which is why the parent
  // (and four releases of fixes) kept investigating the channel.
  const full = channelAddOutcome(false, 0, { capped: 98, hasLive: false });
  const gone = channelAddOutcome(false, 0, { denied: 98, hasLive: false });
  const empty = channelAddOutcome(false, 0, { hasLive: false });
  assert.match(full, /מגבל/, 'the ceiling is not named');
  assert.match(full, /98/, 'the parent is not told how many were lost');
  assert.match(full, /מחקו/, 'the ceiling message offers no way out');
  assert.match(gone, /הוסרו בעבר/, 'a previously-removed backlog is not named');
  assert.match(gone, /98/);
  assert.notEqual(full, empty, 'a full library still reads as an empty channel');
  assert.notEqual(gone, empty, 'a removed backlog still reads as an empty channel');
  assert.notEqual(full, gone, 'the two causes are indistinguishable');
  // a PARTIAL cap is the same lie in miniature: 12 of 98 must not read as the whole channel
  const partial = channelAddOutcome(false, 12, { capped: 86 });
  assert.match(partial, /12/);
  assert.match(partial, /86/, 'the videos that never arrived are unmentioned');
  // and none of this may disturb the messages that were already right
  assert.equal(channelAddOutcome(false, 0, { hasLive: true }), 'הערוץ סונכרן ✅');
  assert.match(channelAddOutcome(false, 0, { noLongForm: true, capped: 0 }), /Shorts/);
  assert.equal(channelAddOutcome(false, 98, {}), 'הערוץ נוסף. 98 סרטונים ממתינים לאישור ברשימת "ממתינים" 👀');
});

/* ---------------- the rolling window (v1.0.39) ---------------- */
// The user's request (2026-08-09): "keep me up to date with the newest videos", answered by
// bounding growth rather than by raising a ceiling — and with their own conditions: tell me
// WHICH channel, let me mark what not to delete, or wipe the channel and keep only new ones.
// The one hard rule: this plans, it never deletes.

const wrec = (i, over = {}) => ({
  key: 'yt:w' + i, scopeId: 'lib:1', channelId: CH, folderId: 'ch:' + CH,
  state: 'live', sortKey: i, title: 'שיר ' + i, ...over
});

test('keepNewestPerChannel: never-written and every nonsense value read as OFF (v1.0.39)', () => {
  // The OPPOSITE default to screenOffMinutes, deliberately: this setting DELETES the
  // child's videos, so 0 is the only safe fallback. A mistyped tiny window must not
  // propose emptying a folder either.
  for (const off of [null, undefined, '', 0, '0', -5, NaN, Infinity, 'abc', {}, [], 9, '9']) {
    assert.equal(keepNewestPerChannel(off), 0, JSON.stringify(off));
  }
  assert.equal(keepNewestPerChannel(10), 10, 'the minimum itself must be accepted');
  assert.equal(keepNewestPerChannel(200), 200);
  assert.equal(keepNewestPerChannel('200'), 200);
  assert.equal(keepNewestPerChannel(250.7), 250, 'a fractional entry floors');
  assert.equal(keepNewestPerChannel(99999), 5000, 'capped');
});

test('planChannelWindow: keeps the NEWEST, proposes the rest, oldest included (v1.0.39)', () => {
  const records = Array.from({ length: 30 }, (_, i) => wrec(i)); // sortKey 0..29
  const p = planChannelWindow({ records, keep: 10 });
  assert.equal(p.total, 20);
  const entry = p.byChannel[CH];
  assert.equal(entry.total, 30);
  assert.equal(entry.keptCount, 10);
  // the kept ones are the highest sortKeys; the proposal must contain the OLDEST
  assert.ok(entry.over.includes('yt:w0'), 'the oldest video was not proposed');
  assert.ok(!entry.over.includes('yt:w29'), 'the NEWEST video was proposed for deletion');
  assert.equal(entry.over.length, 20);
});

test('planChannelWindow: OFF means OFF, in the planner and not only in the caller', () => {
  const records = Array.from({ length: 30 }, (_, i) => wrec(i));
  for (const keep of [0, -1, null, undefined, NaN, 'x']) {
    const p = planChannelWindow({ records, keep });
    assert.deepEqual(p.byChannel, {}, String(keep));
    assert.equal(p.total, 0);
  }
});

test('planChannelWindow: a PROTECTED video is never proposed, at any depth (v1.0.39)', () => {
  // The child's favourite is the thing an automatic window must never eat: a 5-year-old
  // rewatches one video 200 times, and it is by definition an OLD one.
  const records = Array.from({ length: 30 }, (_, i) => wrec(i));
  const p = planChannelWindow({ records, keep: 10, protectedKeys: new Set(['yt:w0', 'yt:w1']) });
  const entry = p.byChannel[CH];
  assert.ok(!entry.over.includes('yt:w0'), 'a marked favourite was proposed for deletion');
  assert.ok(!entry.over.includes('yt:w1'));
  assert.equal(entry.over.length, 18);
  // …and it does not consume a slot from the newest `keep`, or protecting favourites would
  // silently hide recent uploads instead.
  assert.ok(entry.over.includes('yt:w2'));
  // the newest 10 (w20..w29) are kept in full — protecting two OLD favourites must not
  // push a recent upload out of the window
  for (let i = 20; i < 30; i++) {
    assert.ok(!entry.over.includes('yt:w' + i), `the newest 10 must be kept in full (w${i} was proposed)`);
  }
  assert.ok(entry.over.includes('yt:w19'), 'the 11th-newest is outside a window of 10');
  assert.equal(entry.keptCount, 12);
  // an array (not a Set) must work too — a caller reading keys from the DB
  assert.equal(planChannelWindow({ records, keep: 10, protectedKeys: ['yt:w0'] }).byChannel[CH].over.length, 19);
});

test('planChannelWindow: PARKED records are none of the window\'s business (v1.0.39)', () => {
  // pending/rejected are invisible to the child and owned by the approval queue and its
  // 30-day purge. Deleting them here would answer a question the parent was never asked.
  const records = [
    ...Array.from({ length: 5 }, (_, i) => wrec(i)),
    ...Array.from({ length: 40 }, (_, i) => wrec(100 + i, { state: 'pending', folderId: '~pending', homeFolderId: 'ch:' + CH })),
    ...Array.from({ length: 40 }, (_, i) => wrec(200 + i, { state: 'rejected', folderId: '~rejected', homeFolderId: 'ch:' + CH }))
  ];
  assert.deepEqual(planChannelWindow({ records, keep: 10 }).byChannel, {},
    'the window reached into the approval queue');
});

test('planChannelWindow: loose singles have no window; a PLAYLIST folder has one', () => {
  const singles = Array.from({ length: 30 }, (_, i) => wrec(i, { folderId: 'sheet', channelId: null }));
  assert.deepEqual(planChannelWindow({ records: singles, keep: 10 }).byChannel, {},
    'the shared "סרטונים נוספים" list is not a channel and must not be pruned');
  const PL = 'PLxyz';
  const pl = Array.from({ length: 30 }, (_, i) => wrec(i, { folderId: 'pl:' + PL, channelId: 'UCowner' }));
  const p = planChannelWindow({ records: pl, keep: 10 });
  assert.equal(p.byChannel[PL].over.length, 20, 'a playlist folder is keyed by the PLAYLIST');
  assert.equal(p.byChannel.UCowner, undefined, 'and not by the owner channel');
});

test('planChannelWindow: each channel gets its own window', () => {
  const CH2 = 'UCsecond0000000000000001';
  const records = [
    ...Array.from({ length: 15 }, (_, i) => wrec(i)),
    ...Array.from({ length: 12 }, (_, i) => wrec(500 + i, { channelId: CH2, folderId: 'ch:' + CH2 }))
  ];
  const p = planChannelWindow({ records, keep: 10 });
  assert.equal(p.byChannel[CH].over.length, 5);
  assert.equal(p.byChannel[CH2].over.length, 2);
  assert.equal(p.total, 7);
});

test('pruneReviewList: a proposal too big to render still states its real size (v1.0.39)', () => {
  const keys = Array.from({ length: 4000 }, (_, i) => 'yt:k' + i);
  const r = pruneReviewList(keys, 200);
  assert.equal(r.rows.length, 200, 'the screen would build 4000 thumbnails');
  assert.equal(r.hidden, 3800, 'the parent must be told what they cannot see');
  assert.equal(r.total, 4000);
  // small proposals show whole, and garbage never throws
  assert.deepEqual(pruneReviewList(['a', 'b'], 200), { rows: ['a', 'b'], hidden: 0, total: 2 });
  assert.deepEqual(pruneReviewList(null, 200), { rows: [], hidden: 0, total: 0 });
  assert.equal(pruneReviewList(keys, 0).rows.length, 200, 'a nonsense cap falls back, never to 0 rows');
});

test('protectedWindowKeys: reads a MAP of child state, not only an object (v1.0.39)', () => {
  // THE BUG THE BROWSER CAUGHT. Per-child state is a Map (app.loadGiftStates), and the
  // first version read it with Object.entries — which yields nothing, so the
  // "the child already watched this" half of the protection guarded NOBODY and an
  // automatic window would have eaten the favourite it exists to save.
  const records = [{ key: 'yt:a' }, { key: 'yt:b', keepForever: true }];
  const asMap = new Map([['yt:c', { posSec: 42 }], ['yt:d', { unwrappedAt: 5 }], ['yt:e', {}], ['yt:f', { posSec: 0 }]]);
  const fromMap = protectedWindowKeys({ records, states: asMap });
  assert.deepEqual([...fromMap].sort(), ['yt:b', 'yt:c'],
    'a saved position must protect; an empty state must not');
  // ⚠️ unwrappedAt must NOT protect: planGifts' baseline stamps it on every live record
  // that did not become a gift, so trusting it made the window a measured no-op — a
  // 60-video channel 40 over its window proposed ZERO.
  assert.ok(!fromMap.has('yt:d'), 'unwrappedAt is not a watch signal — the gift baseline writes it library-wide');
  assert.ok(!fromMap.has('yt:f'), 'a zero position is not a watch');
  // the plain-object shape keeps working (and is what a future caller might pass)
  const fromObj = protectedWindowKeys({ records, states: { 'yt:c': { posSec: 9 } } });
  assert.deepEqual([...fromObj].sort(), ['yt:b', 'yt:c']);
  // garbage in, empty out — never a throw inside the parent screen's render
  for (const bad of [null, undefined, 0, 'x', []]) {
    assert.deepEqual([...protectedWindowKeys({ records: [], states: bad })], [], JSON.stringify(bad));
  }
  assert.deepEqual([...protectedWindowKeys({})], []);
});

test('pruneConfirmText: names the hidden rows, the emptying, and does not PROMISE a way back (v1.0.39)', () => {
  // pruneReviewList's contract: "a parent must never be asked to confirm a deletion whose
  // size they were not told". The review renders at most PRUNE_REVIEW_CAP rows, so a parent
  // could tick every row they were SHOWN, read "סומנו להשארה: 200", and still delete 3800.
  const big = pruneConfirmText({ name: 'ערוץ', count: 3800, hidden: 3600, kept: 200 });
  assert.match(big.title, /3800/);
  assert.match(big.text, /3600/, 'the rows the parent could not even see are unnamed');
  assert.match(big.text, /200 סרטונים שסימנתם/);
  // wiping a channel removes its tile from the child's home, and the tombstones mean the
  // CURRENT RSS window does not come back either — only a genuinely new upload
  assert.match(pruneConfirmText({ name: 'ערוץ', count: 10, emptied: true }).text, /תתרוקן/);
  assert.ok(!/תתרוקן/.test(pruneConfirmText({ name: 'ערוץ', count: 10 }).text),
    'a partial prune must not claim the folder disappears');
  // THE WAY BACK IS CONDITIONAL, not a promise: re-adding means remove-then-add (whose
  // orphan sweep takes the channel's remaining records), the backfill re-arms only when no
  // other library subscribes, and a keyless install only ever sees the RSS window.
  const plain = pruneConfirmText({ name: 'ערוץ', count: 5 }).text;
  assert.match(plain, /אינה מובטחת/, 'the way back is stated as a certainty again');
  assert.ok(!/צריך להוסיף את הערוץ מחדש/.test(plain), 'the old unconditional promise is back');
  // garbage never leaks a NaN onto the parent's screen
  for (const bad of [undefined, null, {}, { count: NaN, hidden: -3, kept: 'x' }]) {
    const r = pruneConfirmText(bad || undefined);
    assert.ok(!/NaN|undefined/.test(r.title + r.text), JSON.stringify(bad));
  }
});

/* ---------------- favourites (v1.0.40) ---------------- */
// The child marks a video with ⭐; it appears in its own folder at the top of the home AND
// stays where it lives, and it is NEVER deleted automatically. The user's decisions
// (2026-08-11): no cap, the star sits next to 🏠, new favourites APPEND, nothing in the
// parent screen.

test('favActive: an LWW-element set, because UN-favouriting has to travel too (v1.0.40)', () => {
  // With a single `favAt`, removing a star on the tablet would be undone by the phone's
  // stale copy on the next pull — the child takes a video out of ⭐ and watches it walk
  // back in. So a removal is its own event and the LATER one wins (the deny-list rule).
  assert.equal(favActive({ favAt: 100 }), true);
  assert.equal(favActive({ favAt: 100, favOffAt: 200 }), false, 'a later removal must win');
  assert.equal(favActive({ favAt: 300, favOffAt: 200 }), true, 'a later re-star must win');
  // a TIE is NOT a favourite: a star the child taps again is a shrug, a video that refuses
  // to leave ⭐ is the app disobeying them
  assert.equal(favActive({ favAt: 100, favOffAt: 100 }), false);
  for (const junk of [null, undefined, {}, { favOffAt: 5 }, { favAt: 0 }, { favAt: 'x' }]) {
    assert.equal(favActive(junk), false, JSON.stringify(junk));
  }
});

test('mergeFavState is commutative and idempotent — two devices, no server (v1.0.40)', () => {
  const a = { favAt: 100, favOffAt: 0 };
  const b = { favAt: 0, favOffAt: 250 };
  assert.deepEqual(mergeFavState(a, b), mergeFavState(b, a));
  assert.equal(favActive(mergeFavState(a, b)), false, 'the later removal survives the merge');
  const m = mergeFavState(a, b);
  assert.deepEqual(mergeFavState(m, m), m, 'idempotent');
  // a re-star after that removal wins on either side
  assert.equal(favActive(mergeFavState(m, { favAt: 900 })), true);
  assert.deepEqual(mergeFavState(null, undefined), {}, 'nothing in, nothing out');
});

test('favouriteKeys: STABLE order — a new star is APPENDED (v1.0.40)', () => {
  // A 5-year-old navigates by POSITION, not by title. Newest-first would move every video
  // they already know, every time they add one (the user's decision).
  const states = new Map([
    ['yt:c', { favAt: 300 }],
    ['yt:a', { favAt: 100 }],
    ['yt:gone', { favAt: 200, favOffAt: 400 }], // un-starred
    ['yt:b', { favAt: 200 }],
    ['yt:none', { posSec: 12 }]
  ]);
  assert.deepEqual(favouriteKeys(states), ['yt:a', 'yt:b', 'yt:c']);
  // the plain-object shape works too, and garbage never throws inside a render
  assert.deepEqual(favouriteKeys({ 'yt:x': { favAt: 5 } }), ['yt:x']);
  for (const bad of [null, undefined, 0, 'x', []]) assert.deepEqual(favouriteKeys(bad), [], JSON.stringify(bad));
});

test('a favourite is protected from the rolling window, including a SIBLING\'s (v1.0.40)', () => {
  // This is the feature's central promise: "מועדפים לא יימחקו אוטומטית לעולם".
  const records = [{ key: 'yt:a' }, { key: 'yt:b' }, { key: 'yt:c' }];
  const mine = new Map([['yt:a', { favAt: 5 }]]);
  const sibling = new Map([['yt:b', { favAt: 7 }]]);
  const guarded = protectedWindowKeys({ records, states: mine, statesByProfile: [sibling] });
  assert.ok(guarded.has('yt:a'), 'the child\'s own star is unprotected');
  assert.ok(guarded.has('yt:b'), 'a SIBLING\'s star is unprotected — a shared library would eat it');
  assert.ok(!guarded.has('yt:c'));
  // an UN-starred video is not protected by its dead favAt
  const off = protectedWindowKeys({ records, states: new Map([['yt:c', { favAt: 5, favOffAt: 9 }]]) });
  assert.ok(!off.has('yt:c'), 'a removed star still protects — the window can never prune again');
  // and the window itself must then leave them alone
  const live = [
    { key: 'yt:a', state: 'live', folderId: 'ch:' + CH, sortKey: 1 },
    { key: 'yt:b', state: 'live', folderId: 'ch:' + CH, sortKey: 2 },
    { key: 'yt:c', state: 'live', folderId: 'ch:' + CH, sortKey: 3 }
  ];
  // a window of 1 over 3 videos: without the stars it would propose TWO deletions…
  const bare = planChannelWindow({ records: live, keep: 1 });
  assert.equal(bare.total, 2, 'the contrast case must actually propose something');
  // …and with them, nothing is proposed at all (no proposal ⇒ no entry for the channel)
  const tight = planChannelWindow({ records: live, keep: 1, protectedKeys: guarded });
  assert.equal(tight.total, 0, 'a favourite was proposed for deletion');
  assert.deepEqual(tight.byChannel, {});
});

/* ---------------- typed parent code (v1.0.55) ---------------- */

test('pinKeyAction: digits and delete map; every other key keeps its existing owner', () => {
  // TV remotes and hardware keyboards send e.key '0'..'9' for BOTH the digit row and the
  // numpad — that is why the mapping reads e.key and not e.code ('Digit7' vs 'Numpad7').
  for (let d = 0; d <= 9; d++) assert.equal(pinKeyAction(String(d)), String(d));
  assert.equal(pinKeyAction('Backspace'), 'del');
  assert.equal(pinKeyAction('Delete'), 'del');
  // Enter activates whatever the D-pad focused (a digit key on the on-screen pad — typing
  // must not double it), Escape is the hardware-back stand-in, letters are not code.
  for (const k of ['Enter', 'Escape', 'ArrowLeft', ' ', 'a', 'ד', '10', '']) {
    assert.equal(pinKeyAction(k), null, `'${k}' must be refused`);
  }
  // a non-string (broken caller, synthetic event) must neither crash nor type
  assert.equal(pinKeyAction(5), null);
  assert.equal(pinKeyAction(null), null);
  assert.equal(pinKeyAction(undefined), null);
});

/* ---------------- full-tablet lock during the break (v1.0.55) ---------------- */

test('lockScreenContainment: all four combinations, junk fails toward today\'s behaviour', () => {
  // unpinOnClear answers "MAY a pin the break is HOLDING be released when the lock
  // clears?" — the kiosk veto. Whether one is held is runtime state (app.js breakPinHeld),
  // deliberately not the lockTablet setting: it can flip mid-break (settings sync), and
  // the release must follow what was actually pinned (v1.0.55 review finding).
  // neither lock: today's screen — free exit, no pin; a held pin (impossible here, the
  // flag can only be set by pinTask) would be releasable
  assert.deepEqual(lockScreenContainment({}),
    { hideExit: false, gateExit: false, pinTask: false, unpinOnClear: true });
  // kiosk only (v1.0.31, unchanged): the door is hidden entirely; the kiosk owns the pin,
  // so the break must neither pin nor — the v1.0.36 rule — ever release one
  assert.deepEqual(lockScreenContainment({ kiosk: true }),
    { hideExit: true, gateExit: false, pinTask: false, unpinOnClear: false });
  // full-tablet lock only: door visible but code-gated, pinned while shown, releasable
  // when the break ends
  assert.deepEqual(lockScreenContainment({ lockTablet: true }),
    { hideExit: false, gateExit: true, pinTask: true, unpinOnClear: true });
  // both: the kiosk wins the door (hidden) AND vetoes the release — a kiosk session must
  // stay pinned after the break, or the break's end unpins the whole kiosk
  assert.deepEqual(lockScreenContainment({ kiosk: true, lockTablet: true }),
    { hideExit: true, gateExit: true, pinTask: true, unpinOnClear: false });
  // junk reads as OFF (the exitLockOn `=== true` precedent): a corrupted value must fall
  // back to today's behaviour, never lock a tablet the parent never locked
  assert.deepEqual(lockScreenContainment({ kiosk: 'true', lockTablet: 1 }),
    { hideExit: false, gateExit: false, pinTask: false, unpinOnClear: true });
  assert.deepEqual(lockScreenContainment(), lockScreenContainment({}));
});

test('evalScheduledLock: switching the feature OFF beats a leftover lockedUntil', async () => {
  const { evalScheduledLock } = await import('../www/js/plan.js');
  // The live case (v1.0.55 review): a parent zeroes lockAfterMin on ANOTHER device while
  // a break is running here — the phase must read 'off' even though `until` is still
  // stamped, and the tick's teardown must then run clearScheduledLock (invariant-pinned)
  // to drop the stale stamp and release the break's pin. Without the stamp-drop, merely
  // re-enabling the feature later would re-lock the child on the spot.
  assert.equal(evalScheduledLock({ afterMin: 0, lockedUntil: Date.now() + 9e6 }).phase, 'off');
  assert.equal(evalScheduledLock({ afterMin: -5, lockedUntil: Date.now() + 9e6 }).phase, 'off');
});

/* ---------------- swipe paging (v1.0.57) ---------------- */

test('swipePageAction: RTL direction — a flick RIGHT turns to the NEXT page', async () => {
  const { swipePageAction } = await import('../www/js/plan.js');
  // The pager puts `prev` first in the DOM and dir="rtl" mirrors the row, so the ◀ "next"
  // button sits on the LEFT: the next page lives there, and the finger drags the current
  // page rightwards to bring it in (a Hebrew book; Android's own RTL ViewPager).
  // Getting this backwards is invisible to every other test — the app would page fine and
  // feel wrong — so it is pinned by direction, not by "a swipe does something".
  const mid = { dt: 200, page: 1, total: 4 };
  assert.equal(swipePageAction({ dx: 90, dy: 0, ...mid }), 'next');
  assert.equal(swipePageAction({ dx: -90, dy: 0, ...mid }), 'prev');
});

test('swipePageAction: a TAP can never be a page turn', async () => {
  const { swipePageAction } = await import('../www/js/plan.js');
  const { TAP_SLOP_PX, SWIPE_MIN_PX } = await import('../www/js/config.js');
  // Every tile is a <button> and both gestures share the surface. The whole tap band must
  // be refused, with room to spare — a child's finger wobbles.
  assert.ok(SWIPE_MIN_PX > TAP_SLOP_PX * 2, 'the swipe threshold no longer clears the tap slop');
  for (const dx of [0, 5, TAP_SLOP_PX, SWIPE_MIN_PX - 1]) {
    assert.equal(swipePageAction({ dx, dy: 0, dt: 120, page: 1, total: 4 }), null, `dx=${dx} turned a page`);
    assert.equal(swipePageAction({ dx: -dx, dy: 0, dt: 120, page: 1, total: 4 }), null, `dx=-${dx} turned a page`);
  }
  assert.equal(swipePageAction({ dx: SWIPE_MIN_PX, dy: 0, dt: 120, page: 1, total: 4 }), 'next');
});

test('swipePageAction: a vertical SCROLL that drifts sideways is still a scroll', async () => {
  const { swipePageAction } = await import('../www/js/plan.js');
  // The child scrolls the grid with the same finger on the same surface. A scroll must
  // never turn a page — the v1.0.52 collision, from the other side.
  assert.equal(swipePageAction({ dx: 70, dy: 300, dt: 300, page: 1, total: 4 }), null);
  assert.equal(swipePageAction({ dx: 70, dy: 70, dt: 300, page: 1, total: 4 }), null, 'a 45° drag is ambiguous, not a page turn');
  // clearly horizontal, with the vertical wobble a real finger has
  assert.equal(swipePageAction({ dx: 200, dy: 40, dt: 300, page: 1, total: 4 }), 'next');
});

test('swipePageAction: a parked finger is refused, but an unknown clock never costs a swipe', async () => {
  const { swipePageAction } = await import('../www/js/plan.js');
  const { SWIPE_MAX_MS } = await import('../www/js/config.js');
  assert.equal(swipePageAction({ dx: 200, dy: 0, dt: SWIPE_MAX_MS + 1, page: 1, total: 4 }), null);
  assert.equal(swipePageAction({ dx: 200, dy: 0, dt: SWIPE_MAX_MS, page: 1, total: 4 }), 'next');
  // MEASURED, not assumed (2026-08-30): the ceiling started at 900ms as a "flick" test and
  // refused real swipes in the browser. A small child drags slowly and means it, and the
  // app flips on RELEASE — distance is the whole intent test, so the ceiling must stay
  // loose enough to pass an unhurried deliberate drag.
  assert.equal(swipePageAction({ dx: 200, dy: 0, dt: 1200, page: 1, total: 4 }), 'next',
    'an unhurried but deliberate drag is a page turn');
  assert.ok(SWIPE_MAX_MS >= 2000, 'the ceiling tightened back into the range of a real slow swipe');
  // FAIL OPEN on a missing duration — the isTapGesture rule: an odd WebView reporting no
  // clock must not cost the child every swipe, and a stray page turn is one flick to undo.
  assert.equal(swipePageAction({ dx: 200, dy: 0, page: 1, total: 4 }), 'next');
  assert.equal(swipePageAction({ dx: 200, dy: 0, dt: NaN, page: 1, total: 4 }), 'next');
});

test('swipePageAction: the first and last pages absorb the gesture silently', async () => {
  const { swipePageAction } = await import('../www/js/plan.js');
  // The arrows are `disabled` at the ends; a swipe that "flipped" to the same page would
  // read as a broken screen. Bounds live in the helper so no caller can forget them.
  assert.equal(swipePageAction({ dx: -200, dy: 0, dt: 200, page: 0, total: 4 }), null, 'paged before the first page');
  assert.equal(swipePageAction({ dx: 200, dy: 0, dt: 200, page: 3, total: 4 }), null, 'paged past the last page');
  assert.equal(swipePageAction({ dx: 200, dy: 0, dt: 200, page: 0, total: 1 }), null, 'a single page cannot turn');
  assert.equal(swipePageAction({ dx: 200, dy: 0, dt: 200, page: 0, total: 4 }), 'next');
  assert.equal(swipePageAction({ dx: -200, dy: 0, dt: 200, page: 3, total: 4 }), 'prev');
});

test('swipePageAction: junk geometry is refused, and the call is total', async () => {
  const { swipePageAction } = await import('../www/js/plan.js');
  for (const bad of [
    {}, undefined, { dx: NaN, dy: 0, page: 1, total: 4 }, { dx: 200, dy: NaN, page: 1, total: 4 },
    { dx: 200, dy: 0, page: NaN, total: 4 }, { dx: 200, dy: 0, page: 1, total: null },
    { dx: Infinity, dy: 0, page: 1, total: 4 }
  ]) {
    assert.equal(swipePageAction(bad), null, `junk turned a page: ${JSON.stringify(bad)}`);
  }
});

/* ---------------- 🕒 נצפה לאחרונה (v1.0.57) ---------------- */

test('recentLimitFor: never-written is the DEFAULT, and only an explicit 0 is off', async () => {
  const { recentLimitFor } = await import('../www/js/plan.js');
  const { RECENT_DEFAULT_LIMIT, RECENT_MAX_LIMIT } = await import('../www/js/config.js');
  // THE TRAP THIS TEST EXISTS FOR (third feature to hit it — screenOffMinutes,
  // normalizeLockMinutes): Number(null) === 0, so coercing before the unset check turns
  // "the parent never opened this screen" into an explicit "off" and eats the default.
  assert.equal(recentLimitFor(null), RECENT_DEFAULT_LIMIT);
  assert.equal(recentLimitFor(undefined), RECENT_DEFAULT_LIMIT);
  assert.equal(recentLimitFor(''), RECENT_DEFAULT_LIMIT);
  assert.equal(recentLimitFor(0), 0, 'an explicit 0 must stay off');
  assert.equal(recentLimitFor('0'), 0);
  assert.equal(recentLimitFor(25), 25);
  assert.equal(recentLimitFor('7'), 7);
  assert.equal(recentLimitFor(3.7), 3, 'a fraction floors, never rounds up past the parent\'s number');
  assert.equal(recentLimitFor(9999), RECENT_MAX_LIMIT, 'clamped — past this it stops being a shortcut');
  // nonsense falls back to the DEFAULT, never to 0: the opposite direction to
  // keepNewestPerChannel, because there a typo must not propose DELETIONS while here the
  // worst case is a folder the parent did not ask for — and reading a typo as "off" would
  // quietly remove a folder the child navigates by.
  assert.equal(recentLimitFor('abc'), RECENT_DEFAULT_LIMIT);
  assert.equal(recentLimitFor(NaN), RECENT_DEFAULT_LIMIT);
  assert.equal(recentLimitFor(-4), RECENT_DEFAULT_LIMIT);
  // Infinity is NONSENSE, not "a very large number": it cannot be typed into the field, so
  // it can only arrive from a corrupted or hostile value, and nonsense takes the default
  // like every other unusable input. Clamping it to the max instead would silently honour
  // garbage as if the parent had asked for the biggest folder the app allows.
  assert.equal(recentLimitFor(Infinity), RECENT_DEFAULT_LIMIT);
  assert.equal(recentLimitFor(RECENT_MAX_LIMIT + 1), RECENT_MAX_LIMIT, 'a real number over the max clamps');
});

test('recentKeys: newest watch FIRST, capped at the limit', async () => {
  const { recentKeys } = await import('../www/js/plan.js');
  const states = new Map([
    ['a', { playedAt: 300 }],
    ['b', { playedAt: 100 }],
    ['c', { playedAt: 500 }],
    ['d', { favAt: 900 }],            // starred but never watched — not in 🕒
    ['e', { playedAt: 0 }],           // an explicit zero is not a watch
    ['f', { playedAt: 'nonsense' }]
  ]);
  assert.deepEqual(recentKeys(states, 10), ['c', 'a', 'b']);
  // the cap keeps the NEWEST, which is the whole promise of the folder
  assert.deepEqual(recentKeys(states, 2), ['c', 'a']);
  assert.deepEqual(recentKeys(states, 0), [], 'off means empty, never "all of them"');
  assert.deepEqual(recentKeys(states, -1), []);
  assert.deepEqual(recentKeys(states, 'x'), []);
  // it must read a MAP as readily as an object — giftStates is a Map, and reading it with
  // Object.entries is precisely how v1.0.39 shipped a silent no-op (CLAUDE.md's own lesson)
  assert.deepEqual(recentKeys({ a: { playedAt: 1 }, b: { playedAt: 2 } }, 5), ['b', 'a']);
  assert.deepEqual(recentKeys(null, 5), []);
  assert.deepEqual(recentKeys(undefined, 5), []);
});

test('recentKeys order is the OPPOSITE of favouriteKeys, deliberately', async () => {
  const { recentKeys, favouriteKeys } = await import('../www/js/plan.js');
  // ⭐ is a shelf the child builds and navigates BY POSITION, so a new star appends
  // (v1.0.40). 🕒's entire promise is "what I was just watching is at the front". Two
  // folders, two orders, and each one's rationale forbids the other's.
  const states = new Map([['old', { favAt: 1, playedAt: 1 }], ['new', { favAt: 2, playedAt: 2 }]]);
  assert.deepEqual(favouriteKeys(states), ['old', 'new']);
  assert.deepEqual(recentKeys(states, 5), ['new', 'old']);
});

test('protectedWindowKeys: 🕒 members are protected from the rolling window (v1.0.57)', async () => {
  const { protectedWindowKeys } = await import('../www/js/plan.js');
  // The user's decision 2026-08-30, and it repairs the documented weakness of v1.0.39:
  // `posSec` is CLEARED by a video watched to the END, so the most-rewatched video — the
  // one the whole rationale is about — carried no signal at all. A watch stamp does.
  const guarded = protectedWindowKeys({
    records: [{ key: 'kept', keepForever: true }],
    states: new Map([['starred', { favAt: 5 }], ['half', { posSec: 40 }], ['seen', { playedAt: 7 }]]),
    recent: ['seen', 'sibling-seen']
  });
  assert.ok(guarded.has('kept') && guarded.has('starred') && guarded.has('half'));
  assert.ok(guarded.has('seen'), 'the child\'s own recent video is prunable');
  assert.ok(guarded.has('sibling-seen'), 'a sibling\'s recent video is prunable on a shared library');
  // the keys arrive COMPUTED: unioning "every video ever watched" would gut the window
  const noRecent = protectedWindowKeys({ records: [], states: new Map([['seen', { playedAt: 7 }]]) });
  assert.ok(!noRecent.has('seen'), 'a watch stamp alone must not protect — only 🕒 membership does');
  assert.deepEqual([...protectedWindowKeys({ recent: [null, ''] })], []);
});

test('stateRowIsSpent: the row survives while ANY feature still has something on it', async () => {
  const { stateRowIsSpent } = await import('../www/js/normalize.js');
  // ⚠️ THE BUG THIS EXISTS FOR: db.clearPlayPosition (every video watched to the END with
  // resume on) deleted the row whenever it carried no giftRank and no unwrappedAt — a check
  // written in v1.0.32, before ⭐ existed. A starred, never-gifted video watched to the end
  // lost its star silently, and wrote no favOffAt either, so a peer could re-star it.
  assert.equal(stateRowIsSpent({ favAt: 5 }), false, 'a ⭐ would be deleted with the row');
  assert.equal(stateRowIsSpent({ favOffAt: 5 }), false, 'an un-star is an EVENT that must travel');
  assert.equal(stateRowIsSpent({ playedAt: 5 }), false, 'the 🕒 stamp would be deleted with the row');
  assert.equal(stateRowIsSpent({ giftRank: 0 }), false, 'rank 0 is a real rank');
  assert.equal(stateRowIsSpent({ unwrappedAt: 5 }), false);
  assert.equal(stateRowIsSpent({ posSec: 0 }), false, 'a stored 0 position is still stored');
  assert.equal(stateRowIsSpent({ profileId: 'p', key: 'k' }), true);
  assert.equal(stateRowIsSpent({}), true);
  assert.equal(stateRowIsSpent(null), true);
});

/* ---------------- nested Drive folders (v1.0.58) ---------------- */

test('uniqueFolderTitle: two discs with the same name get readable, STABLE titles', async () => {
  const { uniqueFolderTitle } = await import('../www/js/plan.js');
  assert.equal(uniqueFolderTitle('דיסק 21', []), 'דיסק 21');
  assert.equal(uniqueFolderTitle('דיסק 21', ['דיסק 21']), 'דיסק 21 (2)');
  assert.equal(uniqueFolderTitle('דיסק 21', ['דיסק 21', 'דיסק 21 (2)']), 'דיסק 21 (3)');
  // DETERMINISTIC: the same inputs give the same answer, so a re-import lands on the title
  // that is already there instead of drifting a suffix upward on every refresh
  assert.equal(uniqueFolderTitle('דיסק 21', ['דיסק 21']), uniqueFolderTitle('דיסק 21', ['דיסק 21']));
  assert.equal(uniqueFolderTitle('', []), 'תיקיה', 'a nameless folder still gets a usable tile');
});

test('planDriveTreeImport: a folder per subfolder, and the ROOT anchors the refresh (v1.0.58)', async () => {
  const { planDriveTreeImport } = await import('../www/js/plan.js');
  const audio = (id, name) => ({ id, name, mimeType: 'audio/mpeg' });
  const folders = [
    { id: 'ROOT', name: 'הרב מאיר אליהו', depth: 0, files: [{ id: 'ds', name: '.DS_Store', mimeType: 'application/octet-stream' }] },
    { id: 'S1', name: 'דיסק 21', depth: 1, files: [audio('a', 'א.mp3'), audio('b', 'ב.mp3')] },
    { id: 'S2', name: 'דיסק 21', depth: 1, files: [audio('c', 'ג.mp3')] },   // same NAME, other folder
    { id: 'S3', name: 'רק תיקיות', depth: 1, files: [] }
  ];
  const r = planDriveTreeImport({
    folders, existingFolders: [], existingKeys: new Set(), denyKeys: new Set(), rootId: 'ROOT',
    mediaKindOf: (f) => (f.mimeType === 'audio/mpeg' ? 'audio' : null)
  });
  assert.deepEqual(r.folders.map((f) => f.driveFolderId), ['ROOT', 'S1', 'S2'],
    'a folder that holds only subfolders must not become a tile of its own');
  assert.deepEqual(r.folders.map((f) => f.title), ['הרב מאיר אליהו', 'דיסק 21', 'דיסק 21 (2)']);
  // THE ROOT GETS A ROW EVEN WITH NO MEDIA: it holds nothing, so the child never sees it
  // (a custom folder with 0 videos is hidden — the v1.0.21 rule), but it is what the
  // refresh walks. Without it a disc added to the Drive folder later would never arrive.
  assert.equal(r.folders[0].isRoot, true);
  assert.equal(r.folders[0].add.length, 0);
  assert.equal(r.added, 3);
  assert.equal(r.skipped.nonMedia, 1, 'the .DS_Store is counted, not silently dropped');
});

test('planDriveTreeImport: a re-import REUSES the rows it already made (v1.0.58)', async () => {
  const { planDriveTreeImport } = await import('../www/js/plan.js');
  const audio = (id, name) => ({ id, name, mimeType: 'audio/mpeg' });
  const folders = [
    { id: 'ROOT', name: 'שורש', depth: 0, files: [] },
    { id: 'S1', name: 'דיסק 21', depth: 1, files: [audio('a', 'א.mp3'), audio('b', 'ב.mp3')] }
  ];
  const existingFolders = [
    { folderId: 'cf:1', title: 'שורש', driveFolderId: 'ROOT' },
    { folderId: 'cf:2', title: 'דיסק 21 — שם שההורה שינה', driveFolderId: 'S1' }
  ];
  const r = planDriveTreeImport({
    folders, existingFolders, existingKeys: new Set(['file:drive:a']), denyKeys: new Set(),
    rootId: 'ROOT', mediaKindOf: () => 'audio'
  });
  // identity is the driveFolderId, never the title — so a folder the PARENT renamed keeps
  // its name across every refresh instead of being duplicated under the Drive name
  assert.deepEqual(r.folders.map((f) => f.existing && f.existing.folderId), ['cf:1', 'cf:2']);
  assert.deepEqual(r.folders.map((f) => f.title), ['שורש', 'דיסק 21 — שם שההורה שינה']);
  assert.equal(r.added, 1, 'only the file that was not already here');
  assert.equal(r.skipped.existing, 1);
  // and the denied half of the shared per-file decision still applies inside a tree
  const denied = planDriveTreeImport({
    folders, existingFolders, existingKeys: new Set(), denyKeys: new Set(['file:drive:b']),
    rootId: 'ROOT', mediaKindOf: () => 'audio'
  });
  assert.equal(denied.added, 1);
  assert.equal(denied.skipped.denied, 1);
  // v1.0.61 — WHICH keys were refused, not just how many. A count can only be reported;
  // the KEYS are what an "add it again?" answer has to revoke, and the caller cannot
  // recompute them (the walk that produced them is a network operation).
  assert.deepEqual(denied.deniedKeys, ['file:drive:b']);
});

test('deniedReAddPrompt: the words follow the door the parent came through (v1.0.61)', async () => {
  const { deniedReAddPrompt } = await import('../www/js/plan.js');
  // nothing to ask about
  assert.equal(deniedReAddPrompt({ denied: false }).ask, false);
  assert.equal(deniedReAddPrompt({ denied: true, exists: true }).ask, false);
  assert.equal(deniedReAddPrompt({ denied: true, count: 0 }).ask, false);
  // an explicit null must not throw — the destructure is from (opts || {}) for exactly this
  assert.equal(deniedReAddPrompt(null).ask, false);
  // one key: the singular sentence names no container at all
  const one = deniedReAddPrompt({ denied: true, count: 1 });
  assert.equal(one.ask, true);
  assert.match(one.text, /בכל המכשירים/, 'un-denying is not a local act and the parent must be told');
  // many: the noun follows the source. The plural copy was written for the links FILE, and a
  // Drive folder import reused it verbatim — telling a parent importing a FOLDER about links
  // in a file they never opened (found in the browser, not by reading).
  const file = deniedReAddPrompt({ denied: true, count: 3 });
  const folder = deniedReAddPrompt({ denied: true, count: 3, source: 'drive-folder' });
  assert.match(file.title, /בקובץ/);
  assert.match(file.text, /מהלינקים בקובץ/);
  assert.match(folder.title, /בתיקיה/);
  assert.match(folder.text, /מהקבצים בתיקיה/);
  assert.ok(!folder.title.includes('בקובץ') && !folder.text.includes('בקובץ'),
    'a Drive folder import still talks about a file');
  for (const p of [file, folder]) {
    assert.match(p.title, /^3 /, 'the count in the sentence must be the honest one');
    assert.match(p.text, /בכל המכשירים/);
    assert.match(p.text, /השאר נוספו כרגיל/, 'the parent must know the rest of the batch arrived');
  }
});

test('planDriveFolderImport: the refused keys travel with the count (v1.0.61)', async () => {
  const { planDriveFolderImport } = await import('../www/js/plan.js');
  const files = [
    { id: 'a', name: 'שיר א.mp3' },
    { id: 'b', name: 'שיר ב.mp3' },
    { id: 'c', name: 'שיר ג.mp3' }
  ];
  const r = planDriveFolderImport({
    files, existingKeys: new Set(), denyKeys: new Set(['file:drive:b', 'file:drive:c']),
    mediaKindOf: () => 'audio'
  });
  assert.equal(r.add.length, 1);
  assert.equal(r.skipped.denied, 2);
  assert.deepEqual(r.deniedKeys, ['file:drive:b', 'file:drive:c'],
    'the count and the key list must agree — an "add them again" answer un-denies exactly these');
  // nothing refused ⇒ an EMPTY list, never undefined: the caller tests `.length`
  const clean = planDriveFolderImport({ files, existingKeys: new Set(), denyKeys: new Set(), mediaKindOf: () => 'audio' });
  assert.deepEqual(clean.deniedKeys, []);
});

test('driveFolderOutcome: a nested import names its shape, and a cut-short walk SAYS so', async () => {
  const { driveFolderOutcome } = await import('../www/js/plan.js');
  const msgs = new Set();
  const add = (m) => { assert.ok(!msgs.has(m), 'two different outcomes share one sentence: ' + m); msgs.add(m); return m; };
  add(driveFolderOutcome({ added: 751, folders: 32, first: true }));
  add(driveFolderOutcome({ added: 28, folders: 1, first: true }));
  add(driveFolderOutcome({ added: 12, folders: 4, first: false }));
  add(driveFolderOutcome({ added: 500, folders: 20, first: true, truncated: true }));
  add(driveFolderOutcome({ added: 0, partial: true }));
  add(driveFolderOutcome({ added: 0, skipped: { nonMedia: 3 } }));
  add(driveFolderOutcome({ added: 0, skipped: {} }));
  add(driveFolderOutcome({ ok: false }));
  // the shape is NAMED when there is more than one folder, and the counts are real
  assert.match(driveFolderOutcome({ added: 751, folders: 32, first: true }), /751/);
  assert.match(driveFolderOutcome({ added: 751, folders: 32, first: true }), /32 תיקיות/);
  // a cut-short walk must never read as a complete one
  assert.match(driveFolderOutcome({ added: 500, folders: 20, truncated: true }), /גדולה מאוד/);
  assert.match(driveFolderOutcome({ added: 5, folders: 2, partial: true }), /לא נקראו/);
  // nothing leaks undefined/NaN into a sentence a parent reads
  for (const m of msgs) assert.doesNotMatch(m, /undefined|NaN|null/);
});

/* ---------------- downloaded-file cache + empty folders (v1.0.58) ---------------- */

test('planCacheSweep: what is used survives, what was forgotten goes, junk always goes', async () => {
  const { planCacheSweep } = await import('../www/js/plan.js');
  const { CACHE_MAX_AGE_MS } = await import('../www/js/config.js');
  const now = 1_800_000_000_000;
  const files = [
    { name: 'fresh.mp3', size: 5_000_000 },
    { name: 'stale.mp3', size: 3_000_000 },
    { name: 'edge.mp3', size: 1_000_000 },
    { name: 'orphan.mp4', size: 7_000_000 },
    { name: 'nostamp.mp3', size: 2_000_000 }
  ];
  const owned = new Map([
    ['fresh.mp3', { usedAt: now - 1000 }],
    ['stale.mp3', { usedAt: now - CACHE_MAX_AGE_MS - 1 }],
    ['edge.mp3', { usedAt: now - CACHE_MAX_AGE_MS }],       // exactly at the window: kept
    ['nostamp.mp3', { usedAt: 0 }]                           // downloaded before v1.0.58
  ]);
  const r = planCacheSweep({ files, owned, now });
  assert.deepEqual(r.delete.sort(), ['orphan.mp4', 'stale.mp3']);
  assert.equal(r.orphans, 1, 'a file no record owns is junk — that is the only thing that frees what old versions leaked');
  assert.equal(r.expired, 1);
  assert.equal(r.bytes, 10_000_000, 'the freed space must be measured from what is on DISK');
  // ⚠️ A FILE WITH NO USE STAMP IS GIVEN A FULL WINDOW, NEVER DELETED ON SIGHT. Reading
  // "no stamp" as "never used" would wipe the whole cache the first time this ran — the
  // blanket behaviour the user's decision explicitly rejected.
  assert.deepEqual(r.stampMissing, ['nostamp.mp3']);
  assert.ok(!r.delete.includes('nostamp.mp3'));
  // and it is total
  assert.deepEqual(planCacheSweep({}).delete, []);
  assert.deepEqual(planCacheSweep({ files: [{ size: 1 }], owned: new Map() }).delete, [], 'a nameless entry is not deletable');
});

test('formatBytes never shows a parent something meaningless', async () => {
  const { formatBytes } = await import('../www/js/plan.js');
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(-5), '0 MB');
  assert.equal(formatBytes(NaN), '0 MB');
  assert.equal(formatBytes(null), '0 MB');
  assert.equal(formatBytes(900), '1 KB');
  assert.equal(formatBytes(5_500_000), '5.2 MB');
  assert.equal(formatBytes(2_500_000_000), '2.3 GB');
});

test('deleteLocalChoice: asked ONCE, and only when a copy is really on the device', async () => {
  const { deleteLocalChoice } = await import('../www/js/plan.js');
  // A video is downloaded only when STREAMING it failed, so most deletions have nothing to
  // ask about and must raise NO dialog — and a 40-video rejection must raise one, not forty.
  assert.equal(deleteLocalChoice({ total: 1, local: 0 }).ask, false);
  assert.equal(deleteLocalChoice({}).ask, false);
  const one = deleteLocalChoice({ total: 1, local: 1, bytes: 5_500_000 });
  assert.equal(one.ask, true);
  assert.match(one.text, /קובץ אחד/);
  assert.match(one.text, /5\.2 MB/);
  assert.match(one.text, /דרייב/, 'the parent must be told Google Drive is not touched');
  const many = deleteLocalChoice({ total: 40, local: 3, bytes: 0 });
  assert.match(many.text, /3 קבצים/);
  assert.match(many.text, /מתוך 40/, 'a partial batch must say how many of the deletion it covers');
  assert.doesNotMatch(many.text, /\(\)/, 'an unknown size must not leave empty brackets');
  for (const m of [one.text, many.text]) assert.doesNotMatch(m, /undefined|NaN|null/);
});

test('planEmptyFolderSweep: empty folders go, but not the refresh anchor or a fresh one', async () => {
  const { planEmptyFolderSweep } = await import('../www/js/plan.js');
  const { EMPTY_FOLDER_GRACE_MS } = await import('../www/js/config.js');
  const now = 1_800_000_000_000;
  const old = now - EMPTY_FOLDER_GRACE_MS - 1;
  const folders = [
    { folderId: 'cf:plain', createdAt: old },
    { folderId: 'cf:full', createdAt: old },
    { folderId: 'cf:driveRoot', driveFolderId: 'D', createdAt: old },
    { folderId: 'cf:driveDisc', driveFolderId: 'D2', driveRootId: 'D', createdAt: old },
    { folderId: 'cf:justMade', createdAt: now - 1000 },
    // v1.0.61 — a folder whose CHILDREN hold the songs: the row a parent taps to reach 32
    // discs holds nothing of its own
    { folderId: 'cf:container', createdAt: old },
    { folderId: 'cf:disc9', parentFolderId: 'cf:container', createdAt: old }
  ];
  const gone = planEmptyFolderSweep({ folders, counts: { 'cf:full': 3, 'cf:disc9': 12 }, now });
  assert.deepEqual(gone, ['cf:plain']);
  // ⚠️ THE DRIVE ROOT IS EMPTY ON PURPOSE — it is the row the refresh walks, and deleting it
  // silently stops a nested Drive folder from ever picking up a disc added later (the
  // user's decision 2026-08-30 was to keep it).
  assert.ok(!gone.includes('cf:driveRoot'));
  // ⚠️ v1.0.61 REVERSES A v1.0.58 RULE, DELIBERATELY: a Drive DESCENDANT used to be swept at
  // zero. That was a ping-pong even before nesting — `planDriveFolderImport` counts DENIED
  // files as media present, so a disc whose songs the parent deleted in-app still re-appears
  // on the next refresh, with a NEW folderId. The sweep would tombstone it and the refresh
  // would mint it again, every 30 minutes, against the Drive document, on every device.
  assert.ok(!gone.includes('cf:driveDisc'), 'a Drive-backed row is re-created by the refresh — sweeping it is a loop');
  // a folder that holds FOLDERS is not empty, however few songs of its own it has
  assert.ok(!gone.includes('cf:container'), 'the collection front door was deleted — its discs survive, unreachable');
  // and a folder made minutes ago belongs to a parent who is still working on it: the
  // destination picker creates the row BEFORE the add finishes
  assert.ok(!gone.includes('cf:justMade'));
  // `order` stands in for a row with no createdAt (older rows carry only that)
  assert.deepEqual(planEmptyFolderSweep({ folders: [{ folderId: 'cf:x', order: now - 100 }], counts: {}, now }), []);
  assert.deepEqual(planEmptyFolderSweep({}), []);
});

test('artUrlCandidate: https only, and never a page pretending to be a picture', async () => {
  const { artUrlCandidate } = await import('../www/js/folderart.js');
  assert.equal(artUrlCandidate('https://example.com/a/cat.jpg').thumbUrl, 'https://example.com/a/cat.jpg');
  // these bytes are fetched by the app and end up on a CHILD's screen, so the rule is the
  // one weblock and openExternal already follow
  assert.equal(artUrlCandidate('http://example.com/cat.jpg'), null, 'plain http is refused');
  assert.equal(artUrlCandidate('data:image/png;base64,AAAA'), null);
  assert.equal(artUrlCandidate('javascript:alert(1)'), null);
  assert.equal(artUrlCandidate('https://user:pass@example.com/a.jpg'), null, 'userinfo is a spoofing shape');
  assert.equal(artUrlCandidate('https://example.com'), null, 'a bare host is a page, not a picture');
  assert.equal(artUrlCandidate('not a url'), null);
  assert.equal(artUrlCandidate(''), null);
  assert.equal(artUrlCandidate(null), null);
});

/* ---------------- search inside a folder (v1.0.58) ---------------- */

test('folderSearchScope: a Drive collection is searched WHOLE, from any of its folders', async () => {
  const { folderSearchScope } = await import('../www/js/plan.js');
  // ⚠️ "NESTED" HAS ONE MEANING IN THIS APP: the folders of one imported Drive tree, which
  // all carry `driveRootId` pointing at the root. Nothing else nests — there is no
  // folder-inside-a-folder screen and this feature deliberately does not add one.
  const rows = [
    { folderId: 'cf:root', driveFolderId: 'D' },
    { folderId: 'cf:d1', driveFolderId: 'X1', driveRootId: 'D' },
    { folderId: 'cf:d2', driveFolderId: 'X2', driveRootId: 'D' },
    { folderId: 'cf:plain' },
    { folderId: 'cf:elsewhere', driveFolderId: 'Z' }
  ];
  // From a DISC the scope is the whole collection (the user's decision 2026-08-30): the
  // root row is hidden from the child when it holds no songs of its own, so a strictly
  // downward reading would leave no way to search the other discs from anywhere.
  assert.deepEqual(folderSearchScope({ folderId: 'cf:d1', customRows: rows }), ['cf:d1', 'cf:root', 'cf:d2']);
  // THE FOLDER THE CHILD IS STANDING IN COMES FIRST — its own songs are the likeliest answer
  assert.equal(folderSearchScope({ folderId: 'cf:d2', customRows: rows })[0], 'cf:d2');
  assert.deepEqual(folderSearchScope({ folderId: 'cf:root', customRows: rows }).sort(),
    ['cf:d1', 'cf:d2', 'cf:root']);
  // a folder that nests nothing is simply itself — which is what "search in this folder"
  // means when there is nothing under it
  assert.deepEqual(folderSearchScope({ folderId: 'cf:plain', customRows: rows }), ['cf:plain']);
  assert.deepEqual(folderSearchScope({ folderId: 'cf:elsewhere', customRows: rows }), ['cf:elsewhere'],
    'a lone imported folder must not drag in another collection');
  assert.deepEqual(folderSearchScope({ folderId: 'ch:UC1', customRows: rows }), ['ch:UC1']);
  // and it never reaches a DIFFERENT collection
  assert.ok(!folderSearchScope({ folderId: 'cf:d1', customRows: rows }).includes('cf:elsewhere'));
});

test('folderSearchScope: a FOLDER LOCK narrows it to one folder, always', async () => {
  const { folderSearchScope } = await import('../www/js/plan.js');
  // The home's search is HIDDEN under a folder lock, and its own comment says why: "search
  // reaches ANOTHER folder". A scoped search may stay (the user's decision) only for as
  // long as it cannot do that — and a result from a sibling folder IS a way to reach that
  // folder's grid, through the watch screen's under-player pager.
  const rows = [
    { folderId: 'cf:root', driveFolderId: 'D' },
    { folderId: 'cf:d1', driveFolderId: 'X1', driveRootId: 'D' },
    { folderId: 'cf:d2', driveFolderId: 'X2', driveRootId: 'D' }
  ];
  assert.deepEqual(folderSearchScope({ folderId: 'cf:d1', customRows: rows, locked: true }), ['cf:d1']);
  assert.deepEqual(folderSearchScope({ folderId: 'cf:root', customRows: rows, locked: true }), ['cf:root']);
});

test('folderSearchScope is total, and never answers with nothing to search', async () => {
  const { folderSearchScope } = await import('../www/js/plan.js');
  assert.deepEqual(folderSearchScope({ folderId: 'cf:x' }), ['cf:x'], 'no rows at all still searches the folder');
  assert.deepEqual(folderSearchScope({ folderId: 'cf:x', customRows: null }), ['cf:x']);
  assert.deepEqual(folderSearchScope({ folderId: 'cf:x', customRows: [null, undefined] }), ['cf:x']);
  assert.deepEqual(folderSearchScope({}), []);
  assert.deepEqual(folderSearchScope(), []);
  // a row that names a root nothing else belongs to is not a "tree"
  assert.deepEqual(folderSearchScope({ folderId: 'cf:a', customRows: [{ folderId: 'cf:a', driveFolderId: 'D' }] }), ['cf:a']);
});

/* ---------------- nested Drive folders (v1.0.61) ---------------- */

test('planDriveTreeImport: a container folder survives, and the tree carries its shape', async () => {
  const { planDriveTreeImport } = await import('../www/js/plan.js');
  // ROOT ─ disc 1 (songs) ─ disc 2 (songs) ─ "artwork" (no media, no media below)
  //                     └─ "bonus" (no songs of its own) ─ "bonus/live" (songs)
  const folders = [
    { id: 'ROOT', name: 'אוסף', depth: 0, parentId: null, files: [] },
    { id: 'D1', name: 'דיסק 1', depth: 1, parentId: 'ROOT', files: [{ id: 'a', name: 'a.mp3' }] },
    { id: 'D2', name: 'דיסק 2', depth: 1, parentId: 'ROOT', files: [{ id: 'b', name: 'b.mp3' }] },
    { id: 'ART', name: 'עטיפות', depth: 1, parentId: 'ROOT', files: [{ id: 'p', name: 'p.pdf' }] },
    { id: 'BON', name: 'בונוס', depth: 1, parentId: 'ROOT', files: [] },
    { id: 'LIVE', name: 'הופעה', depth: 2, parentId: 'BON', files: [{ id: 'c', name: 'c.mp3' }] }
  ];
  const kind = (f) => (/\.mp3$/.test(f.name) ? 'audio' : null);
  const r = planDriveTreeImport({
    folders, existingFolders: [], existingKeys: new Set(), denyKeys: new Set(),
    rootId: 'ROOT', mediaKindOf: kind
  });
  const ids = r.folders.map((f) => f.driveFolderId);
  assert.deepEqual(ids, ['ROOT', 'D1', 'D2', 'BON', 'LIVE'], 'the artwork folder holds no media anywhere below it');
  // ⚠️ "בונוס" holds NO songs of its own and must still exist: it is the row the parent taps
  // to reach the live disc. v1.0.58 dropped exactly this folder, correctly, because the tree
  // was flattened and the row could never be opened.
  assert.ok(ids.includes('BON'), 'a folder of folders was dropped — its children are unreachable');
  const by = new Map(r.folders.map((f) => [f.driveFolderId, f]));
  assert.equal(by.get('ROOT').parentDriveId, null, 'the root must anchor nothing above it');
  assert.equal(by.get('D1').parentDriveId, 'ROOT');
  assert.equal(by.get('LIVE').parentDriveId, 'BON', 'depth-2 folders must nest under their real parent');
  assert.equal(r.added, 3);
  // and the ROOT still gets a row with nothing at all in the tree — it anchors the refresh
  const bare = planDriveTreeImport({
    folders: [{ id: 'ROOT', name: 'ריק', depth: 0, parentId: null, files: [] }],
    existingFolders: [], existingKeys: new Set(), denyKeys: new Set(), rootId: 'ROOT', mediaKindOf: kind
  });
  assert.deepEqual(bare.folders.map((f) => f.driveFolderId), ['ROOT']);
});

test('folderAncestry / folderWithinLock: the chain, and a lock that covers a subtree', async () => {
  const { folderAncestry, folderWithinLock } = await import('../www/js/plan.js');
  const rows = [
    { folderId: 'cf:root' },
    { folderId: 'cf:mid', parentFolderId: 'cf:root' },
    { folderId: 'cf:leaf', parentFolderId: 'cf:mid' },
    { folderId: 'cf:other' }
  ];
  assert.deepEqual(folderAncestry('cf:leaf', rows), ['cf:leaf', 'cf:mid', 'cf:root'], 'self first, then up');
  assert.deepEqual(folderAncestry('cf:root', rows), ['cf:root']);
  assert.deepEqual(folderAncestry('cf:nope', rows), [], 'an unknown folder has no chain');
  assert.deepEqual(folderAncestry('', rows), []);
  // ⚠️ parentFolderId travels in the Drive doc and is merged LWW PER ROW, so two devices can
  // briefly produce a chain that points at itself. A lock that hangs is a child stuck.
  const cyclic = [
    { folderId: 'cf:a', parentFolderId: 'cf:b' },
    { folderId: 'cf:b', parentFolderId: 'cf:a' }
  ];
  assert.deepEqual(folderAncestry('cf:a', cyclic), ['cf:a', 'cf:b'], 'a cycle must terminate, not hang');
  // the lock
  assert.equal(folderWithinLock('cf:leaf', 'cf:root', rows), true, 'a locked collection must let its discs open');
  assert.equal(folderWithinLock('cf:root', 'cf:root', rows), true);
  assert.equal(folderWithinLock('cf:other', 'cf:root', rows), false);
  assert.equal(folderWithinLock('cf:root', 'cf:mid', rows), false, 'a lock never opens UPWARD');
  assert.equal(folderWithinLock('cf:x', 'cf:root', rows), false, 'an unknown folder is out of bounds — containment errs strict');
  assert.equal(folderWithinLock('cf:leaf', '', rows), true, 'no lock ⇒ nothing is out of bounds');
});

test('homeFolderRows: the home shows roots, and never loses an orphan', async () => {
  const { homeFolderRows } = await import('../www/js/plan.js');
  const rows = [
    { folderId: 'cf:root' },
    { folderId: 'cf:disc1', parentFolderId: 'cf:root' },
    { folderId: 'cf:disc2', parentFolderId: 'cf:root' },
    { folderId: 'cf:plain' }
  ];
  assert.deepEqual(homeFolderRows(rows).map((r) => r.folderId), ['cf:root', 'cf:plain'],
    'the discs belong inside the collection, not on the home');
  // ⚠️ an older app on the same account sweeps container rows it does not understand. A disc
  // whose parent is GONE falls back to the home — worse placed, never invisible.
  const orphaned = rows.filter((r) => r.folderId !== 'cf:root');
  assert.deepEqual(homeFolderRows(orphaned).map((r) => r.folderId), ['cf:disc1', 'cf:disc2', 'cf:plain']);
  assert.deepEqual(homeFolderRows([]), []);
  assert.deepEqual(homeFolderRows(), []);
  // ⚠️ THE HOME RENDERS TILE OBJECTS, WHOSE ID FIELD IS `id`, NOT `folderId`. Reading only
  // the DB row's name made every parent lookup miss and left all 32 discs on the home —
  // the feature doing nothing, with a green suite. Found in the browser, so pinned here.
  const tiles = [
    { id: 'cf:root', title: 'אוסף' },
    { id: 'cf:disc1', parentFolderId: 'cf:root' },
    { id: 'cf:disc2', parentFolderId: 'cf:root' }
  ];
  assert.deepEqual(homeFolderRows(tiles).map((r) => r.id), ['cf:root']);
});

test('folderPageSlots: child folders and videos share ONE pager, folders first', async () => {
  const { folderPageSlots, folderPageTotal } = await import('../www/js/plan.js');
  // 32 discs + 4 loose songs at 15 per page
  const p0 = folderPageSlots({ childCount: 32, page: 0, pageSize: 15 });
  assert.deepEqual(p0, { folderOffset: 0, folderSlots: 15, videoOffset: 0, videoLimit: 0 });
  const p1 = folderPageSlots({ childCount: 32, page: 1, pageSize: 15 });
  assert.deepEqual(p1, { folderOffset: 15, folderSlots: 15, videoOffset: 0, videoLimit: 0 });
  // the page that STRADDLES the boundary: 2 folders left, then videos fill the rest
  const p2 = folderPageSlots({ childCount: 32, page: 2, pageSize: 15 });
  assert.deepEqual(p2, { folderOffset: 30, folderSlots: 2, videoOffset: 0, videoLimit: 13 });
  const p3 = folderPageSlots({ childCount: 32, page: 3, pageSize: 15 });
  assert.deepEqual(p3, { folderOffset: 32, folderSlots: 0, videoOffset: 13, videoLimit: 15 });
  // no children at all ⇒ exactly today's behaviour
  assert.deepEqual(folderPageSlots({ childCount: 0, page: 2, pageSize: 15 }),
    { folderOffset: 0, folderSlots: 0, videoOffset: 30, videoLimit: 15 });
  // ⚠️ videoLimit 0 is a REAL answer on a page of pure folder tiles, and the caller must
  // still call db.pageFolder — its `total` sizes the pager (pageFolder answers {items:[],
  // total} for a zero limit, the v1.0.58 fix).
  assert.equal(p0.videoLimit, 0);
  assert.deepEqual(folderPageSlots({}), { folderOffset: 0, folderSlots: 0, videoOffset: 0, videoLimit: 15 });
  // totals
  assert.equal(folderPageTotal({ childCount: 32, videoTotal: 4, pageSize: 15 }), 3);
  assert.equal(folderPageTotal({ childCount: 0, videoTotal: 0, pageSize: 15 }), 1, 'an empty folder is still one page');
  assert.equal(folderPageTotal({ childCount: 15, videoTotal: 0, pageSize: 15 }), 1);
});

test('folderSearchScope: the subtree, standing folder first, and a lock still narrows it', async () => {
  const { folderSearchScope } = await import('../www/js/plan.js');
  const rows = [
    { folderId: 'cf:root', driveFolderId: 'D0' },
    { folderId: 'cf:d1', parentFolderId: 'cf:root', driveFolderId: 'D1', driveRootId: 'D0' },
    { folderId: 'cf:d2', parentFolderId: 'cf:root', driveFolderId: 'D2', driveRootId: 'D0' },
    { folderId: 'cf:live', parentFolderId: 'cf:d2', driveFolderId: 'D3', driveRootId: 'D0' },
    { folderId: 'cf:elsewhere' }
  ];
  const fromDisc = folderSearchScope({ folderId: 'cf:d1', customRows: rows });
  assert.equal(fromDisc[0], 'cf:d1', 'the folder the child is standing in is searched FIRST');
  assert.deepEqual(new Set(fromDisc), new Set(['cf:d1', 'cf:root', 'cf:d2', 'cf:live']),
    'from a disc the WHOLE collection is searched — the root row is hidden from the child');
  assert.ok(!fromDisc.includes('cf:elsewhere'), 'the scope must never leak into another collection');
  // a folder that nests nothing is its own scope
  assert.deepEqual(folderSearchScope({ folderId: 'cf:elsewhere', customRows: rows }), ['cf:elsewhere']);
  // ⚠️ a folder LOCK narrows it to one folder, always: a sibling's result is a way to reach
  // that folder's grid through the watch screen's pager (the v1.0.58 rule).
  assert.deepEqual(folderSearchScope({ folderId: 'cf:d1', customRows: rows, locked: true }), ['cf:d1']);
  assert.deepEqual(folderSearchScope({ folderId: '', customRows: rows }), []);
});

test('planFolderDeletion: deleting a collection says it takes the folders too', async () => {
  const { planFolderDeletion } = await import('../www/js/plan.js');
  // ⚠️ after nesting, "delete this folder" can mean 32 discs and 751 songs. A parent who
  // reads only the folder's own name has been told the smallest true thing, not the
  // relevant one.
  const many = planFolderDeletion({ title: 'אוסף', count: 751, mode: 'move', children: 32 });
  assert.match(many.text, /32 התיקיות שבתוכה/);
  assert.match(many.text, /751 הסרטונים/);
  assert.equal(many.children, 32);
  const one = planFolderDeletion({ title: 'אוסף', count: 5, mode: 'purge', children: 1 });
  assert.match(one.text, /ואת התיקיה שבתוכה/, 'one child folder must not read as "1 התיקיות"');
  assert.match(one.text, /לצמיתות/);
  // a container with no songs of its own still needs an answer, and says what it is
  const bare = planFolderDeletion({ title: 'אוסף', count: 0, children: 32 });
  assert.equal(bare.needsChoice, true, 'deleting 32 folders must not go through unasked');
  assert.match(bare.text, /32 התיקיות/);
  assert.ok(!/היא ריקה/.test(bare.text), 'a folder holding 32 folders is not "empty"');
  // and a plain empty folder is untouched by all of this
  assert.deepEqual(planFolderDeletion({ title: 'ריקה', count: 0 }).needsChoice, false);
  assert.match(planFolderDeletion({ title: 'ריקה', count: 0 }).text, /היא ריקה/);
});

/* ---------------- the channel sync-mode dialog (v1.0.61) ---------------- */

test('channelSyncModeDialog: the question is the MODE, and it works with an empty queue', async () => {
  const { channelSyncModeDialog } = await import('../www/js/plan.js');
  // ⚠️ THE BUG THIS REPLACES: the old flow asked "what do I do with these N videos?" and
  // could only be raised when N > 0, so a channel with an empty queue was marked "decided"
  // with no dialog at all and stayed on manual forever.
  const empty = channelSyncModeDialog({ name: 'הרב יעקובזון', pending: 0 });
  assert.match(empty.title, /איך לסנכרן/);
  assert.match(empty.title, /הרב יעקובזון/, 'the channel must be named — a parent may have several fresh rows');
  assert.match(empty.text, /אין סרטונים שממתינים/, 'an empty queue is stated, not hidden');
  assert.match(empty.text, /אוטומטי/);
  assert.match(empty.text, /ידני/);
  // three real answers; "אחר כך" must stay a real button (the v1.0.23 rule: an answer
  // mapped onto an accidental dismiss lets a child poking the scrim decide)
  assert.deepEqual([empty.ok, empty.third, empty.cancel], ['אוטומטי', 'ידני', 'אחר כך']);
  const some = channelSyncModeDialog({ name: 'ערוץ', pending: 5 });
  assert.match(some.text, /5 סרטונים שממתינים/);
  assert.match(some.text, /ייכנסו עכשיו/, 'with a backlog, the answer must say what happens to it');
});

test('channelSyncModeDialog: singular reads correctly, and a nameless channel still works', async () => {
  const { channelSyncModeDialog } = await import('../www/js/plan.js');
  const one = channelSyncModeDialog({ name: 'ערוץ', pending: 1 });
  assert.match(one.text, /סרטון אחד שממתין/);
  assert.match(one.text, /הוא ייכנס עכשיו/, 'one video must not be described as "they"');
  assert.doesNotMatch(one.text, /הם ייכנסו/);
  const anon = channelSyncModeDialog({});
  assert.match(anon.title, /הערוץ/);
  for (const d of [one, anon, channelSyncModeDialog({ pending: -3 })]) {
    assert.doesNotMatch(d.title + d.text, /undefined|NaN|null/);
  }
});

test('channelSyncModeOutcome: a zero names itself', async () => {
  const { channelSyncModeOutcome } = await import('../www/js/plan.js');
  // the v1.0.37 rule — "nothing was waiting" and "5 were approved" are different facts
  const many = channelSyncModeOutcome({ auto: true, approved: 5, name: 'ערוץ' });
  const none = channelSyncModeOutcome({ auto: true, approved: 0, name: 'ערוץ' });
  const manual = channelSyncModeOutcome({ auto: false, name: 'ערוץ' });
  assert.match(many, /5 סרטונים אושרו/);
  assert.match(none, /כל סרטון חדש ייכנס מעצמו/);
  assert.doesNotMatch(none, /אושר/, 'nothing was approved — the sentence must not claim otherwise');
  assert.match(manual, /ידנית/);
  assert.match(channelSyncModeOutcome({ auto: true, approved: 1, name: 'ערוץ' }), /סרטון אחד אושר/);
  for (const m of [many, none, manual]) assert.doesNotMatch(m, /undefined|NaN|null/);
});

/* ---------------- live swipe feedback (v1.0.62) ---------------- */

test('swipeDragArm: the grid starts moving only for a deliberate HORIZONTAL drag', async () => {
  const { swipeDragArm } = await import('../www/js/plan.js');
  const { SWIPE_ARM_PX, TAP_SLOP_PX } = await import('../www/js/config.js');
  // ⚠️ the invariant: arming below the tap slop would make every tap on a tile visibly
  // nudge the whole screen. This is SWIPE_MIN_PX's rule one step earlier and stricter.
  assert.ok(SWIPE_ARM_PX > TAP_SLOP_PX, 'a tap would move the grid');
  assert.equal(swipeDragArm({ dx: SWIPE_ARM_PX - 1, dy: 0 }), null, 'tap territory must not arm');
  assert.equal(swipeDragArm({ dx: 40, dy: 0 }), 'next', 'RTL: dragging RIGHT brings the next page in');
  assert.equal(swipeDragArm({ dx: -40, dy: 0 }), 'prev');
  // a SCROLL that drifts sideways is still a scroll — arming on it makes the grid jitter
  // sideways every time the child scrolls the page (the v1.0.52 collision, now visible)
  assert.equal(swipeDragArm({ dx: 40, dy: -260 }), null, 'a vertical scroll armed a page drag');
  assert.equal(swipeDragArm({ dx: 45, dy: -400 }), null);
  assert.equal(swipeDragArm({ dx: 60, dy: 20 }), 'next', 'a slightly diagonal swipe is still a swipe');
  assert.equal(swipeDragArm({}), null);
  assert.equal(swipeDragArm({ dx: NaN, dy: 0 }), null);
});

test('swipeDragOffset: 1:1 with the finger, rubber-banded where there is no page', async () => {
  const { swipeDragOffset } = await import('../www/js/plan.js');
  const { SWIPE_RUBBER, SWIPE_RUBBER_MAX } = await import('../www/js/config.js');
  const W = 800;
  // the whole point of the feature: the page moves exactly as far as the finger did
  assert.equal(swipeDragOffset({ dx: 120, dir: 'next', width: W }), 120);
  assert.equal(swipeDragOffset({ dx: -120, dir: 'prev', width: W }), -120);
  assert.equal(swipeDragOffset({ dx: 5000, dir: 'next', width: W }), W, 'never further than one page');
  // dragged back past the start: only ONE neighbour is rendered, so it comes to REST at 0
  // rather than revealing a page that is not there
  assert.equal(swipeDragOffset({ dx: -30, dir: 'next', width: W }), 0);
  assert.equal(swipeDragOffset({ dx: 30, dir: 'prev', width: W }), 0);
  // the edge answers with resistance (the user's decision) instead of a frozen screen
  assert.equal(swipeDragOffset({ dx: 100, dir: 'next', width: W, edge: true }), 100 * SWIPE_RUBBER);
  assert.equal(swipeDragOffset({ dx: 9999, dir: 'next', width: W, edge: true }), W * SWIPE_RUBBER_MAX,
    'the rubber band must be capped as a FRACTION, so a phone and a tablet feel the same');
  assert.equal(swipeDragOffset({ dx: -9999, dir: 'prev', width: W, edge: true }), -W * SWIPE_RUBBER_MAX);
  // nonsense never moves anything
  assert.equal(swipeDragOffset({ dx: 100, dir: null, width: W }), 0);
  assert.equal(swipeDragOffset({ dx: 100, dir: 'next', width: 0 }), 0);
  assert.equal(swipeDragOffset({}), 0);
});

test('swipeDragCommit: relative to the width, and an edge NEVER turns', async () => {
  const { swipeDragCommit } = await import('../www/js/plan.js');
  const { SWIPE_COMMIT_RATIO } = await import('../www/js/config.js');
  const W = 800;
  const line = W * SWIPE_COMMIT_RATIO;
  // "what you see is what happens": past a third the next page is more than half revealed
  assert.equal(swipeDragCommit({ dx: line + 1, dir: 'next', width: W }), true);
  assert.equal(swipeDragCommit({ dx: line - 1, dir: 'next', width: W }), false);
  assert.equal(swipeDragCommit({ dx: -(line + 1), dir: 'prev', width: W }), true);
  assert.equal(swipeDragCommit({ dx: -(line - 1), dir: 'prev', width: W }), false);
  // RELATIVE, not absolute: the same drag decides differently on a phone and a tablet,
  // which is the point — it is a fraction of what the child can see.
  assert.equal(swipeDragCommit({ dx: 200, dir: 'next', width: 400 }), true);
  assert.equal(swipeDragCommit({ dx: 200, dir: 'next', width: 1200 }), false);
  // ⚠️ an edge drag never commits however far it was pulled — there is no page to turn to,
  // which is exactly what the rubber band was saying the whole time
  assert.equal(swipeDragCommit({ dx: 5000, dir: 'next', width: W, edge: true }), false);
  // dragging back past the start is not a turn in the armed direction
  assert.equal(swipeDragCommit({ dx: -500, dir: 'next', width: W }), false);
  assert.equal(swipeDragCommit({ dx: 100, dir: null, width: W }), false);
  assert.equal(swipeDragCommit({}), false);
});

test('the live drag and the fallback flick agree about direction (v1.0.62)', async () => {
  const { swipeDragArm, swipePageAction } = await import('../www/js/plan.js');
  // ⚠️ If these ever disagreed the drag would PREVIEW one page and the release would turn
  // to the other — invisible to every other test, and the app would feel possessed.
  for (const dx of [60, 200, -60, -200]) {
    const armed = swipeDragArm({ dx, dy: 0 });
    const flick = swipePageAction({ dx, dy: 0, dt: 300, page: 1, total: 5 });
    assert.equal(armed, flick, `the two paths disagree at dx=${dx}`);
  }
});

/* ---------------- site containment (v1.0.67) ---------------- */

test('evalContainment: the two website modes, and a targetless one is OFF', async () => {
  const { evalContainment, CONTAIN_MODES } = await import('../www/js/plan.js');
  assert.deepEqual(CONTAIN_MODES, ['app', 'folder', 'sites', 'site']);
  const now = 1_800_000_000_000;
  // the websites SCREEN: no target needed, the screen is the target
  const sites = evalContainment({ now, mode: 'sites', until: 0 });
  assert.equal(sites.active, true);
  assert.equal(sites.folderId, null);
  assert.equal(sites.siteUrl, null);
  // ONE site: the url is the target, exactly as folderId is for a folder
  const site = evalContainment({ now, mode: 'site', siteUrl: 'https://example.com/kids/', until: 0 });
  assert.equal(site.active, true);
  assert.equal(site.siteUrl, 'https://example.com/kids/');
  // ⚠️ an active-but-TARGETLESS lock would hold the child somewhere undefined — the same
  // refusal 'folder' already makes without a folderId
  assert.equal(evalContainment({ now, mode: 'site', until: 0 }).active, false);
  assert.equal(evalContainment({ now, mode: 'site', siteUrl: '', until: 0 }).active, false);
  // …and only https: these bytes drive a browser on a child's tablet (the weblock rule)
  assert.equal(evalContainment({ now, mode: 'site', siteUrl: 'http://example.com/' }).active, false);
  assert.equal(evalContainment({ now, mode: 'site', siteUrl: 'javascript:alert(1)' }).active, false);
  // expiry works the same for the new modes
  assert.equal(evalContainment({ now, mode: 'sites', until: now - 1 }).expired, true);
  assert.equal(evalContainment({ now, mode: 'site', siteUrl: 'https://a.com/', until: now + 1000 }).msLeft, 1000);
});

test('containmentChrome: the sites screen keeps its list, the folder lock hides it', async () => {
  const { containmentChrome } = await import('../www/js/plan.js');
  const sites = containmentChrome({ active: true, mode: 'sites' });
  // the child lives on the websites screen: its 🏠 returns to the VIDEOS and must go
  assert.equal(sites.hideHome, true);
  assert.equal(sites.hideSites, false, 'the launcher is the screen the child is locked to');
  assert.equal(sites.hideExit, true);
  // a FOLDER lock hides the websites launcher — a site reaches outside the folder entirely
  assert.equal(containmentChrome({ active: true, mode: 'folder' }).hideSites, true);
  // app mode keeps every surface open, websites included
  assert.equal(containmentChrome({ active: true, mode: 'app' }).hideSites, false);
  assert.equal(containmentChrome({ active: false }).hideSites, false);
});

test('rulesForLockedSite: a narrowing, never a widening (v1.0.67)', async () => {
  const { rulesForLockedSite } = await import('../www/js/weblock.js');
  const rules = [
    { host: 'kids.example.com', port: 443, segments: [] },
    { host: 'kids.example.com', port: 443, segments: ['games'] },
    { host: 'other.example.com', port: 443, segments: [] }
  ];
  const kept = rulesForLockedSite(rules, 'https://kids.example.com/games/one');
  assert.equal(kept.length, 2, 'both rules of the locked host survive');
  assert.ok(kept.every((r) => r.host === 'kids.example.com'));
  assert.ok(!kept.some((r) => r.host === 'other.example.com'),
    'an approved link to ANOTHER site would carry the child out of the site they are locked into');
  // ⚠️ an unmatched url yields NOTHING — the strict direction. The caller must refuse to
  // engage a lock it cannot describe rather than open a browser that blocks its own page.
  assert.deepEqual(rulesForLockedSite(rules, 'https://nowhere.example.com/'), []);
  assert.deepEqual(rulesForLockedSite([], 'https://kids.example.com/'), []);
  assert.deepEqual(rulesForLockedSite(rules, 'not a url'), []);
});

test('externalContentChoice: the two approval doors map their answer identically (v1.0.78)', () => {
  // The reported bug: a CDN-hosted video (anafeam-kids) silently would not play because the
  // page's approval never granted external content. Both doors now map their three-way answer
  // HERE so they cannot drift.
  assert.equal(externalContentChoice('third'), 'with', 'the secondary button allows external content');
  assert.equal(externalContentChoice('ok'), 'without', 'the primary (safe) button keeps it strict');
  // anything that is NOT an explicit answer adds NOTHING — the safe direction, exactly as the
  // add dialog has always treated a dismiss.
  assert.equal(externalContentChoice('cancel'), 'cancel');
  assert.equal(externalContentChoice('dismiss'), 'cancel');
  assert.equal(externalContentChoice(''), 'cancel');
  assert.equal(externalContentChoice(undefined), 'cancel');
  assert.equal(externalContentChoice(null), 'cancel');
});
