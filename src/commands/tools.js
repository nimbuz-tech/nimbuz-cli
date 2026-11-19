import { c } from "../core/colors.js";
import { CliError, UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { statusBadge } from "../core/output.js";
import { asArray, parseKeyValues, relativeTime } from "../core/util.js";
import { matchByName } from "../core/context.js";
import { appStatus, withLiveStatus } from "../lib/workloads.js";

const TOOL_ARG = { name: "tool", required: true, desc: "Installed tool name" };
const SECRET_KEY = /pass(word)?|secret|token|key/i;

async function catalog(ctx) {
  return ctx.memo("catalog", async () => asArray(unwrap(await ctx.api.get("deployment/v1/tools/supported")), "tools"));
}

async function findCatalogEntry(ctx, query) {
  const entries = await ctx.out.spin("Loading catalog", catalog(ctx));
  const lower = String(query).toLowerCase();
  const byChart = entries.filter((entry) => String(entry.chart).toLowerCase() === lower);
  if (byChart.length) {
    return byChart.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0];
  }
  return matchByName(entries, query, { kind: "catalog tool" });
}

async function catalogDetail(ctx, entry) {
  const detail = unwrap(await ctx.api.get(`deployment/v1/tools/supported/${encodeURIComponent(entry.id)}`).catch(() => entry));
  return { ...entry, ...detail };
}

function schemaFields(schema) {
  if (!schema || typeof schema !== "object") return [];
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : schema;
  return Object.entries(props)
    .filter(([, field]) => field && typeof field === "object" && field.ui !== false)
    .map(([key, field]) => {
      const fallback = field.default ?? field.default_value ?? field.defaultValue;
      return {
        key: field.key || key,
        label: field.label || field.title || field.name,
        help: field.help,
        type: field.type || field.inputType || field.fieldType,
        default: fallback === "" ? undefined : fallback,
        value: field.value,
        append: field.append,
        updatable: field.update,
        resource: field.function === "resource",
        pattern: field.validation?.regex,
        patternMessage: field.validation?.error_message,
        required: Boolean(field.required ?? field.isRequired ?? (field.validation && (fallback === "" || fallback === undefined))),
        options: Array.isArray(field.options) ? field.options.map((o) => (typeof o === "object" ? o.value ?? o.label : o)).join(", ") : undefined
      };
    });
}

