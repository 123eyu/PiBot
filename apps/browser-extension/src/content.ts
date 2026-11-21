const REF_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "textarea",
  "PopUpButton",
]);
const STATES = ["checked", "selected", "expanded", "disabled", "required", "invalid", "pressed"];
function named(element: Element): string {
  return (
    element.getAttribute("aria-label") ??
    element.textContent ??
    ("value" in element ? String((element as HTMLInputElement).value) : "")
  )
    .trim()
    .replace(/\s+/g, " ");
}
/** The ARIA role a screen reader would announce: explicit, else the element's implicit one. */
function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute("role")?.split(" ")[0];
  if (explicit) return explicit;
  if (element instanceof HTMLAnchorElement)
    return element.hasAttribute("href") ? "link" : undefined;
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLTextAreaElement) return "textbox";
  if (element instanceof HTMLSelectElement) return element.multiple ? "listbox" : "combobox";
  if (element instanceof HTMLInputElement) {
    if (element.type === "hidden") return undefined;
    const byType: Record<string, string> = {
      checkbox: "checkbox",
      radio: "radio",
      range: "slider",
      number: "spinbutton",
      search: "searchbox",
      button: "button",
      submit: "button",
      reset: "button",
      image: "button",
    };
    return byType[element.type] ?? "textbox";
  }
  return undefined;
}
function snapshot() {
  let next = 1;
  const lines: string[] = [];
  for (const element of Array.from(
    document.querySelectorAll<Element>("button,a,input,textarea,select,[role]"),
  )) {
    const role = roleOf(element);
    if (!role || !REF_ROLES.has(role)) continue;
    const ref = `e${next++}`;
    (element as HTMLElement).dataset.pibotRef = ref;
    const states = STATES.filter((state) => element.getAttribute(`aria-${state}`) === "true").join(
      " ",
    );
    lines.push(
      `${role} "${named(element).slice(0, 500)}"${states ? ` [${states}]` : ""} [ref=${ref}]`,
    );
  }
  return {
    tree: lines.join("\n"),
    text: (document.body.innerText ?? "").slice(0, 200_000),
    refs: lines.length,
  };
}
function byRef(ref: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-pibot-ref="${CSS.escape(ref)}"]`);
  if (!element)
    throw Object.assign(new Error("Element was not found"), { code: "browser_ref_not_found" });
  return element;
}
function input(element: HTMLElement, text: string) {
  element.focus();
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
      setter?.call(element, text);
    } else element.textContent = text;
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
    );
  }
}
function click(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"])
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      }),
    );
  element.click();
}
async function action(method: string, params: Record<string, unknown>) {
  if (method === "snapshot") return snapshot();
  if (method === "back") {
    history.back();
    return {};
  }
  if (method === "click") {
    click(byRef(String(params.ref)));
    return snapshot();
  }
  if (method === "inspect") {
    const element = byRef(String(params.ref));
    const link = element.closest("a[href]") as HTMLAnchorElement | null;
    const href = link && !/^javascript:/i.test(link.getAttribute("href") ?? "") ? link.href : null;
    const control = element as HTMLButtonElement | HTMLInputElement;
    const form = "form" in control ? control.form : element.closest("form");
    const submitter =
      (element instanceof HTMLButtonElement && (element.type || "submit") === "submit") ||
      (element instanceof HTMLInputElement && ["submit", "image"].includes(element.type));
    // A text field submits its form on Enter; the host asks only when `type` sends Enter.
    const textEntry =
      element instanceof HTMLInputElement &&
      !["button", "checkbox", "radio"].includes(element.type);
    const submits = !!form && (submitter || textEntry);
    // A button's formAction property falls back to the page address; only its own attribute
    // overrides the form's action.
    const action =
      submitter && element.hasAttribute("formaction")
        ? (element as HTMLButtonElement).formAction
        : form
          ? form.action
          : "";
    return {
      href,
      submits,
      formAction: submits ? action || location.href : null,
      pageUrl: location.href,
    };
  }
  if (method === "type") {
    const element = byRef(String(params.ref));
    input(element, String(params.text));
    if (params.submit === true) {
      const form = element.closest("form");
      if (form) form.requestSubmit();
      else
        for (const type of ["keydown", "keypress", "keyup"])
          element.dispatchEvent(
            new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true }),
          );
    }
    return snapshot();
  }
  if (method === "select") {
    const element = byRef(String(params.ref));
    if (!(element instanceof HTMLSelectElement))
      throw Object.assign(new Error("Not a select"), { code: "browser_ref_not_found" });
    element.value = String(params.value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return snapshot();
  }
  if (method === "scroll") {
    window.scrollBy({
      top:
        params.direction === "down"
          ? Number(params.amount ?? 600)
          : params.direction === "up"
            ? -Number(params.amount ?? 600)
            : 0,
      left:
        params.direction === "right"
          ? Number(params.amount ?? 600)
          : params.direction === "left"
            ? -Number(params.amount ?? 600)
            : 0,
    });
    return snapshot();
  }
  if (method === "upload")
    throw Object.assign(new Error("File chooser requires host mediation"), {
      code: "browser_upload_unsupported",
    });
  if (method === "wait") {
    const deadline = Date.now() + Number(params.timeoutMs ?? 5000);
    while (Date.now() < deadline) {
      const current = snapshot();
      if (params.for === "text" && current.text.includes(String(params.value)))
        return { ...current, matched: true };
      if (
        params.for === "ref" &&
        document.querySelector(`[data-pibot-ref="${CSS.escape(String(params.value))}"]`)
      )
        return { ...current, matched: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ...snapshot(), matched: false };
  }
  return snapshot();
}
chrome.runtime.onMessage.addListener(
  (raw: unknown, _sender: { id?: string }, sendResponse: (value: unknown) => void) => {
    const message =
      typeof raw === "object" && raw !== null
        ? (raw as { method?: string; [key: string]: unknown })
        : {};
    void action(message.method ?? "snapshot", message)
      .then(sendResponse)
      .catch((failure: unknown) => {
        const known = failure as { code?: unknown; message?: unknown };
        sendResponse({
          error: {
            code: typeof known.code === "string" ? known.code : "browser_internal",
            message: typeof known.message === "string" ? known.message : "Page operation failed",
          },
        });
      });
    return true;
  },
);
