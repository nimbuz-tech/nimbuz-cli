import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UsageError } from "./errors.js";

// Production is the default. The other presets exist for internal development
// testing only and are intentionally not shown in help or docs.
export const API_PRESETS = {
  prod: "https://api.nimbuz.tech",
  production: "https://api.nimbuz.tech",
  dev: "https://api.dev.nimbuz.tech",
  development: "https://api.dev.nimbuz.tech",
  local: "http://localhost:8080"
};

export const DEFAULT_API_URL = API_PRESETS.prod;

/** Settings users may change with `nimbuz config set`. */
export const SETTINGS = {
  "api-url": { key: "apiUrl", desc: "API base URL", hidden: true },
  org: { key: "orgName", desc: "Organization name used at login (nimbuz = individual)" },
  username: { key: "username", desc: "Default login username/e-mail" },
  timezone: { key: "timeZone", desc: "IANA time zone for log timestamps (e.g. Asia/Kolkata)" },
  region: { key: "region", desc: "Default region for new projects/environments" },
  output: { key: "output", desc: "Default output format: table or json" }
};

export function resolveApiUrl(value) {
  if (!value) return undefined;
  const preset = API_PRESETS[String(value).toLowerCase()];
  const url = preset || String(value);
  if (!/^https?:\/\//i.test(url)) {
    throw new UsageError(`Invalid API URL "${value}". Use a full https:// URL.`);
  }
  return url.replace(/\/+$/, "");
}

export function configDir() {
  return process.env.NIMBUZ_CONFIG_DIR || path.join(os.homedir(), ".nimbuz-cli");
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

function emptyConfig() {
  return { version: 2, currentProfile: "default", profiles: { default: {} } };
}

/** Upgrades the v0.1 flat format ({accessToken}) to profiles. */
function migrate(raw) {
  if (!raw || typeof raw !== "object") return emptyConfig();
  if (raw.version === 2 && raw.profiles) {
    raw.currentProfile ||= "default";
    raw.profiles[raw.currentProfile] ||= {};
    return raw;
  }
  const config = emptyConfig();
  if (raw.accessToken) {
    // v0.1 always talked to the dev gateway.
    config.profiles.default = {
      apiUrl: API_PRESETS.dev,
      token: raw.accessToken,
      updatedAt: raw.updatedAt
    };
  }
  return config;
}

export class ConfigStore {
  constructor(data, { profileOverride } = {}) {
    this.data = data;
    this.profileName = profileOverride || process.env.NIMBUZ_PROFILE || data.currentProfile || "default";
  }

  static async load(options = {}) {
    let raw = null;
    try {
      raw = JSON.parse(await readFile(configPath(), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (error instanceof SyntaxError) {
          throw new UsageError(`Config file is not valid JSON: ${configPath()}`, {
            hint: "Fix or delete the file, then run `nimbuz login` again."
          });
        }
        throw error;
      }
    }
    return new ConfigStore(migrate(raw), options);
  }

  get profile() {
    this.data.profiles[this.profileName] ||= {};
    return this.data.profiles[this.profileName];
  }

  profileNames() {
    return Object.keys(this.data.profiles);
  }

  get(key) {
    return this.profile[key];
  }

  set(key, value) {
    if (value === undefined || value === null) delete this.profile[key];
    else this.profile[key] = value;
  }

  update(patch) {
    for (const [key, value] of Object.entries(patch)) this.set(key, value);
  }

  useProfile(name) {
    this.data.profiles[name] ||= {};
    this.data.currentProfile = name;
    this.profileName = name;
  }

  deleteProfile(name) {
    delete this.data.profiles[name];
    if (this.data.currentProfile === name) {
      this.data.currentProfile = Object.keys(this.data.profiles)[0] || "default";
    }
    this.data.profiles[this.data.currentProfile] ||= {};
  }

  async save() {
    const file = configPath();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
    await chmod(file, 0o600).catch(() => {});
  }

  /** Effective values after env vars and flags are applied. */
  apiUrl(flagValue) {
    return (
      resolveApiUrl(flagValue) ||
      resolveApiUrl(process.env.NIMBUZ_API_URL) ||
      resolveApiUrl(this.profile.apiUrl) ||
      DEFAULT_API_URL
    );
  }

  token() {
    return process.env.NIMBUZ_TOKEN || this.profile.token || null;
  }
}
