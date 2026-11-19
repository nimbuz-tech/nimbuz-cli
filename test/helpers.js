import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "nimbuz.js");

/** Fake JWT with the claims the CLI reads. */
export function fakeToken(overrides = {}) {
  const payload = {
    owner: "nimbuz",
    name: "jane",
    email: "jane@example.com",
    displayName: "Jane",
    exp: Math.floor(Date.now() / 1000) + 3600,
    properties: { nimbuzUserId: "user-1", nimbuzAccountId: "acct-1" },
    ...overrides
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

/**
 * Starts a mock API. `routes` maps "METHOD /path" to (req) => [status, body] | body.
 * Every request is recorded in `server.requests`.
 */
export async function mockApi(routes) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://localhost");
    const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(record);
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: `No mock for ${req.method} ${url.pathname}` } }));
      return;
    }
    let result = typeof handler === "function" ? await handler(record) : handler;
    let status = 200;
    if (Array.isArray(result) && typeof result[0] === "number") [status, result] = result;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    find: (method, pathname) => requests.filter((r) => r.method === method && r.path === pathname),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function tempConfigDir() {
  return mkdtemp(path.join(os.tmpdir(), "nimbuz-cli-test-"));
}

/** Runs the CLI and resolves { code, stdout, stderr }. */
export function run(args, { env = {}, input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), NO_COLOR: "1", CI: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}
