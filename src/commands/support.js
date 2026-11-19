import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { c } from "../core/colors.js";
import { CliError, UsageError } from "../core/errors.js";
import { unwrap } from "../core/http.js";
import { statusBadge } from "../core/output.js";
import { asArray, formatBytes, relativeTime } from "../core/util.js";

const GROUPS = ["Technical", "Account & Access", "Feature Requests", "General"];
const PRIORITY = { low: 1, normal: 2, high: 3 };
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain", ".json": "application/json", ".zip": "application/zip" };

async function attachments(files) {
  if (files.length > 5) throw new UsageError("At most 5 attachments.");
  let total = 0;
  const result = [];
  for (const file of files) {
    const info = await stat(file).catch(() => {
      throw new UsageError(`File not found: ${file}`);
    });
    if (info.size > 10 * 1024 * 1024) throw new UsageError(`${file} is larger than 10 MB.`);
    total += info.size;
    if (total > 20 * 1024 * 1024) throw new UsageError("Attachments exceed 20 MB in total.");
    result.push({ filename: path.basename(file), data: (await readFile(file)).toString("base64"), mimeType: MIME[path.extname(file).toLowerCase()] });
  }
  return result;
}

async function tickets(ctx) {
  const data = unwrap(await ctx.api.get("user/v1/support/tickets", { query: { status: ctx.flags.status, includeThread: true, threadLimit: 20 } }));
  const open = asArray(data?.reopen?.tickets ?? (data?.status === "reopen" ? data.tickets : []));
  const closed = asArray(data?.close?.tickets ?? (data?.status === "close" ? data.tickets : []));
  return { open, closed, all: [...open.map((t) => ({ ...t, bucket: "open" })), ...closed.map((t) => ({ ...t, bucket: "closed" }))] };
}

async function list(ctx) {
  const { all } = await ctx.out.spin("Loading tickets", tickets(ctx));
  all.sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
  ctx.out.table(all, [
    { header: "#", key: "number" },
    { header: "ID", key: "id" },
    { header: "Title", key: "title" },
    { header: "State", get: (t) => t.state || t.bucket, format: statusBadge },
    { header: "Messages", key: "thread.totalMessages" },
    { header: "Last reply", get: (t) => t.thread?.lastAgentReplyAt, format: relativeTime },
    { header: "Updated", key: "updatedAt", format: relativeTime }
  ], { empty: "No support tickets.", idKey: "id" });
}

async function show(ctx) {
  const { all } = await ctx.out.spin("Loading ticket", tickets(ctx));
  const ticket = all.find((t) => String(t.id) === ctx.args.ticket || String(t.number) === ctx.args.ticket);
  if (!ticket) throw new CliError(`Ticket ${ctx.args.ticket} not found.`);
  ctx.out.result(ticket, () => {
    ctx.out.write(`${c.bold(`#${ticket.number} ${ticket.title}`)}  ${statusBadge(ticket.state || ticket.bucket)}\n`);
    for (const article of asArray(ticket.thread?.articles)) {
      const who = article.sender === "Agent" ? c.magenta("Nimbuz support") : c.cyan("You");
      ctx.out.write(`${who} ${c.dim(relativeTime(article.createdAt))}`);
      const body = String(article.body ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
      ctx.out.write(body.split("\n").map((line) => `  ${line}`).join("\n"));
      for (const file of asArray(article.attachments)) ctx.out.write(c.dim(`  📎 ${file.filename} (${formatBytes(file.size)})`));
      ctx.out.write("");
    }
    ctx.out.hint(`Reply: nimbuz support reply ${ticket.id} -m "…"`);
  });
}

async function create(ctx) {
  const subject = ctx.flags.subject || (await ctx.prompt.text("Subject:", { validate: (v) => (v.length >= 3 ? null : "At least 3 characters.") }));
  const description = ctx.flags.message || (await ctx.prompt.text("Describe the problem:"));
  const body = {
    subject,
    description,
    group: ctx.flags.group,
    priority: PRIORITY[ctx.flags.priority],
    attachments: await attachments(ctx.flags.attach)
  };
  if (!body.attachments.length) delete body.attachments;
  const data = unwrap(await ctx.out.spin("Creating ticket", ctx.api.post("user/v1/support/tickets", body)));
  ctx.out.result(data, () => ctx.out.success(`Opened ticket ${c.bold(`#${data?.ticket?.number ?? data?.ticket?.id ?? ""}`)} — we'll reply by e-mail.`));
}

async function reply(ctx) {
  const description = ctx.flags.message || (await ctx.prompt.text("Reply:"));
  const body = { ticketId: Number(ctx.args.ticket), description, attachments: await attachments(ctx.flags.attach) };
  if (!body.attachments.length) delete body.attachments;
  try {
    const data = unwrap(await ctx.out.spin("Sending reply", ctx.api.post("user/v1/support/tickets", body)));
    ctx.out.result(data, () => ctx.out.success(`Replied to #${data?.ticket?.number ?? ctx.args.ticket}${data?.reopened ? " (ticket reopened)" : ""}.`));
  } catch (error) {
    if (error.status === 409) throw new CliError("This ticket was merged into another one. Run `nimbuz support list` to find it.");
    if (error.status === 413) throw new CliError("Attachments are too large (max 20 MB).");
    throw error;
  }
}

const ATTACH = { name: "attach", alias: "a", type: "list", placeholder: "file", desc: "Attach a file (max 5, 10 MB each)" };

export const supportCommand = {
  name: "support",
  aliases: ["tickets", "help-desk"],
  summary: "Support tickets",
  category: "Account",
  commands: [
    { name: "list", aliases: ["ls"], summary: "List your tickets", flags: [{ name: "status", type: "string", default: "all", choices: ["all", "reopen", "close"], desc: "Filter" }], run: list },
    { name: "show", aliases: ["view"], summary: "Show a ticket conversation", args: [{ name: "ticket", required: true, desc: "Ticket ID or number" }], flags: [{ name: "status", type: "string", default: "all", hidden: true }], run: show },
    {
      name: "create",
      aliases: ["new", "open"],
      summary: "Open a ticket",
      flags: [
        { name: "subject", type: "string", desc: "Subject" },
        { name: "message", alias: "m", type: "string", desc: "Description" },
        { name: "group", type: "string", default: "Technical", choices: GROUPS, desc: "Category" },
        { name: "priority", type: "string", default: "normal", choices: Object.keys(PRIORITY), desc: "Priority" },
        ATTACH
      ],
      examples: ['nimbuz support create --subject "Build stuck" -m "shop-api build has been queued for 1h" -a build.log'],
      run: create
    },
    {
      name: "reply",
      summary: "Reply to a ticket",
      args: [{ name: "ticket", required: true, desc: "Ticket ID" }],
      flags: [{ name: "message", alias: "m", type: "string", desc: "Reply text" }, ATTACH],
      run: reply
    }
  ]
};
