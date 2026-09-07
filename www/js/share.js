// share.js — JS side of the Android share-target (F12b). The native side
// (KidsNativePlugin) queues EXTRA_TEXT into a static inbox and fires a retained
// 'shareReceived' event; boot order here is listener FIRST, then drain — double
// delivery is harmless because the key-duplicate check makes handling idempotent.
//
// Routing (decision 16): the parent-screen toggle (sources.shareIntent.requireApproval)
// decides pending-approval vs added-immediately. A share with no active profile is
// stashed in Preferences and drained on the next profile activation.

import { classifyShared } from './classify.js';
import { normalizeTitle } from './normalize.js';
import { sortKeyFor } from './order.js';
import { prefGet, prefSet } from './platform.js';
import * as db from './db.js';
import { getSetting } from './settings.js';

const K_QUEUE = 'pendingShares';

function kidsNative() {
  const c = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return c && c.Plugins ? c.Plugins.KidsNative : null;
}

let getPid = () => null;
let onAdded = () => {};
// v1.0.7: app.js provides the PIN+confirm dialog flow. Given the classified share it
// resolves 'live' | 'pending' | 'channel' | 'discard'. When absent (or it throws),
// everything falls back to the old silent pending routing — a share is never lost.
let interactive = null;
// v1.0.23: app.js decides WHICH profile a share lands in when the app already has one
// active. Resolves a profileId (it may have switched the app into it), or null to abort.
// Absent (browser preview) ⇒ the active profile, i.e. exactly the old behaviour.
let chooseProfile = null;
// v1.0.61 — asks the parent whether to restore content they removed before. Injected by
// app.js (the dialog and the un-deny live there); absent = the old silent refusal.
let askDenied = null;
// v1.0.26: app.js shows a toast for EVERY outcome. Absent (browser preview) ⇒ silent,
// exactly as before.
let onResult = () => {};

export function initShareTarget({ profileIdGetter, onShareAdded, interactiveHandler, profileChooser, resultHandler, deniedHandler } = {}) {
  if (profileIdGetter) getPid = profileIdGetter;
  if (onShareAdded) onAdded = onShareAdded;
  if (interactiveHandler) interactive = interactiveHandler;
  if (profileChooser) chooseProfile = profileChooser;
  if (deniedHandler) askDenied = deniedHandler;
  if (resultHandler) onResult = resultHandler;
  const plug = kidsNative();
  if (!plug || !plug.addListener) return; // browser preview / plugin absent
  plug.addListener('shareReceived', (o) => { handleShare(o).catch(() => {}); });
  plug.getPendingShares()
    .then(({ shares }) => { for (const s of shares || []) handleShare(s).catch(() => {}); })
    .catch(() => {});
}

/** Called on profile activation: absorb shares that arrived with no active profile. */
/** v1.0.29: is a cold-start share waiting? The boot flow must show the PICKER then —
    it is that share's routing question (v1.0.23) — instead of auto-resuming a profile. */
export async function hasQueuedShares() {
  try { return ((await prefGet(K_QUEUE)) || '[]') !== '[]'; } catch { return false; }
}

export async function drainShareQueue() {
  let queue = [];
  try { queue = JSON.parse((await prefGet(K_QUEUE)) || '[]'); } catch {}
  if (!Array.isArray(queue) || !queue.length) return;
  await prefSet(K_QUEUE, '[]');
  // alreadyRouted: these arrived with NO profile active, and the parent has just picked one
  // by entering it. That tap is the routing decision — do not ask a second time (v1.0.23).
  for (const s of queue) await handleShare(s, { alreadyRouted: true }).catch(() => {});
}

/**
 * v1.0.26 — every route ends in a REASON, and the caller reports it.
 *
 * FIELD BUG: this function had seven silent `return`s and no success path either, so a
 * parent sharing from YouTube saw the same thing — nothing — whether the video was added,
 * parked for approval, a duplicate, previously deleted, or dropped. "Sharing does not
 * work" was unanswerable from inside the app. Reasons map to text in pure
 * `plan.shareOutcome`.
 */
