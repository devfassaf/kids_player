// Drive DB pure-merge tests — the two properties that make server-free convergence
// safe: commutativity and idempotence. Plus the serialization refusal list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretDriveDoc, interpretDriveList, decidePush, mergeChannelForApply, stripPerDeviceChannel, serializeDb, parseDb, mergeDbFiles, mergeLibraryChannel, serializeStateEntry, mergeAppliedState, mergeDeletedChannels, channelOutlivesTombstone, planChannelApply, resolveRestoredLibraryId, restoreScopeCorrection, mergeSiteEntry, mergeDeletedSiteEntries, siteEntryOutlivesTombstone, planSiteApply } from '../www/js/drive.js';
import { mergeSettings } from '../www/js/settings.js';
import { mergeVideoRecord, settleCuration } from '../www/js/normalize.js';

const vid = (key, over = {}) => ({
  key, type: 'youtube', id: key.slice(3), srcUrl: 'https://youtu.be/' + key.slice(3),
  title: 'שיר', titleSource: 'rss', normTitle: 'שיר', folderId: 'sheet', channelId: null,
  sortKey: 1, publishedAt: null, rowIndex: 0, origin: 'sheet-row', state: 'live',
  addedAt: 100, updatedAt: 100, ...over
});

const docA = {
  kind: 'kids-player-db', schema: 1, exportedAt: 1000,
  profiles: [{ id: 'p1', name: 'דני', updatedAt: 10 }],
  libraries: {
    'lib:x': {
      sheetUrl: 'https://sheet', videos: [vid('yt:aaaaaaaaaaa'), vid('yt:bbbbbbbbbbb')],
      denylist: [{ key: 'yt:ddddddddddd', at: 5 }],
      channels: [{ channelId: 'UCabcdefghijklmnopqrstuv', title: 'ערוץ', updatedAt: 10 }],
      libraryChannels: [{ channelId: 'UCabcdefghijklmnopqrstuv', autoApprove: false, updatedAt: 10 }]
    },
    // v1.0.45 — approved websites ride the PROFILE pseudo-library, which is the only
    // place they ever appear in a real document.
    'prof:p1': {
      sheetUrl: null, videos: [], denylist: [], channels: [], libraryChannels: [],
      siteEntries: [
        { entryId: 'sc:1111', kind: 'shortcut', url: 'https://a.com/kids/', title: 'א', order: 0, updatedAt: 10 },
        { entryId: 'rl:2222', kind: 'rule', display: 'https://a.com/kids/', host: 'a.com', port: 443, segments: ['kids'], allowExternal: false, order: 1, updatedAt: 10 }
      ],
      deletedSiteEntries: {}
    }
  },
  profileState: { p1: { 'yt:aaaaaaaaaaa': { unwrappedAt: 50 } } }
};
const docB = {
  kind: 'kids-player-db', schema: 1, exportedAt: 2000,
  profiles: [{ id: 'p1', name: 'דני!', updatedAt: 20 }],
  libraries: {
    'lib:x': {
      sheetUrl: 'https://sheet',
      videos: [vid('yt:bbbbbbbbbbb', { state: 'pending', addedAt: 50 }), vid('yt:ccccccccccc')],
      denylist: [{ key: 'yt:eeeeeeeeeee', at: 7 }, { key: 'yt:bbbbbbbbbbb', at: 9 }],
      channels: [{ channelId: 'UCabcdefghijklmnopqrstuv', title: 'ערוץ חדש', updatedAt: 20 }],
      libraryChannels: [{ channelId: 'UCabcdefghijklmnopqrstuv', autoApprove: true, updatedAt: 20 }]
    },
    'prof:p1': {
      sheetUrl: null, videos: [], denylist: [], channels: [], libraryChannels: [],
      siteEntries: [
        { entryId: 'sc:1111', kind: 'shortcut', url: 'https://a.com/kids/', title: 'א חדש', order: 0, updatedAt: 20 },
        { entryId: 'sc:3333', kind: 'shortcut', url: 'https://b.org/', title: 'ב', order: 2, updatedAt: 20 }
      ],
      deletedSiteEntries: {}
    }
  },
  profileState: { p1: { 'yt:aaaaaaaaaaa': { unwrappedAt: 30 }, 'yt:ccccccccccc': { giftRank: 1 } } }
};

const canon = (d) => JSON.parse(JSON.stringify(d, (k, v) => k === 'exportedAt' ? 0 : v,));
const sortAll = (d) => {
  for (const lib of Object.values(d.libraries)) {
    lib.videos.sort((x, y) => x.key < y.key ? -1 : 1);
    lib.denylist.sort((x, y) => x.key < y.key ? -1 : 1);
    // v1.0.45: a new merged ARRAY must be sorted here too, or the commutativity tests
    // below compare Map-iteration order and start failing (or, worse, passing by luck).
    if (lib.siteEntries) lib.siteEntries.sort((x, y) => x.entryId < y.entryId ? -1 : 1);
  }
  d.profiles.sort((x, y) => x.id < y.id ? -1 : 1);
  return d;
};

test('merge is commutative: merge(a,b) ≡ merge(b,a)', () => {
  const ab = sortAll(canon(mergeDbFiles(docA, docB)));
  const ba = sortAll(canon(mergeDbFiles(docB, docA)));
  assert.deepEqual(ab, ba);
});

test('merge is idempotent: merge(a,a) keeps a\'s content', () => {
  const aa = sortAll(canon(mergeDbFiles(docA, docA)));
  const a1 = sortAll(canon(mergeDbFiles(docA, JSON.parse(JSON.stringify(docA)))));
  assert.deepEqual(aa, a1);
  assert.equal(aa.libraries['lib:x'].videos.length, 2); // aaaa+bbbb kept (only dddd is denied in A)
});

test('deny-list is a union and denied videos never travel', () => {
  const m = mergeDbFiles(docA, docB);
  const deniedKeys = m.libraries['lib:x'].denylist.map((d) => d.key).sort();
  assert.deepEqual(deniedKeys, ['yt:bbbbbbbbbbb', 'yt:ddddddddddd', 'yt:eeeeeeeeeee']);
  assert.ok(!m.libraries['lib:x'].videos.some((v) => v.key === 'yt:bbbbbbbbbbb'),
    'a video denied on EITHER device is gone from the merged doc');
});

test('unwrappedAt takes MIN — once unwrapped anywhere, never re-gifted', () => {
  const m = mergeDbFiles(docA, docB);
  assert.equal(m.profileState.p1['yt:aaaaaaaaaaa'].unwrappedAt, 30);
});

test('LWW by updatedAt for profiles and channel toggles', () => {
  const m = mergeDbFiles(docA, docB);
  assert.equal(m.profiles[0].name, 'דני!');
  assert.equal(m.libraries['lib:x'].libraryChannels[0].autoApprove, true);
});

test('autoApprove CONVERGES even when neither row carries a timestamp (v1.0.22)', () => {
  // The real production shape until v1.0.22: no writer set `updatedAt` on a
  // libraryChannels row, so `lww` compared 0 > 0 → false → the FIRST argument won and
  // "I approved this channel" resolved by merge order. The suite missed it because the
  // fixtures above DO carry timestamps — it pinned the fixture, not the app.
  const lib = (autoApprove) => ({
    kind: 'kids-player-db', schema: 1, exportedAt: 1, profiles: [], profileState: {}, profileSources: {},
    libraries: { 'lib:x': { videos: [], denylist: [], channels: [], libraryChannels: [{ channelId: 'UC1', autoApprove }] } }
  });
  const on = lib(true);
  const off = lib(false);
  const pick = (d) => mergeDbFiles(...d).libraries['lib:x'].libraryChannels[0].autoApprove;
  assert.equal(pick([on, off]), pick([off, on]), 'merge must not depend on argument order');
  // and the tie resolves the SAFE way: still requires the parent to approve
  assert.equal(pick([on, off]), false);
});

