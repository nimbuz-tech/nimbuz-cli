import { findFlag } from "./args.js";
import { c } from "./colors.js";
import { UsageError } from "./errors.js";
import { suggest } from "./util.js";

/** Flags accepted by every command. */
export const GLOBAL_FLAGS = [
  { name: "project", alias: "p", type: "string", placeholder: "id|name", desc: "Project to use (overrides the current context)" },
  { name: "env", alias: "E", type: "string", placeholder: "id|name", desc: "Environment to use (overrides the current context)" },
  { name: "json", type: "boolean", desc: "Print machine-readable JSON" },
  { name: "quiet", alias: "q", type: "boolean", desc: "Only print essential output (IDs/names)" },
  { name: "yes", alias: "y", type: "boolean", desc: "Skip confirmation prompts" },
  { name: "profile", type: "string", placeholder: "name", desc: "Config profile to use" },
  // Internal: point the CLI at a non-production gateway for development testing.
  { name: "api-url", type: "string", placeholder: "url", desc: "Override the API base URL", hidden: true },
  { name: "no-color", type: "boolean", desc: "Disable colored output", hidden: true },
  { name: "color", type: "boolean", desc: "Force colored output", hidden: true },
  { name: "debug", type: "boolean", desc: "Log HTTP requests to stderr" },
  { name: "help", alias: "h", type: "boolean", desc: "Show help" }
];

export function commandFlags(node) {
  return [...(node.flags ?? []), ...GLOBAL_FLAGS];
}

function matches(node, token) {
  return node.name === token || (node.aliases ?? []).includes(token);
}

export function findChild(node, token) {
  return (node.commands ?? []).find((child) => matches(child, token));
}

/**
 * Walks tokens to find the deepest matching command.
 * Returns { node, path: [nodes], rest: tokens-without-command-words }.
 */
export function route(root, tokens) {
  let node = root;
  const path = [root];
  const rest = [];
  let routing = true;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      rest.push(...tokens.slice(i));
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      rest.push(token);
      // Skip the value of a known string flag so it is not mistaken for a command.
      const match = findFlag(commandFlags(node), token);
      if (match && match.spec.type !== "boolean" && !token.includes("=") && !(token.length > 2 && !token.startsWith("--"))) {
        if (tokens[i + 1] !== undefined) {
          rest.push(tokens[i + 1]);
          i += 1;
        }
      }
      continue;
    }
    if (routing && node.commands) {
      const child = findChild(node, token);
      if (child) {
        node = child;
        path.push(child);
        continue;
      }
    }
    routing = false;
    rest.push(token);
  }
  return { node, path, rest };
}

export function commandPath(path) {
  return path
    .slice(1)
    .map((node) => node.name)
    .join(" ");
}

function usageLine(node, path) {
  const parts = ["nimbuz", commandPath(path)].filter(Boolean);
  if (node.commands && !node.run) parts.push("<command>");
  for (const arg of node.args ?? []) {
    const name = arg.variadic ? `${arg.name}...` : arg.name;
    parts.push(arg.required ? `<${name}>` : `[${name}]`);
  }
  if (commandFlags(node).length) parts.push("[flags]");
  return parts.join(" ");
}

function flagLabel(spec) {
  const short = spec.alias ? `-${spec.alias}, ` : "    ";
  const value = spec.type === "boolean" ? "" : ` <${spec.placeholder || (spec.type === "number" ? "n" : "value")}>`;
  const repeat = spec.type === "list" ? " ..." : "";
  return `${short}--${spec.name}${value}${repeat}`;
}

function renderFlags(specs) {
  const visible = specs.filter((spec) => !spec.hidden);
  const labels = visible.map(flagLabel);
  const width = Math.min(34, Math.max(...labels.map((label) => label.length)));
  return visible
    .map((spec, index) => {
      const label = labels[index];
      const extra = [];
      if (spec.choices) extra.push(`one of: ${spec.choices.join(", ")}`);
      if (spec.default !== undefined && spec.type !== "boolean" && spec.type !== "list") extra.push(`default: ${spec.default}`);
      const desc = `${spec.desc ?? ""}${extra.length ? c.dim(` (${extra.join("; ")})`) : ""}`;
      return label.length > width ? `  ${c.cmd(label)}\n  ${" ".repeat(width)}  ${desc}` : `  ${c.cmd(label.padEnd(width))}  ${desc}`;
    })
    .join("\n");
}