async function handleShare(o, { alreadyRouted = false } = {}) {
  const reason = await routeShare(o, { alreadyRouted });
  try { onResult(reason); } catch {}
  return reason;
}

async function routeShare(o, { alreadyRouted = false } = {}) {
  let pid = getPid();
  if (!pid) { // no profile active yet — stash (cap 50, dedupe by text)
    let queue = [];
    try { queue = JSON.parse((await prefGet(K_QUEUE)) || '[]'); } catch {}
    if (!queue.some((q) => q.text === o.text)) queue.push({ text: o.text, subject: o.subject, at: o.at });
    await prefSet(K_QUEUE, JSON.stringify(queue.slice(-50)));
    return 'no-profile';
  }

  const c = classifyShared(o.text, o.subject);
  if (!c) return 'unsupported'; // the safety boundary held — not a playable link

  // v1.0.23 — WHICH profile? Only asked when the app already has one active, i.e. the
  // parent shared into a RUNNING app and we would otherwise pick for them silently. The
  // cold-start path deliberately does not ask: it lands on the profile picker anyway, and
  // the profile the parent then taps IS the answer (asking again would be the same question
  // twice). `alreadyRouted` marks a share replayed from that queue.
  if (!alreadyRouted && chooseProfile) {
    let chosen;
    try { chosen = await chooseProfile(c); } catch { chosen = pid; }
    if (!chosen) return 'cancelled'; // the parent backed out — nothing written, nothing lost
    pid = chosen;
  }

  if (c.kind === 'channel' || c.kind === 'playlist') return handleSourceShare(pid, c);

  const src = await db.getSources(pid);
  // v1.0.6: shares land in the SHARED library folder ('sheet') when sources exist —
  // one list for the whole family; the profile scope stays only as the pre-first-sync
  // fallback (absorbed into the library on the next activation).
  const lib = src && src.libraryId;
  const scope = lib || db.profScope(pid);
  const homeFolder = lib ? 'sheet' : 'mine';
  if (await db.getVideo(scope, c.key)) return 'duplicate'; // idempotent on double delivery
  if (lib && await db.getVideo(db.profScope(pid), c.key)) return 'duplicate';
  // v1.0.61 — DELETED NO LONGER MEANS REFUSED, IT MEANS ASKED (user request). But the
  // question is deferred to AFTER the PIN+confirm below, and that order is the safety
  // property: asking here would let a CHILD revoke a deletion tombstone by sharing the
  // video back into the app. Only a parent who has already passed the code may answer it.
  let denied = (await db.loadDenySet(scope)).has(c.key);
  if (!denied && lib) denied = (await db.loadDenySet(db.profScope(pid))).has(c.key);

  // v1.0.7: the interactive PIN+confirm flow decides; without it (browser preview,
  // handler error) the old toggle-based routing still applies. A declined/cancelled
  // interactive share PARKS AS PENDING (user decision) — never silently lost.
  let decision = null;
  if (interactive) {
    try { decision = await interactive(c); } catch { decision = null; }
  }
  if (decision === 'discard') return 'cancelled';
  // The tombstone question, now that a parent is provably present. With NO interactive
  // handler (browser preview, a thrown handler) nobody has authenticated, so the old
  // refusal stands — a share must never revoke a deletion unasked.
  if (denied) {
    const restored = decision && askDenied ? await askDenied(c.key, scope).catch(() => false) : false;
    if (!restored) return 'denied';
  }
  // v1.0.25: the fallback toggle moved to the synced per-profile settings. Defaulting to
  // TRUE is the whole point of this branch — it runs when the interactive PIN+confirm
  // flow is unavailable or threw, and a share must never reach the child unasked.
  const requireApproval = decision
    ? decision !== 'live'
    : (await getSetting(pid, 'shareApproval', true)) !== false;

  const now = Date.now();
  await db.putVideos([{
    scopeId: scope, key: c.key, type: c.type, id: c.id ?? null, url: c.url ?? null,
    srcUrl: c.srcUrl, driveId: c.driveId ?? null, media: c.media ?? null,
    title: c.title || '', titleSource: c.title ? 'sheet' : null, normTitle: normalizeTitle(c.title),
    folderId: requireApproval ? '~pending' : homeFolder,
    homeFolderId: homeFolder, channelId: null,
    sortKey: sortKeyFor({ origin: 'share-intent', addedAt: now }),
    publishedAt: null, rowIndex: null, origin: 'share-intent',
    state: requireApproval ? 'pending' : 'live',
    addedAt: now, approvedAt: requireApproval ? null : now,
    thumbId: null, thumbUrl: null, localPath: null, updatedAt: now
  }]);
  try { onAdded({ key: c.key, title: c.title, pending: requireApproval }); } catch {}
  return requireApproval ? 'pending' : 'added';
}

