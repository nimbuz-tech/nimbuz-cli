import { c } from "../core/colors.js";
import { CliError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { parseTime, sleep } from "../core/util.js";
import { fetchReleases } from "../lib/workloads.js";

const MAX_PAGE = 300;

function colorize(line) {
  const text = String(line);
  const space = text.indexOf(" ");
  const looksTimestamped = space > 10 && /^\d{4}-\d{2}-\d{2}T/.test(text);
  const ts = looksTimestamped ? text.slice(0, space) : "";
  const message = looksTimestamped ? text.slice(space + 1) : text;
  let body = message;
  if (/\b(error|fatal|panic|exception|err)\b/i.test(message)) body = c.red(message);
  else if (/\b(warn|warning)\b/i.test(message)) body = c.yellow(message);
  else if (/\b(debug|trace)\b/i.test(message)) body = c.dim(message);
  return ts ? `${c.dim(ts)} ${body}` : body;
}

async function fetchPage(ctx, request, page) {
  const data = unwrap(await ctx.api.post("logs/v1/logs", { ...request, page }));
  return { logs: Array.isArray(data?.logs) ? data.logs : [], totalPages: Number(data?.totalPages) || 1, totalItems: data?.totalItems };
}

function lineTime(line) {
  const match = String(line).match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);
  const time = match ? Date.parse(match[1]) : NaN;
  return Number.isNaN(time) ? null : time;
}

/**
 * The docs say pages are oldest-first, but the service returns newest-first.
 * Detect the order from the timestamps so both work.
 */
function isNewestFirst(lines) {
  const times = lines.map(lineTime).filter((t) => t !== null);
  if (times.length < 2) return true;
  return times[0] >= times[times.length - 1];
}

/** Returns the most recent `tail` lines in chronological order. */
async function fetchTail(ctx, request, tail) {
  const first = await fetchPage(ctx, request, 1);
  const newestFirst = isNewestFirst(first.logs);
  const collected = [];
  if (newestFirst) {
    // Page 1 holds the newest lines; walk forward until we have enough.
    for (let page = 1; page <= first.totalPages && collected.length < tail; page += 1) {
      const { logs } = page === 1 ? first : await fetchPage(ctx, request, page);
      collected.push(...logs);
    }
    return collected.slice(0, tail).reverse();
  }
  for (let page = first.totalPages; page >= 1 && collected.length < tail; page -= 1) {
    const { logs } = page === 1 ? first : await fetchPage(ctx, request, page);
    collected.unshift(...logs);
  }
  return collected.slice(-tail);
}

/** Streams every page of the window to onLines in chronological order. */
async function fetchAll(ctx, request, onLines) {
  const first = await fetchPage(ctx, request, 1);
  if (!isNewestFirst(first.logs)) {
    onLines(first.logs);
    for (let page = 2; page <= first.totalPages; page += 1) onLines((await fetchPage(ctx, request, page)).logs);
    return;
  }
  // Newest-first: start from the last (oldest) page and reverse each one.
  for (let page = first.totalPages; page >= 1; page -= 1) {
    const { logs } = page === 1 ? first : await fetchPage(ctx, request, page);
    onLines([...logs].reverse());
  }
}

async function resolveTarget(ctx, scope) {
  const name = ctx.args.name;
  if (!ctx.flags.build && !ctx.flags.release) return { logType: "application", name };

  const app = await ctx.deployment(scope, name);
  const releases = await ctx.out.spin("Loading releases", fetchReleases(ctx, app.id));
  const sorted = [...releases].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
  const release = ctx.flags.release ? sorted.find((r) => r.id === ctx.flags.release || r.releaseId === ctx.flags.release) : sorted[0];
  if (!release) throw new CliError(ctx.flags.release ? `Release ${ctx.flags.release} not found.` : `${app.name} has no builds yet.`);
  const jobName = release.jobName || release.buildJobName || release.job?.name;
  if (!jobName) throw new CliError("This release has no build job logs.");
  if (!ctx.out.jsonMode) ctx.out.log(c.dim(`Build logs for ${app.name} · release ${release.id ?? ""} · ${release.status ?? ""}\n`));
  return { logType: "job", name: jobName };
}

