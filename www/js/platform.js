// platform.js — thin shim over Capacitor plugins with graceful browser fallbacks.
// On device (native) it uses the real plugins (Preferences, CapacitorHttp, Filesystem, App).
// In a plain browser it falls back to localStorage / fetch / no-op so the UI is testable.

function cap() { return (typeof window !== 'undefined') ? window.Capacitor : undefined; }
export const isNative = !!(cap() && cap().isNativePlatform && cap().isNativePlatform());
function plugin(name) { const c = cap(); return c && c.Plugins ? c.Plugins[name] : null; }

/* ---------------- Preferences (persistent key/value) ---------------- */
export async function prefGet(key) {
  const P = plugin('Preferences');
  if (P) { const { value } = await P.get({ key }); return value ?? null; }
  try { return localStorage.getItem(key); } catch { return null; }
}
export async function prefSet(key, value) {
  const P = plugin('Preferences');
  if (P) return P.set({ key, value });
  try { localStorage.setItem(key, value); } catch {}
}
export async function prefRemove(key) {
  const P = plugin('Preferences');
  if (P) return P.remove({ key });
  try { localStorage.removeItem(key); } catch {}
}

/* ---------------- HTTP (native = CORS-exempt) ---------------- */
async function nativeRequest(url, responseType) {
  const CH = plugin('CapacitorHttp');
  const res = await CH.request({ method: 'GET', url, responseType });
  if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
  return res.data;
}
// Browser-only: hosts like Google block cross-origin fetch (CORS). When a direct fetch fails in a
// plain browser, retry through a public CORS proxy so the WEB PREVIEW can load remote lists.
// The installed app NEVER reaches this — it uses native CapacitorHttp above (no CORS).
const CORS_PROXIES = [
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)
];
async function browserFetchText(url) {
  // 1) Direct (works when the host allows CORS, e.g. YouTube oEmbed).
  try { const r = await fetch(url); if (r.ok) return r.text(); } catch {}
  // 2) Same-origin dev proxy from dev-server.mjs — reliable, no CORS, no third party.
  try { const r = await fetch('/__proxy?url=' + encodeURIComponent(url)); if (r.ok) return r.text(); } catch {}
  // 3) Public CORS proxies (last resort, e.g. app served without the dev proxy).
  for (const make of CORS_PROXIES) { try { const r = await fetch(make(url)); if (r.ok) return r.text(); } catch {} }
  throw new Error('fetch-failed: ' + url);
}

/**
 * General HTTP primitive for Drive/Sheets/YouTube API calls.
 * Returns { status, headers, data } and NEVER throws on an HTTP status — callers need
 * the error body (Google APIs put the reason there). Network failure → status 0.
 *
 * ⚠ CapacitorHttp trap (verified in CapacitorHttpUrlConnection.setRequestBody): a
 * request body WITHOUT an explicit Content-Type header is silently discarded — a Drive
 * multipart upload would return 200 and create an EMPTY file. Always pass Content-Type
 * when body != null.
 *
 * v1.0.45 — also returns `url`: the FINAL address after redirects (both transports follow
 * them silently). The approved-websites add flow needs it, because a parent who pastes
 * `example.com/kids/` on a site that redirects to `www.` or to a different path would
 * otherwise save a rule that never matches anything the child can reach.
 */
export async function httpRequest({ method = 'GET', url, headers = {}, body = null, responseType = 'text' } = {}) {
  const CH = plugin('CapacitorHttp');
  if (CH) {
    try {
      const opts = { method, url, headers, responseType };
      if (body != null) opts.data = body;
      const res = await CH.request(opts);
      return { status: res.status || 0, headers: res.headers || {}, data: res.data, url: res.url || url };
    } catch (e) {
      return { status: 0, headers: {}, data: null, url, error: String((e && e.message) || e) };
    }
  }
  try {
    const r = await fetch(url, { method, headers, body: body ?? undefined });
    const data = responseType === 'json' ? await r.json().catch(() => null) : await r.text();
    const h = {};
    r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return { status: r.status, headers: h, data, url: r.url || url };
  } catch (e) {
    return { status: 0, headers: {}, data: null, url, error: String((e && e.message) || e) };
  }
}

