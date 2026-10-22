// lauxlib-style argument checking helpers for NativeFn implementations.
// Numbers are fix32 bit patterns; "checkinteger" is the int16-faithful floor
// (lua_number2integer → (int16_t)fix32 → identity on floor values, see
// llimits.h:254 + fix32 operator int16_t).

import { LuaError } from "./errors.ts";
import type { LuaState } from "./state.ts";
import { Table, typeOf, type Value } from "./value.ts";
import * as fx from "./fix32.ts";
import { argError, typeErrorArg, typeError, toNumber } from "./interp.ts";

export const hasArg = (args: Value[], narg: number): boolean =>
  narg - 1 < args.length && args[narg - 1] !== undefined;

export function checkAny(L: LuaState, args: Value[], narg: number): void {
  if (!hasArg(args, narg)) {
    argError(L, narg, "value expected");
  }
}

export function checkString(
  L: LuaState, args: Value[], narg: number,
): string {
  const v = args[narg - 1];
  if (typeof v === "string") return v;
  if (typeof v === "number") return fx.numToString(v); // luaL_checklstring coerces
  typeErrorArg(L, args, narg, "string");
}

export function checkNumber(
  L: LuaState, args: Value[], narg: number,
): number {
  const n = hasArg(args, narg) ? toNumber(args[narg - 1]) : undefined;
  if (n !== undefined) return n;
  typeErrorArg(L, args, narg, "number");
}

/** luaL_checkinteger — floor, faithful to the int16 cast (values always fit). */
export function checkInt(L: LuaState, args: Value[], narg: number): number {
  return fx.toInt(checkNumber(L, args, narg));
}

export function optString(
  L: LuaState, args: Value[], narg: number, def: string | null,
): string | null {
  const v = args[narg - 1];
  if (v === undefined || v === null) return def;
  return checkString(L, args, narg);
}

export function optNumber(
  L: LuaState, args: Value[], narg: number, def: number,
): number {
  const v = args[narg - 1];
  if (v === undefined || v === null) return def;
  return checkNumber(L, args, narg);
}

export function optInt(
  L: LuaState, args: Value[], narg: number, def: number,
): number {
  const v = args[narg - 1];
  if (v === undefined || v === null) return def;
  return checkInt(L, args, narg);
}

export function checkTable(
  L: LuaState, args: Value[], narg: number,
): Table {
  const v = args[narg - 1];
  if (v instanceof Table) return v;
  typeErrorArg(L, args, narg, "table");
}

export function isNoneOrNil(args: Value[], narg: number): boolean {
  const v = args[narg - 1];
  return v === undefined || v === null;
}

/** luaL_typename for arg errors: missing args are "no value". */
export function typeNameOrNoValue(args: Value[], narg: number): string {
  return hasArg(args, narg) ? typeOf(args[narg - 1]) : "no value";
}
