import { createInterface } from "node:readline";

import { c } from "./colors.js";
import { CancelledError, UsageError } from "./errors.js";

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI;
}

function requireTty(what) {
  if (!isInteractive()) {
    throw new UsageError(`Missing ${what}.`, { hint: "Pass it as a flag; prompts are disabled in non-interactive mode." });
  }
}

/** Asks one question on stderr. `mask` hides typed characters. */
function ask(question, { mask = false } = {}) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let answered = false;
    if (mask) {
      const write = rl._writeToOutput?.bind(rl);
      rl._writeToOutput = (text) => {
        if (text.startsWith(question)) write?.(question + text.slice(question.length).replace(/[^\r\n]/g, "•"));
        else if (text === "\r\n" || text === "\n") write?.(text);
        else write?.(text.replace(/[^\r\n]/g, "•"));
      };
    }
    rl.on("SIGINT", () => {
      rl.close();
      process.stderr.write("\n");
      reject(new CancelledError());
    });
    rl.on("close", () => {
      if (!answered) reject(new CancelledError());
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

export async function text(message, { default: fallback, required = true, validate } = {}) {
  requireTty(message.toLowerCase());
  const suffix = fallback ? c.dim(` (${fallback})`) : "";
  for (;;) {
    const answer = (await ask(`${c.cyan("?")} ${message}${suffix} `)).trim() || fallback || "";
    if (!answer && required) {
      process.stderr.write(`${c.yellow("  A value is required.")}\n`);
      continue;
    }
    const problem = answer && validate ? validate(answer) : null;
    if (problem) {
      process.stderr.write(`${c.yellow(`  ${problem}`)}\n`);
      continue;
    }
    return answer;
  }
}

export async function password(message) {
  requireTty(message.toLowerCase());
  for (;;) {
    const answer = await ask(`${c.cyan("?")} ${message} `, { mask: true });
    if (answer) return answer;
    process.stderr.write(`${c.yellow("  A value is required.")}\n`);
  }
}

export async function confirm(message, { default: fallback = false } = {}) {
  requireTty("confirmation (use --yes)");
  const hint = fallback ? "Y/n" : "y/N";
  const answer = (await ask(`${c.cyan("?")} ${message} ${c.dim(`(${hint})`)} `)).trim().toLowerCase();
  if (!answer) return fallback;
  return ["y", "yes"].includes(answer);
}

/** choices: [{ label, value, hint? }] */
export async function select(message, choices, { default: fallbackIndex = 0 } = {}) {
  requireTty(message.toLowerCase());
  if (!choices.length) throw new UsageError(`Nothing to choose for: ${message}`);
  process.stderr.write(`${c.cyan("?")} ${message}\n`);
  choices.forEach((choice, index) => {
    const marker = index === fallbackIndex ? c.cyan("›") : " ";
    const hint = choice.hint ? c.dim(`  ${choice.hint}`) : "";
    process.stderr.write(`  ${marker} ${c.dim(`${index + 1})`)} ${choice.label}${hint}\n`);
  });
  for (;;) {
    const answer = (await ask(`  ${c.dim(`Choose 1-${choices.length}`)} ${c.dim(`(${fallbackIndex + 1})`)} `)).trim();
    if (!answer) return choices[fallbackIndex].value;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index].value;
    const byLabel = choices.find((choice) => String(choice.label).toLowerCase() === answer.toLowerCase());
    if (byLabel) return byLabel.value;
    process.stderr.write(`${c.yellow("  Pick a number from the list.")}\n`);
  }
}
