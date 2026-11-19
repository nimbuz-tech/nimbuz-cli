import { UsageError } from "./errors.js";
import { suggest } from "./util.js";

/**
 * Flag spec: { name, alias?, type: "string"|"boolean"|"number"|"list", desc, placeholder?, default?, choices?, hidden? }
 * Booleans accept --flag, --flag=false and --no-flag. Lists repeat (-e A=1 -e B=2) or take commas (--set a=1,b=2 is NOT split).
 */
export function findFlag(specs, token) {
  if (token.startsWith("--")) {
    const raw = token.slice(2).split("=")[0];
    const direct = specs.find((spec) => spec.name === raw);
    if (direct) return { spec: direct, negated: false };
    if (raw.startsWith("no-")) {
      const negated = specs.find((spec) => spec.name === raw.slice(3) && spec.type === "boolean");
      if (negated) return { spec: negated, negated: true };
    }
    return null;
  }
  const alias = token.slice(1, 2);
  const spec = specs.find((item) => item.alias === alias);
  return spec ? { spec, negated: false } : null;
}

function coerce(spec, value) {
  if (spec.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new UsageError(`--${spec.name} expects a number, got "${value}".`);
    return n;
  }
  if (spec.type === "boolean") {
    const text = String(value).toLowerCase();
    if (["true", "1", "yes", "on"].includes(text)) return true;
    if (["false", "0", "no", "off"].includes(text)) return false;
    throw new UsageError(`--${spec.name} expects true or false, got "${value}".`);
  }
  if (spec.choices && !spec.choices.includes(value)) {
    throw new UsageError(`--${spec.name} must be one of: ${spec.choices.join(", ")} (got "${value}").`);
  }
  return value;
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

/**
 * Parses tokens against flag specs. Returns { flags, positionals }.
 * Flags are keyed by camelCase name.
 */
export function parseArgs(tokens, specs) {
  const flags = {};
  const positionals = [];
  for (const spec of specs) {
    const key = camel(spec.name);
    if (spec.type === "list") flags[key] = spec.default ? [...spec.default] : [];
    else if (spec.default !== undefined) flags[key] = spec.default;
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    const isFlag = token.startsWith("-") && token.length > 1 && !/^-\d/.test(token);
    if (!isFlag) {
      positionals.push(token);
      continue;
    }

    // Short flag clusters: -yq
    if (!token.startsWith("--") && token.length > 2 && !token.includes("=")) {
      const cluster = token.slice(1).split("");
      const allBool = cluster.every((ch) => specs.find((spec) => spec.alias === ch)?.type === "boolean");
      if (allBool) {
        for (const ch of cluster) {
          const spec = specs.find((item) => item.alias === ch);
          flags[camel(spec.name)] = true;
        }
        continue;
      }
    }

    const match = findFlag(specs, token);
    if (!match) {
      const name = token.replace(/^-+/, "").split("=")[0];
      const candidates = specs.filter((spec) => !spec.hidden).map((spec) => spec.name);
      const guess = suggest(name, candidates);
      throw new UsageError(`Unknown flag: ${token.split("=")[0]}`, {
        hint: guess ? `Did you mean --${guess}?` : "Use --help to see available flags."
      });
    }
    const { spec, negated } = match;
    const key = camel(spec.name);
    const eq = token.indexOf("=");
    const inline = token.startsWith("--") && eq >= 0 ? token.slice(eq + 1) : token.startsWith("-") && !token.startsWith("--") && token.length > 2 ? token.slice(2).replace(/^=/, "") : undefined;

    if (spec.type === "boolean") {
      flags[key] = negated ? false : inline !== undefined ? coerce(spec, inline) : true;
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = tokens[i + 1];
      if (next === undefined || (next.startsWith("-") && next.length > 1 && !/^-\d/.test(next) && next !== "-")) {
        throw new UsageError(`--${spec.name} requires a value${spec.placeholder ? ` (${spec.placeholder})` : ""}.`);
      }
      value = next;
      i += 1;
    }

    if (spec.type === "list") {
      flags[key].push(coerce(spec, value));
    } else {
      flags[key] = coerce(spec, value); // last one wins
    }
  }

  return { flags, positionals };
}

export { camel };
