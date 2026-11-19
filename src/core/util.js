import { readFile } from "node:fs/promises";

import { UsageError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(String(value ?? "").trim());
}

export function isEnvId(value) {
  return /^env-[a-z0-9]+$/i.test(String(value ?? "").trim());
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });
}

/** "15m" | "1h" | "7d" | "30s" | "2w" -> milliseconds. */
export function parseDuration(value, flagName = "duration") {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (!match) {
    throw new UsageError(`Invalid ${flagName} "${value}". Use a value like 30s, 15m, 1h, 7d.`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return amount * factor;
}

/** Parses an ISO date or a relative duration ("1h" = 1 hour ago). */
export function parseTime(value, flagName = "time") {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (text === "now") return new Date();
  if (/^\d+(?:\.\d+)?\s*(ms|s|m|h|d|w)$/i.test(text)) {
    return new Date(Date.now() - parseDuration(text, flagName));
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new UsageError(`Invalid ${flagName} "${value}". Use ISO-8601 (2026-11-05T08:00:00Z) or a relative value (1h).`);
  }
  return date;
}

/** Parses KEY=VALUE pairs into an object. */
export function parseKeyValues(pairs = [], flagName = "value") {
  const result = {};
  for (const pair of pairs) {
    const text = String(pair);
    const index = text.indexOf("=");
    if (index <= 0) {
      throw new UsageError(`Invalid ${flagName} "${text}". Expected KEY=VALUE.`);
    }
    result[text.slice(0, index).trim()] = text.slice(index + 1);
  }
  return result;
}

/** Parses a dotenv file (KEY=VALUE, comments, quotes, `export` prefix). */
export function parseDotenv(content) {
  const result = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    result[match[1]] = value;
  }
  return result;
}

export async function readDotenvFile(path) {
  try {
    return parseDotenv(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new UsageError(`File not found: ${path}`);
    throw error;
  }
}

/** Reads JSON from a literal string, "@file" or "-" (stdin). */
export async function readJsonInput(value) {
  let text = String(value);
  if (text === "-") {
    text = await readStdin();
  } else if (text.startsWith("@")) {
    text = await readFile(text.slice(1), "utf8");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`Invalid JSON: ${error.message}`);
  }
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function formatBytes(bytes, digits = 1) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  let current = Math.abs(value);
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  const sign = value < 0 ? "-" : "";
  return `${sign}${current.toFixed(index === 0 ? 0 : digits)} ${units[index]}`;
}

export function formatMillicores(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1000) return `${(n / 1000).toFixed(2)} vCPU`;
  return `${n.toFixed(n < 10 ? 1 : 0)}m`;
}

export function formatMoney(amount, currency = "USD") {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "-";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: Math.abs(value) < 1 && value !== 0 ? 4 : 2
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

export function relativeTime(value) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return String(value);
  const diff = Date.now() - time;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const units = [
    ["y", 31_536_000_000],
    ["mo", 2_592_000_000],
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000]
  ];
  for (const [label, size] of units) {
    if (abs >= size) {
      const amount = Math.floor(abs / size);
      return future ? `in ${amount}${label}` : `${amount}${label} ago`;
    }
  }
  return "just now";
}

export function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

/** Removes undefined, null, empty-string and empty-object values (shallow). */
export function compact(object) {
  const result = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    result[key] = value;
  }
  return result;
}

/** Deep compact: removes undefined/null values recursively, keeps empty strings. */
export function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue;
      result[key] = prune(item);
    }
    return result;
  }
  return value;
}

export function pick(object, ...keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => (acc == null ? undefined : acc[part]), object);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** Normalizes list-shaped API payloads: arrays, {items}, {data}, id-keyed maps. */
export function asArray(value, ...nestedKeys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of [...nestedKeys, "items", "data", "results", "records", "list"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  const values = Object.values(value);
  if (values.length && values.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    return Object.entries(value).map(([key, item]) => ({ id: key, ...item }));
  }
  return [];
}

export function maskSecret(value, visible = 4) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= visible * 2) return "•".repeat(Math.min(text.length, 8));
  return `${text.slice(0, visible)}${"•".repeat(6)}${text.slice(-visible)}`;
}

export function levenshtein(a, b) {
  const left = String(a);
  const right = String(b);
  const dp = Array.from({ length: left.length + 1 }, (_, i) => [i, ...Array(right.length).fill(0)]);
  for (let j = 1; j <= right.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[left.length][right.length];
}

export function suggest(input, candidates) {
  const value = String(input ?? "").toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = levenshtein(value, String(candidate).toLowerCase());
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore <= Math.max(2, Math.floor(value.length / 3)) ? best : null;
}

export function interpolateEnv(value, source = process.env, context = "value") {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    if (source[name] !== undefined) return source[name];
    if (fallback !== undefined) return fallback;
    throw new UsageError(`Environment variable ${name} is not set (referenced in ${context}).`);
  });
}
