// v1.0.94 — "the folder vanished from the child's home" (field report 2026-10-05).
//
// THE ROOT CAUSE: drive.serializeDb — the function every push runs the local document
// through — never carried parent-made folders. The VIDEOS travelled, each still naming its
// `cf:` folder; the folder ROWS stayed on the one device that made them. The family's own
// backup showed it twice (September and October): 751 songs filed under 32 folders, zero
// folder rows. A restore, a second device, or that device losing its local data all ended
// with the songs present and no tile on the home.
//
// Fixing the rows alone would have created a NEW instance of the same bug: folder deletion
// tombstones would start travelling while a "keep its videos" MOVE still could not (the
// record merge kept each device's own copy on a tie). So placement became last-placement-
// wins (`placedAt`), and the apply side stopped letting a stale pull revert a newer row.
// Then the repair: a lost folder comes back under its ORIGINAL id, as a placeholder that stays
// on the device that rebuilt it, and pasting the Drive link again turns that placeholder back
// into the real folder IN PLACE — no song moves, nothing is swept, no tombstone is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeDb, parseDb, mergeDbFiles, mergeCustomFolder, planCustomFolderApply, planSiteApply,
  planChannelApply, newerRemoteRows, mergeLibraryChannel, travellingFolderRows, customFolderForApply
} from '../www/js/drive.js';
import { mergeVideoRecord, mergeVideoCopies, settlePlacement, homeOf, placeInto } from '../www/js/normalize.js';
import {
  placeholderFolderTitle, planOrphanFolderRepair, planDriveRefile, planDriveFolderImport,
  planDriveTreeImport, driveFolderOutcome, manualVideoRecord, planEmptyFolderSweep,
  refileEligible, pickPlaceholderToAdopt, FOLDER_TITLE_MAX
} from '../www/js/plan.js';

const LIB = 'lib:0a1b2c3d';
const song = (id, over = {}) => ({
  scopeId: LIB, key: 'file:drive:' + id, type: 'file', id: null, driveId: id,
  srcUrl: `https://drive.google.com/file/d/${id}/view`, title: 'שיר ' + id, media: 'audio',
  folderId: 'cf:disc1', channelId: null, state: 'live', addedAt: 1000, approvedAt: 1000,
  sortKey: 5, updatedAt: 1000, ...over
});
const row = (folderId, over = {}) => ({
  scopeId: LIB, folderId, title: 'דיסק', emoji: '📂', artThumbId: null, artSrcUrl: null,
  driveFolderId: null, driveRootId: null, parentFolderId: null, order: 1, createdAt: 1,
  updatedAt: 100, ...over
});
const libOf = (over = {}) => ({
  sheetUrl: null, videos: [], denylist: [], channels: [], libraryChannels: [], deletedChannels: {},
  siteEntries: [], deletedSiteEntries: {}, customFolders: [], deletedCustomFolders: {}, ...over
});
const docOf = (libs) => ({
  kind: 'kids-player-db', schema: 1, exportedAt: 1, profiles: [], libraries: libs,
  profileState: {}, profileSources: {}, settings: { account: {}, profiles: {} }, deletedProfiles: {}
});

/* ==================== the root cause ==================== */

test('ROOT CAUSE: a pushed document CARRIES the folder rows and their tombstones (v1.0.94)', () => {
  const local = {
    libraries: {
      [LIB]: libOf({
        videos: [song('a'), song('b')],
        customFolders: [row('cf:disc1', { title: 'אנא בכח', driveFolderId: 'DRIVE1' })],
        deletedCustomFolders: { 'cf:gone': 50 }
      })
    }
  };
  // EXACTLY what pushDrive does before it merges or uploads
  const pushed = parseDb(serializeDb(local));
  const lib = pushed.libraries[LIB];
  assert.deepEqual((lib.customFolders || []).map((r) => r.folderId), ['cf:disc1'],
    'the folder row never reached Drive — every other device gets the songs and no folder');
  assert.equal(((lib.customFolders || [])[0] || {}).driveFolderId, 'DRIVE1', 'a Drive folder must keep its link, or it can never refresh');
  assert.deepEqual(lib.deletedCustomFolders, { 'cf:gone': 50 }, 'a folder deletion never reached the other devices');
  // …and it SURVIVES the merge against a backup that never had it (the family's backup)
  const remote = docOf({ [LIB]: libOf({ videos: [song('a'), song('b')] }) });
  const merged = mergeDbFiles(pushed, remote);
  assert.deepEqual(merged.libraries[LIB].customFolders.map((r) => r.folderId), ['cf:disc1']);
});

