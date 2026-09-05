// weblock.js — THE SAFETY BOUNDARY for the approved-websites feature (v1.0.45), the
// sibling of classify.js. Every URL the child's in-app browser may load passes through
// here; anything not explicitly permitted is refused.
//
// PURE (imports only util.fnv1a) and regex-based — no `new URL`, no DOM — so it runs
// under `node --test` and cannot be defeated by a host environment's URL quirks.
//
// ── Why this file exists rather than a `startsWith` somewhere in app.js ──────────────
// A naive prefix test is not a safety boundary. Each rule below closes a specific hole:
//
//   'https://example.com/kids/'.startsWith  ALLOWS  https://example.com/kids-adult/
//   'https://good.com'.startsWith           ALLOWS  https://good.com.evil.com/
//                                           ALLOWS  https://good.com@evil.com/   (userinfo)
//   a path with %2e%2e climbs OUT of the allowed section once the WebView decodes it.
//
// So: the origin is compared EXACTLY, the path is compared BY SEGMENT, and every segment
// is decoded before comparison — because Android's `Uri.getPathSegments()` decodes on its
// own, and if the two sides disagree about decoding they disagree about safety.
//
// ── The two-language problem ─────────────────────────────────────────────────────────
// Enforcement happens in Java (KidsWebPlugin), which the node suite cannot execute. The
// split is deliberate: THIS file does all the normalization and hands the native side an
// already-canonical {host, port, segments} rule, leaving Java a dumb comparison of
// pre-normalized parts. The hard part stays here, where it is tested.

import { fnv1a } from './util.js';

/** Percent-decode one path segment. Malformed input is a REFUSAL, never a pass-through. */
function decodeSegment(raw) {
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return null; // '%zz' and friends — fail closed
  }
}

/**
 * Split a URL into { scheme, authority, path } without `new URL`. Returns null when the
 * shape is not an absolute http(s)-looking URL at all.
 */
function splitUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i);
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), authority: m[2], path: m[3] || '' };
}

/**
 * Canonical host+port out of an authority, or null when the authority is unusable.
 *
 * `www.` is stripped on BOTH sides of every comparison (the parent's decision): a parent
 * who pastes `example.com/kids/` must not be defeated by the site's own redirect to
 * `www.example.com/kids/`. No OTHER subdomain is folded — on many sites a subdomain is
 * user-generated content or a forum.
 */
function canonAuthority(authority) {
  const a = String(authority ?? '');
  // userinfo is the classic prefix-defeating trick: https://good.com@evil.com/
  if (a.includes('@')) return null;
  const m = a.match(/^([^:]*)(?::(\d+))?$/);
  if (!m) return null;
  let host = m[1].toLowerCase().replace(/\.+$/, ''); // trailing dot is the same host
  if (!host || host.includes('/')) return null;
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host) return null;
  const port = m[2] ? Number(m[2]) : 443;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Path → decoded segments, or null when any segment is unusable.
 * `.` and `..` are refused AFTER decoding, which is what catches `%2e%2e`.
 */
function canonSegments(path) {
  const out = [];
  for (const raw of String(path ?? '').split('/')) {
    if (!raw) continue; // leading/trailing/double slashes carry no meaning
    const seg = decodeSegment(raw);
    if (seg === null) return null;
    if (seg === '.' || seg === '..') return null;
    out.push(seg);
  }
  return out;
}

/** Rebuild the human-readable canonical prefix. This string IS the rule's identity. */
function displayOf(host, port, segments) {
  const p = port === 443 ? '' : ':' + port;
  const tail = segments.length ? '/' + segments.join('/') + '/' : '/';
  return 'https://' + host + p + tail;
}

/**
 * Normalize a parent-supplied address into a rule. Returns
 *   { ok: true, scheme, host, port, segments, display }
 * or { ok: false, reason } where reason is one of:
 *   'empty' | 'shape' | 'scheme' | 'host' | 'path'
 *
 * https ONLY. http on a child's tablet is both a mixed-content problem inside the
 * app's https origin and an unauthenticated wire someone on the café Wi-Fi can rewrite.
 */
