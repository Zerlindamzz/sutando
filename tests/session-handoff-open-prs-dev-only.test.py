#!/usr/bin/env python3
"""The Open PRs section is written only for a git-attached (developer-mode) checkout.

Run: python3 tests/session-handoff-open-prs-dev-only.test.py

Source-tied: the section is extracted from the live script and executed with a
stub `gh`, because running the whole script would overwrite the real
session-state.md. The packaged engine ships without .git, so a regular owner's
agent must not be handed Sutando repo PRs at session start.
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "src" / "session-handoff.sh"
BASH = shutil.which("bash") or "/bin/bash"


def _section() -> str:
    src = SCRIPT.read_text(encoding="utf-8")
    m = re.search(r"\n(  # Open PRs.*?)\n  # Pending questions", src, re.DOTALL)
    assert m, "Open PRs section not found in session-handoff.sh"
    return m.group(1)


def _run(*, git: bool) -> tuple[str, bool]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        repo = root / "repo"
        repo.mkdir()
        if git:
            (repo / ".git").mkdir()
        bindir = root / "bin"
        bindir.mkdir()
        called = root / "gh-called"
        gh = bindir / "gh"
        gh.write_text(f'#!/bin/sh\ntouch "{called}"\necho "#1 stub-pr"\n')
        gh.chmod(0o755)
        env = dict(os.environ, PATH=f"{bindir}:{os.environ.get('PATH', '')}")
        r = subprocess.run([BASH, "-c", f'REPO="{repo}"\n{_section()}'],
                           capture_output=True, text=True, env=env, timeout=30)
        assert r.returncode == 0, r.stderr
        return r.stdout, called.exists()


class OpenPrsDevOnly(unittest.TestCase):
    def test_packaged_install_has_no_open_prs_section(self):
        out, called = _run(git=False)
        self.assertNotIn("## Open PRs", out)
        self.assertFalse(called, "gh must not be queried on a non-developer install")

    def test_developer_mode_checkout_keeps_the_section(self):
        out, called = _run(git=True)
        self.assertIn("## Open PRs", out)
        self.assertIn("stub-pr", out)
        self.assertTrue(called)


if __name__ == "__main__":
    unittest.main(verbosity=2)
