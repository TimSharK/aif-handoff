import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { initBaseProjectDirectory, logger } from "@aif/shared";
import type { RuntimeRegistry } from "./registry.js";

const log = logger("runtime-project-init");
const moduleRequire = createRequire(import.meta.url);
const IS_WINDOWS = process.platform === "win32";

/** Minimum ai-factory version that supports --config flag. */
const CONFIG_FLAG_MIN_VERSION = [2, 9, 3] as const;

function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(
  version: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > minimum[i]) return true;
    if (version[i] < minimum[i]) return false;
  }
  return true; // equal
}

function getAiFactoryVersion(): string | null {
  const execOptions: { encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "ignore"] } = {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  };

  // 1. Local install — fastest, no network
  try {
    const aiFactoryBin = moduleRequire.resolve("ai-factory/bin/ai-factory.js");
    return execFileSync(process.execPath, [aiFactoryBin, "--version"], execOptions).trim();
  } catch {
    // not installed locally — fall through
  }

  // 2. npx (Windows: cmd /d /c npx) — covers global installs and remote fetching
  try {
    if (IS_WINDOWS) {
      const shell = process.env.ComSpec ?? "cmd.exe";
      return execFileSync(shell, ["/d", "/c", "npx ai-factory --version"], execOptions).trim();
    }
    return execFileSync("npx", ["ai-factory", "--version"], execOptions).trim();
  } catch {
    return null;
  }
}

function supportsConfigFlag(): boolean {
  const raw = getAiFactoryVersion();
  if (!raw) return false;
  const version = parseVersion(raw);
  if (!version) return false;
  return isVersionAtLeast(version, CONFIG_FLAG_MIN_VERSION);
}

export interface InitProjectOptions {
  /** Project root directory path. */
  projectRoot: string;
  /** Runtime registry — runtime IDs are collected for ai-factory init --agents. */
  registry: RuntimeRegistry;
  /** Limit to specific runtime IDs. If omitted, all registered runtimes are used. */
  runtimeIds?: string[];
}

export interface InitProjectResult {
  ok: boolean;
  error?: string;
}

interface AiFactoryCommand {
  command: string;
  args: string[];
}

function quoteAgentIdsForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function resolveAiFactoryCommand(agentIds: string, useConfig: boolean): AiFactoryCommand {
  const configArgs = useConfig ? ["--config"] : [];

  try {
    const aiFactoryBin = moduleRequire.resolve("ai-factory/bin/ai-factory.js");
    return {
      command: process.execPath,
      args: [aiFactoryBin, "init", "--agents", agentIds, ...configArgs],
    };
  } catch {
    if (IS_WINDOWS) {
      const configSuffix = useConfig ? " --config" : "";
      return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: [
          "/d",
          "/c",
          `npx ai-factory init --agents ${quoteAgentIdsForCmd(agentIds)}${configSuffix}`,
        ],
      };
    }

    return {
      command: "npx",
      args: ["ai-factory", "init", "--agents", agentIds, ...configArgs],
    };
  }
}

/**
 * Ensure the project `.mcp.json` contains default MCP servers.
 *
 * Driven by `AIF_PROJECT_MCP_DEFAULTS_JSON` — a JSON object (or an object with
 * a `mcpServers` key) whose entries use the `.mcp.json` server format, e.g.
 * `{"bridge":{"type":"http","url":"http://host.docker.internal:8022/mcp"}}`.
 *
 * Idempotent: merges only keys missing from the existing project config and
 * never rewrites entries already present. No-op when the env var is unset or
 * invalid, so upstream behaviour is unchanged by default.
 */
function ensureDefaultMcpServers(projectRoot: string): void {
  const raw = process.env.AIF_PROJECT_MCP_DEFAULTS_JSON?.trim();
  if (!raw) return;

  let defaults: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = (parsed as { mcpServers?: unknown }).mcpServers ?? parsed;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        defaults = candidate as Record<string, unknown>;
      }
    }
  } catch {
    defaults = null;
  }
  if (!defaults) {
    log.warn("AIF_PROJECT_MCP_DEFAULTS_JSON is invalid JSON — skipping default MCP servers");
    return;
  }
  if (Object.keys(defaults).length === 0) return;

  const mcpPath = resolve(projectRoot, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf-8")) as typeof config;
    } catch {
      log.warn({ mcpPath }, "Existing .mcp.json is not valid JSON — leaving it untouched");
      return;
    }
  }

  const servers = config.mcpServers ?? {};
  const added = Object.keys(defaults).filter((key) => !(key in servers));
  if (added.length === 0) return;

  for (const key of added) servers[key] = defaults[key];
  config.mcpServers = servers;
  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  log.info({ projectRoot, servers: added }, "Default MCP servers ensured in project .mcp.json");
}

/**
 * Ensure the project CLAUDE.md carries shared agent rules (quality gates).
 *
 * Driven by `AIF_PROJECT_SHARED_RULES_FILE` — path (inside the containers, e.g.
 * below PROJECTS_MOUNT) to a markdown file appended to every project's CLAUDE.md
 * under a marker. Idempotent: projects already carrying the marker are skipped.
 * No-op when the env var is unset or the file is missing.
 */
const SHARED_RULES_MARKER = "<!-- aif:shared-rules -->";

