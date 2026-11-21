export function shouldSend(
  event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number },
  composing: boolean,
) {
  // Safari/Chromium IME confirmation can report keyCode 229 after compositionend.
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    !composing &&
    event.keyCode !== 229
  );
}
