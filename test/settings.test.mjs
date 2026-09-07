// settings.js — the synced settings channel (v1.0.25). Before it, the only setting that
// travelled between a family's devices was libraryChannels.autoApprove, and THAT field is
// the cautionary tale this file exists to prevent repeating: nobody stamped its timestamp,
// so the merge compared 0 > 0, the first document always won, and merge(A,B) !== merge(B,A)
// — the documented commutativity invariant was provably false. The suite missed it because
// the fixtures carried timestamps: it pinned the fixture, not the production path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear()
};

const {
  getSetting, getSettings, putSetting, getAllSettings, putAllSettings, mergeSettings, mergeSettingEntry, ACCOUNT
} = await import('../www/js/settings.js');

const e = (v, at) => ({ v, at });

/* ---------------- storage ---------------- */

test('a setting round-trips per profile and per account, without colliding', async () => {
  store.clear();
  await putSetting('p1', 'exitLock', true);
  await putSetting('p2', 'exitLock', false);
  await putSetting(ACCOUNT, 'pin', 'hash-abc');

  assert.equal(await getSetting('p1', 'exitLock', false), true);
  assert.equal(await getSetting('p2', 'exitLock', false), false, 'one child leaked into the other');
  assert.equal(await getSetting(ACCOUNT, 'pin', ''), 'hash-abc');
  // a profile that never wrote gets the default, not the sibling's answer
  assert.equal(await getSetting('p3', 'exitLock', false), false);
});

test('an explicit FALSE is an answer, not an absence', async () => {
  // The whole point of the fallback contract. If a written `false` fell back to the
  // default, turning the exit lock (default off) or share-approval (default ON) off would
  // silently turn it back on at the next read — the parent would flip a switch that
  // refuses to stay flipped.
  store.clear();
  await putSetting('p1', 'shareApproval', false);
  assert.equal(await getSetting('p1', 'shareApproval', true), false);
  await putSetting(ACCOUNT, 'pin', ''); // a CLEARED pin
  assert.equal(await getSetting(ACCOUNT, 'pin', 'legacy-hash'), '',
    "a cleared PIN must not fall back to a stale hash");
});

test('the timestamp is stamped by the writer, never by the caller', async () => {
  // The v1.0.22 lesson from putLibraryChannel: nine call sites were each supposed to set
  // updatedAt and none did, so every comparison was 0 > 0.
  store.clear();
  const before = Date.now();
  await putSetting('p1', 'autoplay', true);
  const all = await getAllSettings();
  const at = all.profiles.p1.autoplay.at;
  assert.ok(at >= before && at <= Date.now(), 'no usable timestamp was written: ' + at);
});

test('a corrupt or absent document reads as empty rather than throwing', async () => {
  store.clear();
  assert.deepEqual(await getAllSettings(), { account: {}, profiles: {} });
  store.set('settings', '{not json');
  assert.deepEqual(await getAllSettings(), { account: {}, profiles: {} });
  assert.equal(await getSetting('p1', 'exitLock', false), false);
  store.set('settings', 'null');
  assert.deepEqual(await getAllSettings(), { account: {}, profiles: {} });
});

/* ---------------- merge ---------------- */

test('the later write wins, per key', () => {
  assert.deepEqual(mergeSettingEntry('exitLock', e(true, 100), e(false, 200)), e(false, 200));
  assert.deepEqual(mergeSettingEntry('exitLock', e(false, 200), e(true, 100)), e(false, 200));
  // one side missing entirely
  assert.deepEqual(mergeSettingEntry('exitLock', null, e(true, 5)), e(true, 5));
  assert.deepEqual(mergeSettingEntry('exitLock', e(true, 5), null), e(true, 5));
  assert.equal(mergeSettingEntry('exitLock', null, null), null);
  // junk that is not an entry must not be mistaken for one
  assert.deepEqual(mergeSettingEntry('exitLock', {}, e(true, 5)), e(true, 5));
  assert.deepEqual(mergeSettingEntry('exitLock', 'nope', e(true, 5)), e(true, 5));
});