function renderCommandList(commands) {
  const visible = commands.filter((cmd) => !cmd.hidden);
  const width = Math.max(...visible.map((cmd) => cmd.name.length)) + 2;
  return visible
    .map((cmd) => {
      const alias = cmd.aliases?.length ? c.dim(` (${cmd.aliases.join(", ")})`) : "";
      return `  ${c.cmd(cmd.name.padEnd(width))}${cmd.summary ?? ""}${alias}`;
    })
    .join("\n");
}

export function renderHelp(node, path, { version } = {}) {
  const lines = [];
  const isRoot = path.length === 1;
  if (isRoot) {
    lines.push(`${c.brand("nimbuz")} ${c.dim(`v${version}`)}  ${c.dim("—")} ${node.summary}`);
  } else {
    lines.push(node.description || node.summary || "");
  }
  lines.push("", c.heading("USAGE"), `  ${usageLine(node, path)}`);

  if (node.args?.length) {
    lines.push("", c.heading("ARGUMENTS"));
    const width = Math.max(...node.args.map((arg) => arg.name.length)) + 2;
    for (const arg of node.args) {
      lines.push(`  ${c.cmd(arg.name.padEnd(width))}${arg.desc ?? ""}${arg.required ? "" : c.dim(" (optional)")}`);
    }
  }

  if (node.commands?.length) {
    const groups = new Map();
    for (const cmd of node.commands) {
      if (cmd.hidden) continue;
      const key = cmd.category || "COMMANDS";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cmd);
    }
    for (const [title, commands] of groups) {
      lines.push("", c.heading(title.toUpperCase()), renderCommandList(commands));
    }
  }

  if (node.flags?.length) {
    lines.push("", c.heading("FLAGS"), renderFlags(node.flags));
  }
  if (!node.commands || node.run || isRoot) {
    lines.push("", c.heading("GLOBAL FLAGS"), renderFlags(GLOBAL_FLAGS.filter((flag) => isRoot || !["help"].includes(flag.name))));
  }

  if (node.examples?.length) {
    lines.push("", c.heading("EXAMPLES"));
    for (const example of node.examples) {
      if (example.startsWith("#")) lines.push(`  ${c.dim(example)}`);
      else lines.push(`  ${c.dim("$")} ${example}`);
    }
  }

  if (node.commands?.length) {
    const prefix = ["nimbuz", commandPath(path)].filter(Boolean).join(" ");
    lines.push("", c.dim(`Run \`${prefix} <command> --help\` for more information on a command.`));
  }
  if (isRoot) {
    lines.push(c.dim("Docs: https://docs.nimbuz.tech · API reference: https://docs.nimbuz.tech/api"));
  }
  return lines.join("\n");
}

export function unknownCommandError(node, token, path) {
  const names = (node.commands ?? []).flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]);
  const guess = suggest(token, names);
  const prefix = ["nimbuz", commandPath(path)].filter(Boolean).join(" ");
  return new UsageError(`Unknown command: ${prefix} ${token}`, {
    hint: guess ? `Did you mean \`${prefix} ${guess}\`?` : `Run \`${prefix} --help\` to see available commands.`
  });
}

/** Maps positionals onto declared args; validates required/variadic. */
export function bindArgs(node, positionals, path) {
  const result = {};
  const specs = node.args ?? [];
  let index = 0;
  for (const spec of specs) {
    if (spec.variadic) {
      result[spec.name] = positionals.slice(index);
      index = positionals.length;
      if (spec.required && result[spec.name].length === 0) {
        throw new UsageError(`Missing required argument: <${spec.name}>`, { hint: `Usage: ${usageLine(node, path)}` });
      }
      continue;
    }
    const value = positionals[index];
    if (value === undefined && spec.required) {
      throw new UsageError(`Missing required argument: <${spec.name}>`, { hint: `Usage: ${usageLine(node, path)}` });
    }
    result[spec.name] = value;
    index += 1;
  }
  if (index < positionals.length) {
    throw new UsageError(`Unexpected argument: ${positionals[index]}`, { hint: `Usage: ${usageLine(node, path)}` });
  }
  return result;
}
