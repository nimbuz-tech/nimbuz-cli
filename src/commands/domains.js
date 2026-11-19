import { c } from "../core/colors.js";
import { UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { renderKeyValues, statusBadge } from "../core/output.js";
import { asArray, relativeTime } from "../core/util.js";

const APP_ARG = { name: "app", required: true, desc: "App or tool name" };

async function endpoint(ctx, scope, name) {
  return unwrap(await ctx.api.get("deployment/v1/endpoints", { query: { name, projectId: scope.projectId, environmentId: scope.environmentId } }));
}

function printDnsInstructions(ctx, domain) {
  const dns = domain?.dns || domain?.dnsInstructions || domain?.instructions;
  if (!dns) return;
  const lines = [];
  if (dns.cname) lines.push(["CNAME", `${dns.cname.name}  →  ${c.bold(dns.cname.value)}`]);
  if (dns.a) lines.push(["A", `${dns.a.name}  →  ${c.bold((dns.a.values ?? []).join(", "))}`]);
  if (dns.txt) lines.push(["TXT", `${dns.txt.name}  →  ${c.bold(dns.txt.value)}`]);
  if (!lines.length) return;
  ctx.out.write(`\n${c.bold(`DNS records for ${domain.host}`)} ${c.dim("(create one of CNAME or A" + (dns.txt ? ", plus TXT" : "") + ")")}`);
  ctx.out.write(renderKeyValues(lines, { indent: 2 }));
}

async function list(ctx) {
  const scope = await ctx.scope();
  if (!ctx.args.app) {
    const rows = asArray(unwrap(await ctx.out.spin("Loading endpoints", ctx.api.get("deployment/v1/endpoints/list", { query: { projectId: scope.projectId, environmentId: scope.environmentId } }))));
    ctx.out.table(rows, [
      { header: "Name", key: "name" },
      { header: "Kind", get: (r) => (r.deploymentId ? "app" : "tool") },
      { header: "Host", key: "host", format: (v) => (!v || /^https?:\/\/(null|undefined)?$/.test(v) ? c.dim("(no host)") : v) },
      { header: "Status", key: "status", format: statusBadge }
    ], { empty: "No public endpoints in this environment.", idKey: "host" });
    return;
  }
  const data = await ctx.out.spin("Loading domains", endpoint(ctx, scope, ctx.args.app));
  ctx.out.result(data, () => {
    ctx.out.kv([
      ["Default host", data?.host || data?.domain ? c.underline(`https://${data.host || data.domain}`) : c.dim("removed")],
      ["Reachability", data?.status ? statusBadge(data.status) : undefined],
      ["Basic auth", data?.authentication ? `on ${c.dim(`(user ${data.authentication.username})`)}` : "off"]
    ]);
    const domains = data?.domains ?? [];
    ctx.out.section(`Custom domains (${domains.length}/5)`);
    ctx.out.table(domains, [
      { header: "Host", key: "host" },
      { header: "DNS", key: "status", format: statusBadge },
      { header: "Certificate", key: "certStatus", format: statusBadge },
      { header: "Checked", key: "lastCheckedAt", format: relativeTime },
      { header: "Problem", key: "failureReason" }
    ], { empty: "None. Add one with `nimbuz domains add <app> <host>`.", total: false });
    for (const domain of domains) if (String(domain.status).toUpperCase() !== "VERIFIED") printDnsInstructions(ctx, domain);
  });
}

function parseAuth(value) {
  if (!value) return undefined;
  const index = String(value).indexOf(":");
  if (index <= 0) throw new UsageError("--auth expects user:password.");
  return { username: value.slice(0, index), password: value.slice(index + 1) };
}

async function expose(ctx) {
  const scope = await ctx.scope();
  const body = { service: ctx.args.app, environmentId: scope.environmentId, projectId: scope.projectId, customDns: false };
  const auth = parseAuth(ctx.flags.auth);
  if (auth) body.authentication = auth;
  const data = unwrap(await ctx.out.spin("Creating endpoint", ctx.api.post("deployment/v1/endpoints", body)));
  ctx.out.result(data, () => {
    ctx.out.success(`${c.bold(ctx.args.app)} is public at ${c.underline(`https://${data?.host || data?.domain || "…"}`)}`);
    if (auth) ctx.out.hint(`Protected with basic auth (user ${auth.username}).`);
  });
}

async function add(ctx) {
  const scope = await ctx.scope();
  const host = ctx.args.host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const body = { service: ctx.args.app, environmentId: scope.environmentId, projectId: scope.projectId, customDns: true, customDnsHost: host };
  const data = unwrap(await ctx.out.spin(`Adding ${host}`, ctx.api.post("deployment/v1/endpoints", body)));
  ctx.out.result(data, () => {
    ctx.out.success(`Added ${c.bold(host)} to ${ctx.args.app}.`);
    const domain = (data?.domains ?? []).find((d) => d.host === host) ?? data;
    printDnsInstructions(ctx, { host, ...domain });
    ctx.out.hint(`\nAfter updating DNS, run: nimbuz domains verify ${ctx.args.app} ${host}`);
  });
}

async function verify(ctx) {
  const scope = await ctx.scope();
  const body = { name: ctx.args.app, environmentId: scope.environmentId, projectId: scope.projectId };
  if (ctx.args.host) body.customDnsHost = ctx.args.host;
  const data = unwrap(await ctx.out.spin("Checking DNS", ctx.api.post("deployment/v1/endpoints/custom-domain/verify", body)));
  ctx.out.result(data, () => {
    const domains = asArray(data?.domains ?? data);
    if (!domains.length) return ctx.out.success("Check requested.");
    ctx.out.table(domains, [
      { header: "Host", key: "host" },
      { header: "DNS", key: "status", format: statusBadge },
      { header: "Certificate", key: "certStatus", format: statusBadge },
      { header: "Problem", key: "failureReason" }
    ], { total: false });
  });
}

async function remove(ctx) {
  const scope = await ctx.scope();
  const body = { name: ctx.args.app, environmentId: scope.environmentId, projectId: scope.projectId, customDnsHost: ctx.args.host };
  await ctx.confirm(`Remove ${ctx.args.host} from ${ctx.args.app}?`);
  await ctx.out.spin("Removing domain", ctx.api.delete("deployment/v1/endpoints/custom-domain", { body }));
  ctx.out.success(`Removed ${ctx.args.host}.`);
}

async function unexpose(ctx) {
  const scope = await ctx.scope();
  const body = { name: ctx.args.app, environmentId: scope.environmentId, projectId: scope.projectId };
  const all = ctx.flags.all;
  await ctx.confirm(all ? `Remove the public endpoint and all custom domains of ${ctx.args.app}?` : `Remove the default *.nimbuz host of ${ctx.args.app}? Custom domains keep working.`, { danger: all });
  await ctx.out.spin("Removing endpoint", ctx.api.delete(all ? "deployment/v1/endpoints" : "deployment/v1/endpoints/default-domain", { body }));
  ctx.out.success(all ? `${ctx.args.app} is no longer public.` : `Removed the default host of ${ctx.args.app}.`);
}

export const domainsCommand = {
  name: "domains",
  aliases: ["domain", "endpoints"],
  summary: "Public endpoints and custom domains",
  category: "Workloads",
  commands: [
    { name: "list", aliases: ["ls"], summary: "List endpoints, or an app's domains", args: [{ name: "app", desc: "App or tool name" }], run: list },
    {
      name: "expose",
      summary: "Give an app a public *.nimbuz host",
      args: [APP_ARG],
      flags: [{ name: "auth", type: "string", placeholder: "user:password", desc: "Protect with HTTP basic auth" }],
      run: expose
    },
    { name: "add", summary: "Attach a custom domain (max 5)", args: [APP_ARG, { name: "host", required: true, desc: "Domain, e.g. shop.acme.com" }], examples: ["nimbuz domains add shop-api shop.acme.com"], run: add },
    { name: "verify", aliases: ["check"], summary: "Re-check DNS for custom domains now", args: [APP_ARG, { name: "host", desc: "Only this domain" }], run: verify },
    { name: "remove", aliases: ["rm"], summary: "Detach a custom domain", args: [APP_ARG, { name: "host", required: true }], run: remove },
    {
      name: "unexpose",
      summary: "Remove the default host (or everything with --all)",
      args: [APP_ARG],
      flags: [{ name: "all", type: "boolean", desc: "Delete the whole endpoint, including custom domains" }],
      run: unexpose
    }
  ]
};
