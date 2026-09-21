package com.luxe.music;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.content.SharedPreferences;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.Manifest;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.lang.ref.WeakReference;

public class MainActivity extends Activity {

    private static WeakReference<MainActivity> activeInstance;

    private static final int PICK_MUSIC_FOLDER = 7001;
    private static final String PREFS = "luxe_native_storage";
    private static final String PREF_TREE_URI = "music_tree_uri";
    private static final String AUDIO_HOST = "luxe.local";
    private static final String CACHE_FILE = "luxe_native_library.json";

    private WebView webView;
    private boolean pageReady = false;
    private boolean restoreStarted = false;
    private boolean scanInProgress = false;
    private final Map<String, Uri> audioUriMap = new HashMap<>();

    private final BroadcastReceiver playbackReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context context, Intent intent) {
            if (!PlaybackKeepAliveService.ACTION_STATE.equals(intent.getAction())) return;
            if (webView == null) return;

            try {
                JSONObject state = new JSONObject();
                state.put("id", intent.getStringExtra("id"));
                state.put("title", intent.getStringExtra("title"));
                state.put("artist", intent.getStringExtra("artist"));
                state.put("playing", intent.getBooleanExtra("playing", false));
                state.put("position", intent.getLongExtra("position", 0L));
                state.put("duration", intent.getLongExtra("duration", 0L));
                state.put("queueIndex", intent.getIntExtra("queueIndex", -1));
                state.put("queueSize", intent.getIntExtra("queueSize", 0));

                // Pass the JSON object itself to JavaScript, not a quoted JSON string.
                // Quoting the whole payload makes JS receive a string, so state.id,
                // state.position and state.duration are undefined and the LUXE
                // full-player progress UI cannot update or seek correctly.
                String json = state.toString();
                runOnUiThread(() -> webView.evaluateJavascript(
                        "if(window.LuxeAndroidNativeState)window.LuxeAndroidNativeState(" + json + ");",
                        null
                ));
            } catch (Exception ignored) {}
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeInstance = new WeakReference<>(this);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(9, 9, 11));
        setContentView(webView);

        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 8201);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        webView.addJavascriptInterface(new AndroidBridge(), "LuxeAndroid");

        IntentFilter playbackFilter = new IntentFilter(PlaybackKeepAliveService.ACTION_STATE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(playbackReceiver, playbackFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(playbackReceiver, playbackFilter);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();

                if (AUDIO_HOST.equals(url.getHost()) &&
                        url.getPath() != null &&
                        url.getPath().startsWith("/audio/")) {

                    String token = url.getLastPathSegment();
                    Uri source;

                    synchronized (audioUriMap) {
                        source = audioUriMap.get(token);
                    }

                    if (source != null) {
                        try {
                            InputStream stream = getContentResolver().openInputStream(source);
                            if (stream != null) {
                                String mime = getContentResolver().getType(source);
                                if (mime == null || mime.isEmpty()) mime = "audio/mpeg";
                                return new WebResourceResponse(mime, null, stream);
                            }
                        } catch (Exception ignored) {}
                    }

                    return new WebResourceResponse(
                            "text/plain",
                            "UTF-8",
                            404,
                            "Not Found",
                            null,
                            new ByteArrayInputStream("Audio unavailable".getBytes(StandardCharsets.UTF_8))
                    );
                }

                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageReady = true;
                if (!restoreStarted) {
                    restoreStarted = true;
                    restoreSavedFolder();
                    PlaybackKeepAliveService.requestState(MainActivity.this);
                }
            }
        });

        webView.loadUrl("file:///android_asset/index.html");
    }

    /**
     * Called by the foreground playback service when Android/lock-screen
     * media controls are pressed.
     */
    public static void sendPlaybackCommand(String command) {
        MainActivity activity = activeInstance == null ? null : activeInstance.get();
        if (activity == null || activity.webView == null || command == null) return;

        activity.runOnUiThread(() -> {
            try {
                String js;

                switch (command) {
                    case "play":
                        js = "(function(){var a=document.getElementById('audio');if(a){var p=a.play();if(p&&p.catch)p.catch(function(){});}})();";
                        break;

                    case "pause":
                        js = "(function(){var a=document.getElementById('audio');if(a)a.pause();})();";
                        break;

                    case "next":
                        js = "(function(){if(typeof window.playNext==='function')window.playNext();})();";
                        break;

                    case "previous":
                        js = "(function(){if(typeof window.playPrevious==='function')window.playPrevious();})();";
                        break;

                    default:
                        if (command.startsWith("seek:")) {
                            String value = command.substring(5);
                            js = "(function(){var a=document.getElementById('audio');if(a)a.currentTime=" + value + "/1000;})();";
                        } else {
                            return;
                        }
                }

                activity.webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {}
        });
    }

    public class AndroidBridge {
        @JavascriptInterface
        public void pickMusicFolder() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION |
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
                        Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                );
                startActivityForResult(intent, PICK_MUSIC_FOLDER);
            });
        }

        @JavascriptInterface
        public boolean isAndroidNative() {
            return true;
        }

        @JavascriptInterface
        public void rescanMusicFolder() {
            runOnUiThread(() -> restoreSavedFolder());
        }

        @JavascriptInterface
        public void nativePlayQueue(String queueJson, int index, boolean repeatMode) {
            try {
                JSONArray input = new JSONArray(queueJson == null ? "[]" : queueJson);
                JSONArray output = new JSONArray();

                for (int i = 0; i < input.length(); i++) {
                    JSONObject item = input.optJSONObject(i);
                    if (item == null) continue;

                    String url = item.optString("url", "");
                    String token = extractAudioToken(url);
                    Uri source = null;
                    if (token != null) {
                        synchronized (audioUriMap) {
                            source = audioUriMap.get(token);
                        }
                    }
                    if (source == null) continue;

                    JSONObject nativeItem = new JSONObject();
                    nativeItem.put("id", item.optString("id", ""));
                    nativeItem.put("title", item.optString("title", "Unknown Title"));
                    nativeItem.put("artist", item.optString("artist", "Unknown Artist"));
                    nativeItem.put("uri", source.toString());
                    output.put(nativeItem);
                }

                Intent service = new Intent(MainActivity.this, PlaybackKeepAliveService.class);
                service.setAction(PlaybackKeepAliveService.ACTION_PLAY_QUEUE);
                service.putExtra("queue", output.toString());
                service.putExtra("index", Math.max(0, index));
                service.putExtra("repeat", repeatMode);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(service);
                } else {
                    startService(service);
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void nativePlay() {
            sendPlaybackServiceCommand(PlaybackKeepAliveService.ACTION_PLAY);
        }

        @JavascriptInterface
        public void nativePause() {
            sendPlaybackServiceCommand(PlaybackKeepAliveService.ACTION_PAUSE);
        }

        @JavascriptInterface
        public void nativeNext() {
            sendPlaybackServiceCommand(PlaybackKeepAliveService.ACTION_NEXT);
        }

        @JavascriptInterface
        public void nativePrevious() {
            sendPlaybackServiceCommand(PlaybackKeepAliveService.ACTION_PREVIOUS);
        }

        @JavascriptInterface
        public void nativeStop() {
            sendPlaybackServiceCommand(PlaybackKeepAliveService.ACTION_STOP);
        }

        @JavascriptInterface
        public void nativeSeek(double seconds) {
            Intent service = new Intent(MainActivity.this, PlaybackKeepAliveService.class);
            service.setAction(PlaybackKeepAliveService.ACTION_SEEK);
            service.putExtra("position", Math.max(0L, (long) (seconds * 1000.0)));
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
                else startService(service);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void nativeSetRepeat(boolean repeatMode) {
            Intent service = new Intent(MainActivity.this, PlaybackKeepAliveService.class);
            service.setAction(PlaybackKeepAliveService.ACTION_SET_REPEAT);
            service.putExtra("repeat", repeatMode);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
                else startService(service);
            } catch (Exception ignored) {}
        }

        private void sendPlaybackServiceCommand(String action) {
            Intent service = new Intent(MainActivity.this, PlaybackKeepAliveService.class);
            service.setAction(action);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
                else startService(service);
            } catch (Exception ignored) {}
        }

        private String extractAudioToken(String url) {
            if (url == null) return null;
            String marker = "/audio/";
            int at = url.indexOf(marker);
            if (at < 0) return null;
            String token = url.substring(at + marker.length());
            int query = token.indexOf('?');
            if (query >= 0) token = token.substring(0, query);
            return token.isEmpty() ? null : token;
        }

        @JavascriptInterface
        public void startPlaybackKeepAlive() {
            // Legacy compatibility: nativePlayQueue now starts the real
            // playback foreground service. No WebView keep-alive is needed.
        }

        @JavascriptInterface
        public void stopPlaybackKeepAlive() {
            // Legacy compatibility.
        }

        @JavascriptInterface
        public void updatePlaybackNotification(
                String title,
                String artist,
                boolean playing,
                double durationSeconds,
                double positionSeconds
        ) {
            // Native service owns notification state. The JS audio element is
            // no longer the Android playback engine.
        }

        @JavascriptInterface
        public void resumeWebPlayback() {
            nativePlay();
        }

        @JavascriptInterface
        public void forgetMusicFolder() {
            runOnUiThread(() -> {
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                String saved = prefs.getString(PREF_TREE_URI, null);

                if (saved != null) {
                    try {
                        getContentResolver().releasePersistableUriPermission(
                                Uri.parse(saved),
                                Intent.FLAG_GRANT_READ_URI_PERMISSION
                        );
                    } catch (Exception ignored) {}
                }

                prefs.edit().remove(PREF_TREE_URI).apply();
                deleteCache();

                synchronized (audioUriMap) {
                    audioUriMap.clear();
                }

                sendFolderCleared();
            });
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode != PICK_MUSIC_FOLDER || resultCode != RESULT_OK || data == null) {
            return;
        }

        Uri treeUri = data.getData();
        if (treeUri == null) return;

        try {
            getContentResolver().takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (Exception ignored) {}

        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putString(PREF_TREE_URI, treeUri.toString())
                .apply();

        deleteCache();
        restoreStarted = true;
        scanAndSend(treeUri, true);
    }

    private boolean hasPersistedReadPermission(Uri treeUri) {
        try {
            for (android.content.UriPermission permission :
                    getContentResolver().getPersistedUriPermissions()) {
                if (treeUri.equals(permission.getUri()) && permission.isReadPermission()) {
                    return true;
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    private void restoreSavedFolder() {
        if (!pageReady || webView == null || scanInProgress) return;

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = prefs.getString(PREF_TREE_URI, null);

        if (saved == null || saved.isEmpty()) {
            sendNativeStatus("Choose your music folder to get started.");
            return;
        }

        try {
            Uri treeUri = Uri.parse(saved);

            if (!hasPersistedReadPermission(treeUri)) {
                prefs.edit().remove(PREF_TREE_URI).apply();
                deleteCache();
                sendNativeStatus("Choose your music folder to get started.");
                return;
            }

            // Show the cached library immediately. The real folder is verified in
            // the background so the app does not make the user wait on every launch.
            JSONObject cached = readCache();
            if (cached != null && treeUri.toString().equals(cached.optString("folderUri"))) {
                rebuildAudioMap(cached.optJSONArray("songs"));
                sendLibraryToJavascript(cached);
            }

            scanAndSend(treeUri, false);
        } catch (Exception ignored) {
            prefs.edit().remove(PREF_TREE_URI).apply();
            deleteCache();
            sendNativeStatus("Choose your music folder to get started.");
        }
    }

    private void scanAndSend(Uri treeUri, boolean userSelected) {
        synchronized (this) {
            if (scanInProgress) return;
            scanInProgress = true;
        }

        new Thread(() -> {
            try {
                List<FileEntry> entries = queryAudioFiles(treeUri);
                JSONObject cached = readCache();

                boolean cacheMatches = cached != null &&
                        treeUri.toString().equals(cached.optString("folderUri")) &&
                        sameFileSet(entries, cached.optJSONArray("songs"));

                JSONArray songs;

                if (cacheMatches) {
                    songs = cached.optJSONArray("songs");
                    if (songs == null) songs = new JSONArray();

                    rebuildAudioMap(songs);

                    // The cached list is already on screen. Don't send it again.
                    if (userSelected) {
                        JSONObject payload = new JSONObject();
                        payload.put("folderUri", treeUri.toString());
                        payload.put("count", songs.length());
                        payload.put("songs", songs);
                        sendLibraryToJavascript(payload);
                    }
                } else {
                    songs = buildFastSongList(entries);

                    JSONObject payload = new JSONObject();
                    payload.put("folderUri", treeUri.toString());
                    payload.put("count", songs.length());
                    payload.put("songs", songs);

                    rebuildAudioMap(songs);
                    writeCache(payload);
                    sendLibraryToJavascript(payload);
                }

                // Metadata and embedded artwork are deliberately processed after
                // the library is visible. They no longer block startup.
                enrichSongsInBackground(treeUri, entries, songs, !cacheMatches);

            } catch (Exception error) {
                sendNativeError(
                        error.getMessage() == null
                                ? "Unable to read the selected folder."
                                : error.getMessage()
                );
            } finally {
                synchronized (this) {
                    scanInProgress = false;
                }
            }
        }, "LUXE-Library-Scanner").start();
    }

    private List<FileEntry> queryAudioFiles(Uri treeUri) {
        List<FileEntry> entries = new ArrayList<>();

        try {
            String parentDocumentId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                    treeUri,
                    parentDocumentId
            );

            String[] projection = new String[] {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
            };

            try (Cursor cursor = getContentResolver().query(
                    childrenUri,
                    projection,
                    null,
                    null,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME + " ASC"
            )) {
                if (cursor == null) return entries;

                int idCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
                int nameCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                int mimeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
                int sizeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
                int modifiedCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);

                while (cursor.moveToNext()) {
                    String docId = cursor.getString(idCol);
                    String name = cursor.getString(nameCol);
                    String mime = cursor.getString(mimeCol);

                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) continue;
                    if (!isAudio(name, mime)) continue;

                    Uri childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                    String token = sha256(childUri.toString());

                    long size = sizeCol >= 0 && !cursor.isNull(sizeCol) ? cursor.getLong(sizeCol) : 0;
                    long modified = modifiedCol >= 0 && !cursor.isNull(modifiedCol) ? cursor.getLong(modifiedCol) : 0;

                    entries.add(new FileEntry(childUri, token, name, mime, size, modified));
                }
            }
        } catch (Exception ignored) {}

        return entries;
    }

    private JSONArray buildFastSongList(List<FileEntry> entries) throws Exception {
        JSONArray songs = new JSONArray();

        for (int index = 0; index < entries.size(); index++) {
            FileEntry entry = entries.get(index);
            JSONObject parsed = parseFileName(entry.name);

            JSONObject song = new JSONObject();
            song.put("id", entry.uri.toString());
            song.put("name", entry.name == null ? "Unknown" : entry.name);
            song.put("mime", entry.mime == null ? "audio/*" : entry.mime);
            song.put("size", entry.size);
            song.put("lastModified", entry.lastModified);
            song.put("url", "https://" + AUDIO_HOST + "/audio/" + entry.token);
            song.put("title", parsed.optString("title", entry.name));
            song.put("artist", parsed.optString("artist", "Unknown Artist"));
            song.put("album", "Local Music");
            song.put("artwork", JSONObject.NULL);
            songs.put(song);
        }

        return songs;
    }

    private void enrichSongsInBackground(Uri treeUri, List<FileEntry> entries, JSONArray songs, boolean refreshMetadata) {
        new Thread(() -> {
            boolean cacheDirty = false;

            for (int i = 0; i < entries.size(); i++) {
                FileEntry entry = entries.get(i);
                JSONObject song = songs.optJSONObject(i);
                if (song == null) continue;

                MediaInfo info = readMediaInfo(entry.uri,
                        song.optString("title", entry.name),
                        song.optString("artist", "Unknown Artist"),
                        song.optString("album", "Local Music"),
                        refreshMetadata);

                try {
                    if (refreshMetadata) {
                        boolean metadataChanged =
                                !info.title.equals(song.optString("title")) ||
                                !info.artist.equals(song.optString("artist")) ||
                                !info.album.equals(song.optString("album"));

                        if (metadataChanged) {
                            song.put("title", info.title);
                            song.put("artist", info.artist);
                            song.put("album", info.album);
                            cacheDirty = true;
                            sendSongMetadataUpdated(song);
                        }
                    }

                    if (info.artwork != null && !info.artwork.isEmpty()) {
                        sendNativeArtworkUpdated(song.optString("id"), info.artwork);
                    }

                    // Save metadata changes without making the UI wait for them.
                    if (cacheDirty && (i % 12 == 0 || i == entries.size() - 1)) {
                        JSONObject payload = new JSONObject();
                        payload.put("folderUri", treeUri.toString());
                        payload.put("count", songs.length());
                        payload.put("songs", songs);
                        writeCache(payload);
                        cacheDirty = false;
                    }
                } catch (Exception ignored) {}
            }

            if (cacheDirty) {
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("folderUri", treeUri.toString());
                    payload.put("count", songs.length());
                    payload.put("songs", songs);
                    writeCache(payload);
                } catch (Exception ignored) {}
            }
        }, "LUXE-Metadata-Artwork").start();
    }

    private MediaInfo readMediaInfo(Uri uri, String fallbackTitle, String fallbackArtist, String fallbackAlbum, boolean readMetadata) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();

        String title = fallbackTitle;
        String artist = fallbackArtist;
        String album = fallbackAlbum;
        String artwork = null;

        try {
            retriever.setDataSource(this, uri);

            if (readMetadata) {
                String metadataTitle = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE);
                if (metadataTitle != null && !metadataTitle.trim().isEmpty()) title = metadataTitle.trim();

                String metadataArtist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST);
                if (metadataArtist != null && !metadataArtist.trim().isEmpty()) artist = metadataArtist.trim();

                String metadataAlbum = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM);
                if (metadataAlbum != null && !metadataAlbum.trim().isEmpty()) album = metadataAlbum.trim();
            }

            byte[] embeddedPicture = retriever.getEmbeddedPicture();
            if (embeddedPicture != null && embeddedPicture.length > 0) {
                artwork = createArtworkDataUri(embeddedPicture);
            }
        } catch (Exception ignored) {
        } finally {
            try { retriever.release(); } catch (Exception ignored) {}
        }

        return new MediaInfo(title, artist, album, artwork);
    }

    private String createArtworkDataUri(byte[] originalBytes) {
        Bitmap original = BitmapFactory.decodeByteArray(originalBytes, 0, originalBytes.length);
        if (original == null) return null;

        Bitmap bitmap = original;
        try {
            int maxSize = 500;
            int width = original.getWidth();
            int height = original.getHeight();

            if (width > maxSize || height > maxSize) {
                float scale = Math.min((float) maxSize / width, (float) maxSize / height);
                int newWidth = Math.max(1, Math.round(width * scale));
                int newHeight = Math.max(1, Math.round(height * scale));
                bitmap = Bitmap.createScaledBitmap(original, newWidth, newHeight, true);
            }

            ByteArrayOutputStream output = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, output);
            String encoded = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
            return "data:image/jpeg;base64," + encoded;
        } catch (Exception ignored) {
            return null;
        } finally {
            if (bitmap != null && bitmap != original && !bitmap.isRecycled()) bitmap.recycle();
            if (original != null && !original.isRecycled()) original.recycle();
        }
    }

    private boolean sameFileSet(List<FileEntry> entries, JSONArray cachedSongs) {
        if (cachedSongs == null || entries.size() != cachedSongs.length()) return false;

        for (int i = 0; i < entries.size(); i++) {
            FileEntry entry = entries.get(i);
            JSONObject cached = cachedSongs.optJSONObject(i);
            if (cached == null) return false;

            if (!entry.uri.toString().equals(cached.optString("id"))) return false;
            if (entry.size != cached.optLong("size", -1)) return false;
            if (entry.lastModified != cached.optLong("lastModified", -1)) return false;
            if (!safeEquals(entry.name, cached.optString("name", null))) return false;
        }
        return true;
    }

    private void rebuildAudioMap(JSONArray songs) {
        if (songs == null) return;
        Map<String, Uri> fresh = new HashMap<>();

        for (int i = 0; i < songs.length(); i++) {
            JSONObject song = songs.optJSONObject(i);
            if (song == null) continue;

            String id = song.optString("id", "");
            if (id.isEmpty()) continue;

            try {
                fresh.put(sha256(id), Uri.parse(id));
            } catch (Exception ignored) {}
        }

        synchronized (audioUriMap) {
            audioUriMap.clear();
            audioUriMap.putAll(fresh);
        }
    }

    private void sendSongMetadataUpdated(JSONObject song) {
        String encoded = JSONObject.quote(song.toString());
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.LUXEAndroid && window.LUXEAndroid.onNativeSongMetadataUpdated(" + encoded + ");",
                null
        ));
    }

    private void sendNativeArtworkUpdated(String songId, String artwork) {
        String id = JSONObject.quote(songId);
        String art = JSONObject.quote(artwork);
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.LUXEAndroid && window.LUXEAndroid.onNativeArtworkUpdated(" + id + "," + art + ");",
                null
        ));
    }

    private void sendLibraryToJavascript(JSONObject payload) {
        String encoded = JSONObject.quote(payload.toString());
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.LUXEAndroid && window.LUXEAndroid.onFolderSelected(" + encoded + ");",
                null
        ));
    }

    private void sendNativeStatus(String message) {
        String encoded = JSONObject.quote(message);
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.LUXEAndroid && window.LUXEAndroid.onNativeStatus(" + encoded + ");",
                null
        ));
    }

    private void sendNativeError(String message) {
        String encoded = JSONObject.quote(message);
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.LUXEAndroid && window.LUXEAndroid.onError(" + encoded + ");",
                null
        ));
    }

    private void sendFolderCleared() {
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.LUXEAndroid && window.LUXEAndroid.onFolderCleared();",
                null
        ));
    }

    private JSONObject readCache() {
        File file = new File(getFilesDir(), CACHE_FILE);
        if (!file.exists()) return null;

        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        } catch (Exception ignored) {
            return null;
        }
    }

    private void writeCache(JSONObject payload) {
        if (payload == null) return;

        File target = new File(getFilesDir(), CACHE_FILE);
        File temp = new File(getFilesDir(), CACHE_FILE + ".tmp");

        try (FileOutputStream output = new FileOutputStream(temp)) {
            output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            output.flush();
            if (!temp.renameTo(target)) {
                try (FileOutputStream fallback = new FileOutputStream(target)) {
                    fallback.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
            }
        } catch (Exception ignored) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
        }
    }

    private void deleteCache() {
        //noinspection ResultOfMethodCallIgnored
        new File(getFilesDir(), CACHE_FILE).delete();
        //noinspection ResultOfMethodCallIgnored
        new File(getFilesDir(), CACHE_FILE + ".tmp").delete();
    }

    private static boolean safeEquals(String a, String b) {
        if (a == null) return b == null;
        return a.equals(b);
    }

    private static class FileEntry {
        final Uri uri;
        final String token;
        final String name;
        final String mime;
        final long size;
        final long lastModified;

        FileEntry(Uri uri, String token, String name, String mime, long size, long lastModified) {
            this.uri = uri;
            this.token = token;
            this.name = name;
            this.mime = mime;
            this.size = size;
            this.lastModified = lastModified;
        }
    }

    private static class MediaInfo {
        final String title;
        final String artist;
        final String album;
        final String artwork;

        MediaInfo(String title, String artist, String album, String artwork) {
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artwork = artwork;
        }
    }

    private boolean isAudio(String name, String mime) {
        if (mime != null && mime.toLowerCase(Locale.ROOT).startsWith("audio/")) return true;
        if (name == null) return false;

        String lower = name.toLowerCase(Locale.ROOT);
        return lower.endsWith(".mp3") ||
                lower.endsWith(".m4a") ||
                lower.endsWith(".flac") ||
                lower.endsWith(".wav") ||
                lower.endsWith(".aac") ||
                lower.endsWith(".ogg") ||
                lower.endsWith(".opus") ||
                lower.endsWith(".webm") ||
                lower.endsWith(".oga");
    }

    private JSONObject parseFileName(String fileName) throws Exception {
        String base = fileName == null
                ? "Unknown"
                : fileName.replaceFirst("\\.[^.]+$", "").trim();

        String artist = "Unknown Artist";
        String title = base;

        String[] parts = base.split("\\s[-–—]\\s", 2);
        if (parts.length == 2) {
            artist = parts[0].trim();
            title = parts[1].trim();
        }

        JSONObject object = new JSONObject();
        object.put("artist", artist);
        object.put("title", title);
        return object;
    }

    private String sha256(String value) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));

        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
    @Override
    protected void onDestroy() {
        try { unregisterReceiver(playbackReceiver); } catch (Exception ignored) {}
        if (activeInstance != null && activeInstance.get() == this) {
            activeInstance.clear();
            activeInstance = null;
        }

        super.onDestroy();
    }

}