test('every collection the merge emits per library survives serializeDb — the next one cannot be forgotten (v1.0.94)', () => {
  // The bug was an OMISSION: v1.0.56 taught the merge and the apply about folders and never
  // added them to the serializer's whitelist. Pin the SHAPE, so a collection added to the
  // merge in the future fails here until the serializer carries it too.
  const full = docOf({ [LIB]: libOf({ videos: [song('a')], customFolders: [row('cf:x')] }) });
  const mergedKeys = Object.keys(mergeDbFiles(full, full).libraries[LIB]).sort();
  const serializedKeys = Object.keys(parseDb(serializeDb(full)).libraries[LIB]).sort();
  for (const k of mergedKeys) {
    assert.ok(serializedKeys.includes(k), `serializeDb drops "${k}" — it would never reach Drive`);
  }
});

test('a rebuilt PLACEHOLDER never leaves the device that rebuilt it; the refresh stamp never travels (v1.0.94)', () => {
  // An app before v1.0.94 puts every remote folder row over its own, whatever its age — so a
  // device still holding the REAL folder (on an app that has not updated yet) would have its
  // name, its place in the tree and its Drive link replaced by a guess. Each device rebuilds
  // its own placeholder under the same id instead; naming it, or the Drive link, makes it real.
  const real = row('cf:real', { driveFolderId: 'D1', driveSyncedAt: 777 });
  const guess = row('cf:guess', { placeholder: true });
  const named = row('cf:named', { placeholder: false });
  const out = parseDb(serializeDb({ libraries: { [LIB]: libOf({ customFolders: [real, guess, named] }) } }))
    .libraries[LIB].customFolders;
  assert.deepEqual(out.map((r) => r.folderId), ['cf:real', 'cf:named'], 'a guess must not travel; a named folder must');
  assert.equal('driveSyncedAt' in out[0], false, "a peer's refresh stamp would silence this device's own refresh");
  assert.equal(out[0].driveFolderId, 'D1', 'the Drive link travels — it is what restores the folder elsewhere');
  assert.deepEqual(travellingFolderRows(null), []);
});

test("applying a remote folder keeps THIS device's refresh stamp, and never inherits \"placeholder\" (v1.0.94)", () => {
  const mine = row('cf:x', { title: 'ניחוש', placeholder: true, driveSyncedAt: 555 });
  const remote = row('cf:x', { title: 'השם האמיתי', driveFolderId: 'D1', updatedAt: 900 });
  const out = customFolderForApply(mine, remote);
  assert.equal(out.title, 'השם האמיתי');
  assert.equal(out.placeholder, undefined, 'a real row replacing a placeholder must not stay a "guess"');
  assert.equal(out.driveSyncedAt, 555, "this device's refresh throttle must survive a pull");
  assert.equal(customFolderForApply(null, { ...remote, driveSyncedAt: 1 }).driveSyncedAt, undefined,
    "a peer's stamp is never adopted");
});

test('device-local fields never travel: localPath, thumbId and the cache-use stamp (v1.0.94)', () => {
  const v = song('a', { localPath: '/data/x.mp3', thumbId: 'thumb:a', localUsedAt: 12345 });
  const out = parseDb(serializeDb({ libraries: { [LIB]: libOf({ videos: [v] }) } })).libraries[LIB].videos[0];
  assert.equal('localPath' in out, false);
  assert.equal('thumbId' in out, false);
  assert.equal('localUsedAt' in out, false,
    "the cache prune's clock travelled — a peer's stamp makes a file look freshly played");
  assert.equal(out.key, v.key, 'and the record itself still travels');
});

/* ==================== placement: the later deliberate placement wins ==================== */

test('homeOf reads a parked record by its home folder', () => {
  assert.equal(homeOf({ folderId: 'cf:a' }), 'cf:a');
  assert.equal(homeOf({ folderId: '~pending', homeFolderId: 'cf:a' }), 'cf:a');
  assert.equal(homeOf({ folderId: '~rejected', homeFolderId: 'sheet' }), 'sheet');
  assert.equal(homeOf({ folderId: '~pending' }), null);
  assert.equal(homeOf(null), null);
});

test('LEGACY records (no placedAt on either copy) merge exactly as before (v1.0.94)', () => {
  // channel videos and everything written before this release: untouched behaviour
  const a = song('a', { folderId: 'cf:one', addedAt: 1000 });
  const b = song('a', { folderId: 'cf:two', addedAt: 2000 });
  assert.deepEqual(mergeVideoCopies(a, b), mergeVideoRecord(a, b));
  assert.deepEqual(mergeVideoCopies(b, a), mergeVideoRecord(b, a));
  const c = song('a', { folderId: 'ch:UCx', addedAt: 1 });
  const d = song('a', { folderId: 'pl:PLx', addedAt: 2 });
  assert.deepEqual(mergeVideoCopies(c, d), mergeVideoRecord(c, d), 'the sync\'s own placements keep their convergence');
});

