/** Compact history stays plain text; strip presentation syntax without enabling HTML or links. */
export function routineSummary(text: string): string {
  return text
    .replace(/```[^\n]*\n?|```|~~~[^\n]*\n?|~~~/gu, "")
    .replace(/!?(\[([^\]\n]*)\])\([^\n)]*\)/gu, "$2")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gu, "$1")
    .replace(/(\*\*|__|~~|`)([^\n]+?)\1/gu, "$2")
    .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/gu, "$2")
    .trim();
}
