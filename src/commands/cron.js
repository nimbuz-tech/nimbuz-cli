import { c } from "../core/colors.js";
import { UsageError } from "../core/errors.js";
import { matchByName } from "../core/context.js";
import { unwrap } from "../core/http.js";
import { statusBadge } from "../core/output.js";
import { asArray, parseKeyValues, parseTime, readDotenvFile, relativeTime } from "../core/util.js";
import { normalizeRepo, uploadArchive } from "../lib/spec.js";

const CRON_ARG = { name: "cronjob", required: true, desc: "Cron job name or ID" };

async function listCronjobs(ctx, scope) {
  return ctx.memo(`cron:${scope.environmentId}`, async () =>
    asArray(unwrap(await ctx.api.get("deployment/v1/cronjobs/list", { query: { projectId: scope.projectId, environmentId: scope.environmentId } })), "cronjobs")
  );
}

async function findCronjob(ctx, scope, query) {
  const jobs = await ctx.out.spin("Loading cron jobs", listCronjobs(ctx, scope));
  return matchByName(jobs, query, { kind: "cron job" });
}

async function list(ctx) {
  const scope = await ctx.scope();
  const jobs = await ctx.out.spin("Loading cron jobs", listCronjobs(ctx, scope));
  ctx.out.table(jobs, [
    { header: "Name", key: "name" },
    { header: "Schedule", key: "schedule" },
    { header: "Status", key: "status", format: statusBadge },
    { header: "Last release", key: "releaseStatus", format: statusBadge },
    { header: "ID", key: "id", format: (v) => c.dim(v) },
    { header: "Updated", key: "updatedAt", format: relativeTime }
  ], { empty: "No cron jobs. Create one with `nimbuz cron create`.", idKey: "name" });
}

async function executions(ctx) {
  const scope = await ctx.scope();
  const query = { projectId: scope.projectId, environmentId: scope.environmentId, page: ctx.flags.page, limit: ctx.flags.limit };
  if (ctx.flags.status) query.status = ctx.flags.status.toUpperCase();
  if (ctx.flags.since) query.from = parseTime(ctx.flags.since, "--since").toISOString();
  // The API needs a cron job selector, so without one we query every job and merge.
  const jobs = ctx.args.cronjob ? [await findCronjob(ctx, scope, ctx.args.cronjob)] : await ctx.out.spin("Loading cron jobs", listCronjobs(ctx, scope));
  const results = await ctx.out.spin("Loading executions", () =>
    Promise.all(jobs.map((job) => ctx.api.get("deployment/v1/cronjobs/executions", { query: { ...query, cronjobId: job.id } }).then(unwrap)))
  );
  const data = results.length === 1 ? results[0] : null;
  const rows = results
    .flatMap((result) => asArray(result, "records", "executions"))
    .sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0))
    .slice(0, ctx.flags.limit);
  ctx.out.table(rows, [
    { header: "Cron job", key: "cronjobName" },
    { header: "Job", key: "jobName" },
    { header: "Status", key: "status", format: statusBadge },
    { header: "Started", key: "startedAt", format: relativeTime },
    { header: "Duration", key: "durationSeconds", format: (v) => (v === undefined || v === null ? "" : `${Math.round(v)}s`) }
  ], { empty: "No executions yet." });
  const pagination = data?.pagination;
  if (pagination && !ctx.out.jsonMode && pagination.totalPages > 1) ctx.out.hint(`\nPage ${pagination.page}/${pagination.totalPages} · ${pagination.totalRecords} total (use --page)`);
  if (rows.length && !ctx.out.jsonMode) ctx.out.hint("Logs of a run: nimbuz logs <job-name>");
}

async function create(ctx) {
  const scope = await ctx.scope();
  const { flags } = ctx;
  if (!flags.schedule) throw new UsageError("Missing --schedule.", { hint: 'e.g. --schedule "0 */6 * * *"' });
  let sourceCode;
  if (flags.archive) sourceCode = { type: "file", s3FileKey: await uploadArchive(ctx, scope, flags.archive), folderPath: flags.dir ?? "", dockerFileName: flags.dockerfile ?? "" };
  else if (flags.repo) {
    const { url, branch } = normalizeRepo(flags.repo);
    sourceCode = { type: "vcs", gitUrl: `${url} -b ${flags.branch || branch || "main"}`, folderPath: flags.dir ?? "", dockerFileName: flags.dockerfile ?? "" };
  } else throw new UsageError("No source given.", { hint: "Pass --repo <url> or --archive <file.zip>." });

  let environment = parseKeyValues(flags.envVar, "--env-var");
  if (flags.envFile) environment = { ...(await readDotenvFile(flags.envFile)), ...environment };
  let secret = parseKeyValues(flags.secret, "--secret");
  if (flags.secretFile) secret = { ...(await readDotenvFile(flags.secretFile)), ...secret };

  const body = {
    name: ctx.args.name,
    schedule: flags.schedule,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    sourceCode,
    application: { replicas: "1", instanceType: flags.instance },
    config: { name: "", path: "", data: "" },
    environment,
    secret
  };
  if (flags.paused) body.action = "pause";
  const result = unwrap(await ctx.out.spin(`Creating ${ctx.args.name}`, ctx.api.post("deployment/v1/cronjobs", body)));
  ctx.out.result(result, () => ctx.out.success(`Created cron job ${c.bold(ctx.args.name)} (${flags.schedule}).`));
}

