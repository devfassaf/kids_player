package com.assaf.kidsplayer;

// Kids Player — the single custom native surface, six features:
//   1) keepAwake/allowSleep (F7): window-level FLAG_KEEP_SCREEN_ON. Needs NO permission
//      (not even WAKE_LOCK), survives the fullscreen custom-view swap, and is auto-scoped
//      to window visibility so background/resume need zero handling.
//   2) Share-intent inbox (F12b): MainActivity.handleShareIntent() enqueues into a STATIC
//      inbox (a share can arrive during super.onCreate(), long before JS boots), then
//      notifyListeners with retainUntilConsumed=true. JS boot order: addListener FIRST,
//      then getPendingShares() to drain. Double delivery is harmless (key dedupe in JS).
//   3) APK self-update installer (F14): FileProvider URI + ACTION_VIEW. Deliberately no
//      resolveActivity() — API 30+ package visibility returns null without <queries>,
//      a phantom failure.
//   4) exitApp (v1.0.4): finishAndRemoveTask + delayed process kill — App.exitApp()
//      only finish()es, which reads as "minimize" on real devices.
//   5) shareText (v1.0.5): the OS share sheet (ACTION_SEND chooser) — used by the
//      parent screen's "share the app" button; no plugin dependency needed.
//   6) Device credential (v1.0.26): BiometricPrompt with BIOMETRIC_WEAK |
//      DEVICE_CREDENTIAL — the FAST path back in for a parent who forgot the app's
//      code. Reports instead of throwing; the 24-hour wait in recovery.js is the
//      floor under it, because a child's tablet often has no lock screen at all.
//
// Canonical copy: native-reference/KidsNativePlugin.java — keep both in sync.

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.view.WindowManager;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.util.ArrayDeque;

// v1.0.64 — POST_NOTIFICATIONS is declared here so Capacitor can REQUEST it. Declaring it
// in the manifest alone is not enough on Android 13+: it is a runtime permission, DENIED by
// default, and v1.0.63 shipped without ever asking — so the background-playback service
// started (the audio kept playing) and its notification was silently suppressed. Reported
// from a device: "השיר המשיך אבל לא הופיע כפתור".
@CapacitorPlugin(name = "KidsNative", permissions = {
    @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = KidsNativePlugin.NOTIF)
})
public class KidsNativePlugin extends Plugin {

    /* ---------------- keep screen on (F7) ---------------- */

    @PluginMethod
    public void keepAwake(PluginCall call) { setKeepScreenOn(true); call.resolve(); }

    @PluginMethod
    public void allowSleep(PluginCall call) { setKeepScreenOn(false); call.resolve(); }