test('mergeLibraryChannel: recency wins, a timestamp beats a legacy row, tie is safe', () => {
  const a = { channelId: 'UC1', autoApprove: false, updatedAt: 10 };
  const b = { channelId: 'UC1', autoApprove: true, updatedAt: 20 };
  assert.equal(mergeLibraryChannel(a, b).autoApprove, true, 'newer wins');
  assert.equal(mergeLibraryChannel(b, a).autoApprove, true, 'and it is commutative');
  const legacy = { channelId: 'UC1', autoApprove: false };
  assert.equal(mergeLibraryChannel(legacy, b).autoApprove, true, 'a real timestamp beats no timestamp');
  assert.equal(mergeLibraryChannel(b, legacy).autoApprove, true);
  assert.equal(mergeLibraryChannel(null, a), a);
  assert.equal(mergeLibraryChannel(a, null), a);
});

test('a peer\'s approval arrives REACHABLE, not parked (v1.0.22)', () => {
  // The applyRemoteDoc composition: local record is waiting for approval, the remote one
  // was approved on another device. mergeVideoRecord promotes the state and never touches
  // folderId, so this used to yield live + '~pending' — invisible in the child's folder
  // AND absent from the approval queue.
  const mine = {
    key: 'yt:aaaaaaaaaaa', state: 'pending', folderId: '~pending', homeFolderId: 'ch:UC1',
    title: 'שיר', titleSource: 'rss', addedAt: 100, approvedAt: null
  };
  const remote = {
    key: 'yt:aaaaaaaaaaa', state: 'live', folderId: 'ch:UC1',
    title: 'שיר', titleSource: 'rss', addedAt: 100, approvedAt: 500
  };
  const rec = settleCuration(mergeVideoRecord(mine, remote), remote.homeFolderId || remote.folderId, 900);
  assert.equal(rec.state, 'live');
  assert.equal(rec.folderId, 'ch:UC1', 'un-parked, or the child can never reach it');
  assert.equal(rec.approvedAt, 500, 'the peer\'s approval time survives');

  // The other direction must NOT leak: a remote record still pending stays parked.
  const stillWaiting = settleCuration(
    mergeVideoRecord({ ...mine }, { ...remote, state: 'pending', folderId: '~pending', approvedAt: null }),
    'ch:UC1', 900
  );
  assert.equal(stillWaiting.state, 'pending');
  assert.equal(stillWaiting.folderId, '~pending');
});

test('a REJECTION travels through the Drive doc, and the merge stays order-independent (v1.0.23)', () => {
  // The cross-device half of the rejected list. Device A rejected the video at t=900;
  // device B still holds the copy it approved at t=100 and pushes it. Whichever order the
  // two documents meet in, the child must not get it back.
  const doc = (over) => ({
    kind: 'kids-player-db', schema: 1, exportedAt: 1, profiles: [], profileState: {}, profileSources: {},
    libraries: { 'lib:x': { sheetUrl: null, denylist: [], channels: [], libraryChannels: [], videos: [vid('yt:aaaaaaaaaaa', over)] } }
  });
  const rejectedOnA = doc({ state: 'rejected', rejectedAt: 900, approvedAt: null, folderId: '~rejected', homeFolderId: 'ch:UC1' });
  const liveOnB = doc({ state: 'live', approvedAt: 100, folderId: 'ch:UC1' });
  const pick = (x, y) => mergeDbFiles(x, y).libraries['lib:x'].videos[0];

  for (const [name, m] of [['A,B', pick(rejectedOnA, liveOnB)], ['B,A', pick(liveOnB, rejectedOnA)]]) {
    assert.equal(m.state, 'rejected', `merge(${name}) revived a rejected video`);
    assert.equal(m.approvedAt, null, `merge(${name}) still claims it is approved`);
  }
  // and the mirror image: an approval made LATER than the rejection must win
  const laterApproval = doc({ state: 'live', approvedAt: 5000, folderId: 'ch:UC1' });
  assert.equal(pick(rejectedOnA, laterApproval).state, 'live', 'the parent changed their mind');
  assert.equal(pick(laterApproval, rejectedOnA).state, 'live');
  // idempotence: merging a doc with itself must not disturb the decision
  assert.equal(pick(rejectedOnA, rejectedOnA).state, 'rejected');
  assert.equal(pick(rejectedOnA, rejectedOnA).rejectedAt, 900);
});

test('serializeDb round-trips the rejected shape (v1.0.23)', () => {
  // If `rejectedAt` or the '~rejected' parking slot did not survive serialization, the
  // rejection would arrive on the peer as an undated one — and resolveCuration compares
  // exactly that timestamp, so any live copy would then outrank it.
  const doc = {
    profiles: [], profileState: {}, profileSources: {},
    libraries: { 'lib:x': { sheetUrl: null, denylist: [], channels: [], libraryChannels: [],
      videos: [vid('yt:aaaaaaaaaaa', { state: 'rejected', rejectedAt: 4242, approvedAt: null, folderId: '~rejected', homeFolderId: 'ch:UC1' })] } }
  };
  const back = parseDb(serializeDb(doc));
  const v = back.libraries['lib:x'].videos[0];
  assert.equal(v.state, 'rejected');
  assert.equal(v.rejectedAt, 4242, 'the decision timestamp must survive the round trip');
  assert.equal(v.folderId, '~rejected');
  assert.equal(v.homeFolderId, 'ch:UC1', 'without this the peer cannot restore it anywhere');
});

test('serializeDb refusal list: no localPath, no thumbId, no backfillCursor', () => {
  const json = serializeDb({
    profiles: [],
    libraries: {
      'lib:x': {
        videos: [vid('yt:aaaaaaaaaaa', { localPath: 'videos/x.mp4', thumbId: 'file:abc' })],
        channels: [{
          channelId: 'UCabcdefghijklmnopqrstuv', title: 'ערוץ', logoUrl: 'https://x/y.jpg',
          backfillCursor: 'PAGE_TOKEN', backfillPlaylistId: 'UULFabcdefghijklmnopqrstuv',
          playlistCursor: 'PL_TOKEN', playlistQueue: ['PLaaa'], playlistsDone: true, noLongForm: true
        }],
        denylist: [], libraryChannels: []
      }
    },
    profileState: {}
  });
  assert.ok(!json.includes('localPath'));
  assert.ok(!json.includes('thumbId'));
  assert.ok(!json.includes('backfillCursor'));
  assert.ok(!json.includes('PAGE_TOKEN'));
  // v1.0.21 — PAGING STATE IS PER DEVICE. A page token means nothing in another device's
  // paging position, and `playlistsDone`/`noLongForm` arriving from a peer would make this
  // device skip work it never did: device B would pull "playlists finished" from device A
  // and never walk them in its OWN scope, losing that content permanently if B follows a
  // different sheet.
  for (const leak of ['playlistCursor', 'PL_TOKEN', 'playlistQueue', 'PLaaa', 'playlistsDone', 'noLongForm', 'backfillPlaylistId']) {
    assert.ok(!json.includes(leak), `${leak} leaked into the Drive backup`);
  }
  // …while the fields that DO belong to every device still travel
  assert.ok(json.includes('logoUrl') && json.includes('ערוץ'), 'shared channel fields were dropped');
});

test('parseDb: round-trip works; garbage and truncated input → null, never throws', () => {
  const json = serializeDb({ profiles: [], libraries: {}, profileState: {} });
  assert.ok(parseDb(json));
  assert.equal(parseDb(json.slice(0, 30)), null);
  assert.equal(parseDb('{"kind":"other"}'), null);
  assert.equal(parseDb(null), null);
});

/* ---------------- profileSources (v1.0.4: profile→sheet mapping in the doc) ---------------- */

