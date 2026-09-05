// Source-level invariants (v1.0.20). Everything here is a rule that CANNOT fail at
// build time — there is no bundler and no type checker — and whose breakage shows up
// only on a real device, in a family's library. Each test names the consequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = join(ROOT, 'www', 'js');

// `exts` is load-bearing: this used to hard-code `.js`, so the Java sweep below
// (the ONLY place the OAuth scope can live) silently walked zero files while the
// test reported the invariant as pinned.
function walk(dir, exts = ['.js']) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const FILES = walk(JS_DIR);
const src = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');
const MODULES = new Map(FILES.map((p) => [rel(p), src(p)]));
/** Same modules with comments stripped. Deletion guards must judge CODE: a tombstone
 *  comment naming what was removed ("planScopeAdoption (v1.0.20) died…") is documentation,
 *  and a guard that trips on it would force us to stop explaining our own history. */
const stripComments = (b) => b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const CODE = new Map([...MODULES].map(([k, v]) => [k, stripComments(v)]));

/**
 * v1.0.63 — the body of `onAppPause(() => { … })`, extracted by BALANCING BRACES.
 *
 * ⚠️ Both guards over this handler used a non-greedy `([\s\S]*?)\}\);`, which ends at the
 * first `});` in the body — so the moment the handler called anything with an object
 * literal (`f({ … })`) the extracted body was truncated and the guards reported the
 * handler had "stopped pausing the player". A guard that breaks on correct code is worse
 * than no guard: it trains you to edit the test until it passes.
 */
function appPauseBody(app) {
  return handlerBody(app, 'onAppPause(() => {');
}

/** v1.0.76 — the same brace-balanced extraction for ANY `name(() => { … })` registration.
 *  ⚠️ Added because a 700-char window from `onPipHidden(` was proven VACUOUS by its own
 *  plant: with comments stripped the window reached INTO the neighbouring onAppPause and
 *  matched that handler's backgroundPlayDecision. A window into app.js is a guess about
 *  distance; a balanced body is not. */
function handlerBody(app, anchor) {
  const at = app.indexOf(anchor);
  if (at < 0) return null;
  let i = app.indexOf('{', at);
  const start = i + 1;
  let depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (!depth) return app.slice(start, i); }
  }
  return null;
}

/** Anchored function-body slice (v1.0.55). Asserts the anchor still exists, so a rename
 *  fails as "lost the anchor — re-anchor this guard" instead of as a phantom regression
 *  (an unchecked indexOf answers -1, slice(-1) yields one character, and the guard's
 *  message then sends the next maintainer hunting a containment bug that does not exist). */
const fnSlice = (src, anchor) => {
  const at = src.indexOf(anchor);
  assert.ok(at > 0, `lost ${anchor} — re-anchor this guard`);
  const fn = src.slice(at);
  return fn.slice(0, fn.indexOf('\n}\n') + 1);
};

/** Static `import … from './x.js'` targets of one module, resolved repo-relative. */
function importsOf(relPath) {
  const body = MODULES.get(relPath) || '';
  const out = [];
  const re = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(body))) {
    const dir = dirname(relPath);
    out.push(join(dir, m[1]).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * DYNAMIC `await import('./x.js')` targets. This codebase has MORE of these than static
 * imports (app.js alone: 61 vs 21), and the static-only regex above could not see any of
 * them — a typo'd dynamic path is a blank screen on the device and a fully green suite.
 * Kept separate from importsOf() on purpose: a dynamic edge is evaluated lazily and is
 * this repo's sanctioned way to BREAK a cycle, so the cycle test must not follow it.
 */
function dynamicImportsOf(relPath) {
  const body = MODULES.get(relPath) || '';
  const out = [];
  const re = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(body))) out.push(join(dirname(relPath), m[1]).replace(/\\/g, '/'));
  return out;
}

test('the module graph has NO CYCLES', () => {
  // A cycle in a no-bundler ES-module app is not a build error: it is an `undefined`
  // binding at runtime, on a device, in whichever order the browser happened to
  // evaluate. CLAUDE.md pins the layer order for exactly this reason.
  const state = new Map(); // 0 = visiting, 1 = done
  const trail = [];
  const visit = (node) => {
    if (state.get(node) === 1) return;
    if (state.get(node) === 0) {
      assert.fail('import cycle: ' + trail.slice(trail.indexOf(node)).concat(node).join(' → '));
    }
    state.set(node, 0);
    trail.push(node);
    for (const dep of importsOf(node)) if (MODULES.has(dep)) visit(dep);
    trail.pop();
    state.set(node, 1);
  };
  for (const p of MODULES.keys()) visit(p);
});

test('tour.js imports NOTHING, so it is safe anywhere in the order', () => {
  // Pure data + pure functions is what lets app.js, the About tab and the empty-home
  // button all reach the decks without dragging a dependency chain along.
  assert.deepEqual(importsOf('www/js/tour.js'), []);
});

test('nav.js depends on no SCREEN — only on the modal primitive it must outrank', () => {
  // The router owns back-precedence (fullscreen → modal → view → pop → swallow), so it
  // legitimately needs to ask ui/modal.js "are you open?". What it must never import is
  // a screen: that is the cycle app.js → nav.js → app.js waiting to happen.
  const allowed = new Set(['www/js/ui/modal.js']);
  const deps = importsOf('www/js/nav.js').filter((d) => !allowed.has(d));
  assert.deepEqual(deps.filter((d) => /app\.js$|ui\/(?!modal)/.test(d)), [],
    'nav.js pulled in a screen: ' + deps);
});

