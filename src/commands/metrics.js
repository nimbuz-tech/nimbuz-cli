import { c } from "../core/colors.js";
import { unwrap } from "../core/http.js";
import { bar, sparkline } from "../core/output.js";
import { formatBytes, formatMillicores, parseDuration } from "../core/util.js";
import { withAbort } from "../lib/workloads.js";

const TYPES = ["cpu", "memory", "ephemeral"];

function series(ts) {
  const result = ts?.data?.result ?? ts?.result ?? [];
  const first = Array.isArray(result) ? result[0] : null;
  if (first?.values) return first.values.map(([, value]) => Number(value));
  if (first?.value) return [Number(first.value[1])];
  return [];
}

function latest(ts) {
  const values = series(ts);
  return values.length ? values[values.length - 1] : undefined;
}

function fmt(type, value) {
  if (value === undefined || !Number.isFinite(value)) return c.dim("-");
  return type === "cpu" ? formatMillicores(value) : formatBytes(value);
}

function summarize(type, set) {
  const values = series(set?.usageRange ?? set?.usage);
  const request = latest(set?.request);
  const limit = latest(set?.limit);
  const current = values.at(-1);
  const max = values.length ? Math.max(...values) : undefined;
  const avg = values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : undefined;
  return { type, values, current, avg, max, request, limit };
}

function renderSummary(ctx, summary) {
  if (!summary.values.length && summary.limit === undefined) return;
  const label = { cpu: "CPU", memory: "Memory", ephemeral: "Disk", disk: "Disk" }[summary.type] ?? summary.type;
  const ratio = summary.limit ? summary.current / summary.limit : undefined;
  ctx.out.write(`${c.bold(label.padEnd(7))} ${c.cyan(sparkline(summary.values, 48))}`);
  const parts = [
    `now ${c.bold(fmt(summary.type, summary.current))}`,
    `avg ${fmt(summary.type, summary.avg)}`,
    `max ${fmt(summary.type, summary.max)}`,
    `request ${fmt(summary.type, summary.request)}`,
    `limit ${fmt(summary.type, summary.limit)}`
  ];
  ctx.out.write(`        ${parts.join(c.dim("  ·  "))}`);
  if (ratio !== undefined && Number.isFinite(ratio)) ctx.out.write(`        ${bar(ratio, 30)} ${Math.round(ratio * 100)}% of limit`);
  ctx.out.write("");
}

function timeWindow(ctx) {
  const to = new Date();
  const from = new Date(to.getTime() - parseDuration(ctx.flags.since, "--since"));
  const step = ctx.flags.step ?? Math.max(15, Math.round((to - from) / 1000 / 120));
  return { from: from.toISOString(), to: to.toISOString(), step };
}

async function resolveSelector(ctx, scope) {
  const kind = ctx.command;
  if (kind === "app") {
    const app = await ctx.deployment(scope, ctx.args.name);
    return { label: app.name, query: { deploymentId: app.id || app.deploymentId } };
  }
  const tool = await ctx.tool(scope, ctx.args.name);
  return { label: tool.name, query: { toolId: tool.id } };
}

async function workloadMetrics(ctx) {
  const scope = await ctx.scope();
  const selector = await resolveSelector(ctx, scope);
  const types = ctx.flags.type ? [ctx.flags.type] : ["cpu", "memory"];

  if (ctx.flags.live) return live(ctx, "metrics/v1/resources/live", { namespace: scope.environmentId, ...selector.query }, types, selector.label);

  const window = timeWindow(ctx);
  const results = await ctx.out.spin("Loading metrics", () =>
    Promise.all(
      types.map((resourceType) =>
        ctx.api
          .get("metrics/v1/resources", { query: { namespace: scope.environmentId, resourceType, ...selector.query, ...window, cluster: ctx.flags.cluster } })
          .then((body) => ({ resourceType, data: unwrap(body) }))
      )
    )
  );
  if (ctx.out.jsonMode) return ctx.out.json(results);
  ctx.out.write(`${c.bold(selector.label)} ${c.dim(`· last ${ctx.flags.since} · step ${window.step}s`)}\n`);
  for (const { resourceType, data } of results) renderSummary(ctx, summarize(resourceType, data));
}

async function envMetrics(ctx) {
  const scope = await ctx.scope();
  if (ctx.flags.live) {
    return live(ctx, "metrics/v1/namespace/live", { namespace: scope.environmentId, resourceType: ctx.flags.type ?? "all" }, ctx.flags.type ? [ctx.flags.type] : ["cpu", "memory"], scope.environment.name);
  }
  const window = timeWindow(ctx);
  const data = unwrap(await ctx.out.spin("Loading metrics", ctx.api.get("metrics/v1/namespace", { query: { namespace: scope.environmentId, ...window, cluster: ctx.flags.cluster } })));
  if (ctx.out.jsonMode) return ctx.out.json(data);
  ctx.out.write(`${c.bold(`${scope.project.name} / ${scope.environment.name}`)} ${c.dim(`· last ${ctx.flags.since} · step ${window.step}s`)}\n`);
  for (const type of ["cpu", "memory", "disk"]) if (data?.[type]) renderSummary(ctx, summarize(type, data[type]));
}

