# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, etc.) that **use** the Nimbuz CLI or **work on** this repository.

## Using the CLI from an agent

```bash
export NIMBUZ_TOKEN=...            # never prompt for a password
nimbuz projects list --json        # always --json; parse stdout only
nimbuz apps list -p shop-api -E production --json
nimbuz apps restart api -p shop-api -E production --yes --json
nimbuz logs api --since 15m --grep ERROR -p shop-api -E production
```

1. **Always** pass `--json`. Stdout is a single JSON value; everything else (progress, warnings) goes to stderr.
2. **Always** pass `--yes` for mutating commands — without a TTY, destructive commands fail with exit code `2` otherwise.
3. **Be explicit about scope** with `-p <project> -E <env>` instead of relying on saved context.
4. **Branch on exit codes**: `0` ok · `1` error · `2` usage · `4` auth needed/expired · `5` not found · `130` cancelled.
5. Discover flags with `nimbuz <command> --help` or read [`docs/COMMANDS.md`](docs/COMMANDS.md).
6. If a capability is not wrapped, use `nimbuz api <path> --json` rather than calling the HTTP API by hand.
7. Never print or log `nimbuz auth token` output; treat it as a secret.

## Working on this repository

- **Runtime:** Node.js ≥ 18, ES modules, **no runtime dependencies** — do not add any. Use `node:` built-ins.
- **Layout:**
  - `bin/nimbuz.js` — entry point
  - `src/cli.js` — builds the command tree and dispatches
  - `src/core/` — args parser, command registry + help renderer, HTTP/SSE client, config/profiles, context resolution, output formatting, errors
  - `src/lib/` — deployment spec builder (flags + manifest → API body) and rollout watcher
  - `src/commands/<group>.js` — one module per command group; each exports a command object `{ name, summary, aliases?, args?, flags?, examples?, commands?, run? }`
  - `test/` — `unit.test.js` and `e2e.test.js` (runs the real CLI against a mock API in `helpers.js`)
- **Adding or changing a command:** edit the module in `src/commands/`, include `examples`, add/adjust a test, then run:

  ```bash
  npm test
  npm run docs     # regenerates docs/COMMANDS.md — commit the result (CI checks it is up to date)
  ```
- **Output:** use `ctx.out.result(data, humanRenderer)` so `--json` and `--quiet` keep working. Write progress to stderr only.
- **Errors:** throw `CliError` / `UsageError` / `NotFoundError` from `src/core/errors.js` with a helpful `hint`; never `process.exit` inside commands.
- **Secrets:** never log tokens or passwords; `--debug` output is redacted in `src/core/http.js`.
- **Style:** 2-space indent, double quotes, small pure functions, no new dependencies.
