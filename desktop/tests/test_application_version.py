import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('app_builder', Path(__file__).parents[1] / 'build_app.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ApplicationVersionChecks(unittest.TestCase):
    def test_application_version_follows_project_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'package.json').write_text(json.dumps({'version': '0.1.1'}))
            with patch.object(builder, 'ROOT', root):
                self.assertEqual(builder.application_version(), '0.1.1')

    def test_invalid_metadata_cannot_enter_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'package.json').write_text(json.dumps({'version': False}))
            with patch.object(builder, 'ROOT', root), self.assertRaisesRegex(SystemExit, 'APPLICATION_VERSION_INVALID'):
                builder.application_version()
