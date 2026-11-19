# Changelog

All notable changes to `@nimbuz-tech/cli` are documented here. This project follows [Semantic Versioning](https://semver.org).

## 1.0.0 — 2026-11-19

First public release on npm as `@nimbuz-tech/cli`.

- Full coverage of the Nimbuz Cloud portal: projects, environments, apps, managed tools, cron jobs, domains, AI endpoints, logs, metrics, billing, team and support.
- `nimbuz init` / `nimbuz deploy` with the `nimbuz.json` manifest and `${VAR}` interpolation.
- Scripting-friendly output: `--json`, `--quiet`, `--yes`, stable exit codes.
- Profiles, `NIMBUZ_TOKEN` for CI, shell completion for bash, zsh and fish.
- Zero runtime dependencies; Node.js 18+.