/** Catalog descriptions are markdown with literal "\\n"; reduce to one plain sentence. */
function plainSummary(text) {
  const plain = String(text ?? "")
    .replace(/\\n|\n/g, " ")
    .replace(/[#*_`>]+/g, " ")
    .replace(/\bAbout\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = plain.split(" ");
  // Drop a leading repeated title, e.g. "PostgreSQL PostgreSQL is a …".
  if (words.length > 2 && words[0].toLowerCase() === words[1].toLowerCase()) words.shift();
  return words.join(" ");
}

async function listCatalog(ctx) {
  if (ctx.args.tool) return showCatalog(ctx);
  const entries = await ctx.out.spin("Loading catalog", catalog(ctx));
  ctx.out.table(entries, [
    { header: "Name", key: "name" },
    { header: "Chart", key: "chart" },
    { header: "Version", key: "version" },
    { header: "Type", key: "type", format: (v) => (v ? String(v).toLowerCase() : v) },
    { header: "Description", key: "description", format: plainSummary }
  ], { idKey: "chart" });
  if (!ctx.out.jsonMode) ctx.out.hint("\nInstall one: nimbuz tools install <chart> <name>   ·   details: nimbuz tools catalog <chart>");
}

async function showCatalog(ctx) {
  const entry = await catalogDetail(ctx, await findCatalogEntry(ctx, ctx.args.tool));
  ctx.out.result(entry, () => {
    ctx.out.kv([
      ["Name", c.bold(entry.name)],
      ["Chart", entry.chart],
      ["Version", entry.version],
      ["Type", entry.type],
      ["Ports", formatPorts(entry.port)],
      ["Description", plainSummary(entry.description)],
      ["Examples", entry.howToUse ? c.dim("connection snippets available with --json (howToUse)") : undefined]
    ]);
    const fields = schemaFields(entry.schema);
    if (fields.length) {
      ctx.out.section("Configuration (--set key=value)");
      ctx.out.table(fields, [
        { header: "Key", key: "key" },
        { header: "Description", get: (f) => f.label || f.help },
        { header: "Type", key: "type" },
        { header: "Default", key: "default", format: (v, row) => (v === undefined ? undefined : `${typeof v === "object" ? JSON.stringify(v) : v}${row.append && !String(v).endsWith(row.append) ? row.append : ""}`) },
        { header: "Req", key: "required", format: (v) => (v ? c.yellow("yes") : "") },
        { header: "Options", key: "options" }
      ], { total: false });
    }
  });
}

async function listTools(ctx) {
  const scope = await ctx.scope();
  const tools = await ctx.out.spin("Loading tools", async () => withLiveStatus(ctx, scope, await ctx.listTools(scope), "tool"));
  ctx.out.table(tools, [
    { header: "Name", key: "name" },
    { header: "Status", get: appStatus, format: statusBadge },
    { header: "Instance", key: "instanceType" },
    { header: "Private host", key: "privateHost" },
    { header: "Public host", get: (t) => t.customDomains?.[0] || t.publicHost || (t.expose ? "yes" : "") },
    { header: "Created", key: "createdAt", format: relativeTime }
  ], { empty: "No tools installed. Browse the catalog: nimbuz tools catalog", idKey: "name" });
}

async function toolValues(ctx, scope, name) {
  return unwrap(await ctx.api.get("deployment/v1/tools/values", { query: { name, projectId: scope.projectId, environmentId: scope.environmentId } }));
}

/** Installed values come either as `values` or as `schema[key].value`. */
function flatValues(details) {
  if (details?.values && typeof details.values === "object") return details.values;
  const result = {};
  for (const field of schemaFields(details?.schema)) if (field.value !== undefined && field.value !== "") result[field.key] = field.value;
  return result;
}

function formatPorts(ports) {
  if (!Array.isArray(ports)) return ports;
  return ports
    .map((p) => {
      if (typeof p !== "object" || p === null) return String(p);
      const number = p.privatePort ?? p.port ?? p.containerPort ?? p.publicPort;
      return p.name && p.name !== "default" ? `${number} (${p.name})` : String(number);
    })
    .join(", ");
}

async function getTool(ctx) {
  const scope = await ctx.scope();
  const installed = await ctx.tool(scope, ctx.args.tool);
  const [details] = await ctx.out.spin("Loading tool", () => Promise.all([toolValues(ctx, scope, installed.name), withLiveStatus(ctx, scope, [installed], "tool")]));
  const merged = { ...installed, ...details, liveStatus: installed.liveStatus, statusReason: installed.statusReason };
  const resourceField = schemaFields(details?.schema).find((field) => field.resource);
  ctx.out.result(merged, () => {
    const ports = formatPorts(merged.ports);
    ctx.out.kv([
      ["Name", c.bold(merged.name)],
      ["Status", `${statusBadge(appStatus(merged))}${merged.statusReason ? c.dim(`  ${merged.statusReason}`) : ""}`],
      ["Chart", merged.chart ? `${merged.chart} ${c.dim(merged.version ?? "")}` : undefined],
      ["Instance", merged.instanceType || resourceField?.value],
      ["Private host", merged.privateHost ?? merged.serviceName],
      ["Public host", merged.publicHost],
      ["Custom domains", merged.customDomains?.length ? merged.customDomains.join(", ") : undefined],
      ["Ports", ports],
      ["Created", merged.createdAt ? relativeTime(merged.createdAt) : undefined]
    ]);
    const values = flatValues(details);
    const rows = Object.entries(values).map(([key, value]) => ({
      key,
      value: SECRET_KEY.test(key) && !ctx.flags.reveal ? "••••••••" : typeof value === "object" ? JSON.stringify(value) : value
    }));
    if (rows.length) {
      ctx.out.section("Values");
      ctx.out.table(rows, [{ header: "Key", key: "key" }, { header: "Value", key: "value" }], { total: false });
      if (!ctx.flags.reveal && rows.some((r) => SECRET_KEY.test(r.key))) ctx.out.hint("\nSecrets are masked. Use --reveal to show them.");
    }
  });
}

function parseValues(pairs) {
  const values = parseKeyValues(pairs, "--set");
  for (const [key, value] of Object.entries(values)) {
    if (/^(true|false)$/i.test(value)) values[key] = value.toLowerCase() === "true";
    else if (/^-?\d+(\.\d+)?$/.test(value) && !/^0\d/.test(value)) values[key] = Number(value);
  }
  return values;
}

function validateValues(schema, values) {
  const fields = new Map(schemaFields(schema).map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    if (!field) {
      if (fields.size) throw new UsageError(`Unknown setting "${key}".`, { hint: `Available: ${[...fields.keys()].join(", ")}` });
      continue;
    }
    if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
      throw new UsageError(`Invalid ${key}: ${field.patternMessage || `must match ${field.pattern}`}`);
    }
  }
}

async function installTool(ctx) {
  const scope = await ctx.scope();
  const entry = await catalogDetail(ctx, await findCatalogEntry(ctx, ctx.args.chart));
  const name = ctx.args.name;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || name.length > 53) throw new UsageError(`Invalid tool name "${name}". Use lowercase letters, digits and dashes (max 53).`);
  if (entry.chart && name.includes(entry.chart)) {
    throw new UsageError(`The tool name must not contain the chart name "${entry.chart}".`, { hint: `Try e.g. "orders-db" instead of "orders-${entry.chart}".` });
  }
  const values = parseValues(ctx.flags.set);
  validateValues(entry.schema, values);
  const missing = schemaFields(entry.schema).filter((field) => field.required && values[field.key] === undefined && (field.default === undefined || field.default === ""));
  if (missing.length && !ctx.flags.yes && ctx.prompt.isInteractive()) {
    for (const field of missing) {
      values[field.key] = SECRET_KEY.test(field.key) ? await ctx.prompt.password(`${field.label || field.key}:`) : await ctx.prompt.text(`${field.label || field.key}:`);
    }
  } else if (missing.length) {
    throw new UsageError(`Missing required values: ${missing.map((f) => f.key).join(", ")}`, { hint: "Pass them with --set key=value." });
  }
  const body = {
    name,
    chart: entry.chart,
    version: ctx.flags.version || entry.version,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    values,
    exposePublicly: Boolean(ctx.flags.public)
  };
  if (entry.repository) body.repository = entry.repository;
  if (ctx.flags.instance) body.instanceType = ctx.flags.instance;
  const result = await ctx.out.spin(`Installing ${entry.name} as ${name}`, ctx.api.post("deployment/v1/tools", body));
  ctx.out.result(result, () => {
    ctx.out.success(`Installing ${c.bold(name)} (${entry.chart} ${body.version}) in ${scope.environment.name}.`);
    ctx.out.hint(`Check progress: nimbuz tools list  ·  connection details: nimbuz tools get ${name}`);
  });
}

async function updateTool(ctx) {
  const scope = await ctx.scope();
  const installed = await ctx.tool(scope, ctx.args.tool);
  const details = await toolValues(ctx, scope, installed.name);
  const values = parseValues(ctx.flags.set);
  if (!Object.keys(values).length && ctx.flags.public === undefined) throw new UsageError("Nothing to update.", { hint: "Use --set key=value and/or --public / --no-public." });
  const body = {
    name: installed.name,
    chart: details?.chart,
    version: details?.version,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    values
  };
  if (details?.repository) body.repository = details.repository;
  if (ctx.flags.public !== undefined) body.exposePublicly = ctx.flags.public;
  if (!body.chart || !body.version) throw new CliError("Could not determine the tool's chart/version.");
  await ctx.out.spin(`Updating ${installed.name}`, ctx.api.patch("deployment/v1/tools", body));
  ctx.out.success(`Updating ${c.bold(installed.name)}.`);
}

function toolRef(scope, name) {
  return { name, environmentId: scope.environmentId, projectId: scope.projectId };
}

function pauseResume(action, verb) {
  return async (ctx) => {
    const scope = await ctx.scope();
    const installed = await ctx.tool(scope, ctx.args.tool);
    await ctx.out.spin(`${verb} ${installed.name}`, ctx.api.patch("deployment/v1/tools/pause-resume", { ...toolRef(scope, installed.name), action }));
    ctx.out.success(`${c.bold(installed.name)} is ${action === "pause" ? "stopping" : "starting"}.`);
  };
}

async function resizeTool(ctx) {
  const scope = await ctx.scope();
  const installed = await ctx.tool(scope, ctx.args.tool);
  let fields = ctx.flags.field;
  if (!fields.length) {
    const details = await toolValues(ctx, scope, installed.name);
    const fromSchema = schemaFields(details?.schema).filter((field) => field.resource).map((field) => field.key);
    fields = fromSchema.length ? fromSchema : Object.keys(flatValues(details)).filter((key) => /resources$/i.test(key));
    if (!fields.length) {
      throw new UsageError("Could not detect the tool's resource fields.", { hint: "Pass --field <key>, e.g. --field mongodb.primary.resources" });
    }
  }
  const resources = Object.fromEntries(fields.map((field) => [field, ctx.args.instance]));
  await ctx.out.spin(`Resizing ${installed.name}`, ctx.api.patch("deployment/v1/tools/resize", { ...toolRef(scope, installed.name), resources }));
  ctx.out.success(`Resizing ${c.bold(installed.name)} to ${ctx.args.instance} ${c.dim(`(${fields.join(", ")})`)}.`);
}

async function deleteTool(ctx) {
  const scope = await ctx.scope();
  const installed = await ctx.tool(scope, ctx.args.tool);
  await ctx.confirm(`Delete ${installed.name}? Its data volumes are removed permanently.`, { danger: true });
  await ctx.out.spin(`Deleting ${installed.name}`, ctx.api.delete("deployment/v1/tools", { body: toolRef(scope, installed.name) }));
  ctx.out.success(`Deleted ${installed.name}.`);
}

export const toolsCommand = {
  name: "tools",
  aliases: ["tool", "addons", "db"],
  summary: "Managed databases and tools (PostgreSQL, MongoDB, n8n…)",
  category: "Workloads",
  commands: [
    { name: "catalog", aliases: ["available", "browse"], summary: "Browse installable tools", args: [{ name: "tool", desc: "Chart or name for details" }], run: listCatalog },
    { name: "list", aliases: ["ls"], summary: "List installed tools", run: listTools },
    { name: "get", aliases: ["show", "info"], summary: "Show connection details and values", args: [TOOL_ARG], flags: [{ name: "reveal", type: "boolean", desc: "Show secret values" }], run: getTool },
    {
      name: "install",
      aliases: ["create", "add"],
      summary: "Install a tool from the catalog",
      args: [
        { name: "chart", required: true, desc: "Catalog chart, e.g. postgresql, mongodb, n8n" },
        { name: "name", required: true, desc: "Name for the installed tool (must not contain the chart name)" }
      ],
      flags: [
        { name: "set", type: "list", placeholder: "key=value", desc: "Configuration value (repeatable; see `tools catalog <chart>`)" },
        { name: "version", type: "string", desc: "Chart version (default: catalog version)" },
        { name: "instance", alias: "i", type: "string", desc: "Instance type" },
        { name: "public", type: "boolean", desc: "Expose on a public host" }
      ],
      examples: [
        "nimbuz tools install postgresql orders-db --set auth.postgresPassword=change-me",
        "nimbuz tools install mongodb catalog --set mongodb.persistence.size=2Gi --public"
      ],
      run: installTool
    },
    {
      name: "update",
      aliases: ["set", "configure"],
      summary: "Change a tool's values or visibility",
      args: [TOOL_ARG],
      flags: [
        { name: "set", type: "list", placeholder: "key=value", desc: "Value to change (repeatable)" },
        { name: "public", type: "boolean", desc: "Expose publicly (--no-public to hide)" }
      ],
      run: updateTool
    },
    {
      name: "resize",
      summary: "Change a tool's instance size",
      args: [TOOL_ARG, { name: "instance", required: true, desc: "Instance type, e.g. small.r" }],
      flags: [{ name: "field", type: "list", placeholder: "key", desc: "Resource field(s) to resize (auto-detected)" }],
      examples: ["nimbuz tools resize orders-db small.r"],
      run: resizeTool
    },
    { name: "start", aliases: ["resume"], summary: "Start a stopped tool", args: [TOOL_ARG], run: pauseResume("resume", "Starting") },
    { name: "stop", aliases: ["pause"], summary: "Stop a tool (scale to zero)", args: [TOOL_ARG], run: pauseResume("pause", "Stopping") },
    { name: "delete", aliases: ["rm", "uninstall"], summary: "Uninstall a tool and delete its data", args: [TOOL_ARG], run: deleteTool }
  ]
};
