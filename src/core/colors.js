// Minimal ANSI styling. Respects NO_COLOR, FORCE_COLOR and --no-color.

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90
};

let enabled = detect();

function detect() {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

export function setColorEnabled(value) {
  enabled = Boolean(value);
}

export function colorEnabled() {
  return enabled;
}

function style(...names) {
  return (value) => {
    const text = String(value ?? "");
    if (!enabled || text === "") return text;
    const open = names.map((name) => `\x1b[${CODES[name]}m`).join("");
    return `${open}${text}\x1b[0m`;
  };
}

export const c = {
  bold: style("bold"),
  dim: style("dim"),
  italic: style("italic"),
  underline: style("underline"),
  red: style("red"),
  green: style("green"),
  yellow: style("yellow"),
  blue: style("blue"),
  magenta: style("magenta"),
  cyan: style("cyan"),
  gray: style("gray"),
  brand: style("bold", "cyan"),
  heading: style("bold"),
  cmd: style("cyan"),
  error: style("bold", "red")
};

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}

export function visibleLength(value) {
  return [...stripAnsi(value)].length;
}
