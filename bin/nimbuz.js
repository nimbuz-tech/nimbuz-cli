#!/usr/bin/env node

const [major] = process.versions.node.split(".").map(Number);
if (major < 18) {
  console.error(`nimbuz requires Node.js 18 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const { runCli, reportError } = await import("../src/cli.js");

// Exit quietly when piped into a closed reader (e.g. `nimbuz logs app | head`).
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportError(error);
}
