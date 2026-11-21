import {
  type BrowserRecordEvent,
  TEACH_MAX_STEPS,
  type TeachStep,
} from "@pibot/skills-contract/full";

export type RecordedStep = Omit<TeachStep, "index">;
export interface Synthesized {
  steps: RecordedStep[];
  /** Per step: index of its last raw event, whose keyframe (if any) pictures the step. */
  events: number[][];
}

/** A navigation this soon after a click or submit is that action's result, not a new step. */
const NAVIGATION_FOLD_MS = 1500;
/**
 * Enter in a form field makes the browser click the form's default button right away (implicit
 * submission); that click is the same submit, while a person's own click comes much later.
 */
const ENTER_CLICK_MS = 300;
const NOT_A_PAGE = /^(?:about|chrome-error):/i;
const TEXT_INPUTS = new Set(["checkbox", "radio", "submit", "button", "reset", "image", "file"]);

const plain = (value: string | undefined, max: number) =>
  [...(value ?? "")]
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

type Target = NonNullable<BrowserRecordEvent["target"]>;
type Language = "zh" | "en";
/**
 * A placeholder is often a rotating suggestion (a search box's trending query), so it names the
 * field only when nothing stable does, and says so; the Bot must not look for that text next time.
 */
const placeholderName = (text: string, language: Language) =>
  language === "zh" ? `${text}（占位词）` : `${text} (placeholder)`;
/** Field names sites use for their search box (`q` Google / Bing, `wd` Baidu, ...). */
const SEARCH_NAMES = new Set(["q", "query", "search", "keyword", "keywords", "wd", "word", "kw"]);
const sameText = (a: string, b: string) => plain(a, 500) === plain(b, 500);

function textField(target: Target) {
  return (
    target.tag === "textarea" || (target.tag === "input" && !TEXT_INPUTS.has(target.type ?? "text"))
  );
}

/**
 * A text field without a stable label gets a generic name: its `name` (`q`, `wd`) means nothing
 * to the user and its placeholder rotates, so neither can name the step.
 */
const isSearch = (target: Target) =>
  target.type === "search" ||
  target.role === "searchbox" ||
  SEARCH_NAMES.has((target.name ?? "").toLowerCase());

function fieldName(target: Target, language: Language) {
  const search = isSearch(target);
  if (language === "zh") return search ? "搜索框" : "输入框";
  return search ? "search box" : "text field";
}

function describe(target: Target | undefined, language: Language, href?: string) {
  if (!target) return "";
  // Some pages copy the rotating suggestion into aria-label / title as well; then it is no label.
  const label =
    target.label && !(target.placeholder && sameText(target.label, target.placeholder))
      ? target.label
      : "";
  // A search box is always just that: sites such as cn.bing.com put the rotating trending query
  // in aria-label / title with no placeholder to compare it to (second-Mac retest).
  if (textField(target)) return (!isSearch(target) && label) || fieldName(target, language);
  return (
    label ||
    target.name ||
    (href && !/^javascript:/i.test(href) ? href : "") ||
    (target.placeholder ? placeholderName(target.placeholder, language) : "") ||
    [target.tag, target.type].filter(Boolean).join(" ")
  );
}

/**
 * Clicks implied by another event: focusing a field (the typing / choosing follows), picking an
 * option (the select step) and toggling a checkbox or radio (the check step).
 */
function implied(target: Target | undefined) {
  if (!target) return false;
  if (["textarea", "select", "label", "option"].includes(target.tag)) return true;
  const type = target.type ?? "text";
  return (
    target.tag === "input" && (!TEXT_INPUTS.has(type) || type === "checkbox" || type === "radio")
  );
}

/**
 * Raw recorder events → reviewable steps: typing merges into one step per field with
 * only its final text, a secret field keeps no value at all, navigations caused by a click fold
 * into it. Every string passes `redact` (API keys typed into ordinary fields) and is bounded.
 */