test('THE STRANDED-SONG BUG: a folder deleted with "keep its videos" moves them on EVERY device (v1.0.94)', () => {
  // Device B deleted cf:disc1 and moved its songs to the loose list (db.moveFolderVideos
  // stamps placedAt); device A still has them filed under cf:disc1. The old merge kept each
  // device's own copy on the tie, so A kept a song in a folder whose row the tombstone
  // deleted — invisible on A's home for good.
  const onA = song('a', { folderId: 'cf:disc1', addedAt: 1000 });
  const onB = song('a', { folderId: 'sheet', addedAt: 1000, placedAt: 5000, updatedAt: 5000 });
  for (const merged of [mergeVideoCopies(onA, onB), mergeVideoCopies(onB, onA)]) {
    assert.equal(merged.folderId, 'sheet', 'the move must win in either merge order');
    assert.equal(merged.placedAt, 5000);
  }
});

test('the LATER deliberate placement wins; a copy with NO stamp never beats one that has it (v1.0.94)', () => {
  const early = song('a', { folderId: 'cf:mine', placedAt: 3000 });
  const later = song('a', { folderId: 'cf:late', placedAt: 9000 });
  assert.equal(mergeVideoCopies(early, later).folderId, 'cf:late');
  assert.equal(mergeVideoCopies(later, early).folderId, 'cf:late');
  // ⚠️ REVIEW FIX — an unstamped copy used to compete with its addedAt ("created later =
  // placed later"), so a channel sync on another device importing the same video LATER pulled
  // it out of the parent's own folder, on every device.
  const filed = song('a', { folderId: 'cf:mine', placedAt: 3000, addedAt: 1000 });
  const synced = song('a', { folderId: 'ch:UCx', addedAt: 50000 });
  for (const m of [mergeVideoCopies(filed, synced), mergeVideoCopies(synced, filed)]) {
    assert.equal(m.folderId, 'cf:mine', "the parent's placement must survive a later copy nobody placed");
    assert.equal(m.placedAt, 3000, 'and keep its stamp');
  }
  // …and the unstamped copy loses even when it is the merge's SURVIVOR (the older one)
  const older = song('a', { folderId: 'ch:UCx', addedAt: 10 });
  assert.equal(mergeVideoRecord(older, filed).folderId, 'ch:UCx', 'precondition: the survivor carries the other folder');
  assert.equal(mergeVideoCopies(older, filed).folderId, 'cf:mine');
});

test('the winning placement time is KEPT, so a later merge against a stale copy cannot undo it (v1.0.94)', () => {
  // mergeVideoRecord keeps the SURVIVOR's fields (here the older, stale copy): without the
  // kept stamp, the next merge would have nothing left to judge the placement by.
  const moved = song('a', { folderId: 'cf:new', addedAt: 4000, placedAt: 6000 });
  const stale = song('a', { folderId: 'cf:dead', addedAt: 1000, placedAt: 1000 });
  const once = mergeVideoCopies(stale, moved);
  assert.equal(once.folderId, 'cf:new');
  assert.equal(once.addedAt, 1000, 'addedAt is still min-merged');
  assert.equal(once.placedAt, 6000, 'the evidence must survive the merge');
  const twice = mergeVideoCopies(once, song('a', { folderId: 'cf:dead', addedAt: 1000, placedAt: 1000 }));
  assert.equal(twice.folderId, 'cf:new', 'a second stale copy must not drag it back');
});

test('placeInto: THE parking rule for a move — every placement in the app goes through it (v1.0.94)', () => {
  assert.deepEqual(placeInto(song('a', { folderId: 'cf:x' }), 'cf:y', 7), { folderId: 'cf:y', placedAt: 7 });
  assert.deepEqual(placeInto(song('a', { folderId: 'cf:x', homeFolderId: 'cf:x' }), 'cf:y', 7),
    { folderId: 'cf:y', homeFolderId: 'cf:y', placedAt: 7 }, 'an approved record keeps its two fields in step');
  assert.deepEqual(placeInto(song('a', { state: 'pending', folderId: '~pending', homeFolderId: 'cf:x' }), 'sheet', 7),
    { homeFolderId: 'sheet', placedAt: 7 }, 'a PENDING video stays parked — moving folderId shows the child a video nobody approved');
  assert.deepEqual(placeInto(song('a', { state: 'rejected', folderId: '~rejected', homeFolderId: 'cf:x' }), 'sheet', 7),
    { homeFolderId: 'sheet', placedAt: 7 }, 'a REJECTED video stays parked — moving folderId brings it back');
  assert.deepEqual(placeInto(null, 'cf:y', 7), { folderId: 'cf:y', placedAt: 7 });
});

