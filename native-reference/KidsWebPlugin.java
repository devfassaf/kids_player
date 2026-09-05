package com.assaf.kidsplayer;

// KidsWebPlugin (v1.0.45) — the RESTRICTED SITE VIEWER.
//
// A native WebView laid over the bridge, used to show a child a website the parent
// approved. It exists because nothing else can enforce where the child may go:
//   • an <iframe> cannot be navigation-controlled from the parent document (same-origin
//     policy) and a large share of the web refuses to be framed at all (X-Frame-Options),
//   • Chrome Custom Tabs is a real browser with no hooks whatsoever.
// `shouldOverrideUrlLoading` below is the ONLY enforcement point in the whole feature.
//
// WHERE THE RULES COME FROM: already canonical, from JS (weblock.canonicalSitePrefix) —
// host lower-cased with a leading `www.` stripped, port defaulted to 443, path split into
// DECODED segments. This file must not re-parse or re-normalize a prefix; the hard part
// lives in one tested place, and a second implementation here would drift from it. All
// that happens here is a comparison of pre-normalized parts, plus the same decode-then-
// refuse rule for `.`/`..` (Uri.getPathSegments decodes on its own, so `%2e%2e` arrives
// as `..` and must be refused at that point or it climbs out of the allowed section).
//
// A VIEW, NOT AN ACTIVITY: added to the decor view of MainActivity. A second activity
// would fight lock-task (the kiosk exit lock) and would need its own immersive handling;
// this way both come for free.

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.util.TypedValue;
import android.view.ActionMode;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@CapacitorPlugin(name = "KidsWeb")
public class KidsWebPlugin extends Plugin {

    /** One approved prefix, already canonical. Never built from a raw string here. */
    private static class Rule {
        String host = "";
        int port = 443;
        final List<String> segments = new ArrayList<>();
        boolean allowExternal = false;
    }

    private static KidsWebPlugin instance;

    private FrameLayout overlay;
    private WebView web;
    private TextView titleView;
    // v1.0.76 — the browser's own back/forward buttons (user request). Fields, not locals,
    // because their enabled state is refreshed from the history hooks below; nulled in
    // forceClose alongside titleView.
    private Button navBack;
    private Button navFwd;
    /**
     * ⚠️ THESE THREE ARE READ FROM A BACKGROUND THREAD.
     *
     * `shouldInterceptRequest` is documented to run OFF the UI thread — it is called once
     * per subresource, from the WebView's own worker. Everything it touches must therefore
     * be safe to read there:
     *
     *  • `rules` is REPLACED wholesale, never mutated in place. `clear()` + `addAll()`
     *    would let the worker observe an empty (or half-filled) list mid-swap and refuse
     *    resources the parent had approved.
     *  • `currentPageUrl` exists because `web.getUrl()` MAY NOT be called off the UI
     *    thread. Doing so throws "A WebView method was called on thread
     *    'WebViewCoreThread'" and KILLS the app — and because the fatal exception
     *    surfaces from inside the WebView implementation, Android blames the WebView
     *    package and offers to uninstall its updates. Field-reported on a real phone:
     *    parent mode was fine (it returns before this code) and child mode crashed on
     *    the first page. Written on the UI thread only, in onPageStarted /
     *    doUpdateVisitedHistory / open().
     */
    private volatile List<Rule> rules = new ArrayList<>();
    private volatile String currentPageUrl = "";
    private volatile boolean parentMode = false;
    // v1.0.67 — the child is LOCKED INSIDE this site (user request). It changes exactly two
    // things natively: the bar's back button becomes a padlock that asks JS for the parent
    // code, and hardware back stops falling through to a close once the site's own history
    // is exhausted. It does NOT change what may be navigated — JS narrows the RULES it
    // hands over, so the safety boundary keeps one implementation.
    private volatile boolean childLocked = false;
    /** The column holding the bar + the page; hidden while a video is fullscreen. */
    private LinearLayout chromeCol;
    private View customView;                                  // the fullscreen video surface
    private WebChromeClient.CustomViewCallback customCallback;
    private final android.os.Handler fsHandler =
        new android.os.Handler(android.os.Looper.getMainLooper());
    private long lastActivityPing = 0L;
    private long pausedAt = 0L;
    /** How long parent mode may sit backgrounded before it is abandoned rather than paused. */
    private static final long PARENT_MODE_GRACE_MS = 60_000L;
    /** The page the child was refused, so the parent's approval knows what it is approving. */
    private String lastBlockedUrl = "";

