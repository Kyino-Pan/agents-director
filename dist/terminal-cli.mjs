// worker/terminal-cli.mjs
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// vendor/process-host/run-process.ts
import {
  spawn as nodeSpawn3,
  spawnSync as nodeSpawnSync
} from "node:child_process";

// vendor/process-host/windows-command-line.ts
function quoteWindows(value, escapePercent) {
  if (!(escapePercent ? /[\\"%]/ : /[\\"]/).test(value)) {
    return `"${value}"`;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += `${"\\".repeat(backslashes * 2)}""`;
      backslashes = 0;
      continue;
    }
    if (escapePercent && char === "%") {
      quoted += `${"\\".repeat(backslashes * 2)}"^%"`;
      backslashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}
function quoteWindowsCmdArgument(value) {
  return quoteWindows(value, true);
}
var WindowsCmdLineBreakError = class extends Error {
  constructor() {
    super("cmd.exe cannot receive an argument containing a line break");
    this.name = "WindowsCmdLineBreakError";
  }
};
function validateWindowsCmdArguments(values) {
  for (const value of values) {
    if (/[\r\n]/.test(value)) {
      throw new WindowsCmdLineBreakError();
    }
  }
}
function buildWindowsCmdShimCommandLine(program, args) {
  validateWindowsCmdArguments([program, ...args]);
  const inner = [program, ...args].map(quoteWindowsCmdArgument).join(" ");
  return `/d /v:off /s /c "${inner}"`;
}
var CMD_INTERPRETED_EXTENSIONS = [".cmd", ".bat"];
function isCmdInterpretedProgram(program) {
  const lower = program.toLowerCase();
  return CMD_INTERPRETED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// vendor/process-host/windows-cmd-shim-resolution.ts
import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
var DISABLE_FLAG = "ORCA_DISABLE_CMD_SHIM_RESOLUTION";
var MAX_SHIM_BYTES = 64 * 1024;
var DP0 = String.raw`(?:%~dp0|%dp0%)\\?`;
var DP0_NODE_EXE = `"${DP0}node\\.exe"`;
var dp0Path = (group) => `"${DP0}(?<${group}>[^"\\r\\n]+)"`;
var ECHO_OFF = String.raw`@echo off\n`;
var FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`;
var NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`;
var PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`;
var NPM_PROG_NODE_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path("script")} +%\*$`,
  "i"
);
var BRANCHED_NODE_SHIM = new RegExp(
  String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path("script")} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path("scriptElse")} +%\*\n\)$`,
  "i"
);
var NPM_DIRECT_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path("target")} +%\*$`,
  "i"
);
var PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path("target")} +%\*$`, "i");
var UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/;
var DIRECT_TARGET_EXTENSIONS = [".exe", ".com"];
function isPlainRelativePath(spelled) {
  return !UNSAFE_SHIM_PATH.test(spelled) && !win32.isAbsolute(spelled);
}
function canonicalize(contents) {
  return contents.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
}
function parseWindowsCmdShim(contents) {
  const canonical = canonicalize(contents);
  const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups;
  if (prog?.script) {
    return isPlainRelativePath(prog.script) ? { kind: "node", script: prog.script } : null;
  }
  const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups;
  if (branched?.script) {
    if (branched.script !== branched.scriptElse || !isPlainRelativePath(branched.script)) {
      return null;
    }
    const nodePath = branched.nodePath;
    if (nodePath === void 0) {
      return { kind: "node", script: branched.script };
    }
    if (nodePath.includes("%") || branched.nodePathElse !== `${nodePath};%NODE_PATH%`) {
      return null;
    }
    return { kind: "node", script: branched.script, nodePathPrefix: nodePath };
  }
  for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
    const target = pattern.exec(canonical)?.groups?.target;
    if (target) {
      return isPlainRelativePath(target) ? { kind: "direct", target } : null;
    }
  }
  return null;
}
var parseCache = /* @__PURE__ */ new Map();
var PARSE_CACHE_LIMIT = 256;
var nodeCache = /* @__PURE__ */ new Map();
var NODE_CACHE_LIMIT = 256;
function statFile(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}
function readParsedShim(program) {
  const stats = statFile(program);
  if (!stats || stats.size > MAX_SHIM_BYTES) {
    return null;
  }
  const cached = parseCache.get(program);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.parsed;
  }
  let contents;
  try {
    contents = readFileSync(program, "utf8");
  } catch {
    return null;
  }
  const parsed = parseWindowsCmdShim(contents);
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    parseCache.clear();
  }
  parseCache.set(program, { mtimeMs: stats.mtimeMs, size: stats.size, parsed });
  return parsed;
}
function firstEnvKey(env, name) {
  const lower = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lower && env[key] !== void 0);
}
var DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
function resolveShimNode(directory, env) {
  const pathKey = firstEnvKey(env, "PATH");
  const pathValue = (pathKey ? env[pathKey] : void 0) ?? "";
  const pathExtKey = firstEnvKey(env, "PATHEXT");
  const pathExtValue = (pathExtKey ? env[pathExtKey] : void 0) || DEFAULT_PATHEXT;
  const key = `${directory}
