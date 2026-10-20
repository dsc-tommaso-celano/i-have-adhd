// Reader-support hooks for Claude Code: enforce rules 11 to 13 of the skill
// when ADHD mode is on (always-on flag, or /i-have-adhd typed this session).
//
//   Stop         Checks the final message before the reader sees the turn end:
//                - rule 12: a turn started by a subagent or background task,
//                  while the reader has not answered earlier text, must end
//                  with a "Where we are" block;
//                - rule 13: a turn that wrote a plan or design document must
//                  offer a walkthrough;
//                - rule 11: a phase, step, or code label must be explained at
//                  least once in the message.
//                Anything missing is sent back as one block reason, asking for
//                a short follow-up message instead of a rewrite.
//   PostToolUse  After a plan or design document is written, reminds Claude to
//                offer the walkthrough and gives the exact side-session command.
//
// The transcript format is internal to Claude Code. Every check fails open:
// unknown input, unreadable files, or any error means exit 0 with no output.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNREAD_MIN_CHARS = 200;
const CATCH_UP_MARKER = /where we are/i;
const WALKTHROUGH_MARKER = /walk\s*(?:me\s+|you\s+|us\s+)?through|walkthrough/i;
const DOC_EXTENSIONS = /\.(?:md|mdx|markdown|txt|adoc|rst)$/i;
const DOC_WORDS =
  /(?:^|[\\/._-])(?:plans?|specs?|specification|architecture|arch|design|adrs?|rfcs?|proposal|roadmap|blueprint)(?=[\\/._-]|$)/i;
const DOC_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const ACTIVATE = /<command-name>\/i-have-adhd(?::[\w-]+)?<\/command-name>|^\s*\/i-have-adhd(?::[\w-]+)?(?:\s|$)/;
const DEACTIVATE = /\b(?:stop adhd mode|normal mode)\b/i;
const AUTOMATED_TEXT = /^\s*(?:<task-notification>|\[SYSTEM NOTIFICATION)/;
const IGNORED_TEXT = /^\s*<local-command-(?:stdout|stderr|caveat)>/;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const entries = [];
  for (const line of fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partially flushed last line is not fatal.
    }
  }
  return entries.filter((e) => !e.isSidechain);
}