export function synthesizeSteps(
  raw: readonly BrowserRecordEvent[],
  redact: (text: string) => string,
  language: Language,
): Synthesized {
  const steps: (RecordedStep & { ms: number; selector?: string })[] = [];
  const events: number[][] = [];
  const pages = new Map<string, string>();
  const text = (value: string | undefined, max: number) => plain(redact(plain(value, max)), max);
  const push = (step: RecordedStep, ms: number, index: number, selector?: string) => {
    if (steps.length >= TEACH_MAX_STEPS) return;
    steps.push({ ...step, ms, ...(selector ? { selector } : {}) });
    events.push([index]);
  };
  const extend = (index: number) => events.at(-1)?.push(index);
  raw.forEach((event, index) => {
    const at = new Date(event.at).toISOString();
    if (event.kind === "click" && event.url) pages.set(event.tab, event.url);
    if (event.kind === "navigate" && event.url) pages.set(event.tab, event.url);
    const page = pages.get(event.tab) ?? event.url;
    // A page that failed to load is Chromium's error page (or our blank stand-in): neither its
    // navigation nor what the user did on it is a step to repeat, and its pseudo host
    // ("chromewebdata") would end up in the skill's site list.
    if (page && NOT_A_PAGE.test(page) && event.kind !== "download") return;
    const url = text(page, 2048);
    const last = steps.at(-1);
    const base = { url, secret: false, hasThumbnail: false, at };
    switch (event.kind) {
      case "navigate": {
        if (!event.url) return;
        if (
          last &&
          (last.kind === "click" || last.kind === "submit") &&
          event.at - last.ms < NAVIGATION_FOLD_MS
        ) {
          extend(index);
          return;
        }
        const target = text(event.url, 500);
        push({ ...base, url: text(event.url, 2048), kind: "navigate", target }, event.at, index);
        return;
      }
      case "click": {
        if (implied(event.target)) return;
        if (last?.kind === "submit" && event.at - last.ms < ENTER_CLICK_MS) {
          extend(index);
          return;
        }
        push(
          {
            ...base,
            kind: "click",
            target: text(describe(event.target, language, event.href), 500),
          },
          event.at,
          index,
        );
        return;
      }
      case "check":
        push(
          {
            ...base,
            kind: "click",
            target: text(describe(event.target, language), 500),
            value: event.checked ? "checked" : "unchecked",
          },
          event.at,
          index,
        );
        return;
      case "input": {
        const secret = event.target?.secret === true;
        const selector = event.target?.selector;
        if (last?.kind === "type" && selector && last.selector === selector) {
          if (!secret) last.value = text(event.value, 2000);
          last.ms = event.at;
          last.at = at;
          extend(index);
          return;
        }
        push(
          {
            ...base,
            kind: "type",
            target: text(describe(event.target, language), 500),
            secret,
            ...(secret ? {} : { value: text(event.value, 2000) }),
          },
          event.at,
          index,
          selector,
        );
        return;
      }
      case "select":
        push(
          {
            ...base,
            kind: "select",
            target: text(describe(event.target, language), 500),
            value: text(event.text || event.value, 2000),
          },
          event.at,
          index,
        );
        return;
      case "submit":
        // Pressing the form's button or Enter already made a step; the submit only confirms it.
        if (
          (last?.kind === "click" || last?.kind === "submit") &&
          event.at - last.ms < NAVIGATION_FOLD_MS
        ) {
          extend(index);
          return;
        }
        push(
          {
            ...base,
            kind: "submit",
            // A form has no name of its own; the recorder falls back to its visible text, which on
            // a search page is the trending list. Right after typing, the field names the submit.
            target:
              last?.kind === "type"
                ? last.target
                : text(describe(event.target, language) || event.action, 500),
          },
          event.at,
          index,
        );
        return;
      case "download":
        push({ ...base, kind: "download", target: text(event.filename, 500) }, event.at, index);
        return;
    }
  });
  return {
    steps: steps.map(({ ms: _ms, selector: _selector, ...step }) => step),
    events,
  };
}
