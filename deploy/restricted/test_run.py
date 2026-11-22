"""Engine selection must survive startup, command failure and cleanup."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import run


class ContextTests(unittest.TestCase):
    def test_context_is_used_through_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            allowlist = Path(directory) / 'allowlist'
            allowlist.write_text('')
            for context in (None, 'isolated-engine'):
                for fail_at in (None, 'ps', 'build', 'up', 'run', 'down'):
                    with self.subTest(context=context, fail_at=fail_at):
                        calls = []
                        def execute(argv, **kwargs):
                            calls.append(argv)
                            operation = argv[argv.index('-f') + 2]
                            code = 7 if operation == fail_at else 0
                            if code and kwargs.get('check'):
                                raise subprocess.CalledProcessError(code, argv)
                            return subprocess.CompletedProcess(argv, code, stdout='')
                        argv = ['run.py', '--workspace', directory, '--allowlist', str(allowlist)]
                        if context is not None:
                            argv += ['--docker-context', context]
                        argv += ['--', 'true']
                        with patch.object(sys, 'argv', argv), patch.object(run.subprocess, 'run', side_effect=execute):
                            if fail_at in ('ps', 'build', 'up'):
                                with self.assertRaises(subprocess.CalledProcessError):
                                    run.main()
                            else:
                                self.assertEqual(run.main(), 7 if fail_at == 'run' else 0)
                        prefix = ['docker', '--context', context, 'compose'] if context else ['docker', 'compose']
                        self.assertTrue(all(call[:len(prefix)] == prefix for call in calls))
                        operations = [call[call.index('-f') + 2] for call in calls]
                        self.assertEqual(operations[-1], 'ps' if fail_at == 'ps' else 'down')

    def test_empty_or_option_context_is_rejected(self):
        for context in ('', ' ', '--host=elsewhere'):
            with self.assertRaises(ValueError):
                run.docker_command(context)