test('profileSources: LWW by updatedAt, one-sided entries survive, commutative', () => {
  const a2 = { ...docA, profileSources: { p1: { sheetUrl: 'https://old', updatedAt: 10 }, p2: { sheetUrl: 'https://only-a', updatedAt: 5 } } };
  const b2 = { ...docB, profileSources: { p1: { sheetUrl: 'https://new', updatedAt: 20 } } };
  const ab = mergeDbFiles(a2, b2);
  const ba = mergeDbFiles(b2, a2);
  assert.equal(ab.profileSources.p1.sheetUrl, 'https://new');
  assert.equal(ab.profileSources.p2.sheetUrl, 'https://only-a');
  assert.deepEqual(ab.profileSources, ba.profileSources);
});

test('profileSources: docs WITHOUT the field (pre-v1.0.4 backups) merge cleanly', () => {
  const m = mergeDbFiles(docA, docB); // neither doc carries profileSources
  assert.deepEqual(m.profileSources, {});
  const mixed = mergeDbFiles(docA, { ...docB, profileSources: { p1: { sheetUrl: 'https://s', updatedAt: 1 } } });
  assert.equal(mixed.profileSources.p1.sheetUrl, 'https://s');
});

test('serializeDb round-trips profileSources; omitted -> {}', () => {
  const json = serializeDb({
    profiles: [], libraries: {}, profileState: {},
    profileSources: { p1: { sheetUrl: 'https://sheet', updatedAt: 7 } }
  });
  assert.equal(parseDb(json).profileSources.p1.sheetUrl, 'https://sheet');
  assert.deepEqual(parseDb(serializeDb({ profiles: [], libraries: {}, profileState: {} })).profileSources, {});
});

/* ---------------- v1.0.10: deny LWW with revocation (sheet-wins undeny) ---------------- */

test('a LATER revoke defeats an older deny — the video travels again', async () => {
  const { mergeDenyRecord } = await import('../www/js/drive.js');
  const a2 = { ...docA, libraries: { 'lib:x': { ...docA.libraries['lib:x'],
    denylist: [{ key: 'yt:aaaaaaaaaaa', at: 50 }] } } };
  const b2 = { ...docB, libraries: { 'lib:x': { ...docB.libraries['lib:x'],
    denylist: [{ key: 'yt:aaaaaaaaaaa', at: 50, removedAt: 90 }] } } };
  const m = mergeDbFiles(a2, b2);
  const entry = m.libraries['lib:x'].denylist.find((d) => d.key === 'yt:aaaaaaaaaaa');
  assert.equal(entry.removedAt, 90, 'the revoked entry wins the merge');
  assert.ok(m.libraries['lib:x'].videos.some((v) => v.key === 'yt:aaaaaaaaaaa'),
    'a revoked deny no longer drops the video');
  // direct rule checks: later re-deny beats older revoke
  const reDenied = mergeDenyRecord({ key: 'k', at: 50, removedAt: 90 }, { key: 'k', at: 120 });
  assert.equal(reDenied.at, 120);
  assert.equal(reDenied.removedAt, undefined);
});

test('deny LWW merge stays commutative and idempotent', () => {
  const a2 = { ...docA, libraries: { 'lib:x': { ...docA.libraries['lib:x'],
    denylist: [{ key: 'yt:ddddddddddd', at: 5 }, { key: 'yt:aaaaaaaaaaa', at: 40, removedAt: 60 }] } } };
  const b2 = { ...docB, libraries: { 'lib:x': { ...docB.libraries['lib:x'],
    denylist: [{ key: 'yt:aaaaaaaaaaa', at: 70 }] } } };
  const ab = sortAll(canon(mergeDbFiles(a2, b2)));
  const ba = sortAll(canon(mergeDbFiles(b2, a2)));
  assert.deepEqual(ab, ba);
  const aa = sortAll(canon(mergeDbFiles(a2, a2)));
  assert.deepEqual(aa, sortAll(canon(mergeDbFiles(a2, JSON.parse(JSON.stringify(a2))))));
  // at 70 > removedAt 60 → the re-deny wins → video dropped
  assert.ok(!ab.libraries['lib:x'].videos.some((v) => v.key === 'yt:aaaaaaaaaaa'));
});

/* ---- the READ side of the deny list (v1.0.20) ---- */

test('denyActive: the read gate agrees with the merge rule, tie → revoked', async () => {
  // The merge rule above decides which deny record survives; this one-liner decides
  // whether a surviving record still BLOCKS. If they ever disagree, deleted videos come
  // back (too lenient) or a sheet re-add can never revive anything (too strict).
  const { denyActive } = await import('../www/js/db.js');
  assert.equal(denyActive({ key: 'yt:a', at: 5 }), true, 'a plain tombstone blocks');
  assert.equal(denyActive({ key: 'yt:a', at: 5, removedAt: 4 }), true, 'an OLDER revoke loses');
  assert.equal(denyActive({ key: 'yt:a', at: 5, removedAt: 6 }), false, 'a LATER revoke wins');
  assert.equal(denyActive({ key: 'yt:a', at: 5, removedAt: 5 }), false, 'a TIE goes to revoked');
  // junk must read as "not blocking" — a corrupt row may not silently hide content
  for (const junk of [null, undefined, 0, '', false]) assert.equal(denyActive(junk), false, String(junk));
  // a record with no timestamp at all still blocks (at||0 = 0, no removedAt)
  assert.equal(denyActive({ key: 'yt:a' }), true);
});

/* ---- v1.0.22: the Drive I/O gates. The pure half of the merge was always tested; the
        decision to WRITE was not, and that is the side that can lose a family's data. ---- */

test('interpretDriveDoc: only a 404 may mean "no document"', () => {
  const doc = JSON.stringify({ kind: 'kids-player-db', schema: 1, libraries: {}, profiles: [] });
  assert.equal(interpretDriveDoc(404, ''), null, 'a real 404 is the ONE empty answer');
  assert.equal(interpretDriveDoc(200, doc).kind, 'kids-player-db');

  // Everything else THROWS. This is the whole point: readDbFile used to answer `null` for
  // all of these, mergeDbFiles(local, null) returns local, and pushDrive then PATCHed
  // local over the remote — in the branch that exists to protect the peer's changes.
  for (const [status, body, why] of [
    [401, '', 'stale token'],
    [500, '', 'server error'],
    [0, '', 'network drop'],
    [200, '', 'empty body'],
    [200, '<!DOCTYPE html><html>sign in</html>', 'a lost grant answers 200 + HTML'],
    [200, '{"kind":"something-else"}', 'not our document'],
    [200, 'not json at all', 'garbage'],
    [200, '{"kind":"kids-player-db"}', 'no libraries map']
  ]) {
    assert.throws(() => interpretDriveDoc(status, body), undefined, `${status} (${why}) did not throw`);
  }
});

test('interpretDriveList: "couldn’t ask" is not "nothing there"', () => {
  // Conflating them told the parent "no backup exists" AND sent pushDrive down the create
  // branch, producing a SECOND db file that permanently shadows the family's real one.
  assert.deepEqual(interpretDriveList(200, { files: [] }), []);
  assert.equal(interpretDriveList(200, { files: [{ id: 'a' }] }).length, 1);
  for (const [status, data] of [[401, null], [500, null], [0, null], [200, {}], [200, { files: 'x' }], [200, null]]) {
    assert.throws(() => interpretDriveList(status, data), undefined, `status ${status} did not throw`);
  }
});

test('decidePush: an UNREADABLE remote aborts — it never writes', () => {
  // Aborting costs one deferred push (pendingPush retries). Guessing costs the backup.
  assert.equal(decidePush({ fileId: null }).action, 'create', 'no file yet ⇒ create');
  assert.equal(decidePush({ fileId: 'f', remoteVersion: '7', lastRemoteVersion: '7' }).action, 'write',
    'unchanged since our own write ⇒ safe to overwrite');

  const changed = { fileId: 'f', remoteVersion: '9', lastRemoteVersion: '7' };
  assert.equal(decidePush({ ...changed, remoteRead: { ok: false, error: 'drive-401' } }).action, 'abort');
  assert.equal(decidePush({ ...changed, remoteRead: null }).action, 'abort', 'not even attempted ⇒ abort');
  const merged = decidePush({ ...changed, remoteRead: { ok: true, doc: { kind: 'kids-player-db', libraries: {} } } });
  assert.equal(merged.action, 'write');
  assert.equal(merged.useRemote, true, 'a readable remote MUST be merged in before writing');

  // an unknown version is a mismatch, not a match: a failed probe must not look "unchanged"
  assert.equal(decidePush({ fileId: 'f', remoteVersion: null, lastRemoteVersion: '7', remoteRead: { ok: false } }).action, 'abort');
  // …and a first-ever push (no lastRemoteVersion) against an existing file still merges
  assert.equal(decidePush({ fileId: 'f', remoteVersion: '1', lastRemoteVersion: '', remoteRead: { ok: true, doc: {} } }).useRemote, true);
});