test('placement respects parking: a parked result moves only its homeFolderId (v1.0.94)', () => {
  const pending = song('a', { state: 'pending', folderId: '~pending', homeFolderId: 'cf:one', addedAt: 1000, approvedAt: null });
  const movedLive = song('a', { state: 'pending', folderId: '~pending', homeFolderId: 'cf:two', placedAt: 7000, approvedAt: null });
  const m = mergeVideoCopies(pending, movedLive);
  assert.equal(m.folderId, '~pending', 'a parked record must stay parked');
  assert.equal(m.homeFolderId, 'cf:two');
  // a live result with a homeFolderId keeps the two in step
  const liveA = song('a', { folderId: 'cf:one', homeFolderId: 'cf:one' });
  const liveB = song('a', { folderId: 'cf:two', homeFolderId: 'cf:two', placedAt: 7000 });
  const l = mergeVideoCopies(liveA, liveB);
  assert.equal(l.folderId, 'cf:two');
  assert.equal(l.homeFolderId, 'cf:two');
});

test('an exact placement tie keeps the survivor\'s folder, and settlePlacement is total (v1.0.94)', () => {
  const a = song('a', { folderId: 'cf:one', placedAt: 5000 });
  const b = song('a', { folderId: 'cf:two', placedAt: 5000 });
  assert.equal(mergeVideoCopies(a, b).folderId, mergeVideoRecord(a, b).folderId);
  assert.equal(settlePlacement(null, b, null), null);
  assert.equal(mergeVideoCopies(a, null), a);
});

test('the DOCUMENT merge uses the placement rule too — the doc and the library cannot disagree (v1.0.94)', () => {
  const docA = docOf({ [LIB]: libOf({ videos: [song('a', { folderId: 'cf:disc1' })] }) });
  const docB = docOf({ [LIB]: libOf({ videos: [song('a', { folderId: 'sheet', placedAt: 5000 })] }) });
  assert.equal(mergeDbFiles(docA, docB).libraries[LIB].videos[0].folderId, 'sheet');
  assert.equal(mergeDbFiles(docB, docA).libraries[LIB].videos[0].folderId, 'sheet');
});

/* ==================== a pull may not revert a newer row ==================== */

test('a STALE pulled row never overwrites a newer local one — folders, sites, subscriptions (v1.0.94)', () => {
  // pullDrive applies the RAW remote document; the push is debounced by a minute and a pull
  // runs on every resume — so a rename made on this device used to be reverted by a pull of
  // the document written before it, and the next push uploaded the reverted row.
  const localF = row('cf:x', { title: 'שם חדש', updatedAt: 900 });
  const staleF = row('cf:x', { title: 'שם ישן', updatedAt: 100 });
  const newerF = row('cf:x', { title: 'שם מהטלפון', updatedAt: 950 });
  const missingF = row('cf:y', { updatedAt: 1 });
  const p = planCustomFolderApply({ localRows: [localF], remoteRows: [staleF, missingF], localTombs: {}, remoteTombs: {} });
  assert.deepEqual(p.puts.map((r) => r.folderId), ['cf:y'], 'the stale row must not be written; an unknown one must');
  assert.deepEqual(planCustomFolderApply({ localRows: [localF], remoteRows: [newerF], localTombs: {}, remoteTombs: {} })
    .puts.map((r) => r.title), ['שם מהטלפון'], 'a NEWER remote row is still taken');

  const site = (updatedAt) => ({ entryId: 's1', kind: 'rule', updatedAt, allowExternal: false });
  assert.deepEqual(planSiteApply({ localRows: [site(900)], remoteRows: [site(100)], localTombs: {}, remoteTombs: {} }).puts, []);
  assert.equal(planSiteApply({ localRows: [site(100)], remoteRows: [site(900)], localTombs: {}, remoteTombs: {} }).puts.length, 1);

  const sub = (updatedAt, autoApprove) => ({ channelId: 'UCx', updatedAt, autoApprove });
  assert.deepEqual(planChannelApply({ localRows: [sub(900, true)], remoteRows: [sub(100, false)], localTombs: {}, remoteTombs: {} }).puts, [],
    'a stale document must not switch auto-approve back');
  assert.equal(planChannelApply({ localRows: [sub(100, true)], remoteRows: [sub(900, false)], localTombs: {}, remoteTombs: {} }).puts.length, 1);
  // tombstones still win over both
  assert.deepEqual(planCustomFolderApply({ localRows: [], remoteRows: [staleF], localTombs: { 'cf:x': 500 }, remoteTombs: {} }).puts, []);
});

