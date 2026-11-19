import { c } from "../core/colors.js";
import { UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { bar } from "../core/output.js";
import { relativeTime } from "../core/util.js";

export const NAME_RULE = (value) =>
  /^[a-zA-Z0-9-]{3,50}$/.test(value) ? null : "Use 3-50 letters, digits or dashes.";

function validateName(value, kind) {
  const problem = NAME_RULE(value);
  if (problem) throw new UsageError(`Invalid ${kind} name "${value}": ${problem}`);
}

function defaultRegion(ctx) {
  return ctx.flags.region || ctx.config.get("region") || "ap-south-1";
}

// ───────────── Projects ─────────────

async function listProjects(ctx) {
  const projects = await ctx.out.spin("Loading projects", ctx.listProjects());
  const current = ctx.config.get("project")?.id;
  ctx.out.table(
    projects,
    [
      ...(projects.some((p) => p.id === current) ? [{ header: "", get: (p) => (p.id === current ? c.green("*") : " "), flex: false }] : []),
      { header: "Name", key: "name" },
      { header: "ID", key: "id", format: (v) => c.dim(v) },
      ...(projects.some((p) => p.description) ? [{ header: "Description", key: "description" }] : []),
      ...(projects.some((p) => p.createdAt) ? [{ header: "Created", key: "createdAt", format: relativeTime }] : [])
    ],
    { empty: "No projects yet. Create one with `nimbuz projects create <name>`.", idKey: "id" }
  );
}

async function getProject(ctx) {
  const ref = await ctx.project({ input: ctx.args.project });
  const [project, envs] = await ctx.out.spin("Loading project", () =>
    Promise.all([
      ctx.api.get(`project/v1/projects/${ref.id}`).then(unwrap),
      ctx.listEnvironments(ref.id).catch(() => [])
    ])
  );
  const providers = ["github", "gitlab", "bitbucket"].filter((key) => project?.[key] && (project[key] === true || Object.keys(project[key] || {}).length));
  ctx.out.result({ ...project, environments: envs }, () => {
    ctx.out.kv([
      ["Name", c.bold(project.name)],
      ["ID", project.id],
      ["Description", project.description],
      ["Git providers", providers.length ? providers.join(", ") : c.dim("none connected")],
      ["Created", project.createdAt ? `${project.createdAt} ${c.dim(`(${relativeTime(project.createdAt)})`)}` : undefined]
    ]);
    ctx.out.section(`Environments (${envs.length})`);
    ctx.out.table(envs, [
      { header: "Name", key: "name" },
      { header: "ID", key: "id" },
      { header: "Region", key: "region" },
      { header: "Status", key: "status" }
    ], { total: false, empty: "No environments." });
  });
}

async function createProject(ctx) {
  const interactive = ctx.prompt.isInteractive();
  const name = ctx.args.name || (await ctx.prompt.text("Project name:", { validate: NAME_RULE }));
  validateName(name, "project");
  const envName = ctx.flags.envName || (interactive && !ctx.flags.yes ? await ctx.prompt.text("First environment name:", { default: "production", validate: NAME_RULE }) : "production");
  const body = {
    name,
    description: ctx.flags.description ?? "",
    envName,
    region: defaultRegion(ctx)
  };
  const project = unwrap(await ctx.out.spin("Creating project", ctx.api.post("project/v1/projects", body)));
  if (ctx.flags.use && project?.id) {
    ctx.config.set("project", { id: project.id, name: project.name });
    if (project.environment?.id) ctx.config.set("environment", { id: project.environment.id, name: project.environment.name, region: project.environment.region });
    await ctx.config.save();
  }
  ctx.out.result(project, () => {
    ctx.out.success(`Created project ${c.bold(project.name)} ${c.dim(project.id)}`);
    if (project.environment) ctx.out.success(`Created environment ${c.bold(project.environment.name)} ${c.dim(project.environment.id)}`);
    if (ctx.flags.use) ctx.out.hint("Set as current context.");
    else ctx.out.hint(`Next: nimbuz use ${project.name}`);
  });
}

async function updateProject(ctx) {
  const ref = await ctx.project({ input: ctx.args.project });
  const current = unwrap(await ctx.api.get(`project/v1/projects/${ref.id}`));
  const body = {
    name: ctx.flags.name ?? current.name,
    description: ctx.flags.description ?? current.description ?? ""
  };
  validateName(body.name, "project");
  const updated = unwrap(await ctx.out.spin("Updating project", ctx.api.patch(`project/v1/projects/${ref.id}`, body)));
  if (ctx.config.get("project")?.id === ref.id) {
    ctx.config.set("project", { id: ref.id, name: body.name });
    await ctx.config.save();
  }
  ctx.out.result(updated ?? body, () => ctx.out.success(`Updated project ${c.bold(body.name)}.`));
}

async function deleteProject(ctx) {
  const ref = await ctx.project({ input: ctx.args.project, ignoreSaved: Boolean(ctx.args.project) });
  await ctx.confirm(`Delete project ${ref.name}? This cannot be undone.`, { danger: true });
  await ctx.out.spin("Deleting project", ctx.api.delete(`project/v1/projects/${ref.id}`));
  if (ctx.config.get("project")?.id === ref.id) {
    ctx.config.set("project", undefined);
    ctx.config.set("environment", undefined);
    await ctx.config.save();
  }
  ctx.out.success(`Deleted project ${ref.name}.`);
}

// ───────────── Environments ─────────────

async function listEnvs(ctx) {
  const project = await ctx.project();
  const envs = await ctx.out.spin("Loading environments", ctx.listEnvironments(project.id));
  const current = ctx.config.get("environment")?.id;
  ctx.out.table(
    envs,
    [
      ...(envs.some((e) => e.id === current) ? [{ header: "", get: (e) => (e.id === current ? c.green("*") : " "), flex: false }] : []),
      { header: "Name", key: "name" },
      { header: "ID", key: "id" },
      { header: "Region", key: "region" },
      { header: "CPU limit", get: (e) => e.cpuMaxUserLimit ?? e.cpuMaxPlatformLimit },
      { header: "Memory limit", get: (e) => e.memoryMaxUserLimit ?? e.memoryMaxPlatformLimit },
      { header: "Created", key: "createdAt", format: relativeTime }
    ],
    { empty: `No environments in ${project.name}.`, idKey: "id" }
  );
}

function quotaRows(quotas) {
  if (!quotas || typeof quotas !== "object") return [];
  if (quotas.allocatedLimits || quotas.usedResources) {
    const limitsMap = quotas.allocatedLimits ?? {};
    const usedMap = quotas.usedResources ?? {};
    return [...new Set([...Object.keys(limitsMap), ...Object.keys(usedMap)])].map((key) => ({ resource: key, used: usedMap[key], limit: limitsMap[key] }));
  }
  const hard = quotas.hard || quotas.status?.hard || quotas.spec?.hard;
  const used = quotas.used || quotas.status?.used;
  if (hard && typeof hard === "object") {
    return Object.keys(hard).map((key) => ({ resource: key, used: used?.[key], limit: hard[key] }));
  }
  return Object.entries(quotas).map(([key, value]) => ({
    resource: key,
    used: typeof value === "object" ? value.used ?? value.usage : undefined,
    limit: typeof value === "object" ? value.limit ?? value.hard ?? JSON.stringify(value) : value
  }));
}

async function getEnv(ctx) {
  const project = await ctx.project();
  const ref = await ctx.environment(project, { input: ctx.args.environment });
  const env = unwrap(await ctx.out.spin("Loading environment", ctx.api.get("project/v1/environments", { query: { id: ref.id } })));
  const data = Array.isArray(env) ? env[0] : env;
  ctx.out.result(data, () => {
    ctx.out.kv([
      ["Name", c.bold(data?.name ?? ref.name)],
      ["ID", ref.id],
      ["Project", `${project.name} ${c.dim(project.id)}`],
      ["Region", data?.region ?? ref.region],
      ["Type", data?.type],
      ["CPU", limits(data?.cpuMaxUserLimit, data?.cpuMaxPlatformLimit, "vCPU")],
      ["Memory", limits(data?.memoryMaxUserLimit, data?.memoryMaxPlatformLimit, "GB")],
      ["Storage", limits(data?.pvcStorageMaxUserLimit, data?.pvcStorageMaxPlatformLimit, "GB")],
      ["Public LB", ctx.apiUrl.includes(".dev.") ? `${ref.id}.dev.lb.nimbuz.tech` : `${ref.id}.${data?.region ?? ref.region ?? "<region>"}.lb.nimbuz.tech`]
    ]);
    const rows = quotaRows(data?.resourceQuotas);
    if (rows.length) {
      ctx.out.section("Resource quotas");
      ctx.out.table(rows, quotaColumns(), { total: false });
    }
  });
}

function limits(user, platform, unit) {
  if (user === undefined && platform === undefined) return undefined;
  const userText = user !== undefined ? `${user} ${unit}` : "-";
  return platform !== undefined ? `${userText} ${c.dim(`(platform max ${platform} ${unit})`)}` : userText;
}

async function createEnv(ctx) {
  const project = await ctx.project();
  const name = ctx.args.name;
  validateName(name, "environment");
  const env = unwrap(
    await ctx.out.spin("Creating environment", ctx.api.post("project/v1/environments", { projectId: project.id, name, region: defaultRegion(ctx) }))
  );
  if (ctx.flags.use && env?.id) {
    ctx.config.set("project", { id: project.id, name: project.name });
    ctx.config.set("environment", { id: env.id, name: env.name ?? name, region: env.region });
    await ctx.config.save();
  }
  ctx.out.result(env, () => ctx.out.success(`Created environment ${c.bold(name)} ${c.dim(env?.id ?? "")} in ${project.name}.`));
}

async function updateEnv(ctx) {
  const project = await ctx.project();
  const ref = await ctx.environment(project, { input: ctx.args.environment });
  const current = unwrap(await ctx.api.get("project/v1/environments", { query: { id: ref.id } }));
  const body = {
    id: ref.id,
    projectId: project.id,
    name: ctx.flags.name ?? current?.name ?? ref.name,
    cpuMaxUserLimit: ctx.flags.cpu ?? Number(current?.cpuMaxUserLimit ?? current?.cpuMaxPlatformLimit),
    memoryMaxUserLimit: ctx.flags.memory ?? Number(current?.memoryMaxUserLimit ?? current?.memoryMaxPlatformLimit),
    pvcStorageMaxUserLimit: ctx.flags.storage ?? Number(current?.pvcStorageMaxUserLimit ?? current?.pvcStorageMaxPlatformLimit)
  };
  if (ctx.flags.ephemeral !== undefined) body.ephemeralStorageMaxUserLimit = ctx.flags.ephemeral;
  validateName(body.name, "environment");
  const updated = unwrap(await ctx.out.spin("Updating environment", ctx.api.put("project/v1/environments", body)));
  ctx.out.result(updated ?? body, () => ctx.out.success(`Updated environment ${c.bold(body.name)}.`));
}

async function deleteEnv(ctx) {
  const project = await ctx.project();
  const ref = await ctx.environment(project, { input: ctx.args.environment });
  await ctx.confirm(`Delete environment ${ref.name} (${ref.id}) in ${project.name}? This cannot be undone.`, { danger: true });
  await ctx.out.spin("Deleting environment", ctx.api.delete("project/v1/environments", { query: { id: ref.id, projectId: project.id } }));
  if (ctx.config.get("environment")?.id === ref.id) {
    ctx.config.set("environment", undefined);
    await ctx.config.save();
  }
  ctx.out.success(`Deleted environment ${ref.name}.`);
}

/** Parses Kubernetes quantities ("539m", "4528Mi", "50Gi", "10") into base units. */
export function parseQuantity(value) {
  const match = String(value ?? "").trim().match(/^([0-9.]+)\s*([a-zA-Z]*)$/);
  if (!match) return undefined;
  const n = Number(match[1]);
  const factor = { "": 1, m: 0.001, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }[match[2]];
  return factor === undefined ? undefined : n * factor;
}

function quotaColumns() {
  return [
    { header: "Resource", key: "resource" },
    { header: "Used", key: "used" },
    { header: "Limit", key: "limit" },
    {
      header: "Usage",
      get: (row) => {
        const used = parseQuantity(row.used);
        const limit = parseQuantity(row.limit);
        if (used === undefined || !limit) return undefined;
        return `${bar(used / limit, 16)} ${Math.round((used / limit) * 100)}%`;
      }
    }
  ];
}

async function envUsage(ctx) {
  const scope = await ctx.scope();
  const plan = ctx.flags.plan || "lite";
  const [usage, planLimits] = await ctx.out.spin("Loading quota usage", () =>
    Promise.all([
      ctx.api.get(`deployment/v1/environments/${scope.environmentId}/resource-quotas/usage`, { query: { plan } }).then(unwrap).catch((error) => {
        if (error.status === 404) return null;
        throw error;
      }),
      ctx.api.get(`user/v1/plans/${plan}`).then(unwrap).catch(() => [])
    ])
  );
  if (usage === null) {
    // Older deployments lack the usage endpoint; the environment's quotas carry the same data.
    const env = unwrap(await ctx.api.get("project/v1/environments", { query: { id: scope.environmentId } }));
    const rows = quotaRows((Array.isArray(env) ? env[0] : env)?.resourceQuotas);
    if (ctx.out.jsonMode) return ctx.out.json(rows);
    ctx.out.log(c.dim(`${scope.project.name} / ${scope.environment.name}\n`));
    ctx.out.table(rows, quotaColumns(), { empty: "No quota data.", total: false });
    return;
  }
  const limitsByType = Object.fromEntries((Array.isArray(planLimits) ? planLimits : []).map((row) => [row.resource_type, row]));
  const rows = (Array.isArray(usage) ? usage : []).map((row) => {
    const limit = limitsByType[row.resource_type];
    return { resource: row.resource_type, remaining: row.remaining, max: limit?.max_limit ?? limit?.default_limit, unit: limit?.unit };
  });
  ctx.out.table(rows, [
    { header: "Resource", key: "resource" },
    { header: "Remaining", key: "remaining" },
    { header: "Plan max", key: "max" },
    { header: "Unit", key: "unit" }
  ], { empty: "No quota data.", total: false });
}

const regionFlag = { name: "region", type: "string", placeholder: "region", desc: "Region (default: ap-south-1)" };

export const projectsCommand = {
  name: "projects",
  aliases: ["project", "proj"],
  summary: "Manage projects",
  category: "Workspace",
  commands: [
    { name: "list", aliases: ["ls"], summary: "List projects", run: listProjects },
    { name: "get", aliases: ["show", "view"], summary: "Show a project and its environments", args: [{ name: "project", desc: "Name or ID (defaults to current)" }], run: getProject },
    {
      name: "create",
      aliases: ["new"],
      summary: "Create a project (and its first environment)",
      args: [{ name: "name", desc: "Project name (3-50 chars: letters, digits, dashes)" }],
      flags: [
        { name: "description", alias: "d", type: "string", desc: "Description (max 200 chars)" },
        { name: "env-name", type: "string", placeholder: "name", desc: "First environment name (default: production)" },
        regionFlag,
        { name: "use", type: "boolean", default: true, desc: "Make it the current context (--no-use to skip)" }
      ],
      examples: ["nimbuz projects create shop-api -d \"Backend for the web shop\"", "nimbuz projects create shop-api --env-name staging --no-use"],
      run: createProject
    },
    {
      name: "update",
      aliases: ["edit", "rename"],
      summary: "Rename a project or change its description",
      args: [{ name: "project", desc: "Name or ID (defaults to current)" }],
      flags: [
        { name: "name", type: "string", desc: "New name" },
        { name: "description", alias: "d", type: "string", desc: "New description" }
      ],
      run: updateProject
    },
    { name: "delete", aliases: ["rm"], summary: "Delete an empty project", args: [{ name: "project", required: true, desc: "Name or ID" }], run: deleteProject }
  ]
};

export const envsCommand = {
  name: "envs",
  aliases: ["env", "environments", "environment"],
  summary: "Manage environments",
  category: "Workspace",
  commands: [
    { name: "list", aliases: ["ls"], summary: "List environments in the project", run: listEnvs },
    { name: "get", aliases: ["show", "view"], summary: "Show an environment with limits and quotas", args: [{ name: "environment", desc: "Name or ID (defaults to current)" }], run: getEnv },
    {
      name: "create",
      aliases: ["new"],
      summary: "Create an environment",
      args: [{ name: "name", required: true, desc: "Environment name" }],
      flags: [regionFlag, { name: "use", type: "boolean", desc: "Make it the current context" }],
      examples: ["nimbuz envs create staging --use"],
      run: createEnv
    },
    {
      name: "update",
      aliases: ["edit"],
      summary: "Rename an environment or set resource limits",
      args: [{ name: "environment", desc: "Name or ID (defaults to current)" }],
      flags: [
        { name: "name", type: "string", desc: "New name" },
        { name: "cpu", type: "number", desc: "Max CPU (vCPU)" },
        { name: "memory", type: "number", desc: "Max memory (GB)" },
        { name: "storage", type: "number", desc: "Max persistent storage (GB)" },
        { name: "ephemeral", type: "number", desc: "Max ephemeral storage (GB)" }
      ],
      examples: ["nimbuz envs update production --cpu 4 --memory 8 --storage 20"],
      run: updateEnv
    },
    { name: "delete", aliases: ["rm"], summary: "Delete an empty environment", args: [{ name: "environment", required: true, desc: "Name or ID" }], run: deleteEnv },
    {
      name: "usage",
      aliases: ["quota"],
      summary: "Show remaining resource quota",
      flags: [{ name: "plan", type: "string", default: "lite", desc: "Plan name" }],
      run: envUsage
    }
  ]
};

