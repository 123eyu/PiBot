import { AndroidConfig, type ConfigPlugin, withInfoPlist } from "expo/config-plugins";

const unrelatedPermissions = [
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.BLUETOOTH",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.SYSTEM_ALERT_WINDOW",
];

/** The upstream plugin assumes calls with media; Pi Bot only uses encrypted DataChannels. */
export const withDataOnlyWebRtc: ConfigPlugin = (config) => {
  // Merger removal markers also prevent dependency manifests from restoring these permissions.
  config = AndroidConfig.Permissions.withBlockedPermissions(config, unrelatedPermissions);
  return withInfoPlist(config, (next) => {
    delete next.modResults.NSMicrophoneUsageDescription;
    return next;
  });
};
