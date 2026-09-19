package com.luxe.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.lang.ref.WeakReference;

/**
 * LUXE Android playback notification + lock-screen media controls.
 *
 * The HTML audio element remains the actual audio engine. This service owns
 * the Android MediaSession and the foreground notification so Android can
 * expose LUXE controls on the notification shade and lock screen.
 */
public class PlaybackKeepAliveService extends Service {

    public static final String ACTION_PREVIOUS = "com.luxe.music.PREVIOUS";
    public static final String ACTION_PLAY_PAUSE = "com.luxe.music.PLAY_PAUSE";
    public static final String ACTION_NEXT = "com.luxe.music.NEXT";
    public static final String ACTION_PLAY = "com.luxe.music.PLAY";
    public static final String ACTION_PAUSE = "com.luxe.music.PAUSE";

    private static final String CHANNEL_ID = "luxe_playback";
    private static final int NOTIFICATION_ID = 4207;

    private static WeakReference<PlaybackKeepAliveService> instance;

    private PowerManager.WakeLock wakeLock;
    private MediaSession mediaSession;

    private String title = "LUXE Music";
    private String artist = "Local Music";
    private boolean playing = false;
    private long durationMs = 0L;
    private long positionMs = 0L;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = new WeakReference<>(this);

        createChannel();
        createMediaSession();

        // The wake lock is enabled only while playback is actually running.
        startForeground(NOTIFICATION_ID, buildNotification());
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "LUXE Music playback",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("LUXE Music playback controls");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void createMediaSession() {
        mediaSession = new MediaSession(this, "LUXE Music");
        mediaSession.setFlags(
                MediaSession.FLAG_HANDLES_MEDIA_BUTTONS |
                MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
        );

        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                sendCommandToWeb("play");
            }

            @Override
            public void onPause() {
                sendCommandToWeb("pause");
            }

            @Override
            public void onSkipToNext() {
                sendCommandToWeb("next");
            }

            @Override
            public void onSkipToPrevious() {
                sendCommandToWeb("previous");
            }

            @Override
            public void onSeekTo(long pos) {
                sendCommandToWeb("seek:" + Math.max(0L, pos));
            }
        });

        mediaSession.setActive(true);
        updateMediaSessionState();
    }

    private void sendCommandToWeb(String command) {
        MainActivity.sendPlaybackCommand(command);
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
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        return PendingIntent.getActivity(
                this,
                10,
                launch,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                        : PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        int playIcon = playing
                ? android.R.drawable.ic_media_pause
                : android.R.drawable.ic_media_play;

        Notification.Action previous = new Notification.Action.Builder(
                android.R.drawable.ic_media_previous,
                "Previous",
                serviceAction(ACTION_PREVIOUS, 11)
        ).build();

        Notification.Action playPause = new Notification.Action.Builder(
                playIcon,
                playing ? "Pause" : "Play",
                serviceAction(ACTION_PLAY_PAUSE, 12)
        ).build();

        Notification.Action next = new Notification.Action.Builder(
                android.R.drawable.ic_media_next,
                "Next",
                serviceAction(ACTION_NEXT, 13)
        ).build();

        Notification.Action stop = new Notification.Action.Builder(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop",
                serviceAction(ACTION_PAUSE, 14)
        ).build();

        builder
                .setSmallIcon(playIcon)
                .setContentTitle(title)
                .setContentText(artist)
                .setContentIntent(launchIntent())
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(previous)
                .addAction(playPause)
                .addAction(next)
                .addAction(stop);

        if (mediaSession != null) {
            builder.setStyle(
                    new Notification.MediaStyle()
                            .setMediaSession(mediaSession.getSessionToken())
                            .setShowActionsInCompactView(0, 1, 2)
            );
        }

        return builder.build();
    }

    private void updateMediaSessionState() {
        if (mediaSession == null) return;

        long safePosition = Math.max(0L, positionMs);
        long safeDuration = Math.max(0L, durationMs);

        int state = playing
                ? PlaybackState.STATE_PLAYING
                : PlaybackState.STATE_PAUSED;

        long actions = PlaybackState.ACTION_PLAY |
                PlaybackState.ACTION_PAUSE |
                PlaybackState.ACTION_PLAY_PAUSE |
                PlaybackState.ACTION_SKIP_TO_NEXT |
                PlaybackState.ACTION_SKIP_TO_PREVIOUS |
                PlaybackState.ACTION_SEEK_TO;

        PlaybackState playbackState = new PlaybackState.Builder()
                .setActions(actions)
                .setState(state, safePosition, 1.0f)
                .build();

        mediaSession.setPlaybackState(playbackState);

        mediaSession.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "LUXE Music")
                .putLong(MediaMetadata.METADATA_KEY_DURATION, safeDuration)
                .build());
    }

    private void publishNotification() {
        updateMediaSessionState();

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    public static void updatePlayback(
            String newTitle,
            String newArtist,
            boolean newPlaying,
            long newDurationMs,
            long newPositionMs
    ) {
        PlaybackKeepAliveService service =
                instance == null ? null : instance.get();

        if (service == null) return;

        service.title = (newTitle == null || newTitle.trim().isEmpty())
                ? "LUXE Music"
                : newTitle;
        service.artist = (newArtist == null || newArtist.trim().isEmpty())
                ? "Local Music"
                : newArtist;
        service.playing = newPlaying;
        service.durationMs = Math.max(0L, newDurationMs);
        service.positionMs = Math.max(0L, newPositionMs);

        if (newPlaying) {
            service.acquireWakeLock();
        } else {
            service.releaseWakeLock();
        }

        service.publishNotification();
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) return;

            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;

            wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "LUXE:PlaybackKeepAlive"
            );
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
        if (intent != null && intent.getAction() != null) {
            String action = intent.getAction();

            if (ACTION_PREVIOUS.equals(action)) {
                sendCommandToWeb("previous");
            } else if (ACTION_NEXT.equals(action)) {
                sendCommandToWeb("next");
            } else if (ACTION_PLAY.equals(action)) {
                sendCommandToWeb("play");
            } else if (ACTION_PAUSE.equals(action)) {
                sendCommandToWeb("pause");
            } else if (ACTION_PLAY_PAUSE.equals(action)) {
                sendCommandToWeb(playing ? "pause" : "play");
            }
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.release();
            } catch (Exception ignored) {}
        }
        mediaSession = null;

        releaseWakeLock();

        if (instance != null) {
            instance.clear();
            instance = null;
        }

        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
