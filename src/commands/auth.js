import { c } from "../core/colors.js";
import { configPath, resolveApiUrl } from "../core/config.js";
import { CliError, UsageError } from "../core/errors.js";
import { ApiClient, unwrap } from "../core/http.js";
import { isExpired, tokenClaims } from "../core/jwt.js";
import { formatDate, readStdin, relativeTime } from "../core/util.js";

const loginFlags = [
  { name: "username", alias: "u", type: "string", placeholder: "email", desc: "Username / e-mail" },
  { name: "org", type: "string", placeholder: "name", desc: "Business organization name (individual accounts: nimbuz)" },
  { name: "individual", type: "boolean", desc: "Log in to an individual account (org = nimbuz)" },
  { name: "password-stdin", type: "boolean", desc: "Read the password from stdin (also: NIMBUZ_PASSWORD)" },
  { name: "code", type: "string", placeholder: "123456", desc: "2FA code, if two-factor authentication is enabled" },
  { name: "token", type: "string", placeholder: "jwt", desc: "Save an existing access token instead of logging in" }
];

/** "https://api.dev.nimbuz.tech" -> "dev.nimbuz.tech" */
function portalDomain(apiUrl) {
  try {
    const host = new URL(apiUrl).hostname;
    return host.startsWith("api.") ? host.slice(4) : host;
  } catch {
    return "nimbuz.tech";
  }
}

async function completeMfa(ctx, api, challenge) {
  const methods = challenge.methods?.length ? challenge.methods : ["totp"];
  let method = methods[0];
  if (ctx.flags.code) method = "totp";
  else if (methods.length > 1 && ctx.prompt.isInteractive()) {
    method = await ctx.prompt.select("Two-factor authentication required", [
      { label: "Authenticator app code", value: "totp" },
      { label: "E-mail me a sign-in code", value: "email", hint: "turns 2FA off after sign-in" }
    ]);
  }

  if (method === "email") {
    const sent = unwrap(await api.post("user/v1/user/login/2fa/email/send", { challengeId: challenge.challengeId }, { auth: false }));
    ctx.out.info(`Code sent to ${sent?.email ?? "your e-mail"}.`);
    const code = await ctx.prompt.text("E-mail code:", { validate: (v) => (/^\d{6}$/.test(v) ? null : "Enter the 6-digit code.") });
    const body = unwrap(await api.post("user/v1/user/login/2fa/email/verify", { challengeId: challenge.challengeId, code }, { auth: false }));
    if (body?.twoFactorDisabled) ctx.out.warn("Two-factor authentication was turned off. Re-enable it with `nimbuz auth 2fa enable`.");
    return body?.token;
  }

  const code =
    ctx.flags.code ||
    (await ctx.prompt.text("Authenticator code:", { validate: (v) => (/^\d{6}$/.test(v) ? null : "Enter the 6-digit code.") }));
  const body = unwrap(await api.post("user/v1/user/login/2fa/verify", { challengeId: challenge.challengeId, code }, { auth: false }));
  return body?.token;
}

async function saveSession(ctx, token, { orgName, username, apiUrl }) {
  const previous = ctx.config.profile;
  const changedTarget = (apiUrl && previous.apiUrl && previous.apiUrl !== apiUrl) || (orgName && previous.orgName && previous.orgName !== orgName);
  ctx.config.update({
    token,
    orgName: orgName ?? previous.orgName,
    username: username ?? previous.username,
    apiUrl: apiUrl ?? previous.apiUrl,
    updatedAt: new Date().toISOString()
  });
  if (changedTarget) {
    ctx.config.set("project", undefined);
    ctx.config.set("environment", undefined);
  }
  await ctx.config.save();
}

