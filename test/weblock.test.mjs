// weblock.test.mjs — the approved-websites SAFETY BOUNDARY (v1.0.45).
//
// Most of these are adversarial on purpose. This module decides what a 5-year-old's
// browser may load, and every "clever" URL below defeats a naive `startsWith`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalSitePrefix, navAllowed, matchRule, subresourceAllowed,
  ruleCandidatesFor, ruleIdFor, shortcutIdFor, extractSiteIconFromHtml,
  rulesForLockedSite, rulesForLockedPage
} from '../www/js/weblock.js';

const ruleFor = (s, extra = {}) => {
  const c = canonicalSitePrefix(s);
  assert.ok(c.ok, `fixture ${s} should normalize`);
  return { host: c.host, port: c.port, segments: c.segments, display: c.display, ...extra };
};

// ── canonicalSitePrefix ────────────────────────────────────────────────────────────

test('canonicalSitePrefix: normalizes the forms a parent actually types', () => {
  const want = 'https://example.com/kids/';
  for (const input of [
    'https://example.com/kids/',
    'https://www.example.com/kids/',
    'HTTPS://WWW.EXAMPLE.COM/kids/',
    'example.com/kids',            // no scheme — assume https, never http
    '  https://example.com/kids  ',
    'https://example.com./kids/',  // trailing dot is the same host
    'https://example.com:443/kids/',
    'https://example.com//kids//',
    'https://example.com/kids/?utm=1#top'
  ]) {
    const c = canonicalSitePrefix(input);
    assert.ok(c.ok, `${input} should normalize`);
    assert.equal(c.display, want, `${input} normalized to ${c.display}`);
  }
});

test('canonicalSitePrefix: refuses everything that is not a plain https site', () => {
  const cases = {
    '': 'empty',
    '   ': 'empty',
    'http://example.com/kids/': 'scheme',
    'ftp://example.com/': 'scheme',
    // The escape hatches a WebView would otherwise honour by launching another app:
    'intent://example.com/#Intent;scheme=https;end': 'scheme',
    'javascript:alert(1)': 'scheme',
    'mailto:someone@example.com': 'scheme',
    'file:///sdcard/': 'scheme',
    'data:text/html,<h1>hi': 'scheme',
    // userinfo — 'https://good.com'.startsWith() says yes, and the browser goes to evil:
    'https://example.com@evil.com/': 'host',
    'https://user:pw@evil.com/': 'host',
    'https://localhost/kids/': 'host',
    'https:///kids/': 'host',
    'https://example.com/a/../../etc/': 'path',
    'https://example.com/a/%2e%2e/etc/': 'path',
    'https://example.com/a/%zz/': 'path'
  };
  for (const [input, reason] of Object.entries(cases)) {
    const c = canonicalSitePrefix(input);
    assert.equal(c.ok, false, `${input} must be refused`);
    assert.equal(c.reason, reason, `${input} refused for the wrong reason`);
  }
});

test('canonicalSitePrefix: a non-default port is a different site', () => {
  const a = canonicalSitePrefix('https://example.com:8443/kids/');
  assert.equal(a.display, 'https://example.com:8443/kids/');
  assert.notEqual(a.display, canonicalSitePrefix('https://example.com/kids/').display);
});

// ── navAllowed / matchRule ─────────────────────────────────────────────────────────

test('navAllowed: the path is compared BY SEGMENT, not as a string', () => {
  const rules = [ruleFor('https://example.com/kids/')];

  for (const ok of [
    'https://example.com/kids/',
    'https://example.com/kids',
    'https://example.com/kids/story/1',
    'https://example.com/kids/?page=2',
    'https://example.com/kids/a#frag',
    'https://www.example.com/kids/song'   // www is folded on both sides
  ]) assert.equal(navAllowed(rules, ok), true, `${ok} should be allowed`);

  // THE bug this whole module exists to prevent: a raw startsWith allows all of these.
  for (const no of [
    'https://example.com/kids-adult/',
    'https://example.com/kidsroom/',
    'https://example.com/kids2',
    'https://example.com/other/',
    'https://example.com/',
    'https://evil.com/kids/',
    'https://example.com.evil.com/kids/',   // suffix trick
    'https://evil.example.com/kids/',       // a non-www subdomain is NOT the site
    'https://example.com@evil.com/kids/',   // userinfo trick
    'http://example.com/kids/',             // downgrade
    'https://example.com:8443/kids/'        // port
  ]) assert.equal(navAllowed(rules, no), false, `${no} must be blocked`);
});

