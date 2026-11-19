// Translates CLI flags and the nimbuz.json manifest into deployment API bodies.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { interpolateEnv, parseKeyValues, readDotenvFile } from "../core/util.js";

export const MANIFEST_FILE = "nimbuz.json";

/** Flags shared by `apps create`, `apps update`, `deploy` and `cron create`. */
export const SOURCE_FLAGS = [
  { name: "repo", alias: "r", type: "string", placeholder: "url|owner/repo", desc: "Git repository (GitHub, GitLab or Bitbucket)" },
  { name: "branch", alias: "b", type: "string", placeholder: "name", desc: "Git branch (default: main)" },
  { name: "archive", type: "string", placeholder: "path", desc: "Deploy a local .zip/.tar archive instead of Git" },
  { name: "dir", type: "string", placeholder: "path", desc: "Sub-folder of the repository to build" },
  { name: "dockerfile", type: "string", placeholder: "file", desc: "Dockerfile name (default: auto-detect)" },
  { name: "auto-deploy", type: "boolean", desc: "Redeploy automatically on every push" }
];

export const APP_FLAGS = [
  ...SOURCE_FLAGS,
  { name: "instance", alias: "i", type: "string", placeholder: "type", desc: "Instance type, e.g. nano.m, small.m (see `nimbuz billing pricing`)" },
  { name: "replicas", type: "number", desc: "Number of replicas" },
  { name: "autoscale", type: "string", placeholder: "min:max", desc: "Enable autoscaling between min and max replicas (\"off\" to disable)" },
  { name: "install-cmd", type: "string", placeholder: "cmd", desc: "Install command (e.g. npm ci)" },
  { name: "build-cmd", type: "string", placeholder: "cmd", desc: "Build command" },
  { name: "start-cmd", type: "string", placeholder: "cmd", desc: "Start command" },
  { name: "port", type: "number", desc: "Container port" },
  { name: "health", type: "string", placeholder: "path", desc: "Health-check path, e.g. /health" },
  { name: "storage", type: "string", placeholder: "size", desc: "Persistent volume size, e.g. 1Gi" },
  { name: "env-var", alias: "e", type: "list", placeholder: "KEY=VALUE", desc: "Environment variable (repeatable)" },
  { name: "env-file", type: "string", placeholder: "path", desc: "Load environment variables from a .env file" },
  { name: "secret", alias: "s", type: "list", placeholder: "KEY=VALUE", desc: "Secret variable (repeatable)" },
  { name: "secret-file", type: "string", placeholder: "path", desc: "Load secrets from a .env file" },
  { name: "config-file", type: "string", placeholder: "local[:mount]", desc: "Mount a local file into the container (e.g. ./app.yaml:/app/config/app.yaml)" },
  { name: "file", alias: "f", type: "string", placeholder: "path", desc: `Read settings from a manifest (default: ./${MANIFEST_FILE} for deploy)` }
];

/** Normalizes a repository reference into an https clone URL. */
export function normalizeRepo(repo) {
  let value = String(repo).trim();
  const branchMatch = value.match(/\s+-b\s+(\S+)$/);
  let branch;
  if (branchMatch) {
    branch = branchMatch[1];
    value = value.slice(0, branchMatch.index).trim();
  }
  if (/^git@([^:]+):(.+)$/.test(value)) {
    const [, host, rest] = value.match(/^git@([^:]+):(.+)$/);
    value = `https://${host}/${rest}`;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    value = `https://github.com/${value}`;
  } else if (/^(github\.com|gitlab\.com|bitbucket\.org)\//.test(value)) {
    value = `https://${value}`;
  }
  value = value.replace(/\/+$/, "");
  if (!value.endsWith(".git")) value = `${value}.git`;
  if (!/^https:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\//.test(value.replace(/^https:\/\/[^@]+@/, "https://"))) {
    throw new UsageError(`Unsupported repository "${repo}".`, { hint: "Use a GitHub, GitLab or Bitbucket https URL, or owner/repo for GitHub." });
  }
  return { url: value, branch };
}

