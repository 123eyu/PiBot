import { ExecError } from "../core/types.ts";

const UNSAFE_VARIABLES = ["SRT_DEBUG", "CLAUDE_CODE_TMPDIR", "CLAUDE_TMPDIR"] as const;

export class UnsafeSandboxEnvironmentError extends ExecError {
  private constructor(readonly variables: ReadonlyArray<(typeof UNSAFE_VARIABLES)[number]>) {
    super("invalid_input");
  }

  static assertSafe(env: NodeJS.ProcessEnv): void {
    const variables = UNSAFE_VARIABLES.filter((name) => env[name]);
    if (variables.length) throw new UnsafeSandboxEnvironmentError(variables);
  }
}
