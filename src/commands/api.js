import { UsageError } from "../core/errors.js";
import { parseKeyValues, readJsonInput } from "../core/util.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

async function api(ctx) {
  let [first, second] = [ctx.args.methodOrPath, ctx.args.path];
  let method = ctx.flags.method?.toUpperCase();
  let pathname = first;
  if (METHODS.includes(String(first).toUpperCase()) && second) {
    method = String(first).toUpperCase();
    pathname = second;
  } else if (second) {
    throw new UsageError(`Unexpected argument: ${second}`);
  }

  let body;
  if (ctx.flags.data !== undefined) body = await readJsonInput(ctx.flags.data);
  const fields = parseKeyValues(ctx.flags.field, "--field");
  if (Object.keys(fields).length) {
    body = { ...(body ?? {}), ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, coerce(v)])) };
  }
  method ||= body !== undefined ? "POST" : "GET";

  const query = parseKeyValues(ctx.flags.query, "--query");
  // Placeholders filled from the current context: {projectId} {environmentId} {accountId}
  const PLACEHOLDER = /\{(projectId|environmentId)\}/;
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  if (PLACEHOLDER.test(pathname) || PLACEHOLDER.test(bodyText) || Object.values(query).some((v) => PLACEHOLDER.test(v)) || ctx.flags.scoped) {
    const scope = await ctx.scope();
    const fill = (text) => text.replace(/\{projectId\}/g, scope.projectId).replace(/\{environmentId\}/g, scope.environmentId);
    pathname = fill(pathname);
    for (const key of Object.keys(query)) query[key] = fill(query[key]);
    if (bodyText && PLACEHOLDER.test(bodyText)) body = JSON.parse(fill(bodyText));
    if (ctx.flags.scoped) {
      query.projectId ||= scope.projectId;
      query.environmentId ||= scope.environmentId;
    }
  }
  if (pathname.includes("{accountId}")) pathname = pathname.replace(/\{accountId\}/g, ctx.requireAccountId());
  for (const key of Object.keys(query)) if (query[key].includes("{accountId}")) query[key] = query[key].replace(/\{accountId\}/g, ctx.requireAccountId());
  if (body !== undefined && JSON.stringify(body).includes("{accountId}")) body = JSON.parse(JSON.stringify(body).replace(/\{accountId\}/g, ctx.requireAccountId()));

  const result = await ctx.api.request(method, pathname.replace(/^\/+/, ""), { query, body, auth: !ctx.flags.noAuth });
  if (typeof result === "string") process.stdout.write(`${result}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function coerce(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export const apiCommand = {
  name: "api",
  summary: "Make an authenticated request to any Nimbuz API",
  category: "Advanced",
  description: [
    "Calls the Nimbuz API gateway with your session and prints the JSON response.",
    "Placeholders {projectId}, {environmentId} and {accountId} are filled from the current context."
  ].join("\n"),
  args: [
    { name: "methodOrPath", required: true, desc: "HTTP method or path" },
    { name: "path", desc: "Path when a method is given" }
  ],
  flags: [
    { name: "method", alias: "X", type: "string", desc: "HTTP method" },
    { name: "data", alias: "d", type: "string", placeholder: "json|@file|-", desc: "JSON request body" },
    { name: "field", alias: "F", type: "list", placeholder: "key=value", desc: "Add a body field (repeatable)" },
    { name: "query", alias: "Q", type: "list", placeholder: "key=value", desc: "Add a query parameter (repeatable)" },
    { name: "scoped", type: "boolean", desc: "Add projectId & environmentId query params from the context" },
    { name: "no-auth", type: "boolean", desc: "Send without the Authorization header" }
  ],
  examples: [
    "nimbuz api /project/v1/projects",
    "nimbuz api /deployment/v1/deployments/list --scoped",
    "nimbuz api GET /pricing/v1/invoices -Q account_id={accountId} -Q limit=5",
    "nimbuz api PUT /deployment/v1/deployments/<id> -F action=restart -F projectId={projectId} -F environmentId={environmentId}"
  ],
  run: api
};
