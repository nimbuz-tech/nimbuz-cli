import { c, stripAnsi, visibleLength } from "./colors.js";

const STATUS_CLASSES = {
  ok: [
    "success", "succeeded", "active", "running", "deployed", "subscribed", "verified", "issued",
    "enabled", "paid", "accessible", "healthy", "ready", "completed", "complete", "open", "connected"
  ],
  progress: [
    "initiated", "building", "deploying", "pending", "queued", "starting", "updating", "in progress",
    "in_progress", "provisioning", "installing", "creating", "restarting", "rolling", "new"
  ],
  warn: [
    "degraded", "degrading", "paused", "stopped", "superseded", "cancelled", "canceled", "disabled",
    "draft", "pending_dns", "suspended", "inactive", "reopen", "unpaid", "overdue", "partially_paid"
  ],
  error: [
    "failed", "build failed", "build timeout", "deploy failed", "deploy timeout", "create job failed",
    "error", "unreachable", "revoked", "crashloopbackoff", "expired", "void"
  ]
};

export function statusClass(status) {
  const value = String(status ?? "").trim().toLowerCase();
  if (!value) return "muted";
  for (const [name, list] of Object.entries(STATUS_CLASSES)) {
    if (list.includes(value)) return name;
  }
  if (/fail|error|timeout/.test(value)) return "error";
  if (/ing$/.test(value)) return "progress";
  return "muted";
}

export function statusBadge(status) {
  if (status === undefined || status === null || status === "") return c.dim("-");
  const text = String(status);
  switch (statusClass(text)) {
    case "ok":
      return `${c.green("●")} ${text}`;
    case "progress":
      return `${c.cyan("◐")} ${text}`;
    case "warn":
      return `${c.yellow("○")} ${text}`;
    case "error":
      return `${c.red("✖")} ${text}`;
    default:
      return `${c.gray("○")} ${text}`;
  }
}

function termWidth() {
  return process.stdout.columns || 120;
}

function truncate(value, width) {
  const text = String(value ?? "");
  if (visibleLength(text) <= width) return text;
  const plain = stripAnsi(text);
  if (width <= 1) return plain.slice(0, width);
  return `${[...plain].slice(0, width - 1).join("")}…`;
}