${pathValue}
${pathExtValue}`;
  const cached = nodeCache.get(key);
  if (cached !== void 0 && (cached === null || statFile(cached))) {
    return cached;
  }
  const resolved = probeShimNode(directory, pathValue, pathExtValue);
  if (nodeCache.size >= NODE_CACHE_LIMIT) {
    nodeCache.clear();
  }
  nodeCache.set(key, resolved);
  return resolved;
}
function probeShimNode(directory, pathValue, pathExtValue) {
  const sibling = win32.join(directory, "node.exe");
  if (statFile(sibling)) {
    return sibling;
  }
  const extensions = pathExtValue.split(";").map((extension) => extension.trim().toLowerCase()).filter((extension) => extension.startsWith("."));
  for (const entry of pathValue.split(";")) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed || !win32.isAbsolute(trimmed)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = win32.join(trimmed, `node${extension}`);
      if (!statFile(candidate)) {
        continue;
      }
      return extension === ".exe" ? candidate : null;
    }
  }
  return null;
}
function withNodePath(env, prefix) {
  const key = firstEnvKey(env, "NODE_PATH") ?? "NODE_PATH";
  const existing = env[key];
  return { ...env, [key]: existing ? `${prefix};${existing}` : prefix };
}
function resolveWindowsCmdShim(program, env) {
  const disableKey = firstEnvKey(env, DISABLE_FLAG);
  if (disableKey && env[disableKey]) {
    return null;
  }
  if (!win32.isAbsolute(program)) {
    return null;
  }
  const parsed = readParsedShim(program);
  if (!parsed) {
    return null;
  }
  const directory = win32.dirname(program);
  if (parsed.kind === "direct") {
    const target = win32.resolve(directory, parsed.target);
    const lower = target.toLowerCase();
    if (!DIRECT_TARGET_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return null;
    }
    return statFile(target) ? { program: target, prefixArgs: [] } : null;
  }
  const script = win32.resolve(directory, parsed.script);
  if (!statFile(script)) {
    return null;
  }
  const node = resolveShimNode(directory, env);
  if (!node) {
    return null;
  }
  return {
    program: node,
    prefixArgs: [script],
    ...parsed.nodePathPrefix ? { env: withNodePath(env, parsed.nodePathPrefix) } : {}
  };
}

// vendor/process-host/wsl-distro-allowlist.ts
var WSL_DISTRO_ALLOWLIST_ENV = "ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST";
var WSL_DISTRO_NOT_ALLOWLISTED_CODE = "ORCA_WSL_DISTRO_NOT_ALLOWLISTED";
var EXEMPT_FLAGS = /* @__PURE__ */ new Set([
  "-l",
  "--list",
  "-v",
  "--verbose",
  "-q",
  "--quiet",
  "--running",
  "--all",
  "-o",
  "--online",
  "--status",
  "--version",
  "--help"
]);
var DISTRO_FLAGS = /* @__PURE__ */ new Set([
  "-d",
  "--distribution",
  "--distribution-id",
  "-t",
  "--terminate",
  "--unregister"
]);
var VALUE_FLAGS = /* @__PURE__ */ new Set(["-u", "--user", "--cd", "--shell-type"]);
var COMMAND_START = /* @__PURE__ */ new Set(["--exec", "-e", "--"]);
var DISTRO_NAME = /^[A-Za-z0-9._-]+$/;
var parsedFor;
var parsedAllowlist = null;
var warnedMalformed = false;
function parseWslDistroAllowlist(value) {
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => !DISTRO_NAME.test(name))) {
    return null;
  }
  return new Set(names.map((name) => name.toLowerCase()));
}
function isWslProgram(program) {
  const base = program.slice(Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\")) + 1);
  const lower = base.toLowerCase();
  return lower === "wsl" || lower === "wsl.exe";
}
function refusalReason(args, allowlist) {
  const targets = [];
  let exemptOnly = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (COMMAND_START.has(arg) || !arg.startsWith("-")) {
      exemptOnly = false;
      break;
    }
    if (DISTRO_FLAGS.has(arg)) {
      exemptOnly = false;
      const name = args[index + 1];
      targets.push(arg === "--distribution-id" ? "" : name ?? "");
      index++;
      continue;
    }
    if (arg === "--shutdown") {
      return "wsl --shutdown stops every distro";
    }
    if (VALUE_FLAGS.has(arg)) {
      index++;
    }
    if (!EXEMPT_FLAGS.has(arg)) {
      exemptOnly = false;
    }
  }
  if (exemptOnly) {
    return null;
  }
  if (allowlist === null) {
    return `${WSL_DISTRO_ALLOWLIST_ENV} is malformed, so no distro is allowed`;
  }
  if (targets.length === 0) {
    return "the call does not name a distro";
  }
  const refused = targets.find((name) => !allowlist.has(name.toLowerCase()));
  return refused === void 0 ? null : `distro "${refused}" is not on the allowlist`;
}
function readAllowlist(value) {
  if (parsedFor !== value) {
    parsedFor = value;
    parsedAllowlist = parseWslDistroAllowlist(value);
    if (parsedAllowlist === null && !warnedMalformed) {
      warnedMalformed = true;
      console.warn(
        `[process-host] ${WSL_DISTRO_ALLOWLIST_ENV} is malformed; refusing every WSL distro exec`
      );
    }
  }
  return parsedAllowlist;
}
function assertWslDistroAllowed(program, args) {
  const value = process.env[WSL_DISTRO_ALLOWLIST_ENV];
  if (value === void 0) {
    return;
  }
  if (!isWslProgram(program)) {
    return;
  }
  const argv = typeof args === "string" ? args.split(/\s+/).filter(Boolean) : args;
  const reason = refusalReason(argv, readAllowlist(value));
  if (reason !== null) {
    throw Object.assign(new Error(`WSL exec refused: ${reason}`), {
      code: WSL_DISTRO_NOT_ALLOWLISTED_CODE
    });
  }
}

// vendor/process-host/spawn-resolution.ts
function resolveSpawn(spec, platform) {
  const args = spec.args ?? [];
  assertWslDistroAllowed(spec.program, args);
  const base = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
    serialization: spec.serialization,
    // GUI-subsystem parents otherwise spawn visible consoles that steal foreground input.
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    // shell:true loses argument escaping and disables windowsHide.
    shell: false,
    ...spec.terminationBarrier && platform !== "win32" ? { detached: true } : {}
  };
  if (platform !== "win32" || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base };
  }
  const shim = resolveWindowsCmdShim(spec.program, spec.env ?? process.env);
  if (shim) {
    return {
      file: shim.program,
      args: [...shim.prefixArgs, ...args],
      options: {
        ...base,
        ...shim.env ? { env: shim.env } : {},
        // Node must quote argv normally after replacing the caller-owned cmd line.
        windowsVerbatimArguments: void 0
      }
    };
  }
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? "cmd.exe";
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  };
}

// vendor/process-host/process-tree-termination.ts
import { spawn as nodeSpawn2 } from "node:child_process";

// vendor/process-host/process-tree-kill-gate.ts
var gate = null;
function admitProcessTreeKill(kill) {
  try {
    return gate?.(kill) ?? true;
  } catch {
    return true;
  }
}

// vendor/process-host/windows-tree-kill.ts
import { spawn as nodeSpawn } from "node:child_process";
import { constants, getPriority, setPriority } from "node:os";

// vendor/process-host/windows-system-binary.ts
import { win32 as pathWin32 } from "node:path";
function systemRoot(env = process.env) {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
}
function windowsSystem32Binary(fileName, env = process.env) {
  return pathWin32.join(systemRoot(env), "System32", fileName);
}

// vendor/process-host/windows-tree-kill.ts
var WINDOWS_TASKKILL_WAIT_MS = 5e3;
var WINDOWS_TASKKILL_DEADLINE_MS = 3e4;
var WINDOWS_TASKKILL_AFTER_ROOT_EXIT_MS = 2e3;
var launchSystemTaskkill = (rootPid) => nodeSpawn(windowsSystem32Binary("taskkill.exe"), ["/pid", String(rootPid), "/t", "/f"], {
  stdio: "ignore",
  windowsHide: true,
  shell: false
});
var launchTaskkill = launchSystemTaskkill;
var treeKills = /* @__PURE__ */ new WeakMap();
function trackedWindowsTreeKill(child) {
  const kill = treeKills.get(child);
  return kill && kill.verdict() !== "unverifiable" ? kill : void 0;
}
function inFlightWindowsTreeKill(child) {
  const kill = treeKills.get(child);
  return kill?.verdict() === "live" ? kill.settled : void 0;
}
function startWindowsTreeKill(child, rootPid, killRoot2) {
  const existing = trackedWindowsTreeKill(child);
  if (existing) {
    return existing;
  }
  let verdict = "live";
  let resolveSettled = () => {
  };
  const settled = new Promise((resolve2) => {
    resolveSettled = resolve2;
  });
  const kill = { verdict: () => verdict, settled };
  treeKills.set(child, kill);
  let killer;
  let deadline;
  let afterRootExit;
  const abandon = () => {
    try {
      killer?.kill();
    } catch {
    }
    finish("unverifiable");
  };
  const onRootExit = () => {
    afterRootExit ??= setTimeout(abandon, WINDOWS_TASKKILL_AFTER_ROOT_EXIT_MS);
    afterRootExit.unref?.();
  };
  function finish(next) {
    if (verdict !== "live") {
      return;
    }
    verdict = next;
    clearTimeout(deadline);
    clearTimeout(afterRootExit);
    child.off("exit", onRootExit);
    if (next === "unverifiable") {
      killRoot2();
    }
    resolveSettled(next);
  }
  try {
    killer = launchTaskkill(rootPid);
  } catch {
    finish("unverifiable");
    return kill;
  }
  if (process.platform === "win32" && killer.pid !== void 0) {
    try {
      if (getPriority(killer.pid) > constants.priority.PRIORITY_NORMAL) {
        setPriority(killer.pid, constants.priority.PRIORITY_NORMAL);
      }
    } catch {
    }
  }
  killer.once("error", () => finish("unverifiable"));
  killer.once("close", (code) => finish(code === 0 ? "exited" : "unverifiable"));
  deadline = setTimeout(abandon, WINDOWS_TASKKILL_DEADLINE_MS);
  deadline.unref?.();
  child.once("exit", onRootExit);
  if (childProcessExited(child)) {
    onRootExit();
  }
  return kill;
}
function waitForWindowsTreeKill(kill, waitMs = WINDOWS_TASKKILL_WAIT_MS) {
  if (kill.verdict() !== "live") {
    return Promise.resolve(kill.verdict() === "exited");
  }
  return new Promise((resolve2) => {
    const timer = setTimeout(() => resolve2(false), waitMs);
    timer.unref?.();
    void kill.settled.then((verdict) => {
      clearTimeout(timer);
      resolve2(verdict === "exited");
    });
  });
}
function childProcessExited(child) {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
}

// vendor/process-host/process-tree-termination.ts
var PROBE_INTERVAL_MS = 25;
var SUBPROCESS_TIMEOUT_MS = 2e3;
var MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024;
function signalProcessTree(child, signal) {
  if (!child.pid) {
    killRoot(child, signal);
    return Promise.resolve(true);
  }
  if (process.platform === "win32") {
    const tracked = trackedWindowsTreeKill(child);
    if (tracked) {
      return waitForWindowsTreeKill(tracked);
    }
    if (childProcessHasExited(child)) {
      killRoot(child, signal);
      return Promise.resolve(false);
    }
    return taskkillTree(child, child.pid, signal);
  }
  if (!admitProcessTreeKill({
    pid: child.pid,
    site: "run-process-tree",
    scope: "posix-process-group"
  })) {
    killRoot(child, signal);
    return Promise.resolve(false);
  }
  try {
    process.kill(-child.pid, signal);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(!processGroupExists(child.pid));
  }
}
async function forceTerminateProcessTree(child) {
  const signaled = await signalProcessTree(child, "SIGKILL");
  if (!signaled) {
    return false;
  }
  if (process.platform !== "win32" && child.pid) {
    return waitForPosixProcessGroupQuiescence(child.pid);
  }
  return true;
}
function childProcessHasExited(child) {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
}
function taskkillTree(child, rootPid, signal) {
  if (!admitProcessTreeKill({ pid: rootPid, site: "run-process-tree", scope: "win-taskkill-tree" })) {
    killRoot(child, signal);
    return Promise.resolve(false);
  }
  return waitForWindowsTreeKill(startWindowsTreeKill(child, rootPid, () => killRoot(child, signal)));
}
async function waitForPosixProcessGroupQuiescence(processGroupId) {
  const deadline = Date.now() + SUBPROCESS_TIMEOUT_MS;
  while (true) {
    const states = await readPosixProcessGroupStates(processGroupId);
    if (states ? states.every((state) => state.startsWith("Z")) : !processGroupExists(processGroupId)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve2) => setTimeout(resolve2, PROBE_INTERVAL_MS));
  }
}
function readPosixProcessGroupStates(processGroupId) {
  return new Promise((resolve2) => {
    let probe;
    try {
      probe = nodeSpawn2("ps", ["-axo", "pgid=,state="], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false
      });
    } catch {
      resolve2(null);
      return;
    }
    let output = "";
    let truncated = false;
    let settled = false;
    const finish = (states) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve2(states);
    };
    probe.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      if (output.length + text.length > MAX_PS_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      output += text;
    });
    probe.stdout?.on("error", () => {
    });
    probe.once("error", () => finish(null));
    probe.once("close", (code) => {
      if (code !== 0 || truncated) {
        finish(null);
        return;
      }
      const states = output.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)/);
        return match && Number(match[1]) === processGroupId ? [match[2]] : [];
      });
      finish(states);
    });
    const timer = setTimeout(() => {
      probe.kill();
      finish(null);
    }, SUBPROCESS_TIMEOUT_MS);
    timer.unref?.();
  });
}
function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}
function killRoot(child, signal) {
  try {
    child.kill(signal);
  } catch {
  }
}

// vendor/process-host/spawn-observer.ts
import { appendFileSync } from "node:fs";
var observer = null;
var E2E_SPAWN_LOG_ENV = "ORCA_E2E_SPAWN_LOG";
var E2E_USER_DATA_DIR_ENV = "ORCA_E2E_USER_DATA_DIR";
function e2eSpawnLog() {
  return process.env[E2E_USER_DATA_DIR_ENV] && process.env[E2E_SPAWN_LOG_ENV] || void 0;
}
function notifySpawnObserver(command, args, blockMs) {
  observer?.(command, args, blockMs);
  const log = e2eSpawnLog();
  if (log) {
    try {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 60;
      const raw = new Error("spawn-log caller").stack ?? "";
      Error.stackTraceLimit = limit;
      const stack = raw.split("\n").slice(2).map((line) => line.trim()).filter((line) => !/\((node:|<anonymous>)|^at (new Promise|process\.)/.test(line)).slice(0, 30);
      appendFileSync(log, `${JSON.stringify({ file: command, args, at: Date.now(), stack })}
