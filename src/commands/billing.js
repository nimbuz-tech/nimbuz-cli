import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { c } from "../core/colors.js";
import { CliError, UsageError } from "../core/errors.js";
import { ApiClient, unwrap } from "../core/http.js";
import { statusBadge } from "../core/output.js";
import { asArray, formatDate, formatMoney, formatNumber, parseTime } from "../core/util.js";

const ACCOUNT_FLAG = { name: "account", type: "string", placeholder: "id", desc: "Account ID (default: from your session)", hidden: true };

function pricingData(body) {
  // Pricing endpoints use { success, data } (sometimes data.data for lists).
  const data = body?.data ?? body;
  return data?.data && !Array.isArray(data) && Array.isArray(data.data) ? data.data : data;
}

async function scopeFilters(ctx) {
  const filters = {};
  if (ctx.flags.project || ctx.flags.env) {
    const project = await ctx.project();
    filters.project_id = project.id;
    if (ctx.flags.env) filters.environment_id = (await ctx.environment(project)).id;
  }
  return filters;
}

async function invoices(ctx) {
  const query = {
    account_id: ctx.requireAccountId(),
    period: ctx.flags.period,
    type: ctx.flags.type,
    limit: ctx.flags.limit,
    offset: ctx.flags.offset
  };
  const body = await ctx.out.spin("Loading invoices", ctx.api.get("pricing/v1/invoices", { query }));
  const rows = asArray(pricingData(body));
  ctx.out.table(rows, [
    { header: "Invoice", key: "id", format: (v) => c.dim(v) },
    { header: "Period", key: "period" },
    { header: "Type", key: "invoice_type" },
    { header: "Status", key: "status", format: statusBadge },
    { header: "Total", get: (r) => formatMoney(r.total, r.currency) },
    { header: "Local", get: (r) => (r.total_local_currency_amount ? formatMoney(r.total_local_currency_amount, r.localCurrencyCode) : undefined) },
    { header: "Issued", get: (r) => r.issue_date || (r.created_at ? String(r.created_at).slice(0, 10) : undefined) },
    { header: "Due", key: "due_date" },
    { header: "PDF", get: (r) => (r.pdf_generated_at ? "yes" : "") }
  ], { empty: "No invoices yet.", idKey: "id" });
}

async function invoice(ctx) {
  const body = await ctx.out.spin("Loading invoice", ctx.api.get(`pricing/v1/invoices/${ctx.args.invoice}`));
  const data = body?.data ?? body;
  ctx.out.result(data, () => {
    const h = data?.header ?? data;
    ctx.out.kv([
      ["Invoice", c.bold(h.title || h.id)],
      ["ID", h.id],
      ["Period", h.period],
      ["Status", statusBadge(h.status)],
      ["Issued", h.issue_date],
      ["Due", h.due_date],
      ["Subtotal", formatMoney(h.subtotal, h.currency)],
      ["Discount", h.discount_amount ? `-${formatMoney(h.discount_amount, h.currency)}` : undefined],
      ["Credits", h.credit_applied ? `-${formatMoney(h.credit_applied, h.currency)}` : undefined],
      ["Tax", h.tax_amount ? formatMoney(h.tax_amount, h.currency) : undefined],
      ["Total", c.bold(formatMoney(h.total, h.currency))],
      ["Local total", h.total_local_currency_amount ? `${formatMoney(h.total_local_currency_amount, h.localCurrencyCode)} ${c.dim(`@ ${h.conversion_rate}`)}` : undefined]
    ]);
    const lines = asArray(data?.lines);
    if (lines.length) {
      ctx.out.section("Line items");
      ctx.out.table(lines, [
        { header: "Description", get: (l) => l.description || l.type },
        { header: "Instance", key: "instance_type" },
        { header: "Hours", key: "hours", format: (v) => formatNumber(v) },
        { header: "Rate/h", get: (l) => (l.rate_instance_hour !== undefined ? formatMoney(l.rate_instance_hour, data.header?.currency) : undefined) },
        { header: "Storage GB·h", key: "storage_gb_hours", format: (v) => formatNumber(v) },
        { header: "Total", get: (l) => formatMoney(l.total_cost, data.header?.currency) }
      ], { total: false });
    }
    const entries = asArray(data?.financial_entries);
    if (entries.length) {
      ctx.out.section("Adjustments");
      ctx.out.table(entries, [
        { header: "Type", get: (e) => e.type || e.entry_type },
        { header: "Description", get: (e) => e.description || e.reason },
        { header: "Amount", get: (e) => formatMoney(e.amount, data.header?.currency) }
      ], { total: false });
    }
    ctx.out.hint(`\nDownload the PDF: nimbuz billing download ${h.id}`);
  });
}

