# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ichwann12/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ichwann12/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process (standard library only):
git smart HTTP (upload-pack protocol v2, receive-pack v0) implemented from scratch with
no git binary, the REST v3 API for repositories, issues, pull requests and contents,
the GraphQL v4 API, and a Model Context Protocol endpoint — all over one in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, serves the
forge until the environment says the trial is done, then exits 0. See `docs/CONTRACT.md`
for the module map and the wire contract the forge implements.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
