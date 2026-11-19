import { spawn } from "node:child_process";

import { c } from "../core/colors.js";
import { CliError, UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { statusBadge } from "../core/output.js";
import { parseKeyValues, readDotenvFile, relativeTime } from "../core/util.js";
import { APP_FLAGS, buildSpec, createBody, currentSecrets, hasChanges, knownSource, loadManifest, parseGitUrl, updateBody } from "../lib/spec.js";
import { appStatus, appUrl, fetchDeployment, fetchReleases, latestRelease, waitForDeployment, withAbort, withLiveStatus } from "../lib/workloads.js";

const APP_ARG = { name: "app", required: true, desc: "App name or ID" };
const WAIT_FLAG = { name: "wait", alias: "w", type: "boolean", desc: "Wait until the rollout finishes" };

function appColumns() {
  return [
    { header: "Name", key: "name" },
    { header: "Status", get: appStatus, format: statusBadge },
    { header: "Instance", key: "application.instanceType" },
    {
      header: "Replicas",
      get: (app) => (app.hpa?.hpaEnabled ? `${app.hpa.hpaMinReplicas}-${app.hpa.hpaMaxReplicas} (auto)` : app.application?.replicas)
    },
    { header: "URL", get: appUrl },
    { header: "Updated", key: "updatedAt", format: relativeTime }
  ];
}

async function listApps(ctx) {
  const scope = await ctx.scope();
  const apps = await ctx.out.spin("Loading apps", async () => withLiveStatus(ctx, scope, await ctx.listDeployments(scope)));
  if (!ctx.out.jsonMode && !ctx.out.quiet) ctx.out.log(c.dim(`${scope.project.name} / ${scope.environment.name}\n`));
  ctx.out.table(apps, appColumns(), { empty: "No apps in this environment. Deploy one with `nimbuz deploy` or `nimbuz apps create`.", idKey: "name" });
}

function sourceSummary(source) {
  if (!source) return undefined;
  if (source.type === "file") return `archive ${c.dim(source.s3FileKey ?? "")}`;
  const { repo, branch } = parseGitUrl(source.gitUrl);
  const extras = [source.folderPath && `dir ${source.folderPath}`, source.dockerFileName && source.dockerFileName, source.vcsAutoDeploy && "auto-deploy"].filter(Boolean);
  return `${repo ?? "-"}${branch ? c.dim(` @ ${branch}`) : ""}${extras.length ? c.dim(` (${extras.join(", ")})`) : ""}`;
}

async function getApp(ctx) {
  const scope = await ctx.scope();
  const ref = await ctx.deployment(scope, ctx.args.app);
  const app = await ctx.out.spin("Loading app", async () => (await withLiveStatus(ctx, scope, [await fetchDeployment(ctx, scope, ref.id)]))[0]);
  ctx.out.result(app, () => {
    const a = app.application ?? {};
    const vars = Object.keys(app.environment ?? {});
    const secrets = Object.keys(currentSecrets(app));
    ctx.out.kv([
      ["Name", c.bold(app.name)],
      ["ID", app.id],
      ["Status", `${statusBadge(appStatus(app))}${app.statusReason ? c.dim(`  ${app.statusReason}`) : ""}`],
      ["URL", appUrl(app) ? c.underline(appUrl(app)) : undefined],
      ["Custom domains", app.network?.customDomains?.length ? app.network.customDomains.join(", ") : undefined],
      ["Source", sourceSummary(app.sourceCode)],
      ["Instance", a.instanceType],
      ["Replicas", app.hpa?.hpaEnabled ? `autoscale ${app.hpa.hpaMinReplicas}-${app.hpa.hpaMaxReplicas}` : a.replicas],
      ["Port", app.network?.port],
      ["Health check", app.network?.healthEndpoint],
      ["Install", a.installCommand],
      ["Build", a.buildCommand],
      ["Start", a.startCommand],
      ["Storage", a.storage],
      ["Variables", vars.length ? vars.join(", ") : c.dim("none")],
      ["Secrets", secrets.length ? secrets.join(", ") : c.dim("none")],
      ["Environment", `${scope.project.name} / ${scope.environment.name}`],
      ["Created", app.createdAt ? `${app.createdAt} ${c.dim(`(${relativeTime(app.createdAt)})`)}` : undefined],
      ["Updated", app.updatedAt ? `${app.updatedAt} ${c.dim(`(${relativeTime(app.updatedAt)})`)}` : undefined]
    ]);
  });
}

async function createApp(ctx) {
  const manifest = ctx.flags.file ? await loadManifest(ctx.flags.file) : null;
  const name = ctx.args.name || manifest?.name;
  if (!name) throw new UsageError("Missing app name.", { hint: "Usage: nimbuz apps create <name> --repo <url>" });
  if (!/^[a-z0-9-]{3,40}$/.test(name)) throw new UsageError(`Invalid app name "${name}". Use 3-40 lowercase letters, digits or dashes.`);
  if (manifest?.project && !ctx.flags.project) ctx.flags.project = manifest.project;
  if (manifest?.environment && !ctx.flags.env) ctx.flags.env = manifest.environment;
  const scope = await ctx.scope();
  const spec = await buildSpec(ctx.flags, manifest);
  const body = await createBody(ctx, scope, name, spec);
  const app = unwrap(await ctx.out.spin(`Creating ${name}`, ctx.api.post("deployment/v1/deployments", body)));
  ctx.out.success(`Created app ${c.bold(name)} in ${scope.project.name} / ${scope.environment.name}. Build queued.`);
  await finishRollout(ctx, scope, app, name);
}

async function finishRollout(ctx, scope, app, name, { target = "running" } = {}) {
  const id = app?.id || app?.deploymentId;
  if (ctx.flags.wait && id) {
    const final = await waitForDeployment(ctx, scope, id, { label: name, target });
    ctx.out.result(final, () => {
      ctx.out.success(`${c.bold(name)} is ${appStatus(final)}.`);
      if (target === "running" && appUrl(final)) ctx.out.write(`  ${c.underline(appUrl(final))}`);
    });
    return;
  }
  ctx.out.result(app, () => ctx.out.hint(`Follow progress: nimbuz apps status ${name} --watch  ·  build logs: nimbuz logs ${name} --build`));
}

async function updateApp(ctx) {
  const scope = await ctx.scope();
  const ref = await ctx.deployment(scope, ctx.args.app);
  const current = await fetchDeployment(ctx, scope, ref.id);
  const manifest = ctx.flags.file ? await loadManifest(ctx.flags.file) : null;
  const spec = await buildSpec(ctx.flags, manifest);
  const body = await updateBody(ctx, scope, spec, current);
  if (!hasChanges(body)) throw new UsageError("Nothing to update.", { hint: "Pass at least one setting, e.g. --instance medium.m or -e KEY=VALUE." });
  const app = unwrap(await ctx.out.spin(`Updating ${current.name}`, ctx.api.put(`deployment/v1/deployments/${ref.id}`, body)));
  ctx.out.success(`Updated ${c.bold(current.name)}.`);
  await finishRollout(ctx, scope, app ?? current, current.name);
}

async function redeployApp(ctx) {
  const scope = await ctx.scope();
  const ref = await ctx.deployment(scope, ctx.args.app);
  const current = await fetchDeployment(ctx, scope, ref.id);
  const sourceCode = current?.sourceCode;
  if (!sourceCode) throw new CliError("This app has no source configuration to redeploy.");
  const next = { ...sourceCode };
  if (ctx.flags.branch) {
    if (sourceCode.type !== "vcs") throw new UsageError("--branch only applies to Git-based apps.");
    next.gitUrl = `${parseGitUrl(sourceCode.gitUrl).repo} -b ${ctx.flags.branch}`;
  }
  const body = { projectId: scope.projectId, environmentId: scope.environmentId, sourceCode: knownSource({ sourceCode: next }) };
  const app = unwrap(await ctx.out.spin(`Triggering a new build of ${current.name}`, ctx.api.put(`deployment/v1/deployments/${ref.id}`, body)));
  ctx.out.success(`New build started for ${c.bold(current.name)}${ctx.flags.branch ? ` from ${ctx.flags.branch}` : ""}.`);
  await finishRollout(ctx, scope, app ?? current, current.name);
}

function lifecycle(action, verb, done) {
  return async (ctx) => {
    const scope = await ctx.scope();
    const ref = await ctx.deployment(scope, ctx.args.app);
    const app = unwrap(
      await ctx.out.spin(`${verb} ${ref.name}`, ctx.api.put(`deployment/v1/deployments/${ref.id}`, { action, projectId: scope.projectId, environmentId: scope.environmentId }))
    );
    ctx.out.success(`${c.bold(ref.name)} ${done}.`);
    if (ctx.flags.wait) await finishRollout(ctx, scope, app ?? ref, ref.name, { target: action === "pause" ? "stopped" : "running" });
    else if (ctx.out.jsonMode) ctx.out.json(app ?? { id: ref.id, action });
  };
}

async function deleteApp(ctx) {
  const scope = await ctx.scope();
  const ref = await ctx.deployment(scope, ctx.args.app);
  await ctx.confirm(`Delete app ${ref.name} from ${scope.environment.name}? This removes it and its domains.`, { danger: true });
  await ctx.out.spin(`Deleting ${ref.name}`, ctx.api.delete("deployment/v1/deployments", { query: { deploymentId: ref.id, projectId: scope.projectId, environmentId: scope.environmentId } }));
  ctx.out.success(`Deleted ${ref.name}.`);
}

async function statusApps(ctx) {
  const scope = await ctx.scope();
  if (!ctx.flags.watch) {
    if (ctx.args.app) {
      const ref = await ctx.deployment(scope, ctx.args.app);
      const [app] = await withLiveStatus(ctx, scope, [await fetchDeployment(ctx, scope, ref.id)]);
      ctx.out.result({ name: app.name, status: appStatus(app), reason: app.statusReason, recordStatus: app.status }, () =>
        ctx.out.write(`${c.bold(app.name)}  ${statusBadge(appStatus(app))}${app.statusReason ? c.dim(`  ${app.statusReason}`) : ""}`)
      );
      return;
    }
    return listApps(ctx);
  }

  // Live: SSE stream of every deployment in the environment.
  const only = ctx.args.app ? (await ctx.deployment(scope, ctx.args.app)).id : null;
  const seen = new Map();
  ctx.out.log(c.dim(`Watching ${scope.project.name} / ${scope.environment.name} — Ctrl+C to stop\n`));
  await withAbort((signal) =>
    ctx.api.stream("deployment/v1/live/deployment/stream", {
      query: { projectId: scope.projectId, environmentId: scope.environmentId, interval: ctx.flags.interval },
      signal,
      onEvent: ({ data }) => {
        const list = Array.isArray(data?.deployment) ? data.deployment : Array.isArray(data?.deployments) ? data.deployments : Array.isArray(data) ? data : [];
        for (const app of list) {
          const id = app.id || app.deploymentId;
          if (only && id !== only) continue;
          const status = appStatus(app);
          if (seen.get(id) === status) continue;
          seen.set(id, status);
          if (ctx.out.jsonMode) process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), id, name: app.name, status })}\n`);
          else ctx.out.write(`${c.dim(new Date().toLocaleTimeString())}  ${String(app.name).padEnd(24)} ${statusBadge(status)}`);
        }
      }
    })
  );
}

async function releases(ctx) {
  const scope = await ctx.scope();
  const ref = await ctx.deployment(scope, ctx.args.app);
  const list = await ctx.out.spin("Loading releases", fetchReleases(ctx, ref.id));
  const rows = [...list].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0)).slice(0, ctx.flags.limit);
  ctx.out.table(rows, [
    { header: "Release", get: (r) => r.id || r.releaseId },
    { header: "Status", get: (r) => r.status || r.buildStatus, format: statusBadge },
    { header: "Version", get: (r) => r.version || r.commitId || r.commit?.slice?.(0, 8) },
    { header: "Job", key: "jobName" },
    { header: "Created", key: "createdAt", format: relativeTime },
    { header: "Deployed", key: "deployedAt", format: relativeTime }
  ], { empty: "No releases yet.", idKey: "id" });
}

async function cancelBuild(ctx) {
  const scope = await ctx.scope();
  const ref = await ctx.deployment(scope, ctx.args.app);
  const releaseId = ctx.flags.release || (await latestRelease(ctx, ref.id))?.id;
  if (!releaseId) throw new CliError("No release found to cancel.");
  await ctx.out.spin("Cancelling build", ctx.api.put(`deployment/v1/deployments/cancelBuildJob/${ref.id}`, { releaseId }));
  ctx.out.success(`Cancelled build ${releaseId} of ${ref.name}.`);
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

async function openApp(ctx) {
  const scope = await ctx.scope();
  let url;
  if (ctx.args.app) {
    const ref = await ctx.deployment(scope, ctx.args.app);
    const app = await fetchDeployment(ctx, scope, ref.id);
    url = ctx.flags.portal ? `${ctx.portalUrl}/applications/${ref.id}` : appUrl(app);
    if (!url) throw new CliError(`${app.name} has no public URL yet.`, { hint: `Expose it with: nimbuz domains expose ${app.name}` });
  } else {
    url = ctx.portalUrl;
  }
  ctx.out.info(`Opening ${url}`);
  openUrl(url);
}

// ───────────── Variables & secrets ─────────────

function varsCommands(kind) {
  const isSecret = kind === "secret";
  const field = isSecret ? "secret" : "environment";
  const label = isSecret ? "secret" : "variable";
  const read = (app) => (isSecret ? currentSecrets(app) : app.environment ?? {});

  async function list(ctx) {
    const scope = await ctx.scope();
    const ref = await ctx.deployment(scope, ctx.args.app);
    const app = await fetchDeployment(ctx, scope, ref.id);
    const values = read(app);
    if (ctx.out.jsonMode) {
      ctx.out.json(isSecret && !ctx.flags.reveal ? Object.fromEntries(Object.keys(values).map((k) => [k, "********"])) : values);
      return;
    }
    if (ctx.flags.dotenv) {
      for (const [key, value] of Object.entries(values)) ctx.out.write(`${key}=${isSecret && !ctx.flags.reveal ? "********" : JSON.stringify(String(value))}`);
      return;
    }
    const rows = Object.entries(values).map(([key, value]) => ({ key, value: isSecret && !ctx.flags.reveal ? "••••••••" : value }));
    ctx.out.table(rows, [
      { header: "Key", key: "key" },
      { header: "Value", key: "value" }
    ], { empty: `No ${label}s set on ${app.name}.`, total: false });
    if (isSecret && !ctx.flags.reveal && rows.length) ctx.out.hint("\nValues are masked. Use --reveal to show them.");
  }

  async function set(ctx) {
    const scope = await ctx.scope();
    const ref = await ctx.deployment(scope, ctx.args.app);
    const app = await fetchDeployment(ctx, scope, ref.id);
    let incoming = parseKeyValues(ctx.args.pairs, label);
    if (ctx.flags.fromFile) incoming = { ...(await readDotenvFile(ctx.flags.fromFile)), ...incoming };
    if (!Object.keys(incoming).length) throw new UsageError(`Give at least one KEY=VALUE or --from-file.`);
    const next = ctx.flags.replace ? incoming : { ...read(app), ...incoming };
    await ctx.out.spin(`Updating ${label}s`, ctx.api.put(`deployment/v1/deployments/${ref.id}`, { projectId: scope.projectId, environmentId: scope.environmentId, [field]: next }));
    ctx.out.success(`Set ${Object.keys(incoming).join(", ")} on ${c.bold(app.name)}. The app will restart.`);
    if (ctx.flags.wait) await waitForDeployment(ctx, scope, ref.id, { label: app.name });
  }

  async function unset(ctx) {
    const scope = await ctx.scope();
    const ref = await ctx.deployment(scope, ctx.args.app);
    const app = await fetchDeployment(ctx, scope, ref.id);
    const next = { ...read(app) };
    const missing = ctx.args.keys.filter((key) => !(key in next));
    if (missing.length) ctx.out.warn(`Not set: ${missing.join(", ")}`);
    for (const key of ctx.args.keys) delete next[key];
    await ctx.out.spin(`Updating ${label}s`, ctx.api.put(`deployment/v1/deployments/${ref.id}`, { projectId: scope.projectId, environmentId: scope.environmentId, [field]: next }));
    ctx.out.success(`Removed ${ctx.args.keys.join(", ")} from ${c.bold(app.name)}.`);
  }

  return [
    {
      name: "list",
      aliases: ["ls"],
      summary: `List ${label}s`,
      args: [APP_ARG],
      flags: [
        ...(isSecret ? [{ name: "reveal", type: "boolean", desc: "Show secret values" }] : []),
        { name: "dotenv", type: "boolean", desc: "Print as KEY=VALUE lines" }
      ],
      run: list
    },
    {
      name: "set",
      summary: `Add or change ${label}s`,
      args: [APP_ARG, { name: "pairs", variadic: true, desc: "KEY=VALUE pairs" }],
      flags: [
        { name: "from-file", type: "string", placeholder: ".env", desc: "Load from a dotenv file" },
        { name: "replace", type: "boolean", desc: `Replace all ${label}s instead of merging` },
        WAIT_FLAG
      ],
      examples: isSecret
        ? ["nimbuz apps secrets set shop-api DATABASE_URL=postgres://… STRIPE_KEY=sk_live_…"]
        : ["nimbuz apps env set shop-api NODE_ENV=production LOG_LEVEL=info", "nimbuz apps env set shop-api --from-file .env.production"],
      run: set
    },
    { name: "unset", aliases: ["rm"], summary: `Remove ${label}s`, args: [APP_ARG, { name: "keys", variadic: true, required: true, desc: "Keys to remove" }], run: unset }
  ];
}

export const appsCommand = {
  name: "apps",
  aliases: ["app", "deployments", "deployment"],
  summary: "Deploy and manage applications",
  category: "Workloads",
  commands: [
    { name: "list", aliases: ["ls"], summary: "List apps in the environment", run: listApps },
    { name: "get", aliases: ["show", "view", "info"], summary: "Show an app's configuration", args: [APP_ARG], run: getApp },
    {
      name: "create",
      aliases: ["new"],
      summary: "Create an app from Git or an archive",
      args: [{ name: "name", desc: "App name (3-40 lowercase letters, digits, dashes)" }],
      flags: [...APP_FLAGS, WAIT_FLAG],
      examples: [
        "nimbuz apps create shop-api --repo acme/shop-api --branch main --port 3000 --wait",
        "nimbuz apps create web --repo https://gitlab.com/acme/web.git -i small.m --health /health -e NODE_ENV=production",
        "nimbuz apps create site --archive ./dist.zip --port 80",
        "nimbuz apps create worker --repo acme/jobs --autoscale 1:4 --secret-file .env.secrets"
      ],
      run: createApp
    },
    {
      name: "update",
      aliases: ["set", "edit", "scale"],
      summary: "Change an app's settings (triggers a rollout)",
      args: [APP_ARG],
      flags: [...APP_FLAGS, WAIT_FLAG],
      examples: [
        "nimbuz apps update shop-api --instance medium.m --replicas 2",
        "nimbuz apps scale shop-api --autoscale 2:6",
        "nimbuz apps update shop-api --branch release/2.0 --wait"
      ],
      run: updateApp
    },
    {
      name: "redeploy",
      aliases: ["rebuild"],
      summary: "Rebuild and redeploy from source",
      args: [APP_ARG],
      flags: [{ name: "branch", alias: "b", type: "string", desc: "Switch to another branch" }, WAIT_FLAG],
      run: redeployApp
    },
    { name: "start", aliases: ["resume"], summary: "Start a stopped app", args: [APP_ARG], flags: [WAIT_FLAG], run: lifecycle("resume", "Starting", "is starting") },
    { name: "stop", aliases: ["pause"], summary: "Stop an app (scale to zero)", args: [APP_ARG], flags: [WAIT_FLAG], run: lifecycle("pause", "Stopping", "is stopping") },
    { name: "restart", summary: "Restart an app's pods", args: [APP_ARG], flags: [WAIT_FLAG], run: lifecycle("restart", "Restarting", "is restarting") },
    { name: "delete", aliases: ["rm", "destroy"], summary: "Delete an app", args: [APP_ARG], run: deleteApp },
    {
      name: "status",
      aliases: ["ps"],
      summary: "Show status (live with --watch)",
      args: [{ name: "app", desc: "App name (all apps when omitted)" }],
      flags: [
        { name: "watch", alias: "w", type: "boolean", desc: "Stream status changes live" },
        { name: "interval", type: "number", default: 5, desc: "Seconds between updates when watching" }
      ],
      run: statusApps
    },
    { name: "releases", aliases: ["history"], summary: "List builds/releases", args: [APP_ARG], flags: [{ name: "limit", alias: "n", type: "number", default: 20, desc: "Max rows" }], run: releases },
    { name: "cancel", summary: "Cancel a running build", args: [APP_ARG], flags: [{ name: "release", type: "string", desc: "Release ID (default: latest)" }], run: cancelBuild },
    {
      name: "open",
      summary: "Open the app (or the portal) in a browser",
      args: [{ name: "app", desc: "App name (opens the portal when omitted)" }],
      flags: [{ name: "portal", type: "boolean", desc: "Open the app's page in the Nimbuz portal" }],
      run: openApp
    },
    { name: "env", aliases: ["vars"], summary: "Manage environment variables", commands: varsCommands("env") },
    { name: "secrets", aliases: ["secret"], summary: "Manage secret variables", commands: varsCommands("secret") }
  ]
};

export { openUrl };
