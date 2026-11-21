const LIMIT = 8192;
const identifier = /[\p{L}\p{N}_.$[\]]/u;
const cell = /^\$?[A-Z]{1,3}\$?[1-9]\d*$/iu;

/** Each token is visited once; long identifiers never restart a sheet-prefix search. */
export function formulaReferences(formula: string | undefined, type?: string) {
  if (!formula)
    return {
      references: [],
      coverage:
        type === "shared" || type === undefined
          ? ("shared_follower" as const)
          : ("partial" as const),
    };
  const source = formula.slice(0, LIMIT);
  const tokens = tokenize(source);
  let partial = formula.length > LIMIT;
  const references: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    let value = token.value;
    if (tokens[i + 1]?.value === "!" && cell.test(tokens[i + 2]?.value ?? "")) {
      value += `!${tokens[i + 2]?.value}`;
      i += 2;
    } else if (!cell.test(value) || token.quoted) {
      if (tokens[i + 1]?.value === "(") {
        if (/^(?:INDIRECT|OFFSET)$/iu.test(value)) partial = true;
      } else if (/[\p{L}_[\]#!:]/u.test(value) && !/^(?:TRUE|FALSE)$/iu.test(value)) partial = true;
      continue;
    } else if (tokens[i + 1]?.value === "(") continue;
    if (tokens[i + 1]?.value === ":" && cell.test(tokens[i + 2]?.value ?? "")) {
      value += `:${tokens[i + 2]?.value}`;
      i += 2;
    }
    if (value.includes("[") || value.length > 200) partial = true;
    if (seen.has(value)) continue;
    seen.add(value);
    if (references.length === 32) {
      partial = true;
      continue;
    }
    references.push(value.slice(0, 200));
  }
  return { references, coverage: partial ? ("partial" as const) : ("static_a1_only" as const) };
}

function tokenize(source: string) {
  const tokens: { value: string; quoted: boolean }[] = [];
  for (let i = 0; i < source.length; ) {
    const start = i;
    const char = source[i];
    if (char === '"' || char === "'") {
      const quote = char;
      i++;
      while (i < source.length) {
        if (source[i++] !== quote) continue;
        if (source[i] === quote) {
          i++;
          continue;
        }
        break;
      }
      if (quote === "'") tokens.push({ value: source.slice(start, i), quoted: true });
    } else if (char && identifier.test(char)) {
      while (i < source.length && identifier.test(source[i] ?? "")) i++;
      tokens.push({ value: source.slice(start, i), quoted: false });
    } else {
      i++;
      if (char && !/\s/u.test(char)) tokens.push({ value: char, quoted: false });
    }
  }
  return tokens;
}