test('an exact tie resolves the SAFE way, and never by argument order', () => {
  // Two devices, same millisecond, opposite answers. Whatever we choose must be the same
  // choice in both orders, or the pair ping-pongs forever.
  assert.equal(mergeSettingEntry('exitLock', e(true, 7), e(false, 7)).v, true, 'stay locked');
  assert.equal(mergeSettingEntry('exitLock', e(false, 7), e(true, 7)).v, true);
  // v1.0.55: full-tablet lock during the break — containment errs strict, like exitLock
  assert.equal(mergeSettingEntry('lockTablet', e(true, 7), e(false, 7)).v, true, 'keep the tablet locked');
  assert.equal(mergeSettingEntry('lockTablet', e(false, 7), e(true, 7)).v, true);
  assert.equal(mergeSettingEntry('shareApproval', e(false, 7), e(true, 7)).v, true, 'keep asking');
  assert.equal(mergeSettingEntry('shareApproval', e(true, 7), e(false, 7)).v, true);
  assert.equal(mergeSettingEntry('autoplay', e(true, 7), e(false, 7)).v, false, 'stop playing');
  assert.equal(mergeSettingEntry('autoplay', e(false, 7), e(true, 7)).v, false);
  // v1.0.32: resume playback — the safe tie is today's behaviour, start from the top
  assert.equal(mergeSettingEntry('resume', e(true, 7), e(false, 7)).v, false, 'start over');
  assert.equal(mergeSettingEntry('resume', e(false, 7), e(true, 7)).v, false);
  // v1.0.86: open-in-fullscreen — no safety asymmetry either way, so the tie keeps the
  // shipped behaviour (fullscreen, the default) instead of surprising a family windowed
  assert.equal(mergeSettingEntry('openFullscreen', e(true, 7), e(false, 7)).v, true, 'keep fullscreen');
  assert.equal(mergeSettingEntry('openFullscreen', e(false, 7), e(true, 7)).v, true);
  // no safe direction (an opaque PIN hash): deterministic by value, still order-free
  const a = mergeSettingEntry('pin', e('aaa', 7), e('bbb', 7));
  const b = mergeSettingEntry('pin', e('bbb', 7), e('aaa', 7));
  assert.deepEqual(a, b);
  // an unknown future setting must not throw or become order-dependent either
  assert.deepEqual(mergeSettingEntry('somethingNew', e(1, 7), e(2, 7)),
    mergeSettingEntry('somethingNew', e(2, 7), e(1, 7)));
});

test('mergeSettings(A,B) === mergeSettings(B,A) — the invariant that broke in v1.0.22', () => {
  const A = {
    account: { pin: e('hash-A', 500) },
    profiles: {
      kid1: { exitLock: e(true, 100), shareApproval: e(false, 900) },
      kid2: { autoplay: e(true, 42) }
    }
  };
  const B = {
    account: { pin: e('hash-B', 400) },
    profiles: {
      kid1: { exitLock: e(false, 300) },
      kid3: { exitLock: e(true, 7) }
    }
  };
  const ab = mergeSettings(A, B);
  const ba = mergeSettings(B, A);
  assert.deepEqual(ab, ba, 'the merge is order-dependent — two devices will never converge');

  // and it is actually correct, not merely symmetric
  assert.equal(ab.account.pin.v, 'hash-A', 'the later PIN (500 > 400) must win');
  assert.equal(ab.profiles.kid1.exitLock.v, false, 'the later lock write (300 > 100) must win');
  assert.equal(ab.profiles.kid1.shareApproval.v, false, 'a key only A had must survive');
  assert.equal(ab.profiles.kid2.autoplay.v, true, 'a profile only A had must survive');
  assert.equal(ab.profiles.kid3.exitLock.v, true, 'a profile only B had must survive');

  // IDEMPOTENT: merging the result back in changes nothing (a push/pull loop must settle)
  assert.deepEqual(mergeSettings(ab, A), ab);
  assert.deepEqual(mergeSettings(ab, B), ab);
  assert.deepEqual(mergeSettings(ab, ab), ab);
});

test('a document from an OLDER app (no settings key) never erases ours', () => {
  // Additive rollout: a device still on v1.0.24 writes a doc with no `settings` at all.
  // Treating that as "the family cleared every setting" would unlock a locked tablet.
  const mine = { account: { pin: e('h', 9) }, profiles: { k: { exitLock: e(true, 9) } } };
  assert.deepEqual(mergeSettings(mine, undefined), mine);
  assert.deepEqual(mergeSettings(undefined, mine), mine);
  assert.deepEqual(mergeSettings(mine, {}), mine);
  assert.deepEqual(mergeSettings({}, {}), { account: {}, profiles: {} });
  assert.deepEqual(mergeSettings(null, null), { account: {}, profiles: {} });
});

test('applying a merged document does NOT restamp it', async () => {
  // Restamping an applied remote record makes it instantly newer than the peer's, and the
  // two devices then ping-pong forever — the reason mergeChannelForApply exists.
  store.clear();
  const remote = { account: {}, profiles: { k: { exitLock: e(true, 1234) } } };
  await putAllSettings(mergeSettings(await getAllSettings(), remote));
  const all = await getAllSettings();
  assert.equal(all.profiles.k.exitLock.at, 1234, 'the applied entry was restamped');
  assert.equal(await getSetting('k', 'exitLock', false), true);
});

test('a local change made since the last push survives applying an older remote doc', async () => {
  store.clear();
  await putSetting('k', 'exitLock', false);              // the parent just unlocked it here
  const stale = { account: {}, profiles: { k: { exitLock: e(true, 1) } } }; // ancient peer
  await putAllSettings(mergeSettings(await getAllSettings(), stale));
  assert.equal(await getSetting('k', 'exitLock', true), false,
    'a stale peer re-locked a tablet the parent had just unlocked');
});