test('navAllowed: %2e%2e cannot climb out of the allowed section', () => {
  const rules = [ruleFor('https://example.com/kids/')];
  for (const no of [
    'https://example.com/kids/%2e%2e/adult/',
    'https://example.com/kids/../adult/',
    'https://example.com/kids/%2E%2E/adult'
  ]) assert.equal(navAllowed(rules, no), false, `${no} must be blocked`);
});

test('navAllowed: any ONE rule of many is enough — approved sites may link to each other', () => {
  const rules = [
    ruleFor('https://example.com/kids/'),
    ruleFor('https://other.org/'),
    ruleFor('https://third.net/a/b/')
  ];
  assert.equal(navAllowed(rules, 'https://other.org/anything/here'), true);
  assert.equal(navAllowed(rules, 'https://third.net/a/b/c'), true);
  assert.equal(navAllowed(rules, 'https://third.net/a/'), false, 'a narrower rule must not widen');
  assert.equal(navAllowed(rules, 'https://nobody.com/'), false);
  assert.equal(navAllowed([], 'https://example.com/kids/'), false, 'no rules = nothing allowed');
  assert.equal(navAllowed(null, 'https://example.com/kids/'), false);
});

test('matchRule: the LONGEST rule governs, so a broad rule cannot loosen a strict section', () => {
  const broad = ruleFor('https://example.com/', { allowExternal: true, display: 'broad' });
  const narrow = ruleFor('https://example.com/kids/', { allowExternal: false, display: 'narrow' });
  const rules = [broad, narrow];
  assert.equal(matchRule(rules, 'https://example.com/kids/x').display, 'narrow');
  assert.equal(matchRule(rules, 'https://example.com/news').display, 'broad');
  assert.equal(matchRule(rules, 'https://elsewhere.com/'), null);
  // Order must not matter.
  assert.equal(matchRule([narrow, broad], 'https://example.com/kids/x').display, 'narrow');
});

test('navAllowed: garbage input is refused, never thrown on', () => {
  const rules = [ruleFor('https://example.com/kids/')];
  for (const junk of [null, undefined, '', '   ', 'not a url', 42, {}, [], '//example.com/kids/']) {
    assert.equal(navAllowed(rules, junk), false, `${String(junk)} must be blocked`);
  }
  assert.equal(navAllowed([null, undefined, {}], 'https://example.com/kids/'), false);
});

// ── subresourceAllowed ─────────────────────────────────────────────────────────────

test('subresourceAllowed: strict mode keeps ad and tracker hosts out of an approved page', () => {
  const rules = [ruleFor('https://example.com/kids/')];
  const page = 'https://example.com/kids/story';

  assert.equal(subresourceAllowed(rules, page, 'https://example.com/img/a.png'), true);
  assert.equal(subresourceAllowed(rules, page, 'https://cdn.example.com/a.png'), true,
    'a subdomain of the page host is where a site keeps its own assets');
  assert.equal(subresourceAllowed(rules, page, 'data:image/png;base64,AAA'), true);

  assert.equal(subresourceAllowed(rules, page, 'https://doubleclick.net/ad.js'), false);
  assert.equal(subresourceAllowed(rules, page, 'https://www.youtube.com/embed/x'), false);
  assert.equal(subresourceAllowed(rules, page, 'http://example.com/a.png'), false);
  assert.equal(subresourceAllowed(rules, page, 'https://example.com.evil.com/a.png'), false);
});

test('subresourceAllowed: another approved site may supply an image', () => {
  const rules = [ruleFor('https://example.com/kids/'), ruleFor('https://other.org/')];
  assert.equal(subresourceAllowed(rules, 'https://example.com/kids/x', 'https://other.org/i.png'), true);
});

