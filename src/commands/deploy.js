import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { c } from "../core/colors.js";
import { UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { asArray } from "../core/util.js";
import { APP_FLAGS, buildSpec, createBody, hasChanges, knownSource, loadManifest, MANIFEST_FILE, normalizeRepo, updateBody } from "../lib/spec.js";
import { appStatus, appUrl, fetchDeployment, waitForDeployment } from "../lib/workloads.js";

const exec = promisify(execFile);

async function git(...args) {
  try {
    const { stdout } = await exec("git", args, { timeout: 3000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort detection of the local project's repo, branch and runtime. */
export async function detectProject(dir = process.cwd()) {
  const remote = await git("-C", dir, "remote", "get-url", "origin");
  const branch = await git("-C", dir, "rev-parse", "--abbrev-ref", "HEAD");
  let repo;
  if (remote) {
    try {
      repo = normalizeRepo(remote).url;
    } catch {
      repo = undefined;
    }
  }
  const hints = { repo, branch: branch && branch !== "HEAD" ? branch : undefined, dockerfile: await exists(path.join(dir, "Dockerfile")) };
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    hints.name = pkg.name?.replace(/^@[^/]+\//, "");
    hints.port = 3000;
    hints.install = (await exists(path.join(dir, "package-lock.json"))) ? "npm ci" : "npm install";
    hints.build = pkg.scripts?.build ? "npm run build" : undefined;
    hints.start = pkg.scripts?.start ? "npm start" : undefined;
  } catch {
    if (await exists(path.join(dir, "requirements.txt"))) hints.port = 8000;
    else if (await exists(path.join(dir, "go.mod"))) hints.port = 8080;
  }
  hints.name ||= path.basename(path.resolve(dir));
  hints.name = hints.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return hints;
}

async function init(ctx) {
  const file = ctx.flags.file || MANIFEST_FILE;
  if ((await exists(file)) && !ctx.flags.force) {
    throw new UsageError(`${file} already exists.`, { hint: "Use --force to overwrite it." });
  }
  const hints = await detectProject();
  const interactive = ctx.prompt.isInteractive() && !ctx.flags.yes;
  const ask = (label, fallback, opts) => (interactive ? ctx.prompt.text(label, { default: fallback ? String(fallback) : undefined, required: false, ...opts }) : fallback);

  const project = ctx.flags.project || ctx.config.get("project")?.name;
  const environment = ctx.flags.env || ctx.config.get("environment")?.name;
  const name = await ask("App name:", hints.name, { validate: (v) => (/^[a-z0-9-]{3,40}$/.test(v) ? null : "3-40 lowercase letters, digits or dashes") });
  const repo = await ask("Git repository:", hints.repo);
  const branch = await ask("Branch:", hints.branch || "main");
  const port = Number(await ask("Port:", hints.port || 80)) || 80;
  const health = await ask("Health-check path:", "/", { validate: (v) => (v.startsWith("/") ? null : "Must start with /") });
  const instance = await ask("Instance type:", "small.m");

  const manifest = {
    name,
    ...(project ? { project } : {}),
    ...(environment ? { environment } : {}),
    source: repo ? { repo, branch, dockerfile: hints.dockerfile ? "Dockerfile" : "", dir: "", autoDeploy: false } : { archive: "./build.zip" },
    build: hints.dockerfile ? {} : { install: hints.install ?? "", build: hints.build ?? "", start: hints.start ?? "" },
    instance,
    replicas: 1,
    port,
    health,
    vars: {},
    secrets: {}
  };
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  ctx.out.success(`Wrote ${file}`);
  ctx.out.hint(`Secrets can reference your shell: "secrets": { "DATABASE_URL": "\${DATABASE_URL}" }`);
  ctx.out.hint(`Deploy with: nimbuz deploy`);
}

async function deploy(ctx) {
  const manifest = await loadManifest(ctx.flags.file);
  const hasSourceFlag = ctx.flags.repo || ctx.flags.archive;
  let detected = null;
  if (!manifest && !hasSourceFlag) {
    detected = await detectProject();
    if (!detected.repo) {
      throw new UsageError("Nothing to deploy: no nimbuz.json, --repo or --archive.", { hint: "Run `nimbuz init` to create a manifest." });
    }
    ctx.flags.repo = detected.repo;
    ctx.flags.branch ||= detected.branch;
    ctx.out.info(`Using ${c.bold(detected.repo)} @ ${detected.branch ?? "main"} (from git remote)`);
  }

  const name = ctx.args.name || manifest?.name || detected?.name;
  if (!name) throw new UsageError("Missing app name.");
  if (manifest?.project && !ctx.flags.project) ctx.flags.project = manifest.project;
  if (manifest?.environment && !ctx.flags.env) ctx.flags.env = manifest.environment;
  const scope = await ctx.scope();
  const spec = await buildSpec(ctx.flags, manifest);

  const apps = await ctx.out.spin("Checking existing apps", ctx.listDeployments(scope));
  const existing = asArray(apps).find((app) => app.name === name);

  let result;
  if (existing) {
    const current = await fetchDeployment(ctx, scope, existing.id);
    const body = await updateBody(ctx, scope, spec, current);
    if (!body.sourceCode && current?.sourceCode) body.sourceCode = knownSource(current);
    if (!hasChanges(body)) throw new UsageError("Nothing to deploy.");
    result = unwrap(await ctx.out.spin(`Deploying ${name}`, ctx.api.put(`deployment/v1/deployments/${existing.id}`, body))) ?? current;
    result.id ||= existing.id;
    ctx.out.success(`Rolling out ${c.bold(name)} to ${scope.project.name} / ${scope.environment.name}`);
  } else {
    const body = await createBody(ctx, scope, name, spec);
    result = unwrap(await ctx.out.spin(`Creating ${name}`, ctx.api.post("deployment/v1/deployments", body)));
    ctx.out.success(`Created ${c.bold(name)} in ${scope.project.name} / ${scope.environment.name}`);
  }

  if (!ctx.flags.wait) {
    ctx.out.result(result, () => ctx.out.hint(`Follow: nimbuz apps status ${name} --watch · logs: nimbuz logs ${name} --build`));
    return;
  }
  const final = await waitForDeployment(ctx, scope, result.id || result.deploymentId, { label: name });
  ctx.out.result(final, () => {
    ctx.out.success(`${c.bold(name)} is ${appStatus(final)}`);
    if (appUrl(final)) ctx.out.write(`  ${c.underline(appUrl(final))}`);
  });
}

export const initCommand = {
  name: "init",
  summary: `Create a ${MANIFEST_FILE} for this folder`,
  category: "Getting started",
  description: `Detects your Git remote, branch and runtime, and writes a ${MANIFEST_FILE} manifest used by \`nimbuz deploy\`.`,
  flags: [
    { name: "file", alias: "f", type: "string", placeholder: "path", desc: `Manifest path (default: ${MANIFEST_FILE})` },
    { name: "force", type: "boolean", desc: "Overwrite an existing manifest" }
  ],
  run: init
};

export const deployCommand = {
  name: "deploy",
  summary: "Create or update an app and wait for it to go live",
  category: "Getting started",
  description: [
    "Deploys the app described by ./nimbuz.json (or flags). Creates the app if it does not exist,",
    "otherwise rolls out the new configuration, then waits for the rollout to finish.",
    "",
    "With no manifest and no --repo, the current folder's git remote and branch are used.",
    "Manifest values like \"${VAR}\" are read from your shell — handy for CI secrets."
  ].join("\n"),
  args: [{ name: "name", desc: "App name (default: from manifest or folder)" }],
  flags: [...APP_FLAGS, { name: "wait", alias: "w", type: "boolean", default: true, desc: "Wait for the rollout (--no-wait to return immediately)" }],
  examples: [
    "nimbuz deploy",
    "nimbuz deploy --env staging --branch develop",
    "nimbuz deploy shop-api --repo acme/shop-api -i medium.m -e NODE_ENV=production",
    "nimbuz deploy -f deploy/nimbuz.prod.json --no-wait"
  ],
  run: deploy
};
