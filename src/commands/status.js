import { c } from "../core/colors.js";
import { unwrap } from "../core/http.js";
import { renderTable, statusBadge } from "../core/output.js";
import { asArray, formatMoney } from "../core/util.js";
import { appStatus, appUrl, withLiveStatus } from "../lib/workloads.js";

async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

async function overview(ctx) {
  const scope = await ctx.scope();
  const accountId = ctx.claims.accountId;
  const [counts, apps, tools, cost] = await ctx.out.spin("Loading overview", () =>
    Promise.all([
      settle(ctx.api.get("deployment/v1/dashboard/status", { query: { projectId: scope.projectId, environmentId: scope.environmentId } }).then(unwrap)),
      settle(ctx.listDeployments(scope).then((apps) => withLiveStatus(ctx, scope, apps))),
      settle(ctx.listTools(scope).then((tools) => withLiveStatus(ctx, scope, tools, "tool"))),
      accountId ? settle(ctx.api.get("pricing/v1/costs/forecast", { query: { account_id: accountId, group_by: "none" } }).then((b) => b?.data ?? b)) : Promise.resolve({ ok: false })
    ])
  );

  const data = {
    project: scope.project,
    environment: scope.environment,
    workloads: counts.ok ? counts.value : null,
    apps: apps.ok ? apps.value : [],
    tools: tools.ok ? tools.value : [],
    forecast: cost.ok ? cost.value : null
  };
  if (ctx.out.jsonMode) return ctx.out.json(data);

  const who = ctx.claims.email || ctx.claims.username || "";
  ctx.out.write(`${c.brand("nimbuz")}  ${c.bold(scope.project.name)} ${c.dim("/")} ${c.bold(scope.environment.name)}  ${c.dim(`${scope.environment.id} · ${who}`)}`);

  if (data.workloads) {
    const w = data.workloads;
    const parts = [
      [c.green("●"), "running", w.running],
      [c.cyan("◐"), "updating", w.updating],
      [c.yellow("○"), "degrading", w.degrading],
      [c.yellow("○"), "stopped", w.stopped],
      [c.gray("○"), "n/a", w.notavailable]
    ].filter(([, , n]) => n);
    ctx.out.write(`${c.dim("Workloads")}  ${parts.map(([dot, label, n]) => `${dot} ${n} ${label}`).join("   ") || c.dim("none")}${w.total !== undefined ? c.dim(`   (${w.total} total)`) : ""}`);
  }

  if (data.forecast) {
    const total = asArray(data.forecast.totals)[0] ?? {};
    const projection = asArray(data.forecast.projection_mtd_rich)[0] ?? {};
    const projected = projection.projected_total?.blended ?? projection.projected_total;
    const currency = data.forecast.currency || total.currency;
    ctx.out.write(`${c.dim("This month")} ${c.bold(formatMoney(total.total_cost, currency))} spent${typeof projected === "number" ? c.dim(` · ~${formatMoney(projected, currency)} projected`) : ""}`);
  }

  ctx.out.write(`\n${c.bold(`Apps (${data.apps.length})`)}`);
  if (data.apps.length) {
    ctx.out.write(renderTable(data.apps, [
      { header: "Name", key: "name" },
      { header: "Status", get: appStatus, format: statusBadge },
      { header: "Instance", key: "application.instanceType" },
      { header: "URL", get: appUrl }
    ]));
  } else ctx.out.write(c.dim("  none — try `nimbuz deploy`"));

  ctx.out.write(`\n${c.bold(`Tools (${data.tools.length})`)}`);
  if (data.tools.length) {
    ctx.out.write(renderTable(data.tools, [
      { header: "Name", key: "name" },
      { header: "Status", get: appStatus, format: statusBadge },
      { header: "Instance", key: "instanceType" },
      { header: "Host", get: (t) => t.publicHost || t.privateHost }
    ]));
  } else ctx.out.write(c.dim("  none — browse `nimbuz tools catalog`"));

  for (const result of [counts, apps, tools]) {
    if (!result.ok && result.error) ctx.out.warn(result.error.message);
  }
}

export const statusCommand = {
  name: "status",
  aliases: ["overview", "dashboard"],
  summary: "Overview of the current environment",
  category: "Getting started",
  run: overview
};