async function download(ctx) {
  let body;
  try {
    body = await ctx.out.spin("Requesting PDF", ctx.api.get(`pricing/v1/invoices/${ctx.args.invoice}/presign`, { query: { download: true } }));
  } catch (error) {
    if (error.status === 409) throw new CliError("The invoice PDF has not been generated yet. Try again later.");
    throw error;
  }
  const url = body?.url ?? body?.data?.url;
  if (!url) throw new CliError("No download URL returned.");
  if (ctx.flags.url) return ctx.out.write(url);
  const file = ctx.flags.output || `invoice-${ctx.args.invoice}.pdf`;
  // Pre-signed URLs must be fetched without the Authorization header.
  const response = await ctx.out.spin("Downloading", fetch(url));
  if (!response.ok || !response.body) throw new CliError(`Download failed with HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  ctx.out.success(`Saved ${file}`);
}

async function usage(ctx) {
  const query = { account_id: ctx.requireAccountId(), group_by: ctx.flags.groupBy, ...(await scopeFilters(ctx)) };
  const body = await ctx.out.spin("Loading month-to-date usage", ctx.api.get("pricing/v1/costs/mtd", { query }));
  const data = body?.data ?? body;
  const rows = asArray(data?.rows ?? data);
  const names = await nameLookup(ctx, ctx.flags.groupBy, rows);
  ctx.out.result(data, () => {
    ctx.out.write(c.dim(`Month to date · grouped by ${data?.group_by ?? ctx.flags.groupBy}\n`));
    const unlabelled = rows.length > 0 && rows.every((r) => r.group_key === undefined);
    ctx.out.table(rows, [
      { header: ctx.flags.groupBy, get: (r) => (r.group_key === undefined ? c.dim("(not returned)") : names.get(r.group_key) ?? r.group_key) },
      { header: "Uptime h", key: "uptime_hours", format: (v) => formatNumber(v, 1) },
      { header: "Compute", get: (r) => formatMoney(r.cost_instance, r.currency) },
      { header: "Storage GB·h", key: "storage_gb_hours", format: (v) => formatNumber(v, 1) },
      { header: "Storage", get: (r) => formatMoney(r.cost_storage, r.currency) },
      { header: "Total", get: (r) => c.bold(formatMoney(r.total_cost, r.currency)) }
    ], { empty: "No usage this cycle.", total: false });
    const total = rows.reduce((sum, row) => sum + (Number(row.total_cost) || 0), 0);
    if (rows.length) ctx.out.write(`\n${c.dim("Total")} ${c.bold(formatMoney(total, rows[0]?.currency))}`);
    if (unlabelled) ctx.out.hint("The API did not return group keys for these rows (older pricing service).");
  });
}

/** Maps project/environment/deployment IDs to names for nicer output. */
async function nameLookup(ctx, groupBy, rows) {
  const map = new Map();
  try {
    if (groupBy === "project") {
      for (const project of await ctx.listProjects()) map.set(project.id, project.name);
    } else if (groupBy === "environment") {
      for (const project of await ctx.listProjects()) {
        for (const env of await ctx.listEnvironments(project.id)) map.set(env.id, `${project.name}/${env.name}`);
      }
    }
  } catch {
    /* names are best effort */
  }
  void rows;
  return map;
}

async function forecast(ctx) {
  const query = { account_id: ctx.requireAccountId(), group_by: ctx.flags.groupBy, ...(await scopeFilters(ctx)) };
  const body = await ctx.out.spin("Loading forecast", ctx.api.get("pricing/v1/costs/forecast", { query }));
  const data = body?.data ?? body;
  ctx.out.result(data, () => {
    const total = asArray(data?.totals)[0] ?? {};
    const projection = asArray(data?.projection_mtd_rich)[0] ?? {};
    const currency = data?.currency || total.currency || projection.currency;
    const projected = projection.projected_total?.blended ?? projection.projected_total ?? projection.total;
    ctx.out.kv([
      ["Period", data?.period],
      ["Cycle start", data?.cycle_start ? formatDate(data.cycle_start) : undefined],
      ["As of", data?.as_of_hour ? formatDate(data.as_of_hour) : undefined],
      ["Spent so far", formatMoney(total.total_cost, currency)],
      ["Projected", c.bold(formatMoney(typeof projected === "object" ? undefined : projected, currency))]
    ]);
  });
}

async function credits(ctx) {
  const accountId = ctx.requireAccountId();
  const body = await ctx.out.spin("Loading credits", ctx.api.get(`pricing/v1/accounts/${accountId}/credits/available`).catch(() => ctx.api.get(`pricing/v1/accounts/${accountId}/availableCredits`)));
  const data = body?.data ?? body;
  const available = data?.credits?.availableCredit ?? data?.total_available_credit ?? data?.availableCredit ?? data?.available;
  ctx.out.result(data, () => ctx.out.kv([["Available credit", c.bold(formatMoney(available, data?.currency || "USD"))]]));
}

const num = (value) => (value === undefined || value === null || value === "" ? undefined : Number(value));

async function pricing(ctx) {
  const api = new ApiClient({ baseUrl: ctx.apiUrl, debug: ctx.flags.debug });
  const body = await ctx.out.spin("Loading price catalog", api.get("pricing/v1/public/pricing-catalog", { auth: false }));
  let rows = asArray(pricingData(body));
  if (ctx.args.filter) rows = rows.filter((row) => String(row.instanceType ?? row.key).includes(ctx.args.filter));
  rows.sort((a, b) => Number(a.instanceHourRate ?? 0) - Number(b.instanceHourRate ?? 0));
  ctx.out.table(rows, [
    { header: "Instance", get: (r) => r.instanceType || r.key },
    { header: "vCPU", get: (r) => num(r.cpuVcpu ?? r.cpu) },
    { header: "Memory GB", get: (r) => num(r.memoryGb ?? r.memory) },
    { header: "Storage GB", get: (r) => num(r.storageGb) },
    { header: "Per hour", get: (r) => formatMoney(r.instanceHourRate ?? r.price, r.currency) },
    { header: "Per month", get: (r) => formatMoney(r.monthlyInstanceRate ?? Number(r.instanceHourRate ?? 0) * 730, r.currency) }
  ], { idKey: "instanceType" });
  if (!ctx.out.jsonMode) ctx.out.hint("\nMonthly = hourly × 730 h. Use the instance name with --instance.");
}

async function explorer(ctx) {
  const from = parseTime(ctx.flags.from, "--from") ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const to = parseTime(ctx.flags.to, "--to") ?? new Date();
  const filters = await scopeFilters(ctx);
  const query = { accountId: ctx.requireAccountId(), from: from.toISOString(), to: to.toISOString(), projectId: filters.project_id, environmentId: filters.environment_id };
  const body = await ctx.out.spin("Loading cost explorer", ctx.api.get("pricing/v1/costs/costexplorer", { query }));
  const data = body?.data ?? body;
  ctx.out.result(data, () => {
    const rows = asArray(data?.services ?? data?.byService ?? data?.rows ?? data);
    ctx.out.write(c.dim(`${formatDate(from)} → ${formatDate(to)}\n`));
    ctx.out.table(rows, [
      { header: "Service", get: (r) => r.service || r.name || r.type || r.group_key },
      { header: "Cost", get: (r) => formatMoney(r.cost ?? r.total_cost ?? r.amount, r.currency) }
    ], { total: false, empty: "No costs in this range." });
  });
}

const budgetPath = (ctx) => `user/v1/accountBudgets/account-budgets/${ctx.requireAccountId()}`;

async function budgetGet(ctx) {
  let data;
  try {
    data = unwrap(await ctx.out.spin("Loading budget", ctx.api.get(budgetPath(ctx))));
  } catch (error) {
    if (error.status === 404) data = null;
    else throw error;
  }
  ctx.out.result(data, () => {
    if (!data) return ctx.out.write(c.dim("No budget set. Set one with `nimbuz billing budget set --monthly 100`."));
    ctx.out.kv([
      ["Daily budget", data.daily_budget !== undefined && data.daily_budget !== null ? formatMoney(data.daily_budget) : "-"],
      ["Monthly budget", data.monthly_budget !== undefined && data.monthly_budget !== null ? formatMoney(data.monthly_budget) : "-"]
    ]);
  });
}

async function budgetSet(ctx) {
  if (ctx.flags.daily === undefined && ctx.flags.monthly === undefined) throw new UsageError("Pass --daily and/or --monthly.");
  let existing = null;
  try {
    existing = unwrap(await ctx.api.get(budgetPath(ctx)));
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const body = {
    daily_budget: ctx.flags.daily ?? existing?.daily_budget ?? null,
    monthly_budget: ctx.flags.monthly ?? existing?.monthly_budget ?? null
  };
  const hasExisting = existing && (existing.daily_budget != null || existing.monthly_budget != null || existing.id);
  await ctx.out.spin("Saving budget", hasExisting ? ctx.api.put(budgetPath(ctx), body) : ctx.api.post(budgetPath(ctx), body));
  ctx.out.success("Budget saved.");
}

async function budgetDelete(ctx) {
  await ctx.confirm("Remove your account budget?");
  await ctx.out.spin("Removing budget", ctx.api.delete(budgetPath(ctx)));
  ctx.out.success("Budget removed.");
}

const alertsPath = (ctx) => `user/v1/accountNotificationRecipients/account-notification-recipients/${ctx.requireAccountId()}`;

async function alertsList(ctx) {
  const rows = asArray(unwrap(await ctx.out.spin("Loading recipients", ctx.api.get(alertsPath(ctx)))));
  ctx.out.table(rows, [
    { header: "ID", key: "id", format: (v) => c.dim(v) },
    { header: "E-mail", key: "email" },
    { header: "Type", key: "notification_type" }
  ], { empty: "No alert recipients.", idKey: "email" });
}

async function alertsAdd(ctx) {
  await ctx.out.spin("Adding recipient", ctx.api.post(alertsPath(ctx), { email: ctx.args.email, notification_type: "budget_limit_alerts" }));
  ctx.out.success(`${ctx.args.email} will receive budget alerts.`);
}

async function alertsRemove(ctx) {
  const rows = asArray(unwrap(await ctx.api.get(alertsPath(ctx))));
  const match = rows.find((row) => row.id === ctx.args.recipient || row.email === ctx.args.recipient);
  if (!match) throw new UsageError(`No recipient ${ctx.args.recipient}.`);
  await ctx.out.spin("Removing recipient", ctx.api.delete(`user/v1/accountNotificationRecipients/account-notification-recipient/${match.id}`));
  ctx.out.success(`Removed ${match.email}.`);
}

async function limits(ctx) {
  const data = unwrap(await ctx.out.spin("Loading account limits", ctx.api.get(`user/v1/accountLimits/account-limits/${ctx.requireAccountId()}`)));
  ctx.out.result(data, () => {
    const rows = asArray(data);
    if (rows.length) {
      ctx.out.table(rows, [
        { header: "Resource", get: (r) => r.resource_type || r.resource || r.name },
        { header: "Limit", get: (r) => r.limit ?? r.max_limit ?? r.value },
        { header: "Unit", key: "unit" }
      ], { total: false });
    } else {
      ctx.out.kv(Object.entries(data ?? {}).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : value]));
    }
  });
}

const scopeNote = "Filter with --project/--env.";

export const billingCommand = {
  name: "billing",
  aliases: ["bill", "costs"],
  summary: "Invoices, usage, forecasts, budgets and pricing",
  category: "Account",
  commands: [
    {
      name: "invoices",
      aliases: ["ls", "list"],
      summary: "List invoices",
      flags: [
        { name: "period", type: "string", placeholder: "YYYY-MM", desc: "Billing month" },
        { name: "type", type: "string", choices: ["usage", "adhoc"], desc: "Invoice type" },
        { name: "limit", alias: "n", type: "number", default: 20, desc: "Max rows (1-100)" },
        { name: "offset", type: "number", default: 0, desc: "Skip rows" },
        ACCOUNT_FLAG
      ],
      run: invoices
    },
    { name: "invoice", aliases: ["show"], summary: "Show an invoice with line items", args: [{ name: "invoice", required: true, desc: "Invoice ID" }], run: invoice },
    {
      name: "download",
      aliases: ["pdf"],
      summary: "Download an invoice PDF",
      args: [{ name: "invoice", required: true, desc: "Invoice ID" }],
      flags: [
        { name: "output", alias: "o", type: "string", placeholder: "file", desc: "Output file (default: invoice-<id>.pdf)" },
        { name: "url", type: "boolean", desc: "Only print the pre-signed URL" }
      ],
      run: download
    },
    {
      name: "usage",
      aliases: ["mtd"],
      summary: "Month-to-date usage and cost",
      description: `Usage and cost for the current billing cycle. ${scopeNote}`,
      flags: [{ name: "group-by", type: "string", default: "project", choices: ["project", "environment", "deployment"], desc: "Group rows by" }, ACCOUNT_FLAG],
      run: usage
    },
    {
      name: "forecast",
      summary: "Projected end-of-cycle cost",
      description: `Projected cost for the cycle based on recent run rates. ${scopeNote}`,
      flags: [{ name: "group-by", type: "string", default: "none", choices: ["none", "project", "environment", "deployment"], desc: "Group by" }, ACCOUNT_FLAG],
      run: forecast
    },
    {
      name: "explorer",
      summary: "Cost by service over a date range",
      flags: [
        { name: "from", type: "string", placeholder: "date", desc: "Start (default: start of month)" },
        { name: "to", type: "string", placeholder: "date", desc: "End (default: now)" },
        ACCOUNT_FLAG
      ],
      run: explorer
    },
    { name: "credits", summary: "Show available credit", flags: [ACCOUNT_FLAG], run: credits },
    { name: "limits", summary: "Show account resource limits", flags: [ACCOUNT_FLAG], run: limits },
    { name: "pricing", aliases: ["prices", "instances"], summary: "Instance types and hourly prices (no login needed)", args: [{ name: "filter", desc: "Only instance types containing this text" }], run: pricing },
    {
      name: "budget",
      summary: "Daily/monthly spending budget",
      commands: [
        { name: "get", aliases: ["show"], summary: "Show the budget", run: budgetGet },
        {
          name: "set",
          summary: "Set the budget",
          flags: [
            { name: "daily", type: "number", placeholder: "USD", desc: "Daily budget" },
            { name: "monthly", type: "number", placeholder: "USD", desc: "Monthly budget" }
          ],
          examples: ["nimbuz billing budget set --monthly 200 --daily 10"],
          run: budgetSet
        },
        { name: "delete", aliases: ["rm"], summary: "Remove the budget", run: budgetDelete }
      ],
      run: budgetGet
    },
    {
      name: "alerts",
      summary: "Budget alert e-mail recipients",
      commands: [
        { name: "list", aliases: ["ls"], summary: "List recipients", run: alertsList },
        { name: "add", summary: "Add a recipient", args: [{ name: "email", required: true }], run: alertsAdd },
        { name: "remove", aliases: ["rm"], summary: "Remove a recipient", args: [{ name: "recipient", required: true, desc: "E-mail or ID" }], run: alertsRemove }
      ],
      run: alertsList
    }
  ]
};