/**
 * A shared CHANNEL or PLAYLIST. PIN + confirm, subscribe, then let
 * `onAdded` import it and ask what to do with the back catalogue (app.js owns the loading
 * screen and the dialog; this layer may not import ui/*).
 *
 * v1.0.26 — three silent drops removed. Each returned bare and the parent saw nothing:
 *  - `decision !== 'channel'` swallowed a declined confirm AND the case where the PIN
 *    screen or a modal was already up (handleShareInteractive answers null for a channel
 *    there), which is easy to hit when the share arrives into a running app;
 *  - `!lib` — a profile with no sources record yet — dropped the channel outright instead
 *    of creating the record the parent-screen path creates for itself;
 *  - a failed reference resolve reported `channelFailed` but nothing told the parent.
 */
async function handleSourceShare(pid, c) {
  const isPlaylist = c.kind === 'playlist';
  if (!interactive) return 'cancelled'; // no way to ask — never subscribe silently
  let decision = null;
  try { decision = await interactive(c); } catch { decision = null; }
  if (decision !== 'channel') return 'cancelled';

  let src = await db.getSources(pid);
  if (!src || !src.libraryId) {
    // v1.0.26: create the sources record instead of giving up. The parent screen has always
    // done this (ensureSources); the share path just returned, so a channel shared before
    // the first sync vanished with no explanation.
    try {
      src = {
        profileId: pid, schema: 1,
        libraryId: 'lib:p:' + pid,
        defaultAutoApprove: false, maxItemsPerChannel: 500, maxItemsTotal: 5000,
        // v1.0.82 — updatedAt 0, NOT Date.now(): this is a PROVISIONAL lib:p: scope, minted
        // when a channel is shared before the profile has a sources record. Minting it with a
        // fresh timestamp let it win the profileSources LWW merge and overwrite the real
        // lib:<hash> mapping in the backup (the v1.0.81 corruption, via a third door). A real
        // mapping always outranks 0. Same rule as ensureSources / doSync.
        drive: (src && src.drive) || { enabled: false }, updatedAt: 0
      };
      await db.putSources(src);
    } catch { return 'no-library'; }
  }
  const lib = src.libraryId;
  if (!lib) return 'no-library';

  try {
    let sourceId = c.playlistId;
    if (!isPlaylist) {
      const yt = await import('./yt.js');
      sourceId = await yt.resolveChannelRef(c.channelRef, await yt.getApiKey());
    }
    if (!sourceId) { try { onAdded({ channelFailed: true }); } catch {} return 'resolve-failed'; }

    await db.putLibraryChannel({
      libraryId: lib, channelId: sourceId, ...(isPlaylist ? { kind: 'playlist' } : {}),
      autoApprove: false, autoApproveSource: 'ui',
      order: Date.now(), addedAt: Date.now(), hidden: false, sourceRow: false,
      titleOverride: c.title || ''
    });
    // No sync here: `onAdded` awaits one behind the loading screen and then raises the
    // approval dialog. Firing one here too would just make the parent wait twice.
    try { await onAdded({ channelAdded: sourceId, title: c.title, isPlaylist }); } catch {}
    return isPlaylist ? 'playlist-added' : 'channel-added';
  } catch {
    return 'failed'; // a failed resolve must not crash the share pipeline — but must SHOW
  }
}
