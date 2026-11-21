import type { ParsedOptions } from "./options/options.ts";
export interface FindAction {
  option: string;
  words: string[];
}
export interface ArgumentFacts {
  reads: string[];
  writes: string[];
  readonly: boolean;
  incomplete: boolean;
  unknownOptions: string[];
  network: boolean;
  domains: string[];
  find?: { roots: string[]; actions: FindAction[] };
}
export function optionFacts(parsed: ParsedOptions): ArgumentFacts {
  return {
    reads: [...parsed.reads],
    writes: [...parsed.writes],
    readonly: parsed.readonly,
    incomplete: parsed.incomplete,
    unknownOptions: parsed.unknownOptions,
    network: false,
    domains: [],
  };
}

/**
 * `head -20` / `git log -5` are the traditional spelling of `-n 20`; without this the
 * commonest read-only commands were "unknown option" and always asked.
 */
export function countShorthand(args: readonly string[]): string[] {
  return args.flatMap((arg) => (/^-\d+$/.test(arg) ? ["-n", arg.slice(1)] : [arg]));
}
