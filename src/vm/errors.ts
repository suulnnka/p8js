// Error and control signals.
//
// LuaError   — normal Lua errors (error(), runtime errors); carries the
//              message exactly as Lua formats it plus optional traceback.
// YieldSignal— coroutine yield / flip(): unwinds JS frames; every execute()
//              level saves its pc into its Frame before rethrowing; native
//              hosts (pcall etc.) must let it pass. Known gap: yield *across*
//              a native pcall loses pcall's post-processing (see PLAN §8 —
//              fake-08's bios yields inside the cart coroutine where
//              coroutine.resume is the boundary, so this doesn't bite there).
// BudgetSignal — per-frame instruction budget exceeded (PLAN §4.3c); turned
//              into a Lua error at the tick boundary so a runaway cart can't
//              freeze the browser.

import type { Value } from "./value.ts";

export class LuaError extends Error {
  /**
   * The Lua error value as pcall sees it: error({code=1}) carries the table,
   * error("msg") / runtime errors carry the position-prefixed string.
   * Defaults to `message` when not set explicitly.
   */
  value: Value;

  constructor(
    message: string,
    /** false for error(msg, 0): don't prepend "chunkname:line: ". */
    public withPosition = true,
    public traceback: string | null = null,
    value?: Value,
  ) {
    super(message);
    this.value = value ?? message;
  }

  fullMessage(): string {
    let m = this.message;
    if (this.withPosition && this.traceback) m = this.traceback + m;
    return m;
  }
}

export class YieldSignal {
  constructor(readonly values: Value[]) {}
}

export class BudgetSignal {
  constructor(readonly limit: number) {}
}