test('nothing calls the YouTube search endpoint (100 quota units per call)', () => {
  // The entire quota budget is 10 000/day. One search.list per channel would burn it
  // before lunch and freeze every family's library for the rest of the day.
  // The patterns must match how this codebase actually writes a call — params are object
  // literals fed to URLSearchParams and the host is the `API` constant, so the previous
  // `part=` / `youtube/v3/search` patterns could not match ANY real offender.
  //
  // v1.0.33: ytsearch.js is the ONE exemption from the URL-literal pattern — the
  // parent's search uses YouTube's KEYLESS internal endpoint (0 quota, no API key),
  // which also contains the substring `/search?`. The exemption is by MODULE, never by
  // weakening the pattern, and inside that module every `/search?` literal must be one
  // of the two sanctioned keyless endpoints. The Data-API guards stay global.
  const YTSEARCH = 'www/js/ytsearch.js';
  for (const [p, body] of MODULES) {
    // call shapes only — quota.js states the rule in PROSE, and a doc comment naming
    // the endpoint must not read as a violation
    assert.doesNotMatch(body, /\bapiGet\s*\(\s*['"`]search\b/i, `${p} calls search.list via apiGet`);
    assert.doesNotMatch(body, /youtube\/v3\/search/i, `${p} calls youtube/v3/search`);
    assert.doesNotMatch(body, /googleapis\.com[^'"`\n]*\/search/i, `${p} hand-builds a Data-API search URL`);
    if (p !== YTSEARCH) {
      assert.doesNotMatch(body, /['"`][^'"`\n]*\/search\?/i, `${p} builds a search endpoint URL`);
    }
  }
  for (const lit of (MODULES.get(YTSEARCH) || '').match(/['"`][^'"`\n]*\/search\?[^'"`\n]*/g) || []) {
    assert.match(lit, /youtubei\/v1\/search\?prettyPrint=false|\/complete\/search\?/,
      `ytsearch.js carries an unsanctioned search URL: ${lit}`);
  }
});

test('custom folders: the store is version-guarded and every surface knows them (v1.0.56)', () => {
  const db = CODE.get('www/js/db.js');
  const app = CODE.get('www/js/app.js');

  // ⚠️ THE UPGRADE GUARD. An unguarded createObjectStore on an existing install throws
  // ConstraintError, aborts the version-change transaction, and the app cannot open its
  // database AT ALL — on every device in the field (the v1.0.45 measurement).
  assert.match(db, /DB_VERSION = 3\b/, 'the store was added without bumping DB_VERSION');
  assert.match(db, /if \(from < 3\) \{[\s\S]*?createObjectStore\('customFolders'/,
    'customFolders is created outside an oldVersion guard — that bricks every install');
  // EXACT, not a proximity heuristic: walk each guard's real brace range (the `from < 1`
  // block alone creates nine stores, so any fixed look-behind window is a lie) and assert
  // every createObjectStore position falls inside one.
  const guarded = [];
  for (const g of db.matchAll(/if \(from < \d+\) \{/g)) {
    let depth = 0;
    let i = g.index + g[0].length - 1;
    for (; i < db.length; i++) {
      if (db[i] === '{') depth++;
      else if (db[i] === '}' && --depth === 0) break;
    }
    guarded.push([g.index, i]);
  }
  assert.ok(guarded.length >= 3, 'the version guards vanished');
  for (const m of db.matchAll(/createObjectStore\(/g)) {
    assert.ok(guarded.some(([s, e]) => m.index > s && m.index < e),
      'a createObjectStore call sits outside an `if (from < N)` guard — that bricks every install');
  }

  // The folder's own row is metadata; MEMBERSHIP is the video's folderId, which is what
  // lets paging/search/parking work with no new branch. A `cf:` folder must therefore
  // never need a case in pageAnyFolder — it falls through to db.pageFolder like `pl:`.
  assert.doesNotMatch(fnSlice(app, 'async function pageAnyFolder('), /cf:/,
    'pageAnyFolder grew a custom-folder branch — membership should be the record\'s folderId');
  assert.doesNotMatch(fnSlice(app, 'async function nextAfter('), /cf:/,
    'nextAfter grew a custom-folder branch — it must stay symmetric with pageAnyFolder');

  // Deletion must ASK about the videos: planOrphanGC never touches a record with no
  // channelId (every manual single), so a folder deleted without re-homing its contents
  // leaves them filed under a folder that no longer exists — invisible on every screen.
  const del = fnSlice(app, 'async function deleteCustomFolderFlow(');
  assert.match(del, /planFolderDeletion\(/, 'the deletion text is no longer the pure decision');
  assert.match(del, /moveFolderVideos\(/, 'the default answer no longer re-homes the videos');
  assert.match(del, /deleteVideosWithTombstones\(/,
    'the purge answer deletes without tombstones — every Drive merge is a union, so a peer re-pushes them');

  // The picker must settle EXACTLY once, by any exit — the chooseShareProfile lesson.
  // ANCHORED to this registration's OWN body: a window-based match was satisfied by the
  // NEXT nav.register's onLeave and stayed green on a planted regression (proven).
  const regAt = app.indexOf("nav.register('folderpick'");
  assert.ok(regAt > 0, "lost nav.register('folderpick') — re-anchor this guard");
  const nextReg = app.indexOf('nav.register(', regAt + 10);
  const regBody = app.slice(regAt, nextReg > 0 ? nextReg : regAt + 400);
  assert.match(regBody, /onLeave/,
    'leaving the picker no longer resolves the awaiting add — the caller hangs forever');
  assert.match(regBody, /folderPickHandlers = null/,
    'the picker handler is not cleared on leave — a stale handler settles the NEXT add');
});

test('custom folders converge across devices like every other collection (v1.0.56)', () => {
  const drive = CODE.get('www/js/drive.js');
  // the same trio as libraryChannels/siteEntries — a second pattern is a second set of bugs
  for (const fn of ['mergeCustomFolder', 'mergeDeletedCustomFolders',
    'customFolderOutlivesTombstone', 'planCustomFolderApply']) {
    assert.match(drive, new RegExp('export function ' + fn + '\\('), `${fn} is gone`);
  }
  // BOTH buildLocalDoc branches must carry the keys — present-and-empty, or a peer's merge
  // reads this side as "unknown" rather than "none" (the v1.0.45 measurement).
  const build = fnSlice(drive, 'async function buildLocalDoc(');
  assert.equal((build.match(/customFolders:/g) || []).length, 2,
    'exactly one customFolders key per buildLocalDoc branch (library + prof pseudo-library)');
  assert.equal((build.match(/deletedCustomFolders:/g) || []).length, 2,
    'a branch is missing its folder tombstones');
  // the tombstone is written FIRST in the delete (a crash between the two writes must
  // leave the intent recorded), and the apply path never restamps a peer's record
  const dbDel = fnSlice(CODE.get('www/js/db.js'), 'export async function deleteCustomFolder(');
  assert.ok(dbDel.indexOf('putDeletedCustomFolders') < dbDel.indexOf("s.delete("),
    'the folder row is deleted before its tombstone is written');
  assert.match(drive, /putCustomFolder\(\{ \.\.\.e, scopeId: libId \}, \{ preserveTimestamp: true \}\)/,
    'applying a remote folder restamps it — the two devices would ping-pong forever');
  // and the per-library purge takes the folder tombstones with it (the v1.0.45 metaKeys bug)
  assert.match(fnSlice(CODE.get('www/js/db.js'), 'export async function purgeProfile('), /cfDelKey\(s\)/,
    'purgeProfile strands the folder tombstones — a recreated profile inherits them');
});

test('the containment lock cannot be escaped, and releases only what it took (v1.0.56)', () => {
  const app = CODE.get('www/js/app.js');

  // 1. EVERY door out is closed by the same helper — the child must not reach the exit
  //    button, another profile, or (in folder mode) any other folder.
  const ui = fnSlice(app, 'async function refreshContainUi(');
  for (const [el, why] of [
    ["'exit-btn'", 'the child could leave the app'],
    ["'profile-chip'", 'the child could switch to an unlocked sibling profile'],
    ["'folder-back'", 'the child could walk out of the locked folder'],
    ["'search-open'", 'search reaches other folders'],
    ["'watch-home'", 'the watch screen 🏠 goes straight to the gallery']
  ]) {
    assert.ok(ui.includes(el), `containment no longer hides ${el} — ${why}`);
  }

  // 2. HIDING THE BUTTON IS NOT ENOUGH: hardware back (and its Escape stand-in) must be
  //    swallowed in the locked folder, and must not offer the exit dialog on the home.
  // ANCHORED to the registration's own body, and it must consult CONTAINMENT — merely
  // asserting that an `onBack` exists is vacuous: `onBack: () => false` kept the substring
  // alive and this guard green on a planted regression (proven, then sharpened).
  const folderAt = app.indexOf("nav.register('folder'");
  assert.ok(folderAt > 0, "lost nav.register('folder') — re-anchor this guard");
  const folderReg = app.slice(folderAt, app.indexOf('nav.register(', folderAt + 10));
  assert.match(folderReg, /onBack: \(\) => \(containState\.active && containState\.mode === 'folder'/,
    'the folder view no longer swallows back under a lock — hardware back leaves the locked folder');
  const galleryReg = app.slice(app.indexOf("nav.register('gallery'"));
  assert.match(galleryReg.slice(0, galleryReg.indexOf('nav.register(', 10)), /containState\.active/,
    'the home offers askExit under containment — the exit button is hidden but back is not');

  // 3. THE PIN RELEASE FOLLOWS OWNERSHIP, NEVER A SETTING RE-READ (the v1.0.55 lesson:
  //    a mid-break toggle flip stranded the pin), and it NEVER unpins a kiosk session
  //    (v1.0.36 — stopLockTask raises the device keyguard).
  const clear = fnSlice(app, 'async function clearContainment(');
  assert.match(clear, /containPinHeld/, 'the release stopped following the pin it actually took');
  assert.match(clear, /exitLockOn\(/, 'the release ignores the kiosk veto — it would unpin a kiosk session');
  assert.match(clear, /containPinHeld = false/, 'the ownership flag is never dropped');

  // 4. It must SURVIVE A RESTART and a background: the state is read on boot/activation
  //    and on resume, and the 5s tick re-asserts the pin (the hold-back+recents gesture
  //    unpins with no lifecycle event at all — the v1.0.55 measurement).
  assert.match(app, /await applyContainment\(\);/, 'containment is not re-applied on profile activation/boot');
  const tick = fnSlice(app, 'async function tickContainment(');
  assert.match(tick, /lockTask\(\)/, 'the tick no longer re-asserts the pin');
  assert.match(tick, /expired/, 'a timed lock never expires by itself');

  // 4b. HIDING A TILE IS NOT ENFORCEMENT: the OPEN itself must refuse another folder.
  //     A relaunch renders the home for an instant, the TV remote reaches a tile, and a
  //     search result carries a folder id — all measured ways in.
  assert.match(fnSlice(app, 'async function openFolder('), /containState\.mode === 'folder'/,
    'openFolder no longer refuses a folder other than the locked one');

  // 4c. The exit button must be restored in BOTH directions. Only ever ADDING the class
  //     left a kiosk-off family with no exit button once a lock had been used (measured).
  assert.match(ui, /classList\.toggle\('hidden', chrome\.hideExit \|\| kiosk\)/,
    'the exit button is hidden one-way again — it never comes back after a release');

  // 4d. Releasing must LEAVE the code screen. startPin's default onSuccess navigates by
  //     itself, so a handler that only does work strands the parent on the keypad.
  const tap = fnSlice(app, 'async function onLockTap(');
  assert.match(tap, /nav\.back\(\)/, 'releasing the lock leaves the parent stranded on the PIN screen');

  // 4e. goGallery is the ONE funnel every "go home" path uses (the in-place delete, the
  //     share flow, leaveWatch's floor, the search/sites back buttons). Under a folder
  //     lock the home is not a destination, so the funnel itself must contain it —
  //     otherwise a parent deleting one video drops the child onto the full home.
  assert.match(fnSlice(app, 'function goGallery('), /containState\.mode === 'folder'/,
    'goGallery resets to the home under a folder lock — every "go home" path leaks');

  // 5. The break screen must not become a way OUT of a folder lock.
  const leave = fnSlice(app, 'function leaveLockedScreen(');
  assert.match(leave, /containState\.active/,
    'the break screen returns to the gallery under a folder lock — that is an escape');

  // 6. The state is DEVICE-LOCAL: syncing "locked until X" would lock a sibling's tablet.
  //    (Same rule the scheduled break's keys follow.)
  for (const mod of ['www/js/drive.js', 'www/js/settings.js', 'www/js/snapshot.js']) {
    assert.doesNotMatch(CODE.get(mod), /contain:/, `${mod} carries containment state — it must stay device-local`);
  }
});

test('an ACTIVE lock offers re-lock, not release-only, and re-lock asks the duration again (v1.0.76)', () => {
  // ⚠️ THE REPORTED BUG: with a lock active, every padlock tap was release-only (an early
  // return), so the "how long?" dialog appeared on the FIRST lock and never again — a parent
  // who had locked a site and then wanted to lock the app could not reach it.
  const app = CODE.get('www/js/app.js');
  const tap = fnSlice(app, 'async function onLockTap(');
  // the active branch must present a CHOICE routed through the pure decision, not just release
  assert.match(tap, /relockChoice\(/, 'onLockTap no longer offers a choice — it is release-only again');
  assert.match(tap, /askKid\(/, 'the active branch shows no dialog — the parent cannot choose to re-lock');
  // re-lock must reach the duration dialog (engageLock → askLockDuration), the whole point
  assert.match(tap, /engageLock\(scope\)/, 'the re-lock path does not re-engage the tapped scope');
  const engage = fnSlice(app, 'function engageLock(');
  assert.match(engage, /askLockDuration\(/, 'engageLock never opens the "how long?" dialog');
  // the FRESH-lock path (no active lock) still asks the code THEN the duration — engageLock
  // runs inside onSuccess, never before the PIN
  assert.match(tap, /onSuccess: \(\) => \{ engageLock\(scope\); \}/,
    'a fresh lock skips the code screen — engageLock must sit inside onSuccess');
  // the site viewer's padlock got the SAME fix (it was release-only too)
  const site = fnSlice(app, 'async function onSiteLockTap(');
  assert.match(site, /relockChoice\(/, 'the site viewer padlock is release-only again');
  assert.match(site, /askLockDuration\('site'/, 'the site re-lock never asks the duration');
});

test('a site lock has two grains, and a page lock is enforced by the SAME rule machinery (v1.0.76)', () => {
  const app = CODE.get('www/js/app.js');
  // the viewer's padlock asks the grain on BOTH engage and re-lock (feature 4 rides on the
  // feature-3 re-lock), routed through the pure decision
  const site = fnSlice(app, 'async function onSiteLockTap(');
  assert.match(app, /async function askSiteGrain\(/, 'the whole-site/page question is gone');
  assert.match(fnSlice(app, 'async function askSiteGrain('), /siteLockGrain\(/,
    'the grain question no longer maps its answer through the pure decision');
  // ⚠️ the narrowing is chosen by GRAIN: a page lock uses rulesForLockedPage, a site lock
  // rulesForLockedSite — both hand the native side an ordinary rule list, so enforcement is
  // unchanged (no Java touch). openLockedSite must branch on the grain.
  const open = fnSlice(app, 'async function openLockedSite(');
  assert.match(open, /siteGrain === 'prefix'/, 'openLockedSite ignores the grain — a page lock would open as a whole-site lock');
  assert.match(open, /rulesForLockedPage\(/, 'the page-lock narrowing is gone');
  assert.match(open, /rulesForLockedSite\(/, 'the whole-site narrowing is gone');
  // the grain must be PERSISTED (it survives a restart, like the rest of the lock) and it is
  // written before applyContainment/openLockedSite read it
  const commit = fnSlice(app, 'async function commitLockSetup(');
  assert.match(commit, /containGrainKey/, 'the grain is not persisted — a page lock reopens as a site lock after a restart');
  // ⚠️ onDone is driven by the SUCCESS BOOLEAN, never a `settled` flag: consumePinDone(true)
  // fires onDone BEFORE onSuccess runs, so a flag would still be false and the site would
  // reopen on success (a latent v1.0.67 bug). Pin the boolean shape.
  assert.match(site, /onDone: \(ok\) =>/, 'onSiteLockTap onDone reads a flag set too late — it reopens on success');
  assert.doesNotMatch(site, /let settled = false/, 'the settled-flag pattern is back — it reopens the site on success');
});

test('a Drive folder is ADDITIVE and never mirrors deletions (v1.0.56)', () => {
  const app = CODE.get('www/js/app.js');
  const plan = CODE.get('www/js/plan.js');

  // THE decision of this feature (user, 2026-08-29): new files flow in, a file the parent
  // removed in DRIVE is never removed from the child's library. A "mirror" is the shape
  // that deleted families' libraries in the sheet era — an unreadable listing reads as an
  // empty folder and sweeps everything.
  const imp = fnSlice(app, 'async function importDriveFolder(');
  // v1.0.58: the importer now walks a TREE, so it calls planDriveTreeImport — which must
  // itself route every file through planDriveFolderImport, so "which files are media, which
  // are already here, which were removed before" keeps exactly ONE answer in this app.
  assert.match(imp, /planDriveTreeImport\(/, 'the import stopped using its pure decision');
  assert.match(fnSlice(plan, 'export function planDriveTreeImport('), /planDriveFolderImport\(/,
    'the tree planner re-implements the per-file decision instead of reusing it');
  for (const banned of [/deleteVideo\(/, /deleteVideoRaw\(/, /deleteVideosWithTombstones\(/]) {
    assert.doesNotMatch(imp, banned,
      'the Drive-folder import deletes videos — it is ADDITIVE ONLY (a failed listing must never sweep)');
  }
  // an unreadable listing must ABORT, never proceed as "the folder is empty"
  assert.match(imp, /if \(!tree\.ok\)/, 'an unreadable listing is no longer distinguished from an empty one');
  assert.match(CODE.get('www/js/gdrivepub.js'), /ok: false, files: \[\]/,
    'fetchDriveFolder collapsed "could not read" into "nothing there"');

  // the KEYED branch must still name the folder: files.list answers children only, and a
  // folder titled by the generic fallback breaks the user's requirement that the app's
  // folder carries the DRIVE folder's name (regression activated the day the operator
  // widened the API key, which is exactly when the keyed branch started running).
  const fetchFolder = fnSlice(CODE.get('www/js/gdrivepub.js'), 'export async function fetchDriveFolder(');
  assert.match(fetchFolder, /return \{ ok: true, files: out, name: await keyedFolderName\(id, key\) \}/,
    'the keyed folder path no longer resolves the folder name — the tile loses the name the parent gave it in Drive');
  // ⚠️ v1.0.58 — AND IT MAY ONLY RETURN WHEN IT ACTUALLY SAW SOMETHING. `files.list` answers
  // 200 with an EMPTY list (not an error) when the key cannot see into a link-shared folder,
  // and the keyed branch used to return that as `{ok:true, files:[]}` from inside its own
  // pagination loop — so a folder full of songs was reported as "התיקיה ריקה" and the public
  // page that CAN read it was never tried. Reported from the field 2026-08-30. The guard
  // pins the SHAPE that makes emptiness fall through: exactly one keyed return, taken only
  // when `out.length`, and the keyless door after it.
  assert.equal((fetchFolder.match(/return \{ ok: true, files: out/g) || []).length, 1,
    'the keyed branch has more than one success return — one of them can report an empty listing');
  assert.match(fetchFolder, /if \(out\.length\) return \{ ok: true, files: out/,
    'the keyed branch returns without checking that it read anything — an empty answer will short-circuit the keyless door');
  assert.match(fetchFolder.slice(fetchFolder.indexOf('if (out.length)')), /parseDriveFolderHtml\(/,
    'the keyless door no longer follows the keyed one — an empty keyed answer has nowhere to fall through to');

  // the zero must NAME its cause (the v1.0.37 rule) — four different facts, four sentences
  assert.match(plan, /export function driveFolderOutcome\(/, 'the outcome text is no longer pure');
  assert.match(imp, /driveFolderOutcome\(/, 'the importer hand-rolls its own message');

  // a Drive folder is a CUSTOM FOLDER that refills itself — no new folder kind anywhere,
  // which is what let paging/search/deletion/sync stay untouched
  assert.doesNotMatch(fnSlice(app, 'async function pageAnyFolder('), /driveFolderId/,
    'paging grew a Drive-folder branch — it should be an ordinary cf: folder');
  assert.match(imp, /putCustomFolder\(/, 'the Drive folder is no longer stored as a custom folder');

  // the refresh is throttled and silent — it runs inside entryRefresh, before the sync
  const ref = fnSlice(app, 'async function refreshDriveFolders(');
  assert.match(ref, /driveSyncedAt/, 'the refresh lost its throttle — every home entry would re-list every folder');
  assert.match(ref, /catch/, 'a failed listing must never take the entry refresh down with it');
});

test('folder art is proposed, never installed, and stored as BYTES (v1.0.56)', () => {
  const art = MODULES.get('www/js/folderart.js');
  assert.ok(art, 'folderart.js is gone');
  // it is a search over arbitrary images on a 5-year-old's tablet: the parent is the
  // filter (user decision 2026-08-29), so nothing here may write a folder by itself
  const deps = [...new Set([...importsOf('www/js/folderart.js'), ...dynamicImportsOf('www/js/folderart.js')])];
  assert.deepEqual(deps, ['www/js/platform.js'], 'folderart.js reaches beyond its tier: ' + deps);
  assert.doesNotMatch(CODE.get('www/js/folderart.js'), /putCustomFolder|putThumb|db\.js/,
    'folderart.js writes to the database — it may only PROPOSE candidates');

  // the picked picture is cached as bytes, like a channel logo (v1.0.32): a stored URL
  // is exactly what 404s on a rebrand and cannot render offline
  const create = fnSlice(CODE.get('www/js/app.js'), 'async function createCustomFolder(');
  assert.match(create, /httpGetBlob\(/, 'the folder picture is no longer fetched as bytes');
  assert.match(create, /putThumb\(/, 'the folder picture is not stored in the thumb cache');
});

test('public-Drive access lives in ONE module and never touches OAuth (v1.0.56)', () => {
  // The app's only OAuth scope is drive.file and it must never grow (v1.0.19 — a
  // SENSITIVE scope brings Google's "unverified app" screen back for every family, and
  // verification needs DNS control we do not have on github.io). Reading a parent's own
  // Drive file is therefore impossible by design; gdrivepub works ONLY on files the
  // parent shared publicly, which playback on the child's tablet already requires.
  // A gauth import here would be the first step of exactly that regression.
  const gd = MODULES.get('www/js/gdrivepub.js');
  assert.ok(gd, 'gdrivepub.js is gone — public-Drive metadata lost its one home');
  const deps = [...new Set([...importsOf('www/js/gdrivepub.js'), ...dynamicImportsOf('www/js/gdrivepub.js')])];
  // v1.0.58: config.js joins the allowlist — it is the BOTTOM tier (pure constants, no
  // imports of its own), and the tree walk's safety caps belong there where an operator
  // can see them, not hidden in a default parameter. The ban this guard exists for is
  // unchanged: gauth/db/drive must never appear here.
  const allowed = new Set(['www/js/platform.js', 'www/js/keys.js', 'www/js/config.js']);
  assert.deepEqual(deps.filter((d) => !allowed.has(d)), [],
    'gdrivepub.js imports above its tier (gauth/db/drive belong nowhere near it): ' + deps);
  assert.doesNotMatch(CODE.get('www/js/gdrivepub.js'), /Authorization/,
    'gdrivepub.js attaches an Authorization header — it is the KEYLESS/public path');

  // the drive/v3 REST literal stays here: one blast radius when Google changes it, and
  // drive.js (the OAuth backup file) is the only other legitimate carrier
  const carriers = [...CODE].filter(([, b]) => /googleapis\.com\/drive\/v3/.test(b)).map(([p]) => p);
  assert.deepEqual(carriers.sort(), ['www/js/drive.js', 'www/js/gdrivepub.js'],
    'a Drive REST literal appeared outside its two modules: ' + carriers.join(', '));

  // the parsers must be TOTAL — a 200-with-HTML or an error envelope may never become a
  // child's tile caption. Behaviour is pinned in gdrivepub.test.mjs; this pins that the
  // fetch keeps routing through them rather than reading .name off a raw response.
  const fetchBody = fnSlice(CODE.get('www/js/gdrivepub.js'), 'export async function fetchDriveFileMeta(');
  assert.match(fetchBody, /interpretDriveFileMeta\(/, 'the API answer bypasses its parser');
  assert.match(fetchBody, /extractDriveFileMetaFromHtml\(/, 'the keyless scrape fallback is gone');
});

test('audio files: no black thumbnail is ever captured, and the scene always clears (v1.0.56)', () => {
  // captureFrame ran with `videoWidth || 320`, so an AUDIO element (videoWidth 0) painted
  // nothing onto a 320×180 canvas and persistThumb stored a solid-black JPEG as the tile's
  // PERMANENT thumbnail — it never retries a record that already has one.
  const cap = fnSlice(CODE.get('www/js/media.js'), 'export function captureFrame(');
  // ban the regression's exact shape — a NUMERIC fallback dimension. (A bare
  // `videoWidth ||` cannot be banned: the correct early-return below contains one.)
  assert.doesNotMatch(cap, /video(?:Width|Height)\s*\|\|\s*\d/,
    'captureFrame invents dimensions for a track-less element again');
  assert.match(cap, /if \(!video\.videoWidth \|\| !video\.videoHeight\) return null;/,
    'captureFrame no longer refuses an element with no video track');

  // the audio scene is a class on the SHARED wrap, so a file that leaves it behind would
  // cover the next video (and the YouTube engine, which never touches this class)
  const player = CODE.get('www/js/player.js');
  const playFile = fnSlice(player, 'async function playFile(');
  assert.match(playFile, /setAudioScene\(false\)/, 'the audio scene is never cleared on teardown');
  const cleanup = playFile.slice(playFile.indexOf('const cleanup = ('));
  assert.match(cleanup.slice(0, cleanup.indexOf('};')), /setAudioScene\(false\)/,
    'cleanup() does not clear the audio scene — it would cover the NEXT video');
  // runtime correction: the record's `media` may be missing (a share, an older peer)
  assert.match(playFile, /setAudioScene\(!\(video\.videoWidth > 0\)\)/,
    'the scene no longer self-corrects from the loaded metadata');

  // the same container invariant as .player-hud/.player-topbar
  const css = readFileSync(join(ROOT, 'www', 'css', 'styles.css'), 'utf8');
  const scene = css.slice(css.indexOf('.audio-scene {'));
  assert.match(scene.slice(0, scene.indexOf('}')), /pointer-events:\s*none/,
    'the audio scene takes pointer events — it would swallow the tap-shield');
});

test('the keyless youtubei endpoints live in EXACTLY one module and never see a key', () => {
  // The endpoints are undocumented — when YouTube changes them, ONE module must be the
  // whole blast radius. And they never need a key: sending one would tie the family's
  // shared quota (or the parent's own key) to requests that are free without it.
  // v1.0.33 widened this from /v1/search to ANY youtubei path (browse joined search).
  const carriers = [...MODULES].filter(([, b]) => /youtubei\//.test(b)).map(([p]) => p);
  assert.deepEqual(carriers, ['www/js/ytsearch.js'],
    'a youtubei endpoint moved or spread: ' + carriers.join(', '));

  const body = MODULES.get('www/js/ytsearch.js') || '';
  // call/import shapes only (the rule this file states for itself): prose naming the
  // getter must not read as a violation — the module's own header documents this ban
  assert.doesNotMatch(body, /[?&]key=/, 'ytsearch.js puts a key in a URL');
  assert.doesNotMatch(body, /\bgetApiKey\s*\(/, 'ytsearch.js calls the API-key getter');
  assert.doesNotMatch(body, /from\s+['"]\.\/keys/, 'ytsearch.js imports the keys module');

  // tier pin: pure parsers + thin transport — nothing above platform/util may enter,
  // or the no-bundler import order breaks and the parsers stop being node-testable
  const deps = [...new Set([...importsOf('www/js/ytsearch.js'), ...dynamicImportsOf('www/js/ytsearch.js')])];
  const allowed = new Set(['www/js/platform.js', 'www/js/util.js']);
  assert.deepEqual(deps.filter((d) => !allowed.has(d)), [],
    'ytsearch.js imports above its tier: ' + deps);
});

test('the search feature keeps one add path, its words, and its safe transport (v1.0.33)', () => {
  const app = MODULES.get('www/js/app.js');
  const yts = MODULES.get('www/js/ytsearch.js');
  const platform = MODULES.get('www/js/platform.js');

  // ONE add path (the v1.0.25 lesson — the importChannelAndAsk pin, applied to the
  // extraction whose whole point was that pasting and search-adding cannot drift).
  // Raise the count only for a new deliberate ADD surface, never to silence a break.
  assert.match(app, /async function addClassifiedRow\(/, 'the shared add path is gone');
  const sites = (app.match(/addClassifiedRow\(/g) || []).length - 1;
  assert.equal(sites, 2, `expected exactly 2 callers (parentAdd + ytsAdd), found ${sites}`);

  // a search result re-enters through the classify boundary, and a kind mismatch is
  // refused — classifyLink stays THE safety gate even for content YouTube handed us
  const ytsAddFn = app.slice(app.indexOf('async function ytsAdd('));
  const ytsAddBody = ytsAddFn.slice(0, ytsAddFn.indexOf('\n}\n'));
  assert.match(ytsAddBody, /classifySourceRow\(/, 'search adds bypass the classify boundary');
  // the FULL conditional shape, not the bare comparison: a `false &&` plant kept the
  // substring alive and this guard green (caught by its own red-check)
  assert.match(ytsAddBody, /if \(!row \|\| row\.kind !== item\.type\)/,
    'a classify/kind mismatch is no longer refused');

  // every stage app.js asks searchMessage for has TEXT (the channelAddWait analog —
  // a stage without words is a silent wait, the exact v1.0.27 ambiguity)
  const used = [...app.matchAll(/searchMessage\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(new Set(used).size >= 4, `only ${new Set(used).size} message stages used — the flow went quiet`);
  for (const stage of new Set(used)) {
    assert.match(yts, new RegExp(`case '${stage}':`),
      `app.js asks for '${stage}' but searchMessage has no text for it`);
  }

  // the transport seam owns BOTH halves of the CapacitorHttp body trap: an explicit
  // Content-Type (or the body is silently discarded) and a pre-stringified body
  // (the drive.js precedent)
  const post = platform.slice(platform.indexOf('export async function httpPostJson('));
  const postBody = post.slice(0, post.indexOf('\n}\n'));
  assert.match(postBody, /JSON\.stringify\(/, 'httpPostJson no longer pre-stringifies the body');
  assert.match(postBody, /'Content-Type': 'application\/json'/,
    'the explicit Content-Type is gone — CapacitorHttp silently drops the body without it');

  // hardware back closes the add tab's overlays before the screen — suggestion
  // dropdown, then browse, then goGallery — and only while the add panel is VISIBLE
  // (state left on another tab must not eat a back press). Deleting the gate or
  // reordering the chain fails here.
  const reg = app.slice(app.indexOf("nav.register('parent'"));
  const regBody = reg.slice(0, reg.indexOf('onLeave'));
  const iPrev = regBody.indexOf('isPreviewOpen()');
  const iSuggest = regBody.indexOf('ytsHideSuggest()');
  const iBrowse = regBody.indexOf('closeYtsBrowse()');
  const iGallery = regBody.indexOf('goGallery()');
  assert.ok(iPrev > -1 && iSuggest > iPrev && iBrowse > iSuggest && iGallery > iBrowse,
    'parent onBack order broke: preview → suggest → browse → goGallery');
  assert.match(regBody, /panel-add/, 'the overlay back-close lost its panel-add visibility gate');

  // renderPreview delegates its per-mode button matrix to the TESTED pure helper —
  // hand-ordered toggles are where the "live 🗑️ over a search result" bug lived
  const rp = app.slice(app.indexOf('function renderPreview('));
  assert.match(rp.slice(0, rp.indexOf('\n}\n')), /previewBubbleButtons\(/,
    'renderPreview grew a private button matrix again');
});

test('the sensitive `spreadsheets` OAuth scope is gone for good', () => {
  // v1.0.19: that scope is what triggered Google's "hasn't verified this app" screen
  // for every family, and verification needs DNS we do not control. Re-adding it to
  // make a pasted sheet writable brings the warning back for everyone.
  const suspects = [...MODULES.entries()];
  // native-reference/ is included deliberately: ARCHITECTURE.md calls those the canonical
  // copies for a `npx cap add android` rebuild, so a stale scope there would be restored
  // verbatim into a real APK.
  for (const dir of ['android/app/src/main/java', 'www', 'native-reference']) {
    for (const p of walk(join(ROOT, dir), ['.js', '.java'])) suspects.push([rel(p), src(p)]);
  }
  assert.ok(suspects.some(([p]) => p.endsWith('.java')), 'the Java sweep matched no files');
  for (const [p, body] of suspects) {
    assert.doesNotMatch(body, /auth\/spreadsheets/, `${p} requests the spreadsheets scope`);
  }
});

test('the UI no longer offers to paste a third-party sheet link', () => {
  // `drive.file` is per-file: a pasted sheet returns 403 appNotAuthorizedToFile, so the
  // input could only ever fail. It was removed from the wizard AND the sources tab.
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  for (const id of ['sheetsetup-paste', 'remote-paste', 'remote-url']) {
    assert.ok(!html.includes(`id="${id}"`), `index.html still has the paste-a-sheet control #${id}`);
  }
});

test('the API key file is gitignored and never referenced from a committed constant', () => {
  // The repo is PUBLIC. keys.local.js ships inside the APK but must never be committed,
  // and the key must never be serialized into the Drive DB or the sheet.
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /keys\.local\.js/, '.gitignore no longer excludes keys.local.js');
  assert.match(MODULES.get('www/js/keys.js'), /import\(['"]\.\/keys\.local\.js['"]\)/,
    'keys.js must load the local key lazily, so a fresh clone runs keyless');
});

test('NO module reads or writes a Google Sheet any more (v1.0.38)', () => {
  // The whole sheet layer is gone: sheetwrite.js (the write queue, the create path, the
  // listing), sync.js (the unauthenticated CSV reader), the sheet stage and the presence
  // mirror. Only the one-time MIGRATION may still read one, and only to fold it in once.
  // Wiring any of it back would restore the two-sources-of-truth design this release ended.
  const sheetApi = /sheets\.googleapis\.com|\/values\/|:append|spreadsheets\/d\//;
  // prove the pattern fires on the exact literals the deleted code used (TESTING.md rule 2)
  for (const bad of ["'https://sheets.googleapis.com/v4/spreadsheets'",
    '`${SHEETS}/${id}/values/${range}`', "url + ':append'",
    "'https://docs.google.com/spreadsheets/d/' + id"]) {
    assert.match(bad, sheetApi, 'the sheet-API pattern went vacuous');
  }
  for (const [p, body] of MODULES) {
    assert.doesNotMatch(body, sheetApi, `${p} talks to the Sheets API again`);
  }
  // the deleted modules must stay deleted
  for (const gone of ['www/js/sheetwrite.js', 'www/js/sync.js']) {
    assert.ok(!MODULES.has(gone), `${gone} is back`);
    for (const [p, body] of MODULES) {
      const name = gone.split('/').pop();
      assert.doesNotMatch(body, new RegExp("(?:\\bfrom|\\bimport)\\s*\\(?\\s*['\"](?:[^'\"]*/)?" + name.replace('.', '\\.') + "['\"]"),
        `${p} imports the deleted ${name}`);
    }
  }
  // and nothing may re-grow a sheet write queue (CODE, not comments — see stripComments)
  for (const [p, body] of CODE) {
    assert.doesNotMatch(body, /enqueueSheetRow|flushSheetQueue|planSheetMirror|applySheetMirror\s*\(/,
      `${p} references the deleted sheet write-back layer`);
  }
});

test('every module app.js imports actually exists on disk', () => {
  // A typo'd path is a blank screen on the device and nothing at all in `npm test` —
  // which is why the DYNAMIC form has to be resolved here too, not just the static one.
  for (const [p] of MODULES) {
    for (const dep of [...importsOf(p), ...dynamicImportsOf(p)]) {
      if (dep.includes('keys.local')) continue; // gitignored by design
      assert.ok(MODULES.has(dep), `${p} imports a file that does not exist: ${dep}`);
    }
  }
});

test('every grid pages through pageAnyFolder — including the 🎁 folder', () => {
  // v1.0.21 FIELD BUG: renderGridPage had its own `fid === 'new'` branch (db.pageGifts)
  // and renderWatchGrid did not, so opening a gift left the UNDER-PLAYER GRID EMPTY —
  // 🎁 is not a stored folder, so pageAnyFolder fell through to db.pageFolder(scope,
  // 'new'), whose folderRange is an exact bound that no record can match. The child lost
  // every way to reach the next video. CLAUDE.md calls pageAnyFolder "the ONE pagination
  // entry point"; this pins that, so a second renderer cannot grow a private branch.
  const app = MODULES.get('www/js/app.js');
  const lines = app.split('\n');
  const idx = (needle) => lines.findIndex((l) => l.includes(needle));

  // the two low-level pagers may be called only from pageAnyFolder, its 🎁 helper, or
  // nextAfter — the three members of the pagination family, kept adjacent on purpose
  const giftHelper = idx('async function pageGiftFolder');
  const entry = idx('async function pageAnyFolder');
  const afterEntry = lines.findIndex((l, i) => i > entry && l === '}');
  const nextFn = idx('async function nextAfter');
  const afterNext = lines.findIndex((l, i) => i > nextFn && l === '}');
  assert.ok(giftHelper > 0 && entry > giftHelper, 'pageGiftFolder must sit above pageAnyFolder');
  assert.ok(nextFn > entry, 'nextAfter must sit with the other pagers, not off on its own');

  for (const [n, line] of lines.entries()) {
    for (const raw of ['db.pageGifts(', 'db.pageFolder(']) {
      if (!line.includes(raw)) continue;
      const inHelper = n > giftHelper && n < entry;
      const inEntry = n > entry && n <= afterEntry;
      const inNext = n > nextFn && n <= afterNext;
      assert.ok(inHelper || inEntry || inNext,
        `app.js:${n + 1} calls ${raw} outside the pagination family — every grid must page through it`);
    }
  }
  // and pageAnyFolder must actually HANDLE the gift folder, or it silently returns []
  const body = lines.slice(entry, afterEntry + 1).join('\n');
  assert.match(body, /fid === 'new'/, "pageAnyFolder lost its 🎁 ('new') branch");

  // v1.0.25 — nextAfter (continuous play) must recognise EVERY folder kind pageAnyFolder
  // does. This is the real hazard of a third pager: a folder kind added to one and not the
  // other means the chain silently disagrees with the grid the child is looking at —
  // stopping early, or worse, playing something that is not the next tile.
  const nextBody = lines.slice(nextFn, afterNext + 1).join('\n');
  // v1.0.40: 'fav' (⭐) joins the list — another folder that no record carries.
  for (const kind of ["'new'", "'fav'", "'grp:'", "'sheet'", "'ch:'"]) {
    assert.ok(body.includes(kind), `pageAnyFolder no longer handles ${kind}`);
    assert.ok(nextBody.includes(kind),
      `nextAfter does not handle ${kind} — continuous play would disagree with the grid`);
  }
});

test('every path that makes a record LIVE forces a refresh', () => {
  // v1.0.21 field bug: a freshly written record is INERT — `srcChannelId` (which files it
  // into its channel folder) comes from the sync's enrichment stage and `giftRank` only
  // from planProfileGifts, so a shared/added video sat in the loose list and was not a 🎁
  // until the parent happened to press "רענון נתונים".
  //
  // A COUNT is all a grep can honestly assert here (the behaviour is DOM- and
  // IndexedDB-coupled). It catches a call being deleted; it cannot catch a NEW approval
  // path that never had one — which is a real hole this suite hit once already, so any
  // new approve/add site must be added here deliberately.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /function refreshAfterAdd\(/, 'the post-add refresh helper is gone');
  // total occurrences minus the one declaration = real call sites.
  // EXACT, deliberately: the old `>= 5` floor stayed green while three call sites were
  // deleted. The 7 are: refreshPendingList's row-approve, approveChannelBacklog,
  // importChannelAndAsk (the awaited wait:true one), parentAdd, the pending
  // single-approve and approve-all handlers, and the share handler in init.
  // v1.0.27 DELIBERATE change 8→7: pickChannelVideos no longer fires its own silent
  // sync — importChannelAndAsk runs the one blocking 'finishing' wait for BOTH dialog
  // answers, which is the waiting-screens feature's whole point on that branch (the
  // "no step is silent" test pins that path). A new add/approve path adds one HERE,
  // and a removal must explain where its refresh went.
  // v1.0.38 DELIBERATE change 7→8: linksImportFromText. ONE call for the whole file
  // (behind the 'finishing' wait), never one per row — a 300-line file must not fire 300
  // forced syncs, which is exactly why the importer does not route through
  // addClassifiedRow. The count is what would catch that regression.
  // v1.0.56 DELIBERATE change 8→9: the Drive-FOLDER import. It writes live records like
  // any other add path, so it needs the same forced refresh — without it the imported
  // files sit un-enriched and un-gifted until the parent presses "רענון נתונים" (the
  // v1.0.21 field bug). The periodic refreshDriveFolders does NOT call it: it already runs
  // inside entryRefresh, immediately before the sync it would otherwise be asking for.
  const sites = (app.match(/refreshAfterAdd\(/g) || []).length - 1;
  assert.equal(sites, 9,
    `expected exactly 9 refreshAfterAdd call sites, found ${sites} — an add path stopped refreshing, or a new one must be pinned here deliberately`);
  // it must FORCE: the 3-min shouldSync throttle is what made the bug invisible
  const fn = app.slice(app.indexOf('function refreshAfterAdd('));
  // `[^}]*` rather than an immediate `}`: v1.0.26 added an `onProgress` option for the one
  // caller that waits behind a loading screen. The RULE is "it must force" — the old regex
  // also pinned the punctuation, so a legitimate second option failed it.
  assert.match(fn.slice(0, 900), /syncLibrary\(activeProfileId,\s*\{[^}]*force:\s*true\b/,
    'refreshAfterAdd must force the sync, or the 3-min throttle swallows it');
  // …and never under a playing video: a forced sync also bypasses the per-channel RSS
  // throttle, so it is a full sweep of every channel on a low-end tablet
  assert.match(fn.slice(0, 900), /nav\.isActive\('watch'\)/,
    'refreshAfterAdd lost its playback guard');
});

test('syncLibrary DELEGATES the join-or-queue decision to planSyncDispatch', () => {
  // The same trap nav.test.mjs describes, and this one already sprang once: v1.0.21 wrote
  // the rule ("a FORCED sync CHAINS, NEVER JOINS") into the comment above syncLibrary and
  // then shipped a condition that joined whenever the running sync was also forced. A
  // comment cannot fail a test. Pin that the tested decision core is the LIVE one.
  const src = MODULES.get('www/js/sync2.js');
  const at = src.indexOf('export function syncLibrary');
  assert.ok(at > 0, 'syncLibrary is gone — re-anchor this guard');
  const fn = src.slice(at);
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(body, /planSyncDispatch\(/, 'syncLibrary re-implements the decision inline again');
  // Anchor to the CURRENT entry names, LOUDLY: the first version of this guard banned
  // `cur.force` long after any `cur` stopped existing, so the v1.0.21 bug rewritten in
  // today's names passed it. A rename must fail HERE, not silently defuse the ban below.
  assert.match(body, /const running = inFlight\.get\(/,
    'the in-flight entry variable was renamed — re-anchor this guard or its .force ban matches nothing');
  assert.match(body, /const queued = queuedRuns\.get\(/,
    'the queued entry variable was renamed — re-anchor this guard or its .force ban matches nothing');
  for (const action of ['start', 'join-running', 'join-queued', 'queue']) {
    assert.ok(body.includes(`'${action}'`), `syncLibrary ignores the '${action}' decision`);
  }
  // The bug was a condition that read an ENTRY's own force flag and joined. The only
  // `.force` the dispatcher may read is the CALLER's (opts.force, fed to the pure
  // helper); any other `.force` inside syncLibrary is the v1.0.21 condition in new names.
  assert.doesNotMatch(body, /(?<!opts)\.force\b/,
    'syncLibrary consults an entry\'s .force directly — the v1.0.21 join-a-forced-run condition is back');
  // …and every join must be gated by the pure decision, never by an ad-hoc condition.
  for (const line of body.split('\n')) {
    if (!line.includes('attach(')) continue;
    assert.match(line, /action === '/,
      `syncLibrary joins a run without asking planSyncDispatch: ${line.trim()}`);
  }
});

test('BOTH ways to add a channel import it and then ASK (v1.0.25)', () => {
  // v1.0.22 made the parent screen ask before a stranger's whole catalogue reaches a
  // 5-year-old. The SHARE path never got it: handleChannelShare subscribed, fired a sync
  // it did not await, and reported success immediately — so the backlog landed in
  // ממתינים with no dialog and no count. CLAUDE.md already claimed the question covered
  // "parent screen + share"; only one of them was true. Pin that they share one path.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function importChannelAndAsk\(/, 'the shared import-then-ask path is gone');
  // v1.0.26 raised this from 2 to 3 DELIBERATELY: pasting a standalone playlist is a third
  // way to subscribe, and it goes through the same import-then-ask path for the same
  // reason. Raise it only when a new SUBSCRIPTION path is added, never to silence a break.
  const sites = (app.match(/importChannelAndAsk\(/g) || []).length - 1;
  assert.equal(sites, 3,
    `expected exactly 3 callers (parent screen: channel + playlist, and share), found ${sites}`);

  // The share layer must NOT run its own sync: it cannot show the loading screen or the
  // modal (it may not import ui/*), and a second sync would make the parent wait twice.
  const share = MODULES.get('www/js/share.js');
  // v1.0.26 renamed it: a shared PLAYLIST takes the same path as a shared channel.
  const at = share.indexOf('async function handleSourceShare');
  assert.ok(at > 0, 'the shared channel/playlist handler is gone');
  const chan = share.slice(at);
  assert.doesNotMatch(chan, /syncLibrary\(/, 'share.js syncs a shared channel behind onAdded again');
  assert.match(chan, /await onAdded\(/, 'the share must AWAIT the import, or it reports an outcome it does not have');
});

test('the new-channel dialog offers three answers and handles every one', () => {
  // A three-way question needs three REAL buttons: mapping an answer onto an accidental
  // dismiss (scrim tap, hardware back) would let a child decide what reaches them. The
  // labels are the parent-facing contract, so they are pinned with the routing.
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function offerChannelApproval('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  for (const label of ['אישור הכל', 'אישור ידני', 'אחר כך']) {
    assert.ok(body.includes(`'${label}'`), `the dialog lost its "${label}" button`);
  }
  assert.match(body, /answer === 'ok'/, "the 'אישור הכל' branch is gone");
  assert.match(body, /answer === 'third'/, "the 'אישור ידני' branch is gone");
  // "approve everything" is exactly what ticks the ✅ in the parent's channel list
  assert.match(body, /autoApprove:\s*true/, 'approving all no longer flips autoApprove');
  assert.match(body, /pickChannelVideos\(/, "'אישור ידני' no longer opens the picker");
});

test('the channel-approval paths resolve the library scope, never the bare global', () => {
  // `libScope` is published by buildFolders — only after a home render. A channel shared
  // from YouTube can now reach these on a cold start, and a null scope reads as "this
  // library is empty": no dialog, and a picker with no rows.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function currentLibScope\(/, 'the defensive scope resolver is gone');
  for (const name of ['pendingKeysOfChannel', 'pickChannelVideos', 'offerChannelApproval']) {
    const fn = app.slice(app.indexOf(`function ${name}(`));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    assert.match(body, /currentLibScope\(\)/, `${name} reads the bare libScope global again`);
  }
});

test('the home entry PULLS before it SYNCS, and nothing else pulls (v1.0.25)', () => {
  // Both write the same video records, so interleaving them lets one clobber the other's
  // merge — CLAUDE.md has said so since v1.0.22, and it was FALSE on launch:
  // nav.reset('gallery') fires the gallery's onEnter synchronously, so the forced launch
  // sync was already running by the time activateProfile reached its own pullThenSync on
  // the very next line. Every launch, on every device with backup enabled.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function entryRefresh\(/, 'the single refresh pipeline is gone');
  const fn = app.slice(app.indexOf('async function entryRefresh('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  const pullAt = body.indexOf('maybePullDrive(');
  const syncAt = body.indexOf('syncLibrary(');
  assert.ok(pullAt >= 0, 'entryRefresh no longer pulls');
  assert.ok(syncAt >= 0, 'entryRefresh no longer syncs');
  assert.ok(pullAt < syncAt, 'the sheet sync now runs BEFORE the Drive pull');
  assert.match(body, /await maybePullDrive\(\)/, 'the pull is not awaited — that IS the race');

  // ONE puller on the entry path. A second call site is how the race got in.
  // v1.0.49: THREE, deliberately. The third is the parent's own "רענון נתונים" button,
  // which never pulled at all — so a site or an approval made on another device could not
  // arrive through the one control whose whole promise is "fetch what is new". Raise this
  // only for another deliberate surface, never to silence a break.
  const callers = (app.match(/maybePullDrive\(/g) || []).length - 1; // minus the definition
  assert.ok(callers <= 3, `maybePullDrive has ${callers} call sites — entry + resume + the refresh button`);
  const dsr = app.slice(app.indexOf('async function doSyncAndRefresh'));
  const dsrBody = dsr.slice(0, dsr.indexOf('\n}\n') + 1);
  assert.match(dsrBody, /maybePullDrive\(\{ force: true \}\)/,
    'the parent\'s refresh button does not pull — it cannot bring anything from another device');
  assert.ok(dsrBody.indexOf('maybePullDrive(') < dsrBody.indexOf('syncLibrary('),
    'the refresh button syncs before it pulls — both write the same records');
  assert.match(dsrBody, /refreshSitesPanel\(\)/,
    'the refresh button leaves the sites tab stale — the tab the parent is standing in');
  // Call shapes only, like the search.list guard: the comment above entryRefresh NAMES the
  // function it replaced, and a doc comment must never read as a violation.
  assert.doesNotMatch(app, /function pullThenSync\b/, 'the old parallel pipeline is back');
  assert.doesNotMatch(app, /[^`'"\w]pullThenSync\s*\(/, 'something calls the old parallel pipeline');

  // …and the decision about WHETHER to pull/force is the tested pure one.
  assert.match(app, /planEntryRefresh\(/, 'homeEntryRefresh re-implements the throttles inline');
});

test('synced settings have ONE source of truth (v1.0.25)', () => {
  // The PIN, the exit lock and the share-approval toggle moved to settings.js so they
  // travel between a family's devices. A leftover direct Preferences read is not a
  // cosmetic duplicate: it is a second source of truth, and the symptom is a parent
  // changing the code on the phone while the tablet keeps opening with the old one.
  for (const [p, body] of MODULES) {
    if (p === 'www/js/settings.js') continue;
    // pin.js legitimately reads the LEGACY key once, to lift an existing PIN out of
    // Preferences — resetting everyone's parent gate for a launch is not an option.
    if (p !== 'www/js/pin.js') {
      assert.doesNotMatch(body, /pref(Get|Set)\(\s*['"]pin['"]/, `${p} reads/writes the PIN outside settings.js`);
    }
    assert.doesNotMatch(body, /pref(Get|Set)\(\s*['"]exitLock['"]/, `${p} still stores the exit lock per device`);
  }
  // and pin.js must never WRITE the legacy key back — that is the two-sources bug
  assert.doesNotMatch(MODULES.get('www/js/pin.js'), /prefSet\(/,
    'pin.js writes the legacy Preferences key again');
});

test('the exit lock is per-profile, and leaving a locked profile is gated', () => {
  // A per-profile lock opens a hole a device-wide one did not have: the profile chip went
  // straight to backToProfiles, so a child on a locked profile could tap their avatar,
  // pick a sibling whose profile is NOT locked, and walk out. Two taps, and the kiosk is
  // decoration.
  const app = MODULES.get('www/js/app.js');
  const chipAt = app.indexOf('async function onProfileChip(');
  assert.ok(chipAt > 0, 'the profile-switch gate is gone');
  const fn = app.slice(chipAt);
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  // v1.0.28 (deliberate change): the chip ALWAYS gates — the exitLockOn() conditional is
  // gone because the unconditional rule is strictly stronger. What this guard now bans is
  // any UN-GATED path: backToProfiles may appear only as startPin's onSuccess, never as a
  // free-standing branch, or a child switches to a sibling's profile in one tap again.
  assert.match(body, /startPin\(/, 'the profile switch no longer asks for the parent code');
  // comments stripped first — the function's own doc block NAMES the old escape, and a
  // pin a comment can trip pins prose, not code (the snapshot-guard lesson, again)
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const freestanding = code.replace(/onSuccess:\s*backToProfiles/g, '');
  assert.doesNotMatch(freestanding, /backToProfiles/,
    'onProfileChip has an un-gated path to the profile picker');
  // and the gate must not fail OPEN — in the FUNCTION, not only in the wiring line: a
  // catch anywhere in onProfileChip that falls back to backToProfiles makes a locked
  // profile escapable by whatever made the check throw. (The first version looked only
  // at the addEventListener line, so a `.catch(() => backToProfiles())` inside the
  // function body — the documented real escape — passed it.)
  assert.doesNotMatch(body, /catch[\s\S]{0,120}backToProfiles/,
    'onProfileChip falls back to backToProfiles on a throw — the switch gate fails open');
  const wiring = app.split('\n').find((l) => l.includes("$('profile-chip').addEventListener")) || '';
  assert.match(wiring, /onProfileChip/, 'the chip is wired straight to backToProfiles again');
  assert.doesNotMatch(wiring, /catch[\s\S]{0,120}backToProfiles/, 'the switch gate fails open at the wiring');

  // …and the lock must arm at launch from the LAST active profile, or there is an
  // unlocked window between launch and the profile tap.
  assert.match(app, /exitLockOn\(await prefGet\('activeProfile'\)\)/,
    'the launch arming no longer knows which profile to arm for');

  // SWITCHING children changes the answer, so activation must re-apply it. Without this
  // the escape is real: arriving at a LOCKED profile from an unlocked one left the device
  // unpinned with the exit button on screen — the child the lock exists for walks out.
  assert.match(app, /async function applyExitLock\(/, 'the per-profile arming helper is gone');
  const act = app.slice(app.indexOf('async function activateProfile('));
  const actBody = act.slice(0, act.indexOf('\n}\n') + 1);
  assert.match(actBody, /applyExitLock\(\)/,
    'activateProfile does not re-apply the exit lock — a locked child keeps a sibling\'s unlocked state');
  // and it must actually CALL the OS pinning, not just the button. The first version
  // matched the bare names, which the destructuring import line satisfies on its own —
  // deleting both OS calls left the kiosk as a hidden button and a green suite.
  const helperAt = app.indexOf('async function applyExitLock(');
  assert.ok(helperAt > 0, 'the per-profile arming helper is gone — re-anchor this guard');
  const helper = app.slice(helperAt);
  const helperBody = helper.slice(0, helper.indexOf('\n}\n') + 1);
  assert.match(helperBody, /await lockTask\(\)/, 'the helper no longer pins — the import alone is not a call');
  // v1.0.36 SUPERSEDES the old "helper must release" half: releasing on activation is
  // exactly what raised the device keyguard mid-profile-switch. The never-unpin rule
  // (and the release points that replace it) is pinned by its own test below.
});

test('the settings channel travels, but the API key never does', () => {
  // The repo is PUBLIC and the key ships in a gitignored file; drive.js has an explicit
  // refusal list. A settings channel is exactly the kind of place a key would get swept
  // into by accident.
  const drive = MODULES.get('www/js/drive.js');
  assert.match(drive, /mergeSettings\(/, 'the Drive doc no longer merges settings');
  const ser = drive.slice(drive.indexOf('export function serializeDb('));
  const body = ser.slice(0, ser.indexOf('\n}\n') + 1);
  assert.match(body, /settings/, 'settings are no longer serialized into the Drive doc');
  for (const [p, src2] of MODULES) {
    if (p !== 'www/js/settings.js' && p !== 'www/js/drive.js') continue;
    assert.doesNotMatch(src2, /yt:apiKey/, `${p} touches the YouTube API key`);
  }
});

test('continuous play routes through planAutoplay, and onExit says WHY (v1.0.25)', () => {
  // finish() fires for a clean end AND for an embedding-disabled video. Without a reason
  // on the wire an autoplay chain cannot tell them apart, so it skips through every broken
  // video in the library in silence — and the failure ceiling can never trigger.
  const player = MODULES.get('www/js/player.js');
  assert.match(player, /const finish = \(reason = 'ended'\)/g, 'finish() lost its reason');
  assert.match(player, /finish\('error'\)/, 'the embed-error path no longer reports a failure');
  assert.match(player, /onExit\(reason\)/, 'onExit is called without the reason again');
  // the DOM hands a listener an Event, which would arrive AS the reason
  assert.doesNotMatch(player, /addEventListener\('ended',\s*finish\s*\)/,
    "the 'ended' listener passes a DOM Event as the exit reason");

  const app = MODULES.get('www/js/app.js');
  assert.match(app, /planAutoplay\(/, 'app.js re-implements the chain decision inline');
  const fn = app.slice(app.indexOf('async function onVideoFinished('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  for (const action of ['stop', 'retry']) {
    assert.ok(body.includes(`'${action}'`), `onVideoFinished ignores the '${action}' decision`);
  }
  // A chain must not survive the child leaving, and a tap must beat the queued video.
  assert.match(app, /resetAutoplayChain\(\); \/\/ a queued next video must never follow/,
    'leaving the watch view no longer cancels a pending countdown');
  const ow = app.slice(app.indexOf('async function openWatch('));
  assert.match(ow.slice(0, 600), /cancelAutoplay\(\)/, 'opening a video does not cancel the countdown');
});

test('deleting a profile actually deletes it, and it STAYS deleted (v1.0.25)', () => {
  // `db.purgeProfile` existed with ZERO CALLERS while the confirm dialog promised
  // "כל הסרטונים של הפרופיל יימחקו. פעולה זו אינה הפיכה". Measured 2026-08-02: a throwaway
  // profile with one channel kept all 500 videos, its subscription and its sources record.
  // A function nobody calls is the failure mode here, so the call site is the invariant.
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function deleteCurrentProfile('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(body, /db\.purgeProfile\(/, 'deleting a profile leaves all of its data behind again');
  assert.match(body, /planProfilePurge\(/,
    'the purge no longer asks which scopes it may erase — a SHARED sheet library would go too');

  // The deletion has to survive the next pull, or it undoes itself on every other device.
  const store = MODULES.get('www/js/store.js');
  const del = store.slice(store.indexOf('export async function deleteProfile('));
  assert.match(del.slice(0, del.indexOf('\n}\n') + 1), /markProfileDeleted\(/,
    'no tombstone is written — a Drive pull will resurrect the profile');
  assert.match(store, /export function mergeProfileLists\(local, remote, deleted/,
    'mergeProfileLists no longer filters deleted profiles');

  // …and the tombstones have to travel, in both directions.
  const drive = MODULES.get('www/js/drive.js');
  assert.match(drive, /deletedProfiles/, 'the Drive document no longer carries the tombstones');
  assert.match(drive, /mergeDeletedProfiles\(/, 'the document merge drops the tombstones');
});

test('the preview bubble leaves the screen behind it untouched (v1.0.26)', () => {
  // The bubble exists so a parent can CHECK a video without losing the queue they are
  // triaging. Everything here is a way that promise gets broken silently.
  const app = MODULES.get('www/js/app.js');
  // Every slice must PROVE its anchor first (the handleSourceShare pattern above): an
  // indexOf that answers -1 makes slice(-1) a one-character body, the inner indexOf
  // answers -1 too, and every doesNotMatch below passes vacuously on an EMPTY string —
  // a renamed function turned this whole test into decoration once already.
  const sliceAt = (needle) => {
    const at = app.indexOf(needle);
    assert.ok(at > 0, `app.js lost the anchor "${needle}" — this guard cannot run on an empty slice`);
    return app.slice(at);
  };

  // 1. It must not be the kid player. setupHud binds window/document listeners and must
  //    never run twice without a teardown; the kid HUD also hides the very scrub bar the
  //    parent needs. The bubble builds its own iframe from the tested pure URL.
  assert.match(app, /previewEmbedUrl\(/, 'the preview no longer uses the tested embed URL');
  const fn = sliceAt('function renderPreview(');
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.doesNotMatch(body, /playItem\(/, 'the preview mounts the KID player — setupHud runs twice');

  // 2. Closing must tear the player out, or a video keeps playing behind the parent screen.
  const close = sliceAt('function closePreview(');
  assert.match(close.slice(0, close.indexOf('\n}\n') + 1), /innerHTML = ''/,
    'closing the bubble leaves the iframe alive and playing');
  assert.match(app, /onLeave: \(\) => closePreview\(\)/,
    'leaving the parent screen no longer stops the preview');

  // 3. Hardware back must close the BUBBLE first, not throw the parent out of the screen.
  const reg = sliceAt("nav.register('parent'");
  assert.match(reg.slice(0, 400), /isPreviewOpen\(\)/, 'back skips the bubble and leaves the screen');

  // 4. THE promise itself: deciding one video must not untick the rows the parent lined up.
  //    Doing this by parameter was wrong — refreshAfterAdd rebuilds the list a beat later
  //    and cleared them right back — so preservation is unconditional and filtered against
  //    the rebuilt list.
  const rp = sliceAt('async function refreshPendingList(');
  const rpBody = rp.slice(0, rp.indexOf('\n}\n') + 1);
  assert.match(rpBody, /const carried = new Set\(pendingSel\)/, 'the selection is dropped on rebuild again');
  assert.match(rpBody, /alive\.has\(id\)/, 'ticks are restored without checking the row still exists');
  assert.doesNotMatch(app, /keepSelection/, 'preservation is conditional again — refreshAfterAdd will undo it');

  // 5. A cancelled confirm must not count as a decision and skip the video.
  const pd = sliceAt('async function previewDecide(');
  assert.match(pd.slice(0, pd.indexOf('\n}\n') + 1), /!== false/,
    'backing out of the delete confirm still advances past the video');
});

test('NO share route can be silent (v1.0.26)', () => {
  // THE field bug: a parent reported that sharing from YouTube does not work, and the app
  // could not answer which of seven silent `return`s it had taken — nor did success say
  // anything either. Every route now ends in a reason, and app.js shows it.
  const share = MODULES.get('www/js/share.js');
  const fnBody = (name) => {
    const at = share.indexOf(`async function ${name}(`);
    assert.ok(at > 0, `share.js lost ${name} — re-anchor this guard`);
    const fn = share.slice(at);
    return fn.slice(0, fn.indexOf('\n}\n') + 1);
  };

  // EVERY function on the share path, not just routeShare: three of the seven real
  // v1.0.26 drops lived in handleSourceShare, which the first version never scanned.
  // (drainShareQueue/initShareTarget stay out: their early returns mean "no share
  // arrived", not a share swallowed.)
  const FLOWS = ['handleShare', 'routeShare', 'handleSourceShare'];
  const reasons = new Set();
  for (const name of FLOWS) {
    const body = fnBody(name);
    // A silent drop is `return;` — and `return null;` / `return undefined;` are the SAME
    // nothing wearing a value. The first version matched only the bare form. Shape-based,
    // not line-based: the real ones look like `if (!c) return;` mid-line.
    assert.doesNotMatch(body, /\breturn\s*(?:null|undefined)?\s*;/,
      `${name} has a silent return — that is a share the parent never hears about`);
    // harvest EVERY reason a return can answer, INCLUDING ternary arms
    // (`return a ? 'pending' : 'added';` — the old `return '…'` shape missed both)
    for (const st of body.matchAll(/\breturn\b([^;]*);/g)) {
      for (const lit of st[1].matchAll(/'([a-z][a-z-]*)'/g)) reasons.add(lit[1]);
    }
  }

  // and handleShare must actually report what routeShare answered
  assert.match(fnBody('handleShare'), /onResult\(reason\)/,
    'the reason is computed and then thrown away');

  // every reason share.js can return must exist in the pure message table
  assert.ok(reasons.size >= 10,
    `only ${reasons.size} reasons harvested — the share sweep went blind`);
  const table = MODULES.get('www/js/plan.js');
  for (const r of reasons) {
    assert.ok(table.includes(`  ${r}: {`) || table.includes(`  '${r}': {`),
      `share.js can answer '${r}' but plan.js has no message for it`);
  }

  // app.js must render them
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /resultHandler:/, 'app.js no longer listens for share outcomes');
  assert.match(app, /shareOutcome\(reason\)/, 'the outcome is not turned into a message');
  assert.match(app, /toast\(/, 'nothing shows the message');
});

test('no module parses an ISO-8601 duration (Shorts are not a length)', () => {
  // THE trap. YouTube defines a Short as "≤3 minutes AND square-or-taller"; the Data API
  // exposes no aspect ratio and no isShort field, so length can never reproduce the rule.
  // Measured 2026-07-31: 6 of the 15 most recent Super Simple Songs LONG-FORM uploads are
  // under 3 minutes (3 of 15 for Cocomelon) — a duration filter would silently delete real
  // nursery rhymes, the app's core content. Membership of the UULF/UUSH playlists is the
  // only correct filter; see quota.planBackfillPlaylist.
  //
  // Nothing here needs a duration (the player reads seconds off the media element, not
  // the API). The banned shape is any realistic parser over `PT…H/M/S`: `PT` followed by
  // a group, a `\d` or a `[0-9]`, with an H/M/S unit nearby. The first version banned the
  // literal `PT(?:` — only NON-CAPTURING-group parsers — and `/PT(\d+H)?/`, the shape a
  // parser that actually wants the numbers uses, sailed straight past it.
  const durationParser = /PT(?:\(|\\d|\[0-9\])[^\n]{0,40}[HMS]/;
  // prove the pattern can fire on the shapes it exists to catch (TESTING.md rule 2)
  for (const bad of ['/^PT(\\d+H)?(\\d+M)?(\\d+S)?$/', '/PT(?:(\\d+)H)?/',
    'PT([0-9]+M)', '/PT\\d+S/']) {
    assert.match(bad, durationParser, 'the duration-parser pattern went vacuous');
  }
  for (const [p, body] of MODULES) {
    assert.doesNotMatch(body, durationParser,
      `${p} parses an ISO-8601 duration — length misclassifies short nursery rhymes as Shorts`);
  }
});

test('every $(id) the code asks for EXISTS in index.html', () => {
  // `$` is `document.getElementById`, and this app has no bundler, no type checker and no
  // JSX — a renamed or forgotten id is not a build error. It is `null.classList`, thrown
  // during mount, which is a BLANK SCREEN on a family's tablet with the whole library
  // still intact behind it. Cheap to pin, and it catches the exact mistake that adding a
  // control to a panel invites: wiring the handler and forgetting the markup.
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const [p, body] of MODULES) {
    for (const m of body.matchAll(/\$\('([^']+)'\)/g)) {
      if (!ids.has(m[1])) missing.push(`${p}: $('${m[1]}')`);
    }
  }
  assert.deepEqual(missing, [], 'these ids are read from JS but are not in index.html');
});

test("the name input's maxlength IS store.PROFILE_NAME_MAX", async () => {
  // v1.0.26: the profile-name limit lives in TWO places that cannot see each other — the
  // `maxlength` attribute the parent actually types against, and the cap `createProfile`
  // stores by. Before this release the attribute was the ONLY one, so the limit was a DOM
  // detail no test could reach; now that both exist, the failure mode is drift: raise the
  // attribute alone and long names reach storage unbounded, raise the constant alone and
  // the parent simply cannot type them. The profile TILE is sized for `PROFILE_NAME_MAX`
  // (2 lines at 9em, browser-measured), so the attribute is what keeps that promise true.
  const { PROFILE_NAME_MAX } = await import('../www/js/store.js');
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  const tag = html.match(/<input[^>]*id="create-name"[^>]*>/);
  assert.ok(tag, 'index.html has no #create-name input');
  const attr = tag[0].match(/maxlength="(\d+)"/);
  assert.ok(attr, `#create-name has no maxlength — the cap would be silent: ${tag[0]}`);
  assert.equal(Number(attr[1]), PROFILE_NAME_MAX,
    'index.html maxlength and store.PROFILE_NAME_MAX disagree');
});

test('the version chain is not one deletable line', () => {
  // EVERY APK's version comes from one `apply from` at the END of a CAPACITOR-GENERATED
  // file. `npx cap add android` regenerates that file, and its own defaultConfig still says
  // versionName "1.0" — so losing the line ships every build as 1.0, which makes
  // isNewer(anything, '1.0') true forever: an update-nag loop on every launch, and no way
  // to tell which build a parent is running.
  const gradle = readFileSync(join(ROOT, 'android/app/build.gradle'), 'utf8');
  assert.match(gradle, /apply from:.*release\/android-release\.gradle/,
    'android/app/build.gradle lost the version+signing hook — every APK would ship as 1.0');
  const rel = readFileSync(join(ROOT, 'release/android-release.gradle'), 'utf8');
  assert.match(rel, /package\.json/, 'the version no longer derives from package.json');
});

test('package.json is the single version source and is well-formed', () => {
  // gradle parses this with a regex and THROWS on a non-X.Y.Z value, but that failure only
  // shows up at build time on the release machine.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `version "${pkg.version}" breaks the gradle parser`);
  const [, minor, patch] = pkg.version.split('.').map(Number);
  // versionCode = major*10000 + minor*100 + patch, so >99 in either would collide
  assert.ok(minor <= 99 && patch <= 99, 'minor/patch must stay <= 99 for the versionCode scheme');
});

test('the pending-reset banner is rendered by the HOME, not only behind the PIN', () => {
  // v1.0.26. The 24-hour wait is not what protects the parent — the ANNOUNCEMENT is. A
  // reset request that nobody sees just means the child waits a day and walks in, so the
  // notice has to be on the screen that is on all day. If `renderHome` stops drawing it,
  // the feature silently becomes a delay with no alarm attached, and every unit test for
  // `planPinRecovery` still passes.
  const app = MODULES.get('www/js/app.js');
  const home = app.slice(app.indexOf('async function renderHome('));
  const body = home.slice(0, home.indexOf('\n}\n'));
  assert.match(body, /refreshRecoveryBanner\(/,
    'renderHome no longer announces a pending parent-code reset');
});

test('a PIN-reset request is DEVICE-LOCAL: exactly one module knows the key', () => {
  // v1.0.26. The request must not travel. The PIN hash itself is synced (that is why
  // recovery has to exist at all), but a *pending reset* is not family state: syncing it
  // would let one device start the clock on every other one, and a peer's stale copy
  // could re-arm a request the parent already cancelled. Keeping the key in a single
  // module is what makes that checkable — `drive.serializeDb` cannot carry what it cannot
  // name, and nothing can read it behind the PIN and quietly decide otherwise.
  const owners = [];
  for (const [p, body] of MODULES) {
    if (body.includes('pinRecoveryAt')) owners.push(p);
  }
  assert.deepEqual(owners, ['www/js/recovery.js'],
    'the recovery timestamp leaked out of recovery.js — see the comment above');
});

test('the device-credential bridge fails CLOSED, and cannot lock a parent out', () => {
  // v1.0.26. Two opposite failures, both reachable from one sloppy line in platform.js:
  //   (a) treating a thrown/absent bridge as SUCCESS would open the parent screen to
  //       anyone on any device where the plugin is missing — i.e. the browser, and every
  //       APK built before this method existed;
  //   (b) letting it THROW would blow up `onPinForgot` before it can offer the 24-hour
  //       wait, turning a missing fingerprint sensor into a permanent lockout.
  // So both wrappers must compare against an explicit `=== true` and swallow.
  const plat = MODULES.get('www/js/platform.js');
  for (const fn of ['canDeviceAuth', 'deviceAuth']) {
    const i = plat.indexOf(`export async function ${fn}(`);
    assert.ok(i > 0, `platform.js no longer exports ${fn}`);
    const body = plat.slice(i, plat.indexOf('\n}', i));
    assert.match(body, /catch\s*\{\s*return false;?\s*\}/,
      `${fn} lets a bridge error escape — a locked-out parent never reaches the wait`);
    assert.match(body, /===\s*true/, `${fn} accepts a truthy value as proof of an adult`);
  }
});

test('a failed device prompt still offers the wait', () => {
  // The fast path is an ADDITION, never a replacement. If `onPinForgot` returns on a
  // failed prompt instead of falling through, then on a device WITH a lock screen the
  // 24-hour route becomes unreachable — and that is the only route that always works.
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function onPinForgot('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /planRecoveryRoute\(/, 'app.js re-implements the route decision inline');
  // Scope to the DEVICE branch alone. Slicing to the end of the function made this guard
  // vacuous: the wait-start branch below also calls requestRecovery(), so deleting the
  // fallback entirely still passed. Caught by planting exactly that.
  const from = body.indexOf("if (route === 'device')");
  assert.ok(from > 0, 'onPinForgot no longer has a device branch');
  const to = body.indexOf('const go = await confirmKid', from);
  assert.ok(to > from, 'the wait-start branch moved — re-anchor this guard');
  const dev = body.slice(from, to);
  assert.match(dev, /requestRecovery\(/,
    'the device branch never falls back to the wait when the prompt fails');
});

test('no step of the channel-add flow is left silent (v1.0.26)', () => {
  // FIELD REPORT: "adding a channel takes a while — fine — but between clicks I cannot
  // tell whether it is still working or waiting for me." Only the long import ever showed
  // anything; every other step handed back the ordinary screen with work still running.
  //
  // Two things must hold, and neither is visible to a unit test:
  //   (a) every stage app.js waits on has TEXT in plan.js — otherwise the parent gets the
  //       generic "בטעינה…", which is the same non-answer;
  //   (b) the post-decision sync is AWAITED, because that one is a second full library
  //       sync and was by far the longest silence.
  const app = MODULES.get('www/js/app.js');
  const plan = MODULES.get('www/js/plan.js');

  const used = [...app.matchAll(/withChannelWait\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 4, `only ${used.length} waited steps — the flow went quiet again`);
  for (const stage of new Set(used)) {
    assert.match(plan, new RegExp(`^\\s{2}${stage}\\s*:`, 'm'),
      `app.js waits on '${stage}' but plan.channelAddWait has no text for it`);
  }

  // The blocking wait, and its valve. `wait: true` is what turns the fire-and-forget
  // refresh into something the parent can see finish.
  const imp = app.slice(app.indexOf('async function importChannelAndAsk('));
  const body = imp.slice(0, imp.indexOf('\n}\n'));
  assert.match(body, /withChannelWait\(\s*'finishing'/, 'the post-decision work went silent again');
  assert.match(body, /refreshAfterAdd\(\{[^}]*wait:\s*true/, 'the second sync is fire-and-forget again');
  // A loading screen swallows back, so an unbounded wait is a trap, not a courtesy.
  assert.match(body, /waitWithValve\(/, 'the blocking wait lost its escape valve');
});

test('the orphan GC delegates to planOrphanGC, and the playlist stages are gated (v1.0.27)', () => {
  // Three fixes from one review, all in the standalone-playlist family — each pinned to
  // the LIVE code path so the pure tests cannot pass while production regrows the inline
  // version they replaced (the v1.0.20 "it pinned the fixture" lesson).
  const sync = MODULES.get('www/js/sync2.js');
  const app = MODULES.get('www/js/app.js');

  // (a) the GC: the inline predicate deleted every standalone-playlist video on every
  //     mirror pass (their channelId is the OWNER, not the subscribed playlist id).
  //     v1.0.38: the sweep moved into its own `gcOrphans`, so the anchor is that function.
  const gcAt = sync.indexOf('export async function gcOrphans(');
  assert.ok(gcAt > 0, 'gcOrphans is gone — the orphan sweep has no home');
  const gc = sync.slice(gcAt, sync.indexOf('\n}\n', gcAt));
  assert.match(gc, /planOrphanGC\(/, 'the orphan GC no longer delegates to planOrphanGC');
  assert.doesNotMatch(sync, /!subscribed\.has\(rec\.channelId\)/,
    'the inline orphan predicate is back — it deletes playlist videos');
  // ONE sweep site: a second renderer-style private copy is how this bug class returns.
  assert.equal((sync.match(/planOrphanGC\(/g) || []).length, 1,
    'planOrphanGC gained a second caller — the sweep must have exactly one site');
  for (const p of [...MODULES.keys()]) {
    if (p === 'www/js/sync2.js' || p === 'www/js/plan.js') continue;
    assert.doesNotMatch(MODULES.get(p), /planOrphanGC\(/, `${p} sweeps orphans on its own`);
  }

  // (b) the standalone playlist stage must gate items like the channel stage does:
  //     a MISSING owner is a private/deleted entry (an untappable "Private video" tile).
  const stAt = sync.indexOf('מושכים סרטונים מרשימת ההשמעה');
  assert.ok(stAt > 0, 'the standalone playlist stage moved — re-anchor this guard');
  assert.match(sync.slice(stAt, stAt + 900), /acceptPlaylistItem\(/,
    'the standalone playlist stage pushes page items unfiltered');

  // (c) the share confirm: a playlist fell into the VIDEO branch, so handleSourceShare
  //     (which accepts only the source decision) answered "ההוספה בוטלה" after the
  //     parent tapped הוספה — the v1.0.26 feature could not succeed on any path.
  const shAt = app.indexOf('function handleShareInteractive(');
  assert.ok(shAt > 0, 'handleShareInteractive moved');
  const sh = app.slice(shAt, app.indexOf('\n}\n', shAt));
  assert.match(sh, /kind === 'playlist'/, 'handleShareInteractive treats a playlist as a video again');
});

test('snapshot deny import goes through the LWW merge — never a blind restamped put', () => {
  // v1.0.26: importProfileSnapshot used to `deny.put({ …, at: d.at || Date.now(), … })` —
  // the v1.0.22 copyDenies bug replayed. A revoked tombstone lost its `removedAt`, took a
  // fresh `at`, imported as ACTIVE-and-newest, clobbered any local revocation, and the
  // restamped row then won every Drive merge and re-deleted the video on every device.
  // The decision now lives in pure planDenyImport (behaviourally tested in
  // snapshot.test.mjs); this pin only holds the IDB loop — which no node test can
  // execute — onto that helper, and bans the exact restamping shape. Comments are
  // STRIPPED first: snapshot.js quotes the old shape in its own doc blocks, and a pin
  // that a comment can satisfy (or trip) pins prose, not code — the routeShare-guard
  // lesson.
  const body = MODULES.get('www/js/snapshot.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /planDenyImport\(existingDenies/,
    'importProfileSnapshot no longer routes deny rows through planDenyImport');
  assert.doesNotMatch(body, /d\.at\s*\|\|\s*Date\.now\(\)/,
    'the blind restamping deny put is back');
  // and the EXPORT carries FULL rows: loadDenySet hides revoked entries, so exporting
  // through it silently dropped every revocation from the backup (presence must be judged
  // by the record existing — the db.copyDenies rule).
  assert.doesNotMatch(body, /loadDenySet/,
    'the export filters the deny-list through loadDenySet again — revocations do not travel');
});

test('the TV remote can reach folded sections (v1.0.28)', () => {
  // <details>/<summary> became the parent screen's main structure (the grouped library
  // list; the rejected archive had it since v1.0.23) — and `summary` was never in the
  // D-pad's focusable selector, so on Android TV every folded section was silently
  // unreachable: the remote skipped straight over it and the content inside might as
  // well not exist. Enter on a focused summary toggles natively; FOCUS was the gap.
  const dpad = MODULES.get('www/js/ui/dpad.js');
  const at = dpad.indexOf('querySelectorAll');
  assert.ok(at > 0, 'the focusables selector moved — re-anchor this guard');
  // end-anchor searched FROM the selector: the word also appears in a comment above it,
  // and slicing to the first occurrence made this guard fail on the correct code
  const sel = dpad.slice(at, dpad.indexOf('offsetParent', at));
  assert.match(sel, /\bsummary\b/, 'summary fell out of the D-pad focusable selector');
});

test('the preview bubble is reachable from a TV remote (v1.0.29)', () => {
  // The bubble is an OVERLAY outside every .view (deliberately — the screen behind keeps
  // its state), so the D-pad's view-scoped scan could never see its buttons: on TV it
  // opened and the remote was trapped behind it. And the thumbnail that OPENS it was a
  // bare <img> with a click listener — not focusable, Enter-dead.
  // comments stripped: the fix's own comment names the bubble, and a pin a comment can
  // satisfy pins prose (this exact plant passed the first version of this guard)
  const dpad = MODULES.get('www/js/ui/dpad.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(dpad, /getElementById\('preview-bubble'\)/,
    "dpad's scope priority lost the open bubble");
  assert.match(dpad, /\?\s*pv\s*:/, 'the bubble branch fell out of the scope ternary');
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('function parentRow(');
  assert.ok(at > 0, 'parentRow moved');
  const fn = app.slice(at, at + 3500);
  assert.match(fn, /img\.tabIndex = 0/, 'the preview thumbnail fell out of the focus scan');
  assert.match(fn, /'Enter'/, 'Enter no longer opens the preview from the remote');
});

test('every D-pad-focusable type that has no native ring gets the TV focus ring (v1.0.29)', () => {
  // On Android TV the ONLY cue to what the remote is on is the focus ring. The D-pad
  // focusable selector (dpad.js) and the `html.tv …:focus` ring rule (styles.css) are two
  // lists that must stay in step: `summary` and `[href]` are focusable but are neither
  // button/input nor carry a [tabindex] ATTRIBUTE (a native summary's tabIndex is a
  // PROPERTY, not an attribute — `[tabindex]` never matches it), so without their own
  // entry they were focusable-but-INVISIBLE from the remote — the grouped-library sections
  // (v1.0.28) and the privacy link. This pins that both are in the ring rule.
  const css = readFileSync(join(ROOT, 'www', 'css', 'styles.css'), 'utf8');
  const ring = css.slice(css.indexOf('html.tv button:focus'), css.indexOf('{', css.indexOf('html.tv button:focus')));
  assert.ok(ring, 'the html.tv focus-ring rule moved — re-anchor this guard');
  for (const sel of ['summary:focus', '[href]:focus']) {
    assert.ok(ring.includes(sel), `the TV focus ring does not cover ${sel} — it is focusable but invisible on TV`);
  }
});

test('the scheduled lock is device-local timer + synced settings (v1.0.31)', () => {
  // A lock is about THIS device's session — syncing "locked until X" would lock a sibling's
  // device on the same account. So the two live timestamps live in Preferences keyed by
  // profile, and MUST NOT appear in the Drive settings channel. The SETTINGS (after/duration)
  // do sync, like the other per-profile settings.
  const app = MODULES.get('www/js/app.js');
  // the timer keys are prefGet/prefSet only, never getSetting/putSetting
  assert.match(app, /schedlock:.*:armed/, 'the armed-timer pref key is gone');
  assert.match(app, /schedlock:.*:until/, 'the locked-until pref key is gone');
  // the SETTINGS travel through the synced channel
  assert.match(app, /putSetting\(activeProfileId, 'lockAfterMin'/, 'lockAfterMin is not saved to the synced settings');
  assert.match(app, /putSetting\(activeProfileId, 'lockDurationMin'/, 'lockDurationMin is not saved to the synced settings');
  // the live timer must never be serialized to Drive
  const drive = MODULES.get('www/js/drive.js');
  assert.doesNotMatch(drive, /schedlock:/, 'the device-local lock timer leaked into the Drive document');
  // the decision is the pure helper, not re-implemented inline
  assert.match(app, /evalScheduledLock\(/, 'app.js re-implements the lock decision inline');
});

test('the scheduled-lock screen cannot be escaped by the child (v1.0.31)', () => {
  // It swallows hardware-back (like the loading screen), and the ONLY exit is the exit
  // button — hidden entirely under the kiosk, code-gated under the full-tablet lock
  // (v1.0.55, pure lockScreenContainment) — or the discreet parent-code tap.
  // COMMENT-STRIPPED source throughout: the v1.0.55 review caught the first version of
  // these guards anchoring on comments (the exact vacuous-guard trap TESTING.md names).
  const app = CODE.get('www/js/app.js');
  assert.match(app, /nav\.register\('locked',\s*\{\s*onBack:\s*\(\)\s*=>\s*true/,
    "the locked view does not swallow back — a child can navigate out of it");
  const body = fnSlice(app, 'async function showLockedScreen(');
  assert.match(body, /refreshLockContainment\(\)/,
    'showLockedScreen no longer applies containment — the exit button shows regardless of the kiosk');
  const helper = fnSlice(app, 'async function refreshLockContainment(');
  assert.match(helper, /breakContainment\(\)/,
    'the exit button is shown without reading the containment settings');
  assert.match(helper, /locked-exit'\)\.classList\.toggle\('hidden', contain\.hideExit\)/,
    'the exit button is not gated through lockScreenContainment (must hide when kiosk is ON)');
});

test('screen-off pauses the video (v1.0.32) — the lifecycle listener exists and does both halves', () => {
  // Node cannot press a tablet's power button, so this is a source guard (the kind a
  // behavioural test cannot express). Android does NOT pause the WebView: before this
  // listener a playing video kept its soundtrack running behind a dark screen. Proven to
  // fail on a planted regression (listener removed / a half dropped).
  const app = MODULES.get('www/js/app.js');
  const raw = appPauseBody(app);
  assert.ok(raw, 'app.js no longer registers an onAppPause listener — screen-off keeps playing');
  const m = [null, raw];
  // comment lines don't count — the first version of this guard passed with the call
  // commented out, which is exactly the vacuous-guard failure TESTING.md warns about
  const body = m[1].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // save FIRST (it reads the live playhead), then pause. Both halves, this order.
  // v1.0.57: the call takes the state as a second argument (the handler reads the playhead
  // ONCE, before pausing, because the call watcher also needs to know whether the video was
  // actually playing). Matched by PREFIX so that stays flexible — the ORDER below is the
  // invariant, not the argument list.
  const save = body.indexOf('saveWatchPosition(currentWatch');
  const pause = body.indexOf('pauseCurrent()');
  assert.ok(save >= 0, 'the screen-off handler no longer banks the stop point');
  assert.ok(pause >= 0, 'the screen-off handler no longer pauses the player');
  assert.ok(save < pause, 'pause runs before the save — the saved playhead may be stale');
  // and the pause must be IN PLACE — stop() tears the player down, which is the
  // "הסרטון נעלם" the user reported. The handler must not contain a bare stop() call.
  assert.doesNotMatch(body, /\bstop\(\)/, 'the screen-off handler tears the player down');
  // platform.js: the listener really is the INACTIVE half of appStateChange
  const platform = MODULES.get('www/js/platform.js');
  const fn = platform.slice(platform.indexOf('export function onAppPause('));
  assert.match(fn.slice(0, 400), /!s\.isActive/, 'onAppPause no longer keys on isActive:false');
});

test('idle screen-off (v1.0.34): the sleep branch does both halves IN ORDER, in place, and the plumbing is wired', () => {
  // Node cannot wait ten minutes in front of a tablet, so this is a source guard for
  // what the pure tests cannot see: the app-side plumbing. Same discipline as the
  // v1.0.32 screen-off guard above — comment lines don't count, and each clause was
  // proven to fail on a planted regression before landing.
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function tickIdleSleep('));
  const body = fn.slice(0, fn.indexOf('\n}\n'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // the decision is the PURE helper's, fed through the sanitizer that knows
  // never-written ≠ explicit 0 (Number(null) is 0 — the wrong kind of "off")
  assert.match(body, /screenOffMinutes\(/, 'the minutes no longer pass the never-written/0 sanitizer');
  assert.match(body, /evalIdleSleep\(/, 'the tick no longer delegates to the pure decision');
  // the sleep half: save FIRST (reads the live playhead), THEN pause — IN PLACE.
  const save = body.indexOf('saveWatchPosition(currentWatch)');
  const pause = body.indexOf('pauseCurrent()');
  assert.ok(save >= 0, 'the idle sleep no longer banks the stop point');
  assert.ok(pause >= 0, 'the idle sleep no longer pauses the player');
  assert.ok(save < pause, 'pause runs before the save — the saved playhead may be stale');
  // stop() here is the "הסרטון נעלם" bug: the child comes back to a black hole
  assert.doesNotMatch(body, /\bstop\(\)/, 'the idle sleep tears the player down');
  // input is observed at the WINDOW in CAPTURE phase for both touch and remote keys —
  // a handler that stops propagation must not be able to starve the timer
  assert.match(app, /addEventListener\('pointerdown', onUserInput, true\)/,
    'touch no longer counts as user input (capture listener gone)');
  assert.match(app, /addEventListener\('keydown', onUserInput, true\)/,
    'remote keys no longer count as user input — a TV child would be paused mid-episode');
  // the answer tap must consume its WHOLE gesture: hiding the overlay on pointerdown
  // puts the tap-shield under the finger, and the shield acts on the END of a tap —
  // without these the "I'm here" tap PAUSED the video (measured in the browser)
  for (const tail of ['pointerup', 'click', 'pointercancel']) {
    assert.match(app, new RegExp(`addEventListener\\('${tail}', swallowIdleGestureTail, true\\)`),
      `the answer tap's ${tail} is no longer consumed — answering the prompt pauses/toggles the video`);
  }
  // the prompt overlay lives INSIDE #player-wrap — that is the element that goes
  // fullscreen; outside it the question is invisible while a video plays
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  const wrap = html.indexOf('id="player-wrap"');
  const prompt = html.indexOf('id="idle-prompt"');
  const hudEnd = html.indexOf('class="player-hud"');
  assert.ok(wrap >= 0 && prompt > wrap && hudEnd > prompt,
    'the "עדיין צופים?" overlay left #player-wrap — invisible in fullscreen');
});

test('NOTHING can attach a sources sheet any more (v1.0.38)', () => {
  // The migration DELETES the family's sheet files, so a re-attached URL would point at a
  // file nothing maintains — and it would undo the migration on the next launch. The wizard,
  // its view, the connect door and the copy button are all gone.
  const app = MODULES.get('www/js/app.js');
  const html = readFileSync(join(ROOT, 'www/index.html'), 'utf8');
  for (const gone of ['openSheetSetup', 'connectWizardSheet', 'wizardGated', 'wizardCreateSheet',
    'joinExistingSheet', 'createSourceSheet', 'listAppSheets', 'sheetsetup']) {
    assert.ok(!app.includes(gone), `app.js still references ${gone}`);
  }
  for (const gone of ['view-sheet-setup', 'sheetsetup-', 'remote-connect', 'remote-copy']) {
    assert.ok(!html.includes(gone), `index.html still has ${gone}`);
  }
  // a nav registration for a view that no longer exists is a silent back-handling hole
  assert.doesNotMatch(app, /nav\.register\('sheet-setup'/, 'the wizard nav registration survived its view');
  // creating a profile must land IN the app, not in a deleted screen
  const cn = app.slice(app.indexOf('async function createNewProfile('));
  const body = cn.slice(0, cn.indexOf('\n}\n'));
  assert.match(body, /activateProfile\(p\.id\)/, 'profile creation no longer enters the app');
  // and no scope can change any more — that is what makes the sunset's libraryId rule real
  for (const [p, b2] of CODE) {
    assert.doesNotMatch(b2, /moveScope\s*\(|planScopeAdoption\s*\(|adoptLibraryScope\s*\(/,
      `${p} can still move a library scope`);
  }
});

test('the picker exit button cannot walk through an armed kiosk (v1.0.32)', () => {
  // askExit also serves the BOOT profile picker, where no profile is active yet — but
  // the kiosk was armed from the LAST ACTIVE one (the launch rule). Reading only the
  // live global would let the picker's exit button walk straight through an armed lock
  // (the real case: a cold-start share showing the picker on a locked device).
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function askExit('));
  const body = fn.slice(0, fn.indexOf('\n}\n'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(body, /exitLockOn\(activeProfileId \|\| await prefGet\('activeProfile'\)\)/,
    'askExit no longer falls back to the stored profile — the boot picker bypasses the kiosk');
  // and the picker really has the button wired to this flow
  assert.match(app, /\$\('profiles-exit'\)\.addEventListener\('click', askExit\)/,
    'the picker exit button is not bound to askExit');
});

/* ---------------- kiosk pin/unpin discipline (v1.0.36) ---------------- */

test('profile activation NEVER unpins, and resume re-arms the lock (v1.0.36)', () => {
  // stopLockTask() raises the DEVICE keyguard on many devices ("lock device when
  // unpinning" is a system setting the app can neither read nor change) — so
  // applyExitLock's old else-branch locked the whole TABLET when switching from a
  // locked child to an unlocked sibling (field report). The activation path may only
  // PIN; the unpin belongs to the code-gated exits (pinGatedExit: askExit + the break
  // door, v1.0.55), the settings toggle, the native installer, and the end of a
  // scheduled break (clearScheduledLock — breakPinHeld ownership + the kiosk veto).
  const app = MODULES.get('www/js/app.js');
  const start = app.indexOf('async function applyExitLock()');
  assert.ok(start > 0, 'applyExitLock not found');
  const body = app.slice(start, app.indexOf('\n}', start));
  assert.ok(!body.includes('unlockTask'),
    'applyExitLock unpins again — profile switches will raise the device keyguard');
  assert.ok(body.includes('lockTask'), 'applyExitLock no longer pins at all');
  // The installer unpins natively; a CANCELLED install resumes back into the app still
  // unpinned on a locked profile — resume must re-arm or the kiosk is silently off.
  const resumeStart = app.indexOf('onAppResume(async () => {');
  assert.ok(resumeStart > 0, 'onAppResume block not found');
  const resumeBody = app.slice(resumeStart, app.indexOf('\n  });', resumeStart));
  assert.ok(resumeBody.includes('applyExitLock'),
    'resume no longer re-arms the exit lock — a cancelled update leaves the kiosk off');
});

test('native pin/unpin are gated on lock-task state and the installer unpins — BOTH java copies (v1.0.36)', () => {
  for (const p of ['android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java',
                   'native-reference/KidsNativePlugin.java']) {
    const java = readFileSync(join(ROOT, p), 'utf8');
    assert.ok(java.includes('private boolean inLockTask()'), `${p}: the inLockTask gate is gone`);
    const lock = java.slice(java.indexOf('public void lockTask'), java.indexOf('public void isTaskLocked'));
    assert.ok(lock.includes('if (inLockTask())') && lock.includes('if (!inLockTask())'),
      `${p}: lockTask/unlockTask no longer gate on the current state — redundant unpins keyguard the tablet`);
    // A PINNED task cannot start the system installer (Android refuses new tasks over
    // lock-task mode), so with the kiosk ON the update button did nothing.
    const inst = java.slice(java.indexOf('public void installApk'), java.indexOf('private void startInstaller'));
    assert.ok(inst.includes('stopLockTask'),
      `${p}: installApk no longer unpins first — updates are dead under the kiosk lock`);
  }
});

/* ---------------- channel-deletion tombstones (v1.0.36) ---------------- */

test('a channel deletion writes its tombstone FIRST, and a move never writes one (v1.0.36)', () => {
  // The pure halves (merge filter, apply plan) are behavior-tested in gdrive.test.mjs;
  // this pins the IDB wiring the node suite cannot execute.
  const db = MODULES.get('www/js/db.js');
  const fnAt = db.indexOf('export async function deleteLibraryChannel(');
  assert.ok(fnAt > 0, 'deleteLibraryChannel not found');
  const body = db.slice(fnAt, db.indexOf('\n}\n', fnAt));
  const tombAt = body.indexOf('putDeletedChannels');
  const rowDelAt = body.indexOf('s.delete([libraryId, channelId])');
  assert.ok(tombAt > 0, 'deleteLibraryChannel no longer writes a tombstone — deletions resurrect on the next pull');
  assert.ok(rowDelAt > tombAt,
    'the tombstone must be written BEFORE the row delete (a crash in between must keep the intent)');
  // v1.0.38: moveScope was the other `tombstone: false` caller and is gone.
  // v1.0.45: snapshot.js joined, DELIBERATELY — importing a snapshot applies an external
  // document's tombstones, exactly like a Drive pull, and restamping them with Date.now()
  // there would make this device's copy instantly newer than the peer's and the two would
  // bump each other forever. What must never reach this branch is a PARENTAL deletion,
  // which is why each caller is also required to write the merged map first.
  const drive = MODULES.get('www/js/drive.js');
  // CALLERS only: db.js is where the parameter is DECLARED (`{ tombstone = true }`) and
  // documented, which is not a call site.
  const falseCallers = [...CODE.entries()]
    .filter(([k, b2]) => k !== 'www/js/db.js' && /tombstone: false/.test(b2)).map(([k]) => k);
  assert.deepEqual(falseCallers.sort(), ['www/js/drive.js', 'www/js/snapshot.js'],
    `tombstone:false is only for APPLYING an external doc's tombstones, found: ${falseCallers.join(', ')}`);
  assert.match(drive, /tombstone: false/, 'the apply path no longer preserves a peer tombstone');
  // Every such caller must persist the merged tombstone map BEFORE it deletes anything —
  // otherwise "the tombstone already exists" is a claim the code does not actually honour.
  for (const mod of falseCallers) {
    const body = CODE.get(mod);
    for (const [put, del] of [['putDeletedChannels(', 'tombstone: false'], ['putDeletedSiteEntries(', 'tombstone: false']]) {
      const p = body.indexOf(put);
      if (p < 0) continue;
      assert.ok(p < body.indexOf(del, p) || body.indexOf(del) > p,
        `${mod}: the merged tombstone map must be written before a ${del} delete`);
    }
  }
});

test('applyRemoteDoc routes libraryChannels through planChannelApply (v1.0.36)', () => {
  // pullDrive applies the RAW remote doc, so without this a stale doc still carrying a
  // deleted subscription re-puts it — the exact field report ("the channel comes back").
  const drive = MODULES.get('www/js/drive.js');
  const at = drive.indexOf('async function applyRemoteDoc(');
  assert.ok(at > 0, 'applyRemoteDoc not found');
  const body = drive.slice(at, drive.indexOf('\n}\n', at));
  assert.match(body, /planChannelApply\(/, 'applyRemoteDoc no longer consults the tombstone plan');
  assert.match(body, /putDeletedChannels\(/, 'the merged tombstones are not persisted — an interrupted apply forgets');
  assert.match(body, /for \(const lc of chPlan\.puts\)/,
    'libraryChannels are applied straight from the doc again, bypassing the tombstone filter');
  // the deletions must NOT restamp: the peer's own `at` is what converges
  assert.match(body, /deleteLibraryChannel\(libId, chId, \{ tombstone: false \}\)/,
    'apply-side deletions restamp the tombstone — the two devices will bump each other forever');
});

/* ---------------- the silent import ceiling (v1.0.37) ---------------- */

test('the import caps have a LIVE consumer — config.js is not decoration (v1.0.37)', () => {
  // THE TRAP THAT MADE THIS BUG SURVIVE FOUR RELEASES: config.js exported
  // MAX_ITEMS_PER_CHANNEL / MAX_ITEMS_TOTAL and NOTHING imported them, while the binding
  // values were literals frozen into every profile's `sources` row at creation. Editing
  // config.js changed nothing, no parent could raise the ceiling, and a library at 5000
  // silently imported zero from every new channel. A constant nobody reads is a lie.
  const consumers = [...MODULES.entries()]
    .filter(([p, s]) => p !== 'www/js/config.js' && /MAX_ITEMS_TOTAL/.test(s))
    .map(([p]) => p);
  assert.ok(consumers.length > 0, 'MAX_ITEMS_TOTAL is dead again — the caps are frozen per profile');
  assert.ok(consumers.includes('www/js/plan.js'), 'effectiveCaps must be the one place the caps come from');
});

test('the sync enforces effectiveCaps, never the frozen sources row (v1.0.37)', () => {
  const sync = MODULES.get('www/js/sync2.js');
  const at = sync.indexOf('planMutations({');
  assert.ok(at > 0, 'planMutations call not found');
  const call = sync.slice(at, sync.indexOf('});', at));
  assert.match(call, /caps: effectiveCaps\(src\)/,
    'the caps come from the stored row again — existing profiles stay frozen at their creation-day ceiling');
  assert.doesNotMatch(call, /src\.maxItemsTotal|src\.maxItemsPerChannel/,
    'the stored literals are back in the cap path');
});

test('a dropped import reaches the parent: sync → diagnose → message (v1.0.37)', () => {
  // The counts were computed since the overhaul and thrown away at every hop, which is
  // why an import that dropped 98 of 98 candidates still reported "the channel is empty".
  const sync = MODULES.get('www/js/sync2.js');
  const app = MODULES.get('www/js/app.js');
  const ret = sync.slice(sync.lastIndexOf('ok: true, added:'));
  assert.match(ret.slice(0, ret.indexOf('};')), /drops: plan\.drops/,
    'syncLibrary no longer returns the run\'s drops — the information dies in the sync again');

  const impAt = app.indexOf('async function importChannelAndAsk(');
  const imp = app.slice(impAt, app.indexOf('\n}\n', impAt));
  assert.match(imp, /await syncLibrary\([^)]*\)/, 'the forced sync call moved');
  assert.match(imp, /drops = res && res\.drops/, 'importChannelAndAsk discards the sync result again');
  assert.match(imp, /diagnoseEmptyChannel\(channelId, count, drops\)/,
    'the drops never reach the diagnosis, so a zero cannot name its cause');

  const diagAt = app.indexOf('async function diagnoseEmptyChannel(');
  const diag = app.slice(diagAt, app.indexOf('\n}\n', diagAt));
  assert.match(diag, /sourceDrops\(drops, channelId\)/, 'the diagnosis no longer reads the attribution');
  // BOTH return paths must carry them. The early `if (count)` return is the PARTIAL cap —
  // "12 waiting" out of 98 reads as the whole channel — and is the easy one to lose.
  const returns = diag.split('return ').slice(1);
  assert.equal(returns.length, 2, 'diagnoseEmptyChannel changed shape — re-anchor this guard');
  for (const [i, r] of returns.entries()) {
    assert.match(r, /capped/, `return #${i + 1} of diagnoseEmptyChannel no longer reports the cap`);
    assert.match(r, /denied/, `return #${i + 1} of diagnoseEmptyChannel no longer reports the tombstones`);
  }
});

test('a previously-removed backlog has a way back, and it is the PARENT who says yes (v1.0.37)', () => {
  // A deny tombstone is revoked by exactly one thing: the sheet re-adding the key
  // (v1.0.10). A channel video has no sheet row, so a single in-place delete — or the
  // 30-day purge of a rejected record (v1.0.26) — made the channel unimportable forever.
  // It must NOT be automatic: a parent who removed three bad videos must not get them
  // back for re-subscribing (the v1.0.23 rule).
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function offerDeniedRestore(');
  assert.ok(at > 0, 'the restore offer is gone — a removed backlog is a permanent dead end again');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /confirmKid\(/, 'the restore no longer ASKS — it must never revoke tombstones silently');
  assert.match(body, /if \(!yes\) return false/, 'a declined restore must change nothing');
  assert.match(body, /unDeny\(/, 'the restore does not actually revoke the tombstones');
  const askAt = body.indexOf('confirmKid(');
  assert.ok(body.indexOf('unDeny(') > askAt, 'the tombstones are revoked BEFORE the parent answers');
  // wired into both add paths — and since v1.0.61 REGARDLESS of how many videos arrived.
  // v1.0.37 gated it on `!count`, so a channel where 12 of 40 videos had been removed here
  // before imported the 28 and told the parent about the 12 NOWHERE: channelAddOutcome
  // returns from its `if (n)` branch long before it reaches the denied clause. The user
  // asked for removed content to be re-addable, which it cannot be if nobody is told.
  assert.equal((app.match(/offerDeniedRestore\(/g) || []).length, 3,
    'the restore must be offered by the channel AND the playlist add path (plus its definition)');
  for (const [what, id] of [['channel', 'channelId'], ['playlist', 'plId']]) {
    const call = new RegExp(`(\\S[^\\n]*)await offerDeniedRestore\\(${id}, empty\\)`);
    const m = app.match(call);
    assert.ok(m, `the ${what} add path no longer offers the restore at all`);
    assert.doesNotMatch(m[1], /!\s*count/,
      `the ${what} path offers the restore only when NOTHING arrived — a partial denial is then reported nowhere`);
  }
});

/* ---------------- the links file (v1.0.38) ---------------- */

test('the links import goes through classifySourceRow, never a raw line', () => {
  // classifyLink/classifySourceRow is THE safety boundary — every link that enters the
  // library passes through it. A bulk importer that split lines itself would be the one
  // door that skips it, on input the parent got from someone else.
  const lf = MODULES.get('www/js/linksfile.js');
  assert.ok(lf, 'linksfile.js is gone');
  const at = lf.indexOf('export function parseLinksFile(');
  assert.ok(at > 0, 'parseLinksFile is gone');
  const body = lf.slice(at, lf.indexOf('\n}\n', at));
  assert.match(body, /parseSourceRows\(parseCsv\(/,
    'parseLinksFile no longer tokenizes with parseCsv + parseSourceRows — the grammar was re-implemented');
  // and it must refuse an unreadable body BEFORE it can read as empty
  const htmlAt = body.indexOf('looksLikeHtml(');
  const parseAt = body.indexOf('parseSourceRows(');
  assert.ok(htmlAt > 0 && htmlAt < parseAt,
    'looksLikeHtml must run BEFORE parsing, or a saved permission page reads as "0 links"');
  assert.doesNotMatch(lf, /split\(\s*\/\[\\t,\]/, 'a hand-rolled delimiter split is back');
  // The module BUILDS canonical URLs (that is canonicalLinkFor's whole job) but must never
  // PARSE one — parsing is classify.js's. So every youtube.com literal must live inside
  // canonicalLinkFor, and none of them may be fed to .match()/.test().
  // Comments are stripped first: this is a rule about CODE, and the doc comment on
  // canonicalLinkFor explains at length why a stored youtu.be srcUrl is not used.
  const code = lf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const buildAt = code.indexOf('export function canonicalLinkFor(');
  const buildEnd = code.indexOf('\n}\n', buildAt);
  const outside = code.slice(0, buildAt) + code.slice(buildEnd);
  assert.ok(!/youtube\.com|youtu\.be/.test(outside),
    'a YouTube URL literal escaped canonicalLinkFor — link building must stay in one place');
  assert.ok(!/\/[^\n/]*youtu[^\n/]*\/[gimsuy]*\s*\.(test|exec)|\.match\(\s*\/[^\n/]*youtu/.test(lf),
    'linksfile.js parses a YouTube link with its own regex — classifySourceRow owns that');
});

test('the links importer does NOT route through the per-item add paths', () => {
  // addClassifiedRow's channel branch raises importChannelAndAsk (loading screen + the
  // three-way approval dialog + a 90s finishing wait) PER CHANNEL, and its video branch
  // fires refreshAfterAdd + renderHome + a push PER VIDEO. A 16-channel file would raise
  // 16 dialogs; a 300-line file, 300 forced syncs.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function linksImportFromText(');
  assert.ok(at > 0, 'the links importer is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.ok(!body.includes('importChannelAndAsk('),
    'the importer calls importChannelAndAsk — that is one dialog per channel');
  assert.ok(!body.includes('addClassifiedRow('),
    'the importer calls addClassifiedRow — that is one forced sync per video');
  // ONE forced sync, and it must be forced: a non-forced call can JOIN a launch run that
  // already read the library (planSyncDispatch, the v1.0.25 field bug).
  assert.equal((body.match(/refreshAfterAdd\(/g) || []).length, 1,
    'the import must refresh exactly ONCE for the whole file');
  assert.match(body, /wait: true/, 'the import refresh must be the awaited one — it owns a waiting screen');
  // the denied question is asked ONCE, outside any loop over rows
  assert.equal((body.match(/deniedReAddPrompt\(/g) || []).length, 1,
    'the denied question must be asked once for the whole file, not per row');
  assert.match(body, /source: 'import', count: hits\.length/,
    'the denied question must carry the real count — that is the whole point of asking once');
});

test('a re-added deleted video is ANSWERED for, never silently destroyed (v1.0.38)', () => {
  // THE HOLE THIS CLOSES. A deny tombstone was revocable by exactly one thing — the SHEET
  // re-adding the key (planSheetMirror.unDenyKeys) — and drive.mergeDbFiles DELETES any
  // video whose tombstone is active from the merged document. addClassifiedRow never
  // consulted the deny set at all, so a re-pasted deleted video was written, shown to the
  // child, and destroyed by the next pull on every device.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function addClassifiedRow(');
  assert.ok(at > 0, 'addClassifiedRow is gone');
  const body = app.slice(at, app.indexOf("\n  if (row && row.kind === 'channel')", at));
  const gate = body.indexOf('offerDeniedReAdd(');
  const write = body.indexOf('db.putVideos(');
  assert.ok(gate > 0, 'the video add path no longer checks the deny list — the v1.0.38 hole is back open');
  assert.ok(write > 0 && gate < write, 'the deny check must run BEFORE the record is written');

  // the helper itself: it must ASK, and only un-deny on a yes
  const hAt = app.indexOf('async function offerDeniedReAdd(');
  assert.ok(hAt > 0, 'offerDeniedReAdd is gone');
  const helper = app.slice(hAt, app.indexOf('\n}\n', hAt));
  assert.match(helper, /confirmKid\(/, 'the re-add must ASK — never revoke a tombstone silently');
  assert.match(helper, /if \(!yes\) return false/, 'a declined re-add must not add the video');
  assert.ok(helper.indexOf('unDeny(') > helper.indexOf('confirmKid('),
    'the tombstone is revoked BEFORE the parent answers');
  // BOTH scopes: a key can carry a tombstone in the shared library and in the personal one
  assert.match(helper, /profScope\(activeProfileId\)/,
    'only one scope is un-denied — the other tombstone survives and re-deletes the video');
});

test('a SHARE of removed content asks — and only AFTER the parent code (v1.0.61)', () => {
  // Until v1.0.61 a share of a previously-deleted video answered 'denied' and stopped. The
  // user asked for it to be re-addable, so share.js now asks — but WHERE it asks is the
  // safety rule: a share arrives from ANY app, on a tablet a child is holding. Asking before
  // the PIN would hand the child a one-tap way to revoke a deletion tombstone (and a revoked
  // tombstone travels to every device). The question therefore lives BELOW the decision.
  const share = MODULES.get('www/js/share.js');
  assert.match(share, /deniedHandler/, 'share.js no longer accepts a denied handler — the refusal is silent again');
  assert.match(share, /askDenied\s*=\s*deniedHandler/, 'the handler is accepted but never installed');
  const askAt = share.indexOf('askDenied(');
  assert.ok(askAt > 0, 'nothing ever calls the denied handler');
  const decideAt = share.indexOf('decision = await interactive(c)');
  assert.ok(decideAt > 0, 'the interactive decision moved — re-anchor this guard');
  assert.ok(askAt > decideAt,
    'the re-add question is asked BEFORE the parent code — a child could revoke a deletion by sharing the video back');
  assert.match(share.slice(askAt - 400, askAt), /if \(decision === 'discard'\) return 'cancelled'/,
    'a parent who CANCELLED the share is still asked to revive the tombstone');
  // and app.js must actually pass one, or the whole path is dead code
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /deniedHandler: \([^)]*\) => offerDeniedReAdd\(/,
    'app.js does not wire the share denied handler — share.js would silently refuse again');
});

test('a Drive folder import asks ONCE for everything it refused (v1.0.61)', () => {
  // A tree walk can meet dozens of previously-removed files at once. One question for the
  // batch is the links-file precedent; dozens of dialogs would be a parent tapping "yes"
  // without reading. The keys come from the PLAN (deniedKeys) because the caller cannot
  // recompute them — the walk that produced them is a network operation.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function importDriveFolder(');
  assert.ok(at > 0, 'importDriveFolder is gone');
  const body = app.slice(at, app.indexOf('\n  }\n\n  async function ', at));
  assert.match(body, /plan\.deniedKeys/, 'the import ignores the refused keys again — a removed file is skipped in silence');
  assert.match(body, /deniedReAddPrompt\(/, 'the import grew its own dialog text — the words live in plan.js');
  assert.match(body, /count: plan\.deniedKeys\.length/, 'the question does not carry the honest count');
  const askAt = body.indexOf('deniedReAddPrompt(');
  const revokeAt = body.indexOf('db.unDeny(');
  assert.ok(revokeAt > askAt, 'the tombstones are revoked BEFORE the parent answers');
  assert.match(body.slice(askAt, revokeAt), /await confirmKid\(/, 'the prompt is built but never shown');
  // ⚠️ anchored PAST the revoke on purpose: `plan = planDriveTreeImport(` also matches the
  // import's own opening `let plan = ...`, so the naive version of this guard stayed green
  // with the whole re-run deleted (caught by planting exactly that).
  assert.match(body.slice(revokeAt), /plan = planDriveTreeImport\(/,
    'the plan is not re-run after the revoke — the files would stay skipped despite the yes');
  // only on a FIRST import: a 30-minute refresh must never raise a dialog at nobody
  assert.match(body, /plan\.deniedKeys\.length && first/,
    'the background refresh can raise this dialog — it runs unattended every 30 minutes');
});

test('both revive dialogs get their words from ONE place (v1.0.38)', () => {
  // There are exactly two acts that revoke a deletion tombstone — re-adding one key
  // (deniedReAddPrompt) and restoring a channel's backlog (deniedRestorePrompt) — and their
  // wording must not drift into describing the same act differently. It already had: for one
  // commit `offerDeniedRestore` kept an inline copy while the pure helper sat unused, which is
  // also the "a helper with no consumer is a lie" smell (v1.0.37).
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function offerDeniedRestore(');
  assert.ok(at > 0, 'offerDeniedRestore is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /deniedRestorePrompt\(/, 'offerDeniedRestore grew its own dialog text again');
  // no Hebrew dialog literal may live in either revive path — plan.js owns them
  for (const frag of ['לשחזר', 'שחזרו', 'להשאיר מוסר']) {
    assert.ok(!body.includes(frag), `offerDeniedRestore hard-codes "${frag}" — it belongs in plan.js`);
  }
  const plan = MODULES.get('www/js/plan.js');
  for (const fn of ['deniedReAddPrompt', 'deniedRestorePrompt']) {
    assert.match(plan, new RegExp('export function ' + fn + '\\('), `plan.${fn} is gone`);
  }
});

test('a snapshot import never re-introduces a forgotten sheet (v1.0.38)', () => {
  // An OLD snapshot still carries sheetUrl/sheetHash/sheetFolderId. Adopting one wholesale
  // put a sheetUrl back on a profile that had already migrated — inert today, but able to
  // outlive sunset.js itself, which is exactly what its deadline branch exists to prevent.
  // libraryId must SURVIVE: it is what puts the imported records where the profile looks.
  const snap = MODULES.get('www/js/snapshot.js');
  const at = snap.indexOf('const mySrc = await getSources(profileId);');
  assert.ok(at > 0, 'the snapshot sources adoption moved — re-anchor this guard');
  const body = snap.slice(at, at + 600);
  assert.match(body, /sheetUrl, sheetHash, sheetFolderId/, 'the sheet fields are adopted again');
  assert.ok(!/putSources\(\{ \.\.\.snap\.sources/.test(snap),
    'snap.sources is adopted wholesale again — that carries the sheet fields back in');
  assert.ok(!/libraryId[^\n]*\.\.\.rest|libraryId,/.test(body),
    'libraryId must NOT be stripped — the imported records would be unreachable');
});

test('EVERY unDeny in the UI layer sits next to a question (v1.0.38)', () => {
  // With the sheet gone there are exactly two sanctioned revocation paths, and both are an
  // explicit parental answer: offerDeniedReAdd (one key) and offerDeniedRestore (a
  // channel's backlog). A third, unconditional one would make deletion meaningless.
  for (const p of ['www/js/app.js', 'www/js/share.js', 'www/js/linksfile.js']) {
    const body = MODULES.get(p) || '';
    const re = /unDeny\(/g;
    let m;
    while ((m = re.exec(body))) {
      const around = body.slice(Math.max(0, m.index - 1400), m.index + 400);
      assert.ok(/deniedReAddPrompt|offerDeniedRestore|offerDeniedReAdd|reviveKeys/.test(around),
        `${p}: an unDeny at index ${m.index} is not guarded by a parental answer`);
    }
  }
});

test('the export WRITES the file before it shares it, and shares the FILE first (v1.0.38)', () => {
  // The write is the artifact a device transfer needs and the only thing that survives a
  // cancelled share; the share is how it leaves the tablet at all, because Android 11+
  // hides Android/data from the Files app. Sharing the list as TEXT is the last rung —
  // EXTRA_TEXT is a Binder payload receivers truncate, and a 400-link message is not a
  // file the other device can import.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function linksExport(');
  assert.ok(at > 0, 'linksExport is gone');
  const body = app.slice(at, app.indexOf('\nlet lastLinksExportText', at));
  const write = body.indexOf('fsWriteTextExternal(');
  const shareF = body.indexOf('shareFile(');
  assert.ok(write > 0, 'the export no longer writes a file');
  assert.ok(shareF > write, 'the share must come AFTER the write — a cancelled share must leave the file');
  assert.ok(!body.includes('shareText('), 'shareText must not be a rung of the export itself');
  // the empty library must be refused, not exported as a blank file
  assert.match(body, /delivery: 'nothing'/, 'an empty library must be named, not exported as an empty file');
});

test('the native shareFile exists in BOTH java copies and its FileProvider path is declared', () => {
  // ARCHITECTURE.md calls native-reference/ the canonical rebuild copy; a method that lives
  // in only one of them is a rebuild that silently loses the feature.
  for (const p of ['android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java',
                   'native-reference/KidsNativePlugin.java']) {
    const java = readFileSync(join(ROOT, p), 'utf8');
    const at = java.indexOf('public void shareFile(PluginCall call)');
    assert.ok(at > 0, `${p}: shareFile is missing — the links export cannot leave the device`);
    const body = java.slice(at, java.indexOf('\n    }\n', java.indexOf('try {', at)));
    assert.match(body, /FileProvider\.getUriForFile/,
      `${p}: a raw file:// URI throws FileUriExposedException on API 24+`);
    assert.match(body, /EXTRA_STREAM/, `${p}: shareFile attaches no file`);
    assert.match(body, /FLAG_GRANT_READ_URI_PERMISSION/,
      `${p}: without the grant flag the receiving app opens an empty document`);
  }
  // …and the path must be whitelisted, in both copies, or getUriForFile throws
  for (const p of ['android/app/src/main/res/xml/file_paths.xml', 'native-reference/file_paths.xml']) {
    const xml = readFileSync(join(ROOT, p), 'utf8');
    assert.match(xml, /<external-files-path[^>]*path="exports\/"/,
      `${p}: exports/ is not declared — FileProvider.getUriForFile throws for the export path`);
  }
});

test('a links import cannot mint a duplicate profile name (v1.0.38)', () => {
  // A PROFILE NAME IS UNIQUE PER GOOGLE ACCOUNT, NOT PER DEVICE (v1.0.22): two devices each
  // creating "נועם" splits that child's gift progress and personal videos while the parent
  // sees two identical avatars. The import's "create a new profile from this file" branch is
  // a NEW way to mint one and must not be the path that skips the check.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function profileNameClash\(/, 'the shared name gate is gone');
  const gate = app.slice(app.indexOf('async function profileNameClash('));
  assert.match(gate.slice(0, 900), /profileNameConflict\(/, 'the gate no longer uses the pure conflict rule');
  assert.match(gate.slice(0, 900), /pullDrive\(/, 'the gate no longer pulls first — a peer name would be invisible');
  const at = app.indexOf('async function linksImportFromText(');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /profileNameClash\(/, 'the create-a-profile branch skips the uniqueness gate');
  assert.ok(body.indexOf('profileNameClash(') < body.indexOf('createProfile('),
    'the name is checked AFTER the profile is created');
  // and createNewProfile must share it rather than keep a private copy
  const cn = app.slice(app.indexOf('async function createNewProfile('), app.indexOf('async function activateProfile('));
  assert.match(cn, /profileNameClash\(/, 'createNewProfile grew a private copy of the gate again');
});

test('the library SCOPE travels with each profile in the Drive doc (v1.0.38)', () => {
  // Without this a fresh device restoring a MIGRATED family gets the profiles and every
  // libraries[…] blob but no sources row — ensureSources then mints lib:p:<id> while the
  // content sits under the old lib:<hash>. Empty home, full database, no tool to fix it
  // (moveScope is gone in this release).
  const drive = MODULES.get('www/js/drive.js');
  const at = drive.indexOf('async function buildLocalDoc(');
  assert.ok(at > 0, 'buildLocalDoc is gone');
  // Bounded to the profileSources block. The first version ended the slice at `\n  return {`,
  // which does not occur after buildLocalDoc at all — indexOf answered -1, slice(at, -1) took
  // the REST OF THE FILE, and the libraries[] `sheetUrl: src.sheetUrl || null` two lines
  // below satisfied every assertion. A slice that silently widens to the whole file is a
  // guard that pins nothing; caught by re-checking the plant.
  const end = drive.indexOf('const lib = src && src.libraryId;', at);
  assert.ok(end > at, 'the buildLocalDoc slice lost its end boundary');
  const build = drive.slice(at, end);
  assert.match(build, /profileSources\[p\.id\] = \{[\s\S]{0,200}libraryId:/,
    'profileSources no longer carries libraryId — a restored profile cannot find its scope');
  assert.ok(!/if \(src && src\.sheetUrl\) \{\s*\n\s*profileSources/.test(build),
    'profileSources is written only for sheet-backed profiles again — the map empties after the migration');
  // the restore side must not reinstate the guard that skipped sheet-less entries
  assert.ok(!/if \(!ps \|\| !ps\.sheetUrl\) continue/.test(drive),
    'the restore branch skips sheet-less entries again — that IS the empty-home bug');
  assert.match(drive, /libraryId: resolveRestoredLibraryId\(/,
    'the restore no longer routes through the pure resolver');

  // A migrated entry's sheetUrl must be NULL, and this has to be checked HERE rather than in
  // a unit test: a gdrive.test.mjs case hands serializeDb a hand-built profileSources, so it
  // pins the FIXTURE and not the production expression — the same trap that made
  // libraryChannels.updatedAt provably order-dependent while the suite stayed green
  // (v1.0.22). buildLocalDoc reads IndexedDB and cannot be unit-tested at all.
  // WHY IT MATTERS: a v1.0.37 device's own `if (!ps.sheetUrl) continue` is the entire reason
  // the new document is harmless to it. A truthy sentinel there and the old app derives a
  // scope from garbage.
  assert.match(build, /sheetUrl: src\.sheetUrl \|\| null,/,
    'buildLocalDoc no longer writes a NULL sheetUrl for a migrated profile — an older app would read the sentinel as a real sheet');
});

test('the orphan sweep is an UNCONDITIONAL STAGE of every sync (v1.0.38)', () => {
  // THE BUG: planOrphanGC only ever ran inside applySheetMirror, gated on `if (sheetParsed)`
  // — so a profile with NO sheet never swept, which is the normal case since v1.0.32 and the
  // ONLY case after this release. A peer deleting a subscription sends the v1.0.36 tombstone,
  // applyRemoteDoc deletes the row, and nothing deleted the videos: the child kept a folder
  // full of a channel nobody subscribes to, forever.
  const sync = MODULES.get('www/js/sync2.js');
  const dsAt = sync.indexOf('async function doSync(');
  assert.ok(dsAt > 0, 'doSync is gone');
  const body = sync.slice(dsAt);
  const subsAt = body.indexOf('const allSubs = await listLibraryChannels(lib)');
  const gcAt = body.indexOf('gcOrphans(lib)');
  const rssAt = body.indexOf("report('rss'");
  assert.ok(subsAt > 0 && gcAt > 0 && rssAt > 0, 'one of the stage anchors moved');
  assert.ok(gcAt > subsAt, 'the sweep runs before the subscription list is known');
  assert.ok(gcAt < rssAt,
    'the sweep runs AFTER the fetch stages — the sync would spend network on channels it is about to sweep');
  // and it must not be gated on a sheet parse ever again
  const stage = body.slice(subsAt, rssAt);
  assert.doesNotMatch(stage, /if \(sheetParsed\)/,
    'the sweep is gated on a sheet parse again — that is the bug this stage fixes');
  // the valve is what makes an unconditional sweep safe on an old install
  assert.match(sync, /orphanSweepValve\(/, 'the sweep lost its valve — a first pass can churn against the Drive doc');
  const gcFn = sync.slice(sync.indexOf('export async function gcOrphans('));
  assert.match(gcFn.slice(0, 1200), /if \(!valve\.sweep\)/, 'gcOrphans ignores the valve');

  // the channel-remove button goes through removeSubscription, not the mirror
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /removeSubscription\(libScope, lc\.channelId\)/,
    'the channel 🗑️ no longer routes through removeSubscription');
  const rs = sync.slice(sync.indexOf('export async function removeSubscription('));
  assert.match(rs.slice(0, 400), /deleteLibraryChannel\(/,
    'removeSubscription does not unsubscribe — the v1.0.36 tombstone is written inside it');
  assert.match(rs.slice(0, 400), /gcOrphans\(/, 'removeSubscription leaves the videos orphaned');

  // a parked sweep must be SAID, not just recorded: a meta key nobody reads is a lie (v1.0.37)
  assert.match(app, /gcAlert:/, 'nothing surfaces a parked sweep to the parent');
});

/* ---------------- the rolling window (v1.0.39) ---------------- */

test('THE SYNC NEVER DELETES FOR THE WINDOW — it has no consumer at all (v1.0.39)', () => {
  // The whole safety model of this feature: planChannelWindow PROPOSES, and the only code
  // that deletes runs behind a parent's confirm. If the sync ever starts consuming the
  // proposal, the child's videos begin disappearing in the background — which is exactly
  // what the user asked NOT to happen ("tell me first, let me mark what to keep").
  for (const [p, s] of MODULES) {
    // plan.js declares the planner, app.js holds the review, db.js DEFINES the bulk delete
    if (p === 'www/js/plan.js' || p === 'www/js/app.js') continue;
    assert.ok(!/planChannelWindow/.test(s),
      `${p} reaches into the rolling window — only the parent-facing review may act on it`);
    if (p === 'www/js/db.js') continue; // its definition, not a call
    assert.ok(!/deleteVideosWithTombstones/.test(s),
      `${p} performs a bulk prune — only the parent-facing review may delete for the window`);
  }
  const sync = MODULES.get('www/js/sync2.js');
  assert.ok(!/keepNewest|keepForever/.test(sync),
    'sync2.js now knows about the window — the proposal must stay out of the background pipeline');
});

test('the window review DELETES ONLY behind a confirm, and marks favourites FIRST (v1.0.39)', () => {
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function reviewChannelWindow(');
  assert.ok(at > 0, 'the rolling-window review is gone');
  const body = app.slice(at, app.indexOf('\n}\n\nasync function refreshChannelsList', at));
  const askAt = body.indexOf('confirmKid(');
  const delAt = body.indexOf('deleteVideosWithTombstones(');
  const markAt = body.indexOf('markKeepForever(');
  assert.ok(askAt > 0, 'the review no longer ASKS before deleting');
  assert.ok(delAt > askAt, 'the deletion runs BEFORE the parent confirms it');
  assert.match(body, /if \(!yes\)/, 'a declined confirm must change nothing');
  // The marks are written first on purpose: a crash in between must leave the favourites
  // protected, never leave them deletable with the deletion already committed.
  assert.ok(markAt > 0 && markAt < delAt,
    'the keep-forever marks must be written BEFORE the deletion');
  // …and the tombstone form is required: a raw delete is pure absence, and every Drive
  // merge is a union, so a peer would re-push every pruned video (the v1.0.36 lesson).
  assert.ok(!/deleteVideoRaw\(/.test(body), 'the prune uses a tombstone-free delete — peers will resurrect it');
});

test('the window is surfaced BY NAME in the sources tab, and derived not stored (v1.0.39)', () => {
  const app = MODULES.get('www/js/app.js');
  const sources = app.slice(app.indexOf('async function refreshSourcesPanel('));
  assert.match(sources.slice(0, sources.indexOf('\n}\n')), /refreshWindowBox\(\)/,
    'the מקורות tab no longer tells the parent which channels are over the window');
  // Nothing about the proposal may be persisted: a stored proposal is a second source of
  // truth that goes stale on the next sync, pull or manual deletion — the entire class of
  // bug v1.0.38 removed. It must be derived on demand.
  const derive = app.slice(app.indexOf('async function channelsOverWindow('));
  const body = derive.slice(0, derive.indexOf('\n}\n'));
  assert.ok(!/putMeta\(/.test(body), 'the window proposal is being stored — it will go stale');
  assert.match(body, /planChannelWindow\(/, 'the derivation no longer uses the pure planner');
  // The protection set must come from the PURE helper, whose own test pins what counts
  // (the parent's marks + a saved position, and NOT unwrappedAt — the gift baseline stamps
  // that on nearly every record, which made the window propose nothing at all: measured).
  assert.match(body, /protectedWindowKeys\(/, 'the protection set is no longer built by the pure helper');
  assert.match(body, /states: giftStates/, 'the child\'s per-video state is no longer consulted');
});

test('the window setting is per-profile, synced, and OFF unless written (v1.0.39)', () => {
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /putSetting\(activeProfileId, 'keepNewest'/, 'the window is no longer per-profile');
  assert.match(app, /getSetting\(activeProfileId, 'keepNewest', null\)/,
    'reading it with a non-null fallback would make never-written indistinguishable from a real 0');
  // it travels: a screen-time style decision belongs to the child, not to one tablet
  const setAt = app.indexOf("$('keep-newest').addEventListener");
  assert.ok(setAt > 0, 'the settings field is not wired');
  const handler = app.slice(setAt, app.indexOf('});', setAt));
  assert.match(handler, /maybeSchedulePush\(\)/, 'the window size no longer syncs to the other devices');
  assert.match(handler, /keepNewestPerChannel\(/, 'the field writes a raw value — a mistyped 1 would propose emptying folders');
  // saving a setting may never delete anything by itself
  assert.ok(!/deleteVideo|markKeepForever/.test(handler), 'saving the setting deletes content');
});

test('"delete this whole channel" still honours an earlier keep-forever mark (v1.0.39)', () => {
  // A marked video is not PROPOSED, so it never appears in the list and cannot be ticked
  // again — which is exactly how the first version deleted two favourites the parent had
  // already protected, behind a button whose label only mentioned a count. Measured in the
  // browser. The promise made when they ticked ("יישארו לתמיד") has to outlive this button.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function reviewChannelWindow(');
  const body = app.slice(at, app.indexOf('\n}\n\nasync function refreshChannelsList', at));
  const decl = body.slice(body.indexOf('const allLive ='), body.indexOf(';', body.indexOf('const allLive =')));
  // The pool must exclude the WHOLE protected set, not just `keepForever`: the other half
  // (a saved playback position) has the identical property — never proposed, therefore never
  // rendered, therefore impossible for the parent to tick and save.
  assert.match(decl, /!guarded\.has\(r\.key\)/,
    'the "delete every video of this channel" pool no longer excludes the full protected set');
  assert.match(body, /const guarded = protectedWindowKeys\(/,
    'the protected set is no longer built from the pure helper inside the review');
  // and the same set must gate the PROPOSAL, so the two buttons cannot disagree
  assert.match(body, /entry\.over\.map\(\(k\) => index\.get\(k\)\)\.filter\(\(r\) => r && !guarded\.has\(r\.key\)\)/,
    'the proposal no longer filters against the protected set');
});

test('the window prune RE-READS before deleting — the proposal can go stale (v1.0.39)', () => {
  // The proposal is computed when the review OPENS. A sync, a Drive pull or the parent
  // acting elsewhere can move a video in between: approved, rejected, protected, or already
  // deleted. Writing a window tombstone for something that is no longer a prunable live
  // record would permanently deny a video this dialog never asked about.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('const commit = async (everything)');
  assert.ok(at > 0, 'the window commit is gone');
  const body = app.slice(at, app.indexOf('\n  };', at));
  const reread = body.indexOf('await db.loadMergeIndex(scope)');
  const del = body.indexOf('deleteVideosWithTombstones(');
  assert.ok(reread > 0, 'the commit no longer re-reads the library before deleting');
  assert.ok(reread < del, 'the re-read must happen BEFORE the deletion');
  assert.match(body, /r\.state === 'live' && !r\.keepForever/,
    'the re-read no longer filters to still-prunable live records');
  // and the toast must report what was ACTUALLY removed, not the pre-confirm intent
  assert.match(body, /toast\(`נמחקו \$\{removed\}/, 'the toast reports the stale count again');
});

test('the prune clears per-child gift state, or 🎁 jams forever (v1.0.39)', () => {
  // THE SEVEREST audit finding. planGifts counts `outstanding` straight out of
  // profileVideoState — `giftRank && !unwrappedAt`, whether or not the video record still
  // exists — and stops gifting at `outstanding >= baseline`. Prune a handful of un-opened
  // gifts and the child NEVER receives another one; planGiftRunawayRepair cannot rescue it
  // (it no-ops below its 60-record floor). The 🎁 tile counts the same index, so the orphans
  // would also promise a folder that resolves to nothing.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('const commit = async (everything)');
  const body = app.slice(at, app.indexOf('\n  };', at));
  assert.match(body, /deleteVideoStates\(/, 'the prune leaves orphan gift state — gifting will jam');
  const del = body.indexOf('deleteVideosWithTombstones(');
  assert.ok(body.indexOf('deleteVideoStates(') > del, 'the state must be cleared for what was ACTUALLY deleted');
  assert.match(body, /giftStates\.delete\(/, 'the in-memory gift map keeps the orphans until the next load');
  // …for every profile that reads this library, not just the active one: a legacy shared
  // scope means a sibling's gift counter is jammed just as easily.
  assert.match(body, /src\.libraryId === scope/, 'only the active profile\'s state is cleared');
});

test('a failed prune is SAID, and never leaves the buttons inert (v1.0.39)', () => {
  // `settled` used to be released only on a cancelled confirm, so any rejection inside the
  // work (a tx-aborted write, a failed chunk) left the parent on the review with both delete
  // buttons dead and no message — the handlers' .catch(() => {}) ate the reason.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('const commit = async (everything)');
  const body = app.slice(at, app.indexOf('\n  };', at));
  assert.match(body, /\} catch \(e\) \{/, 'the commit no longer catches its own failure');
  const cat = body.slice(body.lastIndexOf('} catch (e) {'));
  assert.match(cat, /settled = false/, 'a failure leaves settled=true — both buttons stay inert forever');
  assert.match(cat, /toast\(/, 'a failed deletion says nothing to the parent');
  // ticking every row is a legitimate answer and must not open a "delete 0" confirm
  assert.match(body, /if \(!doomed\.length\)/, 'an empty selection still raises a confirm for zero videos');
});

test('only ONE window review can be open at a time (v1.0.39)', () => {
  // The prelude does two full library reads before it navigates, so a double-tap let a
  // second review repaint the list and replace pickHandlers — and the resulting nav.go
  // fired the pick view's onLeave, which nulls whatever pickHandlers holds: the LIVE one.
  // The screen became a zombie with dead buttons and two 'pick' entries on the stack.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function reviewChannelWindow(');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /windowReviewOpening \|\| nav\.isActive\('pick'\)/,
    'a second review can open over a live one again');
  assert.match(body, /finally/, 'the in-flight flag is not released on every path');
});

/* ---------------- favourites (v1.0.40) ---------------- */

test('⭐ sits directly after 🎁 at the top of the home, and hides at zero (v1.0.40)', () => {
  // The user's explicit requirement: "בראש כל התיקיות, אחרי התיקיה של החדשים". And a tile
  // that opens an empty grid is the v1.0.21 bug, so a count of 0 gets no tile at all.
  const app = MODULES.get('www/js/app.js');
  const gift = app.indexOf("id: 'new', title:");
  const fav = app.indexOf("id: 'fav', title:");
  const firstChannel = app.indexOf("id: prefix + lc.channelId");
  assert.ok(gift > 0, 'the 🎁 folder is gone');
  assert.ok(fav > gift, '⭐ must be pushed AFTER 🎁');
  assert.ok(fav < firstChannel, '⭐ must come before the channel folders');
  assert.match(app.slice(fav - 300, fav), /favCount > 0/, '⭐ renders a tile at zero favourites');
  // v1.0.40: the loose list must NOT reuse ⭐ — it read as the favourites folder (user report)
  const loose = app.slice(app.indexOf("id: 'sheet', scope: lib"), app.indexOf("id: 'sheet', scope: lib") + 160);
  assert.ok(!/emoji: '⭐'/.test(loose), '"סרטונים נוספים" is wearing the favourites folder\'s star again');
});

test('the ⭐ toggle has ONE write path, and no gate (v1.0.40)', () => {
  // It is the CHILD's button: no PIN, no confirm — it is not destructive in either
  // direction (the video stays where it lives; ⭐ is an additional place to find it).
  const app = MODULES.get('www/js/app.js');
  assert.equal((app.match(/db\.setFavourite\(/g) || []).length, 2,
    'db.setFavourite must have exactly two callers: the toggle and the ⭐ folder self-heal');
  const at = app.indexOf('async function toggleFavourite(');
  assert.ok(at > 0, 'the toggle is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.ok(!/startPin\(|confirmKid\(/.test(body), 'the child\'s own star must not be gated');
  assert.match(body, /maybeSchedulePush\(\)/, 'a star is a child decision and must reach the other devices');
  // the in-memory mirror must be restored when the write fails, or the button lies
  assert.match(body, /catch \{[\s\S]*giftStates\.set\(key, st\)/, 'a failed write leaves the button showing a star that was never saved');
});

test('the ⭐ folder self-heal clears only the FAVOURITE fields (v1.0.40)', () => {
  // The state row also carries gift/unwrap/resume. The gift folder may delete the whole row
  // (a rank IS the whole point there); doing that here would erase `unwrappedAt` and
  // RE-GIFT a video the child already opened.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function pageFavFolder(');
  assert.ok(at > 0, 'the ⭐ pager is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /db\.setFavourite\(activeProfileId, key, false\)/,
    'the self-heal no longer un-stars the missing video');
  assert.ok(!/deleteVideoState\(/.test(body),
    'the self-heal deletes the whole state row — that would re-gift an opened video');
});

test('a favourite is protected from the window, including a sibling\'s (v1.0.40)', () => {
  // The feature's central promise. The pure half is unit-tested; this pins the WIRING,
  // which the node suite cannot execute (it reads IndexedDB per profile).
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function channelsOverWindow(');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  // pin the CALL, not the mere mention: the first version of this guard matched the array's
  // construction, so dropping it from the protectedWindowKeys arguments passed vacuously —
  // the exact trap CLAUDE.md documents.
  // v1.0.57: `recent` joined the argument list (🕒's members are protected too — the user's
  // decision). The shape is pinned WHOLE and updated deliberately, exactly as this guard
  // intends: adding an argument must be a decision, and dropping one must fail here.
  assert.match(body, /protectedWindowKeys\(\{ records, states: giftStates, statesByProfile, recent \}\)/,
    'the siblings\' stars are built but not passed — a shared library eats the sibling\'s favourite');
  assert.match(body, /src\.libraryId !== scope/, 'the sibling scan no longer filters to THIS library');
  assert.match(body, /loadVideoStates\(/, 'the siblings\' state is never read');
  // and the recent set must be built for the SIBLINGS too, each with their OWN limit — a
  // sibling's 🕒 is a different length, and reading the active child's number for everyone
  // would protect the wrong videos in both directions.
  assert.match(body, /recentKeys\(giftStates, recentLimit\)/, 'the active child\'s 🕒 is not protected');
  assert.match(body, /recentKeys\(s\.states, lim\)/, 'a sibling\'s 🕒 is not protected');
  assert.match(body, /recentLimitFor\(await getSetting\(s\.pid, 'recentLimit'/,
    'the siblings\' 🕒 length is not read per profile');
});

test('a tap on a video reaches fullscreen SYNCHRONOUSLY (v1.0.2 rule, pinned v1.0.40)', () => {
  // CLAUDE.md has called this an invariant since v1.0.2 — "enterPlayerFullscreen() runs
  // SYNCHRONOUSLY inside the tap gesture (an await first may void the user activation)" —
  // and nothing pinned it. Every feature since has added lines to openWatch and to the tile
  // handler; one `await` in front of either silently costs the child fullscreen, and the
  // symptom (a video that opens windowed, sometimes) is untestable in node.
  const app = MODULES.get('www/js/app.js');

  // 1) the TILE handler must call openWatch with nothing awaited before it
  const tileAt = app.indexOf('function tileEl(');
  const tileBody = app.slice(tileAt, app.indexOf('\n}\n', tileAt));
  const handlerAt = tileBody.indexOf("btn.addEventListener('click'");
  assert.ok(handlerAt > 0, 'the tile click handler moved — re-anchor this guard');
  const handler = tileBody.slice(handlerAt, tileBody.indexOf('});', handlerAt));
  assert.ok(!/\basync\b/.test(handler), 'the tile handler is async — the tap loses its user activation');
  assert.ok(!/\bawait\b/.test(handler), 'the tile handler awaits before opening the video');
  assert.match(handler, /openWatch\(item\)/, 'the tile no longer opens the video directly');

  // 2) openWatch must reach the fullscreen request with no await in front of it
  const openAt = app.indexOf('async function openWatch(');
  assert.ok(openAt > 0, 'openWatch is gone');
  const fsAt = app.indexOf('enterPlayerFullscreen();', openAt);
  assert.ok(fsAt > openAt, 'openWatch no longer requests fullscreen');
  const prelude = app.slice(openAt, fsAt)
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(!/\bawait\b/.test(prelude),
    'openWatch awaits something BEFORE going fullscreen — the tap\'s user activation is spent');

  // 3) v1.0.73 — an AUDIO file opts OUT of fullscreen (user request), and the decision is
  //    the pure one. The call must stay unconditional-looking in the sense that matters —
  //    synchronous, unawaited — while the CHOICE lives in playerlogic.
  assert.match(app, /if \(opensFullscreen\(item\)\) enterPlayerFullscreen\(\);/,
    'the fullscreen request is no longer gated by the pure decision — audio would fill the screen again');
  const logic = MODULES.get('www/js/playerlogic.js');
  assert.match(logic, /export function opensFullscreen\(item\)/, 'opensFullscreen is gone');
  // ⚠️ pinned by ABSENCE: reading an UNKNOWN media as audio would open real videos windowed
  assert.match(logic, /item\.type === 'file' && item\.media === 'audio'/,
    'the opt-out is not restricted to a KNOWN audio file — an unenriched video would open windowed');
});

test('the folder illustration ships, is self-contained, and has an emoji fallback (v1.0.41)', () => {
  // Same rule the guide slides follow: an asset named in code must EXIST in www/, or the
  // child gets an empty circle where their folder should be. And it must be self-contained
  // — the app runs from file:// inside a WebView with no network guarantee, so an external
  // font/image/filter reference would silently render nothing.
  const app = MODULES.get('www/js/app.js');
  const m = app.match(/art: '([^']+)'/);
  assert.ok(m, 'no folder names an illustration any more');
  // v1.0.41: the drawing belongs to the LOOSE-SINGLES folder; ⭐ keeps its plain star
  const favPush = app.slice(app.indexOf("id: 'fav', title:") - 40, app.indexOf("id: 'fav', title:") + 140);
  assert.ok(!/art:/.test(favPush), 'the favourites folder took the drawing back — ⭐ is its mark');
  const rel = m[1];
  const svg = readFileSync(join(ROOT, 'www', rel), 'utf8'); // throws if it is not shipped
  assert.match(svg, /^<svg/, `${rel} is not an SVG`);
  for (const forbidden of [/xlink:href/, /<image\b/, /url\(https?:/, /@font-face/, /<script/]) {
    assert.ok(!forbidden.test(svg), `${rel} pulls in something external (${forbidden}) — it must be self-contained`);
  }
  // the emoji fallback is what makes a missing/blocked asset degrade instead of vanish
  const mountAt = app.indexOf('function mountFolderArt(');
  assert.ok(mountAt > 0, 'the art mounter is gone');
  const body = app.slice(mountAt, app.indexOf('\n}\n', mountAt));
  assert.match(body, /addEventListener\('error'/, 'a failed illustration leaves an EMPTY circle');
  assert.match(body, /fallbackEmoji/, 'the fallback emoji is no longer used');
});

test('emptying ⭐ from the watch screen falls back to the real folder (v1.0.40)', () => {
  // ⭐ is a VIEW, not a folder, and the child can empty it from the very screen that pages
  // it: un-starring the video they are watching removes it from the list. With one favourite
  // that leaves an EMPTY under-player grid and then an empty folder screen — the same shape
  // the 🎁 folder needed fixing for in v1.0.21 (a gift leaves 🎁 the instant it is unwrapped).
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function renderWatchGrid(');
  assert.ok(at > 0, 'renderWatchGrid is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /fid === 'fav' && !favouriteKeys\(giftStates\)\.length/,
    'an emptied ⭐ no longer falls back — the child is left with an empty grid');
  assert.match(body, /current && \(current\.homeFolderId \|\| current\.folderId\)/,
    'the fallback must be where the video actually LIVES');
});

test('leaving fullscreen lands on the TOP of the watch page (v1.0.43)', () => {
  // Exiting fullscreen is NOT a navigation: nav.handleBack answers 'exit-fullscreen' and
  // returns, and the HUD's ⛶ does the same — so nothing scrolled, and the child came back
  // to wherever they had scrolled to (usually the grid, with the small player off-screen
  // above). nav.go has guaranteed a top landing since the F4 fix; this is the one way out
  // that never goes through nav.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('const onFullscreenChange = () => {');
  assert.ok(at > 0, 'the fullscreen-exit scroll handler is gone');
  const body = app.slice(at, app.indexOf('\n  };', at));
  // entering fullscreen must not run the scroll code (v1.0.54 reshaped the branch: the
  // entering path now requests landscape first, but it must still end in a bare return)
  assert.match(body, /const entering = !!\(document\.fullscreenElement \|\| document\.webkitFullscreenElement\)/,
    'the entering/exiting split is gone');
  assert.match(body, /if \(entering\) return;/,
    'the handler also runs the scroll code when ENTERING fullscreen');
  // and it must not fight a navigation that already restored a scroll position: `leaveWatch`
  // (a video that ended) exits fullscreen and then nav.back()s into the folder.
  assert.equal((body.match(/nav\.isActive\('watch'\)/g) || []).length, 2,
    'the watch guard must be checked at event time AND inside the deferred callback');
  // TWICE: immediate (rAF callbacks are SUSPENDED while the document is hidden — measured)
  // and deferred (the reflow as the element leaves fullscreen would undo an immediate one).
  assert.equal((body.match(/window\.scrollTo\(0, 0\)/g) || []).length, 2,
    'the scroll must be both immediate and deferred');
  assert.match(body, /requestAnimationFrame\(\(\) => requestAnimationFrame\(/,
    'the deferred scroll no longer uses the double rAF nav.transition relies on');
  // registered on BOTH vendor names, once, in wire()
  const wireAt = app.indexOf('function wire()');
  const wireBody = app.slice(wireAt);
  assert.match(wireBody, /document\.addEventListener\('fullscreenchange', onFullscreenChange\)/);
  assert.match(wireBody, /document\.addEventListener\('webkitfullscreenchange', onFullscreenChange\)/,
    'older WebViews fire only the webkit-prefixed event');
});

test('the fullscreen-exit top landing SURVIVES the WebView scroll restore (v1.0.51)', () => {
  // Field report (2026-08-18, "בגירסה האחרונה"): the child exits fullscreen and lands
  // mid-page again. v1.0.43's double rAF beats the REFLOW — but Android's WebView also
  // RESTORES the pre-fullscreen scroll offset when the native custom view tears down,
  // and that restore lands after two rAFs on a real tablet. The scenario: the child taps
  // a video from halfway down the under-player grid (fullscreen banks that offset;
  // nav.replace scrolls to 0 underneath, invisibly), watches, exits — and the restore
  // drops them back at the grid with the playing video off-screen above.
  // The fix is a PIN, not a longer timer: for a short window after the exit, any scroll
  // away from the top while still watching is snapped back.
  const app = MODULES.get('www/js/app.js');

  // the pin window is armed in the EXIT path, after the watch guard
  const fsAt = app.indexOf('const onFullscreenChange = () => {');
  const fsBody = app.slice(fsAt, app.indexOf('\n  };', fsAt));
  assert.match(fsBody, /fsExitPinUntil = Date\.now\(\) \+ FS_EXIT_PIN_MS/,
    'the exit path no longer arms the scroll pin');

  const at = app.indexOf('const onFsExitPinScroll = () => {');
  assert.ok(at > 0, 'the fullscreen-exit scroll pin listener is gone');
  const body = app.slice(at, app.indexOf('\n  };', at));
  // every guard is load-bearing: expired window (the child scrolling normally), a
  // re-entered fullscreen, and a navigation that left the watch view (leaveWatch →
  // nav.back restores the FOLDER's scroll — the pin must never fight that).
  assert.match(body, /Date\.now\(\) > fsExitPinUntil/, 'the pin never expires — it would fight the child\'s own scrolling forever');
  assert.match(body, /document\.fullscreenElement \|\| document\.webkitFullscreenElement/,
    'the pin keeps scrolling a page that re-entered fullscreen');
  assert.match(body, /nav\.isActive\('watch'\)/,
    'the pin fights nav.back()\'s folder-scroll restore after leaveWatch');
  assert.match(body, /window\.scrollTo\(0, 0\)/, 'the pin does not actually scroll');

  // registered once, on window, passive (it runs on every scroll of the app's life)
  assert.match(app, /window\.addEventListener\('scroll', onFsExitPinScroll, \{ passive: true \}\)/,
    'the pin listener is not registered (or not passive)');

  // the window must outlast a real tablet's custom-view teardown (~300ms measured class
  // of delay) yet stay short enough that a child's deliberate scroll is not eaten.
  const msMatch = app.match(/const FS_EXIT_PIN_MS = (\d+)/);
  assert.ok(msMatch, 'FS_EXIT_PIN_MS is gone');
  const ms = Number(msMatch[1]);
  assert.ok(ms >= 500 && ms <= 1500, `FS_EXIT_PIN_MS=${ms} — must cover the WebView restore (>=500) without eating the child's own scroll (<=1500)`);
});

/* ---------------- the sheet sunset is GONE (v1.0.44) ---------------- */

test('nothing reads a Google Sheet, and nothing deletes a Drive file (v1.0.44)', () => {
  // The v1.0.38 sunset migration was the last code that did either: it read the family's
  // sources sheet one final time and then deleted the file, bypassing Drive's trash. Both
  // capabilities are gone with it, and this is what keeps them gone — a re-introduction
  // would also re-introduce a Google scope the app no longer needs.
  for (const [p, body] of MODULES) {
    assert.ok(!/sheets\.googleapis|v4\/spreadsheets/.test(body),
      `${p} calls the Google Sheets API — the app has no sheet concept any more`);
    assert.ok(!/method: 'DELETE'|"DELETE"/.test(body),
      `${p} issues an HTTP DELETE — the only one the app ever had was the sunset's file delete`);
    assert.ok(!/runSheetSunset|planSheetSunset|planSheetFold|SUNSET_DEADLINE/.test(body),
      `${p} still references the removed sunset migration`);
  }
  // …and the module itself must not come back
  assert.ok(!MODULES.has('www/js/sunset.js'), 'sunset.js is back — the migration was deleted on purpose');
});

/* ================= approved websites (v1.0.45) =================
   This feature puts a BROWSER on a 5-year-old's tablet. Almost everything below pins a
   door closed rather than a feature working — a broken feature is visible, an open door
   is not. Each guard names what gets through if it fails. */

const JAVA_PAIRS = [
  'android/app/src/main/java/com/assaf/kidsplayer/KidsWebPlugin.java',
  'native-reference/KidsWebPlugin.java'
];

/** v1.0.76 — a Java method's body, brace-balanced from the first `{` at/after `at`. The
 *  Java twin of handlerBody: a fixed char window bleeds into the next method and passes on
 *  a deleted call (proven — the onPageFinished plant). */
function javaMethodBody(src, at) {
  let i = src.indexOf('{', at);
  if (i < 0) return '';
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}
const readRepo = (p) => readFileSync(join(ROOT, p), 'utf8');
/** Java source with comments stripped. Every positional/absence guard below MUST use
 *  this: the comments deliberately NAME what they forbid ("verifying a PIN in Java
 *  would be…", "MUST run before super.onCreate()"), so a guard reading raw text trips
 *  on its own documentation. All three of these fired on comments the first time. */
const readRepoCode = (p) => stripComments(readRepo(p));

test('the URL-prefix rule lives in ONE module (v1.0.45)', () => {
  // The whole feature's safety is one comparison. A second copy of it anywhere — an
  // inline startsWith in a click handler, a "quick check" in the parent panel — is a
  // second answer to "may the child go here", and the two will disagree.
  const owners = [...CODE.entries()]
    .filter(([k, b]) => k !== 'www/js/weblock.js' && /\b(navAllowed|subresourceAllowed|canonicalSitePrefix)\s*\(/.test(b))
    .filter(([, b]) => !/from '\.\/weblock\.js'/.test(b) === true);
  assert.deepEqual(owners.map(([k]) => k), [],
    'the prefix rule is implemented outside weblock.js');
  // and nobody may hand-roll a host/prefix comparison instead of importing it
  for (const [k, b] of CODE.entries()) {
    if (k === 'www/js/weblock.js') continue;
    assert.ok(!/\.startsWith\(\s*['"]https:\/\//.test(b),
      `${k}: a raw startsWith on an https URL is not a prefix check — use weblock`);
  }
});

test('a site deletion writes its tombstone FIRST (v1.0.45)', () => {
  // Absence carries no information: every Drive merge is a union, so a removed site that
  // left only a missing row is re-added by the first peer that has not pulled yet.
  const db = MODULES.get('www/js/db.js');
  const at = db.indexOf('export async function deleteSiteEntry(');
  assert.ok(at > 0, 'deleteSiteEntry not found');
  const body = db.slice(at, db.indexOf('\n}\n', at));
  const tomb = body.indexOf('putDeletedSiteEntries');
  const del = body.indexOf('s.delete([scopeId, entryId])');
  assert.ok(tomb > 0, 'deleteSiteEntry writes no tombstone — removed sites come back on the next pull');
  assert.ok(del > tomb, 'the tombstone must be written BEFORE the row delete');
});

test('applyRemoteDoc routes site entries through planSiteApply (v1.0.45)', () => {
  const drive = CODE.get('www/js/drive.js');
  assert.match(drive, /planSiteApply\(\{/, 'the apply path no longer uses the pure planner');
  assert.match(drive, /putDeletedSiteEntries\(libId, sitePlan\.tombs\)/,
    'the merged tombstone map must be adopted, or an interrupted apply forgets it');
  assert.match(drive, /preserveTimestamp: true/,
    'an applied remote row must keep the winner\'s timestamp or two devices ping-pong');
});

test('EVERY createObjectStore sits behind an oldVersion guard (v1.0.45)', () => {
  // An unguarded store creation on a bumped DB_VERSION throws ConstraintError, aborts the
  // version-change transaction and leaves the app unable to open its database AT ALL —
  // on every installed device. Verified in the browser: it really does throw.
  const db = MODULES.get('www/js/db.js');
  const at = db.indexOf('req.onupgradeneeded');
  const end = db.indexOf('req.onsuccess', at);
  const body = db.slice(at, end);
  assert.match(body, /\(ev\)\s*=>/, 'the upgrade handler must receive the event to read oldVersion');
  const guards = [...body.matchAll(/if \(from < (\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(guards.length >= 2, 'expected one oldVersion block per schema version');
  // every createObjectStore must come AFTER the first guard opens
  const firstGuard = body.indexOf('if (from <');
  for (const m of body.matchAll(/createObjectStore\(/g)) {
    assert.ok(m.index > firstGuard,
      'a createObjectStore sits outside an oldVersion guard — this BRICKS every existing install');
  }
});

test('the site collection travels in BOTH buildLocalDoc branches (v1.0.45)', () => {
  // Sites are PROFILE-scoped, and the prof: pseudo-library is built by a separate, thinner
  // branch that already omits deletedChannels. Carrying the collection in only the library
  // branch means the sites sync NOWHERE, silently, while every local screen looks right.
  const drive = CODE.get('www/js/drive.js');
  const at = drive.indexOf('async function buildLocalDoc');
  const body = drive.slice(at, drive.indexOf('\n}\n', at));
  const hits = [...body.matchAll(/siteEntries:/g)];
  assert.ok(hits.length >= 2,
    'only one buildLocalDoc branch carries siteEntries — the profile-scoped ones would never sync');
  assert.match(body, /listSiteEntries\(pScope\)/, 'the prof: branch must read the real rows');
  // and the blob must be built even when the profile has no personal VIDEOS
  assert.match(body, /pv\.length \|\| pSites\.length/,
    'the prof: blob is gated on videos alone — a child with only websites would sync nothing');
});

test('the scheduled lock CLOSES the site viewer before it renders (v1.0.45)', () => {
  // The viewer is a native view over the whole app, so nav.reset('locked') would swap the
  // screen UNDERNEATH it and the child would keep browsing with the lock invisible.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function showLockedScreen()');
  const body = stripComments(app.slice(at, app.indexOf('\n}\n', at)));
  const close = body.indexOf('closeSiteViewer()');
  const reset = body.indexOf("nav.reset('locked')");
  assert.ok(close > 0, 'the lock no longer closes the site viewer — screen time stops applying to browsing');
  assert.ok(reset > close, 'the viewer must be closed BEFORE the locked view is shown');
});

test('the idle timer counts while a site is open, and its input comes from native (v1.0.45)', () => {
  // Taps inside a native WebView never reach this window, so without the bridge event the
  // idle timer either never fires (viewer not counted) or fires on an active child.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /playing: !!\(st && st\.playing\) \|\| siteViewerOpen/,
    'tickIdleSleep ignores an open site viewer — the screen-off timer is off while browsing');
  assert.match(app, /onSiteEvent\('webActivity'/,
    'nothing feeds idleLastInputAt from the viewer — a browsing child looks idle');
  assert.match(app, /onSiteEvent\('webClosed'/,
    'siteViewerOpen would stay true forever after the viewer closes');
});

test('the child sees SHORTCUTS only, never the navigation rules (v1.0.45)', () => {
  // A rule may be a sub-path or a different site entirely. Rendering rules as tiles would
  // put things on the child's screen the parent never pictured them opening.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /kind === 'shortcut'/, 'siteShortcuts no longer filters by kind');
  const at = app.indexOf('function renderSitesView()');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /siteShortcuts\(\)/,
    'the child grid must render siteShortcuts(), not the whole entry list');
  assert.ok(!/siteRules\(\)/.test(body), 'the child grid renders navigation rules as tiles');
});

test('the launcher is gated on the setting AND a shortcut AND not-TV (v1.0.45)', () => {
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf('async function refreshSitesLauncher()');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /sitesEnabledCache/, 'the parent toggle no longer hides the button');
  assert.match(body, /siteShortcuts\(\)\.length > 0/,
    'a button that opens an empty grid is the v1.0.21 bug');
  assert.match(body, /classList\.contains\('tv'\)/, 'the feature must stay hidden on Android TV');
  assert.match(body, /await loadSiteEntries\(\)/,
    'reading a cache here means a peer\'s change is invisible until the profile is switched');
});

test('parent mode is unreachable from anything the child can touch (v1.0.45)', () => {
  // parentMode navigates WITHOUT restriction. It exists so a parent can complete an SSO
  // login behind the PIN; a path to it from the child's side would be the whole feature
  // undone in one tap.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /parentMode: false/, 'the child path must pass parentMode: false explicitly');
  const kid = app.slice(app.indexOf('async function openSiteForKid'), app.indexOf('async function openSiteForParent'));
  assert.ok(!/parentMode: true/.test(kid), 'the CHILD path can open an unrestricted viewer');
  // and the only caller of the parent path is the parent panel row
  const parentCalls = (app.match(/openSiteForParent\(/g) || []).length - 1;
  assert.ok(parentCalls <= 2, `openSiteForParent has ${parentCalls} call sites — each one must be behind the PIN`);
});

test('the PIN is never verified in Java (v1.0.45)', () => {
  // A second implementation of the one check that guards the whole parent surface. The
  // native side asks JS to take over (webAddRequest) and JS runs the real startPin.
  for (const p of JAVA_PAIRS) {
    const code = readRepoCode(p);
    assert.ok(!/\bpin\b/i.test(code.replace(/kidsweb/gi, '')),
      `${p}: the native side must not know anything about the parent code`);
    assert.match(code, /webAddRequest/, `${p}: no way to hand a blocked page back to the parent`);
  }
});

test('the site viewer closes every escape, in BOTH java copies (v1.0.45)', () => {
  // Each of these is a one-gesture way out of the approved set for a child who is simply
  // exploring. They are listed with the door they close.
  const required = [
    ['shouldOverrideUrlLoading', 'navigation outside the approved rules'],
    ['shouldInterceptRequest', 'ads, trackers and embedded third-party players'],
    ['setDownloadListener', 'downloading an APK'],
    ['onCreateWindow', 'target=_blank and window.open'],
    ['onPermissionRequest', 'camera and microphone'],
    ['onGeolocationPermissionsShowPrompt', 'location'],
    ['setOnLongClickListener', 'the long-press "open in new tab" menu'],
    ['startActionMode', 'text selection → "Web search" (launches another app)'],
    ['setAllowFileAccess(false)', 'file:// browsing'],
    ['MIXED_CONTENT_NEVER_ALLOW', 'http content inside an https page'],
    ['setAcceptThirdPartyCookies', 'cross-site tracking cookies'],
    ['CookieManager.getInstance().flush', 'losing the parent\'s login on every process kill']
  ];
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    for (const [needle, door] of required) {
      assert.ok(body.includes(needle), `${p}: ${needle} is gone — ${door} is open`);
    }
    // https ONLY: intent:// market:// tel: mailto: all leave the app entirely
    assert.match(body, /"https"\.equals\(u\.getScheme\(\)\)/,
      `${p}: the scheme gate is gone — intent:// would launch another app`);
    assert.match(body, /getUserInfo\(\) != null/,
      `${p}: https://good.com@evil.com/ defeats a host check without this`);
    assert.match(body, /"\.\.".equals\(seg\)/,
      `${p}: %2e%2e arrives DECODED and would climb out of the allowed section`);
  }
});

test('MainActivity wires the viewer into back and the lifecycle, in BOTH copies (v1.0.45)', () => {
  for (const p of [
    'android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java',
    'native-reference/MainActivity.java'
  ]) {
    const body = readRepoCode(p);
    assert.match(body, /registerPlugin\(KidsWebPlugin\.class\)/, `${p}: the plugin is not registered`);
    const reg = body.indexOf('registerPlugin(KidsWebPlugin.class)');
    const sup = body.indexOf('super.onCreate(');
    assert.ok(reg < sup, `${p}: plugins must register BEFORE super.onCreate()`);
    assert.match(body, /KidsWebPlugin\.handleBack\(\)/,
      `${p}: hardware back would navigate the app hidden UNDER the site`);
    assert.match(body, /KidsWebPlugin\.onActivityPause\(\)/,
      `${p}: a site's audio would keep playing after the screen-off button (v1.0.32)`);
  }
});

test('the native pair is byte-identical (v1.0.45)', () => {
  // The manifest drifted for three releases because no test compared a pair; a rebuild
  // from native-reference would have shipped an APK with no Android TV support.
  for (const [a, b] of [
    ['android/app/src/main/java/com/assaf/kidsplayer/KidsWebPlugin.java', 'native-reference/KidsWebPlugin.java'],
    ['android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java', 'native-reference/MainActivity.java'],
    ['android/app/src/main/AndroidManifest.xml', 'native-reference/AndroidManifest.xml']
  ]) {
    assert.equal(readRepo(a), readRepo(b), `${a} and ${b} have drifted — disaster recovery would ship the wrong app`);
  }
});

/* ---- v1.0.45 review findings, each pinned so it cannot come back ---- */

test('a parent approval from the CHILD\'s blocked page reopens in CHILD mode (v1.0.45)', () => {
  // The severe one. That flow starts on the child's screen: the parent leans over, types
  // the code, approves, and hands the tablet back. Reopening in parentMode — which
  // navigates WITHOUT restriction — left that child holding a free browser, i.e. the
  // feature undone by the act of fixing it.
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf('async function askSiteRuleGrain');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.ok(!/openSiteForParent\(/.test(body),
    'the blocked-page approval reopens in PARENT mode — the child gets an unrestricted browser');
  assert.match(body, /reopenForKid\(/, 'the approval must hand the page back in child mode');
  const reopen = app.slice(app.indexOf('async function reopenForKid'), app.indexOf('async function openSiteForParent'));
  assert.match(reopen, /parentMode: false/, 'reopenForKid must be explicit about the mode');
});

test('parent mode does not survive an absence (v1.0.45)', () => {
  // It navigates unrestricted, so a tablet put down mid-login and picked up by the child
  // would be a free browser. Closing on PAUSE would be wrong (hopping to a password
  // manager is the commonest thing a parent does mid-login), so it expires on resume.
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    assert.match(body, /PARENT_MODE_GRACE_MS/, `${p}: parent mode never expires`);
    const at = body.indexOf('static void onActivityResume');
    const fn = body.slice(at, body.indexOf('\n    }', at));
    assert.match(fn, /parentMode/, `${p}: resume does not consider parent mode`);
    assert.match(fn, /closeOverlay\(\)/, `${p}: an abandoned parent session is never closed`);
  }
});

test('the modal helpers are never called positionally (v1.0.45)', () => {
  // confirmKid/askKid/alertKid take an OPTIONS object. A positional call is not a syntax
  // error and not a crash — it silently renders the default dialog: "❓", no title, no
  // text. One shipped in this feature's own error path and only a read caught it.
  for (const [k, b] of CODE.entries()) {
    const bad = [...b.matchAll(/\b(alertKid|confirmKid|askKid)\(\s*['"`]/g)].map((m) => m[1]);
    assert.deepEqual(bad, [],
      `${k}: ${bad.join(', ')} called with a string — the dialog renders EMPTY`);
  }
});

test('the site probe is bounded, and the constant has a consumer (v1.0.45)', () => {
  // "A constant with no consumer is a lie" (v1.0.37). And without the bound a hanging
  // host leaves the parent on "בודקים את הכתובת…" with no way out — httpRequest has no
  // timeout of its own. Measured in the browser: the flow now completes in ~8s.
  const cfg = CODE.get('www/js/config.js');
  assert.match(cfg, /SITE_PROBE_TIMEOUT_MS/, 'the timeout constant is gone');
  const app = CODE.get('www/js/app.js');
  assert.match(app, /SITE_PROBE_TIMEOUT_MS/, 'nothing consumes the probe timeout');
  const at = app.indexOf('async function probeSite');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /Promise\.race/, 'probeSite awaits the network with no bound');
});

test('one site add at a time (v1.0.45)', () => {
  // Two taps ran two probes and raised two confirms; the modal swallows the second and
  // reports it as a cancel, so the parent's second tap silently did nothing.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /siteAddBusy/, 'the add button is not latched against a double tap');
  const at = app.indexOf('async function addSiteFromInput');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /if \(siteAddBusy\) return;/, 'the latch is not checked');
  assert.match(body, /finally/, 'a throw would leave the add button disabled forever');
});

test('nothing touches the WebView from the off-thread request hook (v1.0.45)', () => {
  // FIELD-REPORTED CRASH. `shouldInterceptRequest` is documented to run OFF the UI
  // thread, once per subresource. Any WebView method called from there throws
  // "A WebView method was called on thread 'WebViewCoreThread'" and kills the app — and
  // since the fatal exception surfaces from inside the WebView implementation, Android
  // blames the WebView package and offers the user to uninstall its updates.
  //
  // It only ever hit CHILD mode: parent mode returns on the hook's first line, so the
  // phone showed a working parent preview and a crash the moment the child opened the
  // same site. The state that hook reads must be plain fields, and volatile.
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    const slice = (needle, close) => {
      const at = body.indexOf(needle);
      assert.ok(at > 0, `${p}: ${needle} not found`);
      return body.slice(at, body.indexOf(close, at));
    };
    const hook = slice('public WebResourceResponse shouldInterceptRequest', '\n        }');
    const helper = slice('private boolean subresourceAllowed', '\n    }');
    for (const [name, code] of [['shouldInterceptRequest', hook], ['subresourceAllowed', helper]]) {
      assert.ok(!/\bweb\s*\./.test(code),
        `${p}: ${name} calls a WebView method, but it runs OFF the UI thread — that is a fatal crash`);
    }
    // and the cross-thread state must actually be safe to read there
    for (const field of ['rules', 'currentPageUrl', 'parentMode']) {
      assert.match(body, new RegExp(`volatile\\s+[\\w<>.]+\\s+${field}\\b`),
        `${p}: ${field} is read from the request hook's thread and must be volatile`);
    }
    // `rules` must be REPLACED, never mutated in place, or the worker can observe it empty
    assert.ok(!/rules\.clear\(\)/.test(body),
      `${p}: rules is mutated in place — the off-thread reader can see it half-swapped`);
  }
});

test('the site viewer implements HTML5 fullscreen, and back leaves it first (v1.0.45)', () => {
  // A bare WebView does not implement fullscreen AT ALL — without onShowCustomView the
  // fullscreen button on an embedded player does nothing whatsoever, which is how this
  // shipped: it fails SILENTLY, with no error and no log. Reported from the device.
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    assert.match(body, /public void onShowCustomView\(/,
      `${p}: no onShowCustomView — a video's fullscreen button does nothing at all`);
    assert.match(body, /public void onHideCustomView\(/, `${p}: fullscreen can be entered but never left`);
    assert.match(body, /setKeepScreenOn\(true\)/,
      `${p}: a playing video is USE — without this the screen sleeps mid-video`);
    // The idle timer counts an open viewer and is fed only by page loads, so a video with
    // nobody touching the glass would look idle and the viewer would close mid-playback.
    const show = body.slice(body.indexOf('public void onShowCustomView('), body.indexOf('public void onHideCustomView('));
    assert.match(show, /fsPing|webActivity/,
      `${p}: nothing reports activity while fullscreen — the idle timer closes the video`);
    // back: fullscreen before history before close
    const back = body.slice(body.indexOf('static boolean handleBack()'), body.indexOf('\n    }', body.indexOf('static boolean handleBack()')));
    const fs = back.indexOf('customView');
    const goBack = back.indexOf('canGoBack');
    assert.ok(fs > 0 && fs < goBack,
      `${p}: back must leave FULLSCREEN before it walks history, or the child lands on a black screen`);
    // and closing the viewer must not leak a detached surface
    assert.match(body.slice(body.indexOf('private void closeOverlay')), /exitFullscreen\(\)/,
      `${p}: closing while fullscreen leaves the video surface attached`);
  }
});

test('the site viewer has browser back/forward, greyed when dead, in BOTH java copies (v1.0.76)', () => {
  // Node cannot tap a native button; this pins the wiring a behavioural test cannot reach,
  // comment-stripped (the v1.0.45 lesson — the comments NAME what they describe).
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    // the two buttons exist and drive the WebView's real history — no second implementation
    assert.match(body, /navBack\s*=\s*navButton\(/, `${p}: no browser BACK button`);
    assert.match(body, /navFwd\s*=\s*navButton\(/, `${p}: no browser FORWARD button`);
    assert.match(body, /web\.goForward\(\)/, `${p}: forward button does not walk history`);
    // the enabled state is refreshed — a dead arrow a child taps reads as a broken app.
    // updateNavButtons must key on canGoBack/canGoForward…
    const upd = body.slice(body.indexOf('private void updateNavButtons()'),
                           body.indexOf('private void updateNavButtons()') + 500);
    assert.match(upd, /canGoBack\(\)/, `${p}: the back button is never disabled`);
    assert.match(upd, /canGoForward\(\)/, `${p}: the forward button is never disabled`);
    // …and it must be called from EVERY history hook AND open, or a pushState / a fresh page
    // leaves a stale arrow (onPageStarted misses same-document navs; onPageFinished is where
    // canGoForward flips false once a new nav commits).
    for (const hook of ['onPageStarted', 'onPageFinished', 'doUpdateVisitedHistory']) {
      const at = body.indexOf('public void ' + hook + '(');
      assert.ok(at > 0, `${p}: ${hook} is gone — re-anchor this guard`);
      // ⚠️ BRACE-BALANCED, not a char window: a fixed window from onPageFinished( bled into
      // the NEXT hook (which also calls updateNavButtons) and stayed green with this hook's
      // call deleted — the handlerBody trap, a third time.
      assert.match(javaMethodBody(body, at), /updateNavButtons\(\)/,
        `${p}: ${hook} does not refresh the nav buttons — a stale/dead arrow`);
    }
    // the fields are cleared on teardown (the overlay is rebuilt on the next open), like
    // titleView — a stale reference would mis-drive the next session's bar
    const fc = body.slice(body.indexOf('private void forceClose()'), body.indexOf('private void forceClose()') + 700);
    assert.match(fc, /navBack = null/, `${p}: navBack leaks past teardown`);
    assert.match(fc, /navFwd = null/, `${p}: navFwd leaks past teardown`);
  }
});

test('the add flow ASKS about external content, and the answer reaches the rule (v1.0.48)', () => {
  // Asked at add time, not left to a toggle further down the panel: it is a per-site
  // decision the parent is already thinking about, and a site whose embedded videos will
  // not play looks broken long before anyone goes hunting for a switch.
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf('async function runSiteAdd');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /askKid\(/, 'the add confirm is not a three-way question any more');
  assert.match(body, /third:/, 'there is no "with external content" answer');
  assert.match(body, /answer !== 'ok' && answer !== 'third'/,
    'an accidental dismiss must add NOTHING — the v1.0.23 rule');
  assert.match(body, /allowExternal = answer === 'third'/, 'the answer is not read');
  assert.match(body, /addSiteShortcut\([^)]*allowExternal/s, 'the shortcut door drops the answer');
  assert.match(body, /addSiteRule\(finalCanon, \{ allowExternal \}\)/, 'the rule door drops the answer');
  // and the rule a shortcut auto-creates must inherit it, or saying yes changes nothing
  const sc = app.slice(app.indexOf('async function addSiteShortcut'), app.indexOf('async function removeSiteEntry'));
  assert.match(sc, /addSiteRule\(canon, \{ allowExternal \}\)/,
    'the auto-created rule ignores the answer — the parent says yes and the page stays strict');
  // the SAFE answer must be the primary button
  const okIdx = body.indexOf("ok: 'הוספה — בלי");
  assert.ok(okIdx > 0, 'the primary button is no longer the strict one');
});

test('a landed pull redraws the surface the parent is ON, not just the home (v1.0.49)', () => {
  // FIELD-REPORTED. A pull lands wherever the parent is standing, and the parent screen is
  // exactly where they go to check that what they added on the other device arrived. Both
  // entryRefresh branches re-rendered the gallery ALONE, so every parent surface kept
  // showing pre-pull data and the parent pressed "רענון" to reveal rows already in the DB.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /async function renderAfterRemoteChange\(/, 'the shared post-pull render is gone');
  const fn = app.slice(app.indexOf('async function renderAfterRemoteChange('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);

  assert.match(body, /nav\.isActive\('gallery'\)/, 'the child home is no longer redrawn');
  assert.match(body, /nav\.isActive\('parent'\)/, 'the PARENT screen is not redrawn — the reported bug');
  for (const r of ['refreshPendingList', 'refreshChannelsList', 'refreshSitesPanel']) {
    assert.ok(body.includes(r), `${r} is missing — that list stays stale after a pull`);
  }
  // refreshParent() also clears the status lines, re-applies the tab and re-runs the
  // update check: a SILENT background pull must not wipe a message the parent is reading.
  assert.ok(!/\brefreshParent\(\)/.test(body),
    'a background pull must not run refreshParent() — it clobbers the parent mid-action');

  // and BOTH branches must go through it, or they drift apart exactly as they did before
  const er = app.slice(app.indexOf('async function entryRefresh('));
  const erBody = er.slice(0, er.indexOf('\n}\n') + 1);
  // v1.0.56 DELIBERATE change 2→3: the Drive-folder refresh is a THIRD branch that can
  // write records (files the parent added in Drive since), and it must redraw through the
  // same shared helper — rendering the gallery directly is what left the parent screen
  // stale in v1.0.49.
  const calls = (erBody.match(/renderAfterRemoteChange\(\)/g) || []).length;
  assert.equal(calls, 3, `entryRefresh calls the shared render ${calls}× — the pull, drive-folder and sync branches must ALL use it`);
  assert.ok(!/nav\.isActive\('gallery'\)\)\s*(await\s*)?renderHome\(\)/.test(erBody),
    'entryRefresh renders the gallery directly again — the parent screen goes stale');
});

test('site entries are read by PRIMARY KEY, never the by_scope index (v1.0.49)', () => {
  // MEASURED IN THE BROWSER. `by_scope` is ['scopeId','order'], and IndexedDB leaves a
  // record OUT of an index entirely when any component of its key is undefined. A row
  // written without `order` — a peer on another version, a hand-edited snapshot, any
  // future writer — therefore EXISTED in the store and was invisible to every reader,
  // permanently and silently: getAll() on the store returned two rows while
  // listSiteEntries returned none, so the child's launcher stayed hidden and the parent
  // panel stayed empty over a full database. It presents as "the sync is broken" and
  // cannot be diagnosed from any screen.
  const db = CODE.get('www/js/db.js');
  const fn = db.slice(db.indexOf('export async function listSiteEntries'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(!/index\('by_scope'\)/.test(body),
    'listSiteEntries reads the by_scope index again — a row missing `order` becomes invisible');
  assert.match(body, /objectStore\('siteEntries'\)/, 'it no longer range-scans the store itself');
  // and the writer must guarantee the field, so no row can be malformed in the first place
  const put = db.slice(db.indexOf('export async function putSiteEntry'));
  const putBody = put.slice(0, put.indexOf('\n}\n') + 1);
  assert.match(putBody, /order/, 'putSiteEntry no longer defaults `order` — the nine call sites must not own it');
});

test('the document can always grow, so it can always scroll (v1.0.50)', () => {
  // Field report: two Samsung tablets, SAME app version — one scrolled the long screens
  // and one could not. CSS is not node-testable, so these are the three properties the fix
  // rests on, pinned as text.
  const css = readRepoCode('www/css/styles.css');
  const body = css.slice(css.indexOf('\nbody {'), css.indexOf('}', css.indexOf('\nbody {')));

  // `height: 100%` pins the body box to the viewport and leaves a taller page depending on
  // the overflow PROPAGATING to the viewport to be scrollable at all — which is exactly
  // the kind of thing two WebView versions disagree about.
  assert.ok(!/(?<!min-)height:\s*100%/.test(body),
    'body is height-pinned again — a page taller than the screen may not scroll at all');
  assert.match(body, /min-height:\s*100%/, 'body no longer grows with its content');

  // `overscroll-behavior: none` also suppresses the local overscroll some WebViews use to
  // START a touch scroll; `contain` blocks the chaining (pull-to-refresh) and keeps it.
  assert.ok(!/overscroll-behavior:\s*none/.test(body),
    'overscroll-behavior:none is back — it can suppress the gesture that starts a scroll');
  assert.match(body, /overscroll-behavior-y:\s*contain/, 'the pull-to-refresh guard is gone');

  const app = css.slice(css.indexOf('\n#app {'), css.indexOf('}', css.indexOf('\n#app {')));
  // A percentage min-height against an auto-height body silently computes to nothing.
  assert.match(app, /min-height:\s*100dvh/, '#app must not size itself off an auto-height ancestor');
  // The last row must clear Android's bottom gesture strip: a swipe starting inside it is
  // claimed by the SYSTEM (immersive + swipe-to-reveal), so the page does not scroll.
  assert.match(app, /padding-bottom:\s*calc\(16px \+ env\(safe-area-inset-bottom/,
    '#app lost its bottom inset — the last row sits under the gesture strip');
});

test('landscape can scroll: vertical swipes over the player reach the page (v1.0.52)', () => {
  // Field report ("מסך מאוזן, יוצאים ממסך מלא, אי אפשר לגלול מטה"): in LANDSCAPE the
  // player is most of the viewport (64vh tall, centered), so the surface a finger
  // naturally swipes is the tap-shield — and `touch-action: none` there meant those
  // swipes scrolled NOTHING. v1.0.50 made the document able to grow and v1.0.51 landed
  // the fullscreen exit at the top; this is the remaining structural piece.
  const css = readRepoCode('www/css/styles.css');
  const shield = css.slice(css.indexOf('.tap-shield'), css.indexOf('}', css.indexOf('.tap-shield')));
  assert.match(shield, /touch-action:\s*pan-y/,
    'the shield no longer lets vertical pans through — a landscape tablet cannot scroll the watch page');
  assert.ok(!/touch-action:\s*none/.test(shield),
    'touch-action:none is back on the shield — swipes over the player scroll nothing');

  // The slop guard: with pan-y a vertical swipe the page claims ends in pointercancel,
  // but a HORIZONTAL swipe — and every swipe while FULLSCREEN, where nothing scrolls —
  // still ends in a pointerup on the shield, and with no threshold a center release
  // PAUSED the video the child was trying to scroll past.
  const player = CODE.get('www/js/player.js');
  assert.match(player, /const onTap = \(e\) => \{\s*if \(!isTapGesture\(downX, downY, e\.clientX, e\.clientY\)\) return;/,
    'onTap no longer asks isTapGesture FIRST — a swipe releasing over the shield reads as a tap');
  assert.match(player, /downX = e\.clientX; downY = e\.clientY;/,
    'onAnyTouch no longer records the press coordinates the slop check compares against');

  // The child's own finger disarms the v1.0.51 pin. The pin exists to defeat the
  // WebView's PROGRAMMATIC scroll restore, which arrives with no pointer event; without
  // the disarm it snapped the child's own scroll back to the top for 700ms after every
  // exit — the "cannot scroll" half of the report the shield fix alone does not cover.
  const app = CODE.get('www/js/app.js');
  assert.match(app,
    /window\.addEventListener\('pointerdown', \(\) => \{ fsExitPinUntil = 0; \}, \{ capture: true, passive: true \}\)/,
    'a pointerdown no longer disarms the fullscreen-exit pin — it eats the child\'s own scroll');
});

test('fixed overlays can always reach their buttons on a short landscape screen (v1.0.52)', () => {
  // Every VIEW grows with its content (v1.0.50), but a position:fixed overlay CANNOT —
  // a modal card taller than a short landscape viewport was clipped at BOTH ends by the
  // flex centering, and nothing could scroll it: the buttons were simply unreachable.
  // Same lesson as .tour-wrap — the card centers by margin:auto (align-items:center
  // clips an overflowing flex item's TOP), and the CONTAINER scrolls.
  const css = readRepoCode('www/css/styles.css');
  const modal = css.slice(css.indexOf('.modal {'), css.indexOf('}', css.indexOf('.modal {')));
  assert.match(modal, /overflow-y:\s*auto/,
    'the modal container no longer scrolls — a tall card strands its buttons off-screen');
  assert.ok(!/align-items:\s*center/.test(modal),
    'align-items:center is back on .modal — it clips an overflowing card\'s top, unreachably');
  const card = css.slice(css.indexOf('.modal-card {'), css.indexOf('}', css.indexOf('.modal-card {')));
  assert.match(card, /margin:\s*auto/,
    'the card lost margin:auto — the overflow-safe centering (the .tour-wrap lesson)');
  const scrim = css.slice(css.indexOf('.modal-scrim'), css.indexOf('}', css.indexOf('.modal-scrim')));
  assert.match(scrim, /position:\s*fixed/,
    'the scrim is absolute again — scrolling a tall card uncovers the page behind it');

  // The parent's preview bubble is fixed too: height-capped so the approve/reject row
  // stays reachable on a short screen, and its children must keep their natural size —
  // flex children SHRINK by default, squishing the video instead of letting it scroll.
  const bubble = css.slice(css.indexOf('.preview-bubble {'), css.indexOf('}', css.indexOf('.preview-bubble {')));
  assert.match(bubble, /max-height:\s*calc\(100dvh/, 'the preview bubble can outgrow a short landscape screen');
  assert.match(bubble, /overflow-y:\s*auto/, 'a height-capped bubble must scroll');
  assert.match(css, /\.preview-bubble > \* \{ flex: 0 0 auto; \}/,
    'the bubble\'s children shrink again — the video squishes instead of the bubble scrolling');
});

test('the now-playing overlay is fullscreen-only and can never swallow a tap (v1.0.53)', () => {
  // User decision 2026-08-19: the title/channel overlay shows ONLY in fullscreen — the
  // title already sits under the player everywhere else. And it is a HUD CONTAINER, so
  // the standing invariant applies: pointer-events:none ALWAYS, or the top of the video
  // stops taking the shield's taps (the exact bug class the HUD bars once had).
  const css = readRepoCode('www/css/styles.css');
  const bar = css.slice(css.indexOf('.player-topbar {'), css.indexOf('}', css.indexOf('.player-topbar {')));
  assert.match(bar, /pointer-events:\s*none/, 'the topbar takes pointer events — taps on the top of the video die');
  assert.match(bar, /opacity:\s*0/, 'the topbar no longer starts hidden');
  // visible ONLY under fullscreen (+hud-on), on BOTH vendor pseudo-classes — older
  // WebViews match only the -webkit- form (the v1.0.43 dual-event lesson, in CSS)
  assert.match(css, /\.player-wrap:fullscreen\.hud-on \.player-topbar,\s*\.player-wrap:-webkit-full-screen\.hud-on \.player-topbar \{ opacity: 1; \}/,
    'the fullscreen+hud-on gate is gone or lost a vendor form');
  assert.ok(!/\.player-wrap\.hud-on \.player-topbar/.test(css),
    'a bare .hud-on rule shows the overlay in the SMALL player too — the user chose fullscreen only');
  // the empty logo host must not render as a ghost circle; bytes un-hide it by arriving
  assert.match(css, /\.np-logo-host:empty \{ display: none; \}/,
    'an empty logo host renders as a blank circle next to the channel name');

  // markup: inside #player-wrap (the fullscreen element) — outside it the overlay is
  // simply invisible in fullscreen, which is the one place it exists to be seen
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  const wrap = html.indexOf('id="player-wrap"');
  const barAt = html.indexOf('id="player-topbar"');
  const hud = html.indexOf('class="player-hud"');
  assert.ok(wrap >= 0 && barAt > wrap && hud > barAt, 'the topbar left #player-wrap');

  // wiring: driven from openWatch (runs on every open AND every video→video switch,
  // including the YouTube reuse path that never re-runs setupHud) — never from player.js
  const app = CODE.get('www/js/app.js');
  const ow = app.slice(app.indexOf('async function openWatch'), app.indexOf('\n}', app.indexOf('async function openWatch')));
  assert.match(ow, /setWatchChannel\(item\)/, 'openWatch no longer sets the overlay channel line');
  const swt = app.slice(app.indexOf('function setWatchTitle'), app.indexOf('\n}', app.indexOf('function setWatchTitle')));
  assert.match(swt, /np-title/, 'setWatchTitle no longer mirrors the title into the overlay');
  assert.match(swt, /const setBoth/, 'the async oEmbed fallback writes only one of the two titles');
  const swc = app.slice(app.indexOf('function setWatchChannel'), app.indexOf('\n}', app.indexOf('function setWatchChannel')));
  assert.match(swc, /host\.textContent = ''/, 'the previous video\'s logo leaks into the next video\'s overlay');
  assert.match(swc, /delete host\.dataset\.logoChannel/,
    'a stale dataset.logoChannel lets planLogoDelivery deliver video A\'s logo into video B');
  assert.match(swc, /nowPlayingChannel\(item, folders\)/, 'the channel line no longer goes through the pure resolver');
  // player.js stays out of it: the reuse path must keep working without re-running setupHud
  assert.ok(!CODE.get('www/js/player.js').includes('np-title'),
    'player.js writes the overlay — the reuse path and setupHud lifecycles will fight over it');
});

test('fullscreen video forces landscape, and the app can NEVER get stuck sideways (v1.0.54)', () => {
  // User request (phone report): with the system rotation lock on, fullscreen played in
  // portrait — a WebView cannot override that lock; only an activity-level request can
  // (it is exactly what YouTube does). Decision 2026-08-25: every handheld device.
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf('const onFullscreenChange = () => {');
  const body = app.slice(at, app.indexOf('\n  };', at));

  // one hook covers every door (tile tap, ⛶, hardware back, a video that ends):
  // the fullscreenchange handler asks the PURE helper and applies its answer
  assert.match(body, /fullscreenOrientation\(\{ fullscreen: entering,/,
    'the orientation decision left the pure helper');
  assert.match(body, /tv: document\.documentElement\.classList\.contains\('tv'\)/,
    'the TV gate is gone — a television has no sensor and must not be touched');
  assert.match(body, /setOrientation\(want\)/, 'the decision is computed but never applied');

  // THE STUCK-LANDSCAPE TRAP: the 'auto' restore must run BEFORE the watch guard.
  // leaveWatch (a video that ENDED) exits fullscreen and then navigates away; a restore
  // gated on nav.isActive('watch') would leave the whole app sideways after every
  // finished video, on every rotation-locked phone.
  const applyAt = body.indexOf('setOrientation(want)');
  const guardAt = body.indexOf("nav.isActive('watch')");
  assert.ok(applyAt >= 0 && guardAt > applyAt,
    'the orientation restore sits after the watch guard — the app stays stuck sideways after a video ends');

  // the platform wrapper is native-first and can never throw at the player
  const platform = CODE.get('www/js/platform.js');
  const fnAt = platform.indexOf('export async function setOrientation');
  assert.ok(fnAt > 0, 'platform.setOrientation is gone');
  const fn = platform.slice(fnAt, platform.indexOf('\n}', fnAt));
  assert.match(fn, /kids && kids\.setOrientation/, 'the wrapper no longer gates on the bridge (browser dev would throw)');
  assert.match(fn, /catch/, 'a rotation hiccup takes the player down with it');

  // BOTH java copies carry the method, sensor-landscape (both ways of holding the
  // device), the UNSPECIFIED restore, and the UI-thread hop — the parity rule
  for (const p of ['android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java',
                   'native-reference/KidsNativePlugin.java']) {
    const java = readRepoCode(p);
    assert.ok(java.includes('public void setOrientation'), `${p}: setOrientation missing`);
    assert.ok(java.includes('SCREEN_ORIENTATION_SENSOR_LANDSCAPE'),
      `${p}: not SENSOR_LANDSCAPE — a child holding the phone the "wrong" way up gets an upside-down video`);
    assert.ok(java.includes('SCREEN_ORIENTATION_UNSPECIFIED'),
      `${p}: no UNSPECIFIED restore — leaving fullscreen would keep the whole app landscape`);
    assert.ok(/runOnUiThread[\s\S]{0,400}setRequestedOrientation/.test(java),
      `${p}: setRequestedOrientation must run on the UI thread`);
  }
});

test('the code keypad shows NOTHING when pressed, and the code can be TYPED (v1.0.55)', () => {
  // User request: a parent entering the code with the child on their lap must not have
  // each digit light up under their finger. The ONLY feedback is the dots row — how many,
  // never which. The rule is one deleted CSS line, so the guard is textual by necessity.
  const css = readRepoCode('www/css/styles.css');
  assert.ok(!css.includes('.key:active'),
    'a .key:active rule is back — the pressed digit lights up for the watching child');
  assert.ok(!css.includes('.key:hover'),
    'a .key:hover rule highlights the digit under the pointer');
  // The TV focus ring STAYS: a D-pad cannot walk an invisible pad, and many Android TV
  // remotes carry no digit buttons at all — the typed path is an addition, never a
  // replacement for the on-screen pad (user decision 2026-08-28).
  assert.match(css, /html\.tv button:focus/,
    'the TV focus ring rule is gone — a remote cannot navigate the pad at all');

  // The typed path: remote/keyboard digits reach the SAME onKey pipeline, gated on the
  // PIN view being the active view and on no modal sitting over it (the recovery flow
  // stacks confirms there — digits must not leak into the buffer behind them).
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf('pinKeyAction(e.key)');
  assert.ok(at > 0, 'the typed-code path is gone — a TV remote with digit buttons cannot enter the code');
  const handler = app.slice(app.lastIndexOf('window.addEventListener', at), at);
  assert.match(handler, /nav\.isActive\('pin'\)/,
    'typed digits are no longer gated on the PIN view — keystrokes anywhere feed the code buffer');
  assert.match(handler, /isModalOpen\(\)/,
    'typed digits are consumed under a stacked modal — the recovery confirms leak into the buffer');
  // dpad.js's ~30/s lesson: Android TV auto-repeats a HELD key. Without this gate a held
  // digit types itself four times — and in SETUP mode (a family with no code yet) it fills
  // step 1 with '7777' and the still-repeating key confirms step 2: the family's parent
  // code set without anyone choosing it. Review-caught (v1.0.55 hardening pass).
  assert.match(handler, /if \(e\.repeat\) return;/,
    'a held remote key types repeated digits — setup mode can silently mint code 7777');

  // AND the gate must never leak into enterParent (review-caught: a global regex revert
  // once pasted `|| isModalOpen()` into its guard, so a CORRECT code entered while any
  // modal was up — an update prompt resolving mid-await — stranded the parent on the PIN
  // screen with the buffer consumed and no message).
  const epAt = app.indexOf('async function enterParent(');
  assert.ok(epAt > 0, 'enterParent lost — re-anchor this guard');
  const ep = app.slice(epAt, app.indexOf('\n}', epAt));
  assert.ok(!ep.includes('isModalOpen'),
    "enterParent bails on an open modal — a correct code entered under an update prompt is silently eaten");
});

test('the full-tablet break lock: pinned while shown, code-gated exit, released only kiosk-off (v1.0.55)', () => {
  // User request: the parent chooses whether the break locks only the APP (today) or the
  // WHOLE TABLET. The mechanism is the kiosk's own OS screen pinning, so every wiring
  // half below is a containment decision — each proven red on a planted regression, all
  // judged on COMMENT-STRIPPED source (the review found the first version's ordering
  // guard anchored on a comment, and its unlockTask guard satisfied by one).
  const app = CODE.get('www/js/app.js');

  // 1) ONE settings read feeds the pure decision — the 5s tick pays it for a whole break.
  const decide = fnSlice(app, 'async function breakContainment(');
  assert.match(decide, /getSettings\(pid, \['exitLock', 'lockTablet'\], false\)/,
    'breakContainment no longer reads both flags in one round-trip');
  assert.match(decide, /lockScreenContainment\(/, 'the containment decision moved inline');

  // 2) The screen applies containment BEFORE the reveal (the door's hidden class is
  //    sticky DOM state from the previous break — painting first showed a stale, possibly
  //    free, door) and AFTER the parent-screen guard (the OS pinning ceremony must never
  //    run over a parent mid-configuration).
  const show = fnSlice(app, 'async function showLockedScreen(');
  const guardAt = show.indexOf("nav.isActive('parent')");
  const containAt = show.indexOf('refreshLockContainment');
  const resetAt = show.indexOf("nav.reset('locked')");
  assert.ok(guardAt > 0 && containAt > 0 && resetAt > 0, 'showLockedScreen lost a load-bearing step');
  assert.ok(containAt > guardAt,
    'containment runs before the parent-screen guard — the OS ceremony lands on a configuring parent');
  assert.ok(resetAt > containAt,
    'the screen is revealed before the exit door is resolved — a stale door is painted');

  // 3) refreshLockContainment: door + pin from the pure decision, and a SUCCESSFUL pin
  //    records the break's OWNERSHIP — the fact the release is gated on.
  const arm = fnSlice(app, 'async function refreshLockContainment(');
  assert.match(arm, /if \(!contain\.pinTask\) return;/,
    'refreshLockContainment pins without asking containment — it would pin every family');
  assert.match(arm, /if \(\(await lockTask\(\)\) === true\) breakPinHeld = true;/,
    'a successful pin no longer records break ownership — the release has nothing honest to gate on');
  assert.match(arm, /catch/, 'refreshLockContainment can throw at the lock screen');

  // 4) The 5s tick RE-APPLIES containment while the screen is up, and keeps re-pinning
  //    while a CODE SCREEN sits over it: the hold-back+recents gesture fires no resume
  //    event, so without the pin-over-lock branch a child taps 🚪, leaves the code screen
  //    up, gestures, presses HOME — and the whole break is escaped.
  const tick = fnSlice(app, 'async function tickScheduledLock(');
  assert.match(tick, /nav\.isActive\('locked'\)\) \{[\s\S]*?refreshLockContainment\(\)/,
    'the tick no longer re-applies containment — the unpin gesture escapes the whole break');
  assert.match(tick, /nav\.isActive\('pin'\) && breakPinHeld/,
    'a code screen over the lock suspends the re-assert — gesture-unpin + HOME escapes the break');

  // 5) EVERY teardown goes through clearScheduledLock — including the phase-off path
  //    (a parent zeroing lockAfterMin on ANOTHER device syncs here, and evalScheduledLock
  //    answers off before it ever reads lockedUntil): it must release the pin and drop the
  //    stale until stamp, or re-enabling the feature later re-locks the child instantly.
  assert.match(tick, /\{ await clearScheduledLock\(e\.pid \|\| activeProfileId\); leaveLockedScreen\(\); \}/,
    "the phase-off teardown skips clearScheduledLock — the tablet stays pinned and a stale `until` re-locks later");

  // 6) The release is gated on the break's OWNERSHIP of the pin (breakPinHeld — never a
  //    re-read of the toggle, which can flip mid-break) AND on the kiosk veto
  //    (unpinOnClear); the ownership flag always drops.
  const clear = fnSlice(app, 'async function clearScheduledLock(');
  assert.match(clear, /if \(breakPinHeld && \(await breakContainment\(pid\)\)\.unpinOnClear\) \{/,
    'the release lost its ownership/kiosk gate — kiosk sessions unpin, or a toggled-off break never releases');
  assert.match(clear, /await unlockTask\(\);/, 'the break never releases the pin at all');
  assert.match(clear, /breakPinHeld = false;/,
    'the ownership flag is never dropped — the next break inherits a stale claim');

  // 7) The exit door reads the FULL containment at tap time: kiosk ⇒ SELF-HEAL (re-hide,
  //    never exit through a stale button), full lock ⇒ the shared code-gated exit, else
  //    today's free exit.
  const door = fnSlice(app, 'async function onLockedExitTap(');
  assert.match(door, /if \(contain\.hideExit\) \{ \$\('locked-exit'\)\.classList\.add\('hidden'\); return; \}/,
    'a stale-visible door under the kiosk exits instead of self-healing');
  assert.match(door, /if \(contain\.gateExit\) \{ await pinGatedExit\(\); return; \}/,
    'the full-tablet lock lost its code gate on the exit door');
  assert.match(door, /\n  exitApp\(\);\n/, "the free-exit path is gone — today's families lose their exit");
  assert.match(app, /\$\('locked-exit'\)\.addEventListener\('click', \(\) => \{ onLockedExitTap\(\)\.catch/,
    'locked-exit is bound straight to exitApp again — the code gate is bypassed');

  // 8) ONE code-gated exit ceremony — the unpin-before-exit order and the keyguard
  //    consequence live in a single place — with EXACTLY two callers (askExit + the door).
  const gated = fnSlice(app, 'async function pinGatedExit(');
  assert.match(gated, /startPin\(/, 'the gated exit no longer asks for the parent code');
  assert.match(gated, /await unlockTask\(\);[\s\S]*?exitApp\(\);/,
    'the gated exit no longer unpins before exiting — Android refuses to finish a pinned task');
  assert.equal((app.match(/await pinGatedExit\(\);/g) || []).length, 2,
    'pinGatedExit must have exactly two callers — askExit and the break door (a third needs its own review)');

  // 9) The setting rides the synced channel like its siblings (per-profile, tie → locked,
  //    pinned behaviourally in settings.test.mjs).
  assert.match(app, /putSetting\(activeProfileId, 'lockTablet'/,
    'lockTablet is not saved to the synced settings channel');

  // 10) פתיחה להורים is STACKED, never replace: with replace, cancelling the code landed
  //     the child on the gallery until the next tick — a spammable escape hatch.
  const parentTap = fnSlice(app, 'async function onLockedParentTap(');
  assert.ok(!parentTap.includes('replace'),
    'onLockedParentTap replaces the lock view — cancelling the code drops the child on the gallery');
});

test('swipe paging is wired to the three grids and nothing else (v1.0.57)', () => {
  // The gesture shares every surface it lives on with a tap on a <button> tile, a vertical
  // scroll, and — one view over — the player's own three-meaning finger language. Each
  // half below is a way for the feature to look right and behave wrong on a device, which
  // is precisely what node cannot see.
  const swipe = CODE.get('www/js/ui/swipe.js');
  const app = CODE.get('www/js/app.js');
  assert.ok(swipe, 'ui/swipe.js is gone');

  // 1) ONE geometry decision. A second copy — an inline dx check in a handler — is a
  //    second answer to "was that a swipe or a tap", and the two will disagree.
  assert.match(swipe, /import \{[^}]*swipePageAction[^}]*\} from '\.\.\/plan\.js'/,
    'ui/swipe.js no longer delegates to the pure decision');
  assert.match(swipe, /swipePageAction\(\{/, 'ui/swipe.js stopped calling the pure decision');
  // v1.0.62 — the live drag adds three MORE decisions, and they must live in the same one
  // place for the same reason: arming, the offset and the commit are all answers to "was
  // that a swipe", and a second copy of any of them would disagree with the release.
  for (const fn of ['swipeDragArm', 'swipeDragOffset', 'swipeDragCommit']) {
    assert.match(swipe, new RegExp(fn + '\\('), `ui/swipe.js does not use plan.${fn}`);
  }
  for (const [p, body] of CODE) {
    if (p === 'www/js/ui/swipe.js' || p === 'www/js/plan.js') continue;
    assert.doesNotMatch(body, /swipePageAction|swipeDragArm|swipeDragOffset|swipeDragCommit/,
      `${p} decides swipes on its own`);
  }

  // 2) pointercancel next to pointerup — the v1.0.22 seek-bar invariant, same disease: the
  //    OS steals drags, no pointerup arrives, and a start left standing pairs with some
  //    later unrelated release and turns a page nobody asked for.
  assert.match(swipe, /addEventListener\('pointercancel'/,
    'the swipe never releases a stolen gesture — a later release will turn a page');
  assert.match(swipe, /addEventListener\('pointerup'/, 'the swipe lost its end event');

  // 2b) A LOST END MAY NEVER EAT THE NEXT SWIPE (browser-measured, 2026-08-30). The first
  //     version dropped a gesture whenever a start was still standing — written for a
  //     second finger, and in practice it swallowed every other swipe once an end went
  //     missing (the grid re-renders under the finger; a call backgrounds the app
  //     mid-touch). pointerdown must therefore start fresh unconditionally, and multi-touch
  //     is refused by the id check on the RELEASE instead.
  const downHandler = swipe.slice(swipe.indexOf("addEventListener('pointerdown'"));
  assert.doesNotMatch(downHandler.slice(0, downHandler.indexOf('}, { passive')),
    /if \(start\)[\s\S]*?return;/,
    'pointerdown drops a gesture when a start is standing — a lost end will eat the next swipe');
  assert.match(swipe, /e\.pointerId !== s\.id/,
    'the release no longer checks the pointer id — a pinch can turn a page');

  // 3) The click swallow, in CAPTURE phase. A tile is a <button> and the flick ENDS on one:
  //    without this, turning the page also opens whatever video the finger released over.
  //    Bubbling would be too late — the tile's own handler is bound deeper than the host.
  const click = swipe.slice(swipe.indexOf("addEventListener('click'"));
  assert.ok(click.includes('preventDefault') && click.includes('stopPropagation'),
    'the post-swipe click is no longer swallowed — a page turn opens a video');
  assert.match(click, /\}, true\)/, 'the click swallow left the capture phase — the tile fires first');

  // 4) THE WATCH SURFACE IS THE GRID, NEVER THE PLAYER. Centre tap pauses, double tap
  //    seeks ±10s, and the shield is what v1.0.52 spent three releases getting right — a
  //    page turn must never become a fourth meaning for a finger crossing it.
  const hosts = [...app.matchAll(/attachSwipePager\(\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(hosts, ['view-gallery', 'view-folder', 'watch-grid'],
    'the swipe hosts changed — the watch view must bind its GRID, never the player');

  // 5) The count the swipe reads is the count the arrows were drawn from. The home pager is
  //    hand-written markup with no object holding it, so updateHomePager must publish it or
  //    a flick walks the child past the last page onto an empty grid.
  assert.match(fnSlice(app, 'function updateHomePager('), /homePages\s*=/,
    'updateHomePager no longer publishes the page count the swipe reads');
  assert.match(CODE.get('www/js/ui/pager.js'), /state:\s*\(\)\s*=>\s*\(\{ page, total \}\)/,
    'makePager no longer exposes its live page state to the swipe');

  // 6) `pan-y`, never `none` and never left to `auto`: with `auto` the browser claims a
  //    slightly-diagonal flick as a scroll and cancels it; with `none` the page cannot
  //    scroll from the grid at all — the exact v1.0.50/51 bug, on a new surface.
  const css = readRepoCode('www/css/styles.css');
  const rule = css.match(/#view-gallery, #view-folder, #watch-grid \{ touch-action: ([a-z-]+); \}/);
  assert.ok(rule, 'the swipe hosts lost their touch-action rule');
  assert.equal(rule[1], 'pan-y', 'the swipe hosts must be pan-y — `none` kills scrolling, `auto` kills the swipe');
});

test('🕒 נצפה לאחרונה is wired end to end, and device-local (v1.0.57)', () => {
  const app = CODE.get('www/js/app.js');
  const dbm = CODE.get('www/js/db.js');

  // 1) THE THREE DERIVED FOLDERS MUST STAY IN LOCKSTEP. 🎁 and ⭐ each shipped a bug where
  //    one renderer knew the folder and another did not (v1.0.21: an empty under-player
  //    grid, i.e. the child loses every way to reach the next video). pageAnyFolder is THE
  //    pagination entry point and nextAfter is the chain — a kind in one and not the other
  //    means the chain silently disagrees with what is on screen.
  const pager = fnSlice(app, 'async function pageAnyFolder(');
  const chain = fnSlice(app, 'async function nextAfter(');
  assert.match(pager, /fid === 'recent'/, 'pageAnyFolder does not know 🕒 — the folder renders empty');
  assert.match(chain, /fid === 'recent'/, 'nextAfter does not know 🕒 — the chain disagrees with the grid');

  // 2) THE CHAIN READS THE FROZEN SNAPSHOT, NEVER THE LIVE ORDER. Watching a video moves it
  //    to the FRONT of this folder, so a live re-read hands back the video before it and the
  //    chain rocks between the same two forever.
  const recentBranch = chain.slice(chain.indexOf("fid === 'recent'"));
  assert.match(recentBranch.slice(0, 400), /watchCtx\.recent/,
    'the 🕒 chain re-reads the live order — it will ping-pong between two videos');
  assert.doesNotMatch(recentBranch.slice(0, 400), /recentKeys\(giftStates/,
    'the 🕒 chain re-derives the order instead of using the snapshot');
  assert.match(fnSlice(app, 'async function openWatch('), /watchCtx\.recent =/,
    'openWatch no longer freezes the 🕒 order');

  // 3) The stamp is INDEPENDENT of the resume setting (saveWatchPosition is gated on it, and
  //    this folder must work for a family that never turns resume on) and runs ONCE per
  //    opening — the interval fires every few seconds and every write bumps dataVersion(),
  //    which is what the home's folder cache keys off.
  const stamp = fnSlice(app, 'function stampWatched(');
  assert.doesNotMatch(stamp, /resumeEnabled/, 'the 🕒 stamp was gated on the resume setting');
  assert.match(stamp, /stampedWatch === item\.key/, 'the stamp no longer runs once per opening');
  assert.match(stamp, /recentLimit <= 0/, 'the stamp writes state even when the folder is off');

  // 4) The folder cache key names the SETTING. Settings live in Preferences, so changing
  //    this number does NOT move db.dataVersion() — without it in the key the child's home
  //    keeps the old folder until some unrelated write happens to bump the counter.
  const build = fnSlice(app, 'async function buildFolders(');
  assert.match(build, /cache\.recentLimit === recentLimit/,
    'the folder cache ignores the 🕒 setting — changing it will not repaint the home');

  // 5) DEVICE-LOCAL, both directions (behaviourally pinned in gdrive.test.mjs; this pins
  //    that the fields exist where they must). The serializer is an allowlist, so the
  //    dangerous half is the APPLY side silently dropping the local stamp.
  assert.match(CODE.get('www/js/drive.js'), /mine\.playedAt !== undefined\) out\.playedAt = mine\.playedAt/,
    'a Drive pull erases the local 🕒 stamps');

  // 6) THE ROW-DELETE PREDICATE IS THE SHARED PURE ONE. The inline version it replaced ate
  //    ⭐ (see normalize.stateRowIsSpent); the next feature to share this row must extend
  //    that function, not write a second answer here.
  assert.match(dbm, /import \{ stateRowIsSpent \} from '\.\/normalize\.js'/,
    'db.js no longer uses the shared row-spent predicate');
  assert.equal((dbm.match(/stateRowIsSpent\(rec\)/g) || []).length, 2,
    'both row-clearing paths (position + watch stamp) must use the shared predicate');
  assert.doesNotMatch(dbm, /rec\.giftRank === undefined && !rec\.unwrappedAt/,
    'the inline row-spent check is back — it deletes ⭐ and 🕒 with the row');

  // 7) The snapshot import must FOLD onto the live row, never rebuild it: this store is one
  //    row per (child, video) shared by every per-child feature, and a blind put erased the
  //    child's ⭐, their resume position and their 🕒 for every video the file mentioned.
  const imp = CODE.get('www/js/snapshot.js');
  assert.match(imp, /\.\.\.\(existing\.get\(st\.key\) \|\| \{\}\)/,
    'the snapshot import rebuilds state rows from scratch — it erases ⭐ and 🕒');
});

test('a call pauses the video and the END of the call resumes it (v1.0.57)', () => {
  const app = CODE.get('www/js/app.js');
  const platform = CODE.get('www/js/platform.js');

  // 1) THE DECISION IS PURE AND NOBODY ELSE ANSWERS IT. "Was that a call?" decides whether
  //    a video starts itself in a room, so an inline second opinion is not acceptable.
  const check = fnSlice(app, 'async function checkCallResume(');
  assert.match(check, /planCallResume\(\{/, 'app.js decides the call resume inline');
  for (const [p, body] of CODE) {
    if (p === 'www/js/app.js' || p === 'www/js/playerlogic.js') continue;
    assert.doesNotMatch(body, /planCallResume|isCallAudioMode/, `${p} answers the call question on its own`);
  }

  // 2) THE STATE IS RE-READ AFTER THE AWAIT. Reading the audio mode is a bridge call, and
  //    during it the child can leave, the video can change, or a scheduled break can take
  //    the screen — acting on what was true before the await is how a video ends up playing
  //    under a lock screen.
  const awaitAt = check.indexOf('await audioMode()');
  assert.ok(awaitAt > 0, 'the audio mode is no longer read from the device');
  const after = check.slice(awaitAt);
  assert.match(after, /playbackState\(\)/, 'the playback state is read before the await — it may be stale');
  assert.match(after, /inWatch: nav\.isActive\('watch'\)/, 'the view is not re-checked after the await');

  // 3) ARMING AT THE PAUSE REQUIRES THE VIDEO TO HAVE BEEN PLAYING. `pauseCurrent()` runs
  //    first in that handler, so a state read afterwards always says "paused" — and arming
  //    on it would resume a video the child had deliberately paused BEFORE the call.
  const m = [null, appPauseBody(app)];
  assert.ok(m[1], 'the onAppPause listener is gone');
  assert.match(m[1], /const st = playbackState\(\);[\s\S]*?pauseCurrent\(\)/,
    'the playhead is no longer read BEFORE the pause');
  assert.match(m[1], /if \(st && st\.playing\) checkCallResume\(\)/,
    'the pause arms a call resume even for a video that was already paused');

  // 4) ORDER ON RESUME: the scheduled-lock check runs FIRST. A break that matured during
  //    the call resets nav to the lock screen, and planCallResume then disarms because the
  //    watch view is gone — resuming first would leave a video playing behind the lock.
  const resumeFn = app.slice(app.indexOf('onAppResume(async () => {'));
  const lockAt = resumeFn.indexOf('tickScheduledLock()');
  const callAt = resumeFn.indexOf('checkCallResume()');
  assert.ok(lockAt >= 0 && callAt > lockAt,
    'the call resume runs before the scheduled-lock check — a video can play behind the lock');

  // 5) THE APP'S OWN IDLE PARK IS NOT A CALL PAUSE. Without this the watcher would see a
  //    paused video during a later call, arm, and restart the video into the empty room the
  //    idle feature exists to protect.
  assert.match(app, /idleParkedAt = Date\.now\(\)/, 'the idle sleep no longer marks its park');
  assert.match(app, /idleParkedAt = 0/, 'the park flag is never cleared — one park kills the feature');
  assert.match(app, /!callResume && !idleParkedAt\) checkCallResume/,
    'the in-app poll no longer skips an app-parked video');

  // 6) LEAVING THE VIDEO DROPS THE INTENT AND ITS TIMER. A poll left running for the rest
  //    of the session would fire a resume at a torn-down player.
  const leave = app.slice(app.indexOf("nav.register('watch', {"));
  assert.match(leave.slice(0, 1200), /disarmCallResume\(\)/, "the watch view's onLeave leaks the call watcher");
  assert.match(fnSlice(app, 'function disarmCallResume('), /clearInterval|stopCallWatch/,
    'disarming leaves the poll running');

  // 7) THE BRIDGE NEVER GUESSES 'normal'. An older APK, a browser or a refused getter must
  //    read as "no evidence", or every backgrounding would look like a call that ended.
  const fn = platform.slice(platform.indexOf('export async function audioMode('));
  assert.match(fn.slice(0, 600), /return 'unknown'/, 'platform.audioMode can answer something other than unknown on failure');
  assert.doesNotMatch(fn.slice(0, 600), /return 'normal'/, "platform.audioMode guesses 'normal' — every pause would resume");
});

test('the audio-mode reader is in BOTH java copies and needs no permission (v1.0.57)', () => {
  const a = readRepo('android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java');
  const b = readRepo('native-reference/KidsNativePlugin.java');
  assert.equal(a, b, 'the two KidsNativePlugin copies drifted — native-reference is the rebuild copy');
  for (const src of [a, b]) {
    assert.match(src, /public void audioMode\(PluginCall call\)/, 'audioMode is missing from a java copy');
    assert.match(src, /AudioManager\.MODE_IN_COMMUNICATION/, 'VoIP calls (WhatsApp) are not detected');
    assert.match(src, /String mode = "unknown"/, 'the java default is not the safe "unknown"');
  }
  // READ_PHONE_STATE would be a runtime permission prompt on a child's tablet, to resume a
  // video. AudioManager.getMode() needs none and catches VoIP as well.
  // ⚠️ COMMENT-STRIPPED. The manifest's own comment NAMES the permissions it refuses, so a
  // raw grep fires on the very text that documents the rule — the v1.0.45 trap, where three
  // guards tripped on their own comments. Read what the file DECLARES, not what it says.
  const manifest = readRepo('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(manifest, /READ_PHONE_STATE|READ_CALL_LOG|PROCESS_OUTGOING_CALLS/,
    'a telephony permission appeared — call detection must stay permission-free');
  for (const [p, body] of CODE) {
    assert.doesNotMatch(body, /TelephonyManager/, `${p} reaches for telephony instead of the audio mode`);
  }
});

test('a NESTED Drive folder becomes a list of ordinary folders (v1.0.58)', () => {
  const app = CODE.get('www/js/app.js');
  const pub = CODE.get('www/js/gdrivepub.js');

  // 1) NO NEW FOLDER KIND. The whole v1.0.56 promise — paging, search, the watch-grid
  //    chain, deletion with tombstones, the Drive sync — rests on a Drive folder being an
  //    ordinary `cf:` custom folder. A tree must flatten INTO that, never grow a second
  //    shape, and the app must still have no folder-inside-a-folder screen.
  assert.doesNotMatch(fnSlice(app, 'async function pageAnyFolder('), /driveFolderId|driveRootId/,
    'paging grew a Drive branch — a nested import must still be ordinary cf: folders');
  assert.doesNotMatch(fnSlice(app, 'async function nextAfter('), /driveFolderId|driveRootId/,
    'the watch chain grew a Drive branch');

  // 2) THE REFRESH WALKS ROOTS ONLY. Every folder of a tree carries its own driveFolderId
  //    (that is what makes each refill itself), but the root's walk already re-lists the
  //    whole tree — so refreshing descendants too would list a 33-folder tree 33 times
  //    over, every half hour, on a family's mobile data.
  const ref = fnSlice(app, 'async function refreshDriveFolders(');
  assert.match(ref, /driveRootId/, 'the refresh no longer skips the descendants of a tree');
  assert.match(ref, /roots\.has\(f\.driveRootId\)/,
    'a descendant whose ROOT row is gone must refresh itself again, or it silently stops updating');
  assert.match(ref, /driveSyncedAt/, 'the refresh lost its throttle');

  // 3) ONE NAME FOR "THIS ENTRY IS A FOLDER", and both doors report it: files.list in
  //    `mimeType`, the public page in the row's href. A second opinion anywhere is how the
  //    keyless door came to answer `null` for every subfolder in the first place.
  assert.match(pub, /export const DRIVE_FOLDER_MIME = 'application\/vnd\.google-apps\.folder'/,
    'the folder mime lost its single home');
  assert.match(pub, /const isFolder = \/\\\/drive\\\/folders\\\/\[A-Za-z0-9_-\]\+\/\.test\(b\)/,
    'the keyless parser no longer tells a subfolder by its LINK — the icon alone cannot');
  for (const [p, body] of CODE) {
    if (p === 'www/js/gdrivepub.js') continue;
    assert.doesNotMatch(body, /vnd\.google-apps\.folder/, `${p} hard-codes the folder mime instead of asking gdrivepub`);
  }

  // 4) THE WALK IS BOUNDED, and the bound is a named constant an operator can see rather
  //    than a magic number hidden in a default (the v1.0.37 "a constant with no consumer is
  //    a lie" rule, in the other direction).
  assert.match(pub, /DRIVE_TREE_MAX_FOLDERS/, 'the tree walk lost its folder cap');
  assert.match(pub, /DRIVE_TREE_MAX_FILES/, 'the tree walk lost its file cap');
  assert.match(CODE.get('www/js/config.js'), /export const DRIVE_TREE_MAX_FOLDERS/, 'the caps left config.js');
  const walk = fnSlice(pub, 'export async function fetchDriveFolderTree(');
  assert.match(walk, /seen\.has\(entry\.id\)/, 'the cycle guard is gone — a Drive shortcut can loop the walk forever');
  assert.match(walk, /truncated = true/, 'hitting a cap is no longer recorded, so the parent cannot be told');
  assert.match(walk, /node\.depth === 0\) rootFailed = true; else partial = true/,
    'an unreadable ROOT and an unreadable CHILD collapsed into one fact');

  // 5) STILL ADDITIVE — the v1.0.56 decision, now across a whole tree.
  const imp = fnSlice(app, 'async function importDriveFolder(');
  for (const banned of [/deleteVideo\(/, /deleteVideoRaw\(/, /deleteVideosWithTombstones\(/, /deleteCustomFolder\(/]) {
    assert.doesNotMatch(imp, banned, 'the tree import deletes — it is ADDITIVE ONLY');
  }
});

test('the download cache prunes itself, and deletion reaches the device (v1.0.58)', () => {
  const app = CODE.get('www/js/app.js');
  const media = CODE.get('www/js/media.js');

  // 1) THE DECISION IS PURE AND app.js ONLY PERFORMS IT — the db.js split. What gets
  //    deleted off a family's tablet is not a judgement to make inline.
  const sweep = fnSlice(app, 'async function sweepDownloadCache(');
  assert.match(sweep, /planCacheSweep\(/, 'the cache sweep decides inline');
  assert.match(sweep, /CACHE_SWEEP_EVERY_MS/, 'the sweep lost its throttle — it would list the directory on every home entry');
  assert.match(sweep, /cacheSweptAt/, 'the throttle has nothing to remember');
  // a file we just expired must be forgotten by its record, or every later play stats a
  // path that no longer exists
  assert.match(sweep, /localPath: null/, 'an expired file leaves a record pointing at nothing');
  // and the no-stamp case must be STAMPED, never deleted — that is the whole difference
  // between this policy and the blanket wipe the user rejected
  assert.match(sweep, /stampMissing/, 'files with no use stamp are no longer given a window');

  // 2) THE CLOCK IT RUNS ON IS THE ONE HONEST SIGNAL: a cached copy was actually played.
  assert.match(media, /touchLocalUse\(item\)/, 'playing a cached file no longer records that it was used');
  assert.match(fnSlice(media, 'export async function prepareStreamSrc('), /touchLocalUse/,
    'the use stamp left the one place that knows a local copy was served');
  // device-local, exactly like localPath: it describes a file on THIS tablet
  assert.doesNotMatch(CODE.get('www/js/drive.js'), /localUsedAt/, 'the use stamp travels to other devices');

  // 3) BOTH SWEEPS RUN AFTER THE PULL AND THE DRIVE REFRESH, never before: those two ADD
  //    content, and a sweep that ran first would judge a folder empty a second before its
  //    videos arrived — deleting a folder full of songs, on every device.
  const entry = fnSlice(app, 'async function entryRefresh(');
  const pullAt = entry.indexOf('maybePullDrive()');
  const driveAt = entry.indexOf('refreshDriveFolders(');
  const emptyAt = entry.indexOf('sweepEmptyFolders()');
  const cacheAt = entry.indexOf('sweepDownloadCache()');
  assert.ok(pullAt >= 0 && driveAt > pullAt, 'the entry refresh no longer pulls before refreshing Drive folders');
  assert.ok(emptyAt > driveAt, 'the empty-folder sweep runs before the content that fills folders arrives');
  assert.ok(cacheAt > driveAt, 'the cache sweep runs before the Drive refresh that may claim files');

  // 4) THE "DELETE FROM THE DEVICE TOO?" QUESTION IS ASKED ONCE, BY ONE HELPER. Every
  //    deletion surface must go through it, or one of them silently leaves files behind.
  assert.match(fnSlice(app, 'async function askDeleteLocalCopies('), /deleteLocalChoice\(/,
    'the delete-from-device question is decided inline');
  const callers = (app.match(/askDeleteLocalCopies\(/g) || []).length;
  assert.ok(callers >= 4, 'a deletion surface stopped asking about the downloaded copy: ' + callers);
  // cancelling must not delete anything — the answer is a THREE-way choice
  assert.match(app, /if \(choice === 'cancel'\) return;/, 'cancelling the device question still deletes the video');
  assert.match(fnSlice(app, 'async function applyDeleteLocalCopies('), /deleteLocalFiles\(/,
    'the chosen answer is never carried out');

  // 5) GOOGLE DRIVE IS NEVER TOUCHED. The app deletes its own cached copy and nothing else —
  //    the user's explicit condition.
  // the pattern names the REMOTE surfaces only: a looser /delete/i matched the function's
  // own name and tripped on correct code — the self-tripping guard TESTING.md warns about
  assert.doesNotMatch(fnSlice(media, 'export async function deleteLocalFiles('),
    /gdrivepub|googleapis|drive\.google|files\.delete/i,
    'the local-copy deletion reaches beyond the device cache — Google Drive must never be touched');
  assert.match(CODE.get('www/js/platform.js'), /export async function fsDeleteFile\(/, 'the per-file delete is gone');
});

test('an EMPTY folder is deleted, not just hidden (v1.0.58)', () => {
  const app = CODE.get('www/js/app.js');
  const sweep = fnSlice(app, 'async function sweepEmptyFolders(');
  assert.match(sweep, /planEmptyFolderSweep\(/, 'the empty-folder sweep decides inline');
  // the deletion must write the ordinary tombstone, or a peer re-adds the row on its next
  // push — the v1.0.36 lesson, which is why this goes through deleteCustomFolder
  assert.match(sweep, /deleteCustomFolder\(/, 'the sweep no longer deletes through the tombstoned path');
  assert.doesNotMatch(sweep, /tombstone: false/, 'the sweep deletes without a tombstone — a peer will bring the folder back');
  // the home still hides a zero-count folder (a row can exist for a moment before the
  // sweep runs, and the child must never see an empty tile — the v1.0.21 rule)
  assert.match(fnSlice(app, 'async function buildFolders('), /if \(!count\) continue;/,
    'the home stopped hiding a folder that is still empty');
});

test('a folder picture has three doors, and only the parent installs one (v1.0.58)', () => {
  const app = CODE.get('www/js/app.js');
  const art = CODE.get('www/js/folderart.js');
  // the module may still only PROPOSE — the v1.0.56 rule, now with a third proposer
  assert.doesNotMatch(art, /putCustomFolder|putThumb|db\.js/, 'folderart.js writes to the database');
  assert.match(art, /export function artUrlCandidate\(/, 'the pasted-link door left the pure module');
  // https only: these bytes are fetched by the app and shown to a CHILD
  assert.match(fnSlice(art, 'export function artUrlCandidate('), /\^https:/,
    'the pasted picture link is no longer restricted to https');
  // ONE renderer for search results and pasted links — a second copy is a second answer to
  // "what if the picture will not load", and that answer is load-bearing
  assert.match(fnSlice(app, 'async function addFolderArtFromUrl('), /renderArtCandidates\(/,
    'the pasted link renders through its own copy of the candidate loop');
  assert.match(fnSlice(app, 'function renderArtCandidates('), /addEventListener\('error'/,
    'a candidate that cannot load is still offerable — the parent would pick a picture the folder can never show');
  // changing an EXISTING folder's picture stores BYTES, like creation does (v1.0.32)
  const edit = fnSlice(app, 'async function saveFolderArtEdit(');
  assert.match(edit, /httpGetBlob\(/, 'the changed picture is not fetched as bytes');
  assert.match(edit, /putThumb\(/, 'the changed picture is not cached');
  assert.match(edit, /putCustomFolder\(/, 'the changed picture never reaches the folder row');
  // the editor borrows the creation view, so it MUST put the chrome back
  assert.match(fnSlice(app, 'async function renderFolderPick('), /fpArtEditing = null/,
    'the destination picker can open still in art-editing mode');
  assert.match(fnSlice(app, 'async function renderFolderPick('), /setFolderNameFieldVisible\(true\)/,
    'the name field stays hidden after an art edit — the next folder could not be named');
});

test('searching inside a folder reuses the ONE pagination entry point (v1.0.58)', () => {
  const app = CODE.get('www/js/app.js');
  const build = fnSlice(app, 'async function buildFolderSearchIndex(');

  // 1) THE CANDIDATES COME FROM pageAnyFolder, never from a second reading of the folder
  //    rules. That function already knows every folder kind — the 🎁/⭐/🕒 views that carry
  //    no folderId at all, a channel's absorbed singles, the trimmed loose list. Filtering
  //    the merge index by folderId instead would be a SECOND answer to "what is in this
  //    folder", and the two would disagree exactly where it hurts (the v1.0.21 bug that
  //    cost the child every way out of a gift).
  assert.match(build, /pageAnyFolder\(/, 'the folder search reads the library on its own terms');
  assert.doesNotMatch(build, /loadMergeIndex\(/, 'the folder search re-derives folder membership');
  assert.match(build, /folderSearchScope\(/, 'the scope is decided inline');

  // 2) THE LOCK IS PASSED IN, and folder results are suppressed under it. A folder result
  //    is a way to REACH another folder — the one thing a folder lock forbids, and the very
  //    reason the home's search is hidden while one is on.
  assert.match(build, /containState\.mode === 'folder'/, 'the folder search ignores a folder lock');
  assert.match(build, /locked \}\)/, 'the lock never reaches the scope decision');
  assert.match(build, /if \(!locked\) \{[\s\S]*?folderEntries\.push/,
    'folder results are offered under a lock — that is a way out of the locked folder');

  // 3) IT IS BOUNDED. A folder search must never become "load the family's whole library".
  assert.match(build, /FOLDER_SEARCH_MAX_TOTAL/, 'the folder search lost its ceiling');
  assert.match(build, /FOLDER_SEARCH_MAX_PER_FOLDER/, 'one huge folder can exhaust the search');

  // 4) THE TWO SEARCHES CANNOT BLUR. The home's search must reset the scope, and a rebuild
  //    must use the index the screen was opened for — a folder search that silently fell
  //    back to the whole library would leak other folders into a locked one.
  assert.match(fnSlice(app, 'async function openSearch('), /searchFolderId = null/,
    "the home's search can inherit a folder scope");
  assert.match(fnSlice(app, 'async function openFolderSearch('), /searchFolderId = folderId/,
    'the folder search never records its scope');
  assert.match(fnSlice(app, 'async function renderSearchResults('),
    /searchFolderId \? buildFolderSearchIndex\(searchFolderId\) : buildSearchIndex\(\)/,
    'a rebuilt index ignores which search the screen is showing');

  // 5) One screen, one ranking: the folder search must not grow its own matcher.
  assert.equal((app.match(/rankItems\(/g) || []).length, 2,
    'a second ranking implementation appeared — search.rankItems is the only one');
});

test('v1.0.58 REVIEW: three defects that reached main, each now pinned', () => {
  const app = CODE.get('www/js/app.js');

  // 1) A FOLDER HOLDING ONLY PARKED VIDEOS IS NOT EMPTY. `countFolder` ranges
  //    by_folder_sort, and a video waiting for approval carries folderId '~pending' with
  //    the real folder in `homeFolderId` — so it counted as ZERO and the sweep deleted the
  //    folder. The moment the parent approved it, the video was filed under a folder that
  //    no longer existed: invisible on every screen, forever (the exact failure
  //    deleteCustomFolderFlow's own comment exists to prevent).
  const sweep = fnSlice(app, 'async function sweepEmptyFolders(');
  assert.match(sweep, /pagePending\(/, 'the empty-folder sweep ignores videos awaiting approval');
  assert.match(sweep, /pageRejected\(/, 'the empty-folder sweep ignores the rejected archive');
  // ⚠️ AND IT MUST READ `.items`. Both readers answer `{ items, total }`; spreading the
  // OBJECT throws "not iterable" AFTER the promise's .catch, so the throw escaped to the
  // caller's `.catch(() => {})` and the whole sweep silently did nothing. Measured in the
  // browser with the suite green — no node test executes app.js.
  assert.match(sweep, /pending\.items \|\| \[\]/, 'the pending reader is spread as if it were an array');
  assert.match(sweep, /rejected\.items \|\| \[\]/, 'the rejected reader is spread as if it were an array');
  assert.match(sweep, /homeFolderId/, 'a parked video no longer counts toward its real folder');

  // 2) THE CACHE SWEEP OWNS A FILE BY THE PATH THAT WAS WRITTEN, never by re-deriving the
  //    name. `cacheExtFor` reads `media`, and v1.0.56 CORRECTS media at loadedmetadata, so
  //    a re-derived name flips .mp4 → .mp3 after the first play — the live file then匹配
  //    no record and the sweep deletes it as an orphan.
  const cache = fnSlice(app, 'async function sweepDownloadCache(');
  assert.match(cache, /localCacheName\(rec\)/, 'the cache sweep re-derives the file name instead of reading localPath');
  assert.doesNotMatch(cache, /cacheBaseName\(rec\)/, 'the drifting name is back');
  assert.match(app, /const localCacheName = \(rec\) =>[^\n]*localPath/,
    'the owned-name helper no longer reads the path that was written');

  // 3) ONLY AN EXPLICIT EMOJI TAP MAY DROP A FOLDER'S PICTURE. `fpArtChoice` starts null
  //    every time the editor opens, so the old `else` branch fired for a parent who opened
  //    🖼️, looked, and tapped שמירה — silently erasing the picture. The comment claimed an
  //    emoji had been chosen and nothing checked it.
  assert.match(fnSlice(app, 'async function saveFolderArtEdit('), /\} else if \(fpEmojiPicked\) \{/,
    'saving the art editor with nothing chosen wipes the folder picture again');
  assert.match(app, /fpEmojiPicked = true/, 'the explicit-emoji flag is never set');
  assert.match(fnSlice(app, 'async function openFolderArtEditor('), /fpEmojiPicked = false/,
    'the flag survives from one folder to the next — the second edit would wipe a picture');
});

/* ---------------- nested Drive folders (v1.0.61) ---------------- */

test('nesting is rendered, never paged: pageAnyFolder and nextAfter stay flat', () => {
  // The whole design rests on this. `pageAnyFolder` is THE pagination entry point and
  // `nextAfter` is its chain twin; an existing invariant pins that they cover the same
  // folder kinds. Nesting concatenates CHILD TILES onto a page in renderGridPage instead,
  // so neither grows a branch and the two can never disagree about what a folder holds.
  const app = MODULES.get('www/js/app.js');
  for (const fn of ['async function pageAnyFolder(', 'async function nextAfter(']) {
    const body = fnSlice(app, fn);
    assert.ok(body, `${fn} is gone — re-anchor this guard`);
    assert.doesNotMatch(body, /parentFolderId/,
      `${fn} grew a nesting branch — child folders belong to the RENDERER, not the pager`);
    assert.doesNotMatch(body, /folderTile|folderPageSlots/,
      `${fn} is building tiles — it returns records, and the grid decides what to draw`);
  }
  // and the renderer really does the concatenation
  const grid = fnSlice(app, 'async function renderGridPage(');
  assert.match(grid, /folderPageSlots\(/, 'renderGridPage no longer merges child folders');
  assert.match(grid, /folderPageTotal\(/, 'the pager is sized without counting the child folders');
  assert.match(grid, /folderTile\(/, 'the child folders are computed but never drawn');
  // ⚠️ WHERE the children come from, not just that the helpers are called. The first version
  // of this guard checked only the three calls above, and stayed green with the lookup
  // replaced by an empty array — the feature rendering nothing, which is precisely the
  // "a feature that does nothing" shape this suite exists to catch (v1.0.59).
  assert.match(grid, /folders\.filter\(\(f\) => f\.parentFolderId === fid\)/,
    'the child folders are not looked up from `folders` — the merge would silently render none');
  assert.match(grid, /which === 'home' \? \[\]/,
    'the HOME must pass no children: its own tiles are already the roots, and nesting them twice would duplicate them');
});

test('the folder view is driven by its STACK ENTRY, not by the module global (v1.0.61)', () => {
  // `folder` now sits on the stack more than once (collection → disc). A back-pop re-enters
  // the view WITHOUT going through openFolder, so an onEnter that trusted the global would
  // paint the disc the child just left under the collection's header — and the header,
  // painted only in openFolder, did exactly that until it moved into the render.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf("nav.register('folder'");
  assert.ok(at > 0, "nav.register('folder') is gone");
  const body = app.slice(at, app.indexOf("nav.register('search'", at));
  assert.match(body, /entry(\s*&&\s*entry)?\.params/, 'the folder onEnter ignores its entry params again');
  assert.match(body, /folderId = p\.folderId/, 'the entry no longer sets the folder it names');
  const view = fnSlice(app, 'async function renderFolderView(');
  assert.match(view, /paintFolderHeader\(/,
    'the header is painted only on open again — a back-pop would show the wrong folder name');
  // and openFolder must PUSH, never replace: back is how the child walks out of a disc
  const open = fnSlice(app, 'async function openFolder(');
  assert.match(open, /nav\.go\('folder'/, 'openFolder replaces instead of pushing — back would skip the parent');
  assert.doesNotMatch(open, /nav\.replace\('folder'/, 'a replaced entry destroys the way back to the collection');
});

test('a folder lock covers a SUBTREE, and the home filter is the only home change (v1.0.61)', () => {
  // Five places compared containState.folderId for equality. Equality locks a child into a
  // collection's front door and then refuses every disc inside it — the lock reads as broken.
  const app = MODULES.get('www/js/app.js');
  const open = fnSlice(app, 'async function openFolder(');
  assert.match(open, /folderWithinLock\(/,
    'openFolder tests the lock by equality again — the discs inside a locked collection cannot open');
  assert.match(open, /fid = containState\.folderId/,
    'a folder outside the lock is no longer redirected — the OPEN is the boundary, not the chrome');
  // the home shows roots, and `folders` still holds every row (three consumers look it up)
  const home = fnSlice(app, 'async function renderHome(');
  assert.match(home, /homeFolderRows\(folders\)/, 'the home shows every folder again — 32 discs on the home screen');
  assert.match(home, /shouldFlattenHome\(homeList\)/, 'the flatten test still counts nested folders');
  assert.doesNotMatch(home, /folders = homeFolderRows/,
    'the global was narrowed to roots — openFolder and both search indexes look folders up by id');
});

test('deleting a collection cascades, with a tombstone per folder (v1.0.61)', () => {
  // Without the cascade the discs survive with a parent that no longer exists, and
  // homeFolderRows puts all 32 of them back on the home — the exact shape this removes.
  // A tombstone per row is not optional: absence alone is re-added by any peer that has
  // not pulled (the v1.0.36 rule).
  const app = MODULES.get('www/js/app.js');
  const body = fnSlice(app, 'async function deleteCustomFolderFlow(');
  assert.match(body, /folderSubtreeIds\(/, 'the delete no longer walks the subtree — the discs would be orphaned');
  assert.match(body, /for \(const id of descendants\) await db\.deleteCustomFolder\(/,
    'the child rows are not deleted with their tombstones');
  assert.match(body, /children: descendants\.length/, 'the confirm no longer names the folders it takes');
  assert.match(body, /for \(const id of subtree\) await db\.moveFolderVideos\(/,
    'the move branch only re-homes the top folder — the discs\' songs would be orphaned');
  assert.match(body, /inSubtree\.has\(/, 'the purge branch only reaches the top folder\'s own videos');
});

test('the tree survives a snapshot round trip, and its ids are validated (v1.0.61)', () => {
  // The whitelist was already dropping driveFolderId/driveRootId before nesting made it
  // visible: a restored folder never refreshed again. parentFolderId is an untrusted string
  // from a file and the ancestry walk follows it, so it is validated as a folder id.
  const snap = MODULES.get('www/js/snapshot.js');
  const at = snap.indexOf('for (const row of Array.isArray(snap.customFolders)');
  assert.ok(at > 0, 'the snapshot folder import moved — re-anchor this guard');
  const body = snap.slice(at, snap.indexOf('const remoteTombs', at));
  for (const f of ['driveFolderId', 'driveRootId', 'parentFolderId']) {
    assert.ok(body.includes(f), `${f} is dropped by the snapshot import — a restore flattens the tree`);
  }
  assert.match(body, /isCustomFolderId\(row\.parentFolderId\)/,
    'parentFolderId is taken from the file unvalidated — the ancestry walk follows it');
  assert.match(body, /row\.parentFolderId !== row\.folderId/,
    'a row may name ITSELF as its parent — the folder would vanish from the home forever');
});

test('the "how to sync this channel" button always ASKS, and saves both fields (v1.0.61)', () => {
  const app = CODE.get('www/js/app.js');
  const fn = fnSlice(app, 'async function decideNewChannel(');

  // 1) IT NO LONGER DELEGATES TO THE BACKLOG DIALOG. `offerChannelApproval` returns before
  //    opening anything when the queue is empty (six states reach that), and this function
  //    used to read `count === 0` as "the tap was the review" — stamping decidedAt, hiding
  //    the row, and leaving the channel on manual forever. That was the field report.
  assert.doesNotMatch(fn, /offerChannelApproval\(/,
    'the fresh-channel button asks about the BACKLOG again — an empty queue opens no dialog');
  assert.doesNotMatch(fn, /res\.count === 0/, 'the silent decide-without-asking branch is back');
  assert.match(fn, /channelSyncModeDialog\(/, 'the button no longer asks the subscription mode');
  assert.match(fn, /askKid\(/, 'the button decides without a dialog');

  // 2) THE ANSWER WRITES BOTH FIELDS. `autoApprove` IS the ✅ in the channel list and the
  //    actual sync mode; `decidedAt` is only what clears the row out of "ערוצים חדשים".
  //    Writing the second without the first is precisely how the row vanished while
  //    nothing was decided.
  assert.match(fn, /autoApprove: auto/, 'the chosen mode is never saved');
  assert.match(fn, /decidedAt: row\.decidedAt \|\| Date\.now\(\)/, 'the row will not leave "ערוצים חדשים"');
  assert.match(fn, /autoApproveSource: 'ui'/, 'the decision loses its provenance');

  // 3) A NULL LIBRARY SCOPE MUST NOT DECIDE ANYTHING. It is one of the six ways the old
  //    flow reached an empty queue, and an invariant already exists about it elsewhere.
  assert.match(fn, /if \(!scope\)/, 'a null library scope silently decides again');
  const scopeAt = fn.indexOf('if (!scope)');
  assert.ok(scopeAt >= 0 && scopeAt < fn.indexOf('askKid('), 'the scope check must precede the dialog');

  // 4) CANCEL AND DISMISS WRITE NOTHING. `askKid` also answers 'dismiss' when another modal
  //    is already open (modal.js refuses to stack), and that must leave the row where the
  //    parent can find it — never a half-decision.
  assert.match(fn, /if \(answer !== 'ok' && answer !== 'third'\) return;/,
    'an accidental dismiss can now write a decision');
  const guardAt = fn.indexOf("answer !== 'ok'");
  assert.ok(guardAt >= 0 && guardAt < fn.indexOf('putLibraryChannel('),
    'the write happens before the answer is validated');

  // 5) The words live in plan.js, like every other dialog in this app.
  assert.match(CODE.get('www/js/plan.js'), /export function channelSyncModeDialog\(/, 'the dialog text left plan.js');
  assert.match(fn, /channelSyncModeOutcome\(/, 'the outcome toast is hand-rolled');
});

test('the live swipe track cleans up after itself, always (v1.0.62)', () => {
  // Every one of these is a way to leave the child's grid TRANSLATED with a ghost of a page
  // beside it — a screen that looks broken and cannot be recovered without a navigation.
  const swipe = CODE.get('www/js/ui/swipe.js');
  assert.ok(swipe, 'ui/swipe.js is gone');

  // 1) the OS steals drags (the gesture inset, a scroll it decides to own) and no pointerup
  //    ever arrives — the v1.0.22 seek-bar invariant, which here must SPRING BACK, not just
  //    drop the start.
  const cancel = swipe.slice(swipe.indexOf("addEventListener('pointercancel'"));
  assert.match(cancel.slice(0, 200), /settle\(0\)/,
    'a stolen gesture leaves the grid translated forever');

  // 2) a grid rebuilt UNDER the finger (a sync landing, a Drive pull applying) must drop the
  //    drag: it would otherwise keep moving a page that no longer exists.
  assert.match(swipe, /kp:gridrender/, 'a mid-gesture re-render no longer resets the drag');
  const app = CODE.get('www/js/app.js');
  assert.match(app, /function announceGridRender\(/, 'nothing announces a re-render any more');
  assert.match(app, /grid\.dispatchEvent\(new CustomEvent\('kp:gridrender'/,
    'the event is dispatched somewhere other than the grid — on the watch screen the swipe host IS the grid, and events bubble UP');

  // 3) A FAST FLIP MUST NOT LOSE A PAGE. A child swiping again inside the 220ms settle
  //    starts a gesture that cancels it; without the flush, the page turn that settle was
  //    carrying is silently dropped, and the faster they swipe the more pages vanish.
  const clear = swipe.slice(swipe.indexOf('const clearDrag = () =>'));
  const body = clear.slice(0, clear.indexOf('\n  };'));
  assert.match(body, /const run = pending/, 'clearDrag no longer flushes a committed turn — a fast flip loses pages');
  assert.match(body, /\.then\(run\)/, 'the committed turn is captured but never run');
  assert.match(body, /ghost[\s\S]*remove\(\)/, 'the ghost is not removed — a stale page stays on screen');
  assert.match(body, /transform = ''/, 'the transform is not cleared — the grid stays translated');

  // 3b) ⚠️ AND THE TURN MUST RUN BEFORE THE VISUAL RESET (v1.0.75). The old order removed
  //     the ghost and zeroed the transform FIRST, so for the frames until the async render
  //     landed the grid sat at rest still holding the PREVIOUS page — the flicker reported
  //     from a device. The reset is a function called after the render resolves, and every
  //     onSwipe must RETURN its render or there is nothing to wait for.
  assert.match(body, /const reset = \(\) =>/, 'the reset is no longer deferrable');
  assert.ok(body.indexOf('.then(run)') < body.indexOf('.then(reset)'),
    'the transform is cleared before the new page is rendered — the old page flashes at rest');
  // plain substrings: a hand-escaped regex built from a string is one backslash away from
  // "Unterminated group", which is a guard that throws rather than one that checks
  for (const r of ['return renderHome()', 'return renderFolderView()', 'return renderWatchGrid(']) {
    assert.ok(app.includes(r),
      `an onSwipe fires its render instead of returning it (${r}) — the swap cannot wait for the new page`);
  }

  // 4) the live path is an ADDITION, never a replacement: renderPage is async, the viewport
  //    can be absent, and a ghost may never render — all of those must still turn the page.
  assert.match(swipe, /const canLive = !!\(vp && grid && renderPage\)/,
    'the live track is no longer optional — a missing viewport would break paging entirely');
  assert.match(swipe, /swipePageAction\(\{/, 'the fallback flick is gone');
});

test('the swipe viewport never becomes a scroll container (v1.0.62)', () => {
  // ⚠️ Permanent `overflow-x: hidden` turns the OTHER axis into `auto` per spec, making the
  // element a scroll container and taking vertical scrolling away from the document — the
  // exact class of bug v1.0.50/51/52 chased around this app three times. It is therefore
  // applied ONLY while a gesture is running, when there is nothing to scroll inside it.
  const css = readFileSync(join(ROOT, 'www', 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.swipe-vp\s*\{[^}]*position:\s*relative/, 'the viewport lost its positioning context');
  assert.match(css, /\.swipe-vp\.swiping\s*\{[^}]*overflow:\s*hidden/,
    'the clip is not tied to the gesture');
  assert.ok(!/\.swipe-vp\s*\{[^}]*overflow/.test(css),
    'the viewport clips permanently — that makes it a scroll container and the page stops scrolling');
  // the movement must be a COMPOSITOR property: a cheap tablet moves 15 tiles with images
  assert.ok(!/\.swipe-vp[^{]*\{[^}]*transition:[^;]*(left|margin)/.test(css),
    'the track animates a layout property — it must be transform only');

  // all three grids are wrapped, and each is wired with its viewport
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  for (const id of ['grid', 'folder-grid', 'watch-grid']) {
    assert.ok(html.includes(`id="${id}-vp"`), `#${id} has no swipe viewport`);
  }
  const app = CODE.get('www/js/app.js');
  for (const id of ['grid-vp', 'folder-grid-vp', 'watch-grid-vp']) {
    assert.ok(app.includes(`viewport: $('${id}')`), `${id} is not wired to a swipe pager`);
  }
  // the ghost is a PREVIEW: it must never move the pager, or the page would look turned
  // before the child committed
  assert.match(app, /renderGridPage\(grid, scope, fid, which, pageOverride = null, silent = false\)/,
    'renderGridPage lost its ghost parameters');
  assert.match(app, /if \(silent\) return;[\s\S]{0,200}?announceGridRender/,
    'a ghost render updates the pager — the page would look turned before it was');
});

/* ---------------- background playback (v1.0.63) ---------------- */

test('background playback is opt-in, foreground-armed, and torn down everywhere (v1.0.63)', () => {
  const app = CODE.get('www/js/app.js');

  // 1) THE DECISION IS MADE FROM CACHED STATE. onAppPause reads the live playhead and must
  //    stay a synchronous arrow — by the time an awaited setting read returned, the video
  //    would already be paused.
  const body = appPauseBody(app);
  assert.ok(body, 'the onAppPause listener is gone');
  assert.match(body, /backgroundPlayDecision\(/, 'the pause no longer consults the background decision');
  assert.doesNotMatch(body, /await |getSetting\(/,
    'the screen-off handler awaits — it must decide from cached state or the video pauses first');
  assert.match(body, /if \(!bg\.play\) pauseCurrent\(\)/, 'the pause is no longer conditional on the decision');
  // ⚠️ the call watcher stays armed EVEN WHEN THE VIDEO KEEPS PLAYING: a call takes audio
  // focus and the WebView pauses its own media regardless of our service, so an early
  // return here would leave a background-playing video stopped for good.
  assert.match(body, /checkCallResume\(\)/, 'a call during background playback would never resume');
  assert.doesNotMatch(body, /if \(bg\.play\) return/, 'the early return skips the call-resume arming');

  // 2) ARMED WHILE FOREGROUND. API 31+ forbids starting a foreground service from the
  //    background, so arming when the screen goes off would be too late on every modern
  //    device — the feature would look implemented and never work.
  const open = fnSlice(app, 'async function openWatch(');
  assert.match(open, /armBackgroundPlayback\(/, 'the service is not armed when a video opens');
  assert.doesNotMatch(body, /armBackgroundPlayback\(/,
    'the service is armed from onAppPause — API 31+ refuses that, silently');

  // 3) TORN DOWN EVERYWHERE a video stops being the child's current one. A notification left
  //    on the lock screen for a dead video is a button that does nothing — and on a kiosk
  //    tablet, a surface the child can reach for no reason.
  for (const [what, fn] of [
    ['the watch view is left', "nav.register('watch'"],
    ['a profile switch', 'async function activateProfile('],
    ['a scheduled break', 'async function showLockedScreen(']
  ]) {
    const at = app.indexOf(fn);
    assert.ok(at > 0, `${fn} moved — re-anchor this guard`);
    assert.match(app.slice(at, at + 2600), /disarmBackgroundPlayback\(/,
      `background playback survives ${what}`);
  }
  // the break must also SILENCE it, not merely drop the notification
  const lock = app.slice(app.indexOf('async function showLockedScreen('), app.indexOf('async function showLockedScreen(') + 2600);
  assert.match(lock, /pauseCurrent\(\)/, 'a break leaves the music playing — that is not a break');
  assert.ok(lock.indexOf('disarmBackgroundPlayback') > lock.indexOf("nav.isActive('parent')"),
    'the teardown runs before the parent-screen guard — a parent mid-configuration is not a break');

  // 4) the idle "עדיין צופים?" prompt is suspended while playing hidden (the user's
  //    decision): it exists for a child asleep in FRONT of a screen, and there is no screen
  //    to show a prompt on.
  const idle = fnSlice(app, 'async function tickIdleSleep(');
  assert.match(idle, /bgPlayLive && document\.hidden/, 'the idle timer stops a deliberate background listen');
});

test('the background service is declared, gated, and reachable only from the app (v1.0.63)', () => {
  const manifest = readRepo('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  const ref = readRepo('native-reference/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  for (const [name, m] of [['android/', manifest], ['native-reference/', ref]]) {
    assert.match(m, /android:name="\.PlaybackService"/, `${name}: the service is not declared`);
    assert.match(m, /android:foregroundServiceType="mediaPlayback"/,
      `${name}: API 34+ refuses a media foreground service without its type`);
    assert.match(m, /\.PlaybackService"[\s\S]{0,200}?android:exported="false"/,
      `${name}: the service is exported — any app on the device could start it`);
    assert.match(m, /FOREGROUND_SERVICE_MEDIA_PLAYBACK/, `${name}: the API 34 permission is missing`);
    assert.match(m, /POST_NOTIFICATIONS/, `${name}: the notification permission is missing`);
  }
  // ⚠️ THE NOTIFICATION MUST NOT BE A WAY BACK INTO THE APP. Under a containment lock that
  // would be a way out of a locked folder, and on a kiosk tablet a way back into a session
  // the parent ended. Three transport buttons, no content intent.
  const svcA = readRepo('android/app/src/main/java/com/assaf/kidsplayer/PlaybackService.java');
  const svcB = readRepo('native-reference/PlaybackService.java');
  assert.equal(svcA, svcB, 'the two PlaybackService copies have drifted');
  const svc = svcA.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(svc, /setContentIntent|getActivity\(/,
    'the notification can open the app — that is a hole in the containment lock');
  // v1.0.68 — ⏪10 / ⏯ / ⏩10 (user request, replacing skip-track): the library is mostly
  // long recordings, where moving INSIDE the track is what a parent actually needs.
  for (const a of ['ACTION_BACK', 'ACTION_TOGGLE', 'ACTION_FWD']) {
    assert.ok(svc.includes(a), `the notification lost its ${a} button`);
  }
  // the CAR reads the PlaybackState, never the notification's action list — both surfaces
  // must offer the seek, and a head unit's own ⏮/⏭ must land on something rather than sit dead
  for (const a of ['ACTION_REWIND', 'ACTION_FAST_FORWARD']) {
    assert.ok(svc.includes(a), `the session does not advertise ${a} — the car button is dead`);
  }
  assert.match(svc, /onSkipToNext\(\)\s*\{[^}]*"fwd"/,
    'a car skip button does nothing — map it to the same ten seconds rather than leaving it dead');
  // v1.0.69 — the seek buttons wear a RING WITH "10" IN IT, not the system's rewind/forward
  // triangles (user request, from a screenshot of Spotify's ⟲15 beside our plain triangle).
  for (const [name, res] of [['back', 'ic_seek_back_10'], ['forward', 'ic_seek_fwd_10']]) {
    assert.match(svc, new RegExp('R\\.drawable\\.' + res),
      `the ${name} button is not using the app's own ten-second icon`);
    // ⚠️ COMMENT-STRIPPED. The file's own comment explains that a VectorDrawable has no
    // <text> element — and a raw grep fires on that explanation. The v1.0.45 trap, and the
    // third time in one session; read what the file DRAWS, not what it says.
    const icon = readRepo('android/app/src/main/res/drawable/' + res + '.xml')
      .replace(/<!--[\s\S]*?-->/g, '');
    assert.match(icon, /<vector/, `${res} is not a vector`);
    // ⚠️ A NOTIFICATION ACTION ICON IS DRAWN FROM ITS ALPHA AND TINTED, so any colour is
    // thrown away — the ic_notification lesson (v1.0.66), one icon over.
    assert.doesNotMatch(icon, /android:(fill|stroke)Color="(?!#FFFFFFFF)/,
      `${res} uses a colour the system will discard`);
    // the "10" must be SHAPES: a VectorDrawable has no <text> element, so a digit written
    // as text would silently render nothing at all
    assert.doesNotMatch(icon, /<text/, `${res} tries to render text — a VectorDrawable cannot`);
    assert.ok((icon.match(/<path/g) || []).length >= 4,
      `${res} lost a path — the ring, the arrowhead and both digits are four separate shapes`);
  }
  assert.doesNotMatch(svc, /ic_media_rew|ic_media_ff/, 'the plain system triangles came back');
  assert.match(svc, /IMPORTANCE_LOW/, 'the channel makes noise — a song change would wake a sleeping child');
  assert.match(svc, /START_NOT_STICKY/,
    'a sticky service would be restarted by the system for a video that is no longer playing');
  // the plugin half, in both copies
  for (const f of ['android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java',
                   'native-reference/KidsNativePlugin.java']) {
    const src = readRepo(f);
    assert.match(src, /public void startBackgroundPlayback\(PluginCall call\)/, `${f}: start is missing`);
    assert.match(src, /public void stopBackgroundPlayback\(PluginCall call\)/, `${f}: stop is missing`);
    assert.match(src, /emitPlaybackCommand/, `${f}: the notification buttons reach no one`);
  }
});

test('a declared runtime permission is actually REQUESTED (v1.0.64)', () => {
  // ⚠️ THIS SHIPPED BROKEN IN v1.0.63. POST_NOTIFICATIONS was declared in the manifest and
  // never requested — and on Android 13+ it is a RUNTIME permission, denied by default. So
  // the foreground service started, the audio kept playing, and the control was suppressed
  // on every modern device. A manifest entry only makes a permission REQUESTABLE.
  const manifest = readRepo('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  const RUNTIME = ['POST_NOTIFICATIONS'];  // the runtime-gated permissions this app declares
  for (const perm of RUNTIME) {
    if (!manifest.includes(perm)) continue;
    for (const f of ['android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java',
                     'native-reference/KidsNativePlugin.java']) {
      const src = readRepo(f).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(src.includes(perm),
        `${f}: ${perm} is declared in the manifest but the plugin never declares it — it can never be requested`);
      assert.match(src, /requestPermissionForAlias\(/,
        `${f}: nothing requests ${perm} at runtime — it stays denied and the feature degrades silently`);
      assert.match(src, /@PermissionCallback/, `${f}: the request has no callback, so the answer is never reported`);
    }
  }
  // …and JS must ASK at the moment the parent turns the feature on — a prompt at launch has
  // no context on a child's tablet, and one when the screen goes off has nobody to see it.
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf("$('bgplay-toggle').addEventListener");
  assert.ok(at > 0, 'the background-playback toggle is gone');
  const body = app.slice(at, at + 1400);
  assert.match(body, /ensureNotificationPermission\(/,
    'enabling background playback no longer asks for the notification permission');
  assert.match(body, /e\.target\.checked\) notif = await ensureNotificationPermission/,
    'the permission is requested when the setting is turned OFF too — a prompt for nothing');
  // a denied answer must be SAID, not swallowed
  assert.match(body, /form-msg warn/, 'a denied permission is reported as success');
  const css = readFileSync(join(ROOT, 'www', 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.form-msg\.warn\s*\{[^}]*color/,
    'the warn message has no colour — it would read as "nothing happened"');
});

test('the playback service publishes a real MediaSession (v1.0.65)', () => {
  // A plain Notification cannot reach a car: media buttons from a steering wheel or head
  // unit are routed to whichever MediaSession is ACTIVE and nowhere else, and the
  // lock-screen media widget is drawn from a session too. v1.0.63 shipped without one.
  const a = readRepo('android/app/src/main/java/com/assaf/kidsplayer/PlaybackService.java');
  const b = readRepo('native-reference/PlaybackService.java');
  assert.equal(a, b, 'the two PlaybackService copies have drifted');
  const src = a.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(src, /new MediaSession\(/, 'the service publishes no MediaSession — a car cannot control it');
  assert.match(src, /setActive\(true\)/, 'the session is never activated — media buttons reach only an ACTIVE session');
  assert.match(src, /setMediaSession\(/,
    'the notification is not backed by the session — no lock-screen media widget');
  // The ACTIONS a car and the lock screen render come from the PlaybackState, NOT from the
  // notification's own action list — two surfaces that must both be fed.
  //
  // ⚠️ v1.0.70 REMOVED SKIP_TO_NEXT/PREVIOUS FROM THE ADVERTISED SET, DELIBERATELY, and that
  // removal IS a fix: a STANDARD action can only ever wear a STANDARD icon, so advertising
  // them made the lock screen draw the system's ⏮/⏭ triangles no matter what the
  // notification's own ring-with-10 icons said. Reported from a device. CUSTOM actions are
  // the one mechanism that carries our drawable onto those surfaces.
  assert.ok(src.includes('ACTION_PLAY_PAUSE'), 'the session does not advertise play/pause');
  assert.doesNotMatch(src, /setActions\([\s\S]{0,400}?ACTION_SKIP_TO/,
    'a standard skip action is advertised again — the lock screen will draw ITS triangles over our icons');
  for (const cust of ['addCustomAction', 'ic_seek_back_10', 'ic_seek_fwd_10']) {
    assert.ok(src.includes(cust),
      `the seek buttons are not published as custom actions — the lock screen and the car cannot show our icon`);
  }
  assert.match(src, /onCustomAction\(String action/,
    'the custom actions are published but nothing handles them — the buttons would be dead');
  // every session callback must reach the SAME command path the notification buttons use
  // a steering wheel's PHYSICAL ⏮/⏭ keys arrive whether or not the action is advertised
  // (advertising decides what is DRAWN), so they must still land on something
  for (const cb of ['onPlay', 'onPause', 'onSkipToNext', 'onSkipToPrevious', 'onRewind', 'onFastForward']) {
    assert.match(src, new RegExp(cb + '\\(\\)\\s*\\{[^}]*emitPlaybackCommand'),
      `${cb} does not forward to JS — that hardware button would do nothing`);
  }
  // ⚠️ released with the service. A session that outlives it keeps taking the car's media
  // buttons for a video that is not playing.
  assert.match(src, /public void onDestroy\(\)/, 'the service never releases its session');
  assert.match(src, /releaseSession\(\)[\s\S]{0,80}?super\.onDestroy\(\)/,
    'onDestroy does not release the session before tearing down');
  // NO new dependency: the framework session is API 21+ and minSdk is 22
  const gradle = readRepo('android/app/build.gradle');
  assert.doesNotMatch(gradle, /androidx\.media[:3]|exoplayer/,
    'a media library was added — the framework MediaSession already covers this');
});

test('EVERY seek surface goes through the clamp (v1.0.68)', () => {
  // ⚠️ THE CLAMP IS THE INVARIANT, NOT THE PURE HELPER'S EXISTENCE. Testing tvKeyIntent
  // proves the DECISION clamps; it says nothing about whether a caller uses it. Planting a
  // hand-rolled `c.getTime() + 10` inside seekRelative left the suite fully green — so this
  // guard pins the WIRING, which is where the v1.0.22 bug actually lived: an unclamped
  // forward seek runs past the end, the engine fires ENDED → finish() → onExit, and the
  // child is EJECTED from the video they were watching.
  const player = CODE.get('www/js/player.js');
  const fn = fnSlice(player, 'export function seekRelative(');
  assert.ok(fn, 'seekRelative is gone — the notification can no longer seek');
  assert.match(fn, /tvKeyIntent\(/,
    'seekRelative computes its own target — every seek in this app goes through the clamp');
  assert.doesNotMatch(fn, /getTime\(\)\s*[+-]/,
    'seekRelative does arithmetic on the playhead itself — that is the unclamped seek that ejects the child');
  assert.match(fn, /intent\.kind !== 'seek'/, 'a non-seek intent still reaches seekTo');
  // and the notification handler must not seek some other way
  const app = CODE.get('www/js/app.js');
  const cmd = fnSlice(app, 'async function handlePlaybackCommand(');
  assert.match(cmd, /seekRelative\(action\)/, 'the notification seeks without the shared helper');
  assert.doesNotMatch(cmd, /seekTo\(/, 'the handler reaches past seekRelative straight into the player');
});

test('the playback notification carries the app mark and real artwork (v1.0.66)', () => {
  const a = readRepo('android/app/src/main/java/com/assaf/kidsplayer/PlaybackService.java');
  const b = readRepo('native-reference/PlaybackService.java');
  assert.equal(a, b, 'the two PlaybackService copies have drifted');
  const src = a.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // ⚠️ THE SMALL ICON MUST BE OUR OWN SILHOUETTE, never the launcher icon: Android draws a
  // small icon from its ALPHA channel only and tints it, so a coloured mipmap arrives as a
  // featureless white blob. And never the generic system glyph again — the report was of a
  // row sitting anonymously under Spotify's.
  assert.match(src, /setSmallIcon\(R\.drawable\.ic_notification\)/, 'the notification lost its own mark');
  assert.doesNotMatch(src, /setSmallIcon\(android\.R\.drawable|setSmallIcon\(R\.mipmap/,
    'the small icon is the system glyph or the launcher icon — one is anonymous, the other a white blob');
  const icon = readRepo('android/app/src/main/res/drawable/ic_notification.xml');
  assert.match(icon, /<vector/, 'the notification icon is not a vector');
  assert.doesNotMatch(icon, /android:fillColor="(?!#FFFFFFFF)/,
    'the icon uses a colour — a small icon is a silhouette and the colour is thrown away');

  // the big picture: two surfaces again — the notification's large icon AND the session's
  // album art, which is what a car display and the lock-screen widget read.
  assert.match(src, /setLargeIcon\(artwork\)/, 'the notification shows no artwork');
  assert.match(src, /METADATA_KEY_ALBUM_ART/, 'the car and lock screen get no artwork');
  assert.match(src, /decodeArtwork\(/, 'nothing decodes the artwork bytes');
  // TOTAL: a picture is a nicety and must never take the service down
  const dec = src.slice(src.indexOf('private Bitmap decodeArtwork'));
  assert.match(dec.slice(0, 900), /catch \(Throwable/, 'a bad image can crash the playback service');

  // JS: the fallback chain, and the reason it exists
  const app = CODE.get('www/js/app.js');
  const fn = fnSlice(app, 'async function backgroundArtwork(');
  assert.ok(fn, 'backgroundArtwork is gone');
  assert.match(fn, /item\.thumbId/, 'the song\'s own picture is no longer preferred');
  assert.match(fn, /artThumbId/,
    'the folder picture fallback is gone — an audio file NEVER has a thumbnail of its own, so this is the only picture most tracks can show');
  assert.match(fn, /BG_ART_MAX_BYTES/, 'an unbounded image crosses the bridge as base64 on every track change');
  // A publish must not blank the picture: the service rebuilds the WHOLE notification, so
  // artwork omitted from any one publish makes it disappear. v1.0.74 funnelled every
  // publish through one helper, which is a stronger form of the same guarantee — the guard
  // follows it there, and pins that there is exactly ONE place that publishes.
  const pub = fnSlice(app, 'async function republishBackgroundState(');
  assert.ok(pub, 'the shared republish helper is gone');
  assert.match(pub, /artB64: await backgroundArtwork\(/,
    'a republish omits the artwork — the picture would vanish on the first play/pause');
  assert.equal((app.match(/startBackgroundPlayback\(/g) || []).length, 2,
    'the session is published from more than one place — they will drift apart');
});

test('the website locks close every door, and strand nobody (v1.0.67)', () => {
  const app = CODE.get('www/js/app.js');

  // 1) HIDING IS THE AFFORDANCE, THE HANDLER IS THE BOUNDARY. A TV remote reaches a hidden
  //    control and a stale render can show one, so the sites screen's 🏠 must REFUSE, not
  //    merely disappear — the same split openFolder makes for the folder lock.
  const back = app.slice(app.indexOf("$('sites-back').addEventListener"));
  assert.match(back.slice(0, 500), /containState\.mode === 'sites'[\s\S]{0,60}?return;/,
    'the sites screen 🏠 only hides under a websites lock — a remote could still press it');
  // hardware back, the other half
  const reg = app.slice(app.indexOf("nav.register('sites'"), app.indexOf("nav.register('sites'") + 700);
  assert.match(reg, /onBack: \(\) => containState\.active/,
    'hardware back walks out of the websites lock');
  // and "go home" itself, the funnel every other caller uses
  const gg = fnSlice(app, 'function goGallery(');
  assert.match(gg, /mode === 'sites' \|\| containState\.mode === 'site'/,
    'goGallery still returns a locked child to the videos');

  // 2) IT SURVIVES A RESTART — force-closing the app is the first thing a child tries.
  //    A 'site' lock REOPENS the site (the user's decision); landing on the list would let
  //    the child simply not tap it and sit outside the lock.
  const act = fnSlice(app, 'async function activateProfile(');
  assert.match(act, /mode === 'sites' \|\| containState\.mode === 'site'/,
    'a website lock no longer survives a relaunch');
  assert.match(act, /openLockedSite\(containState\.siteUrl\)/, 'a site lock does not reopen its site');

  // 3) ⚠️ FAIL OPEN, AND IN THIS ORDER. Both refusals must come BEFORE the viewer check:
  //    with it on top an orphaned lock never reached the release, and the child was left on
  //    a locked screen with no 🏠 holding a lock on a site that could never open.
  const open = fnSlice(app, 'async function openLockedSite(');
  const rulesAt = open.indexOf('rulesForLockedSite(');
  const availAt = open.indexOf('siteViewerAvailable()');
  assert.ok(rulesAt > 0 && availAt > rulesAt,
    'the viewer check runs before the fail-open release — a child can be stranded behind an unopenable lock');
  assert.match(open, /if \(!rules\.length\) return release\(/, 'a deleted site leaves the lock standing');
  assert.match(open, /clearContainment\(\)/, 'nothing releases an unenforceable lock');

  // 4) the RULES are narrowed, which is what "locked inside this site" means
  assert.match(open, /rules,/, 'openLockedSite passes the full rule set — an approved link would carry the child out');
  assert.match(open, /locked: true/, 'the viewer is opened unlocked — its back button would still close it');
});

test('the site viewer refuses the CHILD, never the app (v1.0.67)', () => {
  const a = readRepo('android/app/src/main/java/com/assaf/kidsplayer/KidsWebPlugin.java');
  const b = readRepo('native-reference/KidsWebPlugin.java');
  assert.equal(a, b, 'the two KidsWebPlugin copies have drifted');
  const src = a.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // ⚠️ THE APP'S OWN CLOSE MUST ALWAYS WORK. v1.0.45 closes the viewer before the break
  // screen and calls that "the one wiring step that decides whether the browser respects
  // screen time at all" — a site lock holds the CHILD in, never the app.
  assert.match(src, /public void close\(PluginCall call\)[\s\S]{0,220}?forceClose\(\)/,
    'the plugin close() honours the child lock — screen time could no longer close the viewer');
  assert.match(src, /private void closeOverlay\(\)[\s\S]{0,200}?if \(childLocked\)/,
    'the child\'s own close is no longer gated by the lock');
  // hardware back must stop falling through to a close
  const hb = src.slice(src.indexOf('static boolean handleBack()'));
  assert.match(hb.slice(0, 700), /childLocked[\s\S]{0,120}?return true;/,
    'hardware back still closes the viewer once the site history runs out');
  // and the bar must not keep a "go back" label on a button that refuses to go back
  assert.match(src, /childLocked \? "🔒/, 'the locked bar still reads as a way out');
  // the lock reaches JS, which owns the code screen — never a second PIN in Java
  assert.match(src, /webLockRequest/, 'the padlock reaches nothing');
  // ⚠️ WORD-BOUNDED ON BOTH SIDES. The first version was /\bpin\b|PIN/i, whose second
  // alternative has no boundary at all — it fired on `lastActivityPing`, i.e. on correct
  // code. A guard that trips on what it is meant to permit trains you to delete it.
  assert.doesNotMatch(src, /\bpin\b/i, 'the parent code must be verified in ONE place, and it is JS');
});

test('the site lock can actually be ENGAGED, and the scene stops with the sound (v1.0.70)', () => {
  // ⚠️ ALL THREE OF THESE SHIPPED BROKEN AND WERE REPORTED FROM A DEVICE. Each is the same
  // shape: correct-looking code with no reachable path, on a surface no browser can render.

  // 1) THE PADLOCK MUST EXIST BEFORE A LOCK DOES. v1.0.67 emitted `webLockRequest` only from
  //    paths that already required `childLocked`, so a site lock could never be turned ON —
  //    the whole feature was unreachable ("אני לא רואה שיש נעילה לאתר אינטרנט ספציפי").
  const web = readRepo('android/app/src/main/java/com/assaf/kidsplayer/KidsWebPlugin.java');
  const webRef = readRepo('native-reference/KidsWebPlugin.java');
  assert.equal(web, webRef, 'the two KidsWebPlugin copies have drifted');
  const wsrc = web.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const build = wsrc.slice(wsrc.indexOf('private void buildOverlay'));
  assert.match(build.slice(0, 4000), /notifyListeners\("webLockRequest"/,
    'the viewer bar has no padlock — a site lock can never be engaged');
  assert.match(build.slice(0, 4000), /if \(!parentMode\)/,
    'the padlock shows in PARENT mode — that session browses unrestricted, and locking a child into it would undo every rule');
  // the child's way out is hidden while locked (the refusal is elsewhere, this is the affordance)
  assert.match(build.slice(0, 4000), /back\.setVisibility\(childLocked/,
    'the close button stays on screen under a lock — a lock with a visible door');
  // and the code is still never verified natively
  assert.doesNotMatch(wsrc, /\bpin\b/i, 'the parent code must be verified in ONE place, and it is JS');

  // 2) the audio scene must FREEZE, not reset, and must follow the media element itself so
  //    every pause source is covered (shield, HUD, notification, call, screen-off)
  const player = CODE.get('www/js/player.js');
  assert.match(player, /const setPausedScene = \(\) =>[^;]*is-paused', !!video\.paused\)/,
    'the paused scene is driven by something other than the media element — a pause source would be missed');
  for (const ev of ['play', 'pause', 'ended']) {
    assert.match(player, new RegExp(`addEventListener\\('${ev}', setPausedScene\\)`),
      `the scene does not react to '${ev}'`);
    assert.match(player, new RegExp(`removeEventListener\\('${ev}', setPausedScene\\)`),
      `the '${ev}' listener leaks past teardown`);
  }
  assert.match(player, /classList\.remove\('is-paused'\)/,
    'a stale is-paused survives teardown — it would freeze the NEXT track\'s scene');
  const css = readFileSync(join(ROOT, 'www', 'css', 'styles.css'), 'utf8');
  assert.match(css, /is-paused[\s\S]{0,120}?animation-play-state:\s*paused/,
    'the scene is stopped with something other than animation-play-state — anything else snaps it back to the start');
});

test('a centre tap SAYS what it did, and the two badges stay apart (v1.0.71)', () => {
  // The ±10 seek has confirmed itself since v1.0.9; pause/resume did not, so the one gesture
  // a child uses most was the one with no feedback (user request: make it like YouTube).
  const player = CODE.get('www/js/player.js');
  const fn = fnSlice(player, 'const toggleWithFlash = () => {');
  assert.ok(fn, 'toggleWithFlash is gone — the centre tap is silent again');
  // ⚠️ THE STATE IS READ BEFORE THE TOGGLE. togglePlay() starts an ASYNCHRONOUS play on both
  // engines, so asking afterwards can still answer "paused" and the badge would contradict
  // what just happened.
  assert.match(fn, /const wasPlaying = ctl\.isPlaying\(\);[\s\S]{0,80}?ctl\.togglePlay\(\)/,
    'the badge is decided after the toggle — an async play would make it lie');
  assert.match(fn, /flash\(wasPlaying \? '⏸' : '▶', 'toggle'\)/, 'the badge no longer shows the action taken');

  // BOTH surfaces with no visible control use it: the centre tap and the TV remote's OK.
  // (The HUD button is deliberately NOT one — the button itself is the indicator.)
  assert.match(player, /if \(visible && center\) \{ toggleWithFlash\(\)/,
    'the centre tap toggles without saying so');
  assert.match(player, /intent\.kind === 'toggle'\) toggleWithFlash\(\)/,
    'the TV remote toggles without saying so');

  // ONE element and ONE timer for both kinds, or a seek landing on a pause leaves two
  // badges fighting over the middle of the video
  assert.equal((player.match(/getElementById\('seek-feedback'\)|\$id\('seek-feedback'\)/g) || []).length, 1,
    'a second feedback element appeared — the two badges would overlap');
  const css = readFileSync(join(ROOT, 'www', 'css', 'styles.css'), 'utf8');
  // …and they must be told apart by SHAPE, because the child this is for cannot read the
  // seek's number
  // ⚠️ ANCHORED TO THE RULE'S OWN BRACES. A character window matched a `border-radius: 50%`
  // belonging to a LATER rule (.ctl-btn), so the guard stayed green with the badge planted
  // square — the second window in this one test to be wrong that way.
  const round = css.slice(css.indexOf('.seek-feedback.is-toggle {'));
  assert.match(round.slice(0, round.indexOf('}')), /border-radius:\s*50%/,
    'the play/pause badge is not round — it would be indistinguishable from the seek pill');
  // matched inside the rule's own braces rather than a character window — the declaration
  // sat 10 characters past a 200-char guess, which is a guard failing on correct code
  const base = css.slice(css.indexOf('.seek-feedback {'));
  assert.match(base.slice(0, base.indexOf('}')), /pointer-events:\s*none/,
    'the badge takes pointer events — it sits over the video and would swallow the next tap');
});

test('a deliberate pause is marked at every surface a person can press (v1.0.72)', () => {
  // ⚠️ THE POLL COULD NOT TELL TWO PAUSES APART. A call's pause and a child's pause look
  // identical from outside, so the distinction has to be RECORDED where the person presses.
  const player = CODE.get('www/js/player.js');
  assert.match(player, /export function markUserToggle\(paused\)/, 'nothing records a deliberate pause');
  // the state carries it to the watcher
  assert.match(player, /userPaused: userPausedAt > 0/, 'playbackState no longer reports who paused');
  // …set by the player-side toggle (centre tap AND the TV remote both route through it)
  assert.match(player, /markUserToggle\(wasPlaying\);[\s\S]{0,60}?ctl\.togglePlay\(\)/,
    'the centre tap and the remote no longer mark their pause');
  // …cleared wherever the video plays again, or a stale mark would block a LATER real call
  assert.match(fnSlice(player, 'export function resumeCurrent('), /userPausedAt = 0/,
    'a resume leaves the mark standing — the next real call would not arm');
  assert.match(fnSlice(player, 'export async function playItem('), /userPausedAt = 0/,
    'a new video inherits the previous one\'s pause mark');
  // ⚠️ app-initiated pauses must NOT mark: those are exactly the ones a call may resume from
  const app = CODE.get('www/js/app.js');
  const pause = appPauseBody(app);
  assert.doesNotMatch(pause, /markUserToggle/,
    'screen-off marks a deliberate pause — a call would then never resume the video');
  // …but the notification's ⏯ IS a person pressing pause
  const cmd = fnSlice(app, 'async function handlePlaybackCommand(');
  assert.match(cmd, /markUserToggle\(st\.playing\)/,
    'a pause from the lock screen is not marked — a call would resume what the parent stopped');
  // and the decision, not the caller, owns the rule
  assert.match(app, /userPaused: !!\(st && st\.userPaused\)/, 'the watcher no longer passes it to the decision');
  assert.match(CODE.get('www/js/playerlogic.js'), /if \(userPaused\) return null;/,
    'planCallResume ignores a deliberate pause again');
});

test('the lock screen follows the PLAYER, not the last button pressed (v1.0.74)', () => {
  // ⚠️ REPORTED FROM A DEVICE: the widget showed ⏸ — "playing, press to pause" — over a
  // track that had FINISHED (57:06 of 57:06). The session state was published only when the
  // notification's own buttons were pressed, so a pause from the screen, a call, or a track
  // simply ending left it advertising STATE_PLAYING for ever.
  const player = CODE.get('www/js/player.js');
  assert.match(player, /opts\.onPlayState\(!video\.paused\)/,
    'the player no longer reports its play state — the widget would go stale again');
  for (const ev of ['play', 'pause', 'ended']) {
    assert.match(player, new RegExp(`addEventListener\\('${ev}', notifyPlayState\\)`),
      `a '${ev}' no longer republishes — the icon would lie after it`);
    assert.match(player, new RegExp(`removeEventListener\\('${ev}', notifyPlayState\\)`),
      `the '${ev}' reporter leaks past teardown`);
  }
  // 'ended' matters most: that is the exact state in the report
  const app = CODE.get('www/js/app.js');
  assert.match(app, /onPlayState: \(playing\) => \{ republishBackgroundState\(playing\)/,
    'nothing listens for the player\'s state changes');

  // ⚠️ THE TOGGLE REPORTS WHAT HAPPENED, NOT WHAT WAS ASKED FOR. resumeCurrent() can be
  // refused by the browser (no user activation, a device still holding audio focus), and
  // publishing "playing" straight after the call would leave the widget claiming a silent
  // track is running — the very bug this fixes, one layer up.
  const cmd = fnSlice(app, 'async function handlePlaybackCommand(');
  const toggle = cmd.slice(0, cmd.indexOf("action !== 'fwd'"));
  assert.doesNotMatch(toggle, /startBackgroundPlayback\(/,
    'the toggle publishes its own optimistic state instead of waiting for the player');
  assert.match(toggle, /if \(st\.playing\) pauseCurrent\(\); else resumeCurrent\(\);/,
    'the toggle no longer just asks the player and lets the event report back');
});

/* ---------------- picture-in-picture (v1.0.76) ---------------- */

test('PiP: entry is gated, the pause handler knows a shrink from a backgrounding, and every lock refuses it (v1.0.76)', () => {
  const app = CODE.get('www/js/app.js');

  // 1) ⚠️ THE PAUSE GATE COMES FIRST. Entering PiP fires the very appStateChange the
  //    v1.0.32 screen-off handler listens to — without this gate the video pauses the
  //    instant it shrinks and the whole feature is a frozen floating frame. It must
  //    precede the save (a save-then-return would still be harmless, but the gate being
  //    FIRST is what documents the contract: a shrink is not a backgrounding).
  const body = appPauseBody(app);
  assert.ok(body, 'the onAppPause listener is gone');
  const gate = body.indexOf('if (inPipMode) return');
  assert.ok(gate >= 0, 'the screen-off handler pauses the video the moment PiP begins');
  assert.ok(gate < body.indexOf('saveWatchPosition'),
    'the PiP gate sits after the pause work — the contract is decided before anything runs');

  // 2) THE WINDOW GOING AWAY HAS ITS OWN DOOR, and it repeats the v1.0.32 contract: no
  //    appStateChange fires (the activity already paused at PiP entry), so onPipHidden
  //    must save FIRST (the live playhead), consult the bgPlay decision, and pause IN
  //    PLACE — never stop() (the "הסרטון נעלם" class).
  // brace-balanced, NOT a char window: the window version reached into the neighbouring
  // onAppPause and stayed green with the bgPlay consult deleted (proven by its own plant)
  const hidden = handlerBody(app, 'onPipHidden(');
  assert.ok(hidden, 'nothing listens for the PiP window going away — X leaves the video playing blind');
  const hSave = hidden.indexOf('saveWatchPosition(currentWatch');
  const hPause = hidden.indexOf('pauseCurrent()');
  assert.ok(hSave >= 0, 'the PiP-hidden door no longer banks the stop point');
  assert.ok(hPause >= 0 && hSave < hPause, 'the PiP-hidden door pauses before saving — stale playhead');
  assert.match(hidden, /backgroundPlayDecision\(/,
    'the PiP-hidden door ignores bgPlay — screen-off over the window would silence a legitimate background listen');
  assert.doesNotMatch(hidden, /\bstop\(\)/, 'the PiP-hidden door tears the player down');

  // 3) ELIGIBILITY IS PUSHED AHEAD AND EVERY LOCK REFUSES IT. The pure decision owns the
  //    rule (unit-tested); this pins the WIRING — refreshPipState must hand it the kiosk
  //    AND the containment state, or a lock silently stops applying to PiP.
  const refresh = fnSlice(app, 'async function refreshPipState(');
  assert.match(refresh, /pipEligibility\(/, 'refreshPipState no longer delegates to the pure decision');
  assert.match(refresh, /contained: containState\.active/, 'a containment lock no longer reaches the PiP decision');
  assert.match(refresh, /exitLockOn\(/, 'the kiosk no longer reaches the PiP decision');
  assert.match(refresh, /kiosk = true/,
    'an unreadable kiosk setting must read as STRICT (kiosk on), never as "no kiosk"');
  // …and the push points exist: a video opening, the player reporting play/pause, the
  // watch view leaving. Each is a moment the pushed answer changes.
  // ⚠️ anchored to the arm call, NOT the whole function: openWatch also carries the
  // onPlayState callback (which mentions refreshPipState), so a whole-function match was
  // proven VACUOUS by its own plant — it stayed green with the direct call deleted.
  assert.match(fnSlice(app, 'async function openWatch('), /armBackgroundPlayback\(item\)[\s\S]{0,320}?refreshPipState\(/,
    'opening a video no longer refreshes the pushed PiP state');
  assert.match(app, /onPlayState: \(playing\) => \{ republishBackgroundState\(playing\)\.catch\(\(\) => \{\}\); refreshPipState\(\)/,
    'a play/pause no longer refreshes the PiP state — the window ⏯ icon and auto-enter go stale');
  // …and BOTH engines report. The file engine has since v1.0.74 (its own guard); the YT
  // engine reports through `cb` — NEVER `opts`, which reuse() swaps away, so `opts` would
  // report into the PREVIOUS video's callbacks. Without this, eligibility and the ⏯ icon
  // go stale on every YouTube video — half the library. (Proven red by its own plant.)
  assert.match(CODE.get('www/js/player.js'), /cb\.onPlayState\(e\.data === YT\.PlayerState\.PLAYING\)/,
    'the YouTube engine no longer reports play/pause — PiP goes stale on YouTube videos');
  const watchLeave = app.slice(app.indexOf("nav.register('watch'"), app.indexOf("nav.register('watch'") + 2600);
  assert.match(watchLeave, /pipTrack = null/, 'a left watch view keeps a stale ⏮/⏭ track');
  assert.match(watchLeave, /refreshPipState\(/, 'leaving the watch view leaves PiP armed for a dead video');

  // 4) THE SKIP IS THE GRID'S OWN ORDER — pageAnyFolder, THE pagination entry point (the
  //    v1.0.63 precedent), never a second reading of the folder rules; and the state is
  //    RE-READ after the await (the v1.0.57 rule — the command is retained natively).
  const track = fnSlice(app, 'async function buildPipTrack(');
  assert.match(track, /pageAnyFolder\(/, 'the PiP track no longer comes from the one pagination entry point');
  const skip = fnSlice(app, 'async function pipSkip(');
  assert.match(skip, /pipSkipTarget\(/, 'the skip no longer goes through the pure gift-skipping decision');
  const afterAwait = skip.slice(skip.indexOf('await buildPipTrack()'));
  assert.match(afterAwait, /nav\.isActive\('watch'\)/,
    'pipSkip does not re-check the watch view after its await — a retained ⏭ starts a video into a left screen');
  // routed BEFORE the bgPlay gate: PiP must work with background playback off
  const cmd = fnSlice(app, 'async function handlePlaybackCommand(');
  const route = cmd.indexOf("action === 'prev'");
  assert.ok(route >= 0, 'the PiP ⏮/⏭ verbs are not routed at all');
  assert.ok(route < cmd.indexOf('bgPlayEnabled'),
    'prev/next sit behind the bgPlay gate — the PiP buttons die whenever background playback is off');
  assert.match(cmd, /!bgPlayEnabled && !pipEnabled/,
    'the ⏯ gate no longer admits PiP — the window\'s pause button dies with bgPlay off');

  // 5) the idle "עדיין צופים?" is held during PiP — the prompt renders under a window
  //    that forwards no taps, so an unanswerable question would just park the video.
  assert.match(fnSlice(app, 'async function tickIdleSleep('), /\|\| inPipMode/,
    'the idle timer counts against a PiP session nobody can answer');
});

test('PiP: the native half is declared, lock-gated, ordered, and identical in both copies (v1.0.76)', () => {
  // Node cannot press HOME — these are source guards over the halves a behavioural test
  // cannot reach, comment-stripped (the v1.0.45 lesson: three guards fired on their own
  // comments).
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const name of ['android/app/src/main/AndroidManifest.xml', 'native-reference/AndroidManifest.xml']) {
    const m = readRepo(name).replace(/<!--[\s\S]*?-->/g, '');
    assert.match(m, /android:supportsPictureInPicture="true"/,
      `${name}: the activity cannot PiP — enterPictureInPictureMode throws at runtime`);
  }
  // the plugin pair must not drift (MainActivity/manifest already ride the byte-identical
  // pair test; KidsNativePlugin joins it here because the PiP logic lives in it)
  assert.equal(readRepo('android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java'),
    readRepo('native-reference/KidsNativePlugin.java'),
    'the two KidsNativePlugin copies have drifted');

  const main = strip(readRepo('android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java'));
  assert.match(main, /onUserLeaveHint\(\)[\s\S]{0,200}?maybeEnterPip\(this\)/,
    'HOME no longer offers PiP — the 26–30 / 3-button path is dead');
  assert.match(main, /onPictureInPictureModeChanged\(boolean[\s\S]{0,300}?onPipModeChanged\(this/,
    'the mode change no longer reaches JS — the pause handler cannot tell a shrink from a backgrounding');
  // onStop must consult the PiP hook BEFORE super — after it, plugin state may be torn down
  const stopAt = main.indexOf('public void onStop()');
  assert.ok(stopAt > 0, 'MainActivity lost its onStop override — a dismissed window leaves the video playing blind');
  const stopBody = main.slice(stopAt, stopAt + 220);
  assert.ok(stopBody.indexOf('onPipActivityStopped()') >= 0
      && stopBody.indexOf('onPipActivityStopped()') < stopBody.indexOf('super.onStop()'),
    'onStop calls super before the PiP hook');

  const plug = strip(readRepo('android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java'));
  // ⚠️ THE KIOSK GATE IS NATIVE TOO: maybeEnterPip must refuse under screen pinning even
  // if a stale eligibility was pushed — the OS would refuse anyway, but the decision must
  // be ours, not an OS side effect.
  const enter = plug.slice(plug.indexOf('static void maybeEnterPip('), plug.indexOf('static void maybeEnterPip(') + 600);
  assert.match(enter, /pipEligible/, 'maybeEnterPip ignores the pushed decision — PiP fires for every family');
  assert.match(enter, /inLockTaskStatic\(/, 'maybeEnterPip no longer refuses under the kiosk pin');
  // the three window buttons ride the EXISTING retained command channel
  for (const verb of ['"prev"', '"next"', '"toggle"']) {
    assert.match(plug, new RegExp(`emitPlaybackCommand\\(${verb}\\)`),
      `the PiP window's ${verb} button no longer reaches JS`);
  }
  // the broadcast stays inside this app (pre-33 context receivers are world-reachable)
  assert.match(plug, /setPackage\(a\.getPackageName\(\)\)/,
    'the PiP action broadcasts lost setPackage — a stranger can skip the child\'s track');
  assert.match(plug, /FLAG_IMMUTABLE/, 'the PiP PendingIntents are mutable');
  // both event names, retained (a frozen WebView must not lose the pause contract)
  assert.match(plug, /notifyListeners\("pipChanged", o, true\)/, 'pipChanged is not retained');
  assert.match(plug, /notifyListeners\("pipHidden", o, true\)/, 'pipHidden is not retained');

  // the four action icons exist in BOTH res trees (a missing drawable is a runtime crash
  // when the window builds its actions)
  for (const dir of ['android/app/src/main/res/drawable', 'native-reference/res/drawable']) {
    for (const icon of ['ic_pip_prev', 'ic_pip_next', 'ic_pip_play', 'ic_pip_pause']) {
      // comment-stripped: the file's own comment EXPLAINS why fillType is banned, and a
      // guard that fires on its explanation is the v1.0.69 trap for the fourth time
      const svg = readRepo(`${dir}/${icon}.xml`).replace(/<!--[\s\S]*?-->/g, '');
      assert.match(svg, /fillColor="#FFFFFFFF"/,
        `${dir}/${icon}: not flat white — a RemoteAction icon is drawn from its alpha and tinted`);
      assert.doesNotMatch(svg, /fillType/,
        `${dir}/${icon}: android:fillType is API 24 — it forces PNG fallbacks nothing here generates`);
    }
  }

  // the settings row: per-profile, synced, and the tie resolves OFF (the bgPlay asymmetry —
  // a wrong "on" quietly opens a door out of the app)
  const settings = CODE.get('www/js/settings.js');
  assert.match(settings, /pip: false/, "the 'pip' setting lost its safe tie direction");
  const html = readRepo('www/index.html');
  assert.match(html, /id="pip-toggle"/, 'the PiP toggle is gone from the settings screen');
  assert.match(html, /id="pip-row"/, 'the PiP row cannot be hidden on devices that cannot PiP');
});
