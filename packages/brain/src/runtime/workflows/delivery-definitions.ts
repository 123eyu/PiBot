/** Keep table cells separate: a bare file path must not absorb neighbouring metadata. */
function tableCells(line: string): string[] | undefined {
  const cells: string[] = [];
  let cell = "";
  let separated = false;
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (char === "\\" && line[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      separated = true;
    } else cell += char;
  }
  if (!separated) return undefined;
  cells.push(cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

/** Definitions stay inside the caller's Sources section; table rows never continue a list item. */
export function sourceDefinitions(lines: readonly string[], signal: AbortSignal) {
  const definitions = new Map<string, string[]>();
  let id: string | undefined;
  let inTable = false;
  for (const [index, line] of lines.entries()) {
    signal.throwIfAborted();
    if (!line.trim()) {
      id = undefined;
      inTable = false;
      continue;
    }
    const cells = tableCells(line);
    if (!cells || cells.length < 2) inTable = false;
    else if (!inTable) {
      // A pipe in a link title is still a list continuation, without table context.
      const next = lines[index + 1] ?? "";
      const nextCells = tableCells(next);
      inTable =
        (nextCells?.length === cells.length &&
          nextCells.every((cell) => /^:?-{3,}:?$/.test(cell))) ||
        (line.trimStart().startsWith("|") &&
          next.trimStart().startsWith("|") &&
          (nextCells?.length ?? 0) >= 2);
    }
    if (inTable && cells) {
      id = undefined;
      const number = /^(?:\[(\d{1,4})\]|(\d{1,4}))$/.exec(cells[0] ?? "");
      const key = number?.[1] ?? number?.[2];
      // Truncating a cell could turn a different URL into an observed source.
      if (key && definitions.size < 200)
        definitions.set(
          key,
          cells.slice(1).filter((cell) => cell.length <= 8000),
        );
      continue;
    }
    const match = /^\s*(?:[-*+]\s*)?(?:\[\^?(\d{1,4})\]:?|([0-9]{1,4})[.)、])\s*(.*)/u.exec(line);
    if (match) {
      id = match[1] ?? match[2];
      if (id && definitions.size < 200) definitions.set(id, [match[3] ?? ""]);
      else id = undefined;
    } else if (id) {
      const previous = definitions.get(id)?.[0] ?? "";
      definitions.set(id, [`${previous}\n${line}`.slice(0, 8000)]);
    }
  }
  return definitions;
}
