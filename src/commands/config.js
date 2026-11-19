import { c } from "../core/colors.js";
import { configPath, DEFAULT_API_URL, resolveApiUrl, SETTINGS } from "../core/config.js";
import { UsageError } from "../core/errors.js";
import { suggest } from "../core/util.js";

function settingFor(name) {
  const setting = SETTINGS[name];
  if (!setting) {
    const guess = suggest(name, Object.keys(SETTINGS));
    throw new UsageError(`Unknown setting: ${name}`, {
      hint: guess ? `Did you mean ${guess}?` : `Available: ${Object.keys(SETTINGS).filter((k) => !SETTINGS[k].hidden).join(", ")}`
    });
  }
  return setting;
}

async function use(ctx) {
  const { project: projectInput, environment: envInput } = ctx.args;
  // With no arguments this becomes an interactive picker.
  const project = await ctx.project({ input: projectInput, ignoreSaved: true });
  ctx.config.set("project", { id: project.id, name: project.name });
  ctx.config.set("environment", undefined);
  const environment = await ctx.environment(project, { input: envInput || ctx.flags.env });
  ctx.config.set("environment", { id: environment.id, name: environment.name, region: environment.region });
  await ctx.config.save();
  ctx.out.result({ project, environment }, () =>
    ctx.out.success(`Now using ${c.bold(project.name)} ${c.dim("/")} ${c.bold(environment.name)} ${c.dim(`(${environment.id})`)}`)
  );
}

async function showContext(ctx) {
  const project = ctx.config.get("project");
  const environment = ctx.config.get("environment");
  const data = {
    profile: ctx.config.profileName,
    apiUrl: ctx.apiUrl,
    org: ctx.claims.org || ctx.config.get("orgName"),
    project: project ?? null,
    environment: environment ?? null
  };
  ctx.out.result(data, () => {
    ctx.out.kv([
      ["Profile", data.profile],
      ["API", data.apiUrl],
      ["Organization", data.org],
      ["Project", project ? `${project.name} ${c.dim(project.id)}` : c.dim("none")],
      ["Environment", environment ? `${environment.name} ${c.dim(environment.id)}` : c.dim("none")]
    ]);
    if (!project) ctx.out.hint("\nSet one with `nimbuz use <project> [environment]`.");
  });
}

async function clearContext(ctx) {
  ctx.config.set("project", undefined);
  ctx.config.set("environment", undefined);
  await ctx.config.save();
  ctx.out.success("Context cleared.");
}

async function configList(ctx) {
  const profile = ctx.config.profile;
  const visible = Object.entries(SETTINGS).filter(([name, setting]) => !setting.hidden || (name === "api-url" && ctx.apiUrl !== DEFAULT_API_URL));
  const rows = visible.map(([name, setting]) => ({
    name,
    value: name === "api-url" ? ctx.apiUrl : profile[setting.key],
    desc: setting.desc
  }));
  ctx.out.table(rows, [
    { header: "Setting", key: "name" },
    { header: "Value", key: "value" },
    { header: "Description", key: "desc", format: (v) => c.dim(v) }
  ]);
  if (!ctx.out.jsonMode) ctx.out.hint(`\nProfile: ${ctx.config.profileName} · File: ${configPath()}`);
}

async function configGet(ctx) {
  const setting = settingFor(ctx.args.key);
  const value = ctx.args.key === "api-url" ? ctx.apiUrl : ctx.config.get(setting.key);
  if (ctx.out.jsonMode) ctx.out.json({ [ctx.args.key]: value ?? null });
  else if (value !== undefined) ctx.out.write(String(value));
}

async function configSet(ctx) {
  const setting = settingFor(ctx.args.key);
  let value = ctx.args.value;
  if (ctx.args.key === "api-url") value = resolveApiUrl(value);
  if (ctx.args.key === "output" && !["table", "json"].includes(value)) throw new UsageError("output must be table or json.");
  ctx.config.set(setting.key, value);
  await ctx.config.save();
  ctx.out.success(`${ctx.args.key} = ${value}`);
}

