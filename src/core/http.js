import { c } from "./colors.js";
import { ApiError, CliError } from "./errors.js";
import { sleep } from "./util.js";

const DEFAULT_TIMEOUT = Number(process.env.NIMBUZ_TIMEOUT_MS) || 60_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const CONNECT_RETRIES = 3;
const CONNECT_ERRORS = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"]);

export function bearer(token) {
  if (!token) return undefined;
  return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
}

/** Derives the portal origin (app.<domain>) the gateway expects from the API URL. */
export function portalOrigin(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (url.hostname.startsWith("api.")) return `${url.protocol}//app.${url.hostname.slice(4)}`;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Extracts a readable message from the many error shapes the services return. */
export function extractError(body, status) {
  const result = { message: undefined, code: undefined, details: [] };
  if (body == null) return result;
  if (typeof body === "string") {
    const text = body.trim();
    result.message = text.startsWith("<") ? undefined : text.slice(0, 500);
    return result;
  }
  const wrapped = body.response?.error || body.response;
  const err = typeof body.error === "object" && body.error ? body.error : wrapped?.error || wrapped;
  result.code = err?.code || err?.errorCode || body.code || body.errorCode;
  result.message =
    (typeof body.error === "string" && body.error) ||
    err?.message ||
    body.data?.errorMessage ||
    body.errorMessage ||
    body.message ||
    body.customError;
  const details = err?.details || body.details || body.errors;
  if (Array.isArray(details)) {
    result.details = details.map((item) =>
      typeof item === "string" ? item : item?.message || item?.msg || JSON.stringify(item)
    );
  } else if (typeof details === "string") {
    result.details = [details];
  }
  if (result.message === "Validation Error" && result.details.length === 1) {
    result.message = result.details[0];
    result.details = [];
  }
  if (!result.message && status) result.message = `HTTP ${status}`;
  return result;
}

function hintFor(status, code) {
  if (status === 401) return "Your session is missing or expired. Run `nimbuz login`.";
  if (status === 403) return "You do not have permission for this project/environment. Ask an admin, or check `nimbuz team policies`.";
  if (code === "DELETE_NOT_ALLOWED") return "Delete the project's environments first (`nimbuz envs delete`).";
  if (code === "ENV_DELETE_FAILED") return "Delete the environment's apps and tools first.";
  if (code === "TOOL_BUSY") return "A previous change is still rolling out. Try again shortly.";
  if (code === "EMAIL_NOT_VERIFIED") return "Verify your e-mail from the link Nimbuz sent you, then log in again.";
  if (code === "INVALID_ORGANIZATION") return "Check the organization name (`--org`); individual accounts use `nimbuz`.";
  return undefined;
}

export class ApiClient {
  constructor({ baseUrl, token, debug = false, onUnauthorized } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.debug = debug;
    this.origin = portalOrigin(baseUrl);
    this.onUnauthorized = onUnauthorized;
  }

  buildUrl(pathname, query) {
    const url = /^https?:\/\//i.test(pathname)
      ? new URL(pathname)
      : new URL(`${this.baseUrl}/${String(pathname).replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  headers({ auth = true, json = true, accept = "application/json, text/plain, */*", extra = {} } = {}) {
    const headers = {
      Accept: accept,
      "User-Agent": "nimbuz-cli",
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.origin ? { Origin: this.origin, Referer: `${this.origin}/` } : {}),
      ...extra
    };
    if (auth) {
      if (!this.token) {
        throw new CliError("You are not logged in.", { exitCode: 4, hint: "Run `nimbuz login` (or set NIMBUZ_TOKEN)." });
      }
      headers.Authorization = bearer(this.token);
    }
    return headers;
  }

  logDebug(...parts) {
    if (this.debug) process.stderr.write(`${c.dim(`[debug] ${parts.join(" ")}`)}\n`);
  }

  /**
   * Performs a request and returns the parsed JSON body (or text).
   * Throws ApiError on non-2xx responses.
   */
  async request(method, pathname, { query, body, auth = true, headers, timeout = DEFAULT_TIMEOUT, retries } = {}) {
    const url = this.buildUrl(pathname, query);
    const upper = method.toUpperCase();
    const maxRetries = retries ?? (upper === "GET" ? 2 : 0);
    const hasBody = body !== undefined;
    const init = {
      method: upper,
      headers: this.headers({ auth, json: hasBody, extra: headers }),
      body: hasBody ? JSON.stringify(body) : undefined
    };

    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeout);
      let response;
      try {
        this.logDebug("→", upper, url.toString());
        if (hasBody) this.logDebug("  body", redact(JSON.stringify(body)));
        response = await fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        // A failure to connect means the request never reached the server, so it is
        // safe to retry any method (including POST/PUT); other failures only for GET.
        const connectFailure = CONNECT_ERRORS.has(error?.cause?.code);
        if (attempt < maxRetries || (connectFailure && attempt < CONNECT_RETRIES)) {
          this.logDebug("  retrying after", error?.cause?.code || error?.message);
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const reason = error?.name === "AbortError" || error?.message === "timeout" ? `timed out after ${timeout / 1000}s` : error?.cause?.code || error?.message;
        throw new CliError(`Could not reach ${url.host} (${reason}).`, {
          hint: connectFailure ? `Tried ${attempt + 1} times. Check your network or VPN, then try again.` : "Check your network connection and try again."
        });
      }
      clearTimeout(timer);

      const text = await response.text();
      this.logDebug("←", response.status, `${Date.now() - started}ms`, text.length ? `${text.length}B` : "");
      let parsed = text;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      } else {
        parsed = null;
      }

      if (response.ok) return parsed;

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }

      const { message, code, details } = extractError(parsed, response.status);
      if (response.status === 401) this.onUnauthorized?.();
      const fallback = response.status === 404 ? `Not found: ${upper} ${url.pathname}` : `Request failed: ${upper} ${url.pathname}`;
      const generic = !message || /^HTTP \d+$/.test(message);
      throw new ApiError(generic ? fallback : message, {
        status: response.status,
        code,
        details,
        body: parsed,
        method: upper,
        url: url.toString(),
        hint: hintFor(response.status, code)
      });
    }
  }

  get(pathname, options) {
    return this.request("GET", pathname, options);
  }

  post(pathname, body, options = {}) {
    return this.request("POST", pathname, { ...options, body: body ?? {} });
  }

  put(pathname, body, options = {}) {
    return this.request("PUT", pathname, { ...options, body: body ?? {} });
  }

  patch(pathname, body, options = {}) {
    return this.request("PATCH", pathname, { ...options, body: body ?? {} });
  }

  delete(pathname, options = {}) {
    return this.request("DELETE", pathname, options);
  }

  /**
   * Opens a Server-Sent Events stream and calls onEvent({event, data}) per message.
   * Resolves when the stream ends or the signal aborts.
   */
  async stream(pathname, { query, onEvent, signal } = {}) {
    const url = this.buildUrl(pathname, query);
    this.logDebug("→ SSE", url.toString());
    const response = await fetch(url, {
      headers: this.headers({ json: false, accept: "text/event-stream" }),
      signal
    }).catch((error) => {
      if (signal?.aborted) return null;
      throw new CliError(`Could not open stream: ${error.message}`);
    });
    if (!response) return;
    if (!response.ok) {
      const text = await response.text();
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const { message, code } = extractError(parsed, response.status);
      throw new ApiError(message, { status: response.status, code, hint: hintFor(response.status, code) });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let event = { event: "message", data: [] };
    const dispatch = () => {
      if (!event.data.length) {
        event = { event: "message", data: [] };
        return;
      }
      const raw = event.data.join("\n");
      let data = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* plain text */
      }
      onEvent?.({ event: event.event, data });
      event = { event: "message", data: [] };
    };

    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.search(/\r?\n/)) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1));
          if (line === "") dispatch();
          else if (line.startsWith(":")) continue;
          else {
            const colon = line.indexOf(":");
            const field = colon < 0 ? line : line.slice(0, colon);
            const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "event") event.event = value;
            else if (field === "data") event.data.push(value);
          }
        }
      }
      dispatch();
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
  }
}

export function redact(text) {
  // Any key that looks sensitive (e.g. "postgresql.auth.postgresPassword", "API_KEY") is masked.
  let out = String(text).replace(/("[^"]*(?:pass(?:word)?|secret|token|api[_-]?key|credential|private[_-]?key)[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"');
  // Values of the `secret` map are always masked, whatever their keys are.
  out = out.replace(/("secret"\s*:\s*\{)([^}]*)\}/g, (_, head, body) => `${head}${body.replace(/(:\s*)"(?:[^"\\]|\\.)*"/g, '$1"***"')}}`);
  return out;
}

/** Unwraps the standard {status, message, data} envelope. */
export function unwrap(body) {
  if (body && typeof body === "object" && !Array.isArray(body) && "data" in body) return body.data;
  return body;
}
