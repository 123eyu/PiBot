package space.pibot.android

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.CancellationSignal
import android.provider.CallLog
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * One bounded page (at most 25 items) of call metadata or active notifications, read on
 * request only. Calls carry id / time / duration / type, never the number, contact, location or
 * recording. Nothing read here is stored or logged. Each read holds a reservation whose
 * CancellationSignal JavaScript cancels on abort, timeout or completion.
 */
object PhoneReadPages {
  private const val MAX_PENDING = 4
  private const val MAX_PAGE = 25
  private val pending = ConcurrentHashMap<String, CancellationSignal>()

  @Synchronized
  fun begin(): String {
    check(pending.size < MAX_PENDING) { "phone_busy" }
    val id = UUID.randomUUID().toString()
    pending[id] = CancellationSignal()
    return id
  }

  fun cancel(id: String) {
    pending.remove(id)?.cancel()
  }

  fun dispose() {
    pending.keys.toList().forEach { cancel(it) }
  }

  // System keys can be long and identify the posting app's internals; a fixed-length digest keeps
  // the cursor stable without handing the raw key out.
  private fun notificationId(key: String): String =
    MessageDigest.getInstance("SHA-256")
      .digest(key.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it.toInt() and 255) }

  private fun listener(ctx: Context) = ComponentName(ctx, PhoneNotifications::class.java)

  // Play builds leave the service out of the manifest (config plugin), so it reports unsupported.
  @Suppress("DEPRECATION")
  private fun listenerDeclared(ctx: Context): Boolean =
    try {
      ctx.packageManager.getServiceInfo(listener(ctx), 0)
      true
    } catch (_: PackageManager.NameNotFoundException) {
      false
    }

  @Suppress("DEPRECATION")
  private fun declaresCallLog(ctx: Context): Boolean =
    ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.GET_PERMISSIONS)
      .requestedPermissions?.contains(Manifest.permission.READ_CALL_LOG) ?: false

  fun permission(ctx: Context, kind: String): String =
    when (kind) {
      "notifications" ->
        when {
          !listenerDeclared(ctx) -> "unsupported"
          !NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName) -> "denied"
          PhoneNotifications.current != null -> "granted"
          else -> {
            // Access is on but the system has not bound the service (e.g. after an update).
            NotificationListenerService.requestRebind(listener(ctx))
            "denied"
          }
        }
      "calls" ->
        when {
          !declaresCallLog(ctx) -> "unsupported"
          ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CALL_LOG) ==
            PackageManager.PERMISSION_GRANTED -> "granted"
          else -> "denied"
        }
      else -> "unsupported"
    }

  fun read(
    ctx: Context,
    requestId: String,
    kind: String,
    beforeTime: Long,
    beforeId: String,
    requested: Int,
  ): Map<String, Any?> {
    val cancellation = pending[requestId] ?: error("phone_offline")
    cancellation.throwIfCanceled()
    check(permission(ctx, kind) == "granted") { "phone_permission_denied" }
    val limit = requested.coerceIn(1, MAX_PAGE)
    // One extra row tells whether another page exists.
    val rows = when (kind) {
      "notifications" -> notifications(cancellation, beforeTime, beforeId, limit + 1)
      "calls" -> calls(ctx, cancellation, beforeTime, beforeId, limit + 1)
      else -> error("unsupported_platform")
    }
    val items = rows.take(limit)
    val next = if (rows.size > limit) items.last().let { mapOf("at" to it["at"], "id" to it["id"]) } else null
    return mapOf("items" to items, "next" to next)
  }

  private fun notifications(
    cancellation: CancellationSignal,
    beforeTime: Long,
    beforeId: String,
    max: Int,
  ): List<Map<String, Any?>> {
    val service = PhoneNotifications.current ?: error("phone_permission_denied")
    val snapshot = (service.activeNotifications ?: emptyArray()).map { notificationId(it.key) to it }
      .sortedWith(
        compareByDescending<Pair<String, StatusBarNotification>> { it.second.postTime }
          .thenByDescending { it.first },
      )
    val rows = mutableListOf<Map<String, Any?>>()
    for ((id, n) in snapshot) {
      cancellation.throwIfCanceled()
      // Keyset cursor over (postTime, id) descending: keep only rows strictly after the cursor.
      if (n.postTime > beforeTime || (n.postTime == beforeTime && id >= beforeId)) continue
      val extras = n.notification.extras
      rows.add(
        mapOf(
          "id" to id,
          "at" to n.postTime.toDouble(),
          "app" to n.packageName.take(256),
          "title" to extras.getCharSequence("android.title")?.toString()?.take(512),
          "text" to extras.getCharSequence("android.text")?.toString()?.take(2048),
        ),
      )
      if (rows.size >= max) break
    }
    return rows
  }

  private fun calls(
    ctx: Context,
    cancellation: CancellationSignal,
    beforeTime: Long,
    beforeId: String,
    max: Int,
  ): List<Map<String, Any?>> {
    val rows = mutableListOf<Map<String, Any?>>()
    val uri = CallLog.Calls.CONTENT_URI.buildUpon()
      .appendQueryParameter(CallLog.Calls.LIMIT_PARAM_KEY, max.toString())
      .build()
    // Parameterized keyset page; the projection never names the number or cached contact columns.
    ctx.contentResolver.query(
      uri,
      arrayOf(CallLog.Calls._ID, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE),
      "${CallLog.Calls.DATE} < ? OR (${CallLog.Calls.DATE} = ? AND ${CallLog.Calls._ID} < ?)",
      arrayOf(beforeTime.toString(), beforeTime.toString(), beforeId),
      "${CallLog.Calls.DATE} DESC, ${CallLog.Calls._ID} DESC",
      cancellation,
    )?.use { cursor ->
      while (rows.size < max && cursor.moveToNext()) {
        cancellation.throwIfCanceled()
        rows.add(
          mapOf(
            "id" to cursor.getString(0),
            "at" to cursor.getLong(1).toDouble(),
            "duration" to cursor.getLong(2).toDouble(),
            "type" to cursor.getInt(3),
          ),
        )
      }
    }
    return rows
  }
}
