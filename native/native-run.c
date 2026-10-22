/*
 * native-run — run a z8lua script with a RAM image preloaded into the
 * interpreter's pico8memory (lua.c's static ram[]). For differential
 * diagnostics: same data, same Lua code, native semantics.
 *   native-run <script.lua> <ram.bin>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

static unsigned char ram[32768];

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: native-run <script.lua> <ram.bin>\n");
        return 2;
    }
    FILE *f = fopen(argv[2], "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", argv[2]); return 2; }
    size_t n = fread(ram, 1, sizeof ram, f);
    fclose(f);

    lua_State *L = luaL_newstate();
    if (!L) return 2;
    lua_setpico8memory(L, ram);
    luaL_openlibs(L);

    if (luaL_loadfile(L, argv[1]) != LUA_OK) {
        fprintf(stderr, "%s\n", lua_tostring(L, -1));
        lua_close(L);
        return 1;
    }
    if (lua_pcall(L, 0, LUA_MULTRET, 0) != LUA_OK) {
        fprintf(stderr, "%s\n", lua_tostring(L, -1));
        lua_close(L);
        return 1;
    }
    /* print any returned values */
    int nres = lua_gettop(L);
    for (int i = 1; i <= nres; i++) {
        const char *s = lua_tostring(L, i);
        printf("%s%s", s ? s : "?", i < nres ? "\t" : "\n");
    }
    lua_close(L);
    (void)n;
    return 0;
}
