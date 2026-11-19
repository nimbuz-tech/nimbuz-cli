<div align="center">

# ☁️ Nimbuz CLI

**Projects, environments, apps and managed tools on [Nimbuz Cloud](https://nimbuz.tech) — straight from your terminal.**

[![npm version](https://img.shields.io/npm/v/@nimbuz-tech/cli?color=6d28d9&label=npm&logo=npm)](https://www.npmjs.com/package/@nimbuz-tech/cli)
[![npm downloads](https://img.shields.io/npm/dm/@nimbuz-tech/cli?color=6d28d9)](https://www.npmjs.com/package/@nimbuz-tech/cli)
[![CI](https://github.com/nimbuz-tech/nimbuz-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/nimbuz-tech/nimbuz-cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@nimbuz-tech/cli?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-success)](package.json)
[![license](https://img.shields.io/npm/l/@nimbuz-tech/cli?color=blue)](LICENSE)

[Install](#-install) · [Quick start](#-quick-start) · [Projects](#-projects) · [Environments](#-environments) · [Apps](#-apps) · [Tools](#-managed-tools) · [CI/CD](#-scripting--cicd) · [Full reference](docs/COMMANDS.md)

</div>

```bash
npm i -g @nimbuz-tech/cli

nimbuz login
nimbuz projects create shop-api                    # project + "production" environment
nimbuz tools install postgresql orders-db          # managed database
nimbuz apps create api --repo acme/shop-api --port 3000 --wait
```

---

## 🧭 How Nimbuz is organised

```text
Project  (shop-api)
 └─ Environment  (production, staging, …)   ← resource limits & quotas
     ├─ Apps   (api, web, worker …)          ← built from Git or an archive
     └─ Tools  (PostgreSQL, MongoDB, n8n …)  ← managed, one-command installs
```

Every app and tool lives in an **environment**, and every environment belongs to a **project**. The CLI mirrors this: pick a project and environment once with `nimbuz use`, then work with apps and tools.

## ✨ Why Nimbuz CLI

| | |
| --- | --- |
| 🚀 **One-command deploys** | `nimbuz deploy` creates the app if it is missing, rolls out changes if it exists, and waits until it is live. |
| 🗄️ **Managed tools in seconds** | Install PostgreSQL, MongoDB, n8n and more from the catalog, then resize, stop or start them. |
| 🌱 **Environments with guardrails** | Separate production and staging, each with its own CPU, memory and storage limits. |
| 🤖 **Built for scripts, CI and AI agents** | `--json` on stdout, progress on stderr, `--quiet` IDs, `--yes` for non-interactive runs, stable exit codes. |
| 🪶 **Zero dependencies** | Pure Node.js 18+. Installs in seconds. |
| 🔐 **Safe by default** | 2FA login, sessions stored with mode `0600`, secrets redacted in `--debug` logs, confirmations on destructive actions. |

## 📦 Install

```bash
npm install -g @nimbuz-tech/cli      # installs the `nimbuz` command
```

Or run it without installing: `npx @nimbuz-tech/cli --help`. Requires **Node.js 18 or newer**.

## ⚡ Quick start

```bash
nimbuz login                         # Individual or Business account, supports 2FA
nimbuz projects create shop-api      # creates the project and a "production" environment
nimbuz init                          # writes nimbuz.json from your git remote / package.json
nimbuz deploy                        # create-or-update the app, then wait until it is live
nimbuz status                        # overview of the current environment
```

Run `nimbuz <command> --help` for every flag and example.

---

## 📁 Projects

A project groups everything that belongs to one product or service.

| Command | What it does |
| --- | --- |
| `nimbuz projects list` | List projects (`ls`) |
| `nimbuz projects get [project]` | Show a project and its environments |
| `nimbuz projects create [name]` | Create a project and its first environment |
| `nimbuz projects update [project]` | Rename a project or change its description |
| `nimbuz projects delete [project]` | Delete an empty project (`rm`) |

```bash
nimbuz projects create shop-api -d "Backend for the web shop"
nimbuz projects create shop-api --env-name staging --region ap-south-1
nimbuz use shop-api production       # set the current project + environment
```

## 🌱 Environments

Environments (`production`, `staging`, `dev`…) isolate workloads and carry their own resource limits.

| Command | What it does |
| --- | --- |
| `nimbuz envs list` | List environments in the project |
| `nimbuz envs get [env]` | Show an environment with limits and quotas |
| `nimbuz envs create <name>` | Create an environment (`--use` to switch to it) |
| `nimbuz envs update [env]` | Rename, or set `--cpu`, `--memory`, `--storage`, `--ephemeral` limits |
| `nimbuz envs usage [env]` | Show remaining resource quota |
| `nimbuz envs delete [env]` | Delete an empty environment |

```bash
nimbuz envs create staging --use
nimbuz envs update production --cpu 4 --memory 8 --storage 20
nimbuz envs usage
```

### Choosing project and environment

The CLI resolves scope in this order:

1. `--project / -p` and `--env / -E` flags (name or ID)
2. `NIMBUZ_PROJECT` and `NIMBUZ_ENV` environment variables
3. the saved context from `nimbuz use <project> [environment]`
4. automatically when only one exists — or by asking you in an interactive terminal

Names match exactly, case-insensitively, or by a unique prefix (`nimbuz use sho` → `shop-api`).

## 🚀 Apps

Apps are built from Git (GitHub, GitLab, Bitbucket) or a local archive and run as containers.

| Command | What it does |
| --- | --- |
| `nimbuz apps list` | List apps in the environment |
| `nimbuz apps get <app>` | Show an app's configuration |
| `nimbuz apps create [name]` | Create an app from Git or an archive |
| `nimbuz apps update <app>` | Change settings — instance, replicas, autoscale, port… (`scale`) |
| `nimbuz apps redeploy <app>` | Rebuild and redeploy from source |
| `nimbuz apps start \| stop \| restart <app>` | Lifecycle control |
| `nimbuz apps status [app] --watch` | Live rollout and pod status |
| `nimbuz apps releases <app>` | Build / release history |
| `nimbuz apps cancel <app>` | Cancel a running build |
| `nimbuz apps open <app>` | Open the app in a browser |
| `nimbuz apps env list \| set \| unset` | Environment variables |
| `nimbuz apps secrets list \| set \| unset` | Secret variables |
| `nimbuz apps delete <app>` | Delete an app |

```bash
# From Git (owner/repo is GitHub shorthand)
nimbuz apps create shop-api --repo acme/shop-api -b main --port 3000 \
  -i small.m --health /health -e NODE_ENV=production --secret-file .env.secrets --wait

# From a local archive
nimbuz apps create site --archive ./dist.zip --port 80

# Scale and configure (only what you pass is sent)
nimbuz apps update shop-api --instance medium.m --replicas 2
nimbuz apps scale shop-api --autoscale 2:6
nimbuz apps env set shop-api LOG_LEVEL=info --wait
nimbuz apps secrets set shop-api --from-file .env.production
nimbuz apps redeploy shop-api --branch release/2.0 --wait
nimbuz logs shop-api -f
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

Values written as `${VAR}` (or `${VAR:-default}`) are read from your shell, so secrets never need to be committed. Flags override the manifest. Use `-f` for another file: `nimbuz deploy -f deploy/prod.json --env production`.

## 🗄️ Managed tools

Databases and services from the Nimbuz catalog — PostgreSQL, MongoDB, n8n and more — installed and operated for you.

| Command | What it does |
| --- | --- |
| `nimbuz tools catalog [tool]` | Browse installable tools and their settings |
| `nimbuz tools list` | List installed tools |
| `nimbuz tools get <tool>` | Show connection details and values |
| `nimbuz tools install <chart> [name]` | Install a tool (`--set key=value`, `--instance`, `--public`) |
| `nimbuz tools update <tool>` | Change values or visibility |
| `nimbuz tools resize <tool> <instance>` | Change the instance size |
| `nimbuz tools start \| stop <tool>` | Lifecycle control |
| `nimbuz tools delete <tool>` | Uninstall a tool **and delete its data** |

```bash
nimbuz tools catalog postgresql
nimbuz tools install postgresql orders-db --set auth.postgresPassword=change-me
nimbuz tools install mongodb catalog --set mongodb.persistence.size=2Gi --public
nimbuz tools get orders-db           # host, port, credentials
nimbuz tools resize orders-db small.r
```

---

## 🤖 Scripting & CI/CD

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable JSON on **stdout**; progress and spinners go to **stderr**. |
| `-q, --quiet` | Print only names/IDs — `nimbuz apps ls -q \| xargs -n1 nimbuz apps restart` |
| `-y, --yes` | Skip confirmations. Without a TTY, destructive commands require it. |

Set `NIMBUZ_TOKEN` for non-interactive auth, or pipe a password:
`echo "$NIMBUZ_PASSWORD" | nimbuz login --org acme -u ci@acme.com --password-stdin`.

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
| `NIMBUZ_PROJECT` / `NIMBUZ_ENV` | Default project / environment |
| `NIMBUZ_PROFILE` | Config profile (separate accounts side by side) |
| `NIMBUZ_USERNAME` / `NIMBUZ_PASSWORD` | Non-interactive login |
| `NIMBUZ_CONFIG_DIR` | Config directory (default `~/.nimbuz-cli`) |
| `NIMBUZ_DEBUG` | Same as `--debug`: logs HTTP calls (secrets redacted) |
| `NO_COLOR` / `FORCE_COLOR` | Color control |

## 🧩 Also included

Beyond the core workflow, the CLI covers the rest of the portal: `domains` (public endpoints and custom domains), `ai` (model endpoints and API keys), `logs`, `metrics`, `billing`, `team`, `support`, `auth` and `config`. See [`docs/COMMANDS.md`](docs/COMMANDS.md) for every command, argument and flag.

## 🧠 For AI agents & LLMs

- **[`llms.txt`](llms.txt)** — compact, structured summary following the [llms.txt](https://llmstxt.org) convention.
- **[`AGENTS.md`](AGENTS.md)** — how to drive the CLI non-interactively and how to work on this codebase.
- **[`docs/COMMANDS.md`](docs/COMMANDS.md)** — full command reference, generated from source.

Rules of thumb: always pass `--json` and `--yes`, set `NIMBUZ_TOKEN`, select scope with `-p/-E`, and branch on exit codes.

## 🛠️ Development

```text
bin/nimbuz.js          entry point
src/cli.js             command tree, dispatch, error reporting
src/core/              args parser, registry/help, HTTP client, config/profiles, context resolution, output
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
<sub>Made with ☁️ by the <a href="https://nimbuz.tech">Nimbuz</a> team · <a href="https://docs.nimbuz.tech">Docs</a></sub>
</div>