test('newerRemoteRows takes a row on a TIE only when the collection\'s own tie-break picks it', () => {
  const merge = mergeLibraryChannel; // tie → the row still requiring approval (the SAFE side)
  const local = { channelId: 'UCx', updatedAt: 5, autoApprove: true };
  const remote = { channelId: 'UCx', updatedAt: 5, autoApprove: false };
  const all = () => true;
  assert.deepEqual(newerRemoteRows([local], [remote], (r) => r.channelId, merge, all), [remote]);
  assert.deepEqual(newerRemoteRows([remote], [local], (r) => r.channelId, merge, all), []);
  assert.deepEqual(newerRemoteRows(null, [null, {}], (r) => r.channelId, merge, all), []);
});

test('a rebuilt PLACEHOLDER never beats a real row, in either order (v1.0.94)', () => {
  const real = row('cf:x', { title: 'אנא בכח', driveFolderId: 'D1', updatedAt: 100 });
  const guess = row('cf:x', { title: 'אנא בכח חלק א ועוד', placeholder: true, updatedAt: 99999 });
  assert.equal(mergeCustomFolder(real, guess), real);
  assert.equal(mergeCustomFolder(guess, real), real);
  // two placeholders: plain LWW
  const g2 = { ...guess, title: 'אחר', updatedAt: 100000 };
  assert.equal(mergeCustomFolder(guess, g2), g2);
  // and the apply plan honours it: a pulled placeholder never replaces a real local row
  assert.deepEqual(planCustomFolderApply({ localRows: [real], remoteRows: [guess], localTombs: {}, remoteTombs: {} }).puts, []);
});

/* ==================== the repair ==================== */

test('placeholderFolderTitle: shared words, else the first track + "ועוד", never cut mid-word (v1.0.94)', () => {
  assert.equal(placeholderFolderTitle(['מגילת קהלת חלק א', 'מגילת קהלת חלק ב', 'מגילת קהלת חלק ג']), 'מגילת קהלת');
  assert.equal(placeholderFolderTitle(['02 פטירת האדם', '01 סוד המיתה', '03 מלאך המוות']), 'סוד המיתה ועוד',
    'the FIRST track in natural order names it');
  assert.equal(placeholderFolderTitle(['01פרשת בראשית', '02פרשת נח']), 'פרשת', 'a number glued to the word is stripped');
  assert.equal(placeholderFolderTitle(['01 - Song One', '02 - Song Two']), 'Song');
  assert.equal(placeholderFolderTitle(['גילגולים חלק א']), 'גילגולים חלק א', 'one song is its own name');
  const long = placeholderFolderTitle(['01 שמונה עצות לזיכרון בלימוד התורה', '02 משהו אחר']);
  assert.equal(long, 'שמונה עצות לזיכרון ועוד');
  for (const t of [long, placeholderFolderTitle(['א'.repeat(80), 'ב'])]) {
    assert.ok([...t].length <= FOLDER_TITLE_MAX, `${t} is longer than a tile can hold`);
  }
  // a word-boundary cut must never END on a dangling "חלק" (measured on the family's data)
  assert.equal(placeholderFolderTitle(['01 אשרי יושבי ביתך חלק א', '02 משהו']), 'אשרי יושבי ביתך ועוד');
  assert.equal(placeholderFolderTitle([]), 'תיקיה משוחזרת');
  assert.equal(placeholderFolderTitle(null), 'תיקיה משוחזרת');
  assert.equal(placeholderFolderTitle(['', null, '   ']), 'תיקיה משוחזרת');
});

