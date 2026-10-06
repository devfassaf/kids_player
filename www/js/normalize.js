// normalize.js — Hebrew-aware title normalization + duplicate-merge policy (F8).
// Pure, node-tested. Title dedupe applies ONLY within the same channel/folder —
// two channels legitimately both have a "פרק 1".

/**
 * Normalize a title for comparison. The Hebrew-specific steps are the point:
 *  - NFKC folds presentation forms (U+FB1D–FB4F) from web copy-paste;
 *  - bidi controls (LRM/RLM/…): Google Sheets inserts them into mixed RTL/LTR
 *    cells — a real, non-obvious duplicate cause;
 *  - niqqud/te'amim stripped: "שָׁלוֹם" must equal "שלום";
 *  - emoji stripped; punctuation/symbols → space; whitespace collapsed.
 * Episode markers ("חלק 2", "#3") are deliberately KEPT — those are real differences.
 * An empty result must never dedupe (guarded by callers via findByNormTitle).
 */
export function normalizeTitle(s) {
  let t = String(s ?? '');
  try { t = t.normalize('NFKC'); } catch {}
  t = t.replace(/[‎‏‪-‮⁦-⁩؜]/g, ''); // bidi controls
  t = t.replace(/[​-‍﻿­]/g, '');                    // zero-width/joiners
  t = t.replace(/[֑-ׇ]/g, '');                                // niqqud + te'amim
  t = t.replace(/\p{Extended_Pictographic}/gu, '');                     // emoji
  t = t.replace(/[︎️\u{1F3FB}-\u{1F3FF}⃣]/gu, '');       // VS / skin tones / keycap
  t = t.toLocaleLowerCase();
  t = t.replace(/[\p{P}\p{S}]+/gu, ' ');                                // punctuation/symbols
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

const TITLE_SOURCE_RANK = { api: 4, rss: 3, sheet: 2, oembed: 1, legacy: 1 };

/**
 * v1.0.23 — the PARKING SLOTS. A record the child must not see is moved OUT of its real
 * folder into one of these, because `by_folder_sort` carries no state component: state
 * alone would not hide it. `homeFolderId` remembers where it belongs.
 *
 * `'~rejected'` is the new one, and it exists because "rejected" stopped meaning "gone".
 * Until now a rejection was `deleteVideo` — the record was ERASED and a deny-list
 * tombstone made it unrevivable (the only undeny path is a sheet re-add, and a video
 * inside a channel has no sheet row at all, so there was no way back, ever). The parent
 * asked for a rejected list they can pull things back out of, so the record now SURVIVES,
 * parked here, invisible to the child. Emptying that list is what finally tombstones it.
 */
export const PARKED = { pending: '~pending', rejected: '~rejected' };
const PARKED_FOLDERS = new Set(Object.values(PARKED));
export const isParkedFolder = (folderId) => PARKED_FOLDERS.has(folderId);

/**
 * v1.0.23 — PURE: which curation decision survives when two copies of one video meet?
 *
 * Adding a third state made the old two-line rule inside `mergeVideoRecord` insufficient.
 * The rule that matters: **a rejection is a parental decision exactly like an approval, so
 * the LATER decision wins** — otherwise the sync, or a peer that never heard about the
 * rejection, quietly shows the child something the parent threw out. Ties resolve to
 * `'rejected'`: of the two ways to be wrong, hiding a video the parent wanted is a
 * complaint, and showing one they rejected is a betrayal.
 *
 * `pending` is not a decision at all, so it never beats one.
 * -> { state, decidedAt } — decidedAt is null for pending
 */
export function resolveCuration(a, b) {
  const at = (r) => (r && (r.state === 'rejected' ? r.rejectedAt : r.state === 'live' ? r.approvedAt : 0)) || 0;
  const decided = (r) => !!r && (r.state === 'rejected' || r.state === 'live');
  if (!decided(a) && !decided(b)) return { state: 'pending', decidedAt: null };
  if (!decided(a)) return { state: b.state, decidedAt: at(b) || null };
  if (!decided(b)) return { state: a.state, decidedAt: at(a) || null };
  if (a.state === b.state) return { state: a.state, decidedAt: Math.max(at(a), at(b)) || null };
  const ta = at(a);
  const tb = at(b);
  if (ta !== tb) {
    const win = ta > tb ? a : b;
    return { state: win.state, decidedAt: at(win) || null };
  }
  return { state: 'rejected', decidedAt: ta || null }; // tie → the safe direction
}

/**
 * Which of two records representing the SAME video survives, and what it absorbs.
 * Survivor: prefer real bytes on disk (localPath), then the older addedAt.
 * The loser's key goes into survivor.mergedFrom — NOT the deny-list (that would
 * block a legitimate future re-add).
 */
export function mergeVideoRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  let s = a, l = b;
  if (!!b.localPath !== !!a.localPath) { s = b.localPath ? b : a; l = s === a ? b : a; }
  else if ((b.addedAt || Infinity) < (a.addedAt || Infinity)) { s = b; l = a; }

  const out = { ...s };
  out.addedAt = Math.min(a.addedAt || Infinity, b.addedAt || Infinity);
  if (out.addedAt === Infinity) out.addedAt = Date.now();
  out.localPath = s.localPath || l.localPath || null;
  // v1.0.23 — curation is decided by resolveCuration, not by "a live loser promotes a
  // pending survivor". That old rule had no answer for 'rejected' and would have let any
  // stale 'live' copy revive a video the parent threw out.
  const cur = resolveCuration(a, b);
  out.state = cur.state;
  if (cur.state === 'live') { out.approvedAt = cur.decidedAt; out.rejectedAt = null; }
  else if (cur.state === 'rejected') { out.rejectedAt = cur.decidedAt; out.approvedAt = null; }
  else { out.approvedAt = null; out.rejectedAt = null; }
  const rs = TITLE_SOURCE_RANK[s.titleSource] || 0;
  const rl = TITLE_SOURCE_RANK[l.titleSource] || 0;
  if ((rl > rs && l.title) || (!out.title && l.title) ||
      (rl === rs && l.title && (l.title.length > (out.title || '').length))) {
    out.title = l.title;
    out.titleSource = l.titleSource;
  }
  out.normTitle = normalizeTitle(out.title);
  out.thumbId = s.thumbId || l.thumbId || null;
  out.thumbUrl = s.thumbUrl || l.thumbUrl || null;
  // v1.0.56 — `media` ('audio'|'video') survives whichever copy wins: a peer on an older
  // app carries none, and `out = {...s}` would strip the enrichment on every merge (the
  // keepForever lesson). `||` keeps it commutative for the Drive doc.
  out.media = s.media || l.media || null;
  // v1.0.39 — `keepForever` is GROW-ONLY, like unwrappedAt is min-merged forever: the
  // parent marked this video as one the rolling window may never delete. `out = {...s}`
  // alone would lose it whenever the OTHER copy wins (a peer whose `addedAt` is older
  // becomes the survivor, and the fresh sync candidate carries no flag at all), and the
  // failure mode is a protected favourite quietly becoming deletable on the next sync.
  // OR is also commutative, so the Drive merge stays order-free.
  if (s.keepForever || l.keepForever) out.keepForever = true;
  const merged = new Set([...(s.mergedFrom || []), ...(l.mergedFrom || [])]);
  if (l.key !== out.key) merged.add(l.key);
  out.mergedFrom = [...merged];
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0) || Date.now();
  return out;
}