function contentBlocks(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function entryText(entry) {
  return contentBlocks(entry)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// "human": the reader typed it. "auto": a subagent, background task, or other
// system event started a turn. "other": tool results, metadata, local output.
export function classify(entry) {
  if (entry?.type !== "user" || entry.isMeta) return "other";
  const blocks = contentBlocks(entry);
  if (blocks.some((b) => b.type === "tool_result")) return "other";
  const text = entryText(entry);
  if (
    entry.turnOrigin === "human" ||
    entry.origin?.kind === "human" ||
    entry.promptSource === "typed" ||
    entry.turnOrigin === "sdk" ||
    entry.promptSource === "sdk"
  ) {
    return "human";
  }
  if (entry.promptSource === "system" || entry.turnOrigin || AUTOMATED_TEXT.test(text)) {
    return "auto";
  }
  if (IGNORED_TEXT.test(text) || !text.trim()) return "other";
  return "human";
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function isModeActive(entries) {
  let active = fs.existsSync(path.join(configDir(), ".i-have-adhd-always"));
  for (const entry of entries) {
    if (classify(entry) !== "human") continue;
    const text = entryText(entry);
    if (ACTIVATE.test(text)) active = true;
    else if (DEACTIVATE.test(text)) active = false;
  }
  return active;
}

export function isDocPath(filePath) {
  if (typeof filePath !== "string" || !DOC_EXTENSIONS.test(filePath)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return DOC_WORDS.test(normalized.replace(DOC_EXTENSIONS, "")) || /\/\.claude\/plans\//.test(normalized);
}

// Labels a reader cannot decode on their own: "Phase 2", "Option B", "§4.1",
// "WP-3", "ADR-004". A label passes when at least one occurrence in the
// message carries its meaning: "Phase 2 (auth middleware)", "WP-3: token fix",
// "the token fix (WP-3)", or a table cell next to a description.
const LABEL_WORDS = ["Phase", "Wave", "Stage", "Step", "Milestone", "Option", "Section", "Chapter", "Part", "Sprint", "Iteration", "Approach", "Scenario", "Work package"]
  // Either case for the word, but only a capital letter as the label: "option B", not "part a".
  .map((w) => `[${w[0]}${w[0].toLowerCase()}]${w.slice(1)}`)
  .join("|");
const LABEL_PATTERNS = [
  new RegExp(`\\b(?:${LABEL_WORDS})\\s+(?:\\d+(?:\\.\\d+)*[a-z]?|[A-H])\\b`, "g"),
  /§\s*\d+(?:\.\d+)*/g,
  /\b(?:WP|FR|NFR|AC|ADR|RFC|REQ|US|UC|BR|TC|DEC|RISK)-?\d+(?:\.\d+)?\b|\b[RD]-\d+\b/g,
];
const AFTER_LABEL = /^[*_]*[ \t]*(?:(?:of|\/)[ \t]*\d+[ \t]*)?(?:(?:is[ \t]+)?(?:done|complete|completed|finished)[ \t]*)?[*_]*[ \t]*(?:[(:=|—–]|-[ \t])/;
const BEFORE_LABEL = /[(|]\s*[*_]*$/;
// A label opening a list item or heading, followed by text, defines itself:
// "1. **Phase 1, Foundation:** set up Redis", "## Phase 2 Rollout".
const LINE_START = /(?:^|\n)[ \t]*(?:[-*+>]|\d+[.)]|#{1,6})?[ \t]*[*_]*$/;
const REST_OF_LINE = /^[*_]*[ \t]*(?:[,(:—–-]|[*_]*[A-Z])[^\n]*?[A-Za-z]{2,}/;

export function findBareLabels(message) {
  const text = String(message || "")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const seen = new Map();
  for (const pattern of LABEL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const label = match[0].replace(/\s+/g, " ");
      const key = label.toLowerCase();
      const end = match.index + match[0].length;
      const before = text.slice(Math.max(0, match.index - 12), match.index);
      const explained =
        AFTER_LABEL.test(text.slice(end, end + 40)) ||
        BEFORE_LABEL.test(before.slice(-4)) ||
        (LINE_START.test(before) && REST_OF_LINE.test(text.slice(end)));
      if (!seen.has(key)) seen.set(key, { label, explained });
      else if (explained) seen.get(key).explained = true;
    }
  }
  return [...seen.values()].filter((v) => !v.explained).map((v) => v.label);
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function sideSessionText(sessionId, cwd, docPath) {
  const prompt = `/i-have-adhd:walkthrough ${docPath}`;
  const command = `cd ${quoteArg(cwd)}; claude --resume ${sessionId} --fork-session ${quoteArg(prompt)}`;
  const opener = `node ${quoteArg(path.join(scriptDir, "side-session.mjs"))} ${quoteArg(sessionId)} ${quoteArg(cwd)} ${quoteArg(docPath)}`;
  return (
    `Side session for the walkthrough (a fork with this conversation, so the main thread stays short):\n` +
    `- Reader runs it themselves: ${command}\n` +
    `- If the reader says yes, open it for them in a new terminal window by running: ${opener}\n` +
    `  If that fails, give them the command above.`
  );
}

function docsWrittenSince(entries, startIndex) {
  const docs = [];
  for (const entry of entries.slice(startIndex + 1)) {
    if (entry.type !== "assistant") continue;
    for (const block of contentBlocks(entry)) {
      if (block.type !== "tool_use" || !DOC_TOOLS.has(block.name)) continue;
      const filePath = block.input?.file_path;
      if (isDocPath(filePath) && !docs.includes(filePath)) docs.push(filePath);
    }
  }
  return docs;
}

function lastIndex(entries, predicate) {
  for (let i = entries.length - 1; i >= 0; i--) if (predicate(entries[i])) return i;
  return -1;
}

export function stopReasons(input, entries) {
  const message = input.last_assistant_message;
  if (typeof message !== "string" || !message.trim()) return [];
  const missing = [];

  let turnStart = input.prompt_id
    ? lastIndex(entries, (e) => e.promptId === input.prompt_id && classify(e) !== "other")
    : -1;
  if (turnStart < 0) turnStart = lastIndex(entries, (e) => classify(e) !== "other");

  // Rule 12: the reader has not answered text sent before this automatic turn.
  if (turnStart >= 0 && classify(entries[turnStart]) === "auto") {
    const lastHuman = lastIndex(entries.slice(0, turnStart), (e) => classify(e) === "human");
    const unread = entries
      .slice(lastHuman + 1, turnStart)
      .filter((e) => e.type === "assistant")
      .map(entryText)
      .join("\n");
    if (unread.trim().length >= UNREAD_MIN_CHARS && !CATCH_UP_MARKER.test(message)) {
      missing.push(
        "A block headed **Where we are** (rule 12). The reader has not answered your earlier messages and will probably read only this one. " +
          "Include: where the work stands in one or two lines; every open question or decision from those unanswered messages, written out in full; the one thing you need from the reader.",
      );
    }
  }

  // Rule 13: a plan or design document was written during this turn.
  const docs = turnStart >= 0 ? docsWrittenSince(entries, turnStart) : [];
  if (docs.length && !WALKTHROUGH_MARKER.test(message)) {
    missing.push(
      `The walkthrough offer (rule 13) for ${docs.join(", ")}: one line asking whether the reader wants to walk through it together, merged with the next action.\n` +
        sideSessionText(input.session_id, input.cwd || process.cwd(), docs[0]),
    );
  }

  // Rule 11: labels with no meaning attached anywhere in the message.
  const labels = findBareLabels(message);
  if (labels.length) {
    missing.push(
      `A one-line legend for ${labels.join(", ")} (rule 11): what each label stands for, in five words or so, e.g. "Phase 2 = moving auth into middleware".`,
    );
  }
  return missing;
}

function stop(input) {
  if (input.stop_hook_active || input.agent_id) return;
  const entries = readTranscript(input.transcript_path);
  if (!isModeActive(entries)) return;
  const missing = stopReasons(input, entries);
  if (!missing.length) return;
  const reason =
    "i-have-adhd reader check. Your last message is missing:\n\n" +
    missing.map((m, i) => `${i + 1}. ${m}`).join("\n\n") +
    "\n\nSend one short follow-up message that adds only what is missing, in the order listed. Do not repeat or rewrite the rest of your message, and do not mention this check.";
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

function postToolUse(input) {
  if (!DOC_TOOLS.has(input.tool_name)) return;
  const docPath = input.tool_input?.file_path;
  if (!isDocPath(docPath)) return;
  if (!isModeActive(readTranscript(input.transcript_path))) return;
  const planMode = /[\\/]\.claude[\\/]plans[\\/]/.test(docPath);
  const context =
    `i-have-adhd: ${docPath} is a plan or design document. When you present it, make your last line the walkthrough offer (rule 13) merged with the next action, once, e.g. "Next: approve it, or walk through it in a side session first?"` +
    (planMode
      ? " This is a plan-mode plan: add the offer and the reader's command below as the last line of the plan, so the reader sees it in the approval prompt."
      : "") +
    `\n${sideSessionText(input.session_id, input.cwd || process.cwd(), docPath)}`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }),
  );
}

try {
  const raw = readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  if (input.hook_event_name === "Stop") stop(input);
  else if (input.hook_event_name === "PostToolUse") postToolUse(input);
} catch {
  // Never block the session on a hook failure.
}
process.exitCode = 0;