test('per-device channel progress never travels, in EITHER direction', () => {
  const remote = {
    channelId: 'UCabcdefghijklmnopqrstuv', title: 'ערוץ', logoUrl: 'https://x/y.jpg',
    backfillCursor: 'THEIRS', backfillPlaylistId: 'UULFtheirs', backfillDone: true,
    lastRssCheckedAt: 999, playlistCursor: 'THEIRS2', playlistQueue: ['PL1'],
    playlistsDone: true, noLongForm: true
  };
  // A channel this device has NEVER seen must adopt the shared facts only. Writing the
  // peer's record verbatim handed it `backfillDone:true`, so planChannelFetch returned
  // 'rss' forever and the child only ever got the ~15-video feed window.
  const fresh = mergeChannelForApply(null, remote);
  assert.equal(fresh.title, 'ערוץ');
  assert.equal(fresh.logoUrl, 'https://x/y.jpg');
  for (const f of ['backfillCursor', 'backfillPlaylistId', 'backfillDone', 'lastRssCheckedAt',
    'playlistCursor', 'playlistQueue', 'playlistsDone', 'noLongForm']) {
    assert.ok(!(f in fresh), `${f} was adopted from a peer`);
  }
  // where we DO have local progress, ours wins and the shared facts still update
  const prev = { channelId: remote.channelId, title: 'old', backfillCursor: 'MINE', backfillDone: false, playlistsDone: false };
  const merged = mergeChannelForApply(prev, remote);
  assert.equal(merged.title, 'ערוץ', 'shared facts must still be adopted');
  assert.equal(merged.backfillCursor, 'MINE');
  assert.equal(merged.backfillDone, false, "a peer's 'finished' must not skip our backfill");
  assert.equal(merged.playlistsDone, false);
  // stripPerDeviceChannel is what serializeDb uses, so the two halves cannot drift
  assert.deepEqual(Object.keys(stripPerDeviceChannel(remote)).sort(), ['channelId', 'logoUrl', 'title']);
});

test('denyRowToWrite: a REVOKED tombstone in the target is never overwritten', async () => {
  const { denyRowToWrite, denyActive } = await import('../www/js/db.js');
  const active = { key: 'yt:aaaaaaaaaaa', at: 500, reason: 'watch-delete' };

  // The bug: "is it missing?" was answered with loadDenySet, which exposes ACTIVE entries
  // only — so a REVOKED row read as absent, got put over, and lost its `removedAt`. That
  // silently undid the one deliberate undeny path ("the sheet wins"), and because the
  // replacement was stamped Date.now() it always won Drive's last-event comparison, so the
  // resurrected tombstone propagated and re-deleted the video on EVERY device.
  const revokedTarget = { key: 'yt:aaaaaaaaaaa', at: 500, removedAt: 900 };
  assert.equal(denyRowToWrite(revokedTarget, active, 'lib:x'), null, 'a revocation was clobbered');
  // an ACTIVE target is likewise left alone (its own timestamp must survive)
  assert.equal(denyRowToWrite({ key: 'yt:aaaaaaaaaaa', at: 700 }, active, 'lib:x'), null);

  // genuinely missing ⇒ copy, carrying the SOURCE's timestamp, not "now"
  const row = denyRowToWrite(undefined, active, 'lib:x');
  assert.equal(row.scopeId, 'lib:x');
  assert.equal(row.key, 'yt:aaaaaaaaaaa');
  assert.equal(row.at, 500, 'the tombstone was re-stamped, which wins the Drive LWW wrongly');
  // a revoked SOURCE copies as revoked — it must not arrive active in the new scope
  const revokedSource = denyRowToWrite(undefined, { key: 'yt:bbbbbbbbbbb', at: 100, removedAt: 200 }, 'lib:x');
  assert.equal(revokedSource.removedAt, 200);
  assert.equal(denyActive(revokedSource), false, 'a revoked entry arrived ACTIVE in the target');
  for (const junk of [null, undefined, {}, { at: 1 }]) assert.equal(denyRowToWrite(undefined, junk, 'lib:x'), null, String(junk));
});

/* ---------------- synced settings ON THE WIRE (v1.0.25) ----------------
 * settings.test.mjs proves mergeSettings converges. These prove the settings actually
 * TRAVEL: deleting one line from serializeDb would leave that whole file green while the
 * PIN silently stopped syncing — the "pinned the fixture, not the production path"
 * failure this repo has already been bitten by twice.
 */

const doc = (settings) => parseDb(serializeDb({
  profiles: [{ id: 'p1', name: 'נועם' }], libraries: {}, profileState: {}, profileSources: {}, settings
}));

test('settings survive serialize → parse (they are really on the wire)', () => {
  const s = { account: { pin: { v: 'hash', at: 7 } }, profiles: { p1: { exitLock: { v: true, at: 9 } } } };
  const d = doc(s);
  assert.ok(d, 'the document did not even parse');
  assert.deepEqual(d.settings, s, 'settings never reached the Drive document');
});

test('serializeDb emits an EMPTY settings object rather than nothing', () => {
  // A missing key and an empty one behave differently on the merge side, and every push
  // from a device that has changed no setting takes this path.
  const d = doc(undefined);
  assert.deepEqual(d.settings, { account: {}, profiles: {} });
});

test('mergeDbFiles merges settings — not first-wins, not dropped', () => {
  const A = serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: { pin: { v: 'old', at: 100 } }, profiles: { p1: { exitLock: { v: false, at: 100 } } } } });
  const B = serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: { pin: { v: 'new', at: 200 } }, profiles: { p1: { autoplay: { v: true, at: 50 } } } } });
  const ab = mergeDbFiles(parseDb(A), parseDb(B));
  const ba = mergeDbFiles(parseDb(B), parseDb(A));

  assert.equal(ab.settings.account.pin.v, 'new', 'the later PIN lost — settings are not merged');
  assert.equal(ab.settings.profiles.p1.exitLock.v, false, 'a key only A had was dropped');
  assert.equal(ab.settings.profiles.p1.autoplay.v, true, 'a key only B had was dropped');
  // the whole reason this repo writes merge tests at all
  assert.deepEqual(ab.settings, ba.settings, 'order-dependent — two devices never converge');
  // idempotent: a push/pull loop has to settle
  assert.deepEqual(mergeDbFiles(ab, parseDb(A)).settings, ab.settings);
  assert.deepEqual(mergeDbFiles(ab, ab).settings, ab.settings);
});