function pad(value, width) {
  const text = String(value ?? "");
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function getValue(row, column) {
  if (typeof column.get === "function") return column.get(row);
  return column.key.split(".").reduce((acc, part) => (acc == null ? undefined : acc[part]), row);
}

/**
 * Prints a borderless table.
 * columns: [{ header, key | get, format?(value,row), width?, flex? }]
 */
export function renderTable(rows, columns) {
  const cells = rows.map((row) =>
    columns.map((column) => {
      const raw = getValue(row, column);
      const formatted = column.format ? column.format(raw, row) : raw;
      if (formatted === undefined || formatted === null || formatted === "") return c.dim("-");
      return String(formatted).replace(/\s*\n\s*/g, " ");
    })
  );
  const headers = columns.map((column) => column.header.toUpperCase());
  const widths = headers.map((header, index) =>
    Math.max(visibleLength(header), ...cells.map((row) => visibleLength(row[index])))
  );

  // Shrink flexible columns until the table fits the terminal.
  const gap = 3;
  const available = termWidth();
  let total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  const flexIndexes = columns
    .map((column, index) => (column.flex === false ? -1 : index))
    .filter((index) => index >= 0);
  while (total > available && flexIndexes.length) {
    const widest = flexIndexes.reduce((best, index) => (widths[index] > widths[best] ? index : best), flexIndexes[0]);
    const minWidth = Math.max(8, visibleLength(headers[widest]));
    if (widths[widest] <= minWidth) {
      flexIndexes.splice(flexIndexes.indexOf(widest), 1);
      continue;
    }
    const shrink = Math.min(widths[widest] - minWidth, total - available);
    widths[widest] -= shrink;
    total -= shrink;
  }

  const spacer = " ".repeat(gap);
  const lines = [];
  lines.push(headers.map((header, index) => c.dim(c.bold(pad(header, widths[index])))).join(spacer).trimEnd());
  for (const row of cells) {
    lines.push(row.map((cell, index) => pad(truncate(cell, widths[index]), widths[index])).join(spacer).trimEnd());
  }
  return lines.join("\n");
}

export function renderKeyValues(entries, { indent = 0 } = {}) {
  const visible = entries.filter((entry) => entry && entry[1] !== undefined);
  const width = Math.max(0, ...visible.map(([key]) => visibleLength(key)));
  const prefix = " ".repeat(indent);
  return visible
    .map(([key, value]) => {
      const text = value === null || value === "" ? c.dim("-") : String(value);
      const lines = text.split("\n");
      const head = `${prefix}${c.dim(pad(key, width))}  ${lines[0]}`;
      const rest = lines.slice(1).map((line) => `${prefix}${" ".repeat(width + 2)}${line}`);
      return [head, ...rest].join("\n");
    })
    .join("\n");
}

const SPARK = "▁▂▃▄▅▆▇█";

export function sparkline(values, width = 40) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (!numbers.length) return c.dim("(no data)");
  let series = numbers;
  if (numbers.length > width) {
    const bucket = numbers.length / width;
    series = Array.from({ length: width }, (_, i) => {
      const slice = numbers.slice(Math.floor(i * bucket), Math.floor((i + 1) * bucket) || undefined);
      return slice.reduce((sum, n) => sum + n, 0) / (slice.length || 1);
    });
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  return series.map((n) => SPARK[Math.round(((n - min) / range) * (SPARK.length - 1))]).join("");
}

export function bar(ratio, width = 20) {
  const value = Math.max(0, Math.min(1, Number(ratio) || 0));
  const filled = Math.round(value * width);
  const paint = value >= 0.9 ? c.red : value >= 0.7 ? c.yellow : c.green;
  return `${paint("█".repeat(filled))}${c.dim("░".repeat(width - filled))}`;
}

/** Output sink bound to the current invocation's flags. */
export class Output {
  constructor({ json = false, quiet = false } = {}) {
    this.jsonMode = json;
    this.quiet = quiet;
    this.spinner = null;
  }

  write(text = "") {
    this.stopSpinner();
    process.stdout.write(`${text}\n`);
  }

  log(text = "") {
    // Human-oriented chatter goes to stderr so stdout stays pipeable.
    if (this.quiet) return;
    this.stopSpinner();
    process.stderr.write(`${text}\n`);
  }

  success(message) {
    this.log(`${c.green("✔")} ${message}`);
  }

  info(message) {
    this.log(`${c.cyan("›")} ${message}`);
  }

  warn(message) {
    this.stopSpinner();
    process.stderr.write(`${c.yellow("!")} ${message}\n`);
  }

  hint(message) {
    this.log(c.dim(message));
  }

  json(value) {
    this.stopSpinner();
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** Prints JSON in --json mode, otherwise runs the human renderer. */
  result(value, human) {
    if (this.jsonMode) {
      this.json(value);
      return;
    }
    human?.(value);
  }

  table(rows, columns, { empty = "Nothing to show.", total = true, idKey } = {}) {
    if (this.jsonMode) {
      this.json(rows);
      return;
    }
    if (this.quiet && idKey) {
      for (const row of rows) this.write(getValue(row, { key: idKey }));
      return;
    }
    if (!rows.length) {
      this.log(c.dim(empty));
      return;
    }
    this.write(renderTable(rows, columns));
    if (total && rows.length > 5) this.log(c.dim(`\n${rows.length} total`));
  }

  kv(entries, raw) {
    if (this.jsonMode) {
      this.json(raw ?? Object.fromEntries(entries.filter(Boolean)));
      return;
    }
    this.write(renderKeyValues(entries));
  }

  section(title) {
    if (this.jsonMode) return;
    this.write(`\n${c.bold(title)}`);
  }

  startSpinner(text) {
    if (!process.stderr.isTTY || this.quiet || process.env.CI) return;
    this.stopSpinner();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let index = 0;
    const state = { text };
    const render = () => {
      process.stderr.write(`\r\x1b[2K${c.cyan(frames[index % frames.length])} ${state.text}`);
      index += 1;
    };
    render();
    state.timer = setInterval(render, 80);
    this.spinner = state;
  }

  updateSpinner(text) {
    if (this.spinner) this.spinner.text = text;
  }

  stopSpinner() {
    if (!this.spinner) return;
    clearInterval(this.spinner.timer);
    process.stderr.write("\r\x1b[2K");
    this.spinner = null;
  }

  async spin(text, promiseOrFn) {
    this.startSpinner(text);
    try {
      return await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
    } finally {
      this.stopSpinner();
    }
  }
}
