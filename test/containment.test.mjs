// v1.0.56 — the containment lock: the parent locks the child into the app, or into ONE
// folder, with an optional timer. Entering and leaving both cost the parent code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evalContainment, containmentChrome, normalizeLockMinutes, containConfirmText,
  containCountdownLabel, CONTAIN_MAX_MIN, relockChoice
} from '../www/js/plan.js';

test('a lock with no end runs until the parent releases it', () => {
  const c = evalContainment({ mode: 'app', until: 0 });
  assert.equal(c.active, true);
  assert.equal(c.msLeft, 0, '0 means "no end", not "expired"');
  assert.equal(c.expired, false);
});

test('a timed lock expires by itself, and expiry is distinguishable from "off"', () => {
  const now = 1_000_000;
  const live = evalContainment({ now, mode: 'app', until: now + 60_000 });
  assert.equal(live.active, true);
  assert.equal(live.msLeft, 60_000);

  const done = evalContainment({ now, mode: 'app', until: now - 1 });
  assert.equal(done.active, false);
  assert.equal(done.expired, true, 'the caller must be able to tell "just expired" from "never set"');

  const never = evalContainment({});
  assert.equal(never.active, false);
  assert.equal(never.expired, false);
});

test('a corrupted lock FAILS OPEN — a child is never stranded behind an unidentifiable lock', () => {
  // deliberately the opposite direction from the kiosk (exitLock), which errs strict: this
  // state is written by one device and read on every render, and the kiosk still contains
  // the child independently of it.
  for (const bad of [
    { mode: 'nonsense', until: 0 },
    { mode: 'folder', folderId: null, until: 0 },   // folder mode with no folder
    { mode: 'folder', folderId: '', until: 0 },
    { mode: null }, {}
  ]) {
    assert.equal(evalContainment(bad).active, false, `expected OFF for ${JSON.stringify(bad)}`);
  }
  // …but a well-formed folder lock is honoured
  assert.equal(evalContainment({ mode: 'folder', folderId: 'cf:1', until: 0 }).folderId, 'cf:1');
  // app mode never carries a folder, even if one was stored
  assert.equal(evalContainment({ mode: 'app', folderId: 'cf:1', until: 0 }).folderId, null);
});

test('the chrome says exactly what the child loses, per mode', () => {
  const off = containmentChrome({ active: false });
  // v1.0.67 added hideSites — the OFF answer must still deny nothing
  assert.deepEqual(off, { hideExit: false, hideChip: false, hideHome: false, hideSites: false, locked: false });

  const app = containmentChrome({ active: true, mode: 'app' });
  assert.equal(app.hideExit, true, 'the child must not leave the app');
  assert.equal(app.hideChip, true, 'nor switch to a sibling profile');
  assert.equal(app.hideHome, false, 'app mode keeps every folder open — the user\'s rule');

  const folder = containmentChrome({ active: true, mode: 'folder' });
  assert.equal(folder.hideHome, true, 'folder mode must close the way out of the folder');
  assert.equal(folder.hideExit, true);
  assert.equal(folder.locked, true);
});

test('the duration: 0 is a real answer, junk falls back, and it is capped', () => {
  assert.equal(normalizeLockMinutes(0, 30), 0, '0 = until released, and must survive');
  assert.equal(normalizeLockMinutes(45, 30), 45);
  assert.equal(normalizeLockMinutes('45', 30), 45);
  assert.equal(normalizeLockMinutes(30.7, 0), 30);
  // junk → the remembered value, never an invented short/long lock (planRejectedPurge rule)
  for (const junk of ['abc', null, undefined, NaN, -5, {}]) {
    assert.equal(normalizeLockMinutes(junk, 30), 30, `junk ${String(junk)} did not fall back`);
  }
  assert.equal(normalizeLockMinutes('abc', 'also junk'), 0, 'a junk fallback lands on 0');
  assert.equal(normalizeLockMinutes(99999), CONTAIN_MAX_MIN, 'capped');
});

test('the confirm text names the mode, the folder and the way out', () => {
  const f = containConfirmText({ mode: 'folder', folderTitle: 'חיות', minutes: 30 });
  assert.match(f, /חיות/, 'a folder lock must name the folder');
  assert.match(f, /30 דקות/);
  assert.match(f, /קוד ההורים/, 'the parent must be told how it ends');

  const a = containConfirmText({ mode: 'app', minutes: 0 });
  assert.match(a, /כל התיקיות/, 'app mode leaves the folders open');
  assert.match(a, /עד שתשחררו/, '0 minutes must read as "until you release it"');
  assert.doesNotMatch(a, /undefined|NaN/);

  // both modes must always say the child cannot leave the app
  for (const t of [f, a]) assert.match(t, /לצאת מהאפליקציה/);
});

test('the countdown label is human, and empty when there is no end', () => {
  assert.equal(containCountdownLabel(0), '');
  assert.equal(containCountdownLabel(-5), '');
  assert.equal(containCountdownLabel(60_000), '1 דק׳');
  assert.equal(containCountdownLabel(90 * 60_000), '1 ש׳ 30 דק׳');
  assert.equal(containCountdownLabel(120 * 60_000), '2 ש׳');
  assert.doesNotMatch(containCountdownLabel(NaN), /NaN/);
});

test('relockChoice: an active lock offers release OR re-lock, and the mapping cannot invert (v1.0.76)', () => {
  // The reported bug: with a lock active every padlock tap was release-only, so the "how
  // long?" dialog appeared on the FIRST lock and never again. The fix is a choice after the
  // code; this pins the ok/third mapping so a swapped pair can't hand a child a release where
  // the parent meant to re-lock.
  assert.equal(relockChoice('ok'), 'release', 'the primary button releases');
  assert.equal(relockChoice('third'), 'relock', 're-lock is the path that was missing');
  // anything that is NOT an explicit answer leaves the lock exactly as it was
  assert.equal(relockChoice('cancel'), 'none');
  assert.equal(relockChoice('dismiss'), 'none');
  assert.equal(relockChoice(''), 'none');
  assert.equal(relockChoice(undefined), 'none');
  assert.equal(relockChoice(null), 'none');
});