    @Override
    public void load() { instance = this; }

    /* ---------------- lifecycle hooks called by MainActivity ---------------- */

    /** Hardware back: walk the site's own history first, then close. */
    static boolean handleBack() {
        if (instance == null || instance.overlay == null) return false;
        // A fullscreen video is what back means FIRST — leaving the page from under a
        // fullscreen surface strands the child on a black screen.
        if (instance.customView != null) { instance.exitFullscreen(); return true; }
        if (instance.web != null && instance.web.canGoBack()) { instance.web.goBack(); return true; }
        // v1.0.67 — under a site lock the history running out is NOT a way out. Back is
        // swallowed (returning true keeps it from reaching nav.handleBack), exactly as the
        // folder lock swallows it one layer up.
        if (instance.childLocked) { instance.notifyListeners("webLockRequest", new JSObject()); return true; }
        instance.forceClose();
        return true;
    }

    /**
     * v1.0.32 replayed: Android does NOT pause a WebView when the activity leaves the
     * foreground, so a site playing audio kept its soundtrack running behind a dark
     * screen — the exact field report the player fix exists for. pauseTimers() also stops
     * JS timers and animation, which is what makes the pause real rather than cosmetic.
     * The cookie flush is here too: without it a login the parent typed is lost whenever
     * the process is killed, and "enter the password once" quietly becomes "every time".
     */
    static void onActivityPause() {
        if (instance == null || instance.web == null) return;
        instance.pausedAt = System.currentTimeMillis();
        instance.web.onPause();
        instance.web.pauseTimers();
        flushCookies();
    }

    /**
     * PARENT MODE DOES NOT SURVIVE AN ABSENCE. It navigates without restriction, so a
     * tablet put down mid-login and picked up by the child would be a free browser.
     *
     * Closing on pause would be wrong: the commonest thing a parent does mid-login is hop
     * to a password manager, which is a few seconds. So the session is abandoned on RESUME
     * after a grace period — long enough for that hop, far shorter than "left on the
     * sofa". Child mode is untouched; there is nothing to protect it from.
     */
    static void onActivityResume() {
        if (instance == null || instance.web == null) return;
        if (instance.parentMode && instance.pausedAt > 0
                && System.currentTimeMillis() - instance.pausedAt > PARENT_MODE_GRACE_MS) {
            instance.closeOverlay();
            return;
        }
        instance.web.resumeTimers();
        instance.web.onResume();
    }

    private static void flushCookies() {
        try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
    }

    /* ---------------- plugin API ---------------- */