test('openFullscreen travels per profile and the LATER answer wins (v1.0.86)', () => {
  // The user's explicit requirement: the flag is per profile and syncs between devices like
  // every other control flag. The channel is generic, so this pins the PRODUCTION path for
  // this key — serialize → parse → merge, both orders — not a fixture of mergeSettings.
  const tablet = serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: {}, profiles: { p1: { openFullscreen: { v: true, at: 100 } } } } });
  const phone = serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: {}, profiles: {
      p1: { openFullscreen: { v: false, at: 200 } },   // the parent switched it off LATER
      p2: { openFullscreen: { v: true, at: 150 } }     // the sibling's own answer
    } } });
  const ab = mergeDbFiles(parseDb(tablet), parseDb(phone));
  const ba = mergeDbFiles(parseDb(phone), parseDb(tablet));
  assert.equal(ab.settings.profiles.p1.openFullscreen.v, false,
    'the later parental answer lost — the flag does not really sync');
  assert.equal(ab.settings.profiles.p2.openFullscreen.v, true,
    'one child\'s flag leaked onto the sibling — the setting is not per profile');
  assert.deepEqual(ab.settings, ba.settings, 'order-dependent — two devices never converge');
  // an exact tie keeps today's fullscreen (the SAFE_ON_TIE direction), in both orders
  const tieA = serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: {}, profiles: { p1: { openFullscreen: { v: true, at: 300 } } } } });
  const tieB = serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: {}, profiles: { p1: { openFullscreen: { v: false, at: 300 } } } } });
  assert.equal(mergeDbFiles(parseDb(tieA), parseDb(tieB)).settings.profiles.p1.openFullscreen.v, true);
  assert.equal(mergeDbFiles(parseDb(tieB), parseDb(tieA)).settings.profiles.p1.openFullscreen.v, true);
});

test('a doc from an OLDER app (no settings key) does not wipe ours', () => {
  // The rollout case: a device still on v1.0.24 pushes a document with no `settings` at
  // all. Reading that as "the family cleared everything" would unlock a locked tablet and
  // erase the parent PIN for the whole account.
  const mine = parseDb(serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: { pin: { v: 'keep', at: 5 } }, profiles: {} } }));
  const legacy = parseDb(JSON.stringify({ kind: 'kids-player-db', schema: 1, libraries: {}, profiles: [] }));
  assert.equal(legacy.settings, undefined, 'the fixture is not actually a legacy doc');
  assert.equal(mergeDbFiles(mine, legacy).settings.account.pin.v, 'keep');
  assert.equal(mergeDbFiles(legacy, mine).settings.account.pin.v, 'keep');
});

test('the settings channel carries NO secret the refusal list bans', () => {
  // drive.js has an explicit never-serialize list (localPath, thumbs, cursors, the API
  // key). A new top-level key is exactly where one would get swept back in.
  const d = doc({ account: { pin: { v: 'h', at: 1 } }, profiles: { p1: { exitLock: { v: true, at: 1 } } } });
  const wire = JSON.stringify(d);
  for (const banned of ['yt:apiKey', 'localPath', 'thumbId', 'backfillCursor', 'dbFileId']) {
    assert.ok(!wire.includes(banned), `the document carries ${banned}`);
  }
});

/* ---------------- profileVideoState ⇄ Drive (v1.0.32) ---------------- */

test('the playback position NEVER travels to Drive', () => {
  // It changes every few seconds of watching — pushing it would rewrite the family
  // document on every pause (the giftRank lesson). A record carrying ONLY a position
  // contributes NOTHING, not an empty object the apply side must skip.
  assert.equal(serializeStateEntry({ posSec: 61, durSec: 300, posAt: 5 }), null);
  // …and a real gift/unwrap entry must not smuggle the position along
  assert.deepEqual(serializeStateEntry({ unwrappedAt: 9, posSec: 61, durSec: 300 }),
    { unwrappedAt: 9 });
  assert.deepEqual(serializeStateEntry({ giftRank: 3, posSec: 61 }), { giftRank: 3 });
  // rank 0 is a valid rank, not "no rank"
  assert.deepEqual(serializeStateEntry({ giftRank: 0 }), { giftRank: 0 });
  assert.equal(serializeStateEntry(null), null);
  assert.equal(serializeStateEntry({}), null);
});

test('applying a remote unwrap PRESERVES the local playback position', () => {
  // The old shape was a blind put({profileId, key, unwrappedAt}) — it erased the local
  // record wholesale, so every pull threw away where the child stopped.
  assert.deepEqual(
    mergeAppliedState({ posSec: 61, durSec: 300, posAt: 5, giftRank: 2 }, { unwrappedAt: 9 }),
    { unwrappedAt: 9, posSec: 61, durSec: 300, posAt: 5 });
  // giftRank is deliberately DROPPED once unwrapped — db.unwrapGift semantics
  assert.equal(mergeAppliedState({ giftRank: 2 }, { unwrappedAt: 9 }).giftRank, undefined);
  // unwrappedAt is min-merged: the EARLIEST open wins ("unwrappedAt is forever")
  assert.equal(mergeAppliedState({ unwrappedAt: 4 }, { unwrappedAt: 9 }).unwrappedAt, 4);
  assert.equal(mergeAppliedState({ unwrappedAt: 9 }, { unwrappedAt: 4 }).unwrappedAt, 4);
  // a remote giftRank applies NOTHING (remote-only rule, unchanged since v1.0.4)
  assert.equal(mergeAppliedState(null, { giftRank: 5 }), null);
  assert.equal(mergeAppliedState({ posSec: 61 }, { giftRank: 5 }), null);
  assert.equal(mergeAppliedState({ posSec: 61 }, {}), null);
  // a fresh device (no local record) simply adopts the unwrap
  assert.deepEqual(mergeAppliedState(null, { unwrappedAt: 9 }), { unwrappedAt: 9 });
});

test('the 🕒 watch stamp is DEVICE-LOCAL, in both directions (v1.0.57)', () => {
  // The user's decision 2026-08-30: "נצפה לאחרונה" is about the tablet in the child's
  // hands, like the resume position and unlike ⭐. Two halves, and BOTH are load-bearing.
  // OUT: it never reaches the document — a stamp per video watched would rewrite the
  // family doc all afternoon, the exact churn the position is kept out for.
  assert.equal(serializeStateEntry({ playedAt: 7 }), null);
  assert.deepEqual(serializeStateEntry({ unwrappedAt: 9, playedAt: 7 }), { unwrappedAt: 9 });
  assert.deepEqual(serializeStateEntry({ favAt: 4, playedAt: 7 }), { favAt: 4 });
  // IN: the fold REPLACES the local row, so a field the remote cannot carry is a field the
  // pull would erase. Without this line every pull emptied 🕒 on the tablet for any video
  // the phone had touched — silently, and only on the devices that actually sync.
  assert.deepEqual(
    mergeAppliedState({ playedAt: 7, posSec: 61 }, { unwrappedAt: 9 }),
    { unwrappedAt: 9, posSec: 61, playedAt: 7 });
  assert.equal(mergeAppliedState({ playedAt: 7 }, { favAt: 3 }).playedAt, 7);
  // a stamp alone still contributes nothing to apply — there is no remote half to fold
  assert.equal(mergeAppliedState({ playedAt: 7 }, {}), null);
});

/* ---------------- channel-deletion tombstones (v1.0.36) ---------------- */
// Deleting a subscription used to be pure row ABSENCE, and a union can only ever ADD —
// so any peer (or stale doc) still holding the row re-subscribed the family to the
// exact channel the parent threw out (field report: "the channel comes back").

const chRow = (channelId, over = {}) => ({
  libraryId: 'lib:x', channelId, autoApprove: false, addedAt: 100, updatedAt: 100, ...over
});
const chDoc = (libraryChannels, deletedChannels) => ({
  kind: 'kids-player-db', schema: 1, exportedAt: 1000, profiles: [],
  libraries: {
    'lib:x': {
      sheetUrl: null, videos: [], denylist: [], channels: [], libraryChannels,
      ...(deletedChannels !== undefined ? { deletedChannels } : {})
    }
  },
  profileState: {}, profileSources: {}
});

test('a deleted channel stays deleted through the union — both merge orders (v1.0.36)', () => {
  const a = chDoc([], { UC1: 200 });                    // this device deleted it at 200
  const b = chDoc([chRow('UC1', { updatedAt: 150 })]);  // stale peer (OLDER APP: no deletedChannels key at all)
  for (const [x, y] of [[a, b], [b, a]]) {
    const m = mergeDbFiles(x, y);
    assert.equal(m.libraries['lib:x'].libraryChannels.length, 0,
      'the stale row survived the union — the deletion undoes itself on the next pull');
    assert.equal(m.libraries['lib:x'].deletedChannels.UC1, 200,
      'the tombstone must travel in the merged doc, or the THIRD device resurrects');
  }
});

