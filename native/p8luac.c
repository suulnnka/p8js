/*
 * p8luac — z8lua bytecode dumper (luac-style driver for the z8lua fork).
 *
 *   p8luac [in.lua [out.bc]]
 *
 * Reads PICO-8 Lua source from stdin (or in.lua), compiles it with luaL_loadbuffer,
 * and writes the z8lua dump (Lua 5.2 format + PICO-8 opcode extensions) to stdout
 * (or out.bc). Compile errors go to stderr with line numbers; exit code 1.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lua.h"
#include "lauxlib.h"

static FILE *g_out = NULL;

static int writer(lua_State *L, const void *p, size_t sz, void *ud)
{
    (void)L;
    (void)ud;
    return fwrite(p, 1, sz, g_out) != sz;
}

static char *read_all(FILE *f, size_t *out_len)
{
    size_t cap = 1 << 16;
    size_t len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf)
        return NULL;
    for (;;) {
        size_t n = fread(buf + len, 1, cap - len, f);
        len += n;
        if (len < cap) {
            if (feof(f))
                break;
            if (ferror(f)) {
                free(buf);
                return NULL;
            }
            /* buffer full but not EOF: grow */
        }
        if (len == cap) {
            cap *= 2;
            buf = (char *)realloc(buf, cap);
            if (!buf)
                return NULL;
        }
    }
    *out_len = len;
    return buf;
}

int main(int argc, char **argv)
{
    const char *chunkname = getenv("P8_CHUNKNAME");
    FILE *in = stdin;
    FILE *out = stdout;
    char *src;
    size_t srclen = 0;
    lua_State *L;
    int status;

    if (!chunkname)
        chunkname = "=(p8luac)";
    if (argc > 1 && strcmp(argv[1], "-") != 0) {
        /* file mode: p8luac in.lua [out.bc] */
        in = fopen(argv[1], "rb");
        if (!in) {
            fprintf(stderr, "p8luac: cannot open '%s'\n", argv[1]);
            return 1;
        }
        chunkname = argv[1];
        if (argc > 2 && strcmp(argv[2], "-") != 0) {
            out = fopen(argv[2], "wb");
            if (!out) {
                fprintf(stderr, "p8luac: cannot open '%s'\n", argv[2]);
                return 1;
            }
        }
    }
    else if (argc > 2) {
        /* stdin mode: p8luac - <chunkname> — used for error/traceback names
           (WSL does not reliably forward custom environment variables).
           The '@' prefix makes Lua treat it as a file name in messages. */
        static char namebuf[4096];
        if (argv[2][0] == '@' || argv[2][0] == '=' ||
            (argv[2][0] == '[' && argv[2][1] == 's'))
            chunkname = argv[2];
        else {
            snprintf(namebuf, sizeof namebuf, "@%s", argv[2]);
            chunkname = namebuf;
        }
    }

    src = read_all(in, &srclen);
    if (in != stdin)
        fclose(in);
    if (!src) {
        fprintf(stderr, "p8luac: failed to read input\n");
        return 1;
    }

    L = luaL_newstate();
    if (!L) {
        fprintf(stderr, "p8luac: cannot create lua state\n");
        return 1;
    }
    g_out = out;

    status = luaL_loadbuffer(L, src, srclen, chunkname);
    if (status != 0) {
        const char *msg = lua_tostring(L, -1);
        fprintf(stderr, "%s\n", msg ? msg : "(unknown error)");
        lua_close(L);
        free(src);
        return 1;
    }

    status = lua_dump(L, writer, NULL);
    if (status != 0) {
        fprintf(stderr, "p8luac: failed to dump bytecode\n");
        lua_close(L);
        free(src);
        return 1;
    }

    lua_close(L);
    free(src);
    if (out != stdout)
        fclose(out);
    return 0;
}