export function parseGitUrl(gitUrl) {
  if (!gitUrl) return {};
  const match = String(gitUrl).match(/^(\S+)(?:\s+-b\s+(\S+))?/);
  return { repo: match?.[1]?.replace(/^https:\/\/[^@]+@/, "https://"), branch: match?.[2] };
}

export async function loadManifest(file, { required = false } = {}) {
  const target = file || MANIFEST_FILE;
  let text;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      if (required || file) throw new UsageError(`Manifest not found: ${target}`, { hint: "Create one with `nimbuz init`." });
      return null;
    }
    throw error;
  }
  try {
    const manifest = JSON.parse(text);
    manifest.__dir = path.dirname(path.resolve(target));
    manifest.__file = target;
    return manifest;
  } catch (error) {
    throw new UsageError(`${target} is not valid JSON: ${error.message}`);
  }
}

function parseAutoscale(value) {
  if (value === undefined) return undefined;
  if (value === false || value === "off" || value === "false" || value === "0") return { hpaEnabled: false };
  if (typeof value === "object") {
    return { hpaEnabled: true, hpaMinReplicas: Number(value.min ?? value.hpaMinReplicas), hpaMaxReplicas: Number(value.max ?? value.hpaMaxReplicas) };
  }
  const match = String(value).match(/^(\d+)\s*[:-]\s*(\d+)$/);
  if (!match) throw new UsageError(`Invalid --autoscale "${value}". Use min:max, e.g. 1:5, or "off".`);
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (min < 1 || max < min) throw new UsageError("--autoscale needs 1 <= min <= max.");
  return { hpaEnabled: true, hpaMinReplicas: min, hpaMaxReplicas: max };
}

async function loadConfigFile(spec, baseDir) {
  if (!spec) return undefined;
  const value = typeof spec === "string" ? { from: spec.split(":")[0], path: spec.split(":").slice(1).join(":") || undefined } : spec;
  const local = path.resolve(baseDir, value.from || value.file);
  const data = await readFile(local, "utf8").catch(() => {
    throw new UsageError(`Config file not found: ${local}`);
  });
  const name = value.name || path.basename(local);
  return { name, path: value.path || `/app/${name}`, data };
}

function resolveVars(map, context) {
  return Object.fromEntries(Object.entries(map ?? {}).map(([key, value]) => [key, interpolateEnv(String(value), process.env, `${context} ${key}`)]));
}

/**
 * Merges manifest + flags into a normalized spec:
 * { name, source:{repo,branch,archive,dir,dockerfile,autoDeploy}, build:{install,build,start},
 *   instance, replicas, autoscale, port, health, storage, vars, secrets, configFile, project, env }
 */
export async function buildSpec(flags, manifest = null) {
  const m = manifest ?? {};
  const dir = m.__dir ?? process.cwd();
  const source = { ...(m.source ?? {}) };

  if (flags.repo) {
    source.repo = flags.repo;
    delete source.archive;
  }
  if (flags.archive) {
    source.archive = flags.archive;
    delete source.repo;
  }
  if (flags.branch) source.branch = flags.branch;
  if (flags.dir !== undefined) source.dir = flags.dir;
  if (flags.dockerfile !== undefined) source.dockerfile = flags.dockerfile;
  if (flags.autoDeploy !== undefined) source.autoDeploy = flags.autoDeploy;
  if (source.repo) {
    const { url, branch } = normalizeRepo(source.repo);
    source.repo = url;
    source.branch = source.branch || branch || "main";
  }
  if (source.archive && !path.isAbsolute(source.archive)) source.archive = path.resolve(dir, source.archive);

  const build = {
    install: flags.installCmd ?? m.build?.install,
    build: flags.buildCmd ?? m.build?.build,
    start: flags.startCmd ?? m.build?.start
  };

  let vars = { ...(m.vars ?? m.env ?? {}) };
  if (flags.envFile) vars = { ...vars, ...(await readDotenvFile(flags.envFile)) };
  vars = { ...vars, ...parseKeyValues(flags.envVar, "--env-var") };
  let secrets = { ...(m.secrets ?? {}) };
  if (flags.secretFile) secrets = { ...secrets, ...(await readDotenvFile(flags.secretFile)) };
  secrets = { ...secrets, ...parseKeyValues(flags.secret, "--secret") };

  return {
    name: m.name,
    project: m.project,
    env: m.environment ?? m.env_name,
    source,
    build,
    instance: flags.instance ?? m.instance,
    replicas: flags.replicas ?? m.replicas,
    autoscale: parseAutoscale(flags.autoscale ?? m.autoscale),
    port: flags.port ?? m.port,
    health: flags.health ?? m.health,
    storage: flags.storage ?? m.storage,
    vars: resolveVars(vars, "variable"),
    secrets: resolveVars(secrets, "secret"),
    configFile: await loadConfigFile(flags.configFile ?? m.configFile, flags.configFile ? process.cwd() : dir)
  };
}