test('a deliberate RE-ADD outlives the tombstone; a TIE deletes (v1.0.36)', () => {
  const del = chDoc([], { UC1: 200 });
  const readd = chDoc([chRow('UC1', { updatedAt: 300 })], {});
  for (const [x, y] of [[del, readd], [readd, del]]) {
    assert.equal(mergeDbFiles(x, y).libraries['lib:x'].libraryChannels.length, 1,
      'a re-add (fresh putLibraryChannel stamp) was eaten by an older tombstone');
  }
  // tie → deleted: resurrecting a deleted channel is the betrayal, re-hiding a
  // re-added one is a complaint (the resolveCuration tie rule).
  assert.equal(channelOutlivesTombstone({ updatedAt: 200 }, 200), false);
  assert.equal(channelOutlivesTombstone({ updatedAt: 201 }, 200), true);
  assert.equal(channelOutlivesTombstone({}, 0), false, 'a timeless row must lose to any real event');
});

test('docs from an OLDER APP (no deletedChannels key) merge exactly as before (v1.0.36)', () => {
  const m = mergeDbFiles(chDoc([chRow('UC1')]), chDoc([chRow('UC2')]));
  assert.equal(m.libraries['lib:x'].libraryChannels.length, 2,
    'a missing tombstone map must never read as "everything was deleted"');
  assert.deepEqual(m.libraries['lib:x'].deletedChannels, {});
});

test('tombstone map merge: LATEST deletion wins, commutative, idempotent, garbage-safe (v1.0.36)', () => {
  // Unlike deletedProfiles (min-merge, ids never reused): a channel can be re-added and
  // deleted AGAIN, so the newest event must win everywhere.
  assert.deepEqual(mergeDeletedChannels({ UC1: 100 }, { UC1: 300, UC2: 50 }), { UC1: 300, UC2: 50 });
  assert.deepEqual(mergeDeletedChannels({ UC1: 300, UC2: 50 }, { UC1: 100 }), { UC1: 300, UC2: 50 });
  assert.deepEqual(mergeDeletedChannels({ UC1: 100 }, { UC1: 100 }), { UC1: 100 });
  assert.deepEqual(mergeDeletedChannels(null, undefined), {});
  assert.deepEqual(mergeDeletedChannels({ UC1: 'garbage' }, null), { UC1: 0 },
    'a timeless tombstone must lose to any real re-add, never explode');
});

test('the whole-doc merge stays idempotent with tombstones: merge(m, m) ≡ m (v1.0.36)', () => {
  const m = mergeDbFiles(chDoc([], { UC1: 200 }), chDoc([chRow('UC1', { updatedAt: 150 })]));
  const again = mergeDbFiles(m, m);
  assert.deepEqual(again.libraries['lib:x'].libraryChannels, m.libraries['lib:x'].libraryChannels);
  assert.deepEqual(again.libraries['lib:x'].deletedChannels, m.libraries['lib:x'].deletedChannels);
});

test('planChannelApply: a STALE remote doc cannot resurrect, and local losers go (v1.0.36)', () => {
  // pullDrive applies the RAW remote doc (never pre-merged) — this is the pull half.
  const plan = planChannelApply({
    localRows: [chRow('UC2', { updatedAt: 100 })],  // the peer deleted this at 250
    remoteRows: [chRow('UC1', { updatedAt: 150 })], // deleted HERE at 200, doc predates it
    localTombs: { UC1: 200 },
    remoteTombs: { UC2: 250 }
  });
  assert.deepEqual(plan.tombs, { UC1: 200, UC2: 250 });
  assert.equal(plan.puts.length, 0, 'a stale remote row was re-put — the pull path resurrects again');
  assert.deepEqual(plan.deletes, ['UC2'], 'the peer\'s deletion never landed locally');
  // the re-add direction: a remote row NEWER than the tombstone is applied
  const readd = planChannelApply({
    localRows: [], remoteRows: [chRow('UC1', { updatedAt: 300 })],
    localTombs: { UC1: 200 }, remoteTombs: {}
  });
  assert.equal(readd.puts.length, 1);
  assert.equal(readd.deletes.length, 0);
});

test('serializeDb carries the per-library deletedChannels map (v1.0.36)', () => {
  const doc = JSON.parse(serializeDb({
    profiles: [], profileState: {}, profileSources: {},
    libraries: { 'lib:x': { videos: [], denylist: [], channels: [], libraryChannels: [], deletedChannels: { UC1: 200 } } }
  }));
  assert.deepEqual(doc.libraries['lib:x'].deletedChannels, { UC1: 200 });
});

/* ---------------- the scope travels with the profile (v1.0.38) ---------------- */

test('resolveRestoredLibraryId: the compatibility ladder, and NEVER null', () => {
  // A new document says the scope outright.
  assert.equal(resolveRestoredLibraryId({ ps: { libraryId: 'lib:abc123', sheetUrl: null }, profileId: 'p1' }), 'lib:abc123');
  // An OLD document (no libraryId) must reproduce the pre-v1.0.38 answer bit for bit, or a
  // restore from a pre-upgrade backup lands on a scope that disagrees with the doc.
  const url = 'https://docs.google.com/spreadsheets/d/SHEETID/edit';
  const fromSheet = resolveRestoredLibraryId({ ps: { sheetUrl: url }, profileId: 'p1' });
  assert.match(fromSheet, /^lib:[0-9a-f]+$/, `expected a hashed scope, got ${fromSheet}`);
  assert.equal(resolveRestoredLibraryId({ ps: { sheetUrl: url, libraryId: 'lib:wins' }, profileId: 'p1' }), 'lib:wins',
    'an explicit libraryId must outrank the derived one');
  // Neither: the same answer ensureSources gives. Returning null would let the caller mint a
  // scope the document does not describe.
  assert.equal(resolveRestoredLibraryId({ ps: {}, profileId: 'p9' }), 'lib:p:p9');
  assert.equal(resolveRestoredLibraryId({ ps: null, profileId: 'p9' }), 'lib:p:p9');
  assert.equal(resolveRestoredLibraryId({}), 'lib:p:');
  assert.equal(resolveRestoredLibraryId(), 'lib:p:');
});

test('restoreScopeCorrection: unwinds a wrongly-minted lib:p: scope, never an established one (v1.0.80)', () => {
  // THE FIELD BUG: a wipe cleared IndexedDB AND signed the app out of Google, so the launch
  // pull returned no-token while the home still rendered — ensureSources minted `lib:p:<pid>`,
  // and the later pull's `getSources → continue` refused to write the REAL scope the backup
  // carries. Videos under `lib:<hash>`, profile pointing at an empty `lib:p:<pid>`.
  const pid = 'pms8usgfosmhf';
  // the repair: local is the auto-mint default, the doc names the real legacy hash → repoint.
  assert.equal(
    restoreScopeCorrection({ existing: { libraryId: 'lib:p:' + pid }, ps: { libraryId: 'lib:455f348c' }, profileId: pid }),
    'lib:455f348c');
  // an OLD doc (sheetUrl, no libraryId) resolves through the ladder and still repoints.
  const fixed = restoreScopeCorrection({ existing: { libraryId: 'lib:p:' + pid }, ps: { sheetUrl: 'https://docs.google.com/spreadsheets/d/S/edit' }, profileId: pid });
  assert.match(fixed, /^lib:[0-9a-f]+$/);

  // NEVER touches an established scope:
  //  • a legitimately lib:p: profile (v1.0.38+, the doc names the same) — no change.
  assert.equal(restoreScopeCorrection({ existing: { libraryId: 'lib:p:' + pid }, ps: { libraryId: 'lib:p:' + pid }, profileId: pid }), null);
  assert.equal(restoreScopeCorrection({ existing: { libraryId: 'lib:p:' + pid }, ps: {}, profileId: pid }), null);
  //  • a scope already correct (a real legacy hash locally) — no change, even if the doc differs.
  assert.equal(restoreScopeCorrection({ existing: { libraryId: 'lib:455f348c' }, ps: { libraryId: 'lib:455f348c' }, profileId: pid }), null);
  assert.equal(restoreScopeCorrection({ existing: { libraryId: 'lib:deadbeef' }, ps: { libraryId: 'lib:455f348c' }, profileId: pid }), null,
    'a non-default local scope is NEVER overwritten — only the auto-mint default is a mistake');
  //  • no local record at all → null (the fresh-restore branch owns that case).
  assert.equal(restoreScopeCorrection({ existing: null, ps: { libraryId: 'lib:455f348c' }, profileId: pid }), null);
  assert.equal(restoreScopeCorrection(), null);
});