function action(name, verb) {
  return async (ctx) => {
    const scope = await ctx.scope();
    const job = await findCronjob(ctx, scope, ctx.args.cronjob);
    await ctx.out.spin(`${verb} ${job.name}`, ctx.api.put("deployment/v1/cronjobs/action", { projectId: scope.projectId, environmentId: scope.environmentId, cronjobId: job.id, action: name }));
    ctx.out.success(`${c.bold(job.name)} ${name === "start" ? "enabled" : "disabled"}.`);
  };
}

async function remove(ctx) {
  const scope = await ctx.scope();
  const job = await findCronjob(ctx, scope, ctx.args.cronjob);
  await ctx.confirm(`Delete cron job ${job.name}?`, { danger: true });
  await ctx.out.spin(`Deleting ${job.name}`, ctx.api.delete("deployment/v1/cronjobs", { body: { projectId: scope.projectId, environmentId: scope.environmentId, cronjobId: job.id } }));
  ctx.out.success(`Deleted ${job.name}.`);
}

export const cronCommand = {
  name: "cron",
  aliases: ["cronjobs", "cronjob", "jobs"],
  summary: "Scheduled jobs",
  category: "Workloads",
  commands: [
    { name: "list", aliases: ["ls"], summary: "List cron jobs", run: list },
    {
      name: "runs",
      aliases: ["executions", "history"],
      summary: "Show recent executions",
      args: [{ name: "cronjob", desc: "Only this cron job" }],
      flags: [
        { name: "status", type: "string", choices: ["running", "success", "failed", "unknown"], desc: "Filter by status" },
        { name: "since", type: "string", placeholder: "24h", desc: "Only runs after this time" },
        { name: "page", type: "number", default: 1, desc: "Page" },
        { name: "limit", alias: "n", type: "number", default: 50, desc: "Rows per page" }
      ],
      run: executions
    },
    {
      name: "create",
      aliases: ["new"],
      summary: "Create a cron job",
      args: [{ name: "name", required: true, desc: "Cron job name" }],
      flags: [
        { name: "schedule", type: "string", placeholder: "cron", desc: 'Cron expression, e.g. "0 */6 * * *"' },
        { name: "repo", alias: "r", type: "string", placeholder: "url", desc: "Git repository" },
        { name: "branch", alias: "b", type: "string", desc: "Git branch (default: main)" },
        { name: "archive", type: "string", placeholder: "path", desc: "Local .zip/.tar archive" },
        { name: "dir", type: "string", placeholder: "path", desc: "Sub-folder to build" },
        { name: "dockerfile", type: "string", placeholder: "file", desc: "Dockerfile name" },
        { name: "instance", alias: "i", type: "string", default: "nano.m", desc: "Instance type" },
        { name: "env-var", alias: "e", type: "list", placeholder: "KEY=VALUE", desc: "Environment variable (repeatable)" },
        { name: "env-file", type: "string", desc: "Load variables from a .env file" },
        { name: "secret", alias: "s", type: "list", placeholder: "KEY=VALUE", desc: "Secret (repeatable)" },
        { name: "secret-file", type: "string", desc: "Load secrets from a .env file" },
        { name: "paused", type: "boolean", desc: "Create it disabled" }
      ],
      examples: ['nimbuz cron create nightly-report --schedule "0 2 * * *" --repo acme/reports -e REPORT=daily'],
      run: create
    },
    { name: "start", aliases: ["enable", "resume"], summary: "Enable a cron job", args: [CRON_ARG], run: action("start", "Enabling") },
    { name: "stop", aliases: ["disable", "pause"], summary: "Disable a cron job", args: [CRON_ARG], run: action("stop", "Disabling") },
    { name: "delete", aliases: ["rm"], summary: "Delete a cron job", args: [CRON_ARG], run: remove }
  ]
};
