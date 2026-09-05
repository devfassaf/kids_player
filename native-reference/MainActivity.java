package com.assaf.kidsplayer;

// Kids Player — native tweaks.
// Copy this over android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java AFTER
// `npx cap add android`. Keep the package line above matching your appId.
//
// It does two things Capacitor does NOT do out of the box:
//   1) Swallows navigations to youtube.com / youtu.be so the app NEVER leaves to YouTube
//      (the embed loads from youtube-nocookie.com as a subframe and still plays).
//      Without this, Capacitor's default behavior LAUNCHES the external browser on the
//      YouTube logo / "Watch on YouTube" tap.
//   2) Installs a WebChromeClient that makes HTML5 fullscreen actually work (Capacitor's
//      onShowCustomView is a no-op) and blocks pop-up windows.

import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KidsNativePlugin.class);  // MUST run before super.onCreate() (bridge builds there)
        registerPlugin(GoogleAuthPlugin.class);
        registerPlugin(KidsWebPlugin.class);     // v1.0.45 — the restricted site viewer
        super.onCreate(savedInstanceState);

        Bridge bridge = getBridge();
        WebView webView = bridge.getWebView();
        webView.getSettings().setSupportMultipleWindows(false);
        webView.setWebViewClient(new KidsWebViewClient(bridge));
        webView.setWebChromeClient(new KidsWebChromeClient(bridge));

        applyImmersive();
    }

    /**
     * v1.0.16 — GAME-STYLE IMMERSIVE MODE: the app always runs without the status and
     * navigation bars, and a swipe from the edge reveals them TRANSIENTLY (they hide
     * themselves again). Rationale: the child gets the whole screen, and the system
     * back/home buttons stop being one accidental tap away from leaving the app.
     * BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE is the sanctioned way — an app may not
     * block the home button (screen pinning, the exit-lock feature, is that mechanism).
     */
    private void applyImmersive() {
        WindowInsetsControllerCompat c =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (c == null) return;
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    /** Dialogs, the keyboard, screen pinning and app switches all restore the bars —
        re-hide whenever we own the window again (the standard immersive contract). */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    /**
     * v1.0.45 — hardware back while the restricted site viewer is up. It is a native view
     * laid OVER the bridge, so the JS back handler cannot see it: without this branch the
     * child's back press would navigate the app hidden underneath while the site stayed
     * on screen. Falls through to super (i.e. Capacitor → nav.handleBack) otherwise.
     */
    @Override
    public void onBackPressed() {
        if (KidsWebPlugin.handleBack()) return;
        super.onBackPressed();
    }

    /**
     * v1.0.32's lesson, applied to the site viewer: Android does not pause a WebView when
     * the activity backgrounds, so a site with audio would keep playing behind a dark
     * screen after the power button — exactly the report that fix exists for. The plugin
     * also flushes cookies here, which is what makes a parent's login survive a process
     * kill instead of quietly having to be typed again.
     */
    @Override
    public void onPause() {
        KidsWebPlugin.onActivityPause();
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        KidsWebPlugin.onActivityResume();
        KidsNativePlugin.onPipActivityResumed(); // v1.0.76: an EXPAND is not a dismissal
    }

    /* ---------------- picture-in-picture (v1.0.76) ----------------
       All four hooks forward to KidsNativePlugin, so the logic (and its comments) live in
       ONE file across both java copies. JS pushes eligibility ahead of time — this hint is
       synchronous and cannot ask the bridge. */

    /** The HOME press on API 26–30 / 3-button nav (on 31+ auto-enter handles the gesture). */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        KidsNativePlugin.maybeEnterPip(this);
    }

    /** Fires BEFORE the onPause PiP entry causes — the order the JS pause handler relies on. */
    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        KidsNativePlugin.onPipModeChanged(this, isInPictureInPictureMode);
    }

    /** A PiP window dismissed with its X, or the screen turning off over it, lands here —
        with NO appStateChange (the activity already paused at PiP entry), so the plugin
        tells JS to bank the playhead and fall silent. */
    @Override
    public void onStop() {
        KidsNativePlugin.onPipActivityStopped();
        super.onStop();
    }

    // F12b share target. VERIFIED: BridgeActivity.load() ends with
    // `this.onNewIntent(getIntent())`, so this ONE override covers both cold start and
    // warm singleTask redelivery — a separate getIntent() branch in onCreate would
    // double-process. It fires during super.onCreate(), before JS boots, which is why
    // the payload goes into KidsNativePlugin's static inbox.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); // keeps bridge plugin dispatch working
        setIntent(intent);
        handleShareIntent(intent);
    }

    private void handleShareIntent(Intent i) {
        if (i == null || !Intent.ACTION_SEND.equals(i.getAction())) return;
        String type = i.getType();
        if (type == null || !type.startsWith("text/")) return;
        String text = i.getStringExtra(Intent.EXTRA_TEXT);
        String subject = i.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null && subject == null) return;
        KidsNativePlugin.enqueueShare(text, subject);
        // Consume: a process-death task restore replays getIntent() and would re-add.
        i.removeExtra(Intent.EXTRA_TEXT);
        i.removeExtra(Intent.EXTRA_SUBJECT);
        i.setAction(Intent.ACTION_MAIN);
    }

    /** Blocks any navigation whose host is YouTube; everything else keeps Capacitor's behavior. */
    private class KidsWebViewClient extends BridgeWebViewClient {
        KidsWebViewClient(Bridge bridge) { super(bridge); }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url != null ? url.getHost() : null;
            if (host != null) {
                if (host.endsWith("youtube-nocookie.com")) {
                    return false; // allow the privacy-enhanced embed
                }
                if (host.endsWith("youtube.com") || host.endsWith("youtu.be")) {
                    return true;  // swallow: no external browser, WebView stays put
                }
            }
            return super.shouldOverrideUrlLoading(view, request);
        }
    }

    /** Real fullscreen support + block new windows/pop-ups. */
    private class KidsWebChromeClient extends BridgeWebChromeClient {
        private View customView;
        private CustomViewCallback customCallback;

        KidsWebChromeClient(Bridge bridge) { super(bridge); }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customCallback = callback;
            Window window = getWindow();
            ViewGroup decor = (ViewGroup) window.getDecorView();
            decor.addView(customView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            getBridge().getWebView().setVisibility(View.GONE);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            Window window = getWindow();
            ViewGroup decor = (ViewGroup) window.getDecorView();
            decor.removeView(customView);
            customView = null;
            getBridge().getWebView().setVisibility(View.VISIBLE);
            if (customCallback != null) {
                customCallback.onCustomViewHidden();
                customCallback = null;
            }
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            return false; // block "open in new window" (e.g. the YouTube logo)
        }
    }
}