async function configUnset(ctx) {
  const setting = settingFor(ctx.args.key);
  ctx.config.set(setting.key, undefined);
  await ctx.config.save();
  ctx.out.success(`${ctx.args.key} cleared.`);
}

async function profiles(ctx) {
  const current = ctx.config.data.currentProfile;
  const rows = ctx.config.profileNames().map((name) => {
    const profile = ctx.config.data.profiles[name];
    return {
      name,
      current: name === current,
      apiUrl: profile.apiUrl,
      org: profile.orgName,
      user: profile.username,
      loggedIn: Boolean(profile.token)
    };
  });
  ctx.out.table(rows, [
    { header: "", key: "current", format: (v) => (v ? c.green("*") : " "), flex: false },
    { header: "Profile", key: "name" },
    { header: "API", key: "apiUrl" },
    { header: "Org", key: "org" },
    { header: "User", key: "user" },
    { header: "Session", key: "loggedIn", format: (v) => (v ? c.green("yes") : c.dim("no")) }
  ]);
}

async function profileUse(ctx) {
  ctx.config.useProfile(ctx.args.name);
  await ctx.config.save();
  ctx.out.success(`Switched to profile ${c.bold(ctx.args.name)}.`);
  if (!ctx.config.get("token")) ctx.out.hint("This profile has no session yet — run `nimbuz login`.");
}

async function profileDelete(ctx) {
  if (!ctx.config.data.profiles[ctx.args.name]) throw new UsageError(`No profile named ${ctx.args.name}.`);
  await ctx.confirm(`Delete profile ${ctx.args.name} and its saved session?`);
  ctx.config.deleteProfile(ctx.args.name);
  await ctx.config.save();
  ctx.out.success(`Deleted profile ${ctx.args.name}.`);
}

export const useCommand = {
  name: "use",
  summary: "Set the current project and environment",
  category: "Getting started",
  description: "Remember a project (and environment) so later commands don't need --project/--env.",
  args: [
    { name: "project", desc: "Project name or ID" },
    { name: "environment", desc: "Environment name or ID (defaults to the only one, or prompts)" }
  ],
  examples: ["nimbuz use shop-api production", "nimbuz use            # pick interactively"],
  run: use
};

export const contextCommand = {
  name: "context",
  aliases: ["ctx"],
  summary: "Show or clear the current context",
  category: "Getting started",
  commands: [
    { name: "show", summary: "Show the current project/environment", run: showContext },
    { name: "clear", summary: "Forget the current project/environment", run: clearContext }
  ],
  run: showContext
};

export const configCommand = {
  name: "config",
  summary: "CLI settings and profiles",
  category: "Account",
  commands: [
    { name: "list", aliases: ["ls"], summary: "List settings", run: configList },
    { name: "get", summary: "Print one setting", args: [{ name: "key", required: true, desc: Object.keys(SETTINGS).filter((k) => !SETTINGS[k].hidden).join(" | ") }], run: configGet },
    {
      name: "set",
      summary: "Change a setting",
      args: [
        { name: "key", required: true, desc: Object.keys(SETTINGS).filter((k) => !SETTINGS[k].hidden).join(" | ") },
        { name: "value", required: true, desc: "New value" }
      ],
      examples: ["nimbuz config set timezone Asia/Kolkata", "nimbuz config set output json"],
      run: configSet
    },
    { name: "unset", summary: "Reset a setting", args: [{ name: "key", required: true }], run: configUnset },
    { name: "path", summary: "Print the config file path", run: async (ctx) => ctx.out.write(configPath()) },
    {
      name: "profiles",
      summary: "Manage profiles (separate accounts/APIs)",
      commands: [
        { name: "list", aliases: ["ls"], summary: "List profiles", run: profiles },
        { name: "use", summary: "Switch the default profile", args: [{ name: "name", required: true }], run: profileUse },
        { name: "delete", aliases: ["rm"], summary: "Delete a profile", args: [{ name: "name", required: true }], run: profileDelete }
      ],
      run: profiles
    }
  ]
};
