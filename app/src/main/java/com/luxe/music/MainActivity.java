package com.luxe.music;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
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

import java.io.ByteArrayOutputStream;
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

        webView.addJavascriptInterface(
                new AndroidBridge(),
                "LuxeAndroid"
        );

        webView.setWebViewClient(new WebViewClient() {

            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    WebResourceRequest request
            ) {

                Uri url = request.getUrl();

                if (
                        AUDIO_HOST.equals(url.getHost()) &&
                        url.getPath() != null &&
                        url.getPath().startsWith("/audio/")
                ) {

                    String token = url.getLastPathSegment();

                    Uri source;

                    synchronized (audioUriMap) {
                        source = audioUriMap.get(token);
                    }

                    if (source != null) {

                        try {

                            InputStream stream =
                                    getContentResolver()
                                            .openInputStream(source);

                            if (stream != null) {

                                String mime =
                                        getContentResolver()
                                                .getType(source);

                                if (mime == null || mime.isEmpty()) {
                                    mime = "audio/mpeg";
                                }

                                return new WebResourceResponse(
                                        mime,
                                        null,
                                        stream
                                );
                            }

                        } catch (Exception ignored) {
                        }
                    }

                    return new WebResourceResponse(
                            "text/plain",
                            "UTF-8",
                            404,
                            "Not Found",
                            null,
                            new java.io.ByteArrayInputStream(
                                    "Audio unavailable"
                                            .getBytes(StandardCharsets.UTF_8)
                            )
                    );
                }

                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onPageFinished(
                    WebView view,
                    String url
            ) {

                super.onPageFinished(view, url);

                restoreSavedFolder();
            }
        });

        webView.loadUrl(
                "file:///android_asset/index.html"
        );
    }

    // =========================================================
    // ANDROID JAVASCRIPT BRIDGE
    // =========================================================

    public class AndroidBridge {

        @JavascriptInterface
        public void pickMusicFolder() {

            runOnUiThread(() -> {

                Intent intent =
                        new Intent(
                                Intent.ACTION_OPEN_DOCUMENT_TREE
                        );

                intent.addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION |
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
                        Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                );

                startActivityForResult(
                        intent,
                        PICK_MUSIC_FOLDER
                );
            });
        }

        @JavascriptInterface
        public boolean isAndroidNative() {
            return true;
        }

        @JavascriptInterface
        public void rescanMusicFolder() {

            runOnUiThread(
                    () -> restoreSavedFolder()
            );
        }

        @JavascriptInterface
        public void forgetMusicFolder() {

            runOnUiThread(() -> {

                SharedPreferences prefs =
                        getSharedPreferences(
                                PREFS,
                                MODE_PRIVATE
                        );

                String saved =
                        prefs.getString(
                                PREF_TREE_URI,
                                null
                        );

                if (saved != null) {

                    try {

                        getContentResolver()
                                .releasePersistableUriPermission(
                                        Uri.parse(saved),
                                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                                );

                    } catch (Exception ignored) {
                    }
                }

                prefs.edit()
                        .remove(PREF_TREE_URI)
                        .apply();

                synchronized (audioUriMap) {
                    audioUriMap.clear();
                }

                sendFolderCleared();
            });
        }
    }

    // =========================================================
    // FOLDER PICKER RESULT
    // =========================================================

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(
            int requestCode,
            int resultCode,
            Intent data
    ) {

        super.onActivityResult(
                requestCode,
                resultCode,
                data
        );

        if (
                requestCode != PICK_MUSIC_FOLDER ||
                resultCode != RESULT_OK ||
                data == null
        ) {
            return;
        }

        Uri treeUri = data.getData();

        if (treeUri == null) {
            return;
        }

        int takeFlags =
                data.getFlags() &
                        (
                                Intent.FLAG_GRANT_READ_URI_PERMISSION |
                                Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        );

        try {

            getContentResolver()
                    .takePersistableUriPermission(
                            treeUri,
                            takeFlags
                    );

        } catch (Exception ignored) {

            try {

                getContentResolver()
                        .takePersistableUriPermission(
                                treeUri,
                                Intent.FLAG_GRANT_READ_URI_PERMISSION
                        );

            } catch (Exception ignoredAgain) {
            }
        }

        getSharedPreferences(
                PREFS,
                MODE_PRIVATE
        )
                .edit()
                .putString(
                        PREF_TREE_URI,
                        treeUri.toString()
                )
                .apply();

        scanAndSend(treeUri);
    }

    // =========================================================
    // RESTORE SAVED FOLDER
    // =========================================================

    private void restoreSavedFolder() {

        String saved =
                getSharedPreferences(
                        PREFS,
                        MODE_PRIVATE
                )
                        .getString(
                                PREF_TREE_URI,
                                null
                        );

        if (
                saved == null ||
                saved.isEmpty()
        ) {
            return;
        }

        try {

            scanAndSend(
                    Uri.parse(saved)
            );

        } catch (Exception ignored) {
        }
    }

    // =========================================================
    // SCAN MUSIC FOLDER
    // =========================================================

    private void scanAndSend(Uri treeUri) {

        new Thread(() -> {

            JSONArray songs =
                    new JSONArray();

            Map<String, Uri> freshMap =
                    new HashMap<>();

            try {

                String parentDocumentId =
                        DocumentsContract
                                .getTreeDocumentId(
                                        treeUri
                                );

                Uri childrenUri =
                        DocumentsContract
                                .buildChildDocumentsUriUsingTree(
                                        treeUri,
                                        parentDocumentId
                                );

                String[] projection =
                        new String[]{

                                DocumentsContract.Document
                                        .COLUMN_DOCUMENT_ID,

                                DocumentsContract.Document
                                        .COLUMN_DISPLAY_NAME,

                                DocumentsContract.Document
                                        .COLUMN_MIME_TYPE,

                                DocumentsContract.Document
                                        .COLUMN_SIZE,

                                DocumentsContract.Document
                                        .COLUMN_LAST_MODIFIED
                        };

                try (
                        Cursor cursor =
                                getContentResolver().query(
                                        childrenUri,
                                        projection,
                                        null,
                                        null,
                                        DocumentsContract.Document
                                                .COLUMN_DISPLAY_NAME
                                                + " ASC"
                                )
                ) {

                    if (cursor != null) {

                        int idCol =
                                cursor.getColumnIndex(
                                        DocumentsContract.Document
                                                .COLUMN_DOCUMENT_ID
                                );

                        int nameCol =
                                cursor.getColumnIndex(
                                        DocumentsContract.Document
                                                .COLUMN_DISPLAY_NAME
                                );

                        int mimeCol =
                                cursor.getColumnIndex(
                                        DocumentsContract.Document
                                                .COLUMN_MIME_TYPE
                                );

                        int sizeCol =
                                cursor.getColumnIndex(
                                        DocumentsContract.Document
                                                .COLUMN_SIZE
                                );

                        int modifiedCol =
                                cursor.getColumnIndex(
                                        DocumentsContract.Document
                                                .COLUMN_LAST_MODIFIED
                                );

                        while (cursor.moveToNext()) {

                            String docId =
                                    cursor.getString(idCol);

                            String name =
                                    cursor.getString(nameCol);

                            String mime =
                                    cursor.getString(mimeCol);

                            if (
                                    DocumentsContract.Document
                                            .MIME_TYPE_DIR
                                            .equals(mime)
                            ) {

                                // LUXE scans only the selected folder.
                                continue;
                            }

                            if (
                                    !isAudio(
                                            name,
                                            mime
                                    )
                            ) {
                                continue;
                            }

                            Uri childUri =
                                    DocumentsContract
                                            .buildDocumentUriUsingTree(
                                                    treeUri,
                                                    docId
                                            );

                            String token =
                                    sha256(
                                            childUri.toString()
                                    );

                            freshMap.put(
                                    token,
                                    childUri
                            );

                            JSONObject song =
                                    new JSONObject();

                            song.put(
                                    "id",
                                    childUri.toString()
                            );

                            song.put(
                                    "name",
                                    name == null
                                            ? "Unknown"
                                            : name
                            );

                            song.put(
                                    "mime",
                                    mime == null
                                            ? "audio/*"
                                            : mime
                            );

                            song.put(
                                    "size",
                                    sizeCol >= 0 &&
                                            !cursor.isNull(sizeCol)
                                            ? cursor.getLong(sizeCol)
                                            : 0
                            );

                            song.put(
                                    "lastModified",
                                    modifiedCol >= 0 &&
                                            !cursor.isNull(modifiedCol)
                                            ? cursor.getLong(modifiedCol)
                                            : 0
                            );

                            song.put(
                                    "url",
                                    "https://" +
                                            AUDIO_HOST +
                                            "/audio/" +
                                            token
                            );

                            // -------------------------------------------------
                            // FILENAME FALLBACK
                            // -------------------------------------------------

                            JSONObject parsed =
                                    parseFileName(name);

                            String title =
                                    parsed.optString(
                                            "title",
                                            name
                                    );

                            String artist =
                                    parsed.optString(
                                            "artist",
                                            "Unknown Artist"
                                    );

                            String album =
                                    "Local Music";

                            // -------------------------------------------------
                            // NATIVE MEDIA METADATA
                            // -------------------------------------------------

                            MediaInfo mediaInfo =
                                    readMediaInfo(
                                            childUri,
                                            title,
                                            artist,
                                            album
                                    );

                            song.put(
                                    "title",
                                    mediaInfo.title
                            );

                            song.put(
                                    "artist",
                                    mediaInfo.artist
                            );

                            song.put(
                                    "album",
                                    mediaInfo.album
                            );

                            // -------------------------------------------------
                            // EMBEDDED ALBUM ART
                            // -------------------------------------------------

                            if (
                                    mediaInfo.artwork != null &&
                                    !mediaInfo.artwork.isEmpty()
                            ) {

                                song.put(
                                        "artwork",
                                        mediaInfo.artwork
                                );

                            } else {

                                song.put(
                                        "artwork",
                                        JSONObject.NULL
                                );
                            }

                            songs.put(song);
                        }
                    }
                }

                synchronized (audioUriMap) {

                    audioUriMap.clear();

                    audioUriMap.putAll(
                            freshMap
                    );
                }

                JSONObject payload =
                        new JSONObject();

                payload.put(
                        "folderUri",
                        treeUri.toString()
                );

                payload.put(
                        "count",
                        songs.length()
                );

                payload.put(
                        "songs",
                        songs
                );

                sendLibraryToJavascript(
                        payload
                );

            } catch (Exception error) {

                String message =
                        error.getMessage();

                sendNativeError(
                        message == null
                                ? "Unable to read the selected folder."
                                : message
                );
            }

        }).start();
    }

    // =========================================================
    // MEDIA INFORMATION
    // =========================================================

    private MediaInfo readMediaInfo(
            Uri uri,
            String fallbackTitle,
            String fallbackArtist,
            String fallbackAlbum
    ) {

        MediaMetadataRetriever retriever =
                new MediaMetadataRetriever();

        String title = fallbackTitle;
        String artist = fallbackArtist;
        String album = fallbackAlbum;

        String artwork = null;

        try {

            retriever.setDataSource(
                    this,
                    uri
            );

            // -------------------------------------------------
            // TITLE
            // -------------------------------------------------

            String metadataTitle =
                    retriever.extractMetadata(
                            MediaMetadataRetriever
                                    .METADATA_KEY_TITLE
                    );

            if (
                    metadataTitle != null &&
                    !metadataTitle.trim().isEmpty()
            ) {

                title =
                        metadataTitle.trim();
            }

            // -------------------------------------------------
            // ARTIST
            // -------------------------------------------------

            String metadataArtist =
                    retriever.extractMetadata(
                            MediaMetadataRetriever
                                    .METADATA_KEY_ARTIST
                    );

            if (
                    metadataArtist != null &&
                    !metadataArtist.trim().isEmpty()
            ) {

                artist =
                        metadataArtist.trim();
            }

            // -------------------------------------------------
            // ALBUM
            // -------------------------------------------------

            String metadataAlbum =
                    retriever.extractMetadata(
                            MediaMetadataRetriever
                                    .METADATA_KEY_ALBUM
                    );

            if (
                    metadataAlbum != null &&
                    !metadataAlbum.trim().isEmpty()
            ) {

                album =
                        metadataAlbum.trim();
            }

            // -------------------------------------------------
            // EMBEDDED COVER
            // -------------------------------------------------

            byte[] embeddedPicture =
                    retriever.getEmbeddedPicture();

            if (
                    embeddedPicture != null &&
                    embeddedPicture.length > 0
            ) {

                artwork =
                        createArtworkDataUri(
                                embeddedPicture
                        );
            }

        } catch (Exception ignored) {

            // If Android cannot read metadata/artwork,
            // LUXE keeps the filename fallback.

        } finally {

            try {
                retriever.release();
            } catch (Exception ignored) {
            }
        }

        return new MediaInfo(
                title,
                artist,
                album,
                artwork
        );
    }

    // =========================================================
    // CREATE SMALL WEBVIEW-FRIENDLY ARTWORK
    // =========================================================

    private String createArtworkDataUri(
            byte[] originalBytes
    ) {

        Bitmap original =
                BitmapFactory.decodeByteArray(
                        originalBytes,
                        0,
                        originalBytes.length
                );

        if (original == null) {
            return null;
        }

        Bitmap bitmap = original;

        try {

            // -------------------------------------------------
            // LIMIT COVER SIZE
            // -------------------------------------------------

            int maxSize = 600;

            int width =
                    original.getWidth();

            int height =
                    original.getHeight();

            if (
                    width > maxSize ||
                    height > maxSize
            ) {

                float scale =
                        Math.min(
                                (float) maxSize / width,
                                (float) maxSize / height
                        );

                int newWidth =
                        Math.max(
                                1,
                                Math.round(
                                        width * scale
                                )
                        );

                int newHeight =
                        Math.max(
                                1,
                                Math.round(
                                        height * scale
                                )
                        );

                bitmap =
                        Bitmap.createScaledBitmap(
                                original,
                                newWidth,
                                newHeight,
                                true
                        );
            }

            // -------------------------------------------------
            // JPEG DATA
            // -------------------------------------------------

            ByteArrayOutputStream output =
                    new ByteArrayOutputStream();

            bitmap.compress(
                    Bitmap.CompressFormat.JPEG,
                    88,
                    output
            );

            byte[] compressed =
                    output.toByteArray();

            String encoded =
                    Base64.encodeToString(
                            compressed,
                            Base64.NO_WRAP
                    );

            return "data:image/jpeg;base64," +
                    encoded;

        } catch (Exception ignored) {

            return null;

        } finally {

            if (
                    bitmap != null &&
                    bitmap != original &&
                    !bitmap.isRecycled()
            ) {
                bitmap.recycle();
            }

            if (
                    original != null &&
                    !original.isRecycled()
            ) {
                original.recycle();
            }
        }
    }

    // =========================================================
    // MEDIA INFO CLASS
    // =========================================================

    private static class MediaInfo {

        final String title;
        final String artist;
        final String album;
        final String artwork;

        MediaInfo(
                String title,
                String artist,
                String album,
                String artwork
        ) {

            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artwork = artwork;
        }
    }

    // =========================================================
    // AUDIO CHECK
    // =========================================================

    private boolean isAudio(
            String name,
            String mime
    ) {

        if (
                mime != null &&
                mime.toLowerCase(Locale.ROOT)
                        .startsWith("audio/")
        ) {

            return true;
        }

        if (name == null) {
            return false;
        }

        String lower =
                name.toLowerCase(Locale.ROOT);

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

    // =========================================================
    // FILENAME METADATA FALLBACK
    // =========================================================

    private JSONObject parseFileName(
            String fileName
    ) throws Exception {

        String base =
                fileName == null
                        ? "Unknown"
                        : fileName
                                .replaceFirst(
                                        "\\.[^.]+$",
                                        ""
                                )
                                .trim();

        String artist =
                "Unknown Artist";

        String title =
                base;

        String[] parts =
                base.split(
                        "\\s[-–—]\\s",
                        2
                );

        if (parts.length == 2) {

            artist =
                    parts[0].trim();

            title =
                    parts[1].trim();
        }

        JSONObject object =
                new JSONObject();

        object.put(
                "artist",
                artist
        );

        object.put(
                "title",
                title
        );

        return object;
    }

    // =========================================================
    // SHA-256 AUDIO TOKEN
    // =========================================================

    private String sha256(
            String value
    ) throws Exception {

        MessageDigest digest =
                MessageDigest.getInstance(
                        "SHA-256"
                );

        byte[] bytes =
                digest.digest(
                        value.getBytes(
                                StandardCharsets.UTF_8
                        )
                );

        StringBuilder out =
                new StringBuilder();

        for (byte b : bytes) {

            out.append(
                    String.format(
                            Locale.ROOT,
                            "%02x",
                            b
                    )
            );
        }

        return out.toString();
    }

    // =========================================================
    // SEND LIBRARY TO JAVASCRIPT
    // =========================================================

    private void sendLibraryToJavascript(
            JSONObject payload
    ) {

        String encoded =
                JSONObject.quote(
                        payload.toString()
                );

        runOnUiThread(() -> {

            webView.evaluateJavascript(
                    "window.LUXEAndroid && " +
                            "window.LUXEAndroid.onFolderSelected(" +
                            encoded +
                            ");",
                    null
            );
        });
    }

    // =========================================================
    // SEND ERROR
    // =========================================================

    private void sendNativeError(
            String message
    ) {

        String encoded =
                JSONObject.quote(
                        message
                );

        runOnUiThread(() -> {

            webView.evaluateJavascript(
                    "window.LUXEAndroid && " +
                            "window.LUXEAndroid.onError(" +
                            encoded +
                            ");",
                    null
            );
        });
    }

    // =========================================================
    // CLEAR FOLDER
    // =========================================================

    private void sendFolderCleared() {

        runOnUiThread(() -> {

            webView.evaluateJavascript(
                    "window.LUXEAndroid && " +
                            "window.LUXEAndroid.onFolderCleared();",
                    null
            );
        });
    }

    // =========================================================
    // BACK BUTTON
    // =========================================================

    @Override
    public void onBackPressed() {

        if (
                webView != null &&
                webView.canGoBack()
        ) {

            webView.goBack();

        } else {

            super.onBackPressed();
        }
    }
}