/**
 * v1.0.33 — JSON POST (the parent's keyless YouTube search). Returns { status, data }
 * and never throws, the httpRequest contract. The body is stringified HERE and the
 * Content-Type is set HERE, because both halves of the CapacitorHttp trap live at this
 * seam: a body without an explicit Content-Type is silently discarded (see httpRequest's
 * doc), and the repo precedent (drive.js) is pre-stringified strings, never raw objects.
 * Browser preview: a direct fetch will CORS-fail against youtube.com — expected — so the
 * real browser path is the dev proxy's POST passthrough (dev-server.mjs). No public
 * CORS-proxy rung: they don't relay POST reliably, and the installed app is native anyway.
 */
export async function httpPostJson(url, bodyObj) {
  const body = JSON.stringify(bodyObj ?? {});
  const headers = { 'Content-Type': 'application/json' };
  if (plugin('CapacitorHttp')) {
    return httpRequest({ method: 'POST', url, headers, body, responseType: 'json' });
  }
  for (const u of [url, '/__proxy?url=' + encodeURIComponent(url)]) {
    try {
      const r = await fetch(u, { method: 'POST', headers, body });
      if (!r.ok) continue;
      return { status: r.status, data: await r.json().catch(() => null) };
    } catch {}
  }
  return { status: 0, data: null };
}

/**
 * v1.0.32 — small binary GET (channel logos). Returns a Blob or null, never throws.
 * Native: CapacitorHttp answers base64 for responseType 'blob'. Browser preview: direct
 * fetch, then the dev proxy, then the public CORS proxies — same ladder as text.
 */
