<div align="center">

# ☁️ Nimbuz CLI

**Deploy and run apps, databases and AI models on [Nimbuz Cloud](https://nimbuz.tech) — straight from your terminal.**

[![npm version](https://img.shields.io/npm/v/@nimbuz-tech/cli?color=6d28d9&label=npm&logo=npm)](https://www.npmjs.com/package/@nimbuz-tech/cli)
[![npm downloads](https://img.shields.io/npm/dm/@nimbuz-tech/cli?color=6d28d9)](https://www.npmjs.com/package/@nimbuz-tech/cli)
[![CI](https://github.com/nimbuz-tech/nimbuz-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/nimbuz-tech/nimbuz-cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@nimbuz-tech/cli?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-success)](package.json)
[![license](https://img.shields.io/npm/l/@nimbuz-tech/cli?color=blue)](LICENSE)

[Install](#-install) · [Quick start](#-quick-start) · [Commands](#-commands) · [Deploying](#-deploying) · [CI/CD](#-scripting--cicd) · [AI agents](#-for-ai-agents--llms) · [Full reference](docs/COMMANDS.md)

</div>

```console
$ npm i -g @nimbuz-tech/cli
$ nimbuz login
✔ Logged in as jane@acme.com (acme)
$ nimbuz use shop-api production
$ nimbuz deploy
▸ Building shop-api from github.com/acme/shop-api@main
▸ Rolling out 2/2 replicas …
✔ shop-api is live → https://shop-api.acme.nimbuz.app
```

---

## ✨ Why Nimbuz CLI

| | |
| --- | --- |
| 🚀 **One-command deploys** | `nimbuz deploy` creates the app if it is missing, rolls out changes if it exists, and waits until it is live. |
| 🧭 **Everything the portal does** | Projects, environments, apps, managed databases, cron jobs, domains, AI endpoints, logs, metrics, billing, team and support — 130+ commands. |
| 🤖 **Built for scripts, CI and AI agents** | `--json` on stdout, progress on stderr, `--quiet` IDs, `--yes` for non-interactive runs, and stable exit codes. |
| 📄 **Declarative manifest** | Commit a `nimbuz.json`; keep secrets out of git with `${VAR}` interpolation. |
| 🪶 **Zero dependencies** | Pure Node.js 18+. Installs in seconds, nothing to audit but this repo. |
| 🔐 **Safe by default** | 2FA login, sessions stored with mode `0600`, secrets redacted in `--debug` logs, confirmations on destructive actions. |

## 📦 Install

```bash
npm install -g @nimbuz-tech/cli
```

Or run it without installing:

```bash
npx @nimbuz-tech/cli --help
```

Requires **Node.js 18 or newer**. The installed binary is called `nimbuz`.

## ⚡ Quick start

```bash
nimbuz login                         # Individual or Business account, supports 2FA
nimbuz projects create shop-api      # creates the project and a "production" environment
nimbuz init                          # writes nimbuz.json from your git remote / package.json
nimbuz deploy                        # create-or-update, then wait until it is live
nimbuz logs shop-api -f              # stream logs
nimbuz status                        # overview of the current environment
```

Run `nimbuz --help` or `nimbuz <command> --help` for every flag and example.

## 🧰 Commands

| Area | Commands |
| --- | --- |
| **Getting started** | `login` · `logout` · `whoami` · `use [project] [env]` · `context` · `status` · `init` · `deploy` |
| **Projects** | `projects list\|get\|create\|update\|delete` |
| **Environments** | `envs list\|get\|create\|update\|delete\|usage` |
| **Apps** | `apps list\|get\|create\|update\|redeploy\|start\|stop\|restart\|delete\|status [--watch]\|releases\|cancel\|open` |
| | `apps env list\|set\|unset` · `apps secrets list\|set\|unset` |
| **Managed tools** (PostgreSQL, MongoDB, n8n…) | `tools catalog\|list\|get\|install\|update\|resize\|start\|stop\|delete` |
| **Cron jobs** | `cron list\|runs\|create\|start\|stop\|delete` |
| **Domains** | `domains list\|expose\|add\|verify\|remove\|unexpose` |
| **AI endpoints** | `ai models\|list\|create\|rotate-key\|rate-limit\|usage\|revoke\|env-key` |
| **Logs** | `logs <app\|tool> [-f] [--since 1h] [--grep x] [--build]` |
| **Metrics** | `metrics app\|tool\|env\|container [--since 6h] [--live]` |
| **Billing** | `billing invoices\|invoice\|download\|usage\|forecast\|explorer\|credits\|limits\|pricing` · `billing budget …` · `billing alerts …` |
| **Team** | `team list\|invite\|remove\|policies\|grant\|revoke` |
| **Support** | `support list\|show\|create\|reply` |
| **Account** | `auth status\|token\|2fa …\|change-password\|forgot-password` · `config list\|get\|set\|unset\|path\|profiles` |
| **Advanced** | `api <path>` (raw authenticated requests) · `completion bash\|zsh\|fish` · `version` |

Most commands have short aliases — `apps ls`, `envs rm`, `tools db`, `metrics top`.

📖 **The complete, auto-generated reference of every command, argument and flag lives in [`docs/COMMANDS.md`](docs/COMMANDS.md).**

## 🎯 Context: project and environment

Nearly every command acts on a project and an environment. The CLI resolves them in this order:

1. `--project / -p` and `--env / -E` flags (name or ID)
2. `NIMBUZ_PROJECT` and `NIMBUZ_ENV` environment variables
3. the saved context from `nimbuz use <project> [environment]`
4. automatically, when only one exists — or by asking you in an interactive terminal

Names match exactly, case-insensitively, or by a unique prefix (`nimbuz use sho` → `shop-api`).

## 🚢 Deploying

```bash
# From Git (GitHub / GitLab / Bitbucket; owner/repo is GitHub shorthand)
nimbuz apps create shop-api --repo acme/shop-api -b main --port 3000 \
  -i small.m --health /health -e NODE_ENV=production --secret-file .env.secrets --wait

# From a local archive
nimbuz apps create site --archive ./dist.zip --port 80

# Change settings (only what you pass is sent)
nimbuz apps update shop-api --instance medium.m --replicas 2
nimbuz apps update shop-api --autoscale 2:6
nimbuz apps redeploy shop-api --branch release/2.0 --wait
```

### `nimbuz.json` manifest

`nimbuz init` writes this file; `nimbuz deploy` reads it, creates the app if missing, and otherwise rolls out the changes.

```json
{
  "name": "shop-api",
  "project": "shop-api",
  "environment": "production",
  "source": { "repo": "https://github.com/acme/shop-api.git", "branch": "main", "dockerfile": "Dockerfile", "dir": "", "autoDeploy": false },
  "build": { "install": "npm ci", "build": "npm run build", "start": "npm start" },
  "instance": "small.m",
  "replicas": 1,
  "autoscale": { "min": 1, "max": 4 },
  "port": 3000,
  "health": "/health",
  "storage": "1Gi",
  "vars": { "NODE_ENV": "production" },
  "secrets": { "DATABASE_URL": "${DATABASE_URL}" },
  "configFile": { "from": "./config/app.yaml", "path": "/app/config/app.yaml" }
}
```

Values written as `${VAR}` (or `${VAR:-default}`) are read from your shell, so CI secrets never need to be committed. Flags override the manifest. Use `-f` for another file: `nimbuz deploy -f deploy/prod.json --env production`.

## 🤖 Scripting & CI/CD

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable JSON on **stdout**; progress and spinners go to **stderr**. |
| `-q, --quiet` | Print only names/IDs — `nimbuz apps ls -q \| xargs -n1 nimbuz apps restart` |
| `-y, --yes` | Skip confirmations. Without a TTY, destructive commands require it. |

**Non-interactive auth:** set `NIMBUZ_TOKEN`, or pipe a password:

```bash
echo "$NIMBUZ_PASSWORD" | nimbuz login --org acme -u ci@acme.com --password-stdin
```

### GitHub Actions

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx @nimbuz-tech/cli deploy --env production --yes
  env:
    NIMBUZ_TOKEN: ${{ secrets.NIMBUZ_TOKEN }}
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Error |
| `2` | Usage error (bad flag or argument) |
| `4` | Not logged in or session expired |
| `5` | Not found |
| `130` | Cancelled |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `NIMBUZ_TOKEN` | Access token (overrides the saved session) |
| `NIMBUZ_PROFILE` | Config profile |
| `NIMBUZ_PROJECT` / `NIMBUZ_ENV` | Default project / environment |
| `NIMBUZ_USERNAME` / `NIMBUZ_PASSWORD` | Non-interactive login |
| `NIMBUZ_CONFIG_DIR` | Config directory (default `~/.nimbuz-cli`) |
| `NIMBUZ_DEBUG` | Same as `--debug`: logs HTTP calls (secrets redacted) |
| `NO_COLOR` / `FORCE_COLOR` | Color control |

## 👥 Profiles

Keep several accounts side by side:

```bash
nimbuz --profile acme login --org acme
nimbuz config profiles use acme
```

Sessions are stored in `~/.nimbuz-cli/config.json` with file mode `0600`.

## 🔌 Raw API access

Anything the CLI does not wrap yet is one authenticated call away. `{projectId}`, `{environmentId}` and `{accountId}` are filled in from your context.

```bash
nimbuz api /project/v1/projects
nimbuz api /deployment/v1/deployments/list --scoped          # adds projectId & environmentId
nimbuz api GET /pricing/v1/invoices -Q account_id={accountId} -Q limit=5
```

## 🐚 Shell completion

```bash
eval "$(nimbuz completion zsh)"      # add to ~/.zshrc   (also: bash, fish)
```

## 🧠 For AI agents & LLMs

This repository is optimised for coding agents and LLM tools:

- **[`llms.txt`](llms.txt)** — a compact, structured summary of the CLI following the [llms.txt](https://llmstxt.org) convention.
- **[`AGENTS.md`](AGENTS.md)** — how to drive the CLI non-interactively and how to work on this codebase.
- **[`docs/COMMANDS.md`](docs/COMMANDS.md)** — every command, argument and flag, generated from the source of truth.

Rules of thumb for agents: always pass `--json` and `--yes`, set `NIMBUZ_TOKEN`, select scope with `-p/-E`, and branch on exit codes rather than parsing text.

## 🛠️ Development

```text
bin/nimbuz.js          entry point
src/cli.js             command tree, dispatch, error reporting
src/core/              args parser, registry/help, HTTP+SSE client, config/profiles, context resolution, output
src/lib/               deployment spec builder (flags + manifest → API body), rollout watcher
src/commands/          one module per command group
scripts/gen-docs.js    generates docs/COMMANDS.md from the registry
test/                  unit tests + end-to-end tests against a mock API
```

```bash
git clone https://github.com/nimbuz-tech/nimbuz-cli.git && cd nimbuz-cli
npm link          # puts `nimbuz` on your PATH from this checkout
npm test          # unit + e2e tests (node:test, no dependencies)
npm run docs      # regenerate docs/COMMANDS.md after changing commands
```

Contributions are welcome — please open an issue or pull request.

## 📄 License

[MIT](LICENSE) © Nimbuz

<div align="center">
<sub>Made with ☁️ by the <a href="https://nimbuz.tech">Nimbuz</a> team · <a href="https://docs.nimbuz.tech">Docs</a> · <a href="https://docs.nimbuz.tech/api">API reference</a></sub>
</div>