    @PluginMethod
    public void open(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("no-activity"); return; }
        final String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("bad-url"); return; }
        final boolean parent = Boolean.TRUE.equals(call.getBoolean("parentMode", false));
        final boolean locked = Boolean.TRUE.equals(call.getBoolean("locked", false));
        final String title = call.getString("title", "");
        final List<Rule> parsed = readRules(call.getArray("rules"));

        a.runOnUiThread(() -> {
            try {
                // The bar's colour and label are the only signal that navigation is
                // unrestricted. They are decided when the overlay is BUILT, so a reopen
                // that changes the mode must rebuild — otherwise parent mode can wear the
                // child's colours and the one visual cue about it is a lie.
                // The bar is rebuilt when the MODE changes, and a lock changes the bar's
                // button from "go back" to a padlock — so it must force a rebuild too, or
                // a locked session would keep a live way out drawn on screen.
                if (overlay != null && (parentMode != parent || childLocked != locked)) forceClose();
                childLocked = locked;
                rules = parsed;              // replace, never mutate (see the field's note)
                currentPageUrl = url;        // before the first subresource can be requested
                parentMode = parent;
                if (overlay == null) buildOverlay(a);
                if (titleView != null) titleView.setText(title == null || title.isEmpty() ? hostOf(url) : title);
                web.loadUrl(url);
                overlay.setVisibility(View.VISIBLE);
                call.resolve();
            } catch (Exception e) {
                call.reject("open-failed: " + e.getMessage());
            }
        });
    }

    /**
     * The APP asking to close — screen time, a profile switch, the release flow. This must
     * ALWAYS work: v1.0.45 closes the viewer before the break screen, and its own comment
     * calls that "the one wiring step that decides whether the browser respects screen time
     * at all". A site lock holds the CHILD in, never the app.
     */
    @PluginMethod
    public void close(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("no-activity"); return; }
        a.runOnUiThread(() -> { forceClose(); call.resolve(); });
    }

    @PluginMethod
    public void isOpen(PluginCall call) {
        JSObject o = new JSObject();
        o.put("value", overlay != null && overlay.getVisibility() == View.VISIBLE);
        call.resolve(o);
    }

    /**
     * Sign out of ONE site. Android's CookieManager has no per-host removal, so the
     * cookies are expired by name against that host — which is what a real sign-out does
     * — and the shared DOM/Web storage is cleared alongside. Resolves either way: failing
     * to find a cookie is an ordinary outcome, not an error (the canDeviceAuth rule).
     */
    @PluginMethod
    public void clearSiteData(PluginCall call) {
        final String host = call.getString("host");
        Activity a = getActivity();
        if (a == null || host == null || host.isEmpty()) { call.resolve(); return; }
        a.runOnUiThread(() -> {
            try {
                CookieManager cm = CookieManager.getInstance();
                for (String base : new String[] { "https://" + host, "https://." + host, "https://www." + host }) {
                    String raw = cm.getCookie(base);
                    if (raw == null) continue;
                    for (String pair : raw.split(";")) {
                        String name = pair.split("=")[0].trim();
                        if (name.isEmpty()) continue;
                        cm.setCookie(base, name + "=; Max-Age=0; Path=/");
                    }
                }
                cm.flush();
                WebStorage.getInstance().deleteAllData();
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    /* ---------------- the overlay ---------------- */

    @SuppressLint("SetJavaScriptEnabled")
    private void buildOverlay(Activity a) {
        overlay = new FrameLayout(a);
        overlay.setBackgroundColor(Color.WHITE);
        // Consume touches so nothing reaches the app's own WebView underneath.
        overlay.setClickable(true);

        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        chromeCol = col;

        LinearLayout bar = new LinearLayout(a);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        // parent mode is deliberately UNMISTAKABLE: it navigates without restriction, and
        // nobody should be in any doubt about which mode the tablet is in.
        bar.setBackgroundColor(parentMode ? Color.parseColor("#8a6d00") : Color.parseColor("#6c63ff"));
        int pad = dp(a, 10);
        // The app runs edge-to-edge in immersive mode, so the bar pads itself down past a
        // transiently-revealed status bar instead of hiding under it.
        bar.setPadding(pad, pad + statusBarInset(a), pad, pad);

        // THE WAY OUT, drawn for a pre-reading child: a bright pill that contrasts with
        // the bar instead of flat text on it, a big bold label, and 🏠 — the SAME sign the
        // app already uses for "back to where you belong" on the watch screen and in the
        // websites grid. A door (🚪) was rejected: in this app it means leaving the APP
        // entirely, and teaching one child two meanings for one picture is how a 5-year-old
        // learns to ignore both.
        Button back = new Button(a);
        back.setText("🏠  חזרה");
        back.setAllCaps(false);
        back.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        back.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f);
        back.setTextColor(parentMode ? Color.parseColor("#6b5200") : Color.parseColor("#4b41d6"));
        android.graphics.drawable.GradientDrawable pill = new android.graphics.drawable.GradientDrawable();
        pill.setColor(Color.WHITE);
        pill.setCornerRadius(dp(a, 22));
        back.setBackground(pill);
        back.setPadding(dp(a, 18), dp(a, 6), dp(a, 18), dp(a, 6));
        back.setMinimumHeight(dp(a, 48));   // a child's finger, not a cursor
        back.setElevation(dp(a, 2));
        back.setOnClickListener(v -> closeOverlay());
        // ⚠️ HIDDEN, NOT ABSENT, WHILE LOCKED: it is the child's way out, and a lock that
        // leaves it on screen is a lock with a visible door. closeOverlay() refuses anyway —
        // hiding is the affordance, the refusal is the boundary.
        back.setVisibility(childLocked ? View.GONE : View.VISIBLE);
        bar.addView(back);

        // v1.0.70 — THE PADLOCK, and it must exist BEFORE a lock does. v1.0.67 shipped with
        // the lock request emitted only from paths that already required `childLocked`, so
        // there was no way to ENGAGE one at all: the feature was unreachable. Reported from
        // a device ("אני לא רואה שיש נעילה לאתר אינטרנט ספציפי").
        //
        // Not in parent mode: that session exists so a parent can complete a login with
        // navigation unrestricted, and locking a child into an unrestricted browser would
        // undo every rule this viewer enforces.
        if (!parentMode) {
            Button lock = new Button(a);
            lock.setText(childLocked ? "🔒" : "🔓");
            lock.setAllCaps(false);
            lock.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f);
            lock.setTextColor(Color.parseColor("#4b41d6"));
            android.graphics.drawable.GradientDrawable lp = new android.graphics.drawable.GradientDrawable();
            lp.setColor(Color.WHITE);
            lp.setCornerRadius(dp(a, 22));
            lock.setBackground(lp);
            lock.setPadding(dp(a, 14), dp(a, 6), dp(a, 14), dp(a, 6));
            lock.setMinimumHeight(dp(a, 48));   // a child's finger, not a cursor
            lock.setElevation(dp(a, 2));
            lock.setContentDescription(childLocked ? "שחרור הנעילה" : "נעילה על האתר");
            // JS owns the code screen and the duration dialog — and the code is NEVER
            // verified here (an invariant bans the word from this file).
            lock.setOnClickListener(v -> notifyListeners("webLockRequest", new JSObject()));
            bar.addView(lock);
        }

        titleView = new TextView(a);
        titleView.setTextColor(Color.WHITE);
        titleView.setSingleLine(true);
        titleView.setPadding(dp(a, 8), 0, 0, 0);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(titleView, tp);

        if (parentMode) {
            TextView tag = new TextView(a);
            tag.setText("מצב הורה");
            tag.setTextColor(Color.WHITE);
            bar.addView(tag);
        }

        // v1.0.76 — BROWSER BACK / FORWARD (user request), at the visual LEFT: added LAST, so
        // in the RTL bar they sit at the far-left corner opposite the 🏠 pill. The glyphs are
        // the app's own pager convention (ui/pager.js): ▶ = "previous" (back), ◀ = "next"
        // (forward) — mirrored for RTL, so a child meets ONE arrow language across the app.
        //
        // ⚠️ NOT A HOLE IN THE SAFETY BOUNDARY: goBack()/goForward() only ever reach history
        // entries that were ALREADY vetted by shouldOverrideUrlLoading when first loaded (and
        // a site lock rebuilds the overlay, so its history holds only in-lock pages). History
        // navigation does not re-run the URL filter, and it does not need to.
        navBack = navButton(a, "▶", "הקודם", () -> { if (web != null && web.canGoBack()) { web.goBack(); } });
        navFwd = navButton(a, "◀", "הבא", () -> { if (web != null && web.canGoForward()) { web.goForward(); } });
        bar.addView(navBack);
        bar.addView(navFwd);

        col.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        updateNavButtons(); // start disabled — a fresh page can go neither way

        // A SUBCLASS, so the text-selection ActionMode can be refused: selecting a word
        // offers "Web search" and "Translate", and both launch another app — the same
        // class of escape as the long-press menu, reached by a different gesture.
        web = new WebView(a) {
            @Override
            public ActionMode startActionMode(ActionMode.Callback callback) { return null; }
            @Override
            public ActionMode startActionMode(ActionMode.Callback callback, int type) { return null; }
        };
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // Persisted on purpose: the parent signs in ONCE, in parent mode, and the child
        // inherits that session. Modern sites keep the session in DOM storage as often as
        // in a cookie, so both are enabled or "once" is a lie.
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // Everything below is a door closed.
        s.setSupportMultipleWindows(false);                 // target=_blank / window.open
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);                        // file:// browsing
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); // no http inside https
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false); // trackers

        // A long press offers "open in new tab" / "copy link" / "download image" — three
        // ways out of the allowed set, in one gesture a child finds by accident.
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        web.setOnLongClickListener(v -> true);

        web.setWebViewClient(new RestrictedClient());
        web.setWebChromeClient(new RestrictedChromeClient());
        // A download is how a child ends up with an APK. There is nothing to download here.
        web.setDownloadListener((u, ua, cd, mt, len) -> notifyBlocked(u));

        col.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        overlay.addView(col, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        ViewGroup decor = (ViewGroup) a.getWindow().getDecorView();
        decor.addView(overlay, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** v1.0.76 — one small round bar button (▶/◀). A child's finger, not a cursor. */
    private Button navButton(Activity a, String glyph, String label, Runnable onTap) {
        Button b = new Button(a);
        b.setText(glyph);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(Color.TRANSPARENT);
        b.setPadding(dp(a, 10), dp(a, 6), dp(a, 10), dp(a, 6));
        b.setMinimumWidth(dp(a, 48));
        b.setMinimumHeight(dp(a, 48));
        b.setContentDescription(label);
        b.setOnClickListener(v -> onTap.run());
        return b;
    }

    /**
     * v1.0.76 — grey a nav button the WebView cannot honour, so a child does not tap a dead
     * arrow. Called from open() and from EVERY history hook (onPageStarted /
     * doUpdateVisitedHistory / onPageFinished) — a same-document pushState changes what
     * canGoBack answers without an onPageStarted. UI thread only (that is where all three
     * hooks and open() run), because canGoBack/canGoForward are UI-thread methods.
     */
    private void updateNavButtons() {
        if (web == null) return;
        boolean back = web.canGoBack();
        boolean fwd = web.canGoForward();
        if (navBack != null) { navBack.setEnabled(back); navBack.setAlpha(back ? 1f : 0.35f); }
        if (navFwd != null) { navFwd.setEnabled(fwd); navFwd.setAlpha(fwd ? 1f : 0.35f); }
    }

    /** The child asked to leave. Under a site lock, that is the one thing they may not do. */
    private void closeOverlay() {
        if (childLocked) { notifyListeners("webLockRequest", new JSObject()); return; }
        forceClose();
    }

    /** Close regardless of the lock — for the app's own reasons only. */
    private void forceClose() {
        childLocked = false;   // the overlay is going; a stale flag would mis-build the next
        if (overlay == null) return;
        exitFullscreen();                   // never leave a detached video surface behind
        try {
            flushCookies();                 // the login must survive the close
            web.stopLoading();
            web.loadUrl("about:blank");     // stops any audio still playing
            ViewGroup parent = (ViewGroup) overlay.getParent();
            if (parent != null) parent.removeView(overlay);
            web.destroy();
        } catch (Exception ignored) {}
        overlay = null;
        web = null;
        titleView = null;
        navBack = null;
        navFwd = null;
        currentPageUrl = "";
        notifyListeners("webClosed", new JSObject());
    }

    /* ---------------- enforcement ---------------- */

    private class RestrictedClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            // The blocked page's own "הורים" link. Checked BEFORE anything else, because
            // it is not https and every other branch would (correctly) refuse it.
            if (u != null && "kidsweb".equals(u.getScheme())) {
                requestParentAdd(lastBlockedUrl);
                return true;
            }
            if (parentMode) return false; // the parent's own browsing, behind the PIN
            if (allowed(u)) return false;
            // TRUE = we handled it, i.e. the navigation does NOT happen. Everything that
            // is not an approved https page lands here, including intent:// market://
            // tel: and mailto:, each of which would otherwise open ANOTHER APP.
            lastBlockedUrl = u.toString();
            notifyBlocked(lastBlockedUrl);
            showBlockedPage(view);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (parentMode) return null;
            if (subresourceAllowed(request.getUrl())) return null;
            // An empty 200 rather than an error: a blocked ad slot should leave a hole in
            // the page, not a broken-image icon or a JS exception the site reacts to.
            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            currentPageUrl = url;   // UI thread — the background reader only ever reads it
            pingActivity();
            updateNavButtons();     // v1.0.76
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            updateNavButtons();     // v1.0.76 — canGoForward flips to false once a new nav commits
        }

        /** Also fires for same-document navigations (pushState), which onPageStarted misses. */
        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            currentPageUrl = url;
            updateNavButtons();     // v1.0.76 — a pushState changes canGoBack with no onPageStarted
        }
    }

    private class RestrictedChromeClient extends WebChromeClient {
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            return false; // pop-ups never open
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            request.deny(); // camera / microphone / midi — never, and never a prompt
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, android.webkit.GeolocationPermissions.Callback cb) {
            cb.invoke(origin, false, false);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            if (titleView != null && title != null && !title.isEmpty()) titleView.setText(title);
        }

        /**
         * HTML5 FULLSCREEN. A bare WebView does not implement it: without these two the
         * fullscreen button on an embedded YouTube player does NOTHING AT ALL — reported
         * from the device. The video element hands us its own surface and we are expected
         * to place it; the same contract MainActivity already honours for the app's own
         * WebView, which is why fullscreen works there and did not work here.
         */
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customCallback = callback;
            if (chromeCol != null) chromeCol.setVisibility(View.GONE);
            overlay.addView(customView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            // A video is USE, even with nobody touching the glass: hold the screen on, and
            // keep telling JS the child is here. Otherwise the idle timer — which counts an
            // open viewer and is fed only by page loads — closes the viewer mid-video.
            overlay.setKeepScreenOn(true);
            fsHandler.removeCallbacks(fsPing);
            fsHandler.post(fsPing);
        }

        @Override
        public void onHideCustomView() { exitFullscreen(); }
    }

    /** Tear the fullscreen surface down. Safe to call when there is none. */
    private void exitFullscreen() {
        if (customView == null) return;
        fsHandler.removeCallbacks(fsPing);
        try { overlay.removeView(customView); } catch (Exception ignored) {}
        customView = null;
        if (chromeCol != null) chromeCol.setVisibility(View.VISIBLE);
        if (overlay != null) overlay.setKeepScreenOn(false);
        if (customCallback != null) {
            try { customCallback.onCustomViewHidden(); } catch (Exception ignored) {}
            customCallback = null;
        }
    }

    /** While a video is fullscreen, report activity so the idle timer does not close it. */
    private final Runnable fsPing = new Runnable() {
        @Override
        public void run() {
            if (customView == null) return;
            notifyListeners("webActivity", new JSObject());
            fsHandler.postDelayed(this, 30000);
        }
    };

    /** THE navigation decision. Pre-normalized parts only — no prefix parsing here. */
    private boolean allowed(Uri u) {
        if (u == null) return false;
        if (!"https".equals(u.getScheme())) return false;
        if (u.getUserInfo() != null) return false;          // https://good.com@evil.com/
        String host = u.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.startsWith("www.")) host = host.substring(4);
        int port = u.getPort();
        if (port == -1) port = 443;

        List<String> segs = u.getPathSegments();            // already percent-decoded
        for (String seg : segs) {
            if (".".equals(seg) || "..".equals(seg)) return false; // %2e%2e arrives as ".."
        }
        for (Rule r : rules) {
            if (!r.host.equals(host) || r.port != port) continue;
            if (r.segments.size() > segs.size()) continue;
            boolean ok = true;
            for (int i = 0; i < r.segments.size(); i++) {
                if (!r.segments.get(i).equals(segs.get(i))) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    /** The rule governing a page, longest match — so a narrow rule keeps its own policy. */
    private Rule governing(Uri u) {
        Rule best = null;
        if (u == null) return null;
        String host = u.getHost();
        if (host == null) return null;
        host = host.toLowerCase(Locale.ROOT);
        if (host.startsWith("www.")) host = host.substring(4);
        List<String> segs = u.getPathSegments();
        for (Rule r : rules) {
            if (!r.host.equals(host)) continue;
            if (r.segments.size() > segs.size()) continue;
            boolean ok = true;
            for (int i = 0; i < r.segments.size(); i++) {
                if (!r.segments.get(i).equals(segs.get(i))) { ok = false; break; }
            }
            if (ok && (best == null || r.segments.size() > best.segments.size())) best = r;
        }
        return best;
    }

    /**
     * Subresources: the prefix rule governs NAVIGATION only, and everything a page embeds
     * arrives without the child tapping anything — ad inventory, trackers, third-party
     * players. Strict by default: the page's own host and its subdomains (where a site's
     * CDN lives), plus any approved rule's host. The parent can open one rule up.
     */
    private boolean subresourceAllowed(Uri u) {
        if (u == null) return true;
        String scheme = u.getScheme();
        if (scheme == null) return true;
        if ("data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme)) return true;
        if (!"https".equals(scheme)) return false;

        // The tracked URL, NOT web.getUrl(): this method runs off the UI thread and any
        // WebView call from here is a fatal "called on thread 'WebViewCoreThread'".
        final String pageUrl = currentPageUrl;
        Uri page = (pageUrl != null && !pageUrl.isEmpty()) ? Uri.parse(pageUrl) : null;
        Rule gov = governing(page);
        if (gov != null && gov.allowExternal) return true;

        String host = u.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (host.startsWith("www.")) host = host.substring(4);

        List<String> allow = new ArrayList<>();
        if (page != null && page.getHost() != null) {
            String h = page.getHost().toLowerCase(Locale.ROOT);
            allow.add(h.startsWith("www.") ? h.substring(4) : h);
        }
        for (Rule r : rules) allow.add(r.host);
        for (String h : allow) {
            if (host.equals(h) || host.endsWith("." + h)) return true;
        }
        return false;
    }

    /**
     * What the CHILD sees when a link is refused: a calm sentence, never a dead tap. The
     * "הורים" button asks JS to take over — the parent code is checked THERE, because
     * verifying a PIN in Java would be a second implementation of the one check that
     * guards the entire parent surface.
     */
    private void showBlockedPage(WebView view) {
        String html = "<!doctype html><html dir='rtl' lang='he'><head><meta charset='utf-8'>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{font-family:sans-serif;background:#fdf6e3;color:#2b2b3a;display:flex;"
            + "flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}"
            + "h1{font-size:22px}p{color:#6b6b80}"
            + "a{margin-top:28px;font-size:12px;opacity:.55;color:#6b6b80;text-decoration:underline}</style></head>"
            + "<body><div style='font-size:56px'>🚧</div><h1>הדף הזה לא זמין</h1>"
            + "<p>אפשר לחזור אחורה ולהמשיך לשחק</p>"
            + "<a href='kidsweb://ask'>הורים</a></body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void notifyBlocked(String url) {
        JSObject o = new JSObject();
        o.put("url", url);
        notifyListeners("webBlocked", o);
    }

    /**
     * Touches inside a native WebView never reach the app's own window, so the JS capture
     * listeners that feed the idle timer are blind while a site is open. Without this ping
     * the screen-off timer would fire on a child who is actively browsing. Throttled — it
     * is a heartbeat, not an event stream.
     */
    private void pingActivity() {
        long now = System.currentTimeMillis();
        if (now - lastActivityPing < 5000) return;
        lastActivityPing = now;
        notifyListeners("webActivity", new JSObject());
    }

    /* ---------------- helpers ---------------- */

    private List<Rule> readRules(JSArray arr) {
        List<Rule> out = new ArrayList<>();
        if (arr == null) return out;
        try {
            for (Object item : arr.toList()) {
                if (!(item instanceof org.json.JSONObject)) continue;
                org.json.JSONObject o = (org.json.JSONObject) item;
                Rule r = new Rule();
                r.host = o.optString("host", "").toLowerCase(Locale.ROOT);
                if (r.host.isEmpty()) continue;
                r.port = o.optInt("port", 443);
                r.allowExternal = o.optBoolean("allowExternal", false);
                org.json.JSONArray segs = o.optJSONArray("segments");
                if (segs != null) {
                    for (int i = 0; i < segs.length(); i++) r.segments.add(segs.optString(i, ""));
                }
                out.add(r);
            }
        } catch (Exception ignored) {}
        return out;
    }

    private static String hostOf(String url) {
        try { return Uri.parse(url).getHost(); } catch (Exception e) { return ""; }
    }

    private static int dp(Activity a, int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, a.getResources().getDisplayMetrics());
    }

    private static int statusBarInset(Activity a) {
        int id = a.getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? a.getResources().getDimensionPixelSize(id) : 0;
    }

    /** The blocked page's "הורים" link, routed to JS. Called from RestrictedClient. */
    void requestParentAdd(String url) {
        JSObject o = new JSObject();
        o.put("url", url);
        notifyListeners("webAddRequest", o);
    }
}