export async function httpGetBlob(url) {
  const CH = plugin('CapacitorHttp');
  if (CH) {
    try {
      const res = await CH.request({ method: 'GET', url, responseType: 'blob' });
      if (res.status < 200 || res.status >= 300 || typeof res.data !== 'string' || !res.data) return null;
      const bin = atob(res.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = String((res.headers && (res.headers['Content-Type'] || res.headers['content-type'])) || 'image/jpeg');
      return new Blob([bytes], { type: mime.split(';')[0] });
    } catch { return null; }
  }
  for (const u of [url, '/__proxy?url=' + encodeURIComponent(url), ...CORS_PROXIES.map((p) => p(url))]) {
    try { const r = await fetch(u); if (r.ok) return await r.blob(); } catch {}
  }
  return null;
}

export async function httpGetText(url) {
  if (plugin('CapacitorHttp')) {
    const data = await nativeRequest(url, 'text');
    return typeof data === 'string' ? data : JSON.stringify(data);
  }
  return browserFetchText(url);
}
export async function httpGetJson(url) {
  if (plugin('CapacitorHttp')) {
    const data = await nativeRequest(url, 'json');
    return typeof data === 'string' ? JSON.parse(data) : data;
  }
  return JSON.parse(await browserFetchText(url));
}

/* ---------------- Filesystem (download + cache) ---------------- */
const DIRECTORY = 'DATA';
export const fsAvailable = () => !!plugin('Filesystem');

export function convertFileSrc(uri) {
  const c = cap();
  return c && c.convertFileSrc ? c.convertFileSrc(uri) : uri;
}
/**
 * v1.0.18 — mkdir FIRST. `downloadFile` ignores `recursive:true` on Android (see
 * the note under the EXTERNAL helpers below), and nothing ever created DATA/videos,
 * so media.js's whole stream→download→cache fallback threw FileNotFoundException on
 * every device, on every fresh install, for every direct-file video. It survived
 * this long because fsAvailable() is false in the browser preview, where the path
 * is never exercised. Doing it here rather than in media.js also covers clearCache()
 * removing the directory mid-session.
 */
export async function fsMkdir(path) {
  const FS = plugin('Filesystem');
  if (!FS || !path) return;
  try { await FS.mkdir({ path, directory: DIRECTORY, recursive: true }); } catch {} // exists → throws
}
export async function fsDownload(url, path) {
  const FS = plugin('Filesystem');
  const dir = String(path || '').replace(/\/[^/]*$/, '');
  if (dir && dir !== path) await fsMkdir(dir);
  const res = await FS.downloadFile({ url, path, directory: DIRECTORY, recursive: true });
  return res.path || null; // native file URI
}
export async function fsStatUri(path) {
  const FS = plugin('Filesystem');
  if (!FS) return null;
  try { const st = await FS.stat({ path, directory: DIRECTORY }); return st.uri || null; }
  catch { return null; }
}
export async function fsRemoveDir(path) {
  const FS = plugin('Filesystem');
  if (!FS) return;
  try { await FS.rmdir({ path, directory: DIRECTORY, recursive: true }); } catch {}
}

/**
 * v1.0.58 — delete ONE cached media file. Until now the only cleaner was `fsRemoveDir`, an
 * all-or-nothing sweep, so deleting a video from the app left its downloaded copy on the
 * tablet forever (the user's report). Never throws: a file that is already gone is the
 * outcome we wanted anyway.
 */
export async function fsDeleteFile(path) {
  const FS = plugin('Filesystem');
  if (!FS) return false;
  try { await FS.deleteFile({ path, directory: DIRECTORY }); return true; } catch { return false; }
}

/**
 * v1.0.58 — list the cache directory: `[{ name, size, mtime }]`, [] when unreadable.
 *
 * This is what makes an HONEST cache policy possible. The records know which files they
 * asked for, but only the DIRECTORY knows what is actually on disk — and the two drift:
 * a video deleted before v1.0.58 left its file behind, a failed download can leave a
 * partial, and a record can be pruned by the rolling window while its file stays. A sweep
 * that only walked the records would never free any of that.
 */
export async function fsListDir(path) {
  const FS = plugin('Filesystem');
  if (!FS) return [];
  try {
    const res = await FS.readdir({ path, directory: DIRECTORY });
    const files = (res && res.files) || [];
    // Capacitor 5+ answers objects; older builds answered bare name strings.
    return files.map((f) => (typeof f === 'string'
      ? { name: f, size: 0, mtime: 0 }
      : { name: String(f.name || ''), size: Number(f.size) || 0, mtime: Number(f.mtime) || 0 }))
      .filter((f) => f.name);
  } catch { return []; }
}

/* ---------- EXTERNAL dir (updater downloads; survives the unknown-sources detour) ---------- */
// ⚠ Filesystem.downloadFile IGNORES recursive:true on Android (verified in
// @capacitor/filesystem source) — mkdir first or the first download throws
// FileNotFoundException. It DID also affect the videos/ cache in media.js; fixed
// in v1.0.18 by making fsDownload above mkdir its own parent directory.
export async function fsMkdirExternal(path) {
  const FS = plugin('Filesystem');
  if (!FS) return;
  try { await FS.mkdir({ path, directory: 'EXTERNAL', recursive: true }); } catch {}
}
export async function fsStatExternal(path) {
  const FS = plugin('Filesystem');
  if (!FS) return null;
  try { return await FS.stat({ path, directory: 'EXTERNAL' }); } catch { return null; }
}
export async function fsDeleteExternal(path) {
  const FS = plugin('Filesystem');
  if (!FS) return;
  try { await FS.deleteFile({ path, directory: 'EXTERNAL' }); } catch {}
}
/**
 * v1.0.38 — write UTF-8 TEXT into the app's own EXTERNAL dir. platform.js had no
 * text-write helper at all until now (only download/stat/mkdir/delete).
 *
 * DIRECTORY: 'EXTERNAL' = getExternalFilesDir(null) — permission-free, and already the
 * updater's target. NOT 'DOCUMENTS' / 'EXTERNAL_STORAGE': @capacitor/filesystem classifies
 * those as PUBLIC directories and gates them behind a storage permission this app
 * deliberately does not declare (the manifest is exactly INTERNET +
 * REQUEST_INSTALL_PACKAGES). The price is that Android 11+ hides Android/data from the
 * Files app — which is why the caller SHARES the file rather than telling the parent to go
 * find it.
 *
 * mkdir FIRST: downloadFile is documented above as ignoring recursive:true on Android, and
 * betting that writeFile differs is not a bet worth making.
 * ⚠ writeFile answers { uri }, NOT { path } like downloadFile — normalized here to an
 * absolute filesystem path, because the native side does `new File(path)`.
 * -> absolute path | null
 */
export async function fsWriteTextExternal(path, text) {
  const FS = plugin('Filesystem');
  if (!FS || !FS.writeFile) return null;
  const dir = String(path).replace(/\/[^/]*$/, '');
  if (dir && dir !== path) await fsMkdirExternal(dir);
  try {
    const res = await FS.writeFile({
      path, directory: 'EXTERNAL', data: String(text ?? ''), encoding: 'utf8', recursive: true
    });
    const uri = (res && (res.uri || res.path)) || '';
    return uri ? String(uri).replace(/^file:\/\//, '') : null;
  } catch { return null; }
}

/**
 * v1.0.38 — the OS share sheet on a FILE (a links export). shareText cannot do this: it is
 * hard-coded text/plain + EXTRA_TEXT and rejects an empty body, and a 400-link list pasted
 * into a WhatsApp message is not a file the other device can import.
 * -> 'native' | 'none'. Never throws.
 */
export async function shareFile(path, { mimeType = 'text/plain', subject = '' } = {}) {
  const kids = plugin('KidsNative');
  if (!kids || !kids.shareFile || !path) return 'none';
  try { await kids.shareFile({ path, mimeType, subject }); return 'native'; } catch { return 'none'; }
}

/**
 * v1.0.54 — fullscreen video forces LANDSCAPE ('landscape'), leaving restores the
 * system's own rule ('auto'). NATIVE ONLY: the activity-level request is what overrides
 * the SYSTEM rotation lock — the exact reason a phone with auto-rotate off played
 * fullscreen in portrait, which the WebView alone can never fix. In the browser this is
 * a silent no-op (embedded panes deny fullscreen anyway, and screen.orientation.lock()
 * rejects outside it). Never throws — a rotation hiccup must not take the player down.
 */
export async function setOrientation(mode) {
  try {
    const kids = plugin('KidsNative');
    if (kids && kids.setOrientation) await kids.setOrientation({ mode: mode === 'landscape' ? 'landscape' : 'auto' });
  } catch { /* no-op */ }
}

/** Browser-only rung: an <a download> blob click. -> 'download' | 'none' */
export async function downloadTextFile(name, text) {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return 'none';
    const blob = new Blob([String(text ?? '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(name || 'links.txt');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 10000);
    return 'download';
  } catch { return 'none'; }
}

export async function fsDownloadExternal(url, path, onProgress) {
  const FS = plugin('Filesystem');
  if (!FS) throw new Error('no-filesystem');
  let sub = null;
  if (onProgress && FS.addListener) {
    sub = await FS.addListener('progress', (p) => {
      if (p && p.url === url) { try { onProgress(p.bytes, p.contentLength); } catch {} }
    });
  }
  try {
    const res = await FS.downloadFile({ url, path, directory: 'EXTERNAL', progress: !!onProgress });
    return res.path || null; // bare absolute path — hand straight to installApk
  } finally {
    if (sub) try { sub.remove(); } catch {}
  }
}
export function appPlugin() { return plugin('App'); }

/* ---------------- App lifecycle (resume / back / exit) ---------------- */
export function onAppResume(fn) {
  const App = plugin('App');
  if (App && App.addListener) {
    App.addListener('appStateChange', (s) => { if (s && s.isActive) fn(); });
    return;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fn(); });
}

/**
 * v1.0.32 — the other half of the lifecycle, which NOTHING listened to until now.
 * Fires when the activity loses the foreground: the physical screen-off button, HOME,
 * the app switcher. Android does NOT pause the WebView, so a playing video kept its
 * soundtrack running behind a dark screen — the field report this exists for.
 * Browser fallback: hidden visibility (a background tab), for dev-preview testing.
 */
export function onAppPause(fn) {
  const App = plugin('App');
  if (App && App.addListener) {
    App.addListener('appStateChange', (s) => { if (s && !s.isActive) fn(); });
    return;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) fn(); });
}

/**
 * Android hardware back. NOTE: registering this listener disables Capacitor's default
 * back handling entirely — the handler MUST consume every case (nav.handleBack does).
 * Browser fallback: Escape key, for dev-preview testing.
 */
export function onBackButton(fn) {
  const App = plugin('App');
  if (App && App.addListener) {
    App.addListener('backButton', () => fn());
    return;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fn(); });
}