test('subresourceAllowed: allowExternal opens only the pages its own rule governs', () => {
  const rules = [
    ruleFor('https://example.com/kids/', { allowExternal: true }),
    ruleFor('https://strict.com/', { allowExternal: false })
  ];
  assert.equal(subresourceAllowed(rules, 'https://example.com/kids/x', 'https://ads.net/a.js'), true);
  assert.equal(subresourceAllowed(rules, 'https://strict.com/x', 'https://ads.net/a.js'), false,
    'the other site must stay strict');
});

// ── ruleCandidatesFor ──────────────────────────────────────────────────────────────

test('ruleCandidatesFor: offers whole-site / section / page, defaulting to the section', () => {
  const r = ruleCandidatesFor('https://example.com/a/b/c?x=1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.options.map((o) => o.label), ['whole-site', 'section', 'page']);
  assert.deepEqual(r.options.map((o) => o.canon.display), [
    'https://example.com/',
    'https://example.com/a/b/',
    'https://example.com/a/b/c/'
  ]);
  assert.equal(r.defaultIndex, 1, 'the default must be the section — not the whole site');
});

test('ruleCandidatesFor: degrades sensibly when there is little path to narrow', () => {
  const one = ruleCandidatesFor('https://example.com/kids');
  assert.deepEqual(one.options.map((o) => o.label), ['whole-site', 'page']);
  assert.equal(one.options[one.defaultIndex].label, 'page', 'never default to the whole site');

  const bare = ruleCandidatesFor('https://example.com/');
  assert.deepEqual(bare.options.map((o) => o.label), ['whole-site']);
  assert.equal(bare.defaultIndex, 0);

  assert.equal(ruleCandidatesFor('http://example.com/').ok, false);
});

test('ruleCandidatesFor: every option it offers is actually enforceable', () => {
  const url = 'https://example.com/a/b/c';
  for (const opt of ruleCandidatesFor(url).options) {
    const rule = { host: opt.canon.host, port: opt.canon.port, segments: opt.canon.segments };
    assert.equal(navAllowed([rule], url), true, `${opt.label} should permit the URL it was built from`);
  }
});

// ── ids ────────────────────────────────────────────────────────────────────────────

test('ids are stable, scoped by kind, and null for junk', () => {
  const a = ruleIdFor(canonicalSitePrefix('https://example.com/kids/'));
  const b = ruleIdFor(canonicalSitePrefix('https://www.example.com/kids'));
  assert.equal(a, b, 'the same rule in two spellings must be ONE row');
  assert.match(a, /^rl:[0-9a-f]{8}$/);

  assert.match(shortcutIdFor('https://example.com/kids/'), /^sc:[0-9a-f]{8}$/);
  assert.notEqual(
    shortcutIdFor('https://example.com/p?a=1'),
    shortcutIdFor('https://example.com/p?a=2'),
    'two landing pages differing only by query are two shortcuts'
  );
  assert.equal(shortcutIdFor('http://example.com/'), null);
  assert.equal(shortcutIdFor(''), null);
  assert.equal(ruleIdFor(canonicalSitePrefix('nonsense://x')), null);
  assert.equal(ruleIdFor(null), null);
});

// ── extractSiteIconFromHtml ────────────────────────────────────────────────────────

test('extractSiteIconFromHtml: anchored tags, in trust order, resolved to absolute', () => {
  const base = 'https://example.com/kids/index.html';
  const apple = '<link rel="apple-touch-icon" href="/icons/touch.png">';
  const og = '<meta property="og:image" content="https://cdn.example.com/og.png">';
  const icon = "<link rel='icon' href='fav.png'>";

  assert.equal(extractSiteIconFromHtml(apple + og + icon, base), 'https://example.com/icons/touch.png');
  assert.equal(extractSiteIconFromHtml(og + icon, base), 'https://cdn.example.com/og.png');
  assert.equal(extractSiteIconFromHtml(icon, base), 'https://example.com/kids/fav.png',
    'a relative href resolves against the page directory');
  assert.equal(
    extractSiteIconFromHtml('<link rel="icon" href="//cdn.example.com/f.ico">', base),
    'https://cdn.example.com/f.ico'
  );
  assert.equal(
    extractSiteIconFromHtml('<link href="/a.png" rel="apple-touch-icon">', base),
    'https://example.com/a.png',
    'attribute order must not matter'
  );
  assert.equal(
    extractSiteIconFromHtml('<link rel="icon" href="/i.png?v=1&amp;s=2">', base),
    'https://example.com/i.png?v=1&s=2'
  );
});

test('extractSiteIconFromHtml: no anchored tag falls back to /favicon.ico, and never guesses', () => {
  const base = 'https://example.com/kids/';
  assert.equal(extractSiteIconFromHtml('<img src="/logo.png">', base), 'https://example.com/favicon.ico',
    'a bare <img> is NOT the site icon — a wrong picture mislabels the tile');
  assert.equal(extractSiteIconFromHtml('', base), 'https://example.com/favicon.ico');
  assert.equal(extractSiteIconFromHtml(null, base), 'https://example.com/favicon.ico');
  assert.equal(extractSiteIconFromHtml('<link rel="icon" href="x">', ''), '');
});

test('extractSiteIconFromHtml: truncated or hostile HTML returns a string, never throws', () => {
  const base = 'https://example.com/';
  for (const junk of [null, undefined, 42, {}, [], '<link rel="icon" href=', '<'.repeat(5000)]) {
    assert.equal(typeof extractSiteIconFromHtml(junk, base), 'string');
  }
});

// ── the shapes this app actually meets ─────────────────────────────────────────────

test('a Hebrew path matches whether it arrives encoded or decoded', () => {
  // Not hypothetical: Hebrew sites routinely use Hebrew paths, and a parent pastes the
  // form their browser showed them while the WebView navigates the other form. If the
  // two did not compare equal the site would open and then block its own links.
  const decoded = 'https://site.co.il/ילדים/';
  const encoded = 'https://site.co.il/%D7%99%D7%9C%D7%93%D7%99%D7%9D/';
  const a = canonicalSitePrefix(decoded);
  const b = canonicalSitePrefix(encoded);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.segments, b.segments, 'the two spellings must canonicalize alike');
  assert.equal(ruleIdFor(a), ruleIdFor(b), 'and must therefore be ONE stored rule');

  const rules = [ruleFor(encoded)];
  assert.equal(navAllowed(rules, decoded), true);
  assert.equal(navAllowed(rules, encoded + 'abc'), true);
  assert.equal(navAllowed(rules, 'https://site.co.il/מבוגרים/'), false,
    'a different Hebrew section must still be blocked');
});

