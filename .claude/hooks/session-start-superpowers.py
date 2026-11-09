#!/usr/bin/env python3
"""SessionStart hook: inject the using-superpowers skill at conversation start.

Upstream (obra/superpowers) force-loads this skill through its plugin's own
SessionStart hook. The skills here are vendored as plain project skills, which
have no such hook, so this reproduces that behaviour.

Emits the skill body as `additionalContext`. Exits silently if the skill is
gone, so removing it can never break session startup.
"""
import json
import os
import pathlib
import sys

root = os.environ.get("CLAUDE_PROJECT_DIR")
root = pathlib.Path(root) if root else pathlib.Path(__file__).resolve().parents[2]
skill = root / ".claude" / "skills" / "using-superpowers" / "SKILL.md"

if not skill.is_file():
    sys.exit(0)

context = (
    "The following project skill is loaded automatically at the start of every "
    "session (source: .claude/skills/using-superpowers/SKILL.md). Treat it as "
    "active guidance for this session.\n\n" + skill.read_text(encoding="utf-8")
)

json.dump(
    {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    },
    sys.stdout,
)
