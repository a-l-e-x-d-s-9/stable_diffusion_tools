"""Run: venv/bin/python -m unittest discover -s tests -p test_safe_image_open.py -v.

The Qt desktop opener is mocked: these tests never launch external applications.
Only the handlers are extracted from the two legacy PyQt5 applications, so their
path handling can also be exercised in the project's PyQt6 environment.
"""

import ast
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from PyQt6.QtCore import QUrl
from PyQt6.QtGui import QDesktopServices


ROOT = Path(__file__).resolve().parents[1]
MODULES = ("visual_sticker.py", "captions_helper.py", "visual_multi_crop.py")


def load_handler(filename):
    tree = ast.parse((ROOT / filename).read_text())
    label = next(node for node in tree.body
                 if isinstance(node, ast.ClassDef) and node.name == "ImageLabel")
    handler = next(node for node in label.body
                   if isinstance(node, ast.FunctionDef) and node.name == "mouseDoubleClickEvent")
    namespace = {"os": os, "sys": sys, "QUrl": QUrl, "QDesktopServices": QDesktopServices}
    exec(compile(ast.Module(body=[handler], type_ignores=[]), filename, "exec"), namespace)
    return namespace["mouseDoubleClickEvent"]


class SafeImageOpenTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.handlers = {filename: load_handler(filename) for filename in MODULES}

    def assert_local_open(self, handler, path, expected):
        with mock.patch.object(QDesktopServices, "openUrl", return_value=True) as opener, \
                mock.patch.object(os, "system", side_effect=AssertionError("Shell execution is unsafe")):
            handler(SimpleNamespace(path=str(path)), None)
        opener.assert_called_once()
        url = opener.call_args.args[0]
        self.assertTrue(url.isLocalFile())
        self.assertEqual(url.toLocalFile(), str(expected))

    def test_special_filenames_are_passed_literally(self):
        # The injection filename is a valid PNG filename on Linux and macOS.
        names = (
            "ordinary.png",
            "image with spaces.png",
            "artist's image.png",
            'image "quoted".png',
            "image'; printf injected > command-injection-proof; #.png",
            "image$(echo injected)`echo injected`&.png",
            "image%20name#fragment?.png",
            "תמונה café 🖼.png",
        )
        for name in names:
            path = self.directory / name
            path.write_bytes(b"fixture")
            for filename, handler in self.handlers.items():
                with self.subTest(module=filename, filename=name):
                    self.assert_local_open(handler, path, path)
        self.assertFalse((self.directory / "command-injection-proof").exists())

    def test_relative_paths_are_absolute_local_urls(self):
        path = self.directory / "artist's image.png"
        path.write_bytes(b"fixture")
        relative = os.path.relpath(path)
        for filename, handler in self.handlers.items():
            with self.subTest(module=filename):
                self.assert_local_open(handler, relative, path)

    def test_symlink_name_is_preserved(self):
        target = self.directory / "target.png"
        target.write_bytes(b"fixture")
        link = self.directory / "preferred image name.png"
        link.symlink_to(target)
        for filename, handler in self.handlers.items():
            with self.subTest(module=filename):
                self.assert_local_open(handler, link, link)

    def test_empty_missing_and_directory_paths_are_ignored(self):
        for path in (None, "", str(self.directory / "missing.png"), str(self.directory), "https://example.com/image.png"):
            for filename, handler in self.handlers.items():
                with self.subTest(module=filename, path=path), \
                        mock.patch.object(QDesktopServices, "openUrl") as opener, \
                        mock.patch.object(os, "system", side_effect=AssertionError("Shell execution is unsafe")):
                    handler(SimpleNamespace(path=path), None)
                    opener.assert_not_called()

    def test_caption_widget_double_click(self):
        # Exercise the complete import and real QLabel, not just its extracted
        # handler, with the binding available in this environment.
        os.environ["QT_QPA_PLATFORM"] = "offscreen"
        sys.path.insert(0, str(ROOT))
        self.addCleanup(sys.path.remove, str(ROOT))
        import captions_helper

        app = captions_helper.QApplication.instance() or captions_helper.QApplication([])
        label = captions_helper.ImageLabel()
        path = self.directory / "artist's image.png"
        path.write_bytes(b"fixture")
        label.path = str(path)
        with mock.patch.object(captions_helper.QDesktopServices, "openUrl", return_value=True) as opener:
            label.mouseDoubleClickEvent(None)
        self.assertEqual(opener.call_args.args[0].toLocalFile(), str(path))
        label.deleteLater()
        app.processEvents()


if __name__ == "__main__":
    unittest.main()
