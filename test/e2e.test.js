import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { fakeToken, mockApi, run, tempConfigDir } from "./helpers.js";

const PROJECT = { id: "3f9b2c1e-8a4d-4f6e-9b0a-1c2d3e4f5a6b", name: "shop", description: "Web shop" };
const ENV = { id: "env-k3x9q2m7", name: "production", region: "ap-south-1" };
const APP = {
  id: "7c1d0000-0000-4000-8000-000000000001",
  name: "shop-api",
  status: "SUCCESS",
  application: { instanceType: "small.m", replicas: 1 },
  network: { port: 3000, appIngressDomain: "shop-api.dev.lb.nimbuz.tech" },
  sourceCode: { type: "vcs", gitUrl: "https://github.com/acme/shop-api.git -b main" },
  environment: { NODE_ENV: "production" },
  secret: { DB: "postgres://x" }
};

let api;
let configDir;
const token = fakeToken();

before(async () => {
  api = await mockApi({
    "POST /user/v1/user/login": ({ body }) =>
      body.password === "right" ? { status: "success", data: { mfaRequired: true, challengeId: "c-1", methods: ["totp"], expiresIn: 300 } } : [400, { status: "error", error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } }],
    "POST /user/v1/user/login/2fa/verify": ({ body }) => (body.code === "123456" ? { status: "success", data: { token } } : [400, { status: "error", error: { message: "Bad code" } }]),
    "GET /project/v1/projects": { status: "Success", data: [PROJECT, { id: "11111111-1111-4111-8111-111111111111", name: "blog" }] },
    "GET /project/v1/environments": ({ query }) => ({ status: "Success", data: query.id ? { ...ENV, cpuMaxUserLimit: 2, cpuMaxPlatformLimit: 4 } : [ENV] }),
    "GET /deployment/v1/deployments/list": { status: "success", data: [APP] },
    "GET /deployment/v1/deployments": { status: "success", data: APP },
    "POST /deployment/v1/deployments": ({ body }) => [201, { status: "success", data: { ...APP, id: "new-id", name: body.name, status: "Pending" } }],
    [`PUT /deployment/v1/deployments/${APP.id}`]: { status: "success", data: APP },
    "POST /logs/v1/logs": ({ body }) => ({
      status: "success",
      // Like the real service: newest first.
      data: { page: body.page, totalPages: 2, logs: body.page === 1 ? ["2026-11-05T10:02:00Z ok", "2026-11-05T10:01:00Z ERROR db down"] : ["2026-11-05T10:00:00Z boot"] }
    }),
    "GET /pricing/v1/public/pricing-catalog": { success: true, data: [{ instanceType: "small.m", cpuVcpu: 1, memoryGb: 2, instanceHourRate: 0.02, currency: "USD" }] },
    "GET /pricing/v1/invoices": { success: true, data: { data: [{ id: "inv-1", period: "2026-10", total: 12.5, currency: "USD", status: "paid" }], total: 1 } }
  });
  configDir = await tempConfigDir();
});

after(() => api.close());

const env = () => ({ NIMBUZ_CONFIG_DIR: configDir, NIMBUZ_API_URL: api.url });

test("login with 2FA saves the session", async () => {
  const bad = await run(["login", "--individual", "-u", "jane@example.com", "--password-stdin"], { env: env(), input: "wrong\n" });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Invalid credentials/);

  const ok = await run(["login", "--individual", "-u", "jane@example.com", "--password-stdin", "--code", "123456"], { env: env(), input: "right\n" });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /Logged in as Jane/);
  const login = api.find("POST", "/user/v1/user/login").at(-1);
  assert.deepEqual(login.body, { username: "jane@example.com", password: "right", orgName: "nimbuz" });
  const saved = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8"));
  assert.equal(saved.profiles.default.token, token);
});

test("whoami --json reflects token claims", async () => {
  const result = await run(["whoami", "--json"], { env: env() });
  const data = JSON.parse(result.stdout);
  assert.equal(data.loggedIn, true);
  assert.equal(data.accountId, "acct-1");
});

test("use resolves names and remembers the context", async () => {
  const result = await run(["use", "sho"], { env: env() });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Now using shop \/ production/);
  const ambiguous = await run(["use", "nope"], { env: env() });
  assert.equal(ambiguous.code, 5);
  assert.match(ambiguous.stderr, /Available: shop, blog/);
});

test("apps list uses the saved context and sends the bearer token", async () => {
  const result = await run(["apps", "ls", "--json"], { env: env() });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].name, "shop-api");
  const request = api.find("GET", "/deployment/v1/deployments/list").at(-1);
  assert.deepEqual(request.query, { projectId: PROJECT.id, environmentId: ENV.id });
  assert.equal(request.headers.authorization, `Bearer ${token}`);
});

test("apps create builds the documented request body", async () => {
  const result = await run(["apps", "create", "web-shop", "--repo", "acme/web", "-b", "dev", "--port", "8080", "-e", "A=1", "-s", "S=2", "--autoscale", "1:3", "--json"], { env: env() });
  assert.equal(result.code, 0, result.stderr);
  const { body } = api.find("POST", "/deployment/v1/deployments").at(-1);
  assert.deepEqual(body, {
    name: "web-shop",
    projectId: PROJECT.id,
    environmentId: ENV.id,
    sourceCode: { type: "vcs", gitUrl: "https://github.com/acme/web.git -b dev", vcsAutoDeploy: false, folderPath: "", dockerFileName: "" },
    application: { instanceType: "small.m" },
    network: { port: 8080 },
    config: { name: "", path: "", data: "" },
    hpa: { hpaEnabled: true, hpaMinReplicas: 1, hpaMaxReplicas: 3 },
    environment: { A: "1" },
    secret: { S: "2" }
  });
});

