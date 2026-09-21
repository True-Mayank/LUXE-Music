# LUXE Music — Native Android Playback

LUXE Music is an offline Android music player using the existing WebView UI with a **real native Android playback service**.

## Native playback features

- Real Android `MediaPlayer` playback service
- Foreground media playback service
- Background playback
- Screen-lock playback
- Automatic next-song playback after a track ends
- Repeat-current-song support
- Android MediaSession
- Lock-screen Play / Pause / Previous / Next
- Notification player with song title and artist
- Bluetooth/headset media-button controls through MediaSession
- Seek support from the LUXE progress bar and system media controls
- Native playback state synchronized back to the LUXE UI

The HTML `<audio>` element is still used for browser/LUXE web playback, but **Android no longer depends on WebView autoplay for native playback**.

## Android project structure

```text
app/src/main/
├── AndroidManifest.xml
├── assets/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── android-folder-picker.js
├── java/com/luxe/music/
│   ├── MainActivity.java
│   └── PlaybackKeepAliveService.java
└── res/values/styles.xml
```

`PlaybackKeepAliveService.java` is now the actual native playback engine. The filename is retained so the existing LUXE Android bridge/package structure does not need to be reorganized.

## Build

The project uses:

- compileSdk 35
- targetSdk 35
- minSdk 23
- Android Gradle Plugin 8.7.3
- Gradle 8.10.2 in the GitHub Actions workflow

GitHub Actions builds the debug APK with:

```text
gradle assembleDebug
```

The APK is uploaded as the `LUXE-Music-Debug-APK` workflow artifact.

## Music storage

LUXE uses Android's Storage Access Framework folder picker. Music is not copied into the application. The selected folder URI is persisted and audio files are streamed through the native Android bridge.
