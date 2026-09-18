# LUXE Music V14 — Android Lock-Screen + Notification Controls

This update adds a native Android MediaSession and media-style foreground notification.

## Controls
- Previous
- Play / Pause
- Next
- Song title + artist
- Android lock-screen media controls
- Android notification player
- Media buttons/headset controls where Android exposes them

## Files
- `app.js` — sends the current LUXE playback state to Android.
- `MainActivity.java` — bridges WebView playback commands to the native MediaSession service.
- `PlaybackKeepAliveService.java` — owns the MediaSession and media-style notification.
- `AndroidManifest.playback-permissions.xml` — permissions/service declaration to merge into the real AndroidManifest.

## Important
The actual audio engine is still LUXE's existing HTML audio element. This update makes Android's lock screen and notification controls operate that player through the native bridge. A later true Media3/ExoPlayer migration would be a separate architectural upgrade.

If the Android project already contains the V13 playback service, replace it with the V14 version in this package.