test('a malformed rule row can neither throw nor match everything', () => {
  // Rows arrive from a peer's document and from an imported snapshot, so a missing or
  // junk field is reachable. Failing OPEN here would hand over the whole web.
  const good = ruleFor('https://example.com/kids/');
  for (const bad of [
    {}, { host: '' }, { host: 'example.com', segments: null },
    { host: 'example.com', segments: 'kids' }, { host: 'example.com', port: 'x', segments: [] },
    null, undefined, 'nonsense', 42
  ]) {
    const only = navAllowed([bad], 'https://example.com/kids/x');
    assert.equal(typeof only, 'boolean', `rule ${JSON.stringify(bad)} must not throw`);
    assert.notEqual(only && bad && bad.host === '', true);
  }
  // a junk row beside a real one must not disturb it
  assert.equal(navAllowed([null, good, {}], 'https://example.com/kids/x'), true);
  assert.equal(navAllowed([null, good, {}], 'https://elsewhere.com/'), false);
  // a rule with NO segments is the whole site — that is legitimate, and only for ITS host
  const whole = ruleFor('https://example.com/');
  assert.equal(navAllowed([whole], 'https://example.com/anything/deep'), true);
  assert.equal(navAllowed([whole], 'https://other.com/'), false);
});

test('an unusual but legal address survives normalization', () => {
  const cases = [
    ['https://EXAMPLE.com/Kids/', 'https://example.com/Kids/'],   // host folds, PATH DOES NOT
    ['https://example.com/a b/', 'https://example.com/a b/'],      // a space, already decoded
    ['https://example.com/%D7%90/', 'https://example.com/א/']
  ];
  for (const [input, display] of cases) {
    const c = canonicalSitePrefix(input);
    assert.ok(c.ok, `${input} should normalize`);
    assert.equal(c.display, display);
  }
  // Path case is significant on most servers, so folding it would silently widen a rule.
  assert.equal(navAllowed([ruleFor('https://example.com/Kids/')], 'https://example.com/kids/'), false,
    'the path must stay case-SENSITIVE — folding it widens the rule');
});

