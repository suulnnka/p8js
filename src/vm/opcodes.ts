// Lua 5.2 instruction set as extended by z8lua (53 opcodes).
// Ported from native/build/z8lua/lopcodes.h (enum OpCode) — order is load-
// bearing: undump'd code stores opcode numbers, and z8lua inserts LSHR/ROTL/
// ROTR after SHR and PEEK/PEEK2/PEEK4 between NOT and LEN, shifting every
// later opcode by 3 then 6.

export const OP_MOVE = 0;
export const OP_LOADK = 1;
export const OP_LOADKX = 2;
export const OP_LOADBOOL = 3;
export const OP_LOADNIL = 4;
export const OP_GETUPVAL = 5;
export const OP_GETTABUP = 6;
export const OP_GETTABLE = 7;
export const OP_SETTABUP = 8;
export const OP_SETUPVAL = 9;
export const OP_SETTABLE = 10;
export const OP_NEWTABLE = 11;
export const OP_SELF = 12;
export const OP_ADD = 13;
export const OP_SUB = 14;
export const OP_MUL = 15;
export const OP_DIV = 16;
export const OP_MOD = 17;
export const OP_POW = 18;
export const OP_IDIV = 19;
export const OP_BAND = 20;
export const OP_BOR = 21;
export const OP_BXOR = 22;
export const OP_SHL = 23;
export const OP_SHR = 24;
export const OP_LSHR = 25;
export const OP_ROTL = 26;
export const OP_ROTR = 27;
export const OP_UNM = 28;
export const OP_BNOT = 29;
export const OP_NOT = 30;
export const OP_PEEK = 31;
export const OP_PEEK2 = 32;
export const OP_PEEK4 = 33;
export const OP_LEN = 34;
export const OP_CONCAT = 35;
export const OP_JMP = 36;
export const OP_EQ = 37;
export const OP_LT = 38;
export const OP_LE = 39;
export const OP_TEST = 40;
export const OP_TESTSET = 41;
export const OP_CALL = 42;
export const OP_TAILCALL = 43;
export const OP_RETURN = 44;
export const OP_FORLOOP = 45;
export const OP_FORPREP = 46;
export const OP_TFORCALL = 47;
export const OP_TFORLOOP = 48;
export const OP_SETLIST = 49;
export const OP_CLOSURE = 50;
export const OP_VARARG = 51;
export const OP_EXTRAARG = 52;

export const NUM_OPCODES = 53;

export const OPNAMES = [
  "MOVE", "LOADK", "LOADKX", "LOADBOOL", "LOADNIL", "GETUPVAL",
  "GETTABUP", "GETTABLE", "SETTABUP", "SETUPVAL", "SETTABLE",
  "NEWTABLE", "SELF",
  "ADD", "SUB", "MUL", "DIV", "MOD", "POW", "IDIV",
  "BAND", "BOR", "BXOR", "SHL", "SHR", "LSHR", "ROTL", "ROTR",
  "UNM", "BNOT", "NOT", "PEEK", "PEEK2", "PEEK4", "LEN",
  "CONCAT", "JMP", "EQ", "LT", "LE", "TEST", "TESTSET",
  "CALL", "TAILCALL", "RETURN", "FORLOOP", "FORPREP",
  "TFORCALL", "TFORLOOP", "SETLIST", "CLOSURE", "VARARG", "EXTRAARG",
] as const;

// Instruction field extraction (POS_OP=0, A at 6, C at 14, B at 23, Bx at 14).
export const getOp = (i: number): number => i & 0x3f;
export const getA = (i: number): number => (i >>> 6) & 0xff;
export const getC = (i: number): number => (i >>> 14) & 0x1ff;
export const getB = (i: number): number => (i >>> 23) & 0x1ff;
export const getBx = (i: number): number => (i >>> 14) & 0x3ffff;
export const getSJx = (i: number): number => ((i >>> 14) & 0x3ffff) - 0x1ffff;
export const getAx = (i: number): number => i >>> 6;

// RK: bit 8 marks a constant index (BITRK = 1 << (SIZE_B-1) = 0x100).
export const BITRK = 0x100;
export const isK = (x: number): boolean => (x & BITRK) !== 0;
export const indexK = (x: number): number => x & 0xff;