/**
 * Share plain text via the OS share sheet (v1.0.5). Fallback chain: native chooser →
 * Web Share API → clipboard. Returns how it was delivered ('native' | 'web' |
 * 'clipboard' | 'none') so the caller can phrase its confirmation message.
 * A Web-Share cancel still returns 'web' — the user SAW the sheet; falling through
 * to the clipboard after an intentional cancel would be wrong.
 */
export async function shareText(text, subject = '') {
  const kids = plugin('KidsNative');
  if (kids && kids.shareText) {
    try { await kids.shareText({ text, subject }); return 'native'; } catch {}
  }
  if (typeof navigator !== 'undefined' && navigator.share) {
    try { await navigator.share({ text }); } catch { /* user cancelled */ }
    return 'web';
  }
  try { await navigator.clipboard.writeText(text); return 'clipboard'; } catch {}
  return 'none';
}

/**
 * Android TV / Google TV detection (v1.0.9) — drives the 10-foot layout and the
 * D-pad focus mode. Cached (the mode can't change mid-session). Browser preview:
 * `localStorage['tv'] = '1'` forces TV mode for keyboard-arrow testing.
 */
let tvCached = null;
export async function isTv() {
  if (tvCached !== null) return tvCached;
  try { if (localStorage.getItem('tv') === '1') { tvCached = true; return true; } } catch {}
  const kids = plugin('KidsNative');
  if (kids && kids.isTv) {
    try { tvCached = (await kids.isTv()).value === true; return tvCached; } catch {}
  }
  tvCached = false;
  return tvCached;
}

