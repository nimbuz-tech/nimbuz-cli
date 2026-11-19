import { c } from "../core/colors.js";
import { UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { asArray, relativeTime } from "../core/util.js";

const ROLES = ["read", "write", "delete", "admin"];

function policyRow(raw) {
  const get = (i) => raw[`V${i}`] ?? raw[`v${i}`];
  return { ptype: raw.ptype ?? raw.PType ?? "p", userId: get(0), accountId: get(1), projectId: get(2), envId: get(3), permission: get(4) };
}

function toPolicy(row) {
  return { ptype: row.ptype || "p", v0: row.userId, v1: row.accountId, v2: row.projectId, v3: row.envId, v4: row.permission };
}

async function users(ctx) {
  return ctx.memo("users", async () => asArray(unwrap(await ctx.api.get("user/v1/user/list-user")), "users"));
}

async function list(ctx) {
  const rows = await ctx.out.spin("Loading members", users(ctx));
  ctx.out.table(rows, [
    { header: "Name", key: "name" },
    { header: "E-mail", key: "email" },
    { header: "Verified", get: (u) => u.isVerfied ?? u.isVerified, format: (v) => (v ? c.green("yes") : c.yellow("pending")) },
    { header: "User ID", key: "id", format: (v) => c.dim(v) },
    { header: "Joined", key: "createdAt", format: relativeTime }
  ], { empty: "No members yet. Invite someone with `nimbuz team invite <email>`.", idKey: "email" });
}

async function invite(ctx) {
  const email = ctx.args.email;
  const body = {
    username: ctx.flags.username || email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, ""),
    email,
    action: ctx.flags.role
  };
  if (ctx.flags.project || ctx.flags.env) {
    const project = await ctx.project();
    body.project = project.name;
    if (ctx.flags.env) body.env = (await ctx.environment(project)).name;
  }
  await ctx.out.spin(`Inviting ${email}`, ctx.api.post("user/v1/user/invite-user", body));
  ctx.out.success(`Invited ${c.bold(email)} with ${ctx.flags.role} access${body.project ? ` to ${body.project}${body.env ? `/${body.env}` : ""}` : ""}.`);
}

async function remove(ctx) {
  const all = await users(ctx);
  const user = all.find((u) => [u.name, u.email, u.id, u.username].includes(ctx.args.user));
  const username = user?.name || user?.username || ctx.args.user;
  await ctx.confirm(`Remove ${username} from the organization?`, { danger: true });
  await ctx.out.spin(`Removing ${username}`, ctx.api.delete("user/v1/user/delete-user", { body: { username } }));
  ctx.out.success(`Removed ${username}.`);
}

async function scopeNames(ctx) {
  const projects = new Map();
  const envs = new Map();
  try {
    for (const project of await ctx.listProjects()) {
      projects.set(project.id, project.name);
      for (const env of await ctx.listEnvironments(project.id).catch(() => [])) envs.set(env.id, env.name);
    }
  } catch {
    /* best effort */
  }
  return { projects, envs };
}

async function policies(ctx) {
  const path = ctx.flags.org ? "user/v1/policies/org" : "user/v1/policies";
  const [raw, members, names] = await ctx.out.spin("Loading policies", () =>
    Promise.all([ctx.api.get(path).then(unwrap), users(ctx).catch(() => []), scopeNames(ctx)])
  );
  const userNames = new Map(members.map((u) => [u.id, u.email || u.name]));
  const rows = asArray(raw).map(policyRow);
  if (ctx.out.jsonMode) return ctx.out.json(rows);
  ctx.out.table(rows, [
    { header: "User", get: (r) => userNames.get(r.userId) ?? r.userId },
    { header: "Project", get: (r) => (r.projectId === "*" ? c.cyan("all") : names.projects.get(r.projectId) ?? r.projectId) },
    { header: "Environment", get: (r) => (r.envId === "*" ? c.cyan("all") : names.envs.get(r.envId) ?? r.envId) },
    { header: "Permission", key: "permission", format: (v) => (["admin", "*"].includes(v) ? c.magenta(v) : v) }
  ], { empty: "No policies." });
}

