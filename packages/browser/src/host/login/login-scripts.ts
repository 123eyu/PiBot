// Page scripts. Plain strings for the same reason as page-scripts.ts: they run inside the
// page's isolated worlds, where bundler helpers would not exist.

export const LOGIN_CAPTURE_WORLD = "pibot-login-capture";
export const LOGIN_FILL_WORLD = "pibot-login-fill";
export const LOGIN_BINDING = "__pibotLoginCapture";

/**
 * Which input is the account field, decided by scoring the page's own element signals rather
 * than by one site's markup. Filling and capturing share this one string, so the box Pi Bot offers
 * to save for an account is the box it would fill. Only elements and fixed reason codes leave it:
 * text found on the page (a placeholder, a label) never reaches a tool result or a log.
 */
export const LOGIN_FIELDS = `(() => {
  // Relative weights. The browser's own autocomplete declaration beats anything guessed from text,
  // the box right before the password beats page context, and context alone is never enough.
  const W = {
    AUTO_USERNAME: 60,
    AUTO_EMAIL: 50,
    AUTO_TEL: 30,
    // Sign-up widgets emit this; a real login form that also sets it still needs text signals.
    AUTO_OFF: -15,
    TYPE_EMAIL: 40,
    TYPE_TEL: 25,
    TYPE_TEXT: 10,
    INPUTMODE_EMAIL: 15,
    TEXT_ACCOUNT: 35,
    BEFORE_PASSWORD: 25,
    LOGIN_BUTTON: 20,
    LOGIN_URL: 15,
    SINGLE_FIELD: 30,
  };
  // A lone text box beside a Continue button clears this; a search box never does.
  const GOOD = 50;
  const ACCOUNT_TEXT = /user|login|log ?in|sign ?in|account|e-?mail|phone|mobile|账号|帐号|帳號|用户名|用戶名|邮箱|郵箱|手机|手機|电话|電話/i;
  // Search, filter, coupon and address boxes sit next to login forms. They are vetoed below rather
  // than scored down: filling a search box with an email address is worse than filling nothing.
  const SEARCH_TEXT = /search|query|filter|find|coupon|promo|discount|voucher|postal|zip ?code|shipping|delivery|first ?name|last ?name|full ?name|nickname|company|搜索|搜尋|查询|查詢|优惠|優惠|邮编|郵編|地址|姓名|昵称|暱稱/i;
  const BUTTON_TEXT = /(log ?in|sign ?in|continue|next|submit|登录|登入|继续|繼續|下一步|确定|確定)/i;
  const URL_TEXT = /login|signin|sign-in|sign_in|auth|sso|登录|登入|授权|授權/i;

  // A field without its own label usually follows one ("Email or username" above the box).
  const nearbyText = (el) => {
    let node = el;
    for (let depth = 0; node && depth < 3; depth += 1) {
      const prev = node.previousElementSibling;
      if (prev && !prev.querySelector("input")) return (prev.textContent || "").slice(0, 120);
      node = node.parentElement;
    }
    return "";
  };
  const labelText = (el) => [
    el.getAttribute("aria-label"),
    ...(el.labels ? [...el.labels].map((label) => label.textContent) : []),
    ...(el.getAttribute("aria-labelledby") || "").split(/\\s+/)
      .map((id) => (id && document.getElementById(id) ? document.getElementById(id).textContent : "")),
    nearbyText(el),
  ].filter(Boolean).join(" ");
  const words = (el) => [el.name, el.id, el.placeholder, el.autocomplete,
    el.getAttribute("inputmode"), labelText(el)]
    .filter(Boolean).join(" ").replace(/\\s+/g, " ");

  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    // A hidden box, an unrendered tab and a collapsed parent all report a zero-size rect.
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  // document.querySelectorAll does not look into open shadow roots (Web Components), so walk them.
  const all = (root, selector) => {
    const found = [];
    const walk = (node) => {
      // A shadow host's own root is not part of its own querySelectorAll; start there when the
      // walk begins at an element (a login form inside a Web Component).
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const el of node.querySelectorAll(selector)) found.push(el);
      for (const el of node.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(root || document);
    return found;
  };
  const inputs = (root) => all(root, "input").filter(visible);
  // Some engines report null for an input written without a type attribute.
  const typeOf = (el) => el.type || "";
  const textish = (el) => ["text", "email", "tel", ""].includes(typeOf(el));
  const codeish = (el) => /\\bone-time-code\\b/i.test(el.autocomplete || "") ||
    /(?:^|[\\s_-])(?:otp|totp|2fa|mfa)(?:$|[\\s_-])|verification.?code|authenticator.?code|security.?code|验证码|驗證碼|动态码|動態碼/i
      .test(words(el));
  const searchish = (el) => {
    if (typeOf(el) === "search") return true;
    const auto = (el.autocomplete || "").toLowerCase();
    // An explicit account declaration outranks a search-like name (a "search" field that really
    // is the login box is rare, and the site said which one it is).
    if (/\\b(username|email|tel)\\b/.test(auto)) return false;
    const named = (el.name + " " + el.id).toLowerCase().trim();
    if (/^(q|s|query|search|keyword|keywords|term|terms)$/.test(named)) return true;
    return SEARCH_TEXT.test(words(el));
  };
  const signupField = (el) => typeOf(el) === "password" &&
    /new-password/i.test(el.autocomplete || "");
  const password = (list) => list.find((el) => typeOf(el) === "password" &&
    !/new-password/i.test(el.autocomplete || "")) || null;
  const codeFields = (list) => list.filter((el) =>
    ["text", "tel", "number", "password", ""].includes(typeOf(el)) && codeish(el));

  const scopeOf = (el) => el.form || el.closest('[role="dialog"], dialog') || document;

  // The intermediate press of a two-step login ("Next" / "Continue"). Only a button whose
  // whole label is a step word is pressed: the final sign-in press stays with the model or the
  // user, and provider buttons ("Continue with Google") are not the form's own next step.
  const STEP_TEXT = /^(continue|next|weiter|suivant|siguiente|下一步|继续|繼續)$/i;
  const NOT_STEP_TEXT = /with |使用|google|apple|facebook|microsoft|twitter|wechat|微信|钉钉|支付宝|登录|登入|sign ?in|log ?in|submit|提交/i;
  const labels = (el) => [el.getAttribute && el.getAttribute("aria-label"), el.value, el.textContent]
    .filter(Boolean)
    .map((text) => text.replace(/\\s+/g, " ").trim());
  const isStep = (el) => {
    const words = labels(el);
    return words.some((text) => STEP_TEXT.test(text)) &&
      !words.some((text) => NOT_STEP_TEXT.test(text));
  };
  // The button has to belong to the account box's form or dialog; failing that, to the nearest
  // container that holds both. A "Next" elsewhere on the page (a carousel, a tour) must never be
  // pressed: that would leave the login instead of moving to its password step.
  const stepButton = (accountEl) => {
    let node = accountEl;
    for (let depth = 0; node && depth < 6; depth += 1) {
      const found = all(node, 'button, [role="button"], input[type="submit"], input[type="button"]')
        .filter((el) => visible(el) && !el.disabled && isStep(el));
      if (found.length) return found[0];
      if (node.matches && node.matches('form, [role="dialog"], dialog')) return null;
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return null;
  };
  const hasLoginButton = (scope) => [...(scope || document)
    .querySelectorAll('button, [role="button"], input[type="submit"]')]
    .some((button) => BUTTON_TEXT.test((button.textContent || button.value || "") + " " +
      (button.getAttribute("aria-label") || "")));
  const loginUrl = () => URL_TEXT.test(location.href + " " + document.title);
  // The list is in document order, so the last box before the password is the nearest one.
  const lastBefore = (boxes, pass, list) => {
    const at = list.indexOf(pass);
    const ahead = boxes.filter((el) =>
      el.form === pass.form && list.indexOf(el) >= 0 && list.indexOf(el) < at);
    return ahead[ahead.length - 1] || null;
  };

  /**
   * The account box and, when there is one, why it was chosen. Codes are fixed: the caller maps
   * them to text, so nothing the page says is ever echoed back to the model.
   */
  const account = (list, scope) => {
    const pass = password(list);
    // A sign-up / change-password form has only a new-password box; nothing on it is a login.
    if (!pass && list.some(signupField)) return null;
    const area = scope || scopeOf(list[0] || document.body);
    const boxes = list.filter((el) => textish(el) && !codeish(el) && !searchish(el));
    if (!boxes.length) return null;
    const button = hasLoginButton(area) ? W.LOGIN_BUTTON : 0;
    const url = loginUrl() ? W.LOGIN_URL : 0;
    // One text box, no password box and a login-ish context: the first step of a two-step login.
    const single = !pass && boxes.length === 1 && (button || url) ? W.SINGLE_FIELD : 0;
    const before = pass ? lastBefore(boxes, pass, list) : null;
    let best = null;
    for (const el of boxes) {
      const reasons = [];
      let score = 0;
      const auto = (el.autocomplete || "").toLowerCase();
      if (/\\busername\\b/.test(auto)) { score += W.AUTO_USERNAME; reasons.push(["autocomplete", W.AUTO_USERNAME]); }
      else if (/\\bemail\\b/.test(auto)) { score += W.AUTO_EMAIL; reasons.push(["autocomplete", W.AUTO_EMAIL]); }
      else if (/\\btel\\b/.test(auto)) { score += W.AUTO_TEL; reasons.push(["autocomplete", W.AUTO_TEL]); }
      else if (auto === "off" || auto === "none" || auto === "on") score += W.AUTO_OFF;
      if (typeOf(el) === "email") { score += W.TYPE_EMAIL; reasons.push(["type", W.TYPE_EMAIL]); }
      else if (typeOf(el) === "tel") { score += W.TYPE_TEL; reasons.push(["type", W.TYPE_TEL]); }
      else score += W.TYPE_TEXT;
      if (el.getAttribute("inputmode") === "email") { score += W.INPUTMODE_EMAIL; reasons.push(["inputmode", W.INPUTMODE_EMAIL]); }
      if (ACCOUNT_TEXT.test([el.name, el.id].join(" "))) { score += W.TEXT_ACCOUNT; reasons.push(["name", W.TEXT_ACCOUNT]); }
      if (ACCOUNT_TEXT.test(el.placeholder || "")) { score += W.TEXT_ACCOUNT; reasons.push(["placeholder", W.TEXT_ACCOUNT]); }
      if (ACCOUNT_TEXT.test(labelText(el))) { score += W.TEXT_ACCOUNT; reasons.push(["label", W.TEXT_ACCOUNT]); }
      if (before === el) { score += W.BEFORE_PASSWORD; reasons.push(["near_password", W.BEFORE_PASSWORD]); }
      if (button) { score += button; reasons.push(["button", button]); }
      if (url) { score += url; reasons.push(["url", url]); }
      if (single) { score += single; reasons.push(["single_field", single]); }
      if (score >= GOOD && (!best || score > best.score)) best = { el, score, reasons };
    }
    if (!best) return null;
    // Highest-weight signal first; the tool result shows only the first few.
    const ranked = [...new Map(best.reasons).entries()].sort((a, b) => b[1] - a[1]);
    return { el: best.el, reasons: ranked.slice(0, 3).map(([code]) => code) };
  };

  return { visible, inputs, textish, codeish, codeFields, password, account, stepButton };
})()`;

