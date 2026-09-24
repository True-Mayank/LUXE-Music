package com.luxe.music;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.util.Base64;

/**
 * LUXE Music Android host.
 *
 * Keeps the existing HTML/CSS/JS app intact and supplies the native
 * Android folder picker + local audio bridge expected by app.js.
 *
 * Important Recent Apps behavior:
 * - Pressing Home / locking the screen does NOT call onTaskRemoved(),
 *   so normal background playback is left alone.
 * - Swiping LUXE away from Recent Apps calls onTaskRemoved(); we pause
 *   the HTML audio there and then tear down the WebView.
 */
public class MainActivity extends Activity {

    private static final int PICK_MUSIC_FOLDER = 4101;
    private static final String PREFS = "luxe_android";
    private static final String KEY_FOLDER_URI = "folder_uri";
    private static final String AUDIO_HOST = "luxe.local";

    private WebView webView;
    private boolean webReady = false;
    private Uri treeUri;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, Uri> audioUris = new HashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.rgb(9, 9, 11));
        getWindow().setNavigationBarColor(Color.rgb(9, 9, 11));

        setupWebView();

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = prefs.getString(KEY_FOLDER_URI, null);
        if (saved != null) {
            try {
                treeUri = Uri.parse(saved);
            } catch (Exception ignored) {
                treeUri = null;
            }
        }
    }

    private void setupWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(9, 9, 11));

        android.webkit.WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);

        webView.addJavascriptInterface(new LuxeAndroidBridge(), "LuxeAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                webReady = true;

                if (treeUri != null) {
                    rescanMusicFolder();
                }
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return interceptAudio(request.getUrl());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                try {
                    return interceptAudio(Uri.parse(url));
                } catch (Exception ignored) {
                    return null;
                }
            }
        });

        setContentView(webView);
        webView.loadUrl("file:///android_asset/index.html");
    }

    private WebResourceResponse interceptAudio(Uri requestUri) {
        if (requestUri == null) return null;
        if (!AUDIO_HOST.equalsIgnoreCase(requestUri.getHost())) return null;
        if (!"https".equalsIgnoreCase(requestUri.getScheme())) return null;

        String path = requestUri.getPath();
        if (path == null || !path.startsWith("/audio/")) return null;

        String token = path.substring("/audio/".length());
        Uri source = audioUris.get(token);
        if (source == null) return null;

        try {
            InputStream stream = getContentResolver().openInputStream(source);
            if (stream == null) return null;

            String mime = getContentResolver().getType(source);
            if (mime == null || mime.trim().isEmpty()) {
                mime = guessMime(source.toString());
            }
            if (mime == null) mime = "audio/mpeg";

            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-store");

            return new WebResourceResponse(mime, "binary", 200, "OK", headers, stream);
        } catch (Exception ignored) {
            return null;
        }
    }

    private String guessMime(String value) {
        String lower = value.toLowerCase(Locale.US);
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".m4a")) return "audio/mp4";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
        if (lower.endsWith(".opus")) return "audio/opus";
        if (lower.endsWith(".webm")) return "audio/webm";
        return "audio/mpeg";
    }

    private void chooseFolder() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(intent, PICK_MUSIC_FOLDER);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode != PICK_MUSIC_FOLDER || resultCode != RESULT_OK || data == null) {
            sendError("Folder selection cancelled.");
            return;
        }

        Uri selected = data.getData();
        if (selected == null) {
            sendError("No folder was selected.");
            return;
        }

        try {
            int flags = data.getFlags() &
                    (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContentResolver().takePersistableUriPermission(selected, flags);
        } catch (Exception ignored) {
            // Some providers do not expose persistable permissions.
        }

        treeUri = selected;
        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putString(KEY_FOLDER_URI, selected.toString())
                .apply();

        rescanMusicFolder();
    }

    private void scanFolderAndSend() {
        if (treeUri == null) {
            sendError("Please select a music folder first.");
            return;
        }

        executor.execute(() -> {
            List<SongItem> found = scanFolder(treeUri);

            mainHandler.post(() -> {
                audioUris.clear();

                try {
                    JSONArray songs = new JSONArray();

                    for (SongItem item : found) {
                        String token = createToken(item.uri);
                        audioUris.put(token, item.uri);

                        JSONObject song = new JSONObject();
                        song.put("id", item.id);
                        song.put("name", item.name);
                        song.put("mime", item.mime);
                        song.put("size", item.size);
                        song.put("lastModified", item.lastModified);
                        song.put("url", "https://" + AUDIO_HOST + "/audio/" + token);
                        song.put("title", item.title);
                        song.put("artist", item.artist);
                        song.put("album", item.album);
                        songs.put(song);
                    }

                    JSONObject payload = new JSONObject();
                    payload.put("folderUri", treeUri.toString());
                    payload.put("count", found.size());
                    payload.put("songs", songs);

                    callJs("window.LUXEAndroid.onFolderSelected(" + JSONObject.quote(payload.toString()) + ");");
                } catch (Exception e) {
                    sendError("Unable to build the music library.");
                }
            });
        });
    }

    private List<SongItem> scanFolder(Uri tree) {
        List<SongItem> result = new ArrayList<>();

        String[] projection = new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
        };

        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                tree,
                DocumentsContract.getTreeDocumentId(tree)
        );

        try (android.database.Cursor cursor = getContentResolver().query(
                childrenUri,
                projection,
                null,
                null,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME + " COLLATE NOCASE ASC")) {

            if (cursor == null) return result;

            int idCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            int mimeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
            int sizeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
            int modifiedCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);

            while (cursor.moveToNext()) {
                String docId = idCol >= 0 ? cursor.getString(idCol) : "";
                String name = nameCol >= 0 ? cursor.getString(nameCol) : "Unknown";
                String mime = mimeCol >= 0 ? cursor.getString(mimeCol) : "";

                if (!isAudio(name, mime)) continue;

                long size = sizeCol >= 0 && !cursor.isNull(sizeCol) ? cursor.getLong(sizeCol) : 0L;
                long modified = modifiedCol >= 0 && !cursor.isNull(modifiedCol) ? cursor.getLong(modifiedCol) : 0L;

                Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
                String[] parsed = parseName(name);

                SongItem item = new SongItem();
                item.uri = documentUri;
                item.id = documentUri.toString();
                item.name = name;
                item.mime = mime;
                item.size = size;
                item.lastModified = modified;
                item.artist = parsed[0];
                item.title = parsed[1];
                item.album = "Local Music";
                result.add(item);
            }
        } catch (Exception ignored) {
            // Provider errors are reported by the empty result below.
        }

        return result;
    }

    private boolean isAudio(String name, String mime) {
        if (mime != null && mime.toLowerCase(Locale.US).startsWith("audio/")) return true;
        if (name == null) return false;
        String n = name.toLowerCase(Locale.US);
        return n.endsWith(".mp3") || n.endsWith(".m4a") || n.endsWith(".flac")
                || n.endsWith(".wav") || n.endsWith(".aac") || n.endsWith(".ogg")
                || n.endsWith(".opus") || n.endsWith(".webm") || n.endsWith(".oga");
    }

    private String[] parseName(String name) {
        String base = name == null ? "Unknown" : name.replaceFirst("\\.[^/.]+$", "").trim();
        String artist = "Unknown Artist";
        String title = base;

        String[] parts = base.split("\\s[-–—]\\s", 2);
        if (parts.length == 2) {
            artist = parts[0].trim();
            title = parts[1].trim();
        }
        return new String[]{artist, title};
    }

    private String createToken(Uri uri) {
        String raw = uri.toString();
        return Base64.encodeToString(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private void callJs(String javascript) {
        if (webView == null || !webReady) return;
        mainHandler.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(javascript, null);
            }
        });
    }

    private void sendError(String message) {
        callJs("window.LUXEAndroid.onError(" + JSONObject.quote(message) + ");");
    }

    public void rescanMusicFolder() {
        if (treeUri == null) {
            sendError("No music folder selected.");
            return;
        }
        scanFolderAndSend();
    }

    private void clearMusicFolder() {
        treeUri = null;
        audioUris.clear();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_FOLDER_URI).apply();
        callJs("window.LUXEAndroid.onFolderCleared();");
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // This is specifically for a swipe-away/removal from Recent Apps.
        // It is NOT called for an ordinary Home/lock-screen background transition.
        stopHtmlAudioAndDestroyWebView();
        super.onTaskRemoved(rootIntent);
    }

    private void stopHtmlAudioAndDestroyWebView() {
        if (webView == null) return;

        final WebView target = webView;
        webView = null;
        webReady = false;

        mainHandler.post(() -> {
            try {
                target.evaluateJavascript(
                        "(function(){var a=document.querySelector('audio');if(a){a.pause();a.removeAttribute('src');try{a.load();}catch(e){}}})();",
                        value -> {
                            try { target.stopLoading(); } catch (Exception ignored) {}
                            try { target.destroy(); } catch (Exception ignored) {}
                        }
                );
            } catch (Exception e) {
                try { target.destroy(); } catch (Exception ignored) {}
            }
        });
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        if (webView != null) {
            try { webView.destroy(); } catch (Exception ignored) {}
            webView = null;
        }
        super.onDestroy();
    }

    private class LuxeAndroidBridge {
        @JavascriptInterface
        public void pickMusicFolder() {
            mainHandler.post(MainActivity.this::chooseFolder);
        }

        @JavascriptInterface
        public void rescanMusicFolder() {
            mainHandler.post(MainActivity.this::rescanMusicFolder);
        }

        @JavascriptInterface
        public void clearMusicFolder() {
            mainHandler.post(MainActivity.this::clearMusicFolder);
        }
    }

    private static class SongItem {
        Uri uri;
        String id;
        String name;
        String mime;
        long size;
        long lastModified;
        String title;
        String artist;
        String album;
    }
}
