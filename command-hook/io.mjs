// Node-only I/O for the command hook: config, per-session state, current effort.
// State holds derived labels and counters only. Prompt, message and transcript
// text is read in memory where needed and never written anywhere.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, mergeConfig, normalizeLevel } from "../lib/core.mjs";

const STATE_VERSION = 1;
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const STALE_STATE_MS = 3 * 24 * 60 * 60 * 1000;

export function loadConfig(overrides, env = process.env) {
  let config = mergeConfig(DEFAULT_CONFIG, overrides ?? {});
  if (env.EFFORT_ADVISOR_CONFIG_JSON) {
    try {
      config = mergeConfig(config, JSON.parse(env.EFFORT_ADVISOR_CONFIG_JSON));
    } catch {
      // A malformed override is ignored.
    }
  }
  if (env.EFFORT_ADVISOR_DISABLED === "1") config.enabled = false;
  return config;
}

export function stateRoot(env = process.env) {
  if (env.EFFORT_ADVISOR_STATE_DIR) return env.EFFORT_ADVISOR_STATE_DIR;
  const base = env.LOCALAPPDATA
    || (process.platform === "win32" ? join(homedir(), "AppData", "Local") : join(homedir(), ".local", "state"));
  return join(base, "effort-advisor");
}

export const sessionKey = (sessionId) => createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 20);

export function statePath(root, sessionId) {
  return join(root, "claude", `s-${sessionKey(sessionId)}.json`);
}

export function emptyState() {
  return {
    v: STATE_VERSION,
    promptCount: 0,
    window: [],
    lastEffort: null,
    lastSuggestion: null,
    pending: null,
    ignored: { up: 0, down: 0 },
    turn: null,
  };
}

export function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state?.v === STATE_VERSION) return { ...emptyState(), ...state };
  } catch {
    // Missing or unreadable state starts fresh.
  }
  return emptyState();
}

export function writeState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), "utf8");
    renameSync(temporary, path);
  } catch {
    // State is a convenience; losing it only resets cooldowns.
  }
}

export function pruneStates(directory, now = Date.now()) {
  try {
    for (const name of readdirSync(directory)) {
      if (!/^s-[0-9a-f]+\.json(?:\.\d+\.tmp)?$/.test(name)) continue;
      const path = join(directory, name);
      try {
        if (now - statSync(path).mtimeMs > STALE_STATE_MS) unlinkSync(path);
      } catch {
        // Another process may have removed it.
      }
    }
  } catch {
    // Nothing to prune.
  }
}

// Bounded read of a file's end; only effort fields are parsed out of it.
export function readTail(path, maxBytes = MAX_TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

// The transcript's last assistant row: the previous turn's effort and model.
function lastAssistantRow(path, wanted) {
  if (!path || typeof path !== "string") return null;
  const lines = readTail(path).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes("\"assistant\"") || !line.includes(wanted)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "assistant") return entry;
    } catch {
      // A partial first line or a non-JSON line is skipped.
    }
  }
  return null;
}

export function lastEffortInTranscript(path) {
  return normalizeLevel(lastAssistantRow(path, "\"effort\"")?.effort);
}

export function lastModelInTranscript(path) {
  const model = lastAssistantRow(path, "\"model\"")?.message?.model;
  return typeof model === "string" ? model : null;
}

/**
 * Current effort, most reliable source first.
 *
 * Claude Code sets `effort` and CLAUDE_EFFORT for tool-use events and Stop. A
 * UserPromptSubmit hook gets neither: its CLAUDE_EFFORT, if any, is inherited
 * and can be stale (the desktop app changes the level without restarting the
 * CLI). So prompt events prefer the transcript and this session's state, and
 * mark an env-only reading `trusted: false` so the caller can wait for a
 * reliable one.
 */
export function currentEffort(input, env = process.env, state = null, { forPrompt = false } = {}) {
  const fromInput = normalizeLevel(input?.effort);
  if (fromInput) return { level: fromInput, source: "hook_input", trusted: true };
  const fromEnv = normalizeLevel(env.CLAUDE_EFFORT);
  if (!forPrompt && fromEnv) return { level: fromEnv, source: "env", trusted: true };
  const fromTranscript = lastEffortInTranscript(input?.transcript_path);
  if (fromTranscript) return { level: fromTranscript, source: "transcript", trusted: true };
  if (state?.lastEffort) return { level: state.lastEffort, source: "state", trusted: true };
  if (fromEnv) return { level: fromEnv, source: "env", trusted: !forPrompt };
  return { level: null, source: "unknown", trusted: false };
}

/** Optional label-only decision log for tuning (off by default). */
export function logDecision(root, entry) {
  try {
    mkdirSync(root, { recursive: true });
    const path = join(root, "decisions.jsonl");
    if (existsSync(path) && statSync(path).size >= MAX_LOG_BYTES) {
      const previous = `${path}.previous`;
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(path, previous);
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging must never affect the hook.
  }
}