// Watches form submissions for a password field. The host keeps what it reports
// only while the user has taken over; at any other time the payload is dropped on arrival.
// A username-only submit (first step of a two-step login) reports just the username.
// The account box is the same one LOGIN_FILL_FUNCTION would fill, so "you logged in as
// <value>" never names a search box or another neighbouring field. A password without an account
// field on the page and without an earlier account step reports no username.
export const LOGIN_CAPTURE_SCRIPT = `(() => {
  if (globalThis.__pibotLoginCaptureInstalled) return;
  globalThis.__pibotLoginCaptureInstalled = true;
  const F = ${LOGIN_FIELDS};
  addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const fields = [...form.elements].filter((el) => el instanceof HTMLInputElement);
    // Sign-up and change-password forms (any "new-password" field) are not logins.
    if (fields.some((el) => el.type === "password" && /new-password/i.test(el.autocomplete || "")))
      return;
    const password = fields.find((el) => el.type === "password" && el.value &&
      !/(new-password|one-time-code)/i.test(el.autocomplete || "")) || null;
    const picked = F.account(fields, form);
    const user = picked && String(picked.el.value || "").trim() ? picked.el : null;
    if (!password && !user) return;
    try {
      globalThis.${LOGIN_BINDING}(JSON.stringify({
        origin: location.origin,
        u: user ? String(user.value).trim().slice(0, 500) : "",
        p: password ? String(password.value) : "",
      }));
    } catch { /* page-side: a field that cannot be read must not abort the login capture */ }
  }, true);
})();`;