    private void setKeepScreenOn(boolean on) {
        Activity a = getActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    /* ---------------- fullscreen orientation (v1.0.54) ---------------- */

    /**
     * v1.0.54 — a fullscreen video plays LANDSCAPE, always (user request: like YouTube).
     * The WebView cannot override the SYSTEM rotation lock; only an activity-level
     * request can, and it is exactly what YouTube itself does on fullscreen entry.
     * 'landscape' = SENSOR_LANDSCAPE (both ways of holding the device); anything else
     * restores UNSPECIFIED — back to the system's own rule, so leaving fullscreen on a
     * rotation-locked phone returns to portrait like every other app. configChanges in
     * the manifest already includes orientation|screenSize, so the request rotates the
     * live WebView without recreating the activity.
     */
    @PluginMethod
    public void setOrientation(PluginCall call) {
        String mode = call.getString("mode", "auto");
        Activity a = getActivity();
        if (a != null) {
            a.runOnUiThread(() -> {
                try {
                    a.setRequestedOrientation("landscape".equals(mode)
                            ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                            : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                } catch (Exception ignored) { /* never take the player down over rotation */ }
            });
        }
        call.resolve();
    }

    /* ---------------- TV detection (v1.0.9) ---------------- */

    /** Are we on Android TV / Google TV? Drives the 10-foot layout + D-pad focus mode. */
    @PluginMethod
    public void isTv(PluginCall call) {
        android.app.UiModeManager ui =
                (android.app.UiModeManager) getContext().getSystemService(Context.UI_MODE_SERVICE);
        boolean tv = ui != null
                && ui.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;
        JSObject ret = new JSObject();
        ret.put("value", tv);
        call.resolve(ret);
    }

    /* ---------------- is a call happening? (v1.0.57) ---------------- */

    /**
     * The audio mode, as one lower-case word. This is how the app knows a video was
     * interrupted by a CALL and not by the child, the power button or a home tap — the
     * user's decision was "calls only", and the lifecycle alone cannot tell them apart.
     *
     * AudioManager.getMode() and NOT TelephonyManager: it needs NO PERMISSION (READ_PHONE_STATE
     * is a runtime permission on a child's tablet, and asking for it to resume a video would be
     * absurd), and it catches VoIP too — WhatsApp, Messenger and the rest report
     * MODE_IN_COMMUNICATION, which a telephony listener never sees.
     *
     * Polled rather than pushed on purpose: OnModeChangedListener is API 31+, and this app
     * runs on much older tablets. The poll is one in-process getter, and JS only runs it
     * around a paused video.
     *
     * An unknown or unreadable state answers "unknown", never "normal": the JS side treats
     * unknown as "no evidence of a call", so a device that cannot answer simply never
     * auto-resumes — the same direction the browser takes.
     */
    @PluginMethod
    public void audioMode(PluginCall call) {
        String mode = "unknown";
        try {
            android.media.AudioManager am =
                    (android.media.AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                int m = am.getMode();
                if (m == android.media.AudioManager.MODE_NORMAL) mode = "normal";
                else if (m == android.media.AudioManager.MODE_RINGTONE) mode = "ringtone";
                else if (m == android.media.AudioManager.MODE_IN_CALL) mode = "in_call";
                else if (m == android.media.AudioManager.MODE_IN_COMMUNICATION) mode = "in_communication";
                else mode = "other";
            }
        } catch (Exception ignored) { }
        JSObject ret = new JSObject();
        ret.put("value", mode);
        call.resolve(ret);
    }

    /* ---------------- open a link outside the app (v1.0.14) ---------------- */

    /**
     * Hands an https link to the system browser. The in-app WebView deliberately
     * blocks external navigation and popups (child safety), so parent-facing links
     * (donation pages) can only leave through an explicit intent like this one.
     * Refuses anything that isn't http(s) — no intent:// or file:// smuggling.
     */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("bad-url");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("no-browser");
        }
    }

    /* ---------------- exit lock via screen pinning (v1.0.11) ---------------- */
    // Android does NOT let apps intercept the HOME button — the sanctioned kiosk
    // mechanism is lock-task ("screen pinning"): home/recents/back are contained by
    // the OS. Without device-owner provisioning the FIRST startLockTask shows a
    // one-time system confirmation; our own stopLockTask() (parent-PIN gated in JS)
    // exits it without device credentials.

    /**
     * v1.0.36: pin/unpin are NOT idempotent at the OS level, so every caller must check
     * first. stopLockTask() on many devices shows the DEVICE keyguard ("lock device when
     * unpinning" is a system setting we cannot read or change) — a redundant unpin locked
     * the whole TABLET mid-profile-switch (field report). startLockTask() while already
     * pinned re-runs the pinning ceremony on some OEMs. This is the one gate for both.
     */
    private boolean inLockTask() { return inLockTaskStatic(getContext()); }