const ARCHIVE_TYPES = {
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".tgz": "application/gzip",
  ".gz": "application/gzip"
};

/** Uploads a local archive via the pre-signed artifact URL; returns the S3 key. */
export async function uploadArchive(ctx, scope, file) {
  const ext = path.extname(file).toLowerCase();
  const contentType = ARCHIVE_TYPES[ext];
  if (!contentType) throw new UsageError(`Unsupported archive type "${ext}". Use .zip or .tar.`);
  const info = await stat(file).catch(() => {
    throw new UsageError(`Archive not found: ${file}`);
  });
  const presign = unwrap(
    await ctx.api.get("deployment/v1/artificat", {
      query: {
        fileExtension: ext.slice(1),
        fileName: path.basename(file),
        fileSize: info.size,
        environmentId: scope.environmentId,
        projectId: scope.projectId
      }
    })
  );
  const uploadUrl = presign?.uploadUrl;
  const key = presign?.s3FileKey || presign?.s3Key;
  if (!uploadUrl || !key) throw new UsageError("The API did not return an upload URL.");
  const body = await readFile(file);
  const sizeMb = (info.size / 1024 / 1024).toFixed(1);
  const response = await ctx.out.spin(`Uploading ${path.basename(file)} (${sizeMb} MB)`, () =>
    fetch(uploadUrl, { method: "PUT", body, headers: { "Content-Type": presign.contentType || contentType } })
  );
  if (!response.ok) throw new UsageError(`Upload failed with HTTP ${response.status}.`);
  return key;
}

async function sourceCodeBody(ctx, scope, source, { requireSource }) {
  if (source.archive) {
    return { type: "file", s3FileKey: await uploadArchive(ctx, scope, source.archive), folderPath: source.dir ?? "", dockerFileName: source.dockerfile ?? "" };
  }
  if (source.repo) {
    return {
      type: "vcs",
      gitUrl: `${source.repo} -b ${source.branch || "main"}`,
      vcsAutoDeploy: Boolean(source.autoDeploy),
      folderPath: source.dir ?? "",
      dockerFileName: source.dockerfile ?? ""
    };
  }
  if (requireSource) {
    throw new UsageError("No source given.", { hint: "Pass --repo <url> [--branch <name>] or --archive <file.zip>." });
  }
  return undefined;
}

function applicationBody(spec, { defaults }) {
  const app = {
    instanceType: spec.instance ?? (defaults ? "small.m" : undefined),
    installCommand: spec.build.install,
    buildCommand: spec.build.build,
    startCommand: spec.build.start,
    storage: spec.storage
  };
  if (!spec.autoscale?.hpaEnabled) app.replicas = spec.replicas ?? (defaults ? 1 : undefined);
  const clean = Object.fromEntries(Object.entries(app).filter(([, v]) => v !== undefined && v !== ""));
  return Object.keys(clean).length ? clean : undefined;
}

