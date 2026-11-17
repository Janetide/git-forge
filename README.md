# git-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/Janetide/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/Janetide/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge: one process serving git smart HTTP,
REST v3, GraphQL v4 and MCP from its own in-memory store. No UI, no outside
service, no dependencies — Node 22 standard library only.

Built for [make.fun bounty github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. The lifecycle in
`main.ts` (bind an ephemeral port, register with `$MAKEFUN_ENV_URL`, poll
`/done`) is the harness's; the server is in `app.ts`.

Local development (no env to register with, so `main.ts` serves standalone):

```sh
MAKEFUN_SHOP_TOKEN=test node --experimental-strip-types main.ts
```

## Layout

- `main.ts` — lifecycle: bind, register, wait for done, exit 0.
- `app.ts` — HTTP server: auth, routing, body limits.
- `store.ts` — in-memory state plus the git object model (objects, trees,
  commits, reachability, packs, issues, pull requests, squash merges).
- `git.ts` — git smart HTTP: `info/refs`, `git-upload-pack` (v0 and v2),
  `git-receive-pack`, pkt-lines, pack building, fast-forward validation.
- `rest.ts` — GitHub REST v3: repositories, branches, commits, contents,
  labels, issues, comments, pull requests, merges.
- `graphql.ts` — a small GraphQL parser/executor for the documents `gh` and
  `github-mcp-server` send, plus `__type` introspection.
- `mcp.ts` — MCP over Streamable HTTP: `server/discover`, `initialize`,
  `tools/list`, `tools/call` (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`, plus
  `get_issue` and `list_repos`).

## Notes

- The bearer token is `MAKEFUN_SHOP_TOKEN`; `/healthz` takes none. When the
  variable is unset (local development only) any non-empty bearer is accepted.
- The token owner is the scenario viewer `adaiversen` (id 1000).
- Timestamps in stored state come from a fixed epoch plus a monotonic counter,
  so two runs on the same instance leave the same state.
- Packs are built from plain (undelted) objects and cached per object set;
  issue reads are served from a cached serialisation.