test("apps env set merges with existing variables", async () => {
  const result = await run(["apps", "env", "set", "shop-api", "LOG=debug"], { env: env() });
  assert.equal(result.code, 0, result.stderr);
  const { body } = api.find("PUT", `/deployment/v1/deployments/${APP.id}`).at(-1);
  assert.deepEqual(body, { projectId: PROJECT.id, environmentId: ENV.id, environment: { NODE_ENV: "production", LOG: "debug" } });
});

test("apps stop sends the pause action; delete requires --yes without a TTY", async () => {
  const stop = await run(["apps", "stop", "shop-api"], { env: env() });
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(api.find("PUT", `/deployment/v1/deployments/${APP.id}`).at(-1).body.action, "pause");
  const del = await run(["apps", "delete", "shop-api"], { env: env() });
  assert.equal(del.code, 2);
  assert.match(del.stderr, /--yes/);
});

test("deploy updates an existing app from nimbuz.json", async () => {
  const dir = await tempConfigDir();
  await writeFile(path.join(dir, "nimbuz.json"), JSON.stringify({ name: "shop-api", instance: "medium.m", vars: { FEATURE: "on" } }));
  const result = await run(["deploy", "--no-wait"], { env: env(), cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  const { body } = api.find("PUT", `/deployment/v1/deployments/${APP.id}`).at(-1);
  assert.equal(body.application.instanceType, "medium.m");
  assert.deepEqual(body.environment, { NODE_ENV: "production", FEATURE: "on" });
  assert.equal(body.sourceCode.gitUrl, APP.sourceCode.gitUrl);
});

test("logs --all prints every page oldest to newest", async () => {
  const result = await run(["logs", "shop-api", "--all"], { env: env() });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["2026-11-05T10:00:00Z boot", "2026-11-05T10:01:00Z ERROR db down", "2026-11-05T10:02:00Z ok"]);
});

test("logs fetches the tail across pages", async () => {
  const result = await run(["logs", "shop-api", "-n", "2", "--since", "1h"], { env: env() });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["2026-11-05T10:01:00Z ERROR db down", "2026-11-05T10:02:00Z ok"]);
  const request = api.find("POST", "/logs/v1/logs").at(-1);
  assert.equal(request.body.timeRange, "1h");
  assert.equal(request.body.logType, "application");
});

test("billing: public pricing without auth, invoices with the account id", async () => {
  const pricing = await run(["billing", "pricing", "--json"], { env: { ...env(), NIMBUZ_CONFIG_DIR: await tempConfigDir() } });
  assert.equal(pricing.code, 0, pricing.stderr);
  assert.equal(api.find("GET", "/pricing/v1/public/pricing-catalog").at(-1).headers.authorization, undefined);
  const invoices = await run(["billing", "invoices", "--json"], { env: env() });
  assert.equal(JSON.parse(invoices.stdout)[0].id, "inv-1");
  assert.equal(api.find("GET", "/pricing/v1/invoices").at(-1).query.account_id, "acct-1");
});

test("api command fills context placeholders", async () => {
  const result = await run(["api", "/deployment/v1/deployments/list", "-Q", "projectId={projectId}", "-Q", "environmentId={environmentId}"], { env: env() });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(api.find("GET", "/deployment/v1/deployments/list").at(-1).query, { projectId: PROJECT.id, environmentId: ENV.id });
});

test("401 responses map to exit code 4 with a login hint", async () => {
  const expired = await mockApi({ "GET /project/v1/projects": [401, { status: "error", data: { errorMessage: "Invalid token or some Error" } }] });
  const result = await run(["projects", "list"], { env: { ...env(), NIMBUZ_API_URL: expired.url } });
  await expired.close();
  assert.equal(result.code, 4);
  assert.match(result.stderr, /Invalid token/);
  assert.match(result.stderr, /nimbuz login/);
});

test("v0.1 config files are migrated", async () => {
  const dir = await tempConfigDir();
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ accessToken: token }));
  const result = await run(["auth", "status", "--json"], { env: { NIMBUZ_CONFIG_DIR: dir } });
  const data = JSON.parse(result.stdout);
  assert.equal(data.loggedIn, true);
  assert.equal(data.apiUrl, "https://api.dev.nimbuz.tech");
});

test("production is the default and dev options stay out of help", async () => {
  const dir = await tempConfigDir();
  const status = JSON.parse((await run(["whoami", "--json"], { env: { NIMBUZ_CONFIG_DIR: dir } })).stdout);
  assert.equal(status.apiUrl, "https://api.nimbuz.tech");
  for (const args of [["--help"], ["login", "--help"], ["config", "set", "--help"], ["apps", "list", "--help"]]) {
    const { stdout } = await run(args, { env: { NIMBUZ_CONFIG_DIR: dir } });
    assert.doesNotMatch(stdout, /api-url|\bdev\b|api\.dev/, `nimbuz ${args.join(" ")}`);
  }
});