test('THE FAMILY\'S DATA: songs whose folder row is gone get their folder back, under its ORIGINAL id (v1.0.94)', () => {
  // The exact shape of the reported backup: songs filed under cf: folders, no rows at all.
  const filed = new Map([
    ['cf:disc2', [song('c', { folderId: 'cf:disc2', title: '01 אנא בכח חלק א', addedAt: 3000 }),
                  song('d', { folderId: 'cf:disc2', title: '02 פתח אליהו', addedAt: 3000 })]],
    ['cf:disc1', [song('a', { title: 'מגילת קהלת חלק א', addedAt: 3000 }),
                  song('b', { title: 'מגילת קהלת חלק ב', addedAt: 2000 })]]
  ]);
  const plan = planOrphanFolderRepair({ scopeId: LIB, filed, rows: [], tombs: {}, elsewhere: [], now: 9999 });
  assert.deepEqual(plan.adopt, []);
  assert.deepEqual(plan.toSheet, []);
  assert.deepEqual(plan.create.map((r) => r.folderId), ['cf:disc1', 'cf:disc2'],
    'the ORIGINAL ids: every song re-attaches with no write to any song, and two devices rebuild ONE row');
  const [d1, d2] = plan.create;
  assert.equal(d1.title, 'מגילת קהלת');
  assert.equal(d2.title, 'אנא בכח חלק א ועוד');
  assert.equal(d1.placeholder, true, 'it must say it is a guess, so a real row can replace it');
  assert.equal(d1.emoji, '🎵', 'an all-audio folder looks like music');
  assert.equal(d1.order, 2000, 'ordered by when its songs arrived — deterministic on every device');
  assert.equal(d1.scopeId, LIB);
  assert.equal(d1.driveFolderId, null, 'a placeholder is not Drive-backed: nothing to walk');
  // deterministic and idempotent
  assert.deepEqual(planOrphanFolderRepair({ scopeId: LIB, filed, rows: [], now: 9999 }).create, plan.create);
  assert.deepEqual(planOrphanFolderRepair({ scopeId: LIB, filed, rows: plan.create, now: 9999 }).create, [],
    'once the rows exist there is nothing left to repair');
});

test('the repair ADOPTS a row this device still holds under another scope, and never rebuilds a DELETED folder (v1.0.94)', () => {
  const filed = new Map([
    ['cf:a', [song('a', { folderId: 'cf:a' })]],
    ['cf:gone', [song('b', { folderId: 'cf:gone' }), song('c', { state: 'pending', folderId: '~pending', homeFolderId: 'cf:gone', approvedAt: null })]],
    ['ch:UCnot', [song('z', { folderId: 'ch:UCnot' })]]
  ]);
  const elsewhere = [row('cf:a', { scopeId: 'lib:p:old', title: 'השם האמיתי', driveFolderId: 'D9' })];
  const plan = planOrphanFolderRepair({ scopeId: LIB, filed, rows: [], tombs: { 'cf:gone': 70 }, elsewhere, now: 8000 });
  assert.deepEqual(plan.adopt.map((r) => [r.folderId, r.scopeId, r.title, r.driveFolderId]),
    [['cf:a', LIB, 'השם האמיתי', 'D9']], 'the exact folder, moved into the scope the profile reads');
  assert.deepEqual(plan.create, [], 'a deleted folder must not be resurrected, and a channel is not a folder');
  assert.deepEqual(plan.toSheet, [
    { key: 'file:drive:b', folderId: 'sheet', from: 'cf:gone' },
    { key: 'file:drive:c', folderId: 'sheet', from: 'cf:gone' }
  ], "its songs go where the delete dialog's default answer sends them (db.placeVideos stamps the move, keeps a parked one parked, and re-checks `from`)");
  assert.deepEqual(planOrphanFolderRepair({}), { create: [], adopt: [], toSheet: [] });
});

test('a lost folder holding ONLY rejected videos is left alone until one is restored (v1.0.94)', () => {
  const rej = (id, home) => song(id, { state: 'rejected', folderId: '~rejected', homeFolderId: home, approvedAt: null });
  const filed = new Map([['cf:r', [rej('a', 'cf:r'), rej('b', 'cf:r')]], ['cf:t', [rej('c', 'cf:t')]]]);
  assert.deepEqual(planOrphanFolderRepair({ scopeId: LIB, filed, rows: [], tombs: { 'cf:t': 5 }, now: 9 }),
    { create: [], adopt: [], toSheet: [] },
    "nothing in it can be shown, and a rebuilt row would sit in the parent's list for ever (the sweep counts parked videos)");
  const mixed = new Map([['cf:r', [rej('a', 'cf:r'),
    song('b', { state: 'pending', folderId: '~pending', homeFolderId: 'cf:r', approvedAt: null })]]]);
  assert.deepEqual(planOrphanFolderRepair({ scopeId: LIB, filed: mixed, rows: [], now: 9 }).create.map((r) => r.folderId), ['cf:r'],
    'one restored video is enough to bring the folder back');
});

