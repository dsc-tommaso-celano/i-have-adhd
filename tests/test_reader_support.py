import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
LONG_TEXT = "Here is the plan for the migration, with the open question about the index. " * 4


def human(text, prompt_id="p-human"):
    return {
        "type": "user",
        "turnOrigin": "human",
        "promptSource": "typed",
        "origin": {"kind": "human"},
        "promptId": prompt_id,
        "message": {"role": "user", "content": text},
    }


def notification(prompt_id="p-auto"):
    return {
        "type": "user",
        "turnOrigin": "task_notification",
        "promptSource": "system",
        "promptId": prompt_id,
        "message": {"role": "user", "content": "<task-notification>\n<status>completed</status>\n</task-notification>"},
    }


def assistant(text):
    return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def write_tool(file_path):
    return {
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "name": "Write", "input": {"file_path": file_path, "content": "# Plan"}}],
        },
    }


def tool_result():
    return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}


@unittest.skipUnless(NODE, "node is required")
class ReaderSupportHookTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.tmp = Path(self.temp_dir.name)
        self.plugin_root = self.tmp / "plugin with spaces"
        shutil.copytree(ROOT / "hooks", self.plugin_root / "hooks")
        self.config_dir = self.tmp / "claude config"
        self.config_dir.mkdir()
        self.transcript = self.tmp / "session.jsonl"

    def opt_in(self):
        (self.config_dir / ".i-have-adhd-always").write_text("")

    def run_hook(self, payload, entries=()):
        self.transcript.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
        payload = {"session_id": "sess-1", "cwd": str(self.tmp), "transcript_path": str(self.transcript), **payload}
        env = os.environ.copy()
        env["CLAUDE_CONFIG_DIR"] = str(self.config_dir)
        result = subprocess.run(
            [NODE, str(self.plugin_root / "hooks" / "reader-support.mjs")],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def stop(self, message, entries, prompt_id="p-human", **extra):
        return self.run_hook(
            {"hook_event_name": "Stop", "last_assistant_message": message, "prompt_id": prompt_id, "stop_hook_active": False, **extra},
            entries,
        )

    def test_silent_when_mode_is_off(self):
        entries = [human("hi"), assistant(LONG_TEXT), notification(), assistant("Phase 2 is blocked by WP-3.")]
        self.assertIsNone(self.stop("Phase 2 is blocked by WP-3.", entries, prompt_id="p-auto"))

    def test_typed_command_turns_mode_on_and_normal_mode_turns_it_off(self):
        on = [human("<command-name>/i-have-adhd</command-name>"), assistant("Phase 2 is next.")]
        self.assertIsNotNone(self.stop("Phase 2 is next.", on))
        off = on + [human("normal mode", "p-2"), assistant("Phase 2 is next.")]
        self.assertIsNone(self.stop("Phase 2 is next.", off, prompt_id="p-2"))

    def test_turn_started_by_reader_needs_no_catch_up(self):
        self.opt_in()
        entries = [human("fix it"), assistant(LONG_TEXT)]
        self.assertIsNone(self.stop(LONG_TEXT, entries))

    def test_notification_after_unread_text_requires_where_we_are(self):
        self.opt_in()
        entries = [human("plan it"), assistant(LONG_TEXT), notification(), assistant("The reviewer agent finished.")]
        result = self.stop("The reviewer agent finished.", entries, prompt_id="p-auto")
        self.assertEqual("block", result["decision"])
        self.assertIn("Where we are", result["reason"])
        self.assertIn("follow-up", result["reason"])

    def test_where_we_are_block_satisfies_the_catch_up(self):
        self.opt_in()
        message = "The reviewer agent finished.\n\n**Where we are**\n1. Plan drafted."
        entries = [human("plan it"), assistant(LONG_TEXT), notification(), assistant(message)]
        self.assertIsNone(self.stop(message, entries, prompt_id="p-auto"))

    def test_short_unread_text_needs_no_catch_up(self):
        self.opt_in()
        entries = [human("plan it"), assistant("waiting"), notification(), assistant("Done.")]
        self.assertIsNone(self.stop("Done.", entries, prompt_id="p-auto"))

    def test_stop_hook_active_never_blocks_twice(self):
        self.opt_in()
        entries = [human("plan it"), assistant(LONG_TEXT), notification(), assistant("Done.")]
        self.assertIsNone(self.stop("Done.", entries, prompt_id="p-auto", stop_hook_active=True))

    def test_subagent_stop_is_ignored(self):
        self.opt_in()
        self.assertIsNone(self.stop("Phase 2 is next.", [human("go")], agent_id="a-1"))

    def test_written_plan_requires_walkthrough_offer_with_side_session_command(self):
        self.opt_in()
        entries = [human("write the spec"), write_tool("docs/auth.spec.md"), tool_result(), assistant("Spec written.")]
        result = self.stop("Spec written.", entries)
        self.assertEqual("block", result["decision"])
        self.assertIn("walkthrough offer", result["reason"])
        self.assertIn('claude --resume sess-1 --fork-session "/i-have-adhd:walkthrough docs/auth.spec.md"', result["reason"])
        self.assertIn("side-session.mjs", result["reason"])

    def test_walkthrough_offer_satisfies_the_check(self):
        self.opt_in()
        message = "Spec written. Next: approve it, or walk through it first?"
        entries = [human("write the spec"), write_tool("docs/auth.spec.md"), tool_result(), assistant(message)]
        self.assertIsNone(self.stop(message, entries))

    def test_bare_labels_require_a_legend(self):
        self.opt_in()
        result = self.stop("Phase 2 is blocked by WP-3. Then §4.1 decides option B.", [human("status?")])
        reason = result["reason"]
        for label in ("Phase 2", "WP-3", "§4.1", "option B"):
            self.assertIn(label, reason)

    def test_explained_labels_pass(self):
        self.opt_in()
        messages = [
            "Phase 2 (moving auth into middleware) is blocked by WP-3: the token fix.",
            "Step 3 of 5 done: schema updated.",
            "Blocked by the token fix (WP-3). Later, WP-3 ships.",
            "| WP-3 | token fix |",
            "## Phase 1 — Setup",
            "1. **Phase 1, Foundation (0.5 day):** set up Redis.\nThen Phase 1 ships.",
            "## Phase 2 Rollout",
            "Run `phase 2` code: ```\nPhase 3 x\n```",
        ]
        for message in messages:
            with self.subTest(message=message):
                self.assertIsNone(self.stop(message, [human("status?")]))

    def test_post_tool_use_reminds_after_writing_a_design_doc(self):
        self.opt_in()
        result = self.run_hook(
            {"hook_event_name": "PostToolUse", "tool_name": "Write", "tool_input": {"file_path": "docs/architecture.md"}},
            [human("design it")],
        )
        context = result["hookSpecificOutput"]["additionalContext"]
        self.assertEqual("PostToolUse", result["hookSpecificOutput"]["hookEventName"])
        self.assertIn("walkthrough offer", context)
        self.assertIn("--fork-session", context)

    def test_post_tool_use_marks_plan_mode_plans(self):
        self.opt_in()
        result = self.run_hook(
            {"hook_event_name": "PostToolUse", "tool_name": "Write", "tool_input": {"file_path": "/home/u/.claude/plans/quiet-fox.md"}},
            [human("plan it")],
        )
        self.assertIn("approval prompt", result["hookSpecificOutput"]["additionalContext"])

    def test_post_tool_use_ignores_code_and_other_documents(self):
        self.opt_in()
        for file_path in ("src/auth.spec.ts", "README.md", "docs/designer-notes.png", "notes/explanation.md"):
            with self.subTest(file_path=file_path):
                self.assertIsNone(
                    self.run_hook(
                        {"hook_event_name": "PostToolUse", "tool_name": "Write", "tool_input": {"file_path": file_path}},
                        [human("go")],
                    )
                )

    def test_doc_paths_that_count(self):
        self.opt_in()
        for file_path in ("PLAN.md", "docs/adr/0004-cache.md", "app/requirements/x/feature.spec.md", "design-doc.md", "C:\\repo\\architecture.md"):
            with self.subTest(file_path=file_path):
                self.assertIsNotNone(
                    self.run_hook(
                        {"hook_event_name": "PostToolUse", "tool_name": "Edit", "tool_input": {"file_path": file_path}},
                        [human("go")],
                    )
                )

    def test_bad_input_fails_open(self):
        env = os.environ.copy()
        env["CLAUDE_CONFIG_DIR"] = str(self.config_dir)
        self.opt_in()
        for stdin in ("", "not json", json.dumps({"hook_event_name": "Stop", "transcript_path": str(self.tmp / "missing.jsonl")})):
            with self.subTest(stdin=stdin):
                result = subprocess.run(
                    [NODE, str(self.plugin_root / "hooks" / "reader-support.mjs")],
                    input=stdin, capture_output=True, text=True, env=env, check=False,
                )
                self.assertEqual((0, "", ""), (result.returncode, result.stdout, result.stderr))

    def test_registered_through_the_shared_plugin_launcher(self):
        config = json.loads((ROOT / "hooks" / "hooks.json").read_text())
        self.opt_in()
        for event in ("Stop", "PostToolUse"):
            with self.subTest(event=event):
                command = config["hooks"][event][0]["hooks"][0]["command"]
                self.assertIn("reader-support.mjs", command)
                env = os.environ.copy()
                env["CLAUDE_CONFIG_DIR"] = str(self.config_dir)
                env["CLAUDE_PLUGIN_ROOT"] = str(self.plugin_root)
                self.transcript.write_text(json.dumps(human("go")) + "\n")
                result = subprocess.run(
                    command,
                    shell=True,
                    input=json.dumps({"hook_event_name": "Stop", "transcript_path": str(self.transcript), "last_assistant_message": "Phase 9 next."}),
                    capture_output=True,
                    text=True,
                    env=env,
                    check=False,
                )
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertIn("Phase 9", result.stdout)


@unittest.skipUnless(NODE, "node is required")
class SideSessionTest(unittest.TestCase):
    def test_dry_run_forks_the_session_into_the_walkthrough(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [NODE, str(ROOT / "hooks" / "side-session.mjs"), "sess-1", tmp, "docs/my plan.md", "--dry-run"],
                capture_output=True, text=True, check=False,
            )
        if result.returncode == 1:
            self.assertIn("--fork-session", result.stderr)
            return
        self.assertEqual(0, result.returncode, result.stderr)
        launch = json.dumps(json.loads(result.stdout))
        self.assertIn("--fork-session", launch)
        self.assertIn("/i-have-adhd:walkthrough docs/my plan.md", launch)

    def test_rejects_unsafe_session_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [NODE, str(ROOT / "hooks" / "side-session.mjs"), "x; rm -rf /", tmp, "plan.md", "--dry-run"],
                capture_output=True, text=True, check=False,
            )
        self.assertEqual(2, result.returncode)


if __name__ == "__main__":
    unittest.main()