async function containerMetrics(ctx) {
  const scope = await ctx.scope();
  const window = timeWindow(ctx);
  const data = unwrap(
    await ctx.out.spin("Loading metrics", ctx.api.get("metrics/v1/container", { query: { namespace: scope.environmentId, pod: ctx.args.pod, container: ctx.args.container, ...window, cluster: ctx.flags.cluster } }))
  );
  if (ctx.out.jsonMode) return ctx.out.json(data);
  ctx.out.write(`${c.bold(`${ctx.args.pod}/${ctx.args.container}`)} ${c.dim(`· last ${ctx.flags.since}`)}\n`);
  for (const type of ["cpu", "memory", "disk"]) if (data?.[type]) renderSummary(ctx, summarize(type, data[type]));
}

async function live(ctx, path, baseQuery, types, label) {
  const history = Object.fromEntries(types.map((type) => [type, []]));
  ctx.out.log(c.dim(`Live metrics for ${label} every ${ctx.flags.interval}s — Ctrl+C to stop\n`));
  const streams = (path.includes("namespace") ? [baseQuery.resourceType] : types).map((resourceType) =>
    withAbort((signal) =>
      ctx.api.stream(path, {
        query: { ...baseQuery, resourceType, interval: ctx.flags.interval, cluster: ctx.flags.cluster },
        signal,
        onEvent: ({ data }) => {
          if (!data || typeof data !== "object") return;
          if (ctx.out.jsonMode) {
            process.stdout.write(`${JSON.stringify(data)}\n`);
            return;
          }
          const values = data.values ?? {};
          const entries = values.usage !== undefined ? [[resourceType, values]] : Object.entries(values);
          for (const [type, value] of entries) {
            const key = type === "ephemeral" || type === "disk" ? "ephemeral" : type;
            history[key] ||= [];
            history[key].push(Number(value.usage));
            if (history[key].length > 60) history[key].shift();
            const ratio = value.limit ? value.usage / value.limit : undefined;
            const time = new Date((data.ts ?? Date.now() / 1000) * 1000).toLocaleTimeString();
            ctx.out.write(
              `${c.dim(time)}  ${key.padEnd(9)} ${c.cyan(sparkline(history[key], 24).padEnd(24))}  ${c.bold(fmt(key, Number(value.usage)).padStart(10))}${value.limit ? c.dim(` / ${fmt(key, Number(value.limit))}`) : ""}${ratio !== undefined ? `  ${bar(ratio, 12)}` : ""}`
            );
          }
        }
      })
    )
  );
  await Promise.all(streams);
}

const COMMON = [
  { name: "since", type: "string", default: "1h", placeholder: "1h|6h|7d", desc: "Time window" },
  { name: "step", type: "number", desc: "Resolution in seconds (min 15)" },
  { name: "cluster", type: "string", desc: "Cluster name (usually omit)", hidden: true }
];
const LIVE = [
  { name: "live", alias: "l", type: "boolean", desc: "Stream live values" },
  { name: "interval", type: "number", default: 15, desc: "Seconds between live updates (min 15)" }
];
const TYPE = { name: "type", alias: "t", type: "string", choices: TYPES, desc: "Only one resource type" };

export const metricsCommand = {
  name: "metrics",
  aliases: ["top", "stats"],
  summary: "CPU, memory and storage usage",
  category: "Observability",
  commands: [
    {
      name: "app",
      summary: "Metrics for an app",
      args: [{ name: "name", required: true, desc: "App name" }],
      flags: [...COMMON, TYPE, ...LIVE],
      examples: ["nimbuz metrics app shop-api --since 6h", "nimbuz metrics app shop-api --live"],
      run: (ctx) => workloadMetrics(Object.assign(ctx, { command: "app" }))
    },
    {
      name: "tool",
      summary: "Metrics for a tool",
      args: [{ name: "name", required: true, desc: "Tool name" }],
      flags: [...COMMON, TYPE, ...LIVE],
      run: (ctx) => workloadMetrics(Object.assign(ctx, { command: "tool" }))
    },
    {
      name: "env",
      summary: "Metrics for the whole environment",
      flags: [...COMMON, { ...TYPE, choices: [...TYPES, "all"] }, ...LIVE],
      run: envMetrics
    },
    {
      name: "container",
      summary: "Metrics for a single pod container",
      args: [
        { name: "pod", required: true, desc: "Pod name" },
        { name: "container", required: true, desc: "Container name" }
      ],
      flags: COMMON,
      run: containerMetrics
    }
  ]
};

