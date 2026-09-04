# LUXE Music Android Native Folder Picker

This is a small Android WebView wrapper proving the native folder-selection path needed by LUXE.

## What already works

- `SELECT MUSIC FOLDER` opens Android's system folder picker (`ACTION_OPEN_DOCUMENT_TREE`).
- Android retains read permission to the selected directory where the provider allows persistable access.
- Only audio files directly inside the chosen folder are scanned (no subfolders, matching the original LUXE requirement).
- The selected audio files are streamed to the WebView using `https://luxe.local/audio/<token>` URLs. Music is **not copied** into the app.
- The saved folder is rescanned automatically on later launches.
- The included test UI can play a selected track.

## Build

1. Open this folder in Android Studio.
2. Let Gradle sync.
3. Run on an Android phone/emulator, or Build > Build APK(s).

The project uses minSdk 23 and target/compile SDK 35.

## Merge with full LUXE V4

Copy your real `index.html`, `style.css`, and `app.js` into:

`app/src/main/assets/`

Keep `android-folder-picker.js` and add this line **before** your normal `app.js`:

```html
<script src="android-folder-picker.js"></script>
<script src="app.js"></script>
```

In the APK, the helper intercepts `#chooseFolderBtn` and calls Android's native picker instead of `webkitdirectory`.

Your full LUXE `app.js` must also listen for the `luxe:native-library` event and use the returned `song.url` for playback. The included demo `app.js` shows the event format.

Payload example:

```js
window.addEventListener("luxe:native-library", event => {
  console.log(event.detail.songs);
});
```

Each song contains:

- `id`
- `name`
- `title`
- `artist`
- `album`
- `mime`
- `size`
- `lastModified`
- `url` (streamable URL for `<audio>`)

## Why this is necessary

A normal HTML `webkitdirectory` input depends on the WebView wrapper and cannot force Android's native directory picker. The Android Storage Access Framework provides the system directory picker and URI grants required for reliable folder access.
