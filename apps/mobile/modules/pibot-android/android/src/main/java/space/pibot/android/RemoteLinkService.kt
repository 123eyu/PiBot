package space.pibot.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Added 2026-11-11: keeps the process out of the background freeze while the phone
 * is the remote control of a paired computer (connected or reconnecting). It owns no network state:
 * the JS link keeps its own sockets and keepalive. Native events drive background ticks because
 * React Native frame timers pause with the Activity. A bounded CPU lease keeps execution schedulable
 * while opted in; vendor restrictions can still stop the service. No Wi-Fi lock.
 *
 * Type connectedDevice (Android 14+): a link to the user's own paired computer. Its prerequisite
 * permission is CHANGE_WIFI_MULTICAST_STATE, which the app already declares for LAN discovery.
 * dataSync is wrong here: Android 15 caps it at six hours a day. `stopWithTask`: swiping the app
 * away ends the remote control too.
 */
class RemoteLinkService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var cpuLease: PowerManager.WakeLock? = null
  private val renewLease = object : Runnable {
    override fun run() {
      if (!running) return
      // The lease is deliberately bounded: cleanup failure cannot leave an indefinite wake lock.
      cpuLease?.acquire(120_000L)
      handler.postDelayed(this, 60_000L)
    }
  }

  private val beat = object : Runnable {
    override fun run() {
      if (!running) return
      onTick?.invoke()
      handler.postDelayed(this, 5_000L)
    }
  }

  companion object {
    // The Expo context owns this callback; no socket or encryption state enters native code.
    @Volatile var onTick: (() -> Unit)? = null
    const val CHANNEL = "remote_link"
    private const val NOTIFICATION_ID = 0x5b07
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_BODY = "body"
    private const val EXTRA_CHANNEL = "channel"
    @Volatile var running = false
      private set

    fun intent(context: Context, title: String, body: String, channelName: String) =
      Intent(context, RemoteLinkService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_BODY, body)
        .putExtra(EXTRA_CHANNEL, channelName)

    /** Same notification, new text (connected ↔ reconnecting); allowed from the background. */
    fun update(context: Context, title: String, body: String, channelName: String) {
      if (!running) return
      ensureChannel(context, channelName)
      context.getSystemService(NotificationManager::class.java)
        ?.notify(NOTIFICATION_ID, build(context, title, body))
    }

    private fun ensureChannel(context: Context, name: String) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      // Low importance: no sound, no heads-up; re-creating only renames it (language switch).
      val channel = NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_LOW)
      channel.setShowBadge(false)
      context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun build(context: Context, title: String, body: String): Notification {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val open =
        launch?.let {
          PendingIntent.getActivity(
            context,
            0,
            it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          )
        }
      return NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(body)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .apply { if (open != null) setContentIntent(open) }
        .build()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // A restart by the system has no JS link to keep alive: end instead of showing a stale notice.
    if (intent == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
    val body = intent.getStringExtra(EXTRA_BODY) ?: ""
    ensureChannel(this, intent.getStringExtra(EXTRA_CHANNEL) ?: title)
    val type =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
      else 0
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, build(this, title, body), type)
      running = true
      if (cpuLease == null) {
        cpuLease = (getSystemService(Context.POWER_SERVICE) as PowerManager)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pibot:remote-link")
          .apply { setReferenceCounted(false) }
        handler.post(renewLease)
        handler.post(beat)
      }
    } catch (_: RuntimeException) {
      // ForegroundServiceStartNotAllowedException / missing type permission: no service; the
      // JS link falls back to the background grace. The caller learns it from `running`.
      running = false
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    handler.removeCallbacks(renewLease)
    handler.removeCallbacks(beat)
    cpuLease?.let { if (it.isHeld) it.release() }
    cpuLease = null
    super.onDestroy()
  }
}
