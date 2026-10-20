// Opens a forked Claude Code session in a new terminal window and starts the
// walkthrough there, so the main conversation stays short.
//
//   node side-session.mjs <session-id> <project-dir> <document-path> [--dry-run]
//
// The fork copies the conversation so far (claude --resume <id> --fork-session),
// so the walkthrough can explain why the document says what it says.
// Prints what it launched. Exits 1 with the manual command when no terminal
// could be opened.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [sessionId, projectDir, docPath] = args.filter((a) => a !== "--dry-run");
const claude = process.env.I_HAVE_ADHD_CLAUDE_BIN || "claude";

if (!sessionId || !projectDir || !docPath || !/^[\w-]+$/.test(sessionId)) {
  console.error("usage: side-session.mjs <session-id> <project-dir> <document-path>");
  process.exit(2);
}
if (!fs.existsSync(projectDir)) {
  console.error(`project directory not found: ${projectDir}`);
  process.exit(2);
}

const prompt = `/i-have-adhd:walkthrough ${docPath}`;
const claudeArgs = ["--resume", sessionId, "--fork-session", prompt];
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const manual = `cd "${projectDir}"; ${claude} --resume ${sessionId} --fork-session "${prompt}"`;

function onPath(bin) {
  const probe = process.platform === "win32" ? spawnSync("where", [bin]) : spawnSync("sh", ["-c", `command -v ${bin}`]);
  return probe.status === 0;
}

function plan() {
  if (process.platform === "win32") {
    if (!process.env.I_HAVE_ADHD_NO_WT && onPath("wt.exe")) {
      // Windows Terminal treats ";" as its own command separator.
      return { cmd: "wt.exe", args: ["-w", "new", "-d", projectDir, claude, ...claudeArgs.map((a) => a.replace(/;/g, "\\;"))] };
    }
    // start needs an empty quoted title, so build the command line by hand.
    return {
      cmd: "cmd.exe",
      args: [`/c start "" /D "${projectDir}" cmd /k ${claude} --resume ${sessionId} --fork-session "${prompt}"`],
      verbatim: true,
    };
  }
  const line = `cd ${sh(projectDir)} && ${[claude, ...claudeArgs].map(sh).join(" ")}`;
  if (process.platform === "darwin") {
    const escaped = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return { cmd: "osascript", args: ["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", 'tell application "Terminal" to activate'] };
  }
  for (const [bin, flag] of [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]]) {
    if (onPath(bin)) return { cmd: bin, args: [flag, "sh", "-c", line] };
  }
  return null;
}

const launch = plan();
if (!launch) {
  console.error(`No terminal found. Run this yourself:\n${manual}`);
  process.exit(1);
}
if (dryRun) {
  console.log(JSON.stringify(launch));
  process.exit(0);
}
try {
  const child = spawn(launch.cmd, launch.args, {
    cwd: projectDir,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    windowsVerbatimArguments: Boolean(launch.verbatim),
  });
  child.on("error", () => {
    console.error(`Could not open a terminal. Run this yourself:\n${manual}`);
    process.exit(1);
  });
  child.unref();
  setTimeout(() => {
    console.log(`Opened a side session for ${docPath} in a new terminal window.`);
    process.exit(0);
  }, 500);
} catch {
  console.error(`Could not open a terminal. Run this yourself:\n${manual}`);
  process.exit(1);
}
