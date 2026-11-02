"""CLI regression tests: venv/bin/python -m unittest discover -s tests -p test_safetensors_metadata.py -v."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from safetensors import safe_open
from safetensors.numpy import save_file


SCRIPT = Path(__file__).resolve().parents[1] / "safetensors_metadata.py"


class MetadataExportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.models = self.root / "models"
        self.models.mkdir()

    def model(self, name="model.safetensors", metadata=None):
        path = self.models / name
        path.parent.mkdir(parents=True, exist_ok=True)
        save_file({"weights": np.array([1.5, 2.5], dtype=np.float32)}, str(path), metadata=metadata)
        return path

    def run_cli(self, *args, expected=0):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *(str(arg) for arg in args)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_single_export_preserves_complete_raw_metadata_and_model_bytes(self):
        metadata = {"title": "שלום café", "nested": '{"tags": ["a", "b"]}', "long": "x" * 3000,
                    "numeric_string": "123", "empty": ""}
        model = self.model(metadata=metadata)
        original = model.read_bytes()
        output = self.root / "metadata" / "model.json"
        self.run_cli(model, "--output", output)
        self.assertEqual(json.loads(output.read_text()), metadata)
        self.assertEqual(model.read_bytes(), original)
        self.assertEqual(list(output.parent.iterdir()), [output])

    def test_directory_with_one_model_still_uses_output_directory(self):
        self.model(metadata={"title": "single"})
        output = self.root / "metadata"
        self.run_cli(self.models, "--read", "--output", output)
        self.assertEqual(json.loads((output / "model.json").read_text()), {"title": "single"})

    def test_recursive_export_preserves_paths_for_duplicate_names(self):
        self.model("one/model.safetensors", {"title": "one"})
        self.model("two/model.safetensors", {"title": "two"})
        output = self.models / "metadata"
        self.run_cli(self.models, "--output", output, "--recursive")
        for name in ("one", "two"):
            self.assertEqual(json.loads((output / name / "model.json").read_text()), {"title": name})
        self.assertEqual(len(list(output.rglob("*.json"))), 2)

    def test_empty_metadata_exports_empty_object(self):
        model = self.model()
        output = self.root / "empty.json"
        self.run_cli(model, "--output", output)
        self.assertEqual(json.loads(output.read_text()), {})

    def test_existing_export_requires_overwrite(self):
        model = self.model(metadata={"title": "new"})
        output = self.root / "model.json"
        output.write_text('{"title": "existing"}')
        self.run_cli(model, "--output", output, expected=2)
        self.assertEqual(json.loads(output.read_text()), {"title": "existing"})
        self.run_cli(model, "--output", output, "--overwrite")
        self.assertEqual(json.loads(output.read_text()), {"title": "new"})

    def test_export_cannot_overwrite_model_or_symlink_to_model(self):
        model = self.model(metadata={"title": "safe"})
        original = model.read_bytes()
        self.run_cli(model, "--output", model, "--overwrite", expected=2)
        link = self.root / "alias.json"
        link.symlink_to(model)
        self.run_cli(model, "--output", link, "--overwrite", expected=2)
        self.assertEqual(model.read_bytes(), original)

    def test_console_read_and_help_still_work(self):
        model = self.model(metadata={"title": "console"})
        result = self.run_cli(model)
        self.assertIn("console", result.stdout)
        output = self.root / "help.json"
        result = self.run_cli(model, "--output", output, "-h")
        self.assertIn("usage:", result.stdout)
        self.assertFalse(output.exists())

    def test_model_metadata_writes_still_target_safetensors(self):
        model = self.model(metadata={"title": "before"})
        original = model.read_bytes()
        output = self.root / "updated.safetensors"
        self.run_cli(model, "--read", "--set-meta", "title=after", "--output", output)
        with safe_open(str(output), framework="numpy") as saved:
            self.assertEqual(saved.metadata(), {"title": "after"})
            np.testing.assert_array_equal(saved.get_tensor("weights"), [1.5, 2.5])
        self.assertEqual(model.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