async function login(ctx) {
  const { flags } = ctx;
  const apiUrl = resolveApiUrl(flags.apiUrl) || ctx.config.get("apiUrl") || ctx.apiUrl;
  const api = new ApiClient({ baseUrl: apiUrl, debug: flags.debug });

  if (flags.token) {
    const token = flags.token === "-" ? (await readStdin()).trim() : flags.token;
    const verify = new ApiClient({ baseUrl: apiUrl, token, debug: flags.debug });
    await ctx.out.spin("Verifying token", verify.get("project/v1/projects"));
    const claims = tokenClaims(token);
    await saveSession(ctx, token, { orgName: claims.org, username: claims.email || claims.username, apiUrl });
    ctx.out.success(`Token saved for ${c.bold(claims.email || claims.username || "your account")}.`);
    return;
  }

  let orgName = flags.org || (flags.individual ? "nimbuz" : undefined);
  if (!orgName) {
    if (ctx.prompt.isInteractive()) {
      const type = await ctx.prompt.select("Account type", [
        { label: "Individual", value: "individual", hint: `app.${portalDomain(apiUrl)}` },
        { label: "Business", value: "business", hint: `<org>.${portalDomain(apiUrl)}` }
      ], { default: ctx.config.get("orgName") && ctx.config.get("orgName") !== "nimbuz" ? 1 : 0 });
      orgName =
        type === "individual"
          ? "nimbuz"
          : await ctx.prompt.text("Organization name:", {
              default: ctx.config.get("orgName") !== "nimbuz" ? ctx.config.get("orgName") : undefined
            });
    } else {
      orgName = ctx.config.get("orgName") || "nimbuz";
    }
  }

  const username =
    flags.username ||
    process.env.NIMBUZ_USERNAME ||
    (await ctx.prompt.text("E-mail:", { default: ctx.config.get("username") }));

  let password = process.env.NIMBUZ_PASSWORD;
  if (flags.passwordStdin) password = (await readStdin()).replace(/\r?\n$/, "");
  if (!password) password = await ctx.prompt.password("Password:");

  const body = unwrap(
    await ctx.out.spin("Signing in", api.post("user/v1/user/login", { username, password, orgName: orgName.toLowerCase() }, { auth: false }))
  );

  let token = body?.token;
  if (!token && body?.mfaRequired) token = await completeMfa(ctx, api, body);
  if (!token) throw new CliError("Login succeeded but no token was returned.");

  await saveSession(ctx, token, { orgName: orgName.toLowerCase(), username, apiUrl });
  const claims = tokenClaims(token);
  const who = claims.displayName || claims.email || username;
  const expiry = claims.expiresAt ? c.dim(` · session expires ${relativeTime(claims.expiresAt)}`) : "";
  ctx.out.success(`Logged in as ${c.bold(who)} ${c.dim(`(${orgName})`)}${expiry}`);
  if (!ctx.config.get("project")) ctx.out.hint("Next: `nimbuz projects list`, then `nimbuz use <project> [environment]`.");
}

async function logout(ctx) {
  const had = Boolean(ctx.config.get("token"));
  ctx.config.set("token", undefined);
  ctx.config.set("updatedAt", undefined);
  await ctx.config.save();
  if (had) ctx.out.success(`Logged out${ctx.config.profileName !== "default" ? ` of profile ${ctx.config.profileName}` : ""}.`);
  else ctx.out.info("You were not logged in.");
}

async function status(ctx) {
  const token = ctx.config.token();
  const claims = tokenClaims(token);
  const expired = token ? isExpired(token) : false;
  const data = {
    loggedIn: Boolean(token) && !expired,
    profile: ctx.config.profileName,
    apiUrl: ctx.apiUrl,
    org: claims.org ?? ctx.config.get("orgName"),
    user: claims.email || claims.username || ctx.config.get("username"),
    userId: claims.userId,
    accountId: claims.accountId,
    expiresAt: claims.expiresAt?.toISOString(),
    tokenSource: process.env.NIMBUZ_TOKEN ? "NIMBUZ_TOKEN" : token ? configPath() : null,
    project: ctx.config.get("project")?.name,
    environment: ctx.config.get("environment")?.name
  };
  ctx.out.result(data, () => {
    if (!token) {
      ctx.out.write(`${c.yellow("○")} Not logged in. Run ${c.cmd("nimbuz login")}.`);
      return;
    }
    const state = expired ? c.red("✖ session expired") : c.green("● logged in");
    ctx.out.kv([
      ["Status", state],
      ["User", `${data.user ?? "-"}${claims.displayName ? c.dim(` (${claims.displayName})`) : ""}`],
      ["Organization", data.org],
      ["Account ID", data.accountId],
      ["User ID", data.userId],
      ["Expires", claims.expiresAt ? `${formatDate(claims.expiresAt)} ${c.dim(`(${relativeTime(claims.expiresAt)})`)}` : "-"],
      ["API", data.apiUrl],
      ["Profile", data.profile],
      ["Context", data.project ? `${data.project}${data.environment ? ` / ${data.environment}` : ""}` : c.dim("none — run `nimbuz use`")],
      ["Token", data.tokenSource]
    ]);
    if (expired) ctx.out.hint("\nRun `nimbuz login` to start a new session.");
  });
}

async function printToken(ctx) {
  const token = ctx.config.token();
  if (!token) throw new CliError("You are not logged in.", { exitCode: 4, hint: "Run `nimbuz login`." });
  if (isExpired(token)) ctx.out.warn("This token has expired.");
  process.stdout.write(`${token}\n`);
}