test('a provisional (updatedAt 0) profileSources mint cannot overwrite a real mapping (v1.0.81)', () => {
  // THE FIELD CORRUPTION: a signed-out launch made ensureSources mint `lib:p:<pid>`, and the
  // next push LWW-overwrote the backup's REAL `lib:<hash>` mapping — so every device (even a
  // fresh reinstall) then read the profile as pointing at an empty scope. The fix mints the
  // provisional scope with updatedAt 0, so a real mapping (any positive updatedAt) always wins
  // the merge, in BOTH orders. This is the merge-layer half of the guard.
  const pid = 'pms8usgfosmhf';
  const doc = (libraryId, updatedAt) => ({
    kind: 'kids-player-db', schema: 1, exportedAt: 1, profiles: [], profileState: {}, libraries: {},
    profileSources: { [pid]: { libraryId, sheetUrl: null, updatedAt } }
  });
  const real = doc('lib:455f348c', 1786600520857);
  const provisional = doc('lib:p:' + pid, 0);
  assert.equal(mergeDbFiles(real, provisional).profileSources[pid].libraryId, 'lib:455f348c');
  assert.equal(mergeDbFiles(provisional, real).profileSources[pid].libraryId, 'lib:455f348c',
    'the provisional mint won the LWW merge and would corrupt the backup map');
});

test('profileSources carries the SCOPE, and a migrated entry keeps sheetUrl falsy', () => {
  // THE COMPATIBILITY HINGE: a v1.0.37 device's own `if (!ps.sheetUrl) continue` guard is what
  // makes the new document harmless to it. That only holds while a migrated entry's sheetUrl
  // is NULL — an '' would still be falsy, but a 'none'/'-' sentinel would not, and the old
  // app would then derive a scope from garbage. This test exists to stop that "improvement".
  const json = serializeDb({
    profiles: [], libraries: {}, profileState: {},
    profileSources: { p1: { libraryId: 'lib:abc', sheetUrl: null, updatedAt: 7 } }
  });
  const back = parseDb(json).profileSources.p1;
  assert.equal(back.libraryId, 'lib:abc');
  assert.ok(!back.sheetUrl, 'a migrated entry must present a FALSY sheetUrl to older readers');
  assert.equal(back.sheetUrl, null, 'and specifically null — never a sentinel an old app reads as truthy');
});

test('the forget CONVERGES against a peer still on the old app, in both orders', () => {
  // The un-migrated phone keeps pushing {sheetUrl, updatedAt:<old>}; the migrated tablet
  // pushes {libraryId, sheetUrl:null, updatedAt:<fresh>}. Whole-object LWW must land on
  // "no sheet" whichever document is read first, or the two devices ping-pong forever.
  const oldPeer = { kind: 'kids-player-db', libraries: {},
    profileSources: { p1: { sheetUrl: 'https://docs.google.com/spreadsheets/d/S/edit', updatedAt: 100 } } };
  const migrated = { kind: 'kids-player-db', libraries: {},
    profileSources: { p1: { libraryId: 'lib:abc', sheetUrl: null, updatedAt: 900 } } };
  for (const [a, b] of [[oldPeer, migrated], [migrated, oldPeer]]) {
    const m = mergeDbFiles(a, b);
    assert.equal(m.profileSources.p1.libraryId, 'lib:abc');
    assert.ok(!m.profileSources.p1.sheetUrl, 'the sheet came back from the old peer');
  }
  // idempotent, like every other merge here
  const once = mergeDbFiles(oldPeer, migrated);
  assert.deepEqual(mergeDbFiles(once, once).profileSources, once.profileSources);
  // …and the scope survives the round trip through the document
  assert.equal(parseDb(serializeDb({ profiles: [], libraries: {}, profileState: {},
    profileSources: once.profileSources })).profileSources.p1.libraryId, 'lib:abc');
});

/* ---------------- favourites travel (v1.0.40) ---------------- */
// TWO functions would have dropped a ⭐ in silence, and the feature would have looked
// device-local: serializeStateEntry was an if/return chain ("whichever field wins"), and
// mergeAppliedState returned null unless the REMOTE carried an unwrap.

test('serializeStateEntry carries the favourite alongside a gift/unwrap (v1.0.40)', () => {
  // the common case: the child stars a video they have already opened
  assert.deepEqual(serializeStateEntry({ unwrappedAt: 5, favAt: 9 }), { unwrappedAt: 5, favAt: 9 });
  assert.deepEqual(serializeStateEntry({ giftRank: 3, favAt: 9 }), { giftRank: 3, favAt: 9 });
  // favourite-only entries travel on their own
  assert.deepEqual(serializeStateEntry({ favAt: 9 }), { favAt: 9 });
  // and so does the REMOVAL — otherwise a peer's stale copy re-stars it
  assert.deepEqual(serializeStateEntry({ favAt: 9, favOffAt: 20 }), { favAt: 9, favOffAt: 20 });
  // the position still never travels (v1.0.32), and an empty entry is still nothing
  assert.deepEqual(serializeStateEntry({ posSec: 42, durSec: 100 }), null);
  assert.equal(serializeStateEntry(null), null);
});

test('mergeAppliedState applies a favourite-only remote, and keeps local state (v1.0.40)', () => {
  // a ⭐ added on the phone must land on the tablet's pull
  const applied = mergeAppliedState(null, { favAt: 100 });
  assert.equal(applied.favAt, 100);
  // the local playback position and gift rank survive the fold
  const keep = mergeAppliedState({ posSec: 42, durSec: 90, giftRank: 4 }, { favAt: 100 });
  assert.equal(keep.posSec, 42);
  assert.equal(keep.giftRank, 4, 'a device-local gift rank was dropped by a favourite-only fold');
  // an UN-star from the peer wins over the local star (later event)
  const off = mergeAppliedState({ favAt: 100 }, { favAt: 100, favOffAt: 300 });
  assert.equal(off.favOffAt, 300);
  // …and unwrappedAt keeps its min-merge, with the star riding along
  const both = mergeAppliedState({ unwrappedAt: 50, favAt: 10 }, { unwrappedAt: 20, favAt: 70 });
  assert.equal(both.unwrappedAt, 20, 'the EARLIEST open must still win');
  assert.equal(both.favAt, 70);
  // nothing to apply is still nothing
  assert.equal(mergeAppliedState({ posSec: 5 }, { posSec: 9 }), null);
  assert.equal(mergeAppliedState(null, null), null);
});

/* ================= approved websites (v1.0.45) =================
   The libraryChannels tombstone block, mirrored. Each property gets its own test and
   each runs BOTH argument orders inline rather than leaning on the whole-doc
   commutativity test above — that is what let the autoApprove bug survive: the shared
   fixtures carry timestamps, so they pinned the fixture and not the production path. */

const sc = (id, over = {}) => ({
  entryId: id, kind: 'shortcut', url: 'https://a.com/kids/', title: 'א',
  order: 0, addedAt: 100, updatedAt: 100, ...over
});
const rl = (id, over = {}) => ({
  entryId: id, kind: 'rule', display: 'https://a.com/kids/', host: 'a.com', port: 443,
  segments: ['kids'], allowExternal: false, order: 1, addedAt: 100, updatedAt: 100, ...over
});