// ── rulesForLockedPage (v1.0.76, feature 4) ─────────────────────────────────────────

test('rulesForLockedPage: narrows to the page prefix and its sub-pages, never the whole site', () => {
  // the parent has approved the whole site; a page lock must hold the child on ONE prefix
  const rules = [ruleFor('https://page.com/')];
  const locked = rulesForLockedPage(rules, 'https://page.com/abc/1/efg');
  assert.equal(locked.length, 1, 'a page lock is exactly one synthetic prefix rule');

  // the child may browse the prefix and DEEPER…
  assert.equal(navAllowed(locked, 'https://page.com/abc/1/efg'), true, 'the locked page itself');
  assert.equal(navAllowed(locked, 'https://page.com/abc/1/efg/x/y'), true, 'a sub-page');
  assert.equal(navAllowed(locked, 'https://page.com/abc/1/efg/?q=2'), true, 'a query is dropped from the prefix');
  // …but NOWHERE else on the site (the whole point of a page lock vs a site lock)
  assert.equal(navAllowed(locked, 'https://page.com/abc/1'), false, 'a shallower path is out');
  assert.equal(navAllowed(locked, 'https://page.com/other'), false, 'a sibling section is out');
  assert.equal(navAllowed(locked, 'https://page.com/'), false, 'the site root is out');
  // segment-boundary safety (the whole weblock doctrine): efg never admits efgX
  assert.equal(navAllowed(locked, 'https://page.com/abc/1/efgX'), false, 'efg must not admit efgX');

  // contrast: rulesForLockedSite on the SAME page keeps the whole host
  const site = rulesForLockedSite(rules, 'https://page.com/abc/1/efg');
  assert.equal(navAllowed(site, 'https://page.com/other'), true, 'a site lock keeps the whole host');
});

test('rulesForLockedPage: can only NARROW — it never grants beyond the governing rule', () => {
  // the approved rule is a SECTION, and the locked page is deeper inside it
  const rules = [ruleFor('https://page.com/abc/')];
  const locked = rulesForLockedPage(rules, 'https://page.com/abc/1/efg');
  // deeper is fine…
  assert.equal(navAllowed(locked, 'https://page.com/abc/1/efg/z'), true);
  // …and it is a SUBSET of the section: what the section allowed but the prefix doesn't, is gone
  assert.equal(navAllowed(locked, 'https://page.com/abc/other'), false,
    'the page lock is narrower than the section it sits in');
  // an unmatched page (no governing rule) yields [] — the caller must refuse to engage
  assert.deepEqual(rulesForLockedPage(rules, 'https://elsewhere.com/x'), [],
    'a page with no governing rule cannot be locked (fail strict)');
  assert.deepEqual(rulesForLockedPage([], 'https://page.com/abc/1'), []);
});

test('rulesForLockedPage: inherits allowExternal from the governing rule', () => {
  const rules = [ruleFor('https://page.com/', { allowExternal: true })];
  const locked = rulesForLockedPage(rules, 'https://page.com/abc/1');
  assert.equal(locked[0].allowExternal, true, 'a site that needs its embeds must keep working when page-locked');
  const strict = rulesForLockedPage([ruleFor('https://page.com/')], 'https://page.com/abc/1');
  assert.equal(strict[0].allowExternal, false);
});
