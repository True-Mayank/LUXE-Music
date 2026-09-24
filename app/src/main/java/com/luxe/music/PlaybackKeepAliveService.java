package com.luxe.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.AudioAttributes;
import android.media.MediaMetadataRetriever;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Real native LUXE playback service.
 *
 * MediaPlayer is the Android audio engine. MediaSession + the foreground
 * service keep playback working when the WebView is backgrounded or the
 * screen is locked. The WebView is only the UI on Android.
 */
public class PlaybackKeepAliveService extends Service {

    public static final String ACTION_PLAY_QUEUE = "com.luxe.music.PLAY_QUEUE";
    public static final String ACTION_PLAY = "com.luxe.music.PLAY";
    public static final String ACTION_PAUSE = "com.luxe.music.PAUSE";
    public static final String ACTION_NEXT = "com.luxe.music.NEXT";
    public static final String ACTION_PREVIOUS = "com.luxe.music.PREVIOUS";
    public static final String ACTION_SEEK = "com.luxe.music.SEEK";
    public static final String ACTION_STOP = "com.luxe.music.STOP";
    public static final String ACTION_REQUEST_STATE = "com.luxe.music.REQUEST_STATE";
    public static final String ACTION_SET_REPEAT = "com.luxe.music.SET_REPEAT";

    public static final String ACTION_STATE = "com.luxe.music.PLAYBACK_STATE";

    private static final String CHANNEL_ID = "luxe_playback";
    private static final int NOTIFICATION_ID = 4207;

    private static PlaybackKeepAliveService instance;
    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Runnable progressTicker = new Runnable() {
        @Override
        public void run() {
            if (playing) {
                publishState();
                progressHandler.postDelayed(this, 1000L);
            }
        }
    };

    private MediaPlayer player;
    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;

    private final List<Track> queue = new ArrayList<>();
    private int queueIndex = -1;
    private boolean repeat = false;
    private boolean preparing = false;
    private long pendingSeekMs = -1L;
    private Bitmap artworkBitmap;

    private String title = "LUXE Music";
    private String artist = "Local Music";
    private String songId = "";
    private long durationMs = 0L;
    private long positionMs = 0L;
    private boolean playing = false;

    private static class Track {
        String id;
        String title;
        String artist;
        String uri;

        Track(String id, String title, String artist, String uri) {
            this.id = id == null ? "" : id;
            this.title = title == null || title.trim().isEmpty() ? "Unknown Title" : title;
            this.artist = artist == null || artist.trim().isEmpty() ? "Unknown Artist" : artist;
            this.uri = uri == null ? "" : uri;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        createMediaSession();
        createPlayer();
        startForeground(NOTIFICATION_ID, buildNotification());
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "LUXE Music playback",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("LUXE Music background playback controls");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private void createPlayer() {
        player = new MediaPlayer();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
        }
        player.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);
        player.setOnPreparedListener(mp -> {
            preparing = false;
            durationMs = Math.max(0L, mp.getDuration());
            if (pendingSeekMs >= 0L) {
                long target = Math.min(pendingSeekMs, durationMs > 0L ? durationMs : pendingSeekMs);
                try { mp.seekTo((int) Math.min(target, Integer.MAX_VALUE)); } catch (Exception ignored) {}
                pendingSeekMs = -1L;
            }
            mp.start();
            playing = true;
            acquireWakeLock();
            progressHandler.removeCallbacks(progressTicker);
            progressHandler.postDelayed(progressTicker, 1000L);
            publishState();
        });

        player.setOnCompletionListener(mp -> {
            preparing = false;
            playing = false;
            progressHandler.removeCallbacks(progressTicker);
            releaseWakeLock();

            if (repeat && queueIndex >= 0 && queueIndex < queue.size()) {
                playIndex(queueIndex, true);
                return;
            }

            if (queueIndex + 1 < queue.size()) {
                playIndex(queueIndex + 1, true);
                return;
            }

            positionMs = durationMs;
            publishState();
        });

        player.setOnErrorListener((mp, what, extra) -> {
            preparing = false;
            playing = false;
            releaseWakeLock();
            publishState();
            return true;
        });
    }