// Runs with Runtime.callFunctionOn in a fresh isolated world of one frame. Values arrive as call
// arguments (never inside source text) and are written with the native value setter followed by
// input/change events, which frameworks such as React observe. Returns which fields were found
// and, for the account box, the fixed reason codes behind that choice (never page text).
export const LOGIN_FILL_FUNCTION = `function (userValue, secretValue, codeValue, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { originMismatch: true };
  const F = ${LOGIN_FIELDS};
  const inputs = F.inputs(document);
  const codeFields = F.codeFields(inputs);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const fill = (el, value) => {
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (codeFields.length) {
    if (!codeValue) return { username: false, password: false, totp: false, needsTotp: true };
    const fillCode = (el, value) => {
      // Keep both accessibility snapshots and screenshot tools from exposing the code later.
      el.setAttribute("autocomplete", "one-time-code");
      el.style.setProperty("-webkit-text-security", "disc", "important");
      fill(el, value);
    };
    const single = codeFields.find((el) => el.maxLength !== 1 && (el.maxLength < 0 || el.maxLength >= codeValue.length));
    if (single) fillCode(single, codeValue);
    else {
      const first = codeFields[0];
      const group = inputs.filter((el) => el.maxLength === 1 && el.form === first.form &&
        ["text", "tel", "number", "password", ""].includes(el.type));
      if (group.length !== codeValue.length) return { username: false, password: false, totp: false, needsTotp: true };
      group.forEach((el, i) => fillCode(el, codeValue[i]));
    }
    return { username: false, password: false, totp: true };
  }
  const password = F.password(inputs);
  // Only "new-password" fields: a sign-up or change-password form; nothing is filled there.
  if (!password && inputs.some((el) => el.type === "password"))
    return { username: false, password: false };
  const picked = F.account(inputs);
  const user = picked ? picked.el : null;
  const filledUser = !!(user && userValue);
  if (filledUser) fill(user, userValue);
  if (password) fill(password, secretValue);
  return { username: filledUser, password: !!password, reasons: picked ? picked.reasons : [] };
}`;