`);
    } catch {
    }
  }
}
function hasSpawnObserver() {
  return observer !== null || e2eSpawnLog() !== void 0;
}

// vendor/process-host/bounded-output-sink.ts
import { Buffer as Buffer2 } from "node:buffer";

// vendor/process-host/growing-byte-buffer.ts
var GrowingByteBuffer = class {
  storage = Buffer.alloc(0);
  // Live bytes are storage[start, start + length); the head offset keeps prefix discards O(1).
  start = 0;
  length = 0;
  get byteLength() {
    return this.length;
  }
  append(bytes) {
    if (bytes.byteLength === 0) {
      return;
    }
    const required = this.length + bytes.byteLength;
    if (this.start + required > this.storage.byteLength) {
      this.reclaimHeadRoom(required);
    }
    const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    source.copy(this.storage, this.start + this.length);
    this.length = required;
  }
  appendRetainedSuffix(bytes, maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("Retained suffix limit must be a non-negative safe integer");
    }
    if (maxBytes === 0) {
      this.clear();
      return;
    }
    const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (source.byteLength >= maxBytes) {
      this.storage = Buffer.from(source.subarray(source.byteLength - maxBytes));
      this.start = 0;
      this.length = maxBytes;
      return;
    }
    this.retainSuffix(maxBytes - source.byteLength);
    this.append(source);
  }
  indexOfByte(value, byteOffset = 0) {
    return this.storage.subarray(this.start, this.start + this.length).indexOf(value, byteOffset);
  }
  takePrefixString(byteLength, encoding = "utf8") {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) {
      throw new RangeError("Prefix length exceeds retained bytes");
    }
    const value = this.storage.toString(encoding, this.start, this.start + byteLength);
    this.discardPrefix(byteLength);
    return value;
  }
  discardPrefix(byteLength) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) {
      throw new RangeError("Prefix length exceeds retained bytes");
    }
    this.start += byteLength;
    this.length -= byteLength;
    if (this.length === 0) {
      this.start = 0;
    }
  }
  retainSuffix(maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("Suffix limit must be a non-negative safe integer");
    }
    if (this.length <= maxBytes) {
      return;
    }
    this.start += this.length - maxBytes;
    this.length = maxBytes;
    if (this.length === 0) {
      this.start = 0;
    }
  }
  toString(encoding = "utf8") {
    return this.storage.toString(encoding, this.start, this.start + this.length);
  }
  toBuffer() {
    return Buffer.from(this.storage.subarray(this.start, this.start + this.length));
  }
  takeString(encoding = "utf8") {
    const value = this.toString(encoding);
    this.clear();
    return value;
  }
  // Returns a view over the released storage, not a copy; the buffer never writes to it again.
  takeBuffer() {
    const value = this.storage.subarray(this.start, this.start + this.length);
    this.clear();
    return value;
  }
  clear() {
    this.storage = Buffer.alloc(0);
    this.start = 0;
    this.length = 0;
  }
  reclaimHeadRoom(required) {
    if (required * 2 <= this.storage.byteLength) {
      this.storage.copy(this.storage, 0, this.start, this.start + this.length);
    } else {
      const capacity = Math.max(required, Math.max(256, this.storage.byteLength * 2));
      const next = Buffer.allocUnsafe(capacity);
      this.storage.copy(next, 0, this.start, this.start + this.length);
      this.storage = next;
    }
    this.start = 0;
  }
};

// vendor/process-host/bounded-output-sink.ts
function createOutputSink(maxBytes, outputCapture = "head") {
  const chunks = [];
  const tail = outputCapture === "tail" ? new GrowingByteBuffer() : void 0;
  let bytes = 0;
  const buffer = () => tail ? tail.toBuffer() : chunks.length === 0 ? Buffer2.alloc(0) : chunks.length === 1 ? chunks[0] : Buffer2.concat(chunks);
  return {
    buffer,
    write(raw) {
      const chunk = Buffer2.isBuffer(raw) ? raw : Buffer2.from(raw);
      const remaining = maxBytes - bytes;
      bytes += chunk.length;
      if (tail) {
        tail.appendRetainedSuffix(chunk, maxBytes);
        return;
      }
      if (remaining <= 0) {
        return;
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
    },
    text: () => tail?.toString() ?? buffer().toString("utf8"),
    // Truncated JSONL can still parse as a valid, incomplete result.
    truncated: () => bytes > maxBytes
  };
}

// vendor/process-host/child-termination-reporter.ts
function createChildTerminationReporter(callback) {
  let reported = false;
  const report = () => {
    if (reported) {
      return;
    }
    reported = true;
    callback?.();
  };
  return { report, reportIf: (confirmed) => confirmed ? report() : void 0 };
}

// vendor/process-host/process-spec.ts
var DEFAULT_PROCESS_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// vendor/process-host/run-process.ts
var PROCESS_EXIT_GRACE_MS = 2e3;
var BARRIER_UNVERIFIED_EXIT_GRACE_MS = 1e4;
function spawnProcess(spec) {
  const resolved = resolveSpawn(spec, process.platform);
  const spawnStartedAt = hasSpawnObserver() ? performance.now() : null;
  const child = nodeSpawn3(resolved.file, [...resolved.args], resolved.options);
  if (spawnStartedAt !== null) {
    notifySpawnObserver(resolved.file, resolved.args, performance.now() - spawnStartedAt);
  }
  return child;
}
function runProcess(spec, outputCapture = "head") {
  if (spec.signal?.aborted) {
    spec.onChildTerminated?.();
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false });
  }
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve2, reject) => {
    const terminationReporter = createChildTerminationReporter(spec.onChildTerminated);
    let child;
    try {
      child = spawnProcess(spec);
    } catch (error) {
      terminationReporter.report();
      reject(error);
      return;
    }
    const stdout = createOutputSink(maxOutputBytes, outputCapture);
    const stderr = createOutputSink(maxOutputBytes, outputCapture);
    let timedOut = false;
    let settled = false;
    let barrierStopping = false;
    let barrierAttemptComplete = false;
    let barrierTerminationVerified = false;
    let initialBarrierTermination;
    let deferredExit = null;
    let deferredClose = null;
    let deferredError = null;
    let rootExitedBeforeBarrier = false;
    const settle = (act) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(barrierDeadlineTimer);
      spec.signal?.removeEventListener("abort", onAbort);
      act();
    };
    child.stdout?.on("data", (chunk) => {
      stdout.write(chunk);
      if (spec.killOnOutputLimit && stdout.truncated()) {
        stopAndSettle();
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr.write(chunk);
      spec.onStderr?.(chunk);
      if (spec.killOnOutputLimit && stderr.truncated()) {
        stopAndSettle();
      }
      if (typeof spec.terminationBarrier === "object") {
        spec.terminationBarrier.observeStderr?.(chunk);
      }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", () => {
      });
    }
    let graceTimer;
    let barrierDeadlineTimer;
    const signalBarrierTree = (signal) => (typeof spec.terminationBarrier === "object" ? spec.terminationBarrier.signal(child, signal) : signalProcessTree(child, signal)).catch(() => false);
    const forceBarrierTree = () => (typeof spec.terminationBarrier === "object" ? spec.terminationBarrier.force(child) : forceTerminateProcessTree(child)).catch(() => false);
    const resolveFromClose = (code, signal) => settle(
      () => resolve2({
        code,
        signal,
        stdout: spec.captureStdoutAsBytes ? "" : stdout.text(),
        ...spec.captureStdoutAsBytes ? { stdoutBytes: stdout.buffer() } : {},
        stderr: spec.captureStderrAsBytes ? "" : stderr.text(),
        ...spec.captureStderrAsBytes ? { stderrBytes: stderr.buffer() } : {},
        timedOut,
        outputTruncated: stdout.truncated() || stderr.truncated()
      })
    );
    const settleBarrierOutcome = () => {
      const rootExit = deferredClose ?? deferredExit;
      if (deferredError) {
        settle(() => reject(deferredError));
        return;
      }
      resolveFromClose(rootExit?.code ?? null, rootExit?.signal ?? null);
    };
    const markBarrierTerminationVerified = () => {
      barrierAttemptComplete = true;
      barrierTerminationVerified = true;
      terminationReporter.report();
      resolveBarrierIfSafe();
    };
    const killRootUnlessTreeKillInFlight = () => {
      if (!inFlightWindowsTreeKill(child)) {
        terminate(child, "SIGKILL");
      }
    };
    const resolveBarrierIfSafe = () => {
      const rootExit = deferredClose ?? deferredExit;
      if (barrierTerminationVerified || rootExitedBeforeBarrier && rootExit) {
        settleBarrierOutcome();
        return;
      }
      if (!barrierAttemptComplete) {
        return;
      }
      barrierDeadlineTimer ??= setTimeout(settleBarrierOutcome, BARRIER_UNVERIFIED_EXIT_GRACE_MS);
      barrierDeadlineTimer.unref?.();
    };
    const stopAndSettle = () => {
      if (spec.terminationBarrier) {
        barrierStopping = true;
        initialBarrierTermination ??= signalBarrierTree();
        if (process.platform === "win32") {
          void inFlightWindowsTreeKill(child)?.then(
            (verdict) => verdict === "exited" && markBarrierTerminationVerified()
          );
          void initialBarrierTermination.then(
            (terminated) => terminated && markBarrierTerminationVerified()
          );
        }
      } else {
        terminate(child);
      }
      graceTimer ??= setTimeout(() => {
        if (spec.terminationBarrier) {
          const initialTermination = initialBarrierTermination ?? Promise.resolve(false);
          if (process.platform === "win32") {
            if (typeof spec.terminationBarrier === "object") {
              void Promise.all([initialTermination, forceBarrierTree()]).then(
                ([initialTerminated, forceTerminated]) => {
                  barrierAttemptComplete = true;
                  barrierTerminationVerified = initialTerminated || forceTerminated;
                  terminationReporter.reportIf(barrierTerminationVerified);
                  if (!barrierTerminationVerified) {
                    killRootUnlessTreeKillInFlight();
                  }
                  resolveBarrierIfSafe();
                }
              );
              return;
            }
            void initialTermination.then((terminated) => {
              if (!terminated) {
                killRootUnlessTreeKillInFlight();
              }
              barrierAttemptComplete = true;
              barrierTerminationVerified = terminated;
              terminationReporter.reportIf(barrierTerminationVerified);
              resolveBarrierIfSafe();
            });
            return;
          }
          void Promise.all([initialTermination, forceBarrierTree()]).then(
            ([_initialTerminated, forceTerminated]) => {
              barrierAttemptComplete = true;
              barrierTerminationVerified = forceTerminated;
              terminationReporter.reportIf(barrierTerminationVerified);
              if (!barrierTerminationVerified) {
                terminate(child, "SIGKILL");
              }
              resolveBarrierIfSafe();
            }
          );
          return;
        }
        terminate(child, "SIGKILL");
        resolveFromClose(null, null);
      }, PROCESS_EXIT_GRACE_MS);
      graceTimer.unref?.();
    };
    const timer = spec.timeoutMs === null ? void 0 : setTimeout(() => {
      timedOut = true;
      stopAndSettle();
    }, spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
    timer?.unref?.();
    const onAbort = () => stopAndSettle();
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    if (spec.signal?.aborted) {
      onAbort();
    }
    child.once("error", (error) => {
      terminationReporter.reportIf(!child.pid);
      if (barrierStopping) {
        deferredError = error;
        resolveBarrierIfSafe();
        return;
      }
      settle(() => reject(error));
    });
    child.once("exit", (code, signal) => {
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true;
      }
      deferredExit = { code, signal };
      if (barrierStopping) {
        resolveBarrierIfSafe();
      }
    });
    child.once("close", (code, signal) => {
      terminationReporter.report();
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true;
      }
      if (barrierStopping) {
        deferredClose = { code, signal };
        resolveBarrierIfSafe();
        return;
      }
      resolveFromClose(code, signal);
    });
    child.stdin?.end(spec.input);
  });
}
function terminate(child, signal) {
  try {
    child.kill(signal);
  } catch {
  }
}

// worker/terminal-cli.mjs
async function runTerminalCli(args) {
  const entry = resolve(dirname(process.argv[1] || ""), "..", "cli", "index.js");
  let program = process.platform === "linux" ? "orca-ide" : "orca";
  let prefix = [];
  try {
    await access(entry);
    program = process.execPath;
    prefix = [entry];
  } catch {
    if (process.platform === "win32") {
      throw new Error("Terminal navigation requires the Orca desktop plugin worker.");
    }
  }
  const result = await runProcess({
    program,
    args: [...prefix, "terminal", ...args, "--json"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeoutMs: 8e3,
    maxOutputBytes: 256 * 1024
  });
  if (result.timedOut) {
    throw new Error("Terminal navigation timed out. Try again.");
  }
  let reply;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    throw new Error("The Orca CLI did not return a terminal result.");
  }
  if (!reply.ok) {
    const stale = reply.error?.code === "terminal_handle_stale" || reply.error?.message === "terminal_handle_stale";
    throw Object.assign(
      new Error(
        stale ? "This terminal address has expired. The terminal may have closed or Orca restarted." : reply.error?.message || "The terminal is no longer available."
      ),
      { code: stale ? "terminal_handle_stale" : reply.error?.code }
    );
  }
  return reply.result;
}
export {
  runTerminalCli
};