    private void createMediaSession() {
        mediaSession = new MediaSession(this, "LUXE Music");
        mediaSession.setFlags(
                MediaSession.FLAG_HANDLES_MEDIA_BUTTONS |
                MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
        );

        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() { resumePlayback(); }

            @Override
            public void onPause() { pausePlayback(); }

            @Override
            public void onSkipToNext() { nextPlayback(); }

            @Override
            public void onSkipToPrevious() { previousPlayback(); }

            @Override
            public void onSeekTo(long pos) { seekPlayback(pos); }

            @Override
            public void onStop() { stopPlayback(true); }
        });

        mediaSession.setActive(true);
    }

    private PendingIntent serviceAction(String action, int requestCode) {
        Intent intent = new Intent(this, PlaybackKeepAliveService.class);
        intent.setAction(action);
        return PendingIntent.getService(
                this,
                requestCode,
                intent,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                        : PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    private PendingIntent launchIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this,
                10,
                intent,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                        : PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        int playIcon = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;

        builder.setSmallIcon(playIcon)
                .setContentTitle(title)
                .setContentText(artist)
                .setContentIntent(launchIntent())
                .setLargeIcon(artworkBitmap)
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_previous,
                        "Previous",
                        serviceAction(ACTION_PREVIOUS, 11)).build())
                .addAction(new Notification.Action.Builder(
                        playIcon,
                        playing ? "Pause" : "Play",
                        serviceAction(playing ? ACTION_PAUSE : ACTION_PLAY, 12)).build())
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_next,
                        "Next",
                        serviceAction(ACTION_NEXT, 13)).build());

        if (mediaSession != null) {
            builder.setStyle(new Notification.MediaStyle()
                    .setMediaSession(mediaSession.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2));
        }

        return builder.build();
    }

    private void publishState() {
        positionMs = player != null && player.isPlaying() ? safeCurrentPosition() : positionMs;
        if (player != null && player.isPlaying()) {
            durationMs = safeDuration();
            playing = true;
        }

        updateMediaSession();

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());

        Intent state = new Intent(ACTION_STATE);
        state.setPackage(getPackageName());
        state.putExtra("id", songId);
        state.putExtra("title", title);
        state.putExtra("artist", artist);
        state.putExtra("playing", playing);
        state.putExtra("position", positionMs);
        state.putExtra("duration", durationMs);
        state.putExtra("queueIndex", queueIndex);
        state.putExtra("queueSize", queue.size());
        sendBroadcast(state);
    }

    private void updateMediaSession() {
        if (mediaSession == null) return;

        long actions = PlaybackState.ACTION_PLAY |
                PlaybackState.ACTION_PAUSE |
                PlaybackState.ACTION_PLAY_PAUSE |
                PlaybackState.ACTION_SKIP_TO_NEXT |
                PlaybackState.ACTION_SKIP_TO_PREVIOUS |
                PlaybackState.ACTION_SEEK_TO |
                PlaybackState.ACTION_STOP;

        int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        long pos = Math.max(0L, positionMs);
        if (player != null && player.isPlaying()) pos = safeCurrentPosition();

        mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(state, pos, 1.0f)
                .build());

        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "LUXE Music")
                .putLong(MediaMetadata.METADATA_KEY_DURATION, Math.max(0L, durationMs));
        if (artworkBitmap != null && !artworkBitmap.isRecycled()) {
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artworkBitmap);
        }
        mediaSession.setMetadata(metadata.build());
    }

    private long safeCurrentPosition() {
        try { return player == null ? 0L : Math.max(0, player.getCurrentPosition()); }
        catch (Exception ignored) { return positionMs; }
    }

    private long safeDuration() {
        try { return player == null ? durationMs : Math.max(0, player.getDuration()); }
        catch (Exception ignored) { return durationMs; }
    }

    private void startQueue(String json, int index, boolean repeatMode) {
        try {
            JSONArray array = new JSONArray(json == null ? "[]" : json);
            queue.clear();

            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) continue;
                String uri = item.optString("uri", "");
                if (uri.isEmpty()) continue;
                queue.add(new Track(
                        item.optString("id", ""),
                        item.optString("title", "Unknown Title"),
                        item.optString("artist", "Unknown Artist"),
                        uri
                ));
            }

            repeat = repeatMode;
            if (queue.isEmpty()) return;

            if (index < 0) index = 0;
            if (index >= queue.size()) index = queue.size() - 1;
            playIndex(index, true);
        } catch (Exception ignored) {}
    }

    private void playIndex(int index, boolean autoplay) {
        if (index < 0 || index >= queue.size()) return;

        Track track = queue.get(index);
        queueIndex = index;
        title = track.title;
        artist = track.artist;
        songId = track.id;
        positionMs = 0L;
        durationMs = 0L;
        pendingSeekMs = -1L;
        loadArtwork(track.uri);
        playing = false;
        preparing = true;
        publishState();

        try {
            player.reset();
            player.setDataSource(this, Uri.parse(track.uri));
            player.prepareAsync();
        } catch (Exception ignored) {
            preparing = false;
            playing = false;
            publishState();
        }
    }

    private void resumePlayback() {
        if (player == null) return;
        try {
            if (!player.isPlaying()) {
                player.start();
                playing = true;
                acquireWakeLock();
                progressHandler.removeCallbacks(progressTicker);
                progressHandler.postDelayed(progressTicker, 1000L);
                publishState();
            }
        } catch (Exception ignored) {}
    }

    private void pausePlayback() {
        if (player == null) return;
        try {
            if (player.isPlaying()) player.pause();
            positionMs = safeCurrentPosition();
        } catch (Exception ignored) {}
        playing = false;
        progressHandler.removeCallbacks(progressTicker);
        releaseWakeLock();
        publishState();
    }

    private void nextPlayback() {
        if (queueIndex + 1 < queue.size()) playIndex(queueIndex + 1, true);
    }

    private void previousPlayback() {
        long position = safeCurrentPosition();
        if (position > 3000L) {
            seekPlayback(0L);
            return;
        }
        if (queueIndex > 0) playIndex(queueIndex - 1, true);
    }

    private void seekPlayback(long position) {
        try {
            long requested = Math.max(0L, position);
            if (player == null) return;

            if (preparing) {
                pendingSeekMs = requested;
                positionMs = requested;
                publishState();
                return;
            }

            long duration = safeDuration();
            long targetMs = Math.max(0L, Math.min(requested, duration > 0 ? duration : requested));
            int target = (int) Math.min(targetMs, Integer.MAX_VALUE);
            player.seekTo(target);
            positionMs = target;
            publishState();
        } catch (Exception ignored) {}
    }

    private void loadArtwork(String uriString) {
        releaseArtwork();
        if (uriString == null || uriString.isEmpty()) {
            return;
        }

        final String artworkForSongId = songId;
        new Thread(() -> {
            Bitmap bitmap = null;
            MediaMetadataRetriever retriever = new MediaMetadataRetriever();
            try {
                retriever.setDataSource(this, Uri.parse(uriString));
                byte[] embedded = retriever.getEmbeddedPicture();
                if (embedded != null && embedded.length > 0) {
                    Bitmap original = BitmapFactory.decodeByteArray(embedded, 0, embedded.length);
                    if (original != null) {
                        int max = 512;
                        int w = original.getWidth();
                        int h = original.getHeight();
                        if (w > max || h > max) {
                            float scale = Math.min((float) max / w, (float) max / h);
                            bitmap = Bitmap.createScaledBitmap(original, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), true);
                            if (bitmap != original && !original.isRecycled()) original.recycle();
                        } else {
                            bitmap = original;
                        }
                    }
                }
            } catch (Exception ignored) {
            } finally {
                try { retriever.release(); } catch (Exception ignored) {}
            }

            final Bitmap result = bitmap;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (artworkForSongId.equals(songId) && !artworkForSongId.isEmpty() && result != null) {
                    if (artworkBitmap != null && artworkBitmap != result && !artworkBitmap.isRecycled()) {
                        artworkBitmap.recycle();
                    }
                    artworkBitmap = result;
                    publishState();
                }
            });
        }, "LUXE-Cover-Art").start();
    }

    private void releaseArtwork() {
        if (artworkBitmap != null && !artworkBitmap.isRecycled()) {
            artworkBitmap.recycle();
        }
        artworkBitmap = null;
    }

    private void stopPlayback(boolean removeNotification) {
        try { if (player != null) player.stop(); } catch (Exception ignored) {}
        playing = false;
        preparing = false;
        releaseWakeLock();
        publishState();
        if (removeNotification) stopForeground(true);
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) return;
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LUXE:NativePlayback");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        } catch (Exception ignored) {}
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
        }
        wakeLock = null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_PLAY_QUEUE.equals(action)) {
                startQueue(
                        intent.getStringExtra("queue"),
                        intent.getIntExtra("index", 0),
                        intent.getBooleanExtra("repeat", false)
                );
            } else if (ACTION_PLAY.equals(action)) {
                resumePlayback();
            } else if (ACTION_PAUSE.equals(action)) {
                pausePlayback();
            } else if (ACTION_NEXT.equals(action)) {
                nextPlayback();
            } else if (ACTION_PREVIOUS.equals(action)) {
                previousPlayback();
            } else if (ACTION_SEEK.equals(action)) {
                seekPlayback(intent.getLongExtra("position", 0L));
            } else if (ACTION_STOP.equals(action)) {
                stopPlayback(true);
            } else if (ACTION_SET_REPEAT.equals(action)) {
                repeat = intent.getBooleanExtra("repeat", false);
                publishState();
            } else if (ACTION_REQUEST_STATE.equals(action)) {
                publishState();
            }
        }
        return START_STICKY;
    }

    public static void requestState(Context context) {
        PlaybackKeepAliveService service = instance;
        if (service != null) service.publishState();
    }

    @Override
    public void onDestroy() {
        progressHandler.removeCallbacks(progressTicker);
        releaseWakeLock();
        if (instance == this) instance = null;
        if (player != null) {
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
        releaseArtwork();
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.release();
            } catch (Exception ignored) {}
            mediaSession = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