test('mergeSiteEntry: later write wins, and it CONVERGES with no timestamps at all', () => {
  const older = sc('sc:1', { title: 'ישן', updatedAt: 10 });
  const newer = sc('sc:1', { title: 'חדש', updatedAt: 20 });
  assert.equal(mergeSiteEntry(older, newer).title, 'חדש');
  assert.equal(mergeSiteEntry(newer, older).title, 'חדש');

  // The autoApprove trap, replayed: two rows nobody ever stamped. Without a deterministic
  // tie-break both sides compare 0 > 0 and the FIRST argument wins, so merge(a,b) and
  // merge(b,a) disagree — the documented commutativity would simply be false.
  const loose = rl('rl:1', { allowExternal: true, updatedAt: 0 });
  const strict = rl('rl:1', { allowExternal: false, updatedAt: 0 });
  assert.equal(mergeSiteEntry(loose, strict).allowExternal, false);
  assert.equal(mergeSiteEntry(strict, loose).allowExternal, false,
    'a tie must resolve the SAFE way — and identically in both orders');

  assert.equal(mergeSiteEntry(null, strict), strict);
  assert.equal(mergeSiteEntry(strict, null), strict);
});

test('mergeDeletedSiteEntries: latest deletion wins, commutative, idempotent, garbage-safe', () => {
  const a = { 'sc:1': 100, 'sc:2': 50 };
  const b = { 'sc:1': 200, 'sc:3': 70 };
  const want = { 'sc:1': 200, 'sc:2': 50, 'sc:3': 70 };
  assert.deepEqual(mergeDeletedSiteEntries(a, b), want);
  assert.deepEqual(mergeDeletedSiteEntries(b, a), want);
  assert.deepEqual(mergeDeletedSiteEntries(want, want), want);
  assert.deepEqual(mergeDeletedSiteEntries({ 'sc:1': 'junk' }, null), { 'sc:1': 0 });
  assert.deepEqual(mergeDeletedSiteEntries(null, undefined), {});
});

test('siteEntryOutlivesTombstone: a deliberate re-add wins, a TIE stays deleted', () => {
  assert.equal(siteEntryOutlivesTombstone(sc('sc:1', { updatedAt: 200 }), 100), true);
  assert.equal(siteEntryOutlivesTombstone(sc('sc:1', { updatedAt: 100 }), 100), false,
    'a tie must delete — showing a removed site is the betrayal');
  assert.equal(siteEntryOutlivesTombstone(sc('sc:1', { updatedAt: 50 }), 100), false);
  assert.equal(siteEntryOutlivesTombstone(null, 100), false);
  assert.equal(siteEntryOutlivesTombstone(sc('sc:1', { updatedAt: 1 }), 'junk'), true);
});

test('a removed site STAYS removed through the union — in both merge orders', () => {
  const withRow = {
    kind: 'kids-player-db', schema: 1, profiles: [],
    libraries: { 'prof:p1': { videos: [], denylist: [], channels: [], libraryChannels: [], siteEntries: [sc('sc:1', { updatedAt: 100 })], deletedSiteEntries: {} } },
    profileState: {}
  };
  const withTomb = {
    kind: 'kids-player-db', schema: 1, profiles: [],
    libraries: { 'prof:p1': { videos: [], denylist: [], channels: [], libraryChannels: [], siteEntries: [], deletedSiteEntries: { 'sc:1': 150 } } },
    profileState: {}
  };
  for (const [x, y] of [[withRow, withTomb], [withTomb, withRow]]) {
    const m = mergeDbFiles(x, y);
    assert.deepEqual(m.libraries['prof:p1'].siteEntries, [],
      'the peer that had not pulled yet re-injected the removed site');
    assert.equal(m.libraries['prof:p1'].deletedSiteEntries['sc:1'], 150);
  }
});

test('a deliberate RE-ADD outlives the tombstone, in both merge orders', () => {
  const readd = {
    kind: 'kids-player-db', schema: 1, profiles: [],
    libraries: { 'prof:p1': { videos: [], denylist: [], channels: [], libraryChannels: [], siteEntries: [sc('sc:1', { updatedAt: 300 })], deletedSiteEntries: {} } },
    profileState: {}
  };
  const tomb = {
    kind: 'kids-player-db', schema: 1, profiles: [],
    libraries: { 'prof:p1': { videos: [], denylist: [], channels: [], libraryChannels: [], siteEntries: [], deletedSiteEntries: { 'sc:1': 150 } } },
    profileState: {}
  };
  for (const [x, y] of [[readd, tomb], [tomb, readd]]) {
    assert.equal(mergeDbFiles(x, y).libraries['prof:p1'].siteEntries.length, 1);
  }
});

test('a doc from an OLDER app (no site keys) merges exactly as before', () => {
  const old = {
    kind: 'kids-player-db', schema: 1, profiles: [],
    libraries: { 'prof:p1': { videos: [], denylist: [], channels: [], libraryChannels: [] } },
    profileState: {}
  };
  const fresh = {
    kind: 'kids-player-db', schema: 1, profiles: [],
    libraries: { 'prof:p1': { videos: [], denylist: [], channels: [], libraryChannels: [], siteEntries: [sc('sc:1')], deletedSiteEntries: {} } },
    profileState: {}
  };
  for (const [x, y] of [[old, fresh], [fresh, old]]) {
    const lib = mergeDbFiles(x, y).libraries['prof:p1'];
    assert.equal(lib.siteEntries.length, 1, 'a missing key filters nothing and loses nothing');
    assert.deepEqual(lib.deletedSiteEntries, {});
  }
});

test('planSiteApply: a stale doc cannot resurrect, and local losers go', () => {
  const plan = planSiteApply({
    localRows: [sc('sc:1', { updatedAt: 100 }), sc('sc:2', { updatedAt: 100 })],
    remoteRows: [sc('sc:1', { updatedAt: 100 })], // the stale peer still carries it
    localTombs: { 'sc:1': 150 },
    remoteTombs: {}
  });
  assert.deepEqual(plan.puts, [], 'the remote row lost to our tombstone');
  assert.deepEqual(plan.deletes, ['sc:1'], 'and the local copy must go too');
  assert.equal(plan.tombs['sc:1'], 150);

  const back = planSiteApply({
    localRows: [], remoteRows: [sc('sc:9', { updatedAt: 500 })],
    localTombs: { 'sc:9': 100 }, remoteTombs: {}
  });
  assert.equal(back.puts.length, 1, 'a re-add newer than the tombstone must be adopted');

  const empty = planSiteApply({});
  assert.deepEqual(empty.puts, []);
  assert.deepEqual(empty.deletes, []);
  assert.deepEqual(empty.tombs, {});
});

test('serializeDb carries the site entries and their tombstones', () => {
  const doc = JSON.parse(serializeDb({
    profiles: [], profileState: {}, profileSources: {}, settings: null, deletedProfiles: {},
    libraries: { 'prof:p1': { videos: [], denylist: [], channels: [], libraryChannels: [], siteEntries: [sc('sc:1')], deletedSiteEntries: { 'sc:9': 42 } } }
  }));
  assert.equal(doc.libraries['prof:p1'].siteEntries.length, 1);
  assert.deepEqual(doc.libraries['prof:p1'].deletedSiteEntries, { 'sc:9': 42 });
  // A library that has never had a site must still emit the keys, so a merge reads
  // "none" rather than "unknown".
  const bare = JSON.parse(serializeDb({
    profiles: [], profileState: {}, profileSources: {}, settings: null, deletedProfiles: {},
    libraries: { 'lib:x': { videos: [], denylist: [], channels: [], libraryChannels: [] } }
  }));
  assert.deepEqual(bare.libraries['lib:x'].siteEntries, []);
  assert.deepEqual(bare.libraries['lib:x'].deletedSiteEntries, {});
});
