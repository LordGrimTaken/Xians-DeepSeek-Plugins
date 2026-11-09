import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `run_hidden`: start a windowed program on an invisible Windows desktop, confirm it stayed alive, stop it.
 *
 * The desktop is created by `hidden-run.ps1` next to this module (CreateDesktop + CreateProcessW with
 * STARTUPINFO.lpDesktop set to it). The runner reports whether the process survived and how many of its windows
 * appeared on the interactive desktop — that count must be zero.
 *
 * This bundle imports nothing from the harness: a linked workspace package cannot resolve the harness's own
 * packages, so the tool definition is authored directly in the enforced raw JSON-Schema subset that the tool
 * registry accepts.
 *
 * @module @local/dsh-plugin-run-hidden
 */

export const name = "tool-run-hidden";
export const inject = ["tools"];

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "hidden-run.ps1");

/** Why the runner exited non-zero. */
const EXIT_REASONS = {
  1: "could not create the hidden desktop or start the process",
  2: "the process exited before the window closed (a launcher stub or a crash)",
  3: "a window appeared on the real desktop",
};

/** Model-facing parameter schema (enforced subset: type/properties/required/items/description). */
const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    exe: { type: "string", description: "Absolute path of the executable to start." },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Arguments for the program, one entry per argument.",
    },
    cwd: { type: "string", description: "Working directory to start it in. Defaults to the current directory." },
    seconds: { type: "integer", description: "How long to let it run before it is stopped (1-120, default 6)." },
  },
  required: ["exe"],
};

/** Result schema; only the fields actually reported are present. */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean", description: "True only when the program ran hidden and was stopped cleanly." },
    survived: { type: "boolean", description: "The program was still running when the window closed." },
    realDesktopWindows: { type: "integer", description: "Visible windows it put on the real desktop (must be 0)." },
    pid: { type: "integer", description: "Process id used for the run." },
    desktop: { type: "string", description: "Name of the throwaway desktop it ran on." },
    seconds: { type: "integer", description: "How long it was allowed to run." },
    exitCode: { type: "integer", description: "Runner exit code when ok is false." },
    error: { type: "string", description: "Why the run failed, when it did." },
  },
};

/**
 * Spawn PowerShell and collect its output.
 * @param {string[]} args - PowerShell arguments.
 * @param {number} timeoutMs - hard limit before the child is killed.
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("powershell.exe", args, { windowsHide: true });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, stdout, stderr: `${stderr}\n(timed out after ${timeoutMs} ms)` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ code: null, stdout, stderr: String(error?.message ?? error) }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

/**
 * Run one program on a hidden desktop.
 * @param {{ exe?: unknown, args?: unknown, cwd?: unknown, seconds?: unknown }} input - tool arguments.
 * @returns {Promise<Record<string, unknown>>} the tool result value.
 */
async function runHidden(input) {
  if (process.platform !== "win32") {
    return { ok: false, error: "run_hidden is Windows-only. Use a headless renderer or the app's own headless switch elsewhere." };
  }
  const exe = String(input?.exe ?? "").trim();
  if (!exe) return { ok: false, error: "exe is required: the absolute path of the executable to start." };
  const requested = Number(input?.seconds);
  const seconds = Math.min(120, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 6));
  const args = Array.isArray(input?.args) ? input.args.map((a) => String(a)) : [];
  const cwd = typeof input?.cwd === "string" && input.cwd.trim() ? input.cwd : undefined;

  const dir = await mkdtemp(path.join(tmpdir(), "dsh-run-hidden-"));
  try {
    const requestFile = path.join(dir, "request.json");
    await writeFile(requestFile, JSON.stringify({ exe, args, cwd, seconds }), "utf8");
    const r = await runPowerShell(
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", RUNNER, "-RequestFile", requestFile],
      (seconds + 60) * 1000,
    );
    const line = r.stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
    let parsed;
    if (line) {
      try { parsed = JSON.parse(line); } catch { parsed = undefined; }
    }
    if (!parsed) {
      return {
        ok: false,
        exitCode: r.code ?? undefined,
        error: (r.stderr || r.stdout || "").trim().slice(0, 1000) || "no output from the hidden runner",
      };
    }
    const ok = r.code === 0;
    /** @type {Record<string, unknown>} */
    const value = {
      ok,
      survived: parsed.survived === true,
      realDesktopWindows: Number(parsed.realDesktopWindows) || 0,
      seconds: Number(parsed.survivedSeconds) || seconds,
    };
    if (Number.isInteger(parsed.pid)) value.pid = parsed.pid;
    if (parsed.desktop) value.desktop = String(parsed.desktop);
    if (!ok) {
      value.exitCode = r.code ?? undefined;
      value.error = EXIT_REASONS[r.code] ?? (r.stderr.trim().slice(0, 600) || `runner exited ${r.code}`);
      if (value.exitCode === undefined) delete value.exitCode;
    }
    return value;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}

/**
 * One line the model reads back.
 * @param {Record<string, any>} value - tool result value.
 * @returns {string}
 */
function describeResult(value) {
  if (!value || value.ok !== true) {
    const code = value?.exitCode != null ? ` (exit ${value.exitCode})` : "";
    return `run_hidden failed${code}: ${value?.error ?? "unknown error"}`;
  }
  return `Ran hidden for ${value.seconds}s: survived=${value.survived === true}, windows on the real desktop=${value.realDesktopWindows}. Process stopped.`;
}

/**
 * Register the tool.
 * @param {any} ctx - registrant context carrying the tool registry.
 */
export function apply(ctx) {
  ctx.tools.register({
    name: "run_hidden",
    description:
      "Start a windowed program on an invisible Windows desktop so no window ever appears on the user's screen, " +
      "confirm it stayed alive, then stop it. Use it to smoke-test GUI programs (Electron clients, launchers, " +
      "installers) without disturbing the user. It reports whether the process survived and how many of its " +
      "windows appeared on the real desktop (must be 0). Windows only. For a VISUAL check prefer a headless " +
      "renderer or the app's own headless switch — a hidden desktop is not composited and cannot be screenshotted.",
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: describeResult(value) }],
    },
    execute: (args) => runHidden(args),
    isConcurrencySafe: () => true,
    timeoutMs: 180000,
    presentCall: (args) => ({
      card: "generic",
      title: `Run hidden: ${path.basename(String(args?.exe ?? "program")) || "program"}`,
      kind: "execute",
      rawInput: args,
    }),
  });
}
