package com.assaf.kidsplayer;

// Kids Player — v1.0.63: KEEP PLAYING WHEN THE SCREEN GOES OFF (user request).
//
// This is the app's FIRST service, and it takes the manifest from two permissions to five.
// That cost is the whole reason the feature is opt-in, per profile, and OFF unless a parent
// turns it on: a family that never opens the setting gains no service and no notification.
//
// WHY A FOREGROUND SERVICE AT ALL. Android stops a backgrounded app's media unless it is
// tied to a foreground service of type mediaPlayback. There is no lighter mechanism — a
// wake lock keeps the CPU awake but does not stop the WebView being frozen.
//
// ⚠️ IT IS STARTED WHILE THE APP IS STILL FOREGROUND, NEVER FROM onAppPause. Since API 31
// an app in the background may not start a foreground service at all (ForegroundService-
// StartNotAllowedException), and `onAppPause` is already too late on some OEMs. So JS starts
// it when an eligible video BEGINS PLAYING — which is also why the notification appears
// during ordinary viewing: it is the control, and every media app behaves this way.
//
// ⚠️ THE NOTIFICATION IS A SURFACE A CHILD CAN REACH FROM THE LOCK SCREEN, including on a
// kiosk-locked tablet. It carries exactly three actions — previous, play/pause, next — and
// no way to open the app or leave it. Adding a content intent here would be a hole in the
// containment lock (v1.0.56), which is why there deliberately is none.
//
// Canonical copy: native-reference/PlaybackService.java — keep both in sync.

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import android.view.KeyEvent;

public class PlaybackService extends Service {

    public static final String ACTION_START = "com.assaf.kidsplayer.PLAYBACK_START";
    public static final String ACTION_STOP  = "com.assaf.kidsplayer.PLAYBACK_STOP";
    // v1.0.68 — ⏪10 / ⏯ / ⏩10 (user request, replacing skip-track). The library is mostly
    // long recordings, where moving inside the track is what a parent actually needs; the
    // step is SEEK_STEP, the same 10 seconds a double-tap on the video gives, so the
    // notification and the screen never disagree about what a skip means.
    public static final String ACTION_BACK  = "com.assaf.kidsplayer.PLAYBACK_BACK10";
    public static final String ACTION_TOGGLE = "com.assaf.kidsplayer.PLAYBACK_TOGGLE";
    public static final String ACTION_FWD   = "com.assaf.kidsplayer.PLAYBACK_FWD10";

    private static final String CHANNEL_ID = "kids_playback";
    private static final int NOTIFICATION_ID = 4711;

    // v1.0.65 — A REAL MediaSession, not just a notification (user request: control the
    // music from the car). Framework MediaSession, API 21+, so it costs NO new dependency:
    // androidx.media would have pulled a library in for something the platform already has.
    //
    // What it buys, none of which a plain Notification can do:
    //   • the car's steering-wheel and head-unit buttons over Bluetooth — media button
    //     events are routed to whichever session is ACTIVE, and nowhere else;
    //   • the standard lock-screen media widget instead of a custom notification;
    //   • the track name and progress on the car display, extrapolated by the system from
    //     the position + speed we publish, so we need not tick every second.
    //
    // ⚠️ It is ALSO the exact prerequisite Android Auto requires. Auto talks only to a
    // MediaBrowserService/MediaLibraryService fronted by a session like this one, so this
    // work is a foundation rather than a detour — but a session ALONE does not put the app
    // on the car screen, and nothing here should be read as claiming otherwise.
    private MediaSession session;

