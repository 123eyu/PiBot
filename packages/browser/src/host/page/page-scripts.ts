// Scripts injected into isolated worlds (Page.addScriptToEvaluateOnNewDocument worldName) so page
// scripts can neither see nor tamper with them. Kept as plain strings: bundler helpers inserted
// into a function would not exist inside the page.

export const GUARD_WORLD = "pibot-guard";
export const GUARD_BINDING = "__pibotGuardReport";
export const RECORD_WORLD = "pibot-recorder";
export const RECORD_BINDING = "__pibotRecord";

/** Native <select> menus are not in the screencast and ignore keys. */
export const BASE_SELECT_CSS = "select, ::picker(select) { appearance: base-select; }";

// Fresh documents block form submission until the host marks the world "allow" right before a
// Bot action on an approved site, or during user takeover.
export const GUARD_SCRIPT = `(() => {
  if (globalThis.__pibotGuard) return;
  const state = { mode: "block" };
  globalThis.__pibotGuard = state;
  addEventListener("submit", (event) => {
    if (state.mode === "allow") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const form = event.target;
    try {
      globalThis.${GUARD_BINDING}(JSON.stringify({
        method: String(form.method || "get").toLowerCase(),
        action: String(form.action || location.href),
      }));
    } catch { /* page-side: submit is reported best-effort; the host also watches navigation */ }
  }, true);
})();`;

// Adapted from tools/probes/bot-browser/feasibility/recorder-page.js (11/11 steps, no secret leak). Secret fields
// report only that typing happened, never the value or its length.
export const RECORD_SCRIPT = `(() => {
  if (globalThis.__pibotRecorderInstalled) return;
  globalThis.__pibotRecorderInstalled = true;
  const send = (payload) => {
    try { globalThis.${RECORD_BINDING}(JSON.stringify(payload)); } catch { /* page-side: the binding is gone while the page is torn down */ }
  };
  const secretAutocomplete = /(password|one-time-code|cc-number|cc-csc|cc-exp)/i;
  const isSecret = (el) => el instanceof HTMLInputElement &&
    (el.type === "password" || secretAutocomplete.test(el.autocomplete || ""));
  const clip = (v, n) => String(v || "").trim().slice(0, n);
  // No placeholder here: search boxes rotate suggestions through it, so it does not name the field.
  const labelOf = (el) => {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return clip(aria, 200);
    const by = el.getAttribute && el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (text.trim()) return clip(text, 200);
    }
    if (el.labels && el.labels.length) {
      // A wrapping label also contains the control (and a select's options); keep its own words.
      const own = el.labels[0].cloneNode(true);
      own.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
      const text = clip(own.textContent, 200);
      if (text) return text;
    }
    const title = el.getAttribute && el.getAttribute("title");
    if (title) return clip(title, 200);
    // A textarea's text is its initial content, not a name for it.
    if (isSecret(el) || el.localName === "textarea") return "";
    return clip(el.innerText || (el.type === "submit" ? el.value : ""), 200);
  };
  const cssPath = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      let part = n.localName;
      const name = n.getAttribute("name");
      if (name) part += '[name="' + CSS.escape(name) + '"]';
      else if (n.parentElement) {
        const same = [...n.parentElement.children].filter((c) => c.localName === n.localName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(part);
    }
    return parts.join(" > ").slice(0, 1000);
  };
  const squash = (v) => String(v).replace(/\\s+/g, " ").trim();
  const describe = (el) => {
    const placeholder = el.placeholder ? clip(el.placeholder, 200) : undefined;
    const label = labelOf(el);
    return {
      tag: clip(el.localName, 60),
      type: el.type ? clip(el.type, 60) : undefined,
      role: el.getAttribute && el.getAttribute("role") ? clip(el.getAttribute("role"), 60) : undefined,
      name: el.getAttribute && el.getAttribute("name") ? clip(el.getAttribute("name"), 200) : undefined,
      // Search boxes copy the rotating suggestion into aria-label / title too; that is no label.
      label: label && !(placeholder && squash(label) === squash(placeholder)) ? label : undefined,
      placeholder,
      selector: cssPath(el),
      secret: isSecret(el) || undefined,
    };
  };
  const actionable = (el) =>
    (el.closest && el.closest("a,button,input,select,textarea,[role=button],[role=link],label")) || el;
  addEventListener("click", (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const el = actionable(e.target);
    send({ kind: "click", target: describe(el), href: el.href ? String(el.href) : undefined, url: location.href });
  }, true);
  addEventListener("input", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (el.type === "checkbox" || el.type === "radio") return;
    send({ kind: "input", target: describe(el), value: isSecret(el) ? undefined : String(el.value).slice(0, 10000) });
  }, true);
  addEventListener("change", (e) => {
    const el = e.target;
    if (el instanceof HTMLSelectElement)
      send({ kind: "select", target: describe(el), value: clip(el.value, 1000),
        text: el.selectedOptions[0] ? clip(el.selectedOptions[0].text, 1000) : undefined });
    else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"))
      send({ kind: "check", target: describe(el), checked: el.checked });
  }, true);
  addEventListener("submit", (e) => {
    const form = e.target;
    send({ kind: "submit", target: describe(form), method: String(form.method || "get").toLowerCase(),
      action: String(form.action || "") });
  }, true);
  // Search boxes often handle Enter in script without any form submit, so Enter in a one-line
  // field is the submit itself. An IME commit (isComposing / 229) is only choosing characters.
  const noEnter = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file",
    "color", "range", "hidden"]);
  addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || noEnter.has(el.type)) return;
    send({ kind: "submit", target: describe(el), url: location.href,
      ...(el.form ? { method: String(el.form.method || "get").toLowerCase(),
        action: String(el.form.action || "") } : {}) });
  }, true);
})();`;
