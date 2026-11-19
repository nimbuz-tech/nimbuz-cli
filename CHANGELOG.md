# Changelog

All notable changes to `@nimbuz-tech/cli` are documented here. This project follows [Semantic Versioning](https://semver.org).

## 1.0.1 — 2026-11-19

- Published as `@nimbuz-tech/cli`.
- README, `llms.txt` and the command reference now focus on projects, environments, apps and managed tools.

## 1.0.0 — 2026-11-19

First public release on npm as `@nimbuz-tech/cli`.

- Full coverage of the Nimbuz Cloud portal: projects, environments, apps, managed tools, domains, AI endpoints, logs, metrics, billing, team and support.
- `nimbuz init` / `nimbuz deploy` with the `nimbuz.json` manifest and `${VAR}` interpolation.
- Scripting-friendly output: `--json`, `--quiet`, `--yes`, stable exit codes.
- Profiles and `NIMBUZ_TOKEN` for CI.
- Zero runtime dependencies; Node.js 18+.
