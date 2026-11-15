# github-core-clone-01 — a standalone GitHub-compatible git forge

One Node 22 process, standard library only, serving four surfaces from its own
in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (`ls-refs`, `fetch`, shallow/deepen) and v0 fallback, receive-pack v0 with
  `report-status` / `side-band-64k` / `delete-refs`. The object store, packfile
  reader/writer (plain, OFS_DELTA and REF_DELTA) and pkt-line codec are
  implemented here from scratch; no git binary, no outside service.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash merge.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server`
  send, including introspection, Relay global ids and operation batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the 2025-11-25 handshake as a fallback.

## Run it

```sh
node main.ts
```

The program binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` answers
`{"done": true}`, then exits 0. With no `MAKEFUN_ENV_URL` it serves on
`$PORT` (default 3101) for local testing. The bearer token it enforces is
`$MAKEFUN_SHOP_TOKEN` (when set).

## Layout

- `main.ts` — the entry/env lifecycle.
- `src/app.ts` — the HTTP server, routing, auth and JSON plumbing.
- `src/store.ts` — the forge store: repositories, git objects and refs,
  issues, pull requests, labels and comments, plus tree/commit/merge helpers.
- `src/gitobj.ts` — git object model, pkt-line codec and packfile codec.
- `src/githttp.ts` — the smart-HTTP protocol handlers.
- `src/rest.ts` — the REST v3 handlers.
- `src/graphql.ts` — a small GraphQL parser and executor.
- `src/mcp.ts` — the MCP endpoint and its tools.
- `src/scenario.ts` — the token owner's login, derived from the competition's
  published fixed scenario seed (the token itself carries no login).

## License

MIT.
