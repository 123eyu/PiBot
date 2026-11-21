import type { ComputerDelivery, ComputerPointerKind, ComputerUiAction } from "@pibot/protocol-base";

export type Platform = "darwin" | "win32" | "linux";
export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Point, Size {}

export interface DisplayReadDiagnostic {
  reason:
    | "read"
    | "no_values"
    | "not_calculator"
    | "window_limit"
    | "window_missing"
    | "window_ambiguous"
    | "role_missing"
    | "children_invalid"
    | "identity_changed"
    | "attribute_unavailable"
    | "bridge_failed"
    | "time_limit"
    | "node_limit"
    | "depth_limit"
    | "worker_failed"
    | "worker_timeout"
    | "cancelled"
    | "invalid_reply"
    | "output_limit"
    | "already_present";
  visited: number;
  found: number;
  axStatus: number;
  added?: number;
  visible?: number;
  visibility?: "visible" | "secure_scan_incomplete" | "filtered_or_hidden" | "no_values";
}
export interface TreeTruncation {
  reason: "node_limit" | "depth_limit" | "driver";
  depthReached: number;
  remainingNodes: number | null;
}

export interface AppInfo {
  /** Bundle id (macOS), executable name (Windows) or app name (Linux). */
  id: string;
  name: string;
  pid: number;
  active: boolean;
}

export interface InstalledApp {
  /** Same identifier as AppInfo.id and app_blocklist.app_id; compare case-insensitively. */
  id: string;
  name: string;
  iconPath?: string;
  /** OS category when the platform has one (macOS LSApplicationCategoryType). */
  osCategory?: string;
}

export interface WindowInfo {
  /** Driver window id as a decimal string (CGWindowID / HWND / X11 id). */
  id: string;
  /** The app the window is reported for (grants, focus checks, foreground). */
  pid: number;
  /**
   * The process the OS says owns the window when that is not the app itself: a classic UWP app
   * draws inside an ApplicationFrameHost.exe window. Driver calls that address the
   * window natively must use this pid; everything above the driver uses `pid`.
   */
  hostPid?: number;
  title: string;
  /** Global logical points. */
  bounds: Rect;
  onScreen: boolean;
  minimized: boolean;
  onCurrentSpace: boolean;
  layer: number;
  /** Stacking order, higher is closer to the front; absent when the OS did not say. */
  z?: number;
}

/** Element as the driver reports it, before Pi Bot's redaction and filtering. */
export interface RawElement {
  token?: string;
  index: number;
  parentIndex?: number;
  depth: number;
  role: string;
  label?: string;
  value?: string;
  valueDescription?: string;
  enabled?: boolean;
  selected?: boolean;
  actions: string[];
  /** Global logical points. */
  frame?: Rect;
  /** Set when an OS-level check found a password field at this element's frame. */
  secure?: boolean;
}

export interface WindowCapture {
  /** Encoded image as the driver returned it (PNG or JPEG). */
  bytes: Uint8Array;
  mimeType: string;
  /** Pixel size of `bytes`. */
  pixels: Size;
  /** Window bounds at capture time, global logical points. */
  bounds: Rect;
}

export interface PointerStep {
  kind: ComputerPointerKind;
  /** Global logical points. */
  at: Point;
  to?: Point;
  dx?: number;
  dy?: number;
  delivery: ComputerDelivery;
  inject?: InputInjection;
}

export interface KeysStep {
  elementToken?: string;
  text?: string;
  combo?: string[];
  delivery: ComputerDelivery;
  inject?: InputInjection;
}

/** Starts at native HID dispatch, and ends only when that native operation settles. */
export type InputInjection = <T>(run: () => Promise<T>) => Promise<T>;

export interface DriverFeatures {
  backgroundClick: boolean;
  backgroundDrag: boolean;
  backgroundKeys: boolean;
  /**
   * Whether the driver's tree marks password fields (macOS AXSecureTextField, AT-SPI password
   * text). Cua on Windows reports them as plain Edit, so an element target there is not
   * evidence and the OS focus check must prove the field is not a password field.
   */
  secureTree: boolean;
}

export interface SessionState {
  /** Seconds since the last HID input (may include the driver's own injections). */
  hidIdleSeconds: number;
  locked: boolean;
}

/**
 * One platform's driver. Coordinates are already global logical points; screenshot
 * pixel conversion, grants, blocklist and redaction live in the service above it.
 * Every method is bounded by the caller's signal and the driver's own per-call timeout.
 */