test('keepNewest ties resolve to the LARGER window, and stay commutative (v1.0.39)', () => {
  // The rolling window's two failure directions are not symmetric: too large keeps videos
  // nobody wanted, too small proposes deleting videos the child watches. The generic
  // fallback orders by STRING, which would prefer "9" over "200" on an exact `at` tie.
  const A = { v: 9, at: 1000 };
  const B = { v: 200, at: 1000 };
  assert.equal(mergeSettingEntry('keepNewest', A, B).v, 200);
  assert.equal(mergeSettingEntry('keepNewest', B, A).v, 200, 'and it must be commutative');
  // 0 IS NOT A SMALL WINDOW, IT IS OFF, and off deletes nothing at all — so it wins the tie
  // before the max rule. Without this, an exact `at` collision let the phone turn the
  // feature back ON for a parent who had just switched it off on the tablet.
  assert.equal(mergeSettingEntry('keepNewest', { v: 0, at: 5 }, { v: 50, at: 5 }).v, 0);
  assert.equal(mergeSettingEntry('keepNewest', { v: 50, at: 5 }, { v: 0, at: 5 }).v, 0, 'and commutative');
  // a real timestamp still decides — OFF does not outrank recency
  assert.equal(mergeSettingEntry('keepNewest', { v: 0, at: 5 }, { v: 50, at: 9 }).v, 50);
  // a real timestamp still decides — the tie-break may never override recency
  assert.equal(mergeSettingEntry('keepNewest', { v: 9, at: 2000 }, { v: 200, at: 1000 }).v, 9);
  // and it does not leak onto other numeric settings (they keep the documented ordering)
  const s = mergeSettingEntry('lockAfterMin', { v: 9, at: 7 }, { v: 200, at: 7 });
  assert.equal(s.v, mergeSettingEntry('lockAfterMin', { v: 200, at: 7 }, { v: 9, at: 7 }).v,
    'every tie-break must be commutative, whichever rule applies');
});

test('sitesEnabled: ON unless written, OFF once written, and ties go OFF (v1.0.45)', async () => {
  store.clear();
  // The parent asked for the websites button to be there by default, so a family that
  // never opens the tab must still see it. `getSetting`'s fallback fires only when the
  // key was NEVER written, which is exactly the semantics that gives us that.
  assert.equal(await getSetting('p1', 'sitesEnabled', true), true, 'unwritten must read as ON');
  await putSetting('p1', 'sitesEnabled', false);
  assert.equal(await getSetting('p1', 'sitesEnabled', true), false, 'a written OFF must stick');
  await putSetting('p1', 'sitesEnabled', true);
  assert.equal(await getSetting('p1', 'sitesEnabled', true), true);
  // and it is per child, like every other profile-scoped setting
  assert.equal(await getSetting('p2', 'sitesEnabled', true), true);

  // A tie is the only case recency cannot decide; it must be deterministic AND narrow.
  const on = { profiles: { p1: { sitesEnabled: e(true, 500) } } };
  const off = { profiles: { p1: { sitesEnabled: e(false, 500) } } };
  assert.equal(mergeSettings(on, off).profiles.p1.sitesEnabled.v, false);
  assert.equal(mergeSettings(off, on).profiles.p1.sitesEnabled.v, false,
    'a tie must not depend on argument order');
});

/* ---------------- getSettings (v1.0.55) ---------------- */

test('getSettings: several names, one storage read, getSetting semantics per name', async () => {
  store.clear();
  await putSetting('p1', 'exitLock', true);
  await putSetting('p1', 'lockTablet', false);
  // written values come back, incl. an explicit false (an ANSWER, not an absence)
  assert.deepEqual(await getSettings('p1', ['exitLock', 'lockTablet'], null),
    { exitLock: true, lockTablet: false });
  // a never-written name gets the fallback, per name — not the sibling's value
  assert.deepEqual(await getSettings('p1', ['exitLock', 'autoplay'], false),
    { exitLock: true, autoplay: false });
  // a scope that never wrote anything answers all-fallback instead of throwing
  assert.deepEqual(await getSettings('p9', ['exitLock', 'lockTablet'], false),
    { exitLock: false, lockTablet: false });
  // ACCOUNT scope works like getSetting's
  await putSetting(ACCOUNT, 'pin', 'h');
  assert.deepEqual(await getSettings(ACCOUNT, ['pin'], ''), { pin: 'h' });
  // a JUNK entry (not the {v,at} shape) reads as the fallback, never a throw — the
  // mergeSettingEntry shape rule; getSetting would throw `'v' in "junk"` here
  const raw = JSON.parse(store.get('settings'));
  raw.profiles.p1.exitLock = 'junk';
  store.set('settings', JSON.stringify(raw));
  assert.deepEqual(await getSettings('p1', ['exitLock', 'lockTablet'], false),
    { exitLock: false, lockTablet: false });
  // empty/missing name lists are harmless
  assert.deepEqual(await getSettings('p1', [], false), {});
  assert.deepEqual(await getSettings('p1', undefined, false), {});
});