// The two-step login's intermediate press. Runs in the isolated world of the frame that was
// just filled, re-finds the same account box with the same scoring, then looks for the nearest
// "Next" / "Continue" in its form or dialog and reports that button's viewport centre. The host
// dispatches a real mouse click there (the way browser_click does), so a site that checks
// `isTrusted` sees the press it expects. Nothing on the page is read back: the answer holds a
// point and a boolean.
export const LOGIN_CONTINUE_FUNCTION = `function (expectedOrigin) {
  if (location.origin !== expectedOrigin) return { originMismatch: true };
  const F = ${LOGIN_FIELDS};
  const picked = F.account(F.inputs(document));
  if (!picked) return { clicked: false };
  const button = F.stepButton(picked.el);
  if (!button) return { clicked: false };
  // A step button below the fold still has a rect; bring it into view before measuring it.
  button.scrollIntoView({ block: "center", inline: "center" });
  const box = button.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return { clicked: false };
  // The host clicks with Input.dispatchMouseEvent, which takes the top page's viewport: a login
  // form inside a same-origin iframe would be hit at the wrong point without adding every
  // ancestor frame's own rect. A cross-origin parent cannot be measured, and guessing there would
  // click something else, so the press is left to the model (clicked: false).
  try {
    const frames = [];
    let view = window;
    for (let depth = 0; depth < 8; depth += 1) {
      const frame = view.frameElement;
      if (!frame) break;
      frames.push(frame);
      view = frame.ownerDocument.defaultView || window;
    }
    // An iframe parked outside its parent's viewport would be clicked at a clamped point.
    for (const frame of frames) frame.scrollIntoView({ block: "center", inline: "center" });
    let x = box.left + box.width / 2;
    let y = box.top + box.height / 2;
    for (const frame of frames) {
      const rect = frame.getBoundingClientRect();
      const style = (frame.ownerDocument.defaultView || window).getComputedStyle(frame);
      x += rect.left + (parseFloat(style.borderLeftWidth) || 0);
      y += rect.top + (parseFloat(style.borderTopWidth) || 0);
    }
    const top = window.top;
    if (x < 0 || y < 0 || x > top.innerWidth || y > top.innerHeight) return { clicked: false };
    return { clicked: true, x: x, y: y };
  } catch {
    return { clicked: false };
  }
}`;
