import { readFileSync } from "node:fs";

import { parseArgs } from "./core/args.js";
import { c, setColorEnabled } from "./core/colors.js";
import { Context } from "./core/context.js";
import { CancelledError, CliError, EXIT, UsageError } from "./core/errors.js";
import { bindArgs, commandFlags, renderHelp, route, unknownCommandError } from "./core/registry.js";

import { aiCommand } from "./commands/ai.js";
import { apiCommand } from "./commands/api.js";
import { appsCommand } from "./commands/apps.js";
import { authCommand, loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { billingCommand } from "./commands/billing.js";
import { completionCommand } from "./commands/completion.js";
import { configCommand, contextCommand, useCommand } from "./commands/config.js";
import { cronCommand } from "./commands/cron.js";
import { deployCommand, initCommand } from "./commands/deploy.js";
import { domainsCommand } from "./commands/domains.js";
import { logsCommand } from "./commands/logs.js";
import { metricsCommand } from "./commands/metrics.js";
import { envsCommand, projectsCommand } from "./commands/projects.js";
import { statusCommand } from "./commands/status.js";
import { supportCommand } from "./commands/support.js";
import { teamCommand } from "./commands/team.js";
import { toolsCommand } from "./commands/tools.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function buildRoot() {
  const root = {
    name: "nimbuz",
    summary: "Deploy and run apps, databases and AI models on Nimbuz Cloud",
    commands: [
      loginCommand,
      logoutCommand,
      whoamiCommand,
      useCommand,
      contextCommand,
      statusCommand,
      initCommand,
      deployCommand,
      projectsCommand,
      envsCommand,
      appsCommand,
      toolsCommand,
      cronCommand,
      domainsCommand,
      aiCommand,
      logsCommand,
      metricsCommand,
      billingCommand,
      teamCommand,
      supportCommand,
      authCommand,
      configCommand,
      apiCommand,
      { name: "version", summary: "Print the CLI version", category: "Advanced", run: async (ctx) => ctx.out.result({ version: VERSION }, () => ctx.out.write(VERSION)) }
    ]
  };
  root.commands.push(...completionCommand(root));
  return root;
}

// Category order on the root help page.
const CATEGORY_ORDER = ["Getting started", "Workspace", "Workloads", "Observability", "Account", "Advanced"];

function sortRoot(root) {
  root.commands.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  return root;
}

function applyColorFlags(argv) {
  if (argv.includes("--no-color")) setColorEnabled(false);
  else if (argv.includes("--color")) setColorEnabled(true);
}

export async function runCli(argv) {
  applyColorFlags(argv);
  const root = sortRoot(buildRoot());

  if (argv[0] === "__complete") {
    const { completeWords } = await import("./commands/completion.js");
    const words = argv.slice(1);
    process.stdout.write(`${completeWords(root, words.length ? words : [""]).join("\n")}\n`);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const { node, path, rest } = route(root, argv);
  const { flags, positionals } = parseArgs(rest, commandFlags(node));

  if (flags.help || (node === root && positionals.length === 0)) {
    process.stdout.write(`${renderHelp(node, path, { version: VERSION })}\n`);
    return;
  }

  if (!node.run) {
    if (positionals.length) throw unknownCommandError(node, positionals[0], path);
    process.stdout.write(`${renderHelp(node, path, { version: VERSION })}\n`);
    return;
  }
  if (node.commands && positionals.length && !node.args?.length) {
    throw unknownCommandError(node, positionals[0], path);
  }

  const args = bindArgs(node, positionals, path);
  const ctx = await Context.create({ flags, args, version: VERSION, command: node.name });
  await node.run(ctx);
}

/** Formats an error for the terminal and returns the exit code. */
export function reportError(error) {
  if (error instanceof CancelledError) {
    process.stderr.write(`${c.dim(error.message)}\n`);
    return error.exitCode;
  }
  if (error instanceof CliError) {
    const prefix = error.status ? c.dim(` (HTTP ${error.status}${error.code ? ` ${error.code}` : ""})`) : "";
    process.stderr.write(`${c.error("✖")} ${error.message}${prefix}\n`);
    for (const detail of error.details ?? []) process.stderr.write(`  ${c.dim("•")} ${detail}\n`);
    if (error.hint) process.stderr.write(`  ${c.dim(error.hint)}\n`);
    if (process.env.NIMBUZ_DEBUG && error.body) process.stderr.write(`${c.dim(JSON.stringify(error.body, null, 2))}\n`);
    return error.exitCode ?? EXIT.ERROR;
  }
  process.stderr.write(`${c.error("✖")} ${error?.message ?? error}\n`);
  if (process.env.NIMBUZ_DEBUG || process.argv.includes("--debug")) process.stderr.write(`${c.dim(error?.stack ?? "")}\n`);
  else process.stderr.write(`  ${c.dim("Re-run with --debug for details.")}\n`);
  return error instanceof UsageError ? EXIT.USAGE : EXIT.ERROR;
}
