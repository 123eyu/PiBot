export interface OptionSpec {
  flags?: string;
  values?: string;
  optional?: string;
  longFlags?: readonly string[];
  longValues?: readonly string[];
  longOptional?: readonly string[];
  readValues?: readonly string[];
  writeValues?: readonly string[];
  mutating?: readonly string[];
  // Known options may open additional paths whose bounds cannot be proved from argv.
  unbounded?: readonly string[];
  stopAtOperand?: boolean;
  // find uses single-dash words; dd uses key=value rather than shell switches.
  named?: Readonly<Record<string, OptionRule>>;
  assignment?: boolean;
}
export interface OptionRule {
  argument: "none" | "value" | "optional";
  path?: "read" | "write";
  mutates?: boolean;
  incomplete?: boolean;
}
export interface ParsedOptions {
  flags: Set<string>;
  values: Map<string, string[]>;
  operands: string[];
  unknownOptions: string[];
  reads: string[];
  writes: string[];
  readonly: boolean;
  unknown: boolean;
  incomplete: boolean;
  nextIndex: number;
}
/** The same option table owns argument consumption, path facts and mutation semantics. */
export function optionTable(spec: OptionSpec): ReadonlyMap<string, OptionRule> {
  const table = new Map<string, OptionRule>(Object.entries(spec.named ?? {}));
  for (const [chars, names, argument] of [
    [spec.flags, spec.longFlags, "none"],
    [spec.values, spec.longValues, "value"],
    [spec.optional, spec.longOptional, "optional"],
  ] as const) {
    for (const key of [...(chars ?? "").split("").map((char) => `-${char}`), ...(names ?? [])])
      table.set(key, {
        argument,
        path: spec.readValues?.includes(key)
          ? "read"
          : spec.writeValues?.includes(key)
            ? "write"
            : undefined,
        mutates: spec.mutating?.includes(key),
        incomplete: spec.unbounded?.includes(key),
      });
  }
  return table;
}
export function parseOptions(
  args: readonly string[],
  spec: OptionSpec,
  prefix?: { offset: number },
): ParsedOptions {
  // Bare wrapper layers need no table allocation; keep the budget for actual syntax work.
  let table: ReadonlyMap<string, OptionRule> | undefined;
  const ruleFor = (key: string) => {
    table ??= optionTable(spec);
    return table.get(key);
  };
  const result: ParsedOptions = {
    flags: new Set(),
    values: new Map(),
    operands: [],
    unknownOptions: [],
    reads: [],
    writes: [],
    readonly: true,
    unknown: false,
    incomplete: false,
    nextIndex: prefix?.offset ?? 0,
  };
  const unknown = (key: string) => {
    result.unknown = true;
    result.incomplete = true;
    result.unknownOptions.push(key);
    result.readonly = false;
  };
  const consume = (key: string, entry?: string) => {
    const rule = ruleFor(key);
    if (!rule) {
      unknown(key);
      return;
    }
    result.flags.add(key);
    if (rule.mutates) result.readonly = false;
    if (rule.incomplete) result.incomplete = true;
    if (rule.argument === "none") return;
    if (entry === undefined) {
      if (rule.argument === "value") unknown(key);
      return;
    }
    const values = result.values.get(key) ?? [];
    values.push(entry);
    result.values.set(key, values);
    if (rule.path) result[rule.path === "read" ? "reads" : "writes"].push(entry);
  };
  let options = true;
  for (let i = prefix?.offset ?? 0; i < args.length; i++) {
    result.nextIndex = i;
    const arg = args[i] ?? "";
    if (spec.assignment) {
      const equal = arg.indexOf("=");
      const key = equal < 0 ? arg : arg.slice(0, equal);
      consume(key, equal < 0 ? undefined : arg.slice(equal + 1));
      continue;
    }
    if (options && arg === "--") {
      options = false;
      if (prefix) {
        result.nextIndex = i + 1;
        return result;
      }
      continue;
    }
    if (!options || arg === "-" || !arg.startsWith("-")) {
      if (prefix) return result;
      result.operands.push(arg);
      if (spec.stopAtOperand) options = false;
      continue;
    }
    if (arg.startsWith("--") || spec.named) {
      const equal = arg.indexOf("=");
      const key = equal < 0 ? arg : arg.slice(0, equal);
      const rule = ruleFor(key);
      if (!rule || (equal >= 0 && rule.argument === "none")) unknown(arg);
      else
        consume(
          key,
          rule.argument === "value" && equal < 0
            ? args[++i]
            : equal < 0
              ? undefined
              : arg.slice(equal + 1),
        );
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const key = `-${arg[j] ?? ""}`;
      const rule = ruleFor(key);
      if (!rule) {
        unknown(key);
        continue;
      }
      if (rule.argument !== "none") {
        consume(
          key,
          j + 1 < arg.length ? arg.slice(j + 1) : rule.argument === "value" ? args[++i] : undefined,
        );
        break;
      }
      consume(key);
    }
  }
  result.nextIndex = args.length;
  return result;
}
export function optionValues(parsed: ParsedOptions, ...keys: string[]): string[] {
  return keys.flatMap((key) => parsed.values.get(key) ?? []);
}
export const DATE_OPTIONS: OptionSpec = {
  flags: "uRInj",
  values: "dsrf",
  optional: "I",
  longFlags: ["--utc", "--universal", "--rfc-email", "--help", "--version"],
  longValues: ["--date", "--set", "--reference", "--file"],
  longOptional: ["--iso-8601", "--rfc-3339"],
  readValues: ["-r", "--reference", "-f", "--file"],
  mutating: ["-s", "--set"],
};
export const FILE_OPTIONS: OptionSpec = {
  flags: "bcCdEhiklLnpPrsvzZ0",
  values: "mfeF",
  longFlags: [
    "--brief",
    "--checking-printout",
    "--compile",
    "--dereference",
    "--keep-going",
    "--mime",
    "--mime-type",
    "--mime-encoding",
    "--no-pad",
    "--preserve-date",
    "--raw",
    "--special-files",
    "--uncompress",
    "--uncompress-noreport",
    "--help",
    "--version",
  ],
  longValues: ["--magic-file", "--files-from", "--exclude", "--separator"],
  readValues: ["-m", "--magic-file", "-f", "--files-from"],
  mutating: ["-C", "--compile", "-p", "--preserve-date"],
};
