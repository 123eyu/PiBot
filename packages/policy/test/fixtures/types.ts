import type { GrantScope, Level, Workplaces } from "@pibot/protocol-base";
import type { Decision, Platform, PolicyRequest } from "../../src/core/types.ts";
export interface Expected {
  programs: string[];
  reason?: string;
  grantScope?: GrantScope | null;
  readonly?: boolean;
  unknownOptions?: string[];
  reads: string[];
  writes: string[];
  domains: string[];
  network: boolean;
  incomplete: boolean;
  risk: "normal" | "danger";
  decision: Decision;
  canRemember: boolean;
}
export interface Fixture {
  name: string;
  request: PolicyRequest;
  expected: Expected;
  runLevel?: Level;
  platform?: Platform;
  withGrant?: boolean;
  grantRoot?: string;
  workplace?: Workplaces;
}
export const inside = (path: string) => (path ? `/work/${path}` : "/work");
export function command(text: string, programs: string[], fields: Partial<Expected> = {}): Fixture {
  return {
    name: text,
    request: { category: "run_command", command: text },
    expected: {
      programs,
      reads: [],
      writes: [],
      domains: [],
      network: false,
      incomplete: false,
      risk: "normal",
      decision: "ask",
      canRemember: true,
      ...fields,
    },
  };
}
export const read = (text: string, program: string, paths: string[]) =>
  command(text, [program], { reads: paths.map(inside) });
export const mutate = (
  text: string,
  program: string,
  writes: string[],
  fields: Partial<Expected> = {},
) => command(text, [program], { writes, incomplete: true, canRemember: false, ...fields });
export const unknown = (text: string, programs: string[], fields: Partial<Expected> = {}) =>
  command(text, programs, { incomplete: true, canRemember: false, ...fields });