async function logs(ctx) {
  const scope = await ctx.scope();
  const target = await resolveTarget(ctx, scope);
  const tz = ctx.flags.timezone || ctx.config.get("timeZone") || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tail = Math.max(1, ctx.flags.tail);
  const request = {
    environmentId: scope.environmentId,
    logType: target.logType,
    name: target.name,
    limit: Math.min(MAX_PAGE, ctx.flags.all ? MAX_PAGE : tail),
    timeZone: tz
  };
  if (target.logType === "application") {
    if (ctx.flags.from || ctx.flags.to) {
      request.fromTimestamp = (parseTime(ctx.flags.from, "--from") ?? new Date(Date.now() - 3_600_000)).toISOString();
      request.toTimestamp = (parseTime(ctx.flags.to, "--to") ?? new Date()).toISOString();
    } else {
      request.timeRange = ctx.flags.since;
    }
    if (ctx.flags.grep) request.keyword = ctx.flags.grep;
  }

  const print = (lines) => {
    for (const line of lines) {
      if (ctx.out.jsonMode) process.stdout.write(`${JSON.stringify({ line })}\n`);
      else process.stdout.write(`${ctx.flags.raw ? line : colorize(line)}\n`);
    }
  };

  if (ctx.flags.all) {
    await fetchAll(ctx, request, print);
  } else {
    const lines = await ctx.out.spin("Fetching logs", fetchTail(ctx, request, tail));
    if (!lines.length && !ctx.flags.follow) ctx.out.log(c.dim(`No logs for ${target.name} in the last ${request.timeRange ?? "window"}.`));
    print(lines);
  }

  if (!ctx.flags.follow) return;

  // Follow: poll a short trailing window and print unseen lines.
  ctx.out.log(c.dim("— following (Ctrl+C to stop) —"));
  const seen = new Set();
  const remember = (line) => {
    seen.add(line);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
  };
  (await fetchTail(ctx, { ...request, timeRange: "5m", limit: MAX_PAGE }, MAX_PAGE).catch(() => [])).forEach(remember);
  let stop = false;
  process.once("SIGINT", () => {
    stop = true;
    process.exit(0);
  });
  while (!stop) {
    await sleep(ctx.flags.interval * 1000);
    try {
      const fresh = await fetchTail(ctx, { ...request, timeRange: "2m", fromTimestamp: undefined, toTimestamp: undefined, limit: MAX_PAGE }, MAX_PAGE);
      const unseen = fresh.filter((line) => !seen.has(line));
      unseen.forEach(remember);
      print(unseen);
    } catch (error) {
      ctx.out.warn(`Retrying after error: ${error.message}`);
    }
  }
}

export const logsCommand = {
  name: "logs",
  aliases: ["log"],
  summary: "Show app, tool or build logs",
  category: "Observability",
  description: "Prints the most recent log lines of an app or tool. Use --build for the latest build's logs and -f to stream.",
  args: [{ name: "name", required: true, desc: "App or tool name" }],
  flags: [
    { name: "follow", alias: "f", type: "boolean", desc: "Keep streaming new lines" },
    { name: "tail", alias: "n", type: "number", default: 200, desc: "Number of recent lines" },
    { name: "since", type: "string", default: "15m", placeholder: "15m|1h|7d", desc: "Relative time window" },
    { name: "from", type: "string", placeholder: "time", desc: "Window start (ISO or relative, e.g. 2h)" },
    { name: "to", type: "string", placeholder: "time", desc: "Window end (ISO or relative)" },
    { name: "grep", alias: "g", type: "string", placeholder: "text", desc: "Only lines containing this text" },
    { name: "build", alias: "b", type: "boolean", desc: "Show the latest build's logs" },
    { name: "release", type: "string", placeholder: "id", desc: "Show build logs of a specific release" },
    { name: "all", type: "boolean", desc: "Print every page in the window (max 10,000 lines)" },
    { name: "timezone", alias: "z", type: "string", placeholder: "tz", desc: "IANA time zone for timestamps" },
    { name: "interval", type: "number", default: 5, desc: "Seconds between polls with --follow" },
    { name: "raw", type: "boolean", desc: "Don't colorize output" }
  ],
  examples: [
    "nimbuz logs shop-api",
    "nimbuz logs shop-api -f --grep error",
    "nimbuz logs shop-api --since 24h --all > shop-api.log",
    "nimbuz logs shop-api --build",
    "nimbuz logs orders-db --since 1h      # tools work too"
  ],
  run: logs
};
