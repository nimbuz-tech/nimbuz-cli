import { c } from "../core/colors.js";
import { CliError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { statusBadge, statusClass } from "../core/output.js";
import { sleep } from "../core/util.js";

export function appUrl(app) {
  const domain = app?.network?.customDomains?.[0] || app?.network?.appIngressDomain || app?.appIngressDomain || app?.domain;
  if (!domain) return undefined;
  return /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
}

/** Prefers the status engine's live state over the (often stale) stored status. */
export function appStatus(app) {
  const live = app?.liveStatus;
  if (live && !/^unknown$/i.test(live)) return live;
  return app?.status || app?.releaseStatus || app?.deploymentStatus;
}

/**
 * Reads one snapshot from the status engine stream for the given workloads.
 * Returns Map(id -> {status, reasonCode, statusReason}). Never throws.
 */
export async function liveStatuses(ctx, scope, ids, type = "application") {
  const map = new Map();
  const list = ids.filter(Boolean);
  if (!list.length) return map;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await ctx.api.stream("statusengine/workloads", {
      query: { environmentId: scope.environmentId, workloadIds: list.join(","), type, interval: 5 },
      signal: controller.signal,
      onEvent: ({ data }) => {
        for (const w of Array.isArray(data?.data) ? data.data : []) map.set(w.workloadId || w.deploymentId || w.id, w);
        controller.abort();
      }
    });
  } catch {
    /* live status is best effort */
  } finally {
    clearTimeout(timer);
  }
  return map;
}

/** Annotates workloads in place with liveStatus/statusReason. */
export async function withLiveStatus(ctx, scope, items, type = "application") {
  const live = await liveStatuses(ctx, scope, items.map((item) => item.id || item.deploymentId), type);
  for (const item of items) {
    const entry = live.get(item.id || item.deploymentId);
    if (entry) {
      item.liveStatus = entry.status;
      item.statusReason = entry.statusReason;
      item.reasonCode = entry.reasonCode;
    }
  }
  return items;
}

export async function fetchDeployment(ctx, scope, deploymentId) {
  return unwrap(
    await ctx.api.get("deployment/v1/deployments", {
      query: { deploymentId, projectId: scope.projectId, environmentId: scope.environmentId }
    })
  );
}

export async function fetchReleases(ctx, deploymentId) {
  const body = unwrap(await ctx.api.get(`deployment/v1/deployments/${deploymentId}/releases`));
  const list = body?.releases?.releases ?? body?.releases ?? body;
  return Array.isArray(list) ? list : [];
}

function sortNewestFirst(releases) {
  return [...releases].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
}

export async function latestRelease(ctx, deploymentId) {
  return sortNewestFirst(await fetchReleases(ctx, deploymentId))[0];
}

/**
 * Polls a deployment until it reaches `target` ("running" or "stopped").
 * The first observed state may be stale (the change has not been picked up yet), so a
 * "running"/"failed" result only counts after a progress state or a change from the
 * initial state, or after a grace period with no change at all.
 * Returns the final deployment; throws when it fails.
 */
export async function waitForDeployment(ctx, scope, deploymentId, { timeoutMs = 20 * 60_000, label, target = "running", graceMs = 90_000 } = {}) {
  const started = Date.now();
  let last;
  let initial;
  let sawProgress = false;
  let app;
  const controller = new AbortController();
  const onSigint = () => controller.abort(new CliError("Stopped watching. The deployment continues in the background.", { exitCode: 130 }));
  process.once("SIGINT", onSigint);

  try {
    for (;;) {
      app = await fetchDeployment(ctx, scope, deploymentId);
      const recordStatus = app?.status;
      if (statusClass(recordStatus) === "progress" && !/starting/i.test(recordStatus)) sawProgress = true;
      await withLiveStatus(ctx, scope, [app]);
      // While a build is running the old pods may still report RUNNING; trust the record then.
      const building = /build|queue|pending|initiat/i.test(recordStatus ?? "");
      const status = (building ? recordStatus : appStatus(app)) ?? "unknown";
      const kind = statusClass(status);
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (status !== last) {
        ctx.out.stopSpinner();
        ctx.out.log(`  ${c.dim(`${String(elapsed).padStart(4)}s`)}  ${statusBadge(status)}${app?.statusReason ? c.dim(`  ${app.statusReason}`) : ""}`);
        last = status;
      }
      initial ??= status;
      if (kind === "progress") sawProgress = true;
      const changed = sawProgress || status !== initial;
      const graceOver = Date.now() - started > graceMs;
      const stopped = /^(stopped|paused)$/i.test(status);
      if (kind === "error" && (changed || graceOver)) {
        throw new CliError(`${label ?? app?.name ?? "Deployment"} failed (${status}).`, {
          hint: `See the logs: nimbuz logs ${app?.name ?? deploymentId}  ·  build logs: nimbuz logs ${app?.name ?? deploymentId} --build`
        });
      }
      if (target === "stopped" && stopped) return app;
      if (target === "running" && kind === "ok" && !stopped && (changed || graceOver)) return app;
      if (Date.now() - started > timeoutMs) {
        throw new CliError(`Timed out waiting for ${label ?? "the deployment"} (still ${status}).`, {
          hint: "It may still finish; check with `nimbuz apps status`."
        });
      }
      ctx.out.startSpinner(`${label ?? "Deploying"} · ${status} · ${elapsed}s`);
      await sleep(4000, controller.signal);
    }
  } finally {
    ctx.out.stopSpinner();
    process.removeListener("SIGINT", onSigint);
  }
}

/** Runs fn with Ctrl+C cleanly aborting the returned signal. */
export async function withAbort(fn) {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    return await fn(controller.signal);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