async function twoFactorStatus(ctx) {
  const data = unwrap(await ctx.api.get("user/v1/user/2fa"));
  ctx.out.result(data, () =>
    ctx.out.kv([
      ["Two-factor", data?.enabled ? c.green("● enabled") : c.yellow("○ disabled")],
      ["Method", data?.method ?? "-"]
    ])
  );
}

async function twoFactorEnable(ctx) {
  const setup = unwrap(await ctx.api.post("user/v1/user/2fa/setup", {}));
  ctx.out.write(`Add this key to your authenticator app (Google Authenticator, 1Password, Authy…):\n`);
  ctx.out.kv([
    ["Secret", c.bold(setup?.secret ?? "-")],
    ["otpauth URL", setup?.otpauthUrl ?? "-"]
  ]);
  ctx.out.write("");
  const code = ctx.flags.code || (await ctx.prompt.text("Enter the 6-digit code to confirm:", { validate: (v) => (/^\d{6}$/.test(v) ? null : "Enter 6 digits.") }));
  await ctx.api.post("user/v1/user/2fa/enable", { setupToken: setup.setupToken, code });
  ctx.out.success("Two-factor authentication enabled.");
}

async function twoFactorDisable(ctx) {
  const code = ctx.flags.code || (await ctx.prompt.text("Current authenticator code:", { validate: (v) => (/^\d{6}$/.test(v) ? null : "Enter 6 digits.") }));
  await ctx.api.post("user/v1/user/2fa/disable", { code });
  ctx.out.success("Two-factor authentication disabled.");
}

async function changePassword(ctx) {
  const claims = ctx.claims;
  const oldPassword = await ctx.prompt.password("Current password:");
  const password = await ctx.prompt.password("New password:");
  const again = await ctx.prompt.password("Repeat new password:");
  if (password !== again) throw new UsageError("Passwords do not match.");
  await ctx.api.post("user/v1/user/reset-password", {
    oldPassword,
    password,
    orgName: claims.org || ctx.config.get("orgName"),
    username: claims.username || ctx.config.get("username")
  });
  ctx.out.success("Password changed.");
}

async function forgotPassword(ctx) {
  const orgName = ctx.flags.org || ctx.config.get("orgName") || "nimbuz";
  const username = ctx.flags.username || ctx.config.get("username") || (await ctx.prompt.text("E-mail:"));
  await new ApiClient({ baseUrl: ctx.apiUrl }).post(
    "user/v1/user/forgot-password",
    { username, orgName, type: orgName === "nimbuz" ? "individual" : "business" },
    { auth: false }
  );
  ctx.out.success(`If an account exists for ${username}, a reset link is on its way.`);
}

export const loginCommand = {
  name: "login",
  summary: "Log in to Nimbuz",
  category: "Getting started",
  description: "Log in with your Nimbuz credentials and save the session locally. Supports two-factor authentication.",
  flags: loginFlags,
  examples: [
    "nimbuz login",
    "nimbuz login --individual -u jane@example.com",
    "nimbuz login --org acme -u jane@acme.com",
    "# CI: read the password from a secret",
    "echo \"$NIMBUZ_PASSWORD\" | nimbuz login --org acme -u ci@acme.com --password-stdin"
  ],
  run: login
};

export const logoutCommand = {
  name: "logout",
  summary: "Remove the saved session",
  category: "Getting started",
  run: logout
};

export const whoamiCommand = {
  name: "whoami",
  summary: "Show the logged-in user and current context",
  category: "Getting started",
  run: status
};

export const authCommand = {
  name: "auth",
  summary: "Sessions, tokens, 2FA and password",
  category: "Account",
  commands: [
    { ...loginCommand, category: undefined },
    { ...logoutCommand, category: undefined },
    { name: "status", summary: "Show session status", run: status },
    {
      name: "token",
      summary: "Print the access token (for scripts)",
      examples: ['curl -H "Authorization: Bearer $(nimbuz auth token)" https://api.nimbuz.tech/project/v1/projects'],
      run: printToken
    },
    {
      name: "2fa",
      summary: "Manage two-factor authentication",
      commands: [
        { name: "status", summary: "Show whether 2FA is enabled", run: twoFactorStatus },
        { name: "enable", summary: "Set up an authenticator app", flags: [{ name: "code", type: "string", desc: "Confirmation code" }], run: twoFactorEnable },
        { name: "disable", summary: "Turn 2FA off", flags: [{ name: "code", type: "string", desc: "Current authenticator code" }], run: twoFactorDisable }
      ]
    },
    { name: "change-password", summary: "Change your password", run: changePassword },
    {
      name: "forgot-password",
      summary: "E-mail a password reset link",
      flags: [
        { name: "username", alias: "u", type: "string", desc: "Username / e-mail" },
        { name: "org", type: "string", desc: "Organization name" }
      ],
      run: forgotPassword
    }
  ]
};