    // v1.0.66 — the artwork shown as the notification's large icon, on the lock-screen
    // widget and on a car display. It arrives from JS as base64 because the picture lives in
    // IndexedDB INSIDE the WebView, which native code cannot open — the same wall that makes
    // full Android Auto a second playback engine (v1.0.65).
    //
    // Cached against the string it was decoded from, so a play/pause tap does not re-decode
    // a bitmap that has not changed; a track change brings new bytes and a new decode.
    private Bitmap artwork;
    private String artworkKey;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private MediaSession ensureSession() {
        if (session != null) return session;
        try {
            session = new MediaSession(this, "KidsPlayer");
            session.setCallback(new MediaSession.Callback() {
                // v1.0.88 — A HEADSET'S ANSWER BUTTON PAUSES/RESUMES, INSTANTLY (user request:
                // "לחיצה על כפתור ענה בדיבורית תתחיל ניגון או תעצור בהתאמה").
                //
                // The dispatch is OURS now, not the framework default's, for three reasons:
                //  1. The default DELAYS every single press by the double-tap window (it waits
                //     to see whether a second press makes it a "next") — a pause button that
                //     answers half a second late reads as broken.
                //  2. The default picks the toggle DIRECTION from the session's LAST PUBLISHED
                //     PlaybackState, which rides an async JS→bridge republish; a press landing
                //     inside that window is dispatched off a stale state. JS decides from the
                //     LIVE player instead (playerlogic.transportIntent).
                //  3. Owning it removes the dependence on per-OEM default-dispatch behaviour.
                //
                // THE COST, deliberate: a single-button headset's double-press no longer skips
                // a track (it is now pause+resume) — instant, deterministic toggling is the
                // user's explicit ask, and headsets with dedicated ⏮/⏭ keys keep the track skip.
                //
                // The stateless keys (HEADSETHOOK, PLAY_PAUSE) emit "toggle"; the DIRECTIONAL
                // keys emit "play"/"pause", which JS honours only when they CHANGE the state —
                // an explicit PAUSE to an already-paused video must never resume it. Emitted on
                // the DOWN with repeatCount 0 only (a held button auto-repeats — the dpad.js
                // lesson), and the WHOLE key stream of these codes is consumed so the framework
                // default cannot double-handle the same press. Every other key (NEXT/PREVIOUS/
                // REWIND/FAST_FORWARD) falls through to super, which routes it to the
                // callbacks below exactly as before.
                @Override public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
                    try {
                        KeyEvent ke = mediaButtonIntent == null
                            ? null : (KeyEvent) mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                        if (ke != null) {
                            int code = ke.getKeyCode();
                            boolean isToggleKey = code == KeyEvent.KEYCODE_HEADSETHOOK
                                || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
                            boolean isDirectionalKey = code == KeyEvent.KEYCODE_MEDIA_PLAY
                                || code == KeyEvent.KEYCODE_MEDIA_PAUSE;
                            if (isToggleKey || isDirectionalKey) {
                                if (ke.getAction() == KeyEvent.ACTION_DOWN && ke.getRepeatCount() == 0) {
                                    KidsNativePlugin.emitPlaybackCommand(isToggleKey ? "toggle"
                                        : code == KeyEvent.KEYCODE_MEDIA_PLAY ? "play" : "pause");
                                }
                                return true; // consume UP/repeats too — no double-handling
                            }
                        }
                    } catch (Throwable ignored) {}
                    return super.onMediaButtonEvent(mediaButtonIntent);
                }
                // v1.0.88 — the transport callbacks (an external controller's EXPLICIT commands,
                // e.g. a watch UI, a car's resume-after-navigation) are DIRECTIONAL now. They
                // all used to emit "toggle", so PAUSE while paused RESUMED and — worst — STOP
                // while paused STARTED the video. onStop maps to "pause": this player has no
                // teardown-by-controller, and stopping must never start sound.
                @Override public void onPlay() { KidsNativePlugin.emitPlaybackCommand("play"); }
                @Override public void onPause() { KidsNativePlugin.emitPlaybackCommand("pause"); }
                @Override public void onStop() { KidsNativePlugin.emitPlaybackCommand("pause"); }
                @Override public void onRewind() { KidsNativePlugin.emitPlaybackCommand("back"); }
                @Override public void onFastForward() { KidsNativePlugin.emitPlaybackCommand("fwd"); }
                // the lock screen's and the car's ⏪10/⏩10 — the custom actions published above
                @Override public void onCustomAction(String action, android.os.Bundle extras) {
                    if (ACTION_BACK.equals(action)) KidsNativePlugin.emitPlaybackCommand("back");
                    else if (ACTION_FWD.equals(action)) KidsNativePlugin.emitPlaybackCommand("fwd");
                }
                // v1.0.84 — a Bluetooth headset/watch/car's own ⏮/⏭ KEYS change the TRACK (the
                // user's request, "להעביר שירים"). Still not DRAWN on the lock screen or the car
                // (those keep the ±10s custom actions above — the library is mostly long
                // recordings), but a physical media button changes the song. JS owns which
                // track is next — gifts skipped, no wrap, the same order the grid shows.
                @Override public void onSkipToNext() { KidsNativePlugin.emitPlaybackCommand("next"); }
                @Override public void onSkipToPrevious() { KidsNativePlugin.emitPlaybackCommand("prev"); }
            });
            if (Build.VERSION.SDK_INT < 26) {
                // Pre-Oreo needs these flags for the session to receive media buttons and
                // transport controls at all; from 26 they are implied and deprecated.
                session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            }
        } catch (Throwable ignored) { session = null; }
        return session;
    }

    /**
     * Publish what is playing and where it is. The system EXTRAPOLATES the position from the
     * speed we set, so a car's progress bar advances without us ticking every second — which
     * on a child's tablet is a bridge call and a wake-up we do not need to pay for.
     */
    /**
     * base64 -> Bitmap, or null. TOTAL: a picture is a nicety and must never take the
     * service down — a truncated string, an unsupported format or an image too large for
     * the heap all end as "no artwork", and the app icon takes its place.
     */
    private Bitmap decodeArtwork(String b64) {
        if (b64 == null || b64.isEmpty()) { artwork = null; artworkKey = null; return null; }
        if (b64.equals(artworkKey) && artwork != null) return artwork;
        try {
            byte[] raw = Base64.decode(b64, Base64.DEFAULT);
            BitmapFactory.Options o = new BitmapFactory.Options();
            // A notification icon is displayed small; decoding a 4K frame at full size would
            // be megabytes of heap on a cheap tablet for something ~128dp wide.
            o.inSampleSize = raw.length > 400_000 ? 4 : raw.length > 120_000 ? 2 : 1;
            Bitmap bm = BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
            artwork = bm;
            artworkKey = bm == null ? null : b64;
            return bm;
        } catch (Throwable ignored) { artwork = null; artworkKey = null; return null; }
    }

    private void publishSession(String title, String subtitle, boolean playing, long posMs, long durMs) {
        MediaSession s = ensureSession();
        if (s == null) return;
        try {
            MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title == null ? "" : title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle == null ? "" : subtitle)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title == null ? "" : title)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, subtitle == null ? "" : subtitle);
            if (durMs > 0) md.putLong(MediaMetadata.METADATA_KEY_DURATION, durMs);
            // ALBUM_ART is what a CAR display and the lock-screen widget read; the
            // notification's own large icon is set separately below. Two surfaces again.
            if (artwork != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
            s.setMetadata(md.build());
            // The ACTIONS are what a car renders as buttons — the notification's own actions
            // do not reach it. Both lists must agree or the two surfaces disagree.
            // ⚠️ THE LOCK SCREEN AND THE CAR DRAW THE SESSION'S ACTIONS, NEVER THE
            // NOTIFICATION'S. v1.0.69 gave the notification its ring-with-10 icons and the
            // lock screen still showed the system's ⏮/⏭ triangles — reported from a device —
            // because SKIP_TO_NEXT/PREVIOUS were advertised here and the system draws those
            // with its OWN glyphs. They are gone: a standard action can only ever wear a
            // standard icon.
            //
            // CUSTOM ACTIONS are the one mechanism that carries our own drawable onto those
            // surfaces, so ⏪10/⏩10 are published as custom actions and handled in
            // onCustomAction below.
            PlaybackState.Builder st = new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP
                    // v1.0.84 → v1.0.85 FIELD FIX. SKIP is advertised so an EXTERNAL CONTROLLER
                    // (a smartWATCH, a car head unit) actually SENDS next/previous: a
                    // MediaController shows and sends only the actions the session ADVERTISES.
                    // v1.0.70 removed these on the belief that "hardware buttons arrive
                    // regardless of advertising" — true for a wired headset's KEY event, but NOT
                    // for a watch controller: a device reported pause working and skip doing
                    // nothing. The ±10 SEEK stays a CUSTOM action (its ring icon, the v1.0.70
                    // fix), and the skip triangles the system draws for these now correctly
                    // CHANGE TRACK — which is exactly what the user asked the watch to do.
                    | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    // kept so a steering wheel's own ⏪/⏩ keys still reach us
                    | PlaybackState.ACTION_REWIND | PlaybackState.ACTION_FAST_FORWARD)
                .addCustomAction(new PlaybackState.CustomAction.Builder(
                    ACTION_BACK, "10 שניות אחורה", R.drawable.ic_seek_back_10).build())
                .addCustomAction(new PlaybackState.CustomAction.Builder(
                    ACTION_FWD, "10 שניות קדימה", R.drawable.ic_seek_fwd_10).build())
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                    Math.max(0, posMs), playing ? 1.0f : 0f);
            s.setPlaybackState(st.build());
            s.setActive(true);   // media buttons reach only an ACTIVE session
        } catch (Throwable ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            releaseSession();
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }
        // A button on the notification: hand it to JS, which owns every playback decision
        // (which video is next, whether it is a gift, whether the folder has run out). The
        // service deliberately knows none of that — one answer, in one place.
        if (ACTION_BACK.equals(action) || ACTION_TOGGLE.equals(action) || ACTION_FWD.equals(action)) {
            String cmd = ACTION_BACK.equals(action) ? "back" : ACTION_FWD.equals(action) ? "fwd" : "toggle";
            KidsNativePlugin.emitPlaybackCommand(cmd);
            return START_NOT_STICKY;
        }
        String title = intent == null ? null : intent.getStringExtra("title");
        String subtitle = intent == null ? null : intent.getStringExtra("subtitle");
        boolean playing = intent == null || intent.getBooleanExtra("playing", true);
        long posMs = intent == null ? 0 : intent.getLongExtra("posMs", 0);
        long durMs = intent == null ? 0 : intent.getLongExtra("durMs", 0);
        decodeArtwork(intent == null ? null : intent.getStringExtra("artB64"));
        publishSession(title, subtitle, playing, posMs, durMs);
        startForegroundCompat(buildNotification(title, subtitle, playing));
        // NOT sticky: a service the SYSTEM restarts after killing the app would resume a
        // notification for a video no longer playing, with a JS side that no longer exists.
        return START_NOT_STICKY;
    }

    private void startForegroundCompat(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable ignored) {
            // API 31+ can refuse the start outright, and API 33+ can have POST_NOTIFICATIONS
            // denied. Never crash the app over a convenience: the video simply pauses on
            // background as it did before this feature existed.
        }
    }

    private void releaseSession() {
        MediaSession s = session;
        session = null;
        if (s == null) return;
        try { s.setActive(false); s.release(); } catch (Throwable ignored) {}
    }

    @Override
    public void onDestroy() {
        // A session that outlives its service keeps taking the car's media buttons for a
        // video that is not playing — the "control for a dead video" this feature avoids
        // everywhere else.
        releaseSession();
        super.onDestroy();
    }

    private void stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Throwable ignored) {}
    }

    private PendingIntent commandIntent(String action, int requestCode) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, requestCode, i, flags);
    }

    private Notification buildNotification(String title, String subtitle, boolean playing) {
        ensureChannel();
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        b.setContentTitle(title == null || title.isEmpty() ? getString(R.string.app_name) : title)
         .setContentText(subtitle == null || subtitle.isEmpty() ? getString(R.string.app_name) : subtitle)
         // v1.0.66 — the app's OWN mark instead of the generic system play glyph, so the
         // row is identifiable at a glance in a crowded shade (user request, with a
         // screenshot of it sitting anonymously under Spotify's).
         .setSmallIcon(R.drawable.ic_notification)
         .setOngoing(true)
         .setShowWhen(false);
        if (Build.VERSION.SDK_INT >= 21) b.setVisibility(Notification.VISIBILITY_PUBLIC);
        // The big square picture. Absent for most audio files — captureFrame cannot take a
        // frame from a track with no video — so JS falls back to the FOLDER's picture, and
        // the system falls back to the app icon when there is neither.
        if (artwork != null) b.setLargeIcon(artwork);
        // ⚠️ NO setContentIntent: tapping the notification must not open (or re-open) the
        // app. Under a containment lock that would be a way out of a locked folder, and on
        // a kiosk tablet a way back into a session the parent ended.
        b.addAction(new Notification.Action.Builder(
                R.drawable.ic_seek_back_10, "10 שניות אחורה", commandIntent(ACTION_BACK, 1)).build());
        b.addAction(new Notification.Action.Builder(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "השהיה" : "ניגון", commandIntent(ACTION_TOGGLE, 2)).build());
        b.addAction(new Notification.Action.Builder(
                R.drawable.ic_seek_fwd_10, "10 שניות קדימה", commandIntent(ACTION_FWD, 3)).build());
        if (Build.VERSION.SDK_INT >= 21) {
            Notification.MediaStyle style = new Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2);
            // Handing the session token to MediaStyle is what turns this from a custom
            // notification into the SYSTEM media notification — and it is what puts the
            // standard widget on the lock screen.
            MediaSession s = ensureSession();
            if (s != null) style.setMediaSession(s.getSessionToken());
            b.setStyle(style);
        }
        return b.build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        // IMPORTANCE_LOW: the control must be reachable, but a media notification that
        // makes a sound or vibrates every time a song changes is a tablet that wakes a
        // sleeping child up.
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "ניגון", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }
}