/**
 * v1.0.57 — the device's audio mode, as one lower-case word, for "was this video
 * interrupted by a CALL?" (the user's decision: calls only, never every backgrounding).
 *
 * NEVER THROWS AND NEVER GUESSES 'normal'. An app built before the native method existed,
 * a browser, a device that refuses the getter — all answer 'unknown', and the pure decision
 * treats unknown as "no evidence of a call", so the worst case is the pre-v1.0.57 behaviour
 * (the child taps play). Answering 'normal' instead would make an unrelated pause look like
 * a call that just ended, and the video would start itself in a quiet room.
 */
/**
 * v1.0.63 — the foreground service that lets the family's OWN media keep playing when the
 * app goes to the background. Bridge-gated and NEVER throwing: in a browser and on any APK
 * built before the native side existed these are silent no-ops, and the video simply pauses
 * on background exactly as it did before the feature.
 *
 * ⚠️ `start` MUST be called while the app is still FOREGROUND — since API 31 a backgrounded
 * app may not start a foreground service at all. It is called when an eligible video begins
 * playing, not when the screen goes off.
 */
/**
 * v1.0.64 — ask for the notification permission, and report the honest answer.
 *
 * ⚠️ v1.0.63 declared POST_NOTIFICATIONS and never REQUESTED it. On Android 13+ that is a
 * runtime permission denied by default, so the service started, the audio kept playing, and
 * the control was suppressed on every device — the failure a parent reported as "השיר המשיך
 * אבל לא הופיע כפתור". A manifest entry only makes a permission requestable.
 *
 * An absent bridge answers TRUE: on an older APK and in the browser there is nothing to ask
 * for, and answering "denied" would put a false warning in front of a parent.
 */
export async function ensureNotificationPermission() {
  const kids = plugin('KidsNative');
  if (!kids || !kids.ensureNotificationPermission) return true;
  try {
    const r = await kids.ensureNotificationPermission();
    return !(r && r.granted === false);
  } catch { return true; }
}

export async function startBackgroundPlayback(title, playing, meta = null) {
  const kids = plugin('KidsNative');
  if (!kids || !kids.startBackgroundPlayback) return false;
  const m = meta || {};
  const ms = (v) => Math.max(0, Math.round(Number(v) * 1000) || 0);
  try {
    await kids.startBackgroundPlayback({
      title: String(title || ''), playing: playing !== false,
      // v1.0.65 — the folder name and the playhead. The system EXTRAPOLATES the position
      // from the speed it is given, so a car's progress bar advances without us ticking.
      subtitle: String(m.subtitle || ''), artB64: String(m.artB64 || ''),
      posMs: ms(m.posSec), durMs: ms(m.durSec)
    });
    return true;
  } catch { return false; }
}

export async function stopBackgroundPlayback() {
  const kids = plugin('KidsNative');
  if (!kids || !kids.stopBackgroundPlayback) return false;
  try { await kids.stopBackgroundPlayback(); return true; } catch { return false; }
}

