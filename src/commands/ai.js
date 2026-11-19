import { c } from "../core/colors.js";
import { matchByName } from "../core/context.js";
import { CliError, UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { renderKeyValues, statusBadge } from "../core/output.js";
import { asArray, formatMoney, formatNumber, parseTime, relativeTime } from "../core/util.js";

const LLM_ARG = { name: "endpoint", required: true, desc: "AI endpoint name or ID" };

function inferenceBase(ctx) {
  return ctx.apiUrl.includes(".dev.") ? "https://ai.dev.nimbuz.tech" : "https://ai.nimbuz.tech";
}

/** The models catalogue may be an array, a provider map, or a JSON string. */
function normalizeModels(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const nested = value.models ?? value.items;
    if (Array.isArray(nested)) return nested;
    return Object.entries(value).flatMap(([provider, models]) =>
      Array.isArray(models) ? models.map((model) => ({ provider, ...(typeof model === "object" ? model : { id: model, name: model }) })) : []
    );
  }
  return [];
}

async function listModels(ctx) {
  const models = normalizeModels(unwrap(await ctx.out.spin("Loading models", ctx.api.get("llmgateway/v1/models"))));
  ctx.out.table(models, [
    { header: "Model ID", get: (m) => m.nimbuzModelId || m.id },
    { header: "Vendor", get: (m) => m.parent || m.provider },
    { header: "Context", get: (m) => m.price?.context || m.contextLength || m.contextWindow },
    { header: "Input", get: (m) => m.price?.input ?? m.inputPricePerMillion ?? m.pricing?.input },
    { header: "Output", get: (m) => m.price?.output ?? m.outputPricePerMillion ?? m.pricing?.output },
    { header: "Status", get: (m) => m.status || (m.isActive === false || m.enabled === false ? "disabled" : m.isActive || m.enabled ? "active" : undefined), format: statusBadge }
  ], { idKey: "id", empty: "No models available." });
  if (!ctx.out.jsonMode) ctx.out.hint("\nPrices are per million tokens. Create an endpoint: nimbuz ai create <name> --model <model-id>");
}

async function llms(ctx) {
  return ctx.memo("llms", async () => asArray(unwrap(await ctx.api.get("llmgateway/v1/llms")), "llms"));
}

async function findLlm(ctx, query) {
  return matchByName(await ctx.out.spin("Loading AI endpoints", llms(ctx)), query, { kind: "AI endpoint" });
}

async function listLlms(ctx) {
  let rows = await ctx.out.spin("Loading AI endpoints", llms(ctx));
  const envId = ctx.flags.project || ctx.flags.env ? (await ctx.scope()).environmentId : null;
  if (envId) rows = rows.filter((row) => !row.envId || row.envId === envId);
  ctx.out.table(rows, [
    { header: "Name", key: "name" },
    { header: "Model", get: (r) => r.nimbuzModelId || r.model },
    { header: "Status", key: "status", format: statusBadge },
    { header: "Key", get: (r) => { const p = r.activeKeyPrefix || r.keyPrefix; return p ? `${p}…` : undefined; } },
    { header: "RPM", get: (r) => r.currentRateLimitPerMinute },
    { header: "Req 7d", get: (r) => r.requests_7d ?? r.requests7d ?? r.usage?.requests },
    { header: "Tokens 7d", get: (r) => r.totalTokens_7d ?? r.tokens7d },
    { header: "Created", key: "createdAt", format: relativeTime }
  ], { idKey: "id", empty: "No AI endpoints. Create one with `nimbuz ai create <name> --model <id>`." });
}

function printKey(ctx, name, data) {
  const apiKey = data?.apiKey;
  ctx.out.result(data, () => {
    if (!apiKey) return;
    ctx.out.write("");
    ctx.out.write(renderKeyValues([
      ["API key", c.bold(apiKey)],
      ["Base URL", inferenceBase(ctx)]
    ], { indent: 2 }));
    ctx.out.write("");
    ctx.out.warn("Copy the key now — it will not be shown again.");
    ctx.out.hint(`\n  curl ${inferenceBase(ctx)}/chat/completions \\\n    -H "Authorization: Bearer $NIMBUZ_AI_KEY" -H "Content-Type: application/json" \\\n    -d '{"model":"${data?.model ?? "<model>"}","messages":[{"role":"user","content":"Hello"}]}'`);
  });
}

async function createLlm(ctx) {
  const scope = await ctx.scope();
  if (!ctx.flags.model) throw new UsageError("Missing --model.", { hint: "List models with `nimbuz ai models`." });
  const body = {
    projectId: scope.projectId,
    envId: scope.environmentId,
    name: ctx.args.name,
    nimbuzModelId: ctx.flags.model,
    createdBy: ctx.claims.userId
  };
  const data = unwrap(await ctx.out.spin("Creating AI endpoint", ctx.api.post("llmgateway/v1/llms", body)));
  ctx.out.success(`Created AI endpoint ${c.bold(ctx.args.name)} for ${ctx.flags.model}.`);
  printKey(ctx, ctx.args.name, { ...data, model: ctx.flags.model });
}

async function rotateKey(ctx) {
  const llm = await findLlm(ctx, ctx.args.endpoint);
  await ctx.confirm(`Rotate the key of ${llm.name}? The current key stops working immediately.`);
  const data = unwrap(await ctx.out.spin("Rotating key", ctx.api.post(`llmgateway/v1/llms/${llm.id}/rotate-key`, {})));
  ctx.out.success(`Rotated the key of ${c.bold(llm.name)}.`);
  printKey(ctx, llm.name, { ...data, model: llm.model });
}