export interface ComputerDriver {
  readonly platform: Platform;
  readonly features: DriverFeatures;
  /** Why the driver cannot run here, or undefined when usable. */
  unavailableReason(signal?: AbortSignal): Promise<string | undefined>;
  listApps(signal?: AbortSignal): Promise<AppInfo[]>;
  /** Read-only OS name alias lookup; identifies an installed app without launching it. */
  resolveAppName?(name: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Installed (not only running) apps, read-only, at most `limit`. */
  installedApps(
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ apps: InstalledApp[]; truncated: boolean }>;
  frontmostApp(signal?: AbortSignal): Promise<AppInfo | null>;
  /**
   * The program path behind an app ID, for launches where the ID alone cannot be opened
   * (Windows: exe-name IDs). Undefined when the driver does not know it.
   */
  launchPath?(appId: string, signal?: AbortSignal): Promise<string | undefined>;
  windows(pid: number, signal?: AbortSignal): Promise<WindowInfo[]>;
  /** On-screen windows of every app, back to front (for masking display screenshots). */
  onScreenWindows(signal?: AbortSignal): Promise<WindowInfo[]>;
  captureWindow(window: WindowInfo, signal?: AbortSignal): Promise<WindowCapture>;
  /** Primary-display native capture; service masking and grants still apply. */
  captureDisplay?(index: number, signal?: AbortSignal): Promise<WindowCapture>;
  readTree(
    window: WindowInfo,
    options: {
      maxNodes: number;
      maxDepth: number;
      onDisplayRead?(value: DisplayReadDiagnostic): void;
    },
    signal?: AbortSignal,
  ): Promise<{
    elements: RawElement[];
    truncated: boolean;
    truncation?: TreeTruncation;
    /** Supplemental display values must not be erased or trusted using cached password geometry. */
    requireFreshSecureScan?: boolean;
    displayRead?: DisplayReadDiagnostic;
    /** Internal provenance for counting only supplemental values after security/filtering. */
    displayElementIndexes?: number[];
  }>;
  uiAction(
    window: WindowInfo,
    elementToken: string,
    action: ComputerUiAction,
    value: string | undefined,
    signal?: AbortSignal,
  ): Promise<"confirmed" | "unverified">;
  /**
   * Presses an item of the app's menu bar by its titles (["Edit", "Delete"]). `window` is
   * the app window whose menu bar is meant; foreground = brings it to the front first (the user
   * agreed). Throws `unsupported` where the platform has no verified route.
   */
  invokeMenu(
    window: WindowInfo,
    path: string[],
    delivery: ComputerDelivery,
    signal?: AbortSignal,
  ): Promise<{ effect: "confirmed" | "unverified"; delivery: "background" | "foreground" }>;
  pointer(
    window: WindowInfo,
    step: PointerStep,
    signal?: AbortSignal,
  ): Promise<"background" | "foreground">;
  keys(
    window: WindowInfo,
    step: KeysStep,
    signal?: AbortSignal,
  ): Promise<"background" | "foreground">;
  /**
   * Whether the app's focused element (or the element at `at`) is a password field.
   * "unknown" when the platform cannot tell; callers refuse free-form keys then.
   * "occluded" when `at` landed in another window (the target is covered), so the caller can
   * say why instead of a generic unknown.
   * `windowId` lets a platform that can see it reject focus sitting in another window of the
   * same app; platforms that cannot tell ignore it.
   */
  secureFocus(
    pid: number,
    at?: Point,
    signal?: AbortSignal,
    windowId?: string,
  ): Promise<boolean | "unknown" | "occluded">;
  /**
   * The same question about one element of `window`, asked by the element itself — its own
   * accessibility element and its own control handle — instead of the point under it. A covered
   * window answers a point query with "occluded", which used to make background input into it
   * impossible; identifying the element by the frame the tree reported keeps that working
   * without trusting whatever covers it. "unknown" when the platform cannot identify
   * the element; callers refuse then.
   */
  secureElement?(
    window: WindowInfo,
    frame: Rect,
    signal?: AbortSignal,
  ): Promise<boolean | "unknown">;
  /**
   * Select one item of `window` through the platform's own selection interface, without moving
   * the real pointer (Cua's Windows "pick" click moved it onto the row and back, which
   * the user sees). "unsupported" when the element there is not a selectable item; callers then
   * refuse instead of clicking, because a silent cursor move is what this exists to prevent.
   * "selected_foreground" means the row was selected but the selection brought the app to the
   * front: the caller reports that instead of claiming an invisible background step.
   * "selected_unverified" means selection was sent but readback differs from the target; this
   * must be reported as an executed, unverified step rather than a before-delivery refusal.
   * Absent platforms select with a click.
   */
  selectElement?(
    window: WindowInfo,
    frame: Rect,
    signal?: AbortSignal,
  ): Promise<
    "selected" | "selected_foreground" | "selected_unverified" | "unsupported" | "unknown"
  >;
  /** OS focus facts only, never field text; absent platforms cannot waive an incomplete scan. */
  focusedInput?(
    pid: number,
    signal?: AbortSignal,
  ): Promise<{ role: string; subrole: string; frame: Rect; secure: boolean } | null>;
  /** Fresh OS receiver and bounded value; password values must never be read. */
  focusedValue?(
    window: WindowInfo,
    signal?: AbortSignal,
  ): Promise<{
    role: string;
    subrole: string;
    frame: Rect;
    secure: boolean;
    value?: string;
  } | null>;
  /**
   * Frames of the app's password fields, for drivers whose tree hides the field type (Cua on
   * macOS reports Chromium password inputs as AXTextField). complete=false: budget ran out.
   * `window` limits the walk to that window when the OS can match it;
   * it is matched by title first and only then by frame, because the window server reports a
   * background app's window as Stage Manager's side-strip thumbnail on macOS.
   */
  secureFrames?(
    pid: number,
    window: { title?: string; bounds?: Rect } | undefined,
    signal?: AbortSignal,
  ): Promise<{
    frames: Rect[];
    complete: boolean;
    timing?: { windowMs: number; attributesMs: number; queueMs: number };
  }>;
  session(signal?: AbortSignal): Promise<SessionState>;
  /** Waits for native calls, including calls whose caller already cancelled. */
  drain?(): Promise<void>;
  /** Releases resident helpers (worker processes, native sessions); the driver can be reused. */
  release(): Promise<void>;
}