/** A ⏮/⏯/⏭ tap on the notification. Retained natively, so a frozen WebView loses nothing. */
export function onPlaybackCommand(fn) {
  const kids = plugin('KidsNative');
  if (!kids || !kids.addListener) return;
  try {
    kids.addListener('playbackCommand', (o) => {
      const a = o && typeof o.action === 'string' ? o.action : '';
      if (a) { try { fn(a); } catch {} }
    });
  } catch {}
}

/* ---------------- picture-in-picture (v1.0.76) ----------------
 * HOME shrinks a playing video into Android's own PiP window (user request, opt-in per
 * profile). JS PUSHES the eligibility ahead of time (`setPipState`) because the native
 * `onUserLeaveHint` is synchronous and cannot ask the bridge; the native side caches it —
 * the same shape as the v1.0.63 `bgPlayEnabled` cache, one layer down. Browser dev:
 * unsupported, and every wrapper is a silent no-op. */

/** Can this device do PiP at all? (API 26+, has the system feature, and not a TV.) */
export async function pipSupported() {
  const kids = plugin('KidsNative');
  if (!kids || !kids.pipSupported) return false;
  try {
    const r = await kids.pipSupported();
    return !!(r && r.value);
  } catch { return false; }
}

/** Push the cached PiP decision + the real play state (drives the window's ⏯ icon). */
export async function setPipState({ eligible = false, playing = false } = {}) {
  const kids = plugin('KidsNative');
  if (!kids || !kids.setPipState) return;
  try { await kids.setPipState({ eligible: !!eligible, playing: !!playing }); } catch {}
}

/** Entering/leaving the PiP window. Fires BEFORE the matching appStateChange (Android
 *  calls onPictureInPictureModeChanged before onPause on entry — device-verified), which
 *  is what lets the app's own screen-off pause know this pause is not a backgrounding. */
export function onPipChanged(fn) {
  const kids = plugin('KidsNative');
  if (!kids || !kids.addListener) return;
  try { kids.addListener('pipChanged', (o) => { try { fn(!!(o && o.active)); } catch {} }); } catch {}
}

/** The PiP window is no longer visible: dismissed with its X, or the screen went off.
 *  Either way the video must bank its spot and fall silent unless bgPlay says otherwise —
 *  no appStateChange fires here (the activity already paused when PiP began). */
export function onPipHidden(fn) {
  const kids = plugin('KidsNative');
  if (!kids || !kids.addListener) return;
  try { kids.addListener('pipHidden', (o) => { try { fn(!!(o && o.dismissed)); } catch {} }); } catch {}
}

