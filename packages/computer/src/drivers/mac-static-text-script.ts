// This fixed helper supplements Calculator's display, never arbitrary app scripts.
export const MAC_STATIC_TEXT_SCRIPT = `
function staticText(m) {
  var started = Date.now(), visited = 0, values = [], axStatus = 0;
  function result(reason, include) {
    return { elements: include ? values : [], diagnostic: { reason: reason, visited: visited, found: include ? values.length : 0, axStatus: axStatus } };
  }
  function calculator() {
    var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(m.pid);
    return running && unwrapStr(running.bundleIdentifier) === "com.apple.calculator";
  }
  function field(el, key, optional) {
    var ref = Ref();
    var status = $.AXUIElementCopyAttributeValue(el, $(key), ref);
    if (optional && (status === -25205 || status === -25212)) return null;
    if (status !== 0 || !ref[0]) { axStatus = Number(status); throw new Error("attribute_unavailable"); }
    return ObjC.castRefToObject(ref[0]);
  }
  function text(value) {
    if (value === null || value === undefined) return "";
    var decoded = ObjC.unwrap(value);
    return typeof decoded === "string" ? decoded : typeof decoded === "number" && Number.isFinite(decoded) ? String(decoded) : "";
  }
  try {
    if (!calculator()) return result("not_calculator", false);
    var app = $.AXUIElementCreateApplication(m.pid);
    var wins = field(app, "AXWindows", false);
    var matches = [];
    var windowCount = Number(wins.count);
    if (!Number.isSafeInteger(windowCount) || windowCount < 0 || windowCount > 100) return result("window_limit", false);
    for (var w = 0; w < windowCount; w++) {
      var win = wins.objectAtIndex(w);
      if (sameFrame(win, m.window)) matches.push(win);
    }
    if (matches.length !== 1) return result(matches.length ? "window_ambiguous" : "window_missing", false);
    var target = matches[0];
    var queue = [{ el: target, depth: 0 }], cursor = 0, depthLimited = false, nodeLimited = false;
    while (cursor < queue.length && cursor < m.maxNodes && Date.now() - started < 1500) {
      var item = queue[cursor++];
      visited++;
      var role = unwrapStr(field(item.el, "AXRole", false));
      var subrole = unwrapStr(field(item.el, "AXSubrole", true)) || "";
      if (!role) return result("role_missing", false);
      // Never read values or children of password containers, including nested descendants.
      if (/secure|password/i.test(role + " " + subrole)) continue;
      if (role === "AXStaticText" || role === "AXTextField" || role === "AXTextArea") {
        var value = text(field(item.el, "AXValue", true));
        // Some Calculator versions expose display text via AXDescription, not AXValue.
        if (!value && role === "AXStaticText") value = text(field(item.el, "AXDescription", true));
        if (value && values.length < 32) values.push({ value: value.slice(0, 2000), depth: item.depth });
      }
      if (item.depth >= m.maxDepth) { depthLimited = true; continue; }
      var children = field(item.el, "AXChildren", true);
      if (!children) continue;
      if (Number($.CFGetTypeID(children)) !== Number($.CFArrayGetTypeID())) return result("children_invalid", false);
      var count = Number(children.count);
      if (!Number.isSafeInteger(count) || count < 0) return result("children_invalid", false);
      for (var k = 0; k < count; k++) {
        if (queue.length >= m.maxNodes) { nodeLimited = true; break; }
        var child = children.objectAtIndex(k);
        if (!$.CFEqual(child, item.el)) queue.push({ el: child, depth: item.depth + 1 });
      }
    }
    if (!calculator() || !sameFrame(target, m.window)) return result("identity_changed", false);
    // Values remain subject to a fresh, complete secure-frame scan in the service.
    return result(cursor < queue.length && Date.now() - started >= 1500 ? "time_limit" : nodeLimited ? "node_limit" : depthLimited ? "depth_limit" : values.length ? "read" : "no_values", true);
  } catch (e) {
    // Unknown roles/children may conceal a secure ancestor; expose no collected values then.
    return result(axStatus ? "attribute_unavailable" : "bridge_failed", false);
  }
}
`;
