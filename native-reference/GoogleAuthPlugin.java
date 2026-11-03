package com.assaf.kidsplayer;

// Kids Player — Google Drive authorization via Play Services AuthorizationClient.
// WHY this API (and not GoogleSignIn / AppAuth / WebView OAuth):
//  - No refresh token exists on the device: every authorize() call returns a fresh
//    ~1h access token silently once the user consented ONCE in the system UI. The
//    "Testing-mode consent revokes refresh tokens every 7 days" problem cannot occur.
//  - No client secret ships in the APK (Android OAuth clients have none).
//  - WebView OAuth is blocked by Google (disallowed_useragent); custom-URI-scheme
//    redirects are being closed for new Android clients. This is the supported path.
// Requires: com.google.android.gms:play-services-auth (added in release/android-release.gradle)
// and an Android OAuth client in Google Cloud matching package + signing SHA-1
// (one per signing key: release / debug .dev — see GOOGLE_CLOUD_SETUP.md).

import android.content.Intent;
import android.content.IntentSender;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import java.util.Arrays;
import java.util.List;

@CapacitorPlugin(name = "KidsGoogleAuth", requestCodes = { GoogleAuthPlugin.REQ_AUTHORIZE })
public class GoogleAuthPlugin extends Plugin {

    static final int REQ_AUTHORIZE = 7834;
    // v1.0.19 — drive.file ONLY, and that is a deliberate product decision.
    //
    // `spreadsheets` is classified SENSITIVE by Google, and it alone was what put
    // the "Google hasn't verified this app" warning in front of every parent. Its
    // removal is why the app now writes only to sheets IT created: drive.file grants
    // per-file access to exactly those, which covers spreadsheets.create,
    // values.get/append and batchUpdate on them. A sheet the parent made themselves
    // and pasted a link to is NOT covered (403 appNotAuthorizedToFile), which is
    // precisely why the paste-a-link option was removed from the UI.
    //
    // Escaping the warning by verification instead was not available: Google requires
    // a DNS-level Search Console Domain Property, and the site is on github.io whose
    // DNS we do not control.
    //
    // ⚠️ Do NOT re-add `spreadsheets` to make a pasted sheet work — it brings the
    // warning screen back for everyone. drive.file is non-sensitive and needs no
    // verification at all.
    private static final List<Scope> SCOPES = Arrays.asList(
            new Scope("https://www.googleapis.com/auth/drive.file"));

    private PluginCall pendingCall;

    /**
     * authorize({ interactive }) -> { granted, accessToken?, needsUi? }
     * interactive=false NEVER pops UI (background token refresh must not interrupt
     * a child mid-video) — it resolves { granted:false, needsUi:true } instead.
     */
    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", true));
        AuthorizationRequest req = AuthorizationRequest.builder().setRequestedScopes(SCOPES).build();
        Identity.getAuthorizationClient(getActivity())
                .authorize(req)
                .addOnSuccessListener(result -> {
                    if (!result.hasResolution()) {
                        resolveWithResult(call, result);
                        return;
                    }
                    if (!interactive) {
                        JSObject r = new JSObject();
                        r.put("granted", false);
                        r.put("needsUi", true);
                        call.resolve(r);
                        return;
                    }
                    try {
                        pendingCall = call;
                        // v1.0.95: the Play Services consent is its own activity — flag it as
                        // a deliberate departure so the TV kiosk watchdog never yanks it away.
                        KidsNativePlugin.noteLegitLeave();
                        getActivity().startIntentSenderForResult(
                                result.getPendingIntent().getIntentSender(),
                                REQ_AUTHORIZE, null, 0, 0, 0);
                    } catch (IntentSender.SendIntentException e) {
                        pendingCall = null;
                        call.reject("consent-ui-failed");
                    }
                })
                .addOnFailureListener(e -> {
                    // Surface the Play Services status code so the UI can tell a parent
                    // exactly what's wrong: 10 = DEVELOPER_ERROR — the app isn't registered
                    // in Google Cloud (missing OAuth client / wrong signing SHA-1).
                    String code = "unknown";
                    if (e instanceof com.google.android.gms.common.api.ApiException) {
                        code = String.valueOf(((com.google.android.gms.common.api.ApiException) e).getStatusCode());
                    }
                    call.reject("auth-unavailable:" + code);
                });
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_AUTHORIZE || pendingCall == null) return;
        PluginCall call = pendingCall;
        pendingCall = null;
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity())
                    .getAuthorizationResultFromIntent(data);
            resolveWithResult(call, result);
        } catch (Exception e) {
            JSObject r = new JSObject();
            r.put("granted", false);
            call.resolve(r); // user declined — not an error
        }
    }

    private void resolveWithResult(PluginCall call, AuthorizationResult result) {
        JSObject r = new JSObject();
        String token = result.getAccessToken();
        r.put("granted", token != null);
        if (token != null) r.put("accessToken", token);
        call.resolve(r);
    }

    /** Play Services availability probe (a de-Googled tablet loses Drive sync only). */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        try {
            r.put("available", com.google.android.gms.common.GoogleApiAvailability.getInstance()
                    .isGooglePlayServicesAvailable(getContext())
                    == com.google.android.gms.common.ConnectionResult.SUCCESS);
        } catch (Exception e) {
            r.put("available", false);
        }
        call.resolve(r);
    }
}
