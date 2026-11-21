import { SAFE_SYSTEM_SERVICES } from "./sandbox-config.ts";

/**
 * Services a card may never open, once or remembered: they expose credentials or tokens
 * (keychain, smart cards, authorization), control or read the screen, input and other apps
 * (WindowServer, accessibility, Apple Events, LaunchServices), grant privacy access (TCC),
 * reach devices or location (camera, microphone, location), share data out (pasteboard,
 * sharing) or write another app's preferences (cfprefsd). The whole audio family is closed
 * because the audio HAL (audiohald) also carries microphone input, and Shortcuts / Siri because a
 * shortcut runs arbitrary actions, shell scripts included, outside the sandbox (acceptance,
 * 2026-11-16: afplay and `shortcuts list` reached these as rememberable cards). Such a command
 * runs outside the sandbox once instead, which the user confirms each time.
 */
const NEVER_OPENED =
  /^com\.apple\.(?:SecurityServer|securityd|security\.|secd|seckeychain|trustd\.keychain|ctkd|ctkahp|CryptoTokenKit|authd|authorizationhost|tccd|TCC|windowserver|CoreGraphics|WindowServer|accessibility|axserver|AXserver|universalaccess|pasteboard|pboard|appleevent|AppleEvent|ae\.|coreservices\.(?:appleevents|launchservices|uiagent|lsuseractivity)|lsd|LaunchServices|launchservices|cfprefsd|audio\.|siri\.|shortcuts|VoiceShortcuts|cmio|coremedia|avfoundation|camera|locationd|corelocation|sharingd|screencapture|ScreenCapture|replayd|hiservices|HIToolbox|dock|loginwindow|SystemUIServer|notificationcenterui|installd|PackageKit|xpc\.smd|ServiceManagement|bluetoothd|usbd|IOHID)/i;

/** A service name a card may name: well-formed and not one of the services above. */
export function allowedSandboxSystemService(service: string) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(service) && !NEVER_OPENED.test(service);
}

/** A runtime upgrade may move a previously remembered service into the safe baseline. */
export function rememberableSystemService(service: string) {
  return (
    allowedSandboxSystemService(service) &&
    !(SAFE_SYSTEM_SERVICES as readonly string[]).includes(service)
  );
}
