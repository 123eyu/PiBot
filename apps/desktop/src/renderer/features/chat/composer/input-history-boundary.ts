export function atInputHistoryBoundary(input: HTMLTextAreaElement, direction: "up" | "down") {
  if (!input.value) return true;
  const document = input.ownerDocument;
  const computed = document.defaultView?.getComputedStyle(input);
  if (!computed) return false;
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
    boxSizing: "border-box",
    width: `${input.clientWidth}px`,
  });
  for (const property of [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "fontVariant",
    "lineHeight",
    "letterSpacing",
    "wordSpacing",
    "textIndent",
    "textAlign",
    "textTransform",
    "direction",
    "tabSize",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "wordBreak",
    "overflowWrap",
  ] as const)
    mirror.style[property] = computed[property];
  const caretTop = (offset: number) => {
    const marker = document.createElement("span");
    marker.textContent = input.value.slice(offset) || "\u200b";
    mirror.replaceChildren(document.createTextNode(input.value.slice(0, offset)), marker);
    return marker.offsetTop;
  };
  // Newline offsets alone would steal native navigation inside a softly wrapped line.
  document.body.append(mirror);
  try {
    const current = caretTop(input.selectionStart);
    const boundary = caretTop(direction === "up" ? 0 : input.value.length);
    return direction === "up" ? current <= boundary : current >= boundary;
  } finally {
    mirror.remove();
  }
}
