/*
 * diag: A/B luaL_loadfilex vs luaL_loadbufferx dump determinism (same process).
 * build: g++ -std=c++17 -O2 -I<z8lua> diag_dump.c <z8lua>/liblua.a -o out -lm
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"

static FILE *g_out;

static int writer(lua_State *L, const void *p, size_t sz, void *ud)
{
    (void)L; (void)ud;
    return fwrite(p, 1, sz, g_out) != sz;
}

static char *read_all(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *b = (char *)malloc(n);
    if (fread(b, 1, n, f) != (size_t)n) { fclose(f); free(b); return NULL; }
    fclose(f);
    *out_len = (size_t)n;
    return b;
}

static int dump_one(int mode, const char *path, const char *outp)
{
    lua_State *L = luaL_newstate();
    int st;
    if (mode == 0) {
        st = luaL_loadfilex(L, path, NULL);
    } else {
        size_t n = 0;
        char *b = read_all(path, &n);
        char name[1024];
        snprintf(name, sizeof name, "@%s", path);
        st = luaL_loadbufferx(L, b, n, name, "bt");
        free(b);
    }
    if (st != 0) {
        fprintf(stderr, "load fail (mode %d): %s\n", mode, lua_tostring(L, -1));
        lua_close(L);
        return 1;
    }
    g_out = fopen(outp, "wb");
    int r = lua_dump(L, writer, NULL);
    fclose(g_out);
    lua_close(L);
    if (r != 0) fprintf(stderr, "dump fail (mode %d)\n", mode);
    return r;
}

int main(int argc, char **argv)
{
    if (argc < 3) { fprintf(stderr, "usage: diag_dump <src.lua> <outdir>\n"); return 2; }
    const char *src = argv[1], *dir = argv[2];
    char out[2048];
    for (int i = 0; i < 3; i++) {
        snprintf(out, sizeof out, "%s/lf-%d.bc", dir, i + 1);
        if (dump_one(0, src, out)) return 1;
        snprintf(out, sizeof out, "%s/lb-%d.bc", dir, i + 1);
        if (dump_one(1, src, out)) return 1;
    }
    printf("diag_dump: ok\n");
    return 0;
}
