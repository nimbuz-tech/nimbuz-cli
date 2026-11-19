import { c } from "./colors.js";
import { ConfigStore } from "./config.js";
import { CliError, NotFoundError, UsageError } from "./errors.js";
import { ApiClient, unwrap } from "./http.js";
import { tokenClaims } from "./jwt.js";
import { Output } from "./output.js";
import * as prompt from "./prompt.js";
import { asArray, isEnvId, isUuid } from "./util.js";

/** Finds one item by id, exact name, or unique prefix/substring. */
export function matchByName(items, query, { kind, idKeys = ["id"], nameKeys = ["name"] } = {}) {
  const value = String(query ?? "").trim();
  const lower = value.toLowerCase();
  const idOf = (item) => idKeys.map((key) => item?.[key]).find(Boolean);
  const nameOf = (item) => nameKeys.map((key) => item?.[key]).find(Boolean) ?? "";

  const byId = items.find((item) => String(idOf(item)) === value);
  if (byId) return byId;
  const exact = items.filter((item) => String(nameOf(item)).toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : items.filter((item) => String(nameOf(item)).toLowerCase().startsWith(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new UsageError(`"${value}" matches several ${kind}s: ${partial.map(nameOf).join(", ")}.`, {
      hint: `Use the exact name or ID.`
    });
  }
  const names = items.map(nameOf).filter(Boolean);
  throw new NotFoundError(`No ${kind} named "${value}".`, {
    hint: names.length ? `Available: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}` : undefined
  });
}

export class Context {
  constructor({ flags, args, config, version, command }) {
    this.flags = flags;
    this.args = args;
    this.config = config;
    this.version = version;
    this.command = command;
    this.out = new Output({ json: flags.json || config.get("output") === "json", quiet: flags.quiet });
    this.prompt = prompt;
    this.cache = new Map();
    this._api = null;
  }

  static async create({ flags, args, version, command }) {
    const config = await ConfigStore.load({ profileOverride: flags.profile });
    return new Context({ flags, args, config, version, command });
  }

  get apiUrl() {
    return this.config.apiUrl(this.flags.apiUrl);
  }

  get api() {
    if (!this._api) {
      this._api = new ApiClient({
        baseUrl: this.apiUrl,
        token: this.config.token(),
        debug: Boolean(this.flags.debug || process.env.NIMBUZ_DEBUG)
      });
    }
    return this._api;
  }

  /** Base URL of the web portal matching the API (for links). */
  get portalUrl() {
    return this.api.origin || "https://app.nimbuz.tech";
  }

  get claims() {
    return tokenClaims(this.config.token());
  }

  requireAccountId() {
    const accountId = this.flags.account || this.claims.accountId;
    if (!accountId) {
      throw new CliError("Could not determine your account ID from the saved token.", {
        exitCode: 4,
        hint: "Run `nimbuz login` again, or pass --account <id>."
      });
    }
    return accountId;
  }

  async memo(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, Promise.resolve().then(fn));
    return this.cache.get(key);
  }

  async confirm(message, { danger = false } = {}) {
    if (this.flags.yes) return;
    if (!prompt.isInteractive()) {
      throw new UsageError(`${message.replace(/\?$/, "")} — confirmation required.`, { hint: "Re-run with --yes to confirm." });
    }
    const ok = await prompt.confirm(danger ? c.red(message) : message);
    if (!ok) throw new CliError("Aborted.", { exitCode: 1 });
  }

  // ───────────── Resolution of project / environment / workloads ─────────────

  listProjects() {
    return this.memo("projects", async () => asArray(unwrap(await this.api.get("project/v1/projects")), "projects"));
  }

  listEnvironments(projectId) {
    return this.memo(`envs:${projectId}`, async () =>
      asArray(unwrap(await this.api.get("project/v1/environments", { query: { projectId } })), "environments")
    );
  }

  /** Resolves the project from --project, NIMBUZ_PROJECT, the saved context, or a prompt. */
  async project({ input, required = true, ignoreSaved = false } = {}) {
    const query = input || this.flags.project || process.env.NIMBUZ_PROJECT;
    const saved = ignoreSaved ? null : this.config.get("project");
    if (!query && saved?.id) return saved;

    if (query && isUuid(query)) {
      const known = saved?.id === query ? saved : null;
      return known || { id: query, name: (await this.listProjects()).find((p) => p.id === query)?.name || query };
    }

    const projects = await this.out.spin("Loading projects", this.listProjects());
    if (query) {
      const project = matchByName(projects, query, { kind: "project", nameKeys: ["name", "projectName"] });
      return { id: project.id || project.projectId, name: project.name || project.projectName };
    }
    if (!required) return null;
    if (projects.length === 1) return { id: projects[0].id, name: projects[0].name };
    if (!projects.length) {
      throw new UsageError("You have no projects yet.", { hint: "Create one with `nimbuz projects create <name>`." });
    }
    if (prompt.isInteractive()) {
      const choice = await prompt.select(
        "Select a project",
        projects.map((p) => ({ label: p.name, value: p, hint: p.id }))
      );
      this.out.hint(`Tip: run \`nimbuz use ${choice.name}\` to remember this choice.`);
      return { id: choice.id, name: choice.name };
    }
    throw new UsageError("No project selected.", { hint: "Pass --project <name> or run `nimbuz use <project>`." });
  }

  /** Resolves the environment within a project. */
  async environment(project, { input, required = true } = {}) {
    const query = input || this.flags.env || process.env.NIMBUZ_ENV || process.env.NIMBUZ_ENVIRONMENT;
    const saved = this.config.get("environment");
    const savedProject = this.config.get("project");
    if (!query && saved?.id && savedProject?.id === project.id) return saved;
    if (query && isEnvId(query)) {
      if (saved?.id === query) return saved;
      const envs = await this.listEnvironments(project.id).catch(() => []);
      return { id: query, name: envs.find((env) => env.id === query)?.name || query };
    }

    const envs = await this.out.spin("Loading environments", this.listEnvironments(project.id));
    if (query) {
      const env = matchByName(envs, query, { kind: "environment" });
      return { id: env.id, name: env.name, region: env.region };
    }
    if (!required) return null;
    if (envs.length === 1) return { id: envs[0].id, name: envs[0].name, region: envs[0].region };
    if (!envs.length) {
      throw new UsageError(`Project "${project.name}" has no environments.`, {
        hint: "Create one with `nimbuz envs create <name>`."
      });
    }
    if (prompt.isInteractive()) {
      const choice = await prompt.select(
        `Select an environment in ${project.name}`,
        envs.map((env) => ({ label: env.name, value: env, hint: `${env.id} · ${env.region ?? ""}` }))
      );
      this.out.hint(`Tip: run \`nimbuz use ${project.name} ${choice.name}\` to remember this choice.`);
      return { id: choice.id, name: choice.name, region: choice.region };
    }
    throw new UsageError("No environment selected.", { hint: "Pass --env <name> or run `nimbuz use <project> <env>`." });
  }

  /** { project, environment, projectId, environmentId } */
  async scope() {
    return this.memo("scope", async () => {
      const project = await this.project();
      const environment = await this.environment(project);
      return { project, environment, projectId: project.id, environmentId: environment.id };
    });
  }

  listDeployments(scope) {
    return this.memo(`apps:${scope.environmentId}`, async () =>
      asArray(
        unwrap(
          await this.api.get("deployment/v1/deployments/list", {
            query: { projectId: scope.projectId, environmentId: scope.environmentId }
          })
        ),
        "deployments"
      )
    );
  }

  async deployment(scope, input) {
    if (!input) throw new UsageError("Missing app name.");
    const apps = await this.out.spin("Loading apps", this.listDeployments(scope));
    if (isUuid(input) && !apps.some((app) => app.id === input)) return { id: input, name: input };
    return matchByName(apps, input, { kind: "app", idKeys: ["id", "deploymentId", "_id"] });
  }

  listTools(scope) {
    return this.memo(`tools:${scope.environmentId}`, async () =>
      asArray(
        unwrap(
          await this.api.get("deployment/v1/tools/installed", {
            query: { projectId: scope.projectId, environmentId: scope.environmentId }
          })
        ),
        "tools"
      )
    );
  }

  async tool(scope, input) {
    const tools = await this.out.spin("Loading tools", this.listTools(scope));
    return matchByName(tools, input, { kind: "tool" });
  }
}