export function canonicalSitePrefix(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  // A bare "example.com/kids" is what a parent actually types; assume https rather than
  // refusing. We never assume http.
  const hasProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hasProto) {
    // "scheme:rest" without slashes is a FOREIGN scheme (javascript:, mailto:, data:).
    // Refuse it as a scheme problem instead of mangling it into a bogus host — but
    // "example.com:8443/kids" is a host:port a parent may legitimately type, so a
    // digits-only tail is not a scheme.
    const m = s.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
    if (m && !/^\d+(?:[/?#]|$)/.test(m[2])) return { ok: false, reason: 'scheme' };
  }
  const withScheme = hasProto ? s : 'https://' + s;
  const parts = splitUrl(withScheme);
  if (!parts) return { ok: false, reason: 'shape' };
  if (parts.scheme !== 'https') return { ok: false, reason: 'scheme' };
  const auth = canonAuthority(parts.authority);
  if (!auth) return { ok: false, reason: 'host' };
  // A host with no dot is not a public site (localhost, an intranet name, a typo).
  if (!auth.host.includes('.')) return { ok: false, reason: 'host' };
  const segments = canonSegments(parts.path);
  if (segments === null) return { ok: false, reason: 'path' };
  return {
    ok: true,
    scheme: 'https',
    host: auth.host,
    port: auth.port,
    segments,
    display: displayOf(auth.host, auth.port, segments)
  };
}

/** One rule vs one already-split URL. Both sides are canonical by construction. */
function ruleCovers(rule, target) {
  if (!rule || !target) return false;
  const host = String(rule.host ?? '').toLowerCase();
  if (!host || host !== target.host) return false;
  const port = Number(rule.port) || 443;
  if (port !== target.port) return false;
  const segs = Array.isArray(rule.segments) ? rule.segments : [];
  if (segs.length > target.segments.length) return false;
  for (let i = 0; i < segs.length; i++) {
    if (String(segs[i]) !== target.segments[i]) return false;
  }
  return true;
}

/**
 * Split a live URL (from a navigation, not from a parent) the same way a rule is split.
 * Query and fragment are dropped: they are not part of the identity of a page, and
 * comparing them would block `?page=2` on an allowed section.
 */
function targetOf(url) {
  const parts = splitUrl(url);
  if (!parts || parts.scheme !== 'https') return null;
  const auth = canonAuthority(parts.authority);
  if (!auth) return null;
  const segments = canonSegments(parts.path);
  if (segments === null) return null;
  return { host: auth.host, port: auth.port, segments };
}

/**
 * Which rule governs this URL — null when none does.
 *
 * The LONGEST matching rule wins, so a narrow rule's `allowExternal` is what applies on
 * its own pages even when a broader rule also covers them. Without that, adding
 * "the whole site" later would silently loosen a section the parent had deliberately
 * kept strict.
 */
export function matchRule(rules, url) {
  const t = targetOf(url);
  if (!t) return null;
  let best = null;
  for (const r of rules || []) {
    if (!ruleCovers(r, t)) continue;
    const len = Array.isArray(r.segments) ? r.segments.length : 0;
    if (!best || len > best.len) best = { rule: r, len };
  }
  return best ? best.rule : null;
}

/**
 * v1.0.67 — PURE: the rules that remain in force while the child is LOCKED INTO ONE SITE
 * (user decision 2026-08-31: "רק באתר הנוכחי").
 *
 * This is a NARROWING and can only ever remove reach: it keeps the rule that covers the
 * locked page — the longest match, the same one `matchRule` would pick — plus any rule for
 * the SAME host, so a site whose approved sections are separate rules still works end to
 * end. Everything else falls away, which is what stops an approved link from carrying the
 * child out of the site the parent locked them into.
 *
 * An unmatched url yields `[]`, and an empty rule list is a viewer that can navigate
 * NOWHERE — the strict direction, and the caller must therefore refuse to engage a lock it
 * cannot describe rather than open a browser that blocks its own page.
 */
export function rulesForLockedSite(rules, url) {
  const here = matchRule(rules, url);
  if (!here) return [];
  const host = here.host;
  return (rules || []).filter((r) => r && r.host === host);
}

/**
 * v1.0.76 — PURE: the rules in force while the child is LOCKED ONTO ONE PAGE and its
 * sub-pages (user request: "לנעול דף ספציפי … הילד יוכל לגלוש בכל הכתובות עם התחילית").
 *
 * The narrower sibling of `rulesForLockedSite`. Where that keeps the whole HOST, this keeps
 * exactly ONE synthetic rule: the locked page's full path, so the child may navigate only to
 * that prefix and deeper (`/abc/1/efg` → `/abc/1/efg/…`) and nowhere else on the site.
 *
 * ⚠️ IT CAN ONLY EVER NARROW, never grant. `here` is the rule that already governs the
 * locked page (matchRule), and matchRule guarantees `here.segments` is a PREFIX of the
 * page's segments — so the synthetic rule (the page's full segments) is equal-or-deeper,
 * i.e. a subset of what the child could already reach. It inherits `here.allowExternal` for
 * the same reason `rulesForLockedSite` keeps it: a site that renders broken without its
 * third-party embeds must keep working.
 *
 * Comparison stays BY SEGMENT (the whole weblock doctrine): `/abc/1/efg` never admits
 * `/abc/1/efgX`. An unmatched url yields `[]` — a viewer that can navigate nowhere, so the
 * caller refuses to engage a lock it cannot describe (the strict direction, exactly as
 * `rulesForLockedSite`).
 */
export function rulesForLockedPage(rules, url) {
  const here = matchRule(rules, url);
  if (!here) return [];
  const canon = canonicalSitePrefix(url);
  if (!canon.ok) return [];
  return [{
    host: canon.host, port: canon.port, segments: canon.segments,
    allowExternal: !!here.allowExternal
  }];
}

/** May the child NAVIGATE here? Any rule is enough. */
export function navAllowed(rules, url) {
  return matchRule(rules, url) !== null;
}

/**
 * May the page load this SUBRESOURCE (image, script, iframe, xhr)?
 *
 * The prefix rule governs navigation only. Everything a page EMBEDS — ad inventory,
 * trackers, third-party players — arrives without the child ever tapping a link, so an
 * app that curates videos one at a time cannot leave that door open by default.
 *
 * Strict mode allows the current page's own host (and its subdomains, which is where a
 * site's CDN and image server usually live) plus any approved rule's host, so one
 * approved site may legitimately embed another's images. `data:` is inline bytes with no
 * network behind it.
 *
 * A rule with allowExternal turned on relaxes this for the pages IT governs — the parent
 * flipped it after seeing the site render broken, and the warning says what it costs.
 */
export function subresourceAllowed(rules, pageUrl, resUrl) {
  const res = String(resUrl ?? '').trim();
  if (!res) return false;
  if (/^data:/i.test(res)) return true;
  // about:blank / blob: are the WebView's own internals, never network fetches.
  if (/^(about|blob):/i.test(res)) return true;

  const governing = matchRule(rules, pageUrl);
  if (governing && governing.allowExternal) return true;

  const t = targetOf(res);
  if (!t) return false; // non-https subresource: refused like every other non-https URL

  const hosts = [];
  const page = targetOf(pageUrl);
  if (page) hosts.push(page.host);
  for (const r of rules || []) {
    const h = String((r && r.host) ?? '').toLowerCase();
    if (h) hosts.push(h);
  }
  return hosts.some((h) => t.host === h || t.host.endsWith('.' + h));
}

/**
 * The three rules a parent may choose from when approving a page that was just blocked.
 * Returned widest-first; `defaultIndex` points at the middle one — a whole site is more
 * than they were asked about, and a single page means the next link is blocked again.
 * Fewer than three when the URL has no path to narrow.
 */
export function ruleCandidatesFor(url) {
  const canon = canonicalSitePrefix(url);
  if (!canon.ok) return { ok: false, reason: canon.reason, options: [], defaultIndex: 0 };
  const { host, port, segments } = canon;
  const mk = (segs, label) => {
    const c = { ok: true, scheme: 'https', host, port, segments: segs, display: displayOf(host, port, segs) };
    return { label, canon: c };
  };
  const options = [mk([], 'whole-site')];
  if (segments.length > 1) options.push(mk(segments.slice(0, -1), 'section'));
  if (segments.length > 0) options.push(mk(segments, 'page'));
  // Widest-first, so the LAST option is always the narrowest. Prefer the middle when
  // there is one; otherwise the narrowest available.
  return { ok: true, options, defaultIndex: options.length > 2 ? 1 : options.length - 1 };
}

/** Stable ids. A rule is identified by what it permits; a shortcut by where it opens. */
export function ruleIdFor(canon) {
  return canon && canon.ok ? 'rl:' + fnv1a(canon.display) : null;
}

export function shortcutIdFor(url) {
  const s = String(url ?? '').trim();
  if (!canonicalSitePrefix(s).ok) return null;
  // The full URL — query included — is the shortcut's identity, unlike a rule's, because
  // two landing pages on one site may differ only by a query parameter.
  return 'sc:' + fnv1a(s.toLowerCase());
}

/**
 * Absolute icon URL out of a page, or '' when the page names none.
 *
 * ANCHORED patterns only, in descending order of trust — the yt.extractChannelIdFromHtml
 * doctrine. There is no "first .png on the page" fallback: a missing icon degrades to the
 * 🌐 emoji, which is fine, while a wrong one silently mislabels a site in a grid a
 * pre-reading child navigates by picture.
 */
export function extractSiteIconFromHtml(html, baseUrl) {
  const s = String(html ?? '');
  const pick = (re) => {
    const m = s.match(re);
    return m && m[1] ? m[1].trim() : '';
  };
  const href = pick(/<link[^>]+rel=["'](?:apple-touch-icon(?:-precomposed)?)["'][^>]*href=["']([^"']+)["']/i)
    || pick(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:apple-touch-icon(?:-precomposed)?)["']/i)
    || pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || pick(/<link[^>]+rel=["'](?:shortcut icon|icon)["'][^>]*href=["']([^"']+)["']/i)
    || pick(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut icon|icon)["']/i);

  const base = splitUrl(baseUrl);
  if (!href) {
    // Every site serves /favicon.ico or 404s harmlessly; the caller treats a failed
    // fetch as "no icon".
    return base ? base.scheme + '://' + base.authority + '/favicon.ico' : '';
  }
  const clean = href.replace(/&amp;/g, '&');
  if (/^https:\/\//i.test(clean)) return clean;
  if (/^\/\//.test(clean)) return 'https:' + clean;
  if (!base) return '';
  if (clean.startsWith('/')) return base.scheme + '://' + base.authority + clean;
  const dir = base.path.replace(/[^/]*$/, '');
  return base.scheme + '://' + base.authority + (dir.startsWith('/') ? dir : '/' + dir) + clean;
}
