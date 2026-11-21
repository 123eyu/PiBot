import { MAC_STATIC_TEXT_SCRIPT } from "./mac-static-text-script.ts";

// Source of the resident macOS helper, run as `osascript -l JavaScript -e <source>`.
// Kept inline (not a file next to the bundle) so packaging needs no extra resource and the
// script cannot be swapped on disk. Derived from tools/probes/computer-use/feasibility/jxa/worker.jxa and
// tools/probes/computer-use/background-input/jxa/stamped-click.jxa (verified there).
// Protocol: one JSON request per stdin line {id, op, ...}; one JSON reply per stdout line
// {id, ok, result | error}. Bridge pitfalls: NSUInteger/NSRange arrive as strings (Number()
// them), never CFRelease bridge-owned objects (osascript crashes), buffer stdin by bytes.
// Framework imports use single quotes: the package check scans bundles for import("…") and
// would read these as npm dependencies.
export const MAC_WORKER_SCRIPT = String.raw`
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
var pending = $.NSMutableData.data;
var NL = $("\n").dataUsingEncoding($.NSUTF8StringEncoding);

function readLine() {
  for (;;) {
    var bytes = Number(pending.length);
    if (bytes > 0) {
      var nl = pending.rangeOfDataOptionsRange(NL, 0, $.NSMakeRange(0, bytes));
      var at = Number(nl.location);
      if (Number(nl.length) > 0 && at < bytes) {
        var line = pending.subdataWithRange($.NSMakeRange(0, at));
        var rest = pending.subdataWithRange($.NSMakeRange(at + 1, bytes - at - 1));
        pending = $.NSMutableData.dataWithData(rest);
        return $.NSString.alloc.initWithDataEncoding(line, $.NSUTF8StringEncoding).js;
      }
    }
    var data = stdin.availableData;
    if (Number(data.length) === 0) return null;
    pending.appendData(data);
  }
}

function write(obj) {
  stdout.writeData($(JSON.stringify(obj) + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
}

function unwrapStr(v) {
  if (v === null || v === undefined) return undefined;
  try {
    var u = ObjC.unwrap(v);
    if (typeof u === "string") return u;
  } catch (e) { /* not every ObjC value unwraps to a string; "no name" is a valid answer here */ }
  return undefined;
}

function resolveAppName(m) {
  var path = $.NSWorkspace.sharedWorkspace.fullPathForApplication(m.name);
  if (!unwrapStr(path)) return null;
  var bundle = $.NSBundle.bundleWithPath(path);
  return bundle ? (unwrapStr(bundle.bundleIdentifier) || null) : null;
}

function appInfo(a) {
  return {
    pid: Number(a.processIdentifier),
    name: a.localizedName.js || "",
    id: a.bundleIdentifier.js || "",
    active: !!a.active,
  };
}

// Regular (Dock) apps only: background agents and helpers are not operable targets.
function apps() {
  var list = $.NSWorkspace.sharedWorkspace.runningApplications;
  var out = [];
  for (var i = 0; i < Number(list.count); i++) {
    var a = list.objectAtIndex(i);
    if (Number(a.activationPolicy) !== 0) continue;
    out.push(appInfo(a));
  }
  return out;
}

// Installed apps from the standard folders (and one level of sub-folders such as Utilities):
// Info.plist only, through NSBundle; needs no privacy permission and prompts nothing.
function installed(m) {
  var fm = $.NSFileManager.defaultManager;
  var out = [];
  var seen = {};
  var truncated = false;
  function str(v) {
    try { var u = ObjC.unwrap(v); return typeof u === "string" ? u : undefined; } catch (e) { return undefined; }
  }
  function add(path) {
    var b = $.NSBundle.bundleWithPath(path);
    if (!b) return;
    var id = b.bundleIdentifier.js;
    if (!id || seen[id.toLowerCase()]) return;
    seen[id.toLowerCase()] = true;
    var info = b.infoDictionary;
    var name = fm.displayNameAtPath(path).js.replace(/\.app$/, "");
    var app = { id: id, name: name || id };
    var category = info ? str(info.objectForKey("LSApplicationCategoryType")) : undefined;
    if (category) app.osCategory = category;
    var icon = info ? str(info.objectForKey("CFBundleIconFile")) : undefined;
    if (icon) {
      var iconPath = path + "/Contents/Resources/" + (/\.icns$/.test(icon) ? icon : icon + ".icns");
      if (fm.fileExistsAtPath(iconPath)) app.iconPath = iconPath;
    }
    out.push(app);
  }
  function scan(dir, depth) {
    var items = fm.contentsOfDirectoryAtPathError(dir, null);
    if (!items) return;
    for (var i = 0; i < Number(items.count); i++) {
      if (out.length >= m.limit) { truncated = true; return; }
      var item = items.objectAtIndex(i).js;
      if (item.charAt(0) === ".") continue;
      var path = dir + "/" + item;
      if (/\.app$/.test(item)) add(path);
      else if (depth > 0) scan(path, depth - 1);
    }
  }
  for (var d = 0; d < m.dirs.length && !truncated; d++) scan(m.dirs[d], 1);
  return { apps: out, truncated: truncated };
}

function frontmost() {
  var a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return a ? appInfo(a) : null;
}

var ANY_INPUT = 0xffffffff;
function session() {
  var d = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary());
  var locked = d ? d.objectForKey("CGSSessionScreenIsLocked") : null;
  return {
    hid: $.CGEventSourceSecondsSinceLastEventType($.kCGEventSourceStateHIDSystemState, ANY_INPUT),
    locked: locked ? ObjC.unwrap(locked) === true : false,
  };
}

// Topmost visible window under a global point (window-server metadata, no pixels).
function windowAt(m) {
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
  for (var i = 0; i < Number(list.count); i++) {
    var w = list.objectAtIndex(i);
    var b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    if (!(m.x >= b.X && m.x < b.X + b.Width && m.y >= b.Y && m.y < b.Y + b.Height)) continue;
    var alpha = Number(ObjC.unwrap(w.objectForKey("kCGWindowAlpha")));
    if (alpha === 0) continue;
    return {
      pid: Number(ObjC.unwrap(w.objectForKey("kCGWindowOwnerPID"))),
      windowId: String(ObjC.unwrap(w.objectForKey("kCGWindowNumber"))),
      layer: Number(ObjC.unwrap(w.objectForKey("kCGWindowLayer"))),
    };
  }
  return null;
}

// Every visible window of every layer, front to back (window-server metadata, no pixels): the
// menu bar, notifications and other overlays that Cua's layer-0 list leaves out.
var LIST_ON_SCREEN_NO_DESKTOP = 1 | 16;
function screenWindows() {
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(LIST_ON_SCREEN_NO_DESKTOP, 0));
  var out = [];
  for (var i = 0; i < Number(list.count); i++) {
    var w = list.objectAtIndex(i);
    if (Number(ObjC.unwrap(w.objectForKey("kCGWindowAlpha"))) === 0) continue;
    var b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    out.push({
      id: String(ObjC.unwrap(w.objectForKey("kCGWindowNumber"))),
      pid: Number(ObjC.unwrap(w.objectForKey("kCGWindowOwnerPID"))),
      layer: Number(ObjC.unwrap(w.objectForKey("kCGWindowLayer"))),
      x: b.X, y: b.Y, width: b.Width, height: b.Height,
    });
  }
  return out;
}

function subroleOf(el) {
  var ref = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $("AXSubrole"), ref) !== 0 || !ref[0]) return undefined;
  return unwrapStr(ObjC.castRefToObject(ref[0]));
}

function roleOf(el) {
  var ref = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $("AXRole"), ref) !== 0 || !ref[0]) return undefined;
  return unwrapStr(ObjC.castRefToObject(ref[0]));
}

function isSecure(el) {
  return subroleOf(el) === "AXSecureTextField" || roleOf(el) === "AXSecureTextField";
}

function attr(el, name) {
  var ref = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), ref) !== 0 || !ref[0]) return null;
  return ObjC.castRefToObject(ref[0]);
}

// Chromium's hit test and focus land on the inner editor of an <input type=password>, not on
// the AXSecureTextField itself, so look a few parents up (a test session: Cua reported the
// field as a plain AXTextField and a direct hit test missed it).
function secureNear(el) {
  for (var i = 0; el && i < 4; i++) {
    if (isSecure(el)) return true;
    el = attr(el, "AXParent");
  }
  return false;
}

// Roles that can receive typed text. A Chromium input is reported through an inner editor, so
// the focused element or one of its few parents has to carry the role (same walk as secureNear).
var TEXT_ROLES = { AXTextField: 1, AXTextArea: 1, AXComboBox: 1, AXSearchField: 1, AXSecureTextField: 1 };
function textNear(el) {
  for (var i = 0; el && i < 4; i++) {
    if (TEXT_ROLES[roleOf(el)] === 1) return true;
    el = attr(el, "AXParent");
  }
  return false;
}

// Focused element of the app, and optionally the element at a global point. Also reports what
// actually holds the keyboard: a background Chromium app publishes no AXFocusedUIElement
// (measured: focus sat in a password field while the app was behind another window, and the old
// boolean answered "not a password field" for a receiver it could not see, so free-form keys went
// into that field). The caller lets text through only for a proven text input.
function secureFocus(m) {
  var app = $.AXUIElementCreateApplication(m.pid);
  var focused = attr(app, "AXFocusedUIElement");
  var secure = secureNear(focused);
  var hit = false;
  if (!secure && m.x !== undefined) {
    var at = Ref();
    if ($.AXUIElementCopyElementAtPosition(app, m.x, m.y, at) === 0 && at[0]) {
      hit = true;
      secure = secureNear(ObjC.castRefToObject(at[0]));
    }
  }
  return { secure: secure, focus: !focused ? "none" : textNear(focused) ? "text" : "other", hit: hit };
}

function axPoint(v) {
  var text = ObjC.castRefToObject($.CFCopyDescription(v)).js;
  var p = /x:([-\d.]+) y:([-\d.]+)/.exec(text);
  var s = /w:([-\d.]+) h:([-\d.]+)/.exec(text);
  if (p) return { x: +p[1], y: +p[2] };
  if (s) return { w: +s[1], h: +s[2] };
  return null;
}

// Unlike secureFocus's hit test, these facts describe only the actual keyboard receiver.
function focusedInput(m, withValue) {
  var app = $.AXUIElementCreateApplication(m.pid);
  var el = attr(app, "AXFocusedUIElement");
  if (!el) return null;
  var role = roleOf(el);
  var subrole = subroleOf(el);
  var position = attr(el, "AXPosition");
  var size = attr(el, "AXSize");
  // Plain text areas have no subrole; a password field always reports AXSecureTextField.
  if (!role || !position || !size) return null;
  var p = axPoint(position);
  var s = axPoint(size);
  if (!p || !s) return null;
  var result = { role: role, subrole: subrole || "", secure: secureNear(el),
    frame: { x: p.x, y: p.y, width: s.w, height: s.h } };
  var b = m.window;
  // Read only the verified receiver in this window; never fetch a password's AXValue.
  if (withValue && b && !result.secure && !/secure|password/i.test(role + " " + subrole) &&
      p.x >= b.x && p.y >= b.y && p.x + s.w <= b.x + b.width && p.y + s.h <= b.y + b.height) {
    var value = attr(el, "AXValue");
    if (value && Number($.CFGetTypeID(value)) === Number($.CFStringGetTypeID())) {
      result.value = value.substringToIndex(Math.min(2000, Number($.CFStringGetLength(value)))).js;
    }
  }
  return result;
}
function focusedValue(m) { return focusedInput(m, true); }

// Frames of every password field in the app's windows, breadth first within a node and time
// budget; complete=false when the budget ran out (the caller then trusts only hit tests).
// Geometry is a cross-process AX round trip too; only password nodes need it.
var SECURE_ATTRS = $(["AXRole", "AXSubrole", "AXChildren"]);
// AX has no public CGWindowID, so the target window is matched by frame (a tree read of
// one window should not spend the budget on the app's other windows). No match is incomplete.
function sameFrame(el, r) {
  var p = attr(el, "AXPosition");
  var s = attr(el, "AXSize");
  if (!p || !s) return false;
  var a = axPoint(p);
  var b = axPoint(s);
  return !!a && !!b && Math.abs(a.x - r.x) <= 2 && Math.abs(a.y - r.y) <= 2 &&
    Math.abs(b.w - r.width) <= 2 && Math.abs(b.h - r.height) <= 2;
}
// Which AX window the caller means. AX has no public CGWindowID, and the caller's geometry comes
// from the window server, which under Stage Manager reports a background app's window as the
// side-strip thumbnail: the frame no longer matches what AX reports, the walk finds
// no window and every background input looks unscanned. So the title decides first, geometry only
// narrows duplicate titles, and the app's single window is a target when it has just one. No
// unambiguous target returns null, which the caller reports as an incomplete scan (fail closed).
function targetWindows(list, want) {
  if (!want) return list;
  var title = want.title ? String(want.title).trim() : "";
  var byTitle = [];
  if (title) for (var i = 0; i < list.length; i++) {
    var seen = unwrapStr(attr(list[i], "AXTitle"));
    if (seen !== undefined && seen.trim() === title) byTitle.push(list[i]);
  }
  if (byTitle.length === 1) return byTitle;
  var pool = byTitle.length ? byTitle : list;
  var byFrame = [];
  if (want.bounds) for (var j = 0; j < pool.length; j++)
    if (sameFrame(pool[j], want.bounds)) byFrame.push(pool[j]);
  if (byFrame.length === 1) return byFrame;
  if (!byTitle.length && !byFrame.length && list.length === 1) return list;
  return null;
}
function secureFrames(m) {
  // options=0 returns per-attribute AXError values even when the batch itself succeeds.
  function field(values, index) {
    try {
      var value = values.objectAtIndex(index);
      if (value === null || value === undefined) return { value: null, error: NaN };
      if (Number($.CFGetTypeID(value)) === Number($.AXValueGetTypeID()) &&
          Number($.AXValueGetType(value)) === Number($.kAXValueAXErrorType)) {
        // AXValueGetValue needs a real out-buffer; an empty JXA Ref() is a null pointer and
        // segfaults the worker (seen on macOS 26.5). The description carries the code too.
        var text = ObjC.castRefToObject($.CFCopyDescription(value)).js;
        var match = /(-\d{4,6})/.exec(text);
        return { value: null, error: match ? Number(match[1]) : NaN };
      }
      return { value: value, error: null };
    } catch (e) { return { value: null, error: NaN }; }
  }
  // Optional subrole/children may be explicitly absent; transport and other AX failures
  // are not absence. Role is never optional, and a non-array children value is unknown.
  function absent(error) { return error === -25205 || error === -25212; }
  var started = Date.now();
  var timing = { windowMs: 0, attributesMs: 0, queueMs: 0 };
  var complete = true;
  var frames = [];
  function result(done) { return { frames: frames, complete: done && complete, timing: timing }; }
  var app = $.AXUIElementCreateApplication(m.pid);
  var queue = [];
  var windows = attr(app, "AXWindows");
  var list = [];
  var count = windows ? Number(windows.count) : 0;
  for (var w = 0; w < count; w++) {
    if (w >= m.maxNodes || Date.now() - started >= m.budgetMs) {
      timing.windowMs = Date.now() - started;
      return result(false);
    }
    list.push(windows.objectAtIndex(w));
  }
  var picked = targetWindows(list, m.window);
  timing.windowMs = Date.now() - started;
  if (!picked) return result(false);
  for (var q = 0; q < picked.length; q++) queue.push(picked[q]);
  var visited = 0;
  var cursor = 0;
  while (cursor < queue.length) {
    if (visited >= m.maxNodes || Date.now() - started >= m.budgetMs) return result(false);
    var el = queue[cursor];
    queue[cursor++] = null;
    visited++;
    var at = Date.now();
    var ref = Ref();
    var status = $.AXUIElementCopyMultipleAttributeValues(el, SECURE_ATTRS, 0, ref);
    timing.attributesMs += Date.now() - at;
    if (status !== 0 || !ref[0]) { complete = false; continue; }
    var vals = ObjC.castRefToObject(ref[0]);
    var roleField = field(vals, 0);
    var subroleField = field(vals, 1);
    var role = unwrapStr(roleField.value);
    var subrole = unwrapStr(subroleField.value);
    if (subroleField.error !== null && !absent(subroleField.error)) complete = false;
    if (subroleField.error === null && subrole === undefined) complete = false;
    if (!role) complete = false;
    if (role === "AXSecureTextField" || subrole === "AXSecureTextField") {
      var p = null;
      var s = null;
      at = Date.now();
      try { p = axPoint(attr(el, "AXPosition")); s = axPoint(attr(el, "AXSize")); } catch (e) { /* an element without a frame only loses its own hit region */ }
      timing.attributesMs += Date.now() - at;
      if (p && s && s.w > 0 && s.h > 0) frames.push({ x: p.x, y: p.y, width: s.w, height: s.h });
      else complete = false;
      continue;
    }
    at = Date.now();
    var children = field(vals, 2);
    var kids = children.value;
    var n = 0;
    if (children.error !== null) {
      if (!absent(children.error)) complete = false;
    } else try {
      if (Number($.CFGetTypeID(kids)) !== Number($.CFArrayGetTypeID())) complete = false;
      else {
        n = Number(kids.count);
        if (!Number.isSafeInteger(n) || n < 0) { complete = false; n = 0; }
      }
    } catch (e) { complete = false; n = 0; }
    for (var k = 0; k < n; k++) {
      if (queue.length - cursor >= m.maxNodes || Date.now() - started >= m.budgetMs) {
        timing.queueMs += Date.now() - at;
        return result(false);
      }
      var child = kids.objectAtIndex(k);
      if (!$.CFEqual(child, el)) queue.push(child);
    }
    timing.queueMs += Date.now() - at;
  }
  return result(Date.now() - started < m.budgetMs);
}

// Fallback for a foreground step when Cua cannot front the exact window (another Space or a
// full-screen app in front): activate the app and raise the AX window with these bounds.
function raise(m) {
  var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(m.pid);
  if (!running) return { raised: false };
  running.activateWithOptions(3);
  var app = $.AXUIElementCreateApplication(m.pid);
  var windows = attr(app, "AXWindows");
  if (!windows) return { raised: false };
  for (var i = 0; i < Number(windows.count); i++) {
    var win = windows.objectAtIndex(i);
    var p = attr(win, "AXPosition");
    var s = attr(win, "AXSize");
    var pos = p ? axPoint(p) : null;
    var size = s ? axPoint(s) : null;
    if (!pos || !size) continue;
    if (Math.abs(pos.x - m.x) > 2 || Math.abs(pos.y - m.y) > 2 || Math.abs(size.w - m.width) > 2 || Math.abs(size.h - m.height) > 2) continue;
    $.AXUIElementPerformAction(win, $("AXRaise"));
    return { raised: true };
  }
  return { raised: false };
}

// Background click: CGEventPostToPid with Cua's window-routing fields (f40 target pid,
// f51/f91/f92 window number, f58 click group, f7 subtype). Cursor, focus and the HID idle
// clock are untouched. The leading off-screen click makes Chromium emit "click" events.
function stampedClick(m) {
  var pid = Number(m.pid);
  // CGWindowID is uint32; keep its decimal wire identity until the native bridge call.
  var wid = String(m.windowId);
  if (!/^[0-9]+$/.test(wid) || wid.length > 10 || (wid.length === 10 && wid > "4294967295"))
    throw new Error("window_id_out_of_range");
  var group = Math.floor(Math.random() * 1e9);
  var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
  var right = m.button === "right";
  var downType = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  var upType = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  var button = right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
  function ev(type, px, py, clickState, number) {
    var e = $.CGEventCreateMouseEvent(src, type, { x: px, y: py }, button);
    $.CGEventSetIntegerValueField(e, 0, number);
    $.CGEventSetIntegerValueField(e, 1, clickState);
    $.CGEventSetIntegerValueField(e, 3, right ? 1 : 0);
    $.CGEventSetIntegerValueField(e, 7, 3);
    $.CGEventSetIntegerValueField(e, 40, pid);
    $.CGEventSetIntegerValueField(e, 51, wid);
    $.CGEventSetIntegerValueField(e, 91, wid);
    $.CGEventSetIntegerValueField(e, 92, wid);
    $.CGEventSetIntegerValueField(e, 58, group);
    $.CGEventPostToPid(pid, e);
  }
  ev($.kCGEventMouseMoved, m.x, m.y, 0, 2);
  delay(0.015);
  if (!right) {
    ev($.kCGEventLeftMouseDown, -1, -1, 1, 1);
    ev($.kCGEventLeftMouseUp, -1, -1, 1, 2);
    delay(0.1);
  }
  var n = m.count || 1;
  for (var i = 1; i <= n; i++) {
    ev(downType, m.x, m.y, i, 2 + i);
    ev(upType, m.x, m.y, i, 2 + i);
  }
  return {};
}

// Foreground input: a private source at the session tap, tagged so a future event tap could
// tell our events apart. These move the real cursor and reset the HID idle clock.
var privateSource = $.CGEventSourceCreate($.kCGEventSourceStatePrivate);
var PIBOT_TAG = 0x50694274;
function post(type, x, y, clickState, button) {
  var ev = $.CGEventCreateMouseEvent(privateSource, type, { x: x, y: y }, button || $.kCGMouseButtonLeft);
  if (clickState) $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, clickState);
  $.CGEventSetIntegerValueField(ev, $.kCGEventSourceUserData, PIBOT_TAG);
  $.CGEventPost($.kCGSessionEventTap, ev);
}

function click(m) {
  var right = m.button === "right";
  var button = right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
  var down = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  var up = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  post($.kCGEventMouseMoved, m.x, m.y, 0);
  for (var i = 1; i <= (m.count || 1); i++) {
    post(down, m.x, m.y, i, button);
    post(up, m.x, m.y, i, button);
  }
  return {};
}

function drag(m) {
  var steps = m.steps || 16;
  post($.kCGEventMouseMoved, m.x, m.y, 0);
  post($.kCGEventLeftMouseDown, m.x, m.y, 1);
  for (var i = 1; i <= steps; i++) {
    post($.kCGEventLeftMouseDragged, m.x + ((m.toX - m.x) * i) / steps, m.y + ((m.toY - m.y) * i) / steps, 1);
    $.NSThread.sleepForTimeInterval(0.012);
  }
  post($.kCGEventLeftMouseUp, m.toX, m.toY, 1);
  return {};
}

function move(m) {
  post($.kCGEventMouseMoved, m.x, m.y, 0);
  return {};
}

${MAC_STATIC_TEXT_SCRIPT}

var ops = {
  staticText: staticText,
  ping: function () { return { pong: true }; },
  apps: apps,
  resolveAppName: resolveAppName,
  installed: installed,
  frontmost: frontmost,
  session: session,
  windowAt: windowAt,
  screenWindows: screenWindows,
  secureFocus: secureFocus,
  focusedInput: focusedInput,
  focusedValue: focusedValue,
  secureFrames: secureFrames,
  raise: raise,
  stampedClick: stampedClick,
  click: click,
  drag: drag,
  move: move,
};

// NSWorkspace (running apps, frontmost app, activation state) is refreshed by notifications
// delivered through this thread's run loop, and the blocking stdin read below never runs it:
// without this, every app launched or quit after the helper started stayed invisible / alive.
// One zero-length pass drains what is pending (~1 ms).
function refresh() {
  $.CFRunLoopRunInMode($.kCFRunLoopDefaultMode, 0, false);
}

for (;;) {
  var line = readLine();
  if (line === null) break;
  if (!line.length) continue;
  refresh();
  var msg;
  try { msg = JSON.parse(line); } catch (e) { write({ id: 0, ok: false, error: "bad_json" }); continue; }
  try {
    var fn = ops[msg.op];
    if (!fn) throw new Error("unknown_op");
    write({ id: msg.id, ok: true, result: fn(msg) });
  } catch (e) {
    write({ id: msg.id, ok: false, error: String(e).slice(0, 200) });
  }
}
`;
