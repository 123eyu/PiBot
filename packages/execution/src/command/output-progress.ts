/** Count redacted output lines without keeping their contents or depending on tail retention. */
export class OutputProgress {
  private completed = 0;
  private partial = false;

  push(text: string) {
    if (!text) return;
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) === 10) this.completed = Math.min(this.completed + 1, 1_000_000_000);
    this.partial = !text.endsWith("\n");
  }

  get lines() {
    return Math.min(this.completed + Number(this.partial), 1_000_000_000);
  }
}