function networkBody(spec, { defaults }) {
  const network = { port: spec.port ?? (defaults ? 80 : undefined), healthEndpoint: spec.health };
  const clean = Object.fromEntries(Object.entries(network).filter(([, v]) => v !== undefined && v !== ""));
  return Object.keys(clean).length ? clean : undefined;
}

/** POST /deployments body. */
export async function createBody(ctx, scope, name, spec) {
  const body = {
    name,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    sourceCode: await sourceCodeBody(ctx, scope, spec.source, { requireSource: true }),
    application: applicationBody(spec, { defaults: true }),
    network: networkBody(spec, { defaults: true }),
    config: spec.configFile ?? { name: "", path: "", data: "" },
    hpa: spec.autoscale ?? { hpaEnabled: false }
  };
  if (Object.keys(spec.vars).length) body.environment = spec.vars;
  if (Object.keys(spec.secrets).length) body.secret = spec.secrets;
  return body;
}

/**
 * PUT /deployments/{id} body with only what changed.
 * `current` is the existing deployment, used to merge variables.
 */
export async function updateBody(ctx, scope, spec, current, { replaceVars = false } = {}) {
  const body = { projectId: scope.projectId, environmentId: scope.environmentId };
  const sourceCode = await sourceCodeBody(ctx, scope, spec.source, { requireSource: false });
  if (sourceCode) body.sourceCode = sourceCode;
  else if (spec.source.branch && current?.sourceCode?.gitUrl) {
    const { repo } = parseGitUrl(current.sourceCode.gitUrl);
    body.sourceCode = { ...pickKnown(current.sourceCode, SOURCE_KEYS), gitUrl: `${repo} -b ${spec.source.branch}` };
  }
  if (!sourceCode && current?.sourceCode && (spec.source.dir !== undefined || spec.source.dockerfile !== undefined || spec.source.autoDeploy !== undefined)) {
    body.sourceCode = {
      ...(body.sourceCode ?? pickKnown(current.sourceCode, SOURCE_KEYS)),
      ...(spec.source.dir !== undefined ? { folderPath: spec.source.dir } : {}),
      ...(spec.source.dockerfile !== undefined ? { dockerFileName: spec.source.dockerfile } : {}),
      ...(spec.source.autoDeploy !== undefined ? { vcsAutoDeploy: spec.source.autoDeploy } : {})
    };
  }
  const application = applicationBody(spec, { defaults: false });
  if (application) body.application = { ...pickKnown(current?.application, APP_KEYS), ...application };
  if (spec.autoscale) {
    body.hpa = spec.autoscale;
    if (spec.autoscale.hpaEnabled && body.application) delete body.application.replicas;
  }
  const network = networkBody(spec, { defaults: false });
  if (network) body.network = { port: current?.network?.port, healthEndpoint: current?.network?.healthEndpoint, ...network };
  if (spec.configFile) body.config = spec.configFile;
  if (Object.keys(spec.vars).length) body.environment = replaceVars ? spec.vars : { ...(current?.environment ?? {}), ...spec.vars };
  if (Object.keys(spec.secrets).length) body.secret = replaceVars ? spec.secrets : { ...currentSecrets(current), ...spec.secrets };
  if (body.application) {
    for (const key of Object.keys(body.application)) if (body.application[key] === null || body.application[key] === undefined) delete body.application[key];
  }
  return body;
}

const APP_KEYS = ["replicas", "instanceType", "installCommand", "buildCommand", "startCommand", "storage"];
const SOURCE_KEYS = ["type", "gitUrl", "s3FileKey", "vcsAutoDeploy", "folderPath", "dockerFileName"];

function pickKnown(object, keys) {
  const result = {};
  for (const key of keys) if (object?.[key] !== undefined && object?.[key] !== null) result[key] = object[key];
  return result;
}

export function knownSource(deployment) {
  return pickKnown(deployment?.sourceCode, SOURCE_KEYS);
}

export function currentSecrets(deployment) {
  return deployment?.secret ?? deployment?.secrets ?? {};
}

export function hasChanges(body) {
  return Object.keys(body).some((key) => !["projectId", "environmentId"].includes(key));
}
