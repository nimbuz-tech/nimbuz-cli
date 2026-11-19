import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs } from "../src/core/args.js";
import { extractError, redact } from "../src/core/http.js";
import { buildRoot } from "../src/cli.js";
import { route } from "../src/core/registry.js";
import { buildSpec, normalizeRepo, updateBody } from "../src/lib/spec.js";
import { parseDotenv, parseDuration, asArray } from "../src/core/util.js";

const specs = [
  { name: "repo", alias: "r", type: "string" },
  { name: "port", type: "number" },
  { name: "wait", alias: "w", type: "boolean" },
  { name: "yes", alias: "y", type: "boolean" },
  { name: "env-var", alias: "e", type: "list" }
];

test("parseArgs handles long, short, inline, negated, lists and clusters", () => {
  const { flags, positionals } = parseArgs(["app", "-r", "acme/x", "--port=3000", "-e", "A=1", "--env-var", "B=2", "-wy", "--no-wait", "--", "-literal"], specs);
  assert.deepEqual(positionals, ["app", "-literal"]);
  assert.equal(flags.repo, "acme/x");
  assert.equal(flags.port, 3000);
  assert.deepEqual(flags.envVar, ["A=1", "B=2"]);
  assert.equal(flags.yes, true);
  assert.equal(flags.wait, false);
});

test("parseArgs rejects unknown flags with a suggestion", () => {
  assert.throws(() => parseArgs(["--prot", "1"], specs), (error) => error.hint === "Did you mean --port?");
  assert.throws(() => parseArgs(["--port", "abc"], specs), /expects a number/);
  assert.throws(() => parseArgs(["--repo"], specs), /requires a value/);
});

test("route finds nested commands and skips flag values", () => {
  const root = buildRoot();
  const { node, rest } = route(root, ["--project", "apps", "apps", "env", "set", "web", "A=1"]);
  assert.equal(node.name, "set");
  assert.deepEqual(rest, ["--project", "apps", "web", "A=1"]);
  assert.equal(route(root, ["deployments", "ls"]).node.name, "list");
});

test("normalizeRepo accepts shorthand, ssh and branch suffix", () => {
  assert.deepEqual(normalizeRepo("acme/shop"), { url: "https://github.com/acme/shop.git", branch: undefined });
  assert.deepEqual(normalizeRepo("git@gitlab.com:acme/shop.git"), { url: "https://gitlab.com/acme/shop.git", branch: undefined });
  assert.deepEqual(normalizeRepo("https://bitbucket.org/acme/shop -b dev"), { url: "https://bitbucket.org/acme/shop.git", branch: "dev" });
  assert.throws(() => normalizeRepo("https://example.com/acme/shop"), /Unsupported repository/);
});

test("buildSpec merges manifest, flags and ${VAR} interpolation", async () => {
  process.env.TEST_DB_URL = "postgres://db";
  const spec = await buildSpec(
    { repo: undefined, branch: "release", envVar: ["B=2"], secret: [], instance: "medium.m", autoscale: "2:5" },
    { name: "shop", source: { repo: "acme/shop" }, vars: { A: "1" }, secrets: { DATABASE_URL: "${TEST_DB_URL}" }, port: 3000, __dir: process.cwd() }
  );
  assert.equal(spec.source.repo, "https://github.com/acme/shop.git");
  assert.equal(spec.source.branch, "release");
  assert.deepEqual(spec.vars, { A: "1", B: "2" });
  assert.deepEqual(spec.secrets, { DATABASE_URL: "postgres://db" });
  assert.deepEqual(spec.autoscale, { hpaEnabled: true, hpaMinReplicas: 2, hpaMaxReplicas: 5 });
  await assert.rejects(buildSpec({ envVar: [], secret: [] }, { secrets: { X: "${NOPE_NOT_SET}" } }), /NOPE_NOT_SET is not set/);
});

test("updateBody only sends changed fields and merges variables", async () => {
  const spec = await buildSpec({ envVar: ["NEW=1"], secret: [], replicas: 3 });
  const current = {
    sourceCode: { type: "vcs", gitUrl: "https://github.com/acme/shop.git -b main", extra: "x" },
    application: { replicas: 1, instanceType: "small.m", junk: null },
    environment: { OLD: "0" }
  };
  const body = await updateBody(null, { projectId: "p", environmentId: "e" }, spec, current);
  assert.deepEqual(body, {
    projectId: "p",
    environmentId: "e",
    application: { replicas: 3, instanceType: "small.m" },
    environment: { OLD: "0", NEW: "1" }
  });
});

test("extractError understands the services' error shapes", () => {
  assert.equal(extractError({ status: "error", error: { code: "X", message: "Boom" } }).message, "Boom");
  assert.equal(extractError({ status: "error", data: { errorMessage: "Invalid token" } }).message, "Invalid token");
  assert.equal(extractError({ message: "Validation Error", details: ["Name too short"] }).message, "Name too short");
  assert.equal(extractError({ customError: true, response: { error: { code: "PROJECT_NOT_FOUND", message: "Missing" } } }).code, "PROJECT_NOT_FOUND");
  assert.equal(extractError({ error: "Invoice PDF not generated" }).message, "Invoice PDF not generated");
});

test("utilities", () => {
  assert.equal(parseDuration("15m"), 900_000);
  assert.deepEqual(parseDotenv('# c\nA=1\nexport B="two words"\nC=x # note\n'), { A: "1", B: "two words", C: "x" });
  assert.deepEqual(asArray({ mongo: { name: "MongoDB" } }), [{ id: "mongo", name: "MongoDB" }]);
});

test("debug redaction masks sensitive keys and every secret value", () => {
  const out = redact(JSON.stringify({ values: { "postgresql.auth.postgresPassword": "Pw123456", size: "1Gi" }, secret: { DB: "postgres://u:p@h" }, environment: { A: "1" }, apiKey: "k" }));
  assert.doesNotMatch(out, /Pw123456|postgres:\/\/|"k"/);
  assert.match(out, /"size":"1Gi"/);
  assert.match(out, /"A":"1"/);
});

test("connection failures are retried even for POST, then reported", async () => {
  const { ApiClient } = await import("../src/core/http.js");
  // Grab a free port and close it again, so connections are refused.
  const net = await import("node:net");
  const port = await new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });
  const started = Date.now();
  await assert.rejects(client.post("user/v1/user/login", { a: 1 }, { auth: false }), (error) => /Could not reach/.test(error.message) && /Tried 4 times/.test(error.hint));
  assert.ok(Date.now() - started >= 3000, "backs off between attempts");
});