/**
 * v1.0.94 — PURE: the folder a record LIVES in. A parked record (pending / rejected) keeps
 * its real folder in `homeFolderId` while `folderId` holds the parking slot, so "where is
 * it" is a two-field answer and every placement rule must ask it the same way.
 */
export function homeOf(rec) {
  if (!rec) return null;
  return (isParkedFolder(rec.folderId) ? rec.homeFolderId : rec.folderId) || null;
}

/**
 * v1.0.94 — PURE: two copies of one record disagree about WHICH FOLDER it lives in. The
 * LATER DELIBERATE PLACEMENT wins, and the evidence is `placedAt`.
 *
 * WHY THIS EXISTS. `mergeVideoRecord` takes every field — the folder included — from the
 * copy it calls the survivor: the one with a downloaded file, else the OLDER one, and a tie
 * keeps the first argument (the LOCAL copy, on a pull). So a placement made on one device
 * never reached another: a parent's move kept its addedAt and lost the tie everywhere else,
 * and a folder deleted with "move its videos" sent its TOMBSTONE to the peers while their
 * copies stayed filed under a folder that no longer existed — invisible on every screen.
 * That was latent only because folder rows never travelled at all (the v1.0.94 root cause);
 * fixing the rows without this would have turned every folder deletion into exactly the bug
 * the family reported.
 *
 * Deliberately NARROW: when NEITHER copy was ever deliberately placed (no `placedAt` — every
 * channel video, every record written before this release) the result is untouched, so the
 * sync's own placements (ch:/pl:, the unify rule) keep their old, tested convergence.
 * ⚠️ A copy WITHOUT the stamp competes as ZERO — it was never deliberately placed, so it can
 * never beat one that was, whatever its age. (The first version let it compete with its
 * `addedAt`, "created later = placed later" — and the review found the hole: a channel sync
 * on another device importing the same video LATER beat the parent's own move and pulled it
 * out of their folder on every device.) The winning stamp is kept on the result, because
 * the next merge has nothing else to judge by. An exact tie keeps the survivor's folder —
 * the old behaviour. Parking is preserved: a parked result moves only its `homeFolderId`.
 * Mutates and returns `out`.
 */