function ensureProjectSharedRules(projectRoot: string): void {
  const rulesPath = process.env.AIF_PROJECT_SHARED_RULES_FILE?.trim();
  if (!rulesPath) return;

  let rules: string;
  try {
    rules = readFileSync(rulesPath, "utf-8").trim();
  } catch {
    return;
  }
  if (!rules) return;

  const claudePath = resolve(projectRoot, "CLAUDE.md");
  let existing = "";
  if (existsSync(claudePath)) {
    existing = readFileSync(claudePath, "utf-8");
    if (existing.includes(SHARED_RULES_MARKER)) return;
  }

  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  const addition = `${separator}\n${SHARED_RULES_MARKER}\n${rules}\n`;
  writeFileSync(claudePath, existing + addition, "utf-8");
  log.info({ projectRoot, source: rulesPath }, "Shared agent rules appended to project CLAUDE.md");
}

/**
 * Align `.ai-factory/config.yaml` git.base_branch with the repo's real default
 * branch. The ai-factory scaffold template always writes `base_branch: main`,
 * which breaks branch isolation for legacy `master`-based repositories
 * ("Base branch main does not exist"). No-op when the repo is main-based or
 * the config/origin HEAD is missing.
 */
function alignConfigBaseBranch(projectRoot: string): void {
  let defaultBranch: string | null = null;
  try {
    const out = execFileSync(
      "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: projectRoot, encoding: "utf-8", timeout: 10_000 },
    ).trim();
    defaultBranch = out.replace(/^origin\//, "") || null;
  } catch {
    return;
  }
  if (!defaultBranch || defaultBranch === "main") return;

  const cfgPath = resolve(projectRoot, ".ai-factory", "config.yaml");
  if (!existsSync(cfgPath)) return;
  const txt = readFileSync(cfgPath, "utf-8");
  const updated = txt.replace(/(^|\n)(\s*)base_branch:[^\n]*/, `$1$2base_branch: ${defaultBranch}`);
  if (updated !== txt) {
    writeFileSync(cfgPath, updated, "utf-8");
    log.info({ projectRoot, baseBranch: defaultBranch }, "Aligned .ai-factory base_branch with repo default");
  }
}

/**
 * Initialize a project directory with all runtime-specific structures.
 *
 * 1. Creates project root + git repo (base scaffold)
 * 2. Runs `ai-factory init --agents claude,codex` if `.ai-factory/` does not exist yet
 *
 * `.ai-factory/` is created exclusively by `ai-factory init`. If the command
 * fails the directory stays missing so subsequent calls will retry.
 * Existing `.ai-factory/` projects are intentionally not reinitialized here;
 * runtime rollout guards must handle compatibility for older bootstrap state.
 *
 * Safe to call multiple times — skips if `.ai-factory/` already exists.
 *
 * @throws Error if `ai-factory init` fails — callers must handle this to
 *   prevent creating projects with broken scaffold.
 */
export function initProject(options: InitProjectOptions): InitProjectResult {
  const { projectRoot, registry, runtimeIds } = options;

  const aiFactoryDir = resolve(projectRoot, ".ai-factory");
  const alreadyInitialized = existsSync(aiFactoryDir);

  // 1. Base scaffold: project root + git (does NOT create .ai-factory/)
  initBaseProjectDirectory(projectRoot);

  // 1b. Merge configured default MCP servers into .mcp.json (no-op by default)
  ensureDefaultMcpServers(projectRoot);

  // 1c. Append shared agent rules (quality gates) to CLAUDE.md (no-op by default)
  ensureProjectSharedRules(projectRoot);

  // 1d. Align config base_branch with the repo default (covers existing projects)
  alignConfigBaseBranch(projectRoot);

  // 2. ai-factory init — only for fresh projects
  if (alreadyInitialized) return { ok: true };

  const descriptors = registry.listRuntimes();
  const initCapable = descriptors.filter((d) => d.supportsProjectInit);
  const targets = runtimeIds ? initCapable.filter((d) => runtimeIds.includes(d.id)) : initCapable;

  const agentIds = [
    ...new Set(
      targets.flatMap((descriptor) => {
        const agentName = descriptor.projectInitAgentName?.trim();
        if (agentName) return [agentName];

        log.warn(
          { projectRoot, runtimeId: descriptor.id },
          "Skipping runtime during ai-factory init because projectInitAgentName is missing",
        );
        return [];
      }),
    ),
  ].join(",");
  if (!agentIds) return { ok: true };

  try {
    const useConfig = supportsConfigFlag();
    const command = resolveAiFactoryCommand(agentIds, useConfig);
    log.debug({ useConfig }, "ai-factory --config flag support");
    execFileSync(command.command, command.args, {
      cwd: projectRoot,
      stdio: "ignore",
      timeout: 60_000,
    });
    log.info({ projectRoot, agents: agentIds }, "ai-factory init completed");
    alignConfigBaseBranch(projectRoot);
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "ai-factory init failed with unknown error";
    log.error(
      { projectRoot, agents: agentIds, err },
      "ai-factory init failed — project scaffold is incomplete",
    );
    return {
      ok: false,
      error: `Project initialization failed: could not run "ai-factory init". ${message}. Make sure ai-factory is available (npx ai-factory --version) and try again.`,
    };
  }
}