    /** v1.0.76: static twin, so the PiP hooks (no plugin instance in hand) read the SAME gate. */
    static boolean inLockTaskStatic(Context ctx) {
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            return am != null
                    && am.getLockTaskModeState() != android.app.ActivityManager.LOCK_TASK_MODE_NONE;
        } catch (Exception ignored) { return false; }
    }

    @PluginMethod
    public void lockTask(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("no-activity"); return; }
        if (inLockTask()) { call.resolve(); return; } // already pinned — never re-pin
        a.runOnUiThread(() -> {
            try { a.startLockTask(); call.resolve(); }
            catch (Exception e) { call.reject("lock-failed: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void unlockTask(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("no-activity"); return; }
        if (!inLockTask()) { call.resolve(); return; } // not pinned — never poke the keyguard
        a.runOnUiThread(() -> {
            try { a.stopLockTask(); } catch (Exception ignored) {}
            call.resolve();
        });
    }

    @PluginMethod
    public void isTaskLocked(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("value", inLockTask());
        call.resolve(ret);
    }

    /* ---------------- real exit (v1.0.4) ---------------- */

    /**
     * App.exitApp() only calls activity.finish(): the task stays in recents and on some
     * launchers the app just minimizes. finishAndRemoveTask() removes the whole task;
     * the delayed System.exit ensures the process dies even if a plugin holds it alive.
     */
    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve(); // resolve first — the webview is about to die
        Activity a = getActivity();
        if (a == null) { System.exit(0); return; }
        a.runOnUiThread(() -> {
            try { a.stopLockTask(); } catch (Exception ignored) {} // pinned task can't finish
            a.finishAndRemoveTask();
            new android.os.Handler(android.os.Looper.getMainLooper())
                    .postDelayed(() -> System.exit(0), 250);
        });
    }

    /* ---------------- share sheet (v1.0.5) ---------------- */

    /** Opens the system share chooser with plain text (link + explanation). */
    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty()) { call.reject("no-text"); return; }
        String subject = call.getString("subject");
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            if (subject != null && !subject.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, subject);
            Intent chooser = Intent.createChooser(send, null);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("share-failed: " + e.getMessage());
        }
    }

    /**
     * v1.0.38 — the system share chooser on a FILE (the links export).
     *
     * shareText cannot do this: it is text/plain + EXTRA_TEXT and rejects an empty body.
     * The URI must come from our FileProvider (authority <applicationId>.fileprovider,
     * declared in the manifest) — handing out a raw file:// URI throws FileUriExposedException
     * on API 24+ — and the receiving app needs FLAG_GRANT_READ_URI_PERMISSION or it opens an
     * empty document. res/xml/file_paths.xml must contain an <external-files-path> entry
     * covering exports/, or getUriForFile throws IllegalArgumentException for this path.
     */
    @PluginMethod
    public void shareFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) { call.reject("no-path"); return; }
        String mimeType = call.getString("mimeType");
        if (mimeType == null || mimeType.isEmpty()) mimeType = "text/plain";
        String subject = call.getString("subject");
        try {
            File f = new File(path);
            if (!f.exists()) { call.reject("no-file"); return; }
            Context ctx = getContext();
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mimeType);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            if (subject != null && !subject.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, subject);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, null);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            // Every failure here is recoverable by the JS side (it falls back to sharing the
            // list as text, then the clipboard), so reject rather than crash.
            call.reject("share-file-failed: " + e.getMessage());
        }
    }

    /* ---------------- notification permission (v1.0.64) ---------------- */

    static final String NOTIF = "notifications";

    /**
     * v1.0.64 — ask for POST_NOTIFICATIONS, and answer whether it is granted.
     *
     * Called from JS at the ONE moment it makes sense: when a parent switches background
     * playback ON. Asking at launch would be a prompt with no context on a child's tablet;
     * asking when the screen goes off would be a dialog nobody is there to see.
     *
     * Below API 33 there is no such permission and the answer is always "granted" — the
     * notification simply shows.
     */
    @PluginMethod
    public void ensureNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) { resolveGranted(call, true); return; }
        if (getPermissionState(NOTIF) == PermissionState.GRANTED) { resolveGranted(call, true); return; }
        requestPermissionForAlias(NOTIF, call, "notifPermCallback");
    }

    @PermissionCallback
    private void notifPermCallback(PluginCall call) {
        resolveGranted(call, getPermissionState(NOTIF) == PermissionState.GRANTED);
    }

    private void resolveGranted(PluginCall call, boolean granted) {
        JSObject o = new JSObject();
        o.put("granted", granted);
        call.resolve(o);
    }

    /* ---------------- background playback (v1.0.63) ---------------- */

    /**
     * v1.0.63 — keep playing when the app goes to the background (user request), for the
     * family's OWN audio/video files only. JS decides everything about WHAT plays; this
     * pair only runs the foreground service that lets Android keep it playing.
     *
     * ⚠️ CALLED WHILE THE APP IS STILL FOREGROUND. Since API 31 a backgrounded app may not
     * start a foreground service at all, so JS starts this when an eligible video begins
     * playing — not when the screen goes off, which is already too late.
     */
    @PluginMethod
    public void startBackgroundPlayback(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.resolve(); return; }
        Intent i = new Intent(a, PlaybackService.class)
            .setAction(PlaybackService.ACTION_START)
            .putExtra("title", call.getString("title", ""))
            // v1.0.65 — the folder's name, shown as the "artist" line on a car display and
            // on the lock-screen widget. A song with no context is the one thing a driver
            // glancing at the screen cannot use.
            .putExtra("subtitle", call.getString("subtitle", ""))
            .putExtra("artB64", call.getString("artB64", ""))
            .putExtra("posMs", call.getInt("posMs", 0).longValue())
            .putExtra("durMs", call.getInt("durMs", 0).longValue())
            .putExtra("playing", call.getBoolean("playing", Boolean.TRUE));
        try {
            if (Build.VERSION.SDK_INT >= 26) a.startForegroundService(i);
            else a.startService(i);
        } catch (Throwable ignored) {
            // An OEM or a policy may refuse. Never crash a child's player over it: the
            // video simply pauses on background, exactly as it did before this feature.
        }
        call.resolve();
    }

    @PluginMethod
    public void stopBackgroundPlayback(PluginCall call) {
        Activity a = getActivity();
        if (a != null) {
            try { a.startService(new Intent(a, PlaybackService.class).setAction(PlaybackService.ACTION_STOP)); }
            catch (Throwable ignored) {}
        }
        call.resolve();
    }

    /**
     * A notification button. RETAINED until consumed, like a share intent: the WebView may
     * be frozen when the parent taps ⏭ with the screen off, and a dropped command is a
     * button that does nothing.
     */
    public static void emitPlaybackCommand(String action) {
        KidsNativePlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("action", action == null ? "" : action);
        p.notifyListeners("playbackCommand", o, true);
    }

    /* ---------------- picture-in-picture (v1.0.76) ---------------- */
    //
    // HOME shrinks a playing video into Android's own floating window (user request,
    // opt-in per profile). JS PUSHES the decision ahead of time (setPipState) because
    // onUserLeaveHint is synchronous and cannot ask the bridge — the v1.0.63
    // bgPlayEnabled cached-decision shape, one layer down. MainActivity forwards its
    // lifecycle moments here so the logic lives in ONE file across both java copies.
    //
    // The window's X and expand affordances are ANDROID'S OWN; only ⏮/⏯/⏭ are ours
    // (RemoteActions). Their taps arrive as broadcasts and ride the EXISTING
    // playbackCommand channel — the same retained-until-consumed path the notification's
    // buttons use, so a command tapped while the WebView is busy is never lost.

    private static volatile boolean pipEligible = false;
    private static volatile boolean pipPlaying = false;
    private static volatile boolean pipActive = false;
    private static volatile long pipExitAt = 0L;

    private static final String PIP_PREV = "com.assaf.kidsplayer.PIP_PREV";
    private static final String PIP_TOGGLE = "com.assaf.kidsplayer.PIP_TOGGLE";
    private static final String PIP_NEXT = "com.assaf.kidsplayer.PIP_NEXT";

    /** Can this device PiP at all? API 26+ AND the system feature (not every tablet has it). */
    @PluginMethod
    public void pipSupported(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT >= 26 && hasPipFeature(getContext());
        JSObject ret = new JSObject();
        ret.put("value", ok);
        call.resolve(ret);
    }

    /**
     * The cached decision + the real play state (the state drives the ⏯ icon — the
     * v1.0.74 rule: the icon follows what the player REPORTED, never what was asked for).
     * Re-applying the params also live-updates an already-open window.
     */
    @PluginMethod
    public void setPipState(PluginCall call) {
        pipEligible = Boolean.TRUE.equals(call.getBoolean("eligible", false));
        pipPlaying = Boolean.TRUE.equals(call.getBoolean("playing", false));
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(() -> applyPipParams(a));
        call.resolve();
    }

    private static boolean hasPipFeature(Context ctx) {
        try {
            return ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
        } catch (Throwable ignored) { return false; }
    }

    /** setPictureInPictureParams: arms auto-enter (API 31+) AND refreshes a live window. */
    static void applyPipParams(Activity a) {
        if (Build.VERSION.SDK_INT < 26 || !hasPipFeature(a)) return;
        try { a.setPictureInPictureParams(buildPipParams(a)); }
        catch (Throwable ignored) { /* never take the player down over a window param */ }
    }

    @androidx.annotation.RequiresApi(26)
    private static android.app.PictureInPictureParams buildPipParams(Activity a) {
        android.app.PictureInPictureParams.Builder b = new android.app.PictureInPictureParams.Builder();
        // 16:9 always — the library is long-form by doctrine (Shorts are excluded), and an
        // audio file's music scene renders at whatever shape the window gives it.
        b.setAspectRatio(new android.util.Rational(16, 9));
        java.util.List<android.app.RemoteAction> actions = new java.util.ArrayList<>();
        actions.add(pipAction(a, 1, R.drawable.ic_pip_prev, "הקודם", PIP_PREV));
        actions.add(pipAction(a, 2, pipPlaying ? R.drawable.ic_pip_pause : R.drawable.ic_pip_play,
                pipPlaying ? "השהיה" : "ניגון", PIP_TOGGLE));
        actions.add(pipAction(a, 3, R.drawable.ic_pip_next, "הבא", PIP_NEXT));
        b.setActions(actions);
        // API 31+: the system enters PiP by itself on the home GESTURE — smoother than the
        // onUserLeaveHint fallback, which still covers 26–30 and 3-button navigation.
        // Never under screen pinning: the kiosk's whole point is that HOME goes nowhere.
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(pipEligible && !inLockTaskStatic(a));
        return b.build();
    }

    @androidx.annotation.RequiresApi(26)
    private static android.app.RemoteAction pipAction(Activity a, int req, int icon, String title, String action) {
        // setPackage keeps the broadcast inside this app: below API 33 a context-registered
        // receiver is reachable from outside, and a stranger must not skip the child's track.
        Intent i = new Intent(action).setPackage(a.getPackageName());
        android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(a, req, i,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
        return new android.app.RemoteAction(
                android.graphics.drawable.Icon.createWithResource(a, icon), title, title, pi);
    }

    /** The HOME press (26–30 / 3-button nav): enter the floating window if JS armed it.
     *  On 31+ auto-enter usually beat us here and the redundant call is a harmless no-op. */
    static void maybeEnterPip(Activity a) {
        if (Build.VERSION.SDK_INT < 26 || !pipEligible || !hasPipFeature(a)) return;
        // The OS refuses PiP under screen pinning anyway; refusing here keeps the kiosk
        // decision explicit rather than an OS side effect (and skips a pointless throw).
        if (inLockTaskStatic(a)) return;
        try { a.enterPictureInPictureMode(buildPipParams(a)); }
        catch (Throwable ignored) { /* a refused window = an ordinary backgrounding */ }
    }

    /**
     * MainActivity.onPictureInPictureModeChanged → here. ORDER IS THE CONTRACT: Android
     * fires this BEFORE the onPause that PiP entry causes, and bridge events keep their
     * order — so JS learns "this pause is a shrink, not a backgrounding" before the
     * appStateChange that would otherwise pause the video (the v1.0.32 handler).
     */
    static void onPipModeChanged(Activity a, boolean isIn) {
        pipActive = isIn;
        if (isIn) registerPipReceiver(a);
        else { unregisterPipReceiver(a); pipExitAt = android.os.SystemClock.uptimeMillis(); }
        KidsNativePlugin p = instance;
        if (p != null) {
            JSObject o = new JSObject();
            o.put("active", isIn);
            p.notifyListeners("pipChanged", o, true);
        }
    }

    /** MainActivity.onResume → here: an EXPAND back into the full app (pip → resumed). */
    static void onPipActivityResumed() { pipExitAt = 0L; }

    /**
     * MainActivity.onStop → here. Two shapes mean "the floating window is no longer
     * visible", and JS must bank the spot and fall silent (its onPipHidden door):
     *   - the screen went off OVER the window (onStop arrives with pipActive still true);
     *   - the window was DISMISSED with its X (pipChanged(false), then onStop with no
     *     onResume in between — an EXPAND resumes instead of stopping, which is the tell).
     * No appStateChange fires for either: the activity already paused when PiP began.
     */
    static void onPipActivityStopped() {
        boolean dismissed = !pipActive && pipExitAt > 0
                && android.os.SystemClock.uptimeMillis() - pipExitAt < 2000L;
        if (!pipActive && !dismissed) return;
        pipExitAt = 0L;
        KidsNativePlugin p = instance;
        if (p != null) {
            JSObject o = new JSObject();
            o.put("dismissed", dismissed);
            p.notifyListeners("pipHidden", o, true);
        }
    }

    /** ⏮/⏯/⏭ taps, registered only while the window is up and always unregistered with it. */
    private static android.content.BroadcastReceiver pipReceiver = null;

    private static void registerPipReceiver(Activity a) {
        if (pipReceiver != null) return;
        pipReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String act = intent == null ? null : intent.getAction();
                if (PIP_PREV.equals(act)) emitPlaybackCommand("prev");
                else if (PIP_NEXT.equals(act)) emitPlaybackCommand("next");
                else if (PIP_TOGGLE.equals(act)) emitPlaybackCommand("toggle");
            }
        };
        android.content.IntentFilter f = new android.content.IntentFilter();
        f.addAction(PIP_PREV);
        f.addAction(PIP_TOGGLE);
        f.addAction(PIP_NEXT);
        try {
            if (Build.VERSION.SDK_INT >= 33) a.registerReceiver(pipReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            else a.registerReceiver(pipReceiver, f);
        } catch (Throwable ignored) { pipReceiver = null; }
    }

    private static void unregisterPipReceiver(Activity a) {
        if (pipReceiver == null) return;
        try { a.unregisterReceiver(pipReceiver); } catch (Throwable ignored) {}
        pipReceiver = null;
    }

    /* ---------------- share-intent inbox (F12b) ---------------- */

    private static final ArrayDeque<JSObject> INBOX = new ArrayDeque<>();
    private static KidsNativePlugin instance;

    @Override
    public void load() { instance = this; }

    /** Called from MainActivity for both cold-start and warm onNewIntent deliveries. */
    public static void enqueueShare(String text, String subject) {
        JSObject o = new JSObject();
        o.put("text", text == null ? "" : text);
        o.put("subject", subject == null ? "" : subject);
        o.put("at", System.currentTimeMillis());
        synchronized (INBOX) {
            while (INBOX.size() >= 20) INBOX.pollFirst();
            INBOX.addLast(o);
        }
        KidsNativePlugin p = instance;
        if (p != null) p.notifyListeners("shareReceived", o, true); // retained until consumed
    }

    @PluginMethod
    public void getPendingShares(PluginCall call) {
        JSArray shares = new JSArray();
        synchronized (INBOX) {
            while (!INBOX.isEmpty()) shares.put(INBOX.pollFirst());
        }
        JSObject ret = new JSObject();
        ret.put("shares", shares);
        call.resolve(ret);
    }

    /* ---------------- APK self-update installer (F14) ---------------- */

    /** Advisory only — returns stale false in-process right after the user grants it. */
    @PluginMethod
    public void canInstallPackages(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT < 26
                || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("value", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("no-settings");
        }
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) { call.reject("no-path"); return; }
        // v1.0.36: a PINNED task cannot start the system installer — Android silently
        // refuses new tasks over lock-task mode, so with the kiosk lock ON the update
        // button did nothing (field report). Unpin first, defensively, exactly like
        // exitApp() below: the flow is parent-PIN-gated in JS, and the JS side re-arms
        // the pin on resume when the install is cancelled. The unpin and the installer
        // launch ride ONE UI-thread hop, or the intent could race ahead of the unpin.
        Activity a = getActivity();
        if (a != null && inLockTask()) {
            a.runOnUiThread(() -> {
                try { a.stopLockTask(); } catch (Exception ignored) {}
                startInstaller(call, path);
            });
            return;
        }
        startInstaller(call, path);
    }

    private void startInstaller(PluginCall call, String path) {
        Context ctx = getContext();
        try {
            File apk = new File(path);
            if (!apk.exists()) { call.reject("file-missing"); return; }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW); // ACTION_INSTALL_PACKAGE is deprecated since API 29
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject("fileprovider-path-not-configured"); // the #1 misconfig — name it clearly
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("no-installer");
        } catch (Exception e) {
            call.reject("install-failed: " + e.getMessage());
        }
    }

    /* ---------------- device credential (v1.0.26, parent-code recovery) ---------------- */
    // The FAST path back in when a parent forgets the code: fingerprint, or the device's
    // own lock PIN/pattern/password. It proves "an adult who administers this device" —
    // which is the only identity claim this app can honestly check offline.
    //
    // The 24-hour wait in recovery.js is the FLOOR under this and must stay: a child's
    // tablet frequently has no lock screen at all, Android TV never does, and the prompt
    // can legitimately be unavailable. Every failure here therefore reports rather than
    // throws, and the JS side falls back to the wait — a broken prompt must never become
    // either an open door or a locked one.
    //
    // BIOMETRIC_WEAK (not STRONG) is deliberate: we are gating a UI screen, not unwrapping
    // a crypto key, and STRONG needlessly excludes perfectly good face/fingerprint sensors.
    // DEVICE_CREDENTIAL is what makes it work on a device with nothing enrolled. When
    // DEVICE_CREDENTIAL is allowed, setNegativeButtonText MUST NOT be set (the library
    // throws) — the credential fallback IS the negative button.

    private static int authenticators() {
        return androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
                | androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    }

    /** Can this device prove an adult is present? -> { available, reason }. Never rejects. */
    @PluginMethod
    public void canDeviceAuth(PluginCall call) {
        JSObject ret = new JSObject();
        String reason = "unknown";
        boolean ok = false;
        try {
            int status = androidx.biometric.BiometricManager.from(getContext())
                    .canAuthenticate(authenticators());
            switch (status) {
                case androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS:
                    ok = true; reason = "ok"; break;
                case androidx.biometric.BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                    // No lock screen and no biometric — the common children's-tablet case,
                    // and exactly why the wait exists.
                    reason = "none-enrolled"; break;
                case androidx.biometric.BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                    reason = "no-hardware"; break;
                case androidx.biometric.BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                    reason = "hw-unavailable"; break;
                default:
                    reason = "unsupported-" + status; break;
            }
        } catch (Throwable t) {
            // A missing class or an API-level quirk must read as "use the wait", never crash.
            reason = "error";
        }
        ret.put("available", ok);
        ret.put("reason", reason);
        call.resolve(ret);
    }

    /**
     * Show the prompt. Resolves { ok, reason } — it does NOT reject, because "the parent
     * cancelled" is an ordinary outcome here, not an error.
     */
    @PluginMethod
    public void deviceAuth(PluginCall call) {
        final String title = call.getString("title", "אימות הורה");
        final String subtitle = call.getString("subtitle", "");
        Activity a = getActivity();
        if (!(a instanceof androidx.fragment.app.FragmentActivity)) {
            // BridgeActivity is an AppCompatActivity, so this cannot happen today — but a
            // silent ClassCastException here would look exactly like "the fingerprint
            // reader is broken" to a locked-out parent.
            resolveAuth(call, false, "no-fragment-activity");
            return;
        }
        final androidx.fragment.app.FragmentActivity fa = (androidx.fragment.app.FragmentActivity) a;
        fa.runOnUiThread(() -> {
            try {
                androidx.biometric.BiometricPrompt prompt = new androidx.biometric.BiometricPrompt(
                        fa,
                        androidx.core.content.ContextCompat.getMainExecutor(fa),
                        new androidx.biometric.BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(
                                    androidx.biometric.BiometricPrompt.AuthenticationResult result) {
                                resolveAuth(call, true, "ok");
                            }
                            @Override
                            public void onAuthenticationError(int code, CharSequence msg) {
                                // Includes the user cancelling and the "too many attempts"
                                // lockout. Both mean: fall back to the wait.
                                resolveAuth(call, false, "error-" + code);
                            }
                            // onAuthenticationFailed = one bad finger; the prompt stays up
                            // and the user may retry, so it is deliberately not terminal.
                        });

                androidx.biometric.BiometricPrompt.PromptInfo.Builder b =
                        new androidx.biometric.BiometricPrompt.PromptInfo.Builder()
                                .setTitle(title)
                                .setAllowedAuthenticators(authenticators());
                if (subtitle != null && !subtitle.isEmpty()) b.setSubtitle(subtitle);
                prompt.authenticate(b.build());
            } catch (Throwable t) {
                resolveAuth(call, false, "prompt-failed");
            }
        });
    }

    /** One resolve per call — a prompt can report twice, and Capacitor would throw. */
    private void resolveAuth(PluginCall call, boolean ok, String reason) {
        synchronized (authLock) {
            if (authSettled.contains(call.getCallbackId())) return;
            authSettled.add(call.getCallbackId());
        }
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        ret.put("reason", reason);
        call.resolve(ret);
    }

    private final Object authLock = new Object();
    private final java.util.Set<String> authSettled = new java.util.HashSet<>();
}