async function resolveUser(ctx, query) {
  const all = await users(ctx);
  const user = all.find((u) => [u.id, u.email, u.name].includes(query));
  if (!user) throw new UsageError(`No member "${query}".`, { hint: "See `nimbuz team list`." });
  return user;
}

async function grantScope(ctx) {
  let projectId = "*";
  let envId = "*";
  if (ctx.flags.project && ctx.flags.project !== "*") {
    const project = await ctx.project();
    projectId = project.id;
    if (ctx.flags.env && ctx.flags.env !== "*") envId = (await ctx.environment(project)).id;
  }
  return { projectId, envId };
}

async function grant(ctx) {
  const user = await resolveUser(ctx, ctx.args.user);
  const { projectId, envId } = await grantScope(ctx);
  const policy = toPolicy({ userId: user.id, accountId: ctx.requireAccountId(), projectId, envId, permission: ctx.flags.role });
  await ctx.out.spin("Granting access", ctx.api.post("user/v1/policies", [policy]));
  ctx.out.success(`Granted ${ctx.flags.role} on ${projectId === "*" ? "all projects" : ctx.flags.project}${envId === "*" ? "" : `/${ctx.flags.env}`} to ${user.email || user.name}.`);
}

async function revoke(ctx) {
  const user = await resolveUser(ctx, ctx.args.user);
  const raw = asArray(unwrap(await ctx.api.get("user/v1/policies/org"))).map(policyRow);
  let matches = raw.filter((row) => row.userId === user.id);
  if (ctx.flags.project || ctx.flags.env) {
    const { projectId, envId } = await grantScope(ctx);
    matches = matches.filter((row) => row.projectId === projectId && (ctx.flags.env ? row.envId === envId : true));
  }
  if (!matches.length) throw new UsageError(`No matching policies for ${user.email || user.name}.`);
  await ctx.confirm(`Revoke ${matches.length} polic${matches.length === 1 ? "y" : "ies"} from ${user.email || user.name}?`);
  await ctx.out.spin("Revoking access", ctx.api.delete("user/v1/policies", { body: matches.map(toPolicy) }));
  ctx.out.success(`Revoked ${matches.length} polic${matches.length === 1 ? "y" : "ies"}.`);
}

const ROLE_FLAG = { name: "role", type: "string", default: "read", choices: ROLES, desc: "Permission level" };

export const teamCommand = {
  name: "team",
  aliases: ["members", "users"],
  summary: "Organization members and access policies",
  category: "Account",
  commands: [
    { name: "list", aliases: ["ls"], summary: "List members", run: list },
    {
      name: "invite",
      summary: "Invite a member",
      args: [{ name: "email", required: true }],
      flags: [{ name: "username", alias: "u", type: "string", desc: "Username (default: from e-mail)" }, ROLE_FLAG],
      examples: ["nimbuz team invite dev@acme.com --role write --project shop-api --env staging"],
      run: invite
    },
    { name: "remove", aliases: ["rm"], summary: "Remove a member", args: [{ name: "user", required: true, desc: "Username, e-mail or ID" }], run: remove },
    { name: "policies", aliases: ["access"], summary: "Show access policies", flags: [{ name: "org", type: "boolean", desc: "All organization policies (admins)" }], run: policies },
    {
      name: "grant",
      summary: "Grant a member access (all projects unless --project)",
      args: [{ name: "user", required: true, desc: "E-mail or ID" }],
      flags: [ROLE_FLAG],
      examples: ["nimbuz team grant dev@acme.com --role write --project shop-api", "nimbuz team grant ops@acme.com --role admin"],
      run: grant
    },
    { name: "revoke", summary: "Revoke a member's access", args: [{ name: "user", required: true, desc: "E-mail or ID" }], run: revoke }
  ]
};
