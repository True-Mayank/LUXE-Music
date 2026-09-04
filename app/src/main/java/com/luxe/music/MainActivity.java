package com.luxe.music;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends Activity {

    private static final int PICK_MUSIC_FOLDER = 7001;
    private static final String PREFS = "luxe_native_storage";
    private static final String PREF_TREE_URI = "music_tree_uri";
    private static final String AUDIO_HOST = "luxe.local";

    private WebView webView;
    private final Map<String, Uri> audioUriMap = new HashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(9, 9, 11));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        webView.addJavascriptInterface(new AndroidBridge(), "LuxeAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (AUDIO_HOST.equals(url.getHost()) && url.getPath() != null && url.getPath().startsWith("/audio/")) {
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
                            new java.io.ByteArrayInputStream("Audio unavailable".getBytes(StandardCharsets.UTF_8))
                    );
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                restoreSavedFolder();
            }
        });

        webView.loadUrl("file:///android_asset/index.html");
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

        int takeFlags = data.getFlags() &
                (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

        try {
            getContentResolver().takePersistableUriPermission(treeUri, takeFlags);
        } catch (Exception ignored) {
            try {
                getContentResolver().takePersistableUriPermission(
                        treeUri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception ignoredAgain) {}
        }

        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putString(PREF_TREE_URI, treeUri.toString())
                .apply();

        scanAndSend(treeUri);
    }

    private void restoreSavedFolder() {
        String saved = getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString(PREF_TREE_URI, null);
        if (saved == null || saved.isEmpty()) return;
        try {
            scanAndSend(Uri.parse(saved));
        } catch (Exception ignored) {}
    }

    private void scanAndSend(Uri treeUri) {
        new Thread(() -> {
            JSONArray songs = new JSONArray();
            Map<String, Uri> freshMap = new HashMap<>();

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
                    if (cursor != null) {
                        int idCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
                        int nameCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                        int mimeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
                        int sizeCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
                        int modifiedCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);

                        while (cursor.moveToNext()) {
                            String docId = cursor.getString(idCol);
                            String name = cursor.getString(nameCol);
                            String mime = cursor.getString(mimeCol);

                            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                                continue; // LUXE V4 scans only the chosen folder, not subfolders.
                            }

                            if (!isAudio(name, mime)) continue;

                            Uri childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                            String token = sha256(childUri.toString());
                            freshMap.put(token, childUri);

                            JSONObject song = new JSONObject();
                            song.put("id", childUri.toString());
                            song.put("name", name == null ? "Unknown" : name);
                            song.put("mime", mime == null ? "audio/*" : mime);
                            song.put("size", sizeCol >= 0 && !cursor.isNull(sizeCol) ? cursor.getLong(sizeCol) : 0);
                            song.put("lastModified", modifiedCol >= 0 && !cursor.isNull(modifiedCol) ? cursor.getLong(modifiedCol) : 0);
                            song.put("url", "https://" + AUDIO_HOST + "/audio/" + token);

                            JSONObject parsed = parseFileName(name);
                            song.put("title", parsed.optString("title", name));
                            song.put("artist", parsed.optString("artist", "Unknown Artist"));
                            song.put("album", "Local Music");

                            songs.put(song);
                        }
                    }
                }

                synchronized (audioUriMap) {
                    audioUriMap.clear();
                    audioUriMap.putAll(freshMap);
                }

                JSONObject payload = new JSONObject();
                payload.put("folderUri", treeUri.toString());
                payload.put("count", songs.length());
                payload.put("songs", songs);

                sendLibraryToJavascript(payload);

            } catch (Exception error) {
                sendNativeError(error.getMessage() == null ? "Unable to read the selected folder." : error.getMessage());
            }
        }).start();
    }

    private boolean isAudio(String name, String mime) {
        if (mime != null && mime.toLowerCase(Locale.ROOT).startsWith("audio/")) return true;
        if (name == null) return false;
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.endsWith(".mp3") || lower.endsWith(".m4a") ||
                lower.endsWith(".flac") || lower.endsWith(".wav") ||
                lower.endsWith(".aac") || lower.endsWith(".ogg") ||
                lower.endsWith(".opus") || lower.endsWith(".webm") ||
                lower.endsWith(".oga");
    }

    private JSONObject parseFileName(String fileName) throws Exception {
        String base = fileName == null ? "Unknown" : fileName.replaceFirst("\\.[^.]+$", "").trim();
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

    private void sendLibraryToJavascript(JSONObject payload) {
        String encoded = JSONObject.quote(payload.toString());
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.LUXEAndroid && window.LUXEAndroid.onFolderSelected(" + encoded + ");",
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

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