export async function audioMode() {
  const kids = plugin('KidsNative');
  if (!kids || !kids.audioMode) return 'unknown';
  try {
    const r = await kids.audioMode();
    return (r && typeof r.value === 'string') ? r.value : 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Open an https link OUTSIDE the app (v1.0.14) — the WebView blocks external
 * navigation/popups by design, so parent-facing links need the native intent.
 * Returns true when something actually opened.
 */
export async function openExternal(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  const kids = plugin('KidsNative');
  if (kids && kids.openUrl) {
    try { await kids.openUrl({ url }); return true; } catch { return false; }
  }
  try { return !!window.open(url, '_blank', 'noopener'); } catch { return false; }
}

/* ---------------- the restricted site viewer (v1.0.45) ----------------
 * A NATIVE WebView laid over the bridge, because nothing else can enforce where the child
 * may go: an <iframe> cannot be navigation-controlled from the parent document (same-origin
 * policy) and half the web refuses to frame at all (X-Frame-Options), while Custom Tabs is
 * a real browser with no hooks. `shouldOverrideUrlLoading` in KidsWebPlugin is the only
 * enforcement point, so the whole feature is device-only by construction.
 *
 * The rules handed over are ALREADY canonical (weblock.canonicalSitePrefix); the native
 * side does a dumb comparison of pre-normalized parts and never re-parses a prefix.
 */
export function siteViewerAvailable() {
  return !!plugin('KidsWeb');
}

/** Opens the viewer. Resolves as soon as it is up — closing arrives via onSiteEvent. */
export async function openSiteViewer({ url, rules = [], title = '', parentMode = false, locked = false }) {
  const kw = plugin('KidsWeb');
  if (!kw || !kw.open) return false;
  try {
    // v1.0.67 — `locked` turns the bar's back button into a padlock and stops hardware back
    // from closing the viewer. It contains the CHILD only: the app's own close (screen time,
    // a profile switch, the release flow) is a different native path and always works.
    await kw.open({ url, rules, title, parentMode: !!parentMode, locked: !!locked });
    return true;
  } catch { return false; }
}

export async function closeSiteViewer() {
  const kw = plugin('KidsWeb');
  if (kw && kw.close) { try { await kw.close(); } catch {} }
}

export async function isSiteViewerOpen() {
  const kw = plugin('KidsWeb');
  if (kw && kw.isOpen) {
    // `=== true` on purpose (the canDeviceAuth rule): a missing or throwing bridge must
    // never read as "open", or the screen-time timers would wait on a viewer that is gone.
    try { return (await kw.isOpen()).value === true; } catch {}
  }
  return false;
}

/** Sign out of one site: its cookies and its DOM storage. Parent-facing. */
export async function clearSiteData(host) {
  const kw = plugin('KidsWeb');
  if (kw && kw.clearSiteData) { try { await kw.clearSiteData({ host }); return true; } catch {} }
  return false;
}

/**
 * Subscribe to the viewer's events: 'webClosed', 'webBlocked' ({url}),
 * 'webAddRequest' ({url}) and 'webActivity'. A no-op without the plugin.
 */
export function onSiteEvent(name, fn) {
  const kw = plugin('KidsWeb');
  if (kw && kw.addListener) { try { kw.addListener(name, fn); } catch {} }
}

/* ---------------- exit lock / screen pinning (v1.0.11) ---------------- */
// Kiosk mode: HOME cannot be intercepted by apps — OS lock-task is the mechanism.
// All three are graceful no-ops in the browser preview / without the plugin.
export async function lockTask() {
  const kids = plugin('KidsNative');
  if (kids && kids.lockTask) { try { await kids.lockTask(); return true; } catch {} }
  return false;
}
export async function unlockTask() {
  const kids = plugin('KidsNative');
  if (kids && kids.unlockTask) { try { await kids.unlockTask(); } catch {} }
}
export async function isTaskLocked() {
  const kids = plugin('KidsNative');
  if (kids && kids.isTaskLocked) {
    try { return (await kids.isTaskLocked()).value === true; } catch {}
  }
  return false;
}

/* ---------------- device credential (v1.0.26, parent-code recovery) ---------------- */
// The FAST path for a parent who forgot the app's code: fingerprint, or the device's own
// lock PIN. BOTH of these fail CLOSED and SILENT — in the browser preview, on an APK built
// before the plugin method existed, or on a device with no lock screen, they simply report
// "not available" and the 24-hour wait in recovery.js carries the whole feature. A thrown
// error here must never read as a successful authentication, and must never remove the
// only other way back in.

/** Can this device prove an adult is present? -> boolean. Never throws. */
export async function canDeviceAuth() {
  const kids = plugin('KidsNative');
  if (!kids || !kids.canDeviceAuth) return false;
  try { return (await kids.canDeviceAuth()).available === true; } catch { return false; }
}

/**
 * Show the prompt. -> boolean, and ONLY an explicit `ok === true` counts.
 * A cancel, a lockout, a missing plugin and a thrown bridge error are all just `false`.
 */
export async function deviceAuth(title, subtitle = '') {
  const kids = plugin('KidsNative');
  if (!kids || !kids.deviceAuth) return false;
  try { return (await kids.deviceAuth({ title, subtitle })).ok === true; } catch { return false; }
}

export function exitApp() {
  // Prefer the native KidsNative.exitApp: App.exitApp() only calls finish(), which on
  // real devices leaves the task in recents — "exit" looked like minimize (v1.0.4 fix).
  // finishAndRemoveTask() + delayed process kill actually closes the app.
  const kids = plugin('KidsNative');
  if (kids && kids.exitApp) { Promise.resolve(kids.exitApp()).catch(() => {}); return; }
  const App = plugin('App');
  if (App && App.exitApp) { App.exitApp(); return; }
  try { window.close(); } catch {}
}