test('two rebuilt folders never share a tile name (v1.0.94)', () => {
  const filed = new Map([
    ['cf:a', [song('a', { folderId: 'cf:a', title: 'פרשת בראשית' }), song('b', { folderId: 'cf:a', title: 'פרשת נח' })]],
    ['cf:b', [song('c', { folderId: 'cf:b', title: 'פרשת לך לך' }), song('d', { folderId: 'cf:b', title: 'פרשת וירא' })]]
  ]);
  const titles = planOrphanFolderRepair({ scopeId: LIB, filed, rows: [row('cf:x', { title: 'פרשת' })] }).create.map((r) => r.title);
  assert.deepEqual(titles, ['פרשת (2)', 'פרשת (3)']);
});

test('the empty-folder sweep leaves a rebuilt folder alone while it holds songs, and takes it once emptied', () => {
  const ph = row('cf:a', { placeholder: true, createdAt: 1, order: 1 });
  assert.deepEqual(planEmptyFolderSweep({ folders: [ph], counts: new Map([['cf:a', 5]]), now: 1e9 }), []);
  assert.deepEqual(planEmptyFolderSweep({ folders: [ph], counts: new Map([['cf:a', 0]]), now: 1e9 }), ['cf:a'],
    'once the parent moved or deleted every song in it, the guess goes like any empty folder');
});

/* ==================== pasting the Drive link again rebuilds ==================== */

test('refileEligible: a song goes back into the walked folder only when its own folder is GONE (v1.0.94)', () => {
  const rows = new Map([['cf:ph', row('cf:ph', { placeholder: true })], ['cf:favs', row('cf:favs')], ['cf:target', row('cf:target')]]);
  const ctx = { targetFolderId: 'cf:target', rowsById: rows, first: false };
  assert.equal(refileEligible(song('a', { folderId: 'cf:gone' }), ctx), true, 'a folder with no row at all');
  assert.equal(refileEligible(song('a', { state: 'pending', folderId: '~pending', homeFolderId: 'cf:gone' }), ctx), true,
    'a parked song is judged by its home');
  assert.equal(refileEligible(song('a', { folderId: 'cf:ph' }), ctx), false,
    'a placeholder is ADOPTED by the walk, never emptied (pickPlaceholderToAdopt)');
  assert.equal(refileEligible(song('a', { folderId: 'cf:favs' }), ctx), false, 'a song the parent filed elsewhere stays');
  assert.equal(refileEligible(song('a', { folderId: 'cf:target' }), ctx), false, 'already there');
  assert.equal(refileEligible(song('a', { folderId: 'sheet' }), ctx), false,
    'the 30-minute refresh must not yank back a song the parent moved out');
  assert.equal(refileEligible(song('a', { folderId: 'sheet' }), { ...ctx, first: true }), true, 'a fresh paste puts the loose songs back');
  assert.equal(refileEligible(song('a', { folderId: 'ch:UCx' }), { ...ctx, first: true }), false, "a channel's video belongs to the sync");
  assert.equal(refileEligible(null, ctx), false);
  assert.equal(refileEligible(song('a', { folderId: 'cf:gone' }), { ...ctx, targetFolderId: null }), false);
});

test('planDriveRefile: the eligible moves for one walked folder, each key once (v1.0.94)', () => {
  const recs = new Map([
    ['file:drive:lost', song('lost', { folderId: 'cf:gone' })],
    ['file:drive:guess', song('guess', { folderId: 'cf:ph' })],
    ['file:drive:loose', song('loose', { folderId: 'sheet' })]
  ]);
  const rows = new Map([['cf:ph', row('cf:ph', { placeholder: true })]]);
  const keys = [...recs.keys(), 'file:drive:unknown', 'file:drive:lost'];
  assert.deepEqual(planDriveRefile({ keys, targetFolderId: 'cf:t', recordsByKey: recs, rowsById: rows, first: false }),
    [{ key: 'file:drive:lost', folderId: 'cf:t' }]);
  assert.deepEqual(planDriveRefile({ keys, targetFolderId: 'cf:t', recordsByKey: recs, rowsById: rows, first: true }).map((m) => m.key),
    ['file:drive:lost', 'file:drive:loose']);
  assert.deepEqual(planDriveRefile({ keys, targetFolderId: null, recordsByKey: recs, rowsById: rows }), []);
  assert.deepEqual(planDriveRefile({}), []);
});

