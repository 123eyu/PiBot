package space.pibot.android

import android.service.notification.NotificationListenerService

/** Read the system's live snapshot on demand; never retain notification bodies. */
class PhoneNotifications : NotificationListenerService() {
  companion object { @Volatile var current: PhoneNotifications? = null }
  override fun onListenerConnected() { current = this }
  override fun onListenerDisconnected() { if (current === this) current = null }
  override fun onDestroy() { if (current === this) current = null; super.onDestroy() }
}