export function settlePlacement(a, b, out) {
  if (!a || !b || !out) return out;
  const pa = Number(a.placedAt) || 0;
  const pb = Number(b.placedAt) || 0;
  if (!pa && !pb) return out;
  out.placedAt = Math.max(pa, pb);
  const ha = homeOf(a);
  const hb = homeOf(b);
  if (!ha || !hb || ha === hb || pa === pb) return out;
  return Object.assign(out, placeInto(out, pb > pa ? hb : ha, out.placedAt));
}

/**
 * v1.0.94 — PURE: the fields that put `rec` into folder `folderId`, stamped `placedAt: at`.
 * THE one statement of the parking rule for a move: a parked record (pending / rejected)
 * keeps its parking slot and changes only its `homeFolderId` — moving `folderId` would show
 * the child a video nobody approved, or bring back one the parent rejected — while a live
 * record moves its `folderId`, and its `homeFolderId` too when it carries one (an approved
 * record remembers where it was parked for). Every placement in the app goes through here:
 * a parent's move, deleting a folder and keeping its videos, the orphan repair, the Drive
 * re-file, and the cross-device merge above — four hand-written copies of this rule were
 * one drift away from parking a video in the child's view.
 */
export function placeInto(rec, folderId, at) {
  if (rec && isParkedFolder(rec.folderId)) return { homeFolderId: folderId, placedAt: at };
  return { folderId, ...(rec && rec.homeFolderId ? { homeFolderId: folderId } : {}), placedAt: at };
}

/** v1.0.94 — two copies of one record, as the Drive document and a pull merge them: the
 *  record merge, then the placement rule above. ONE function for both, so the document a
 *  device writes and the library it applies can never disagree about a folder. */
export function mergeVideoCopies(a, b) {
  return settlePlacement(a, b, mergeVideoRecord(a, b));
}

/**
 * v1.0.22 — make a merged record's curation SELF-CONSISTENT. Two shapes are illegal and
 * BOTH were reachable, because `mergeVideoRecord` above flips `state` (a live loser
 * promotes a pending survivor) and never touches `folderId`:
 *  - pending but not parked: `by_folder_sort` carries no state component, so an
 *    unapproved record left in a real folder is visible to the CHILD.
 *  - live but still parked in '~pending': invisible in the child's folder AND absent from
 *    the approval queue — a record that exists and can never be reached.
 * Lives here, next to the merge it repairs, because BOTH callers of that merge need it:
 * `plan.planMutations` (the sync's title-twin and prior branches) and
 * `drive.applyRemoteDoc` (a peer's approval arriving over the Drive doc).
 */
export function settleCuration(rec, fallbackFolderId, now = Date.now()) {
  if (rec.state === 'pending' || rec.state === 'rejected') {
    // Parked: remember the real home BEFORE overwriting folderId, or restoring later has
    // nowhere to put it back (and `fallbackFolderId` is only a guess).
    rec.homeFolderId = rec.homeFolderId
      || (isParkedFolder(rec.folderId) ? null : rec.folderId)
      || fallbackFolderId;
    rec.folderId = PARKED[rec.state];
    if (rec.state === 'rejected' && !rec.rejectedAt) rec.rejectedAt = now;
  } else {
    if (isParkedFolder(rec.folderId)) rec.folderId = rec.homeFolderId || fallbackFolderId;
    if (!rec.approvedAt) rec.approvedAt = now; // it becomes live HERE — say when
    rec.rejectedAt = null;
  }
  return rec;
}

/**
 * v1.0.57 — PURE: has this `profileVideoState` row got anything left worth keeping?
 *
 * The store is ONE row per (child, video) shared by four unrelated features — the gift
 * rank, the unwrap stamp, the resume position, the ⭐, and now the watch stamp — so
 * "clear my field" and "delete the row" are different acts, and only this predicate may
 * decide the second one.
 *
 * ⚠️ IT EXISTS BECAUSE THE INLINE VERSION SILENTLY ATE STARS. `db.clearPlayPosition`
 * (which runs on every video that plays to the END while resume is on) deleted the row
 * whenever it carried no `giftRank` and no `unwrappedAt` — a check written in v1.0.32,
 * before ⭐ existed, and never revisited when v1.0.40 added `favAt`/`favOffAt` to the same
 * row. So a video the child starred, that was never a gift, watched to the end, lost its
 * star: it vanished from ⭐ with nothing to explain it, and `favOffAt` was not written
 * either, so a peer's copy could later re-star it. Found while adding `playedAt`, which
 * would have been the next field to disappear the same way.
 *
 * Every field the row can carry is named here ON PURPOSE: the next feature to share this
 * row must add its field to this list, and a test pins the list against the writers.
 */
export function stateRowIsSpent(rec) {
  if (!rec) return true;
  return rec.giftRank === undefined
    && !rec.unwrappedAt
    && !rec.favAt && !rec.favOffAt
    && !rec.playedAt
    && rec.posSec === undefined;
}