test('pickPlaceholderToAdopt: a Drive folder BECOMES the placeholder holding most of its songs (v1.0.94)', () => {
  const rows = new Map([
    ['cf:p1', row('cf:p1', { placeholder: true })], ['cf:p2', row('cf:p2', { placeholder: true })], ['cf:real', row('cf:real')]
  ]);
  const at = (k, over) => [k, song(k, { key: k, ...over })];
  const recs = new Map([
    at('k1', { folderId: 'cf:p2' }), at('k2', { folderId: 'cf:p2' }),
    at('k3', { folderId: 'cf:p1' }), at('k4', { state: 'pending', folderId: '~pending', homeFolderId: 'cf:p1' }),
    at('k5', { folderId: 'cf:p1' }),
    at('k6', { folderId: 'cf:real' }), at('k7', { folderId: 'cf:real' }), at('k8', { folderId: 'cf:real' }), at('k9', { folderId: 'cf:real' })
  ]);
  const pick = (keys) => pickPlaceholderToAdopt({ keys, recordsByKey: recs, rowsById: rows });
  assert.equal(pick(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']), 'cf:p1',
    'the placeholder with the most songs wins (a parked song counts by its home); a REAL folder is never adopted');
  assert.equal(pick(['k1', 'k3']), 'cf:p1', 'a tie picks the smaller id, so two devices pick the same row');
  assert.equal(pick(['k3', 'k1']), 'cf:p1', 'whatever the order the walk met them in');
  assert.equal(pick(['k6', 'k7', 'unknown']), null, 'no placeholder holds them — the walk mints a new row');
  assert.equal(pick(['k1', 'k1', 'k1', 'k3', 'k5']), 'cf:p1', 'a duplicate key counts once');
  assert.equal(pickPlaceholderToAdopt({}), null);
});

test('the Drive import plans hand back the songs ALREADY here, per folder (v1.0.94)', () => {
  const files = [{ id: 'f1', name: '01 a.mp3', mimeType: 'audio/mpeg' }, { id: 'f2', name: '02 b.mp3', mimeType: 'audio/mpeg' }];
  const kind = () => 'audio';
  const flat = planDriveFolderImport({ files, existingKeys: new Set(['file:drive:f2']), mediaKindOf: kind });
  assert.deepEqual(flat.existingKeys, ['file:drive:f2']);
  assert.deepEqual(flat.add.map((f) => f.driveId), ['f1']);
  const tree = planDriveTreeImport({
    folders: [{ id: 'ROOT', name: 'שיעורים', depth: 0, parentId: null, files: [] },
              { id: 'D1', name: 'דיסק 1', depth: 1, parentId: 'ROOT', files }],
    existingKeys: new Set(['file:drive:f1', 'file:drive:f2']), rootId: 'ROOT', mediaKindOf: kind
  });
  assert.deepEqual(tree.folders.find((n) => n.driveFolderId === 'D1').existingKeys, ['file:drive:f1', 'file:drive:f2']);
});

test('a rebuilt placeholder never pushes the REAL Drive name into "(2)" (v1.0.94)', () => {
  // measured on the family's data: the restored disc came back as "גילגולים (2)" beside the
  // placeholder it was replacing — a suffix that would outlive the placeholder for ever
  const tree = planDriveTreeImport({
    folders: [{ id: 'ROOT', name: 'שיעורים', depth: 0, parentId: null, files: [] },
              { id: 'D2', name: 'גילגולים', depth: 1, parentId: 'ROOT', files: [{ id: 'f1', name: 'a.mp3', mimeType: 'audio/mpeg' }] }],
    existingFolders: [row('cf:ph', { title: 'גילגולים', placeholder: true }), row('cf:mine', { title: 'שיעורים' })],
    existingKeys: new Set(), rootId: 'ROOT', mediaKindOf: () => 'audio'
  });
  assert.equal(tree.folders.find((n) => n.driveFolderId === 'D2').title, 'גילגולים', 'a guess must not claim a real name');
  assert.equal(tree.folders.find((n) => n.driveFolderId === 'ROOT').title, 'שיעורים (2)', 'a REAL folder still does');
});

test('driveFolderOutcome says the folder came BACK — not "nothing new" (v1.0.94)', () => {
  assert.match(driveFolderOutcome({ ok: true, added: 0, restored: 751, folders: 32, skipped: { existing: 751 } }),
    /שוחזרה.*751 קבצים חזרו.*32 תיקיות/);
  assert.match(driveFolderOutcome({ ok: true, added: 2, restored: 1 }), /קובץ אחד חזר.*נוספו 2 קבצים חדשים/);
  assert.match(driveFolderOutcome({ ok: true, added: 0, restored: 0, skipped: { existing: 3 } }), /אין קבצים חדשים/,
    'with nothing restored the old sentence stands');
});

test('a manual add is a placement, so it carries the stamp (v1.0.94)', () => {
  const r = manualVideoRecord({ row: { key: 'yt:abc', type: 'youtube', id: 'abc' }, scope: LIB, now: 4242 });
  assert.equal(r.placedAt, 4242);
});