async function revoke(ctx) {
  const llm = await findLlm(ctx, ctx.args.endpoint);
  await ctx.confirm(`Revoke ${llm.name}? Its API keys stop working permanently.`, { danger: true });
  await ctx.out.spin("Revoking", ctx.api.post(`llmgateway/v1/llms/${llm.id}/revoke`, {}));
  ctx.out.success(`Revoked ${llm.name}.`);
}

function activeKey(llm) {
  if (llm.activeKeyId) return { id: llm.activeKeyId };
  const keys = asArray(llm.keys);
  return keys.find((key) => String(key.status ?? "active").toLowerCase() === "active") ?? keys[0];
}

async function rateLimit(ctx) {
  const rpm = Number(ctx.args.rpm);
  if (!Number.isInteger(rpm) || rpm < 1) throw new UsageError("rpm must be a positive whole number.");
  const llm = await findLlm(ctx, ctx.args.endpoint);
  const key = ctx.flags.key ? { id: ctx.flags.key } : activeKey(llm);
  if (!key?.id) throw new CliError(`${llm.name} has no API key to limit.`);
  await ctx.out.spin("Updating rate limit", ctx.api.put(`llmgateway/v1/llms/${llm.id}/keys/${key.id}/rate-limit`, { rateLimitPerMinute: rpm }));
  ctx.out.success(`${c.bold(llm.name)} is limited to ${ctx.args.rpm} requests/minute.`);
}

async function usage(ctx) {
  const llm = await findLlm(ctx, ctx.args.endpoint);
  const query = {
    from: parseTime(ctx.flags.since, "--since")?.toISOString(),
    to: new Date().toISOString(),
    limit: ctx.flags.limit
  };
  const key = ctx.flags.key ? { id: ctx.flags.key } : null;
  const path = key ? `llmgateway/v1/llms/${llm.id}/keys/${key.id}/usage` : `llmgateway/v1/llms/${llm.id}/usage`;
  const data = unwrap(await ctx.out.spin("Loading usage", ctx.api.get(path, { query })));
  ctx.out.result(data, () => {
    const s = data?.summary ?? {};
    ctx.out.write(`${c.bold(llm.name)} ${c.dim(`· since ${ctx.flags.since}`)}\n`);
    ctx.out.kv([
      ["Requests", formatNumber(s.requests ?? s.totalRequests ?? s.count, 0)],
      ["Input tokens", formatNumber(s.inputTokens ?? s.promptTokens ?? s.input_tokens, 0)],
      ["Output tokens", formatNumber(s.outputTokens ?? s.completionTokens ?? s.output_tokens, 0)],
      ["Errors", s.errors ?? s.errorCount],
      ["Cost", s.cost !== undefined || s.totalCost !== undefined ? formatMoney(s.cost ?? s.totalCost, s.currency) : undefined]
    ]);
    const events = asArray(data?.events);
    if (events.length) {
      ctx.out.section("Recent requests");
      ctx.out.table(events, [
        { header: "Time", get: (e) => e.createdAt || e.timestamp, format: relativeTime },
        { header: "Model", key: "model" },
        { header: "Status", get: (e) => e.status ?? e.statusCode },
        { header: "In", get: (e) => e.inputTokens ?? e.promptTokens },
        { header: "Out", get: (e) => e.outputTokens ?? e.completionTokens },
        { header: "Latency", get: (e) => (e.latencyMs !== undefined ? `${e.latencyMs}ms` : undefined) }
      ], { total: false });
    }
  });
}

async function envKey(ctx) {
  const scope = await ctx.scope();
  const data = unwrap(await ctx.out.spin("Creating environment key", ctx.api.post("llmgateway/v1/llms/create-env-key", { envId: scope.environmentId })));
  ctx.out.success(`Created an AI key for ${scope.project.name} / ${scope.environment.name}.`);
  printKey(ctx, scope.environment.name, data);
}

export const aiCommand = {
  name: "ai",
  aliases: ["llm", "models"],
  summary: "AI model endpoints and API keys",
  category: "Workloads",
  commands: [
    { name: "models", aliases: ["catalog"], summary: "List available models", run: listModels },
    { name: "list", aliases: ["ls"], summary: "List AI endpoints", run: listLlms },
    {
      name: "create",
      aliases: ["new"],
      summary: "Create an endpoint and API key for a model",
      args: [{ name: "name", required: true, desc: "Endpoint name" }],
      flags: [{ name: "model", alias: "m", type: "string", placeholder: "id", desc: "Model ID from `nimbuz ai models`" }],
      examples: ["nimbuz ai create chatbot --model nimbuz-gpt-oss-20b"],
      run: createLlm
    },
    { name: "rotate-key", aliases: ["rotate"], summary: "Issue a new API key", args: [LLM_ARG], run: rotateKey },
    {
      name: "rate-limit",
      summary: "Set requests per minute for an endpoint key",
      args: [LLM_ARG, { name: "rpm", required: true, desc: "Requests per minute" }],
      flags: [{ name: "key", type: "string", desc: "Key ID (default: active key)" }],
      run: rateLimit
    },
    {
      name: "usage",
      summary: "Token usage and recent requests",
      args: [LLM_ARG],
      flags: [
        { name: "since", type: "string", default: "7d", desc: "Window" },
        { name: "limit", alias: "n", type: "number", default: 20, desc: "Recent events to show (max 200)" },
        { name: "key", type: "string", desc: "Only this key ID" }
      ],
      run: usage
    },
    { name: "revoke", aliases: ["delete", "rm"], summary: "Revoke an endpoint", args: [LLM_ARG], run: revoke },
    { name: "env-key", summary: "Create an API key for the whole environment", run: envKey }
  ]
};
