#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os, sys, json, shutil
from typing import List, Dict, Optional, Tuple

from PyQt6.QtCore import (
    Qt, QRectF, QSize, QTimer, QRunnable, QThreadPool, pyqtSignal, QObject
)
from PyQt6.QtGui import (
    QPixmap, QAction, QKeySequence, QPainter, QImage
)
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QFileDialog, QGraphicsView, QGraphicsScene,
    QGraphicsPixmapItem, QToolBar, QMessageBox, QStatusBar, QDialog,
    QFormLayout, QLineEdit, QPushButton, QWidget, QHBoxLayout
)

# Robust, tolerant image decode
from PIL import Image, ImageOps, ImageFile, ImageQt
ImageFile.LOAD_TRUNCATED_IMAGES = True
import argparse

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif", ".gif", ".heic", ".heif"}
CONFIG_PATH = os.path.expanduser("~/.config/image_mover_config.json")

def load_config() -> dict:
    data = {}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
            if isinstance(raw, dict):
                data = raw
    except Exception:
        pass
    # ensure digit keys 1..9 exist
    for i in range(1, 10):
        data.setdefault(str(i), "")
    return data

def save_config(cfg: dict) -> None:
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)



# -------------------- Async loader --------------------

class LoadSignals(QObject):
    done = pyqtSignal(str, QImage, object)  # (path, qimage, token)
    fail = pyqtSignal(str, str)             # unchanged


class LoadJob(QRunnable):
    def __init__(self, path: str, target: Optional[Tuple[int, int]], token: object):
        super().__init__()
        self.path = path
        self.target = target
        self.token = token
        self.s = LoadSignals()

    def run(self):
        try:
            im = Image.open(self.path)
            im = ImageOps.exif_transpose(im)
            if self.target is not None:
                tw, th = self.target
                im = ImageOps.contain(im, (max(1, tw), max(1, th)), Image.Resampling.LANCZOS)
            if im.mode != "RGBA":
                im = im.convert("RGBA")
            qimg = ImageQt.ImageQt(im)
            qimg = QImage(qimg).copy()
            self.s.done.emit(self.path, qimg, self.token)   # <- emit token
        except Exception as e:
            self.s.fail.emit(self.path, str(e))


# -------------------- Image view --------------------

class ImageView(QGraphicsView):
    requestLoad = pyqtSignal(str, object)  # (path, target_or_None)
    requestOpenPath = pyqtSignal(str)  # NEW

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)

        self.scene = QGraphicsScene(self)
        self.setScene(self.scene)

        self.setAcceptDrops(True)
        self.viewport().setAcceptDrops(True)

        self.pix_item: Optional[QGraphicsPixmapItem] = None
        self._path: Optional[str] = None
        self.fit_mode = True
        self._resize_timer = QTimer(self)
        self._resize_timer.setSingleShot(True)
        self._resize_timer.setInterval(120)
        self._resize_timer.timeout.connect(self._refit_after_resize)

    # --- DnD helpers ---
    def _first_image_path(self, mime) -> str | None:
        if not mime.hasUrls():
            return None
        for u in mime.urls():
            if u.isLocalFile():
                p = u.toLocalFile()
                if os.path.splitext(p)[1].lower() in SUPPORTED_EXTS:
                    return p
        return None

    def dragEnterEvent(self, ev):
        if self._first_image_path(ev.mimeData()):
            ev.acceptProposedAction()
        else:
            ev.ignore()

    def dragMoveEvent(self, ev):
        # many WMs require accepting *move* continuously
        if self._first_image_path(ev.mimeData()):
            ev.acceptProposedAction()
        else:
            ev.ignore()

    def dropEvent(self, ev):
        p = self._first_image_path(ev.mimeData())
        if p:
            self.requestOpenPath.emit(p)  # MainWindow.open_path will handle starting from it
            ev.acceptProposedAction()
        else:
            ev.ignore()

    def set_path(self, path: Optional[str]):
        self._path = path
        self._resize_timer.stop()
        self.scene.clear()
        self.pix_item = None
        if not path:
            return
        target = (self.viewport().width(), self.viewport().height()) if self.fit_mode else None
        self.requestLoad.emit(path, target)

    def set_qimage(self, path: str, img: QImage):
        # Ignore stale loads
        if path != self._path:
            return
        self.scene.clear()
        pm = QPixmap.fromImage(img)
        self.pix_item = self.scene.addPixmap(pm)
        self.scene.setSceneRect(QRectF(pm.rect()))
        if self.fit_mode:
            self.resetTransform()
            self.fit_in_view()

    def clear_image(self):
        self._path = None
        self.scene.clear()
        self.pix_item = None

    def fit_in_view(self):
        if not self.pix_item:
            return
        self.fit_mode = True
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        br = self.pix_item.boundingRect()
        if br.width() > 0 and br.height() > 0:
            margin = 2
            self.fitInView(br.adjusted(-margin, -margin, margin, margin),
                           Qt.AspectRatioMode.KeepAspectRatio)

    def resizeEvent(self, ev):
        super().resizeEvent(ev)
        if self.fit_mode and self._path:
            # Throttle re-decode while resizing
            self._resize_timer.start()

    def _refit_after_resize(self):
        if not (self.fit_mode and self._path):
            return
        target = (self.viewport().width(), self.viewport().height())
        self.requestLoad.emit(self._path, target)

    def wheelEvent(self, ev):
        if not self.pix_item:
            return
        # On first wheel, leave fit mode (no re-decode on resize)
        if self.fit_mode:
            self.fit_mode = False
            self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        angle = ev.angleDelta().y()
        factor = 1.0 + (0.0015 * angle)
        if factor < 0.1:
            factor = 0.1
        self.scale(factor, factor)

    def key_reset_zoom(self):
        # Back to Fit: re-decode for viewport size
        self.resetTransform()
        self.fit_mode = True
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        if self._path:
            target = (self.viewport().width(), self.viewport().height())
            self.requestLoad.emit(self._path, target)


# -------------------- Dest dialog --------------------

class DestFoldersDialog(QDialog):
    def __init__(self, mapping: Dict[str, str], parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.setWindowTitle("Destination Folders")
        self.mapping = mapping.copy()
        form = QFormLayout(self)
        self.edits: Dict[str, QLineEdit] = {}
        for key in [str(i) for i in range(1, 10)]:
            row = QWidget(self); h = QHBoxLayout(row); h.setContentsMargins(0, 0, 0, 0)
            edit = QLineEdit(self.mapping.get(key, ""), self)
            btn = QPushButton("Browse…", self)
            btn.clicked.connect(lambda _, k=key, e=edit: self._browse_for(k, e))
            h.addWidget(edit, 1); h.addWidget(btn, 0)
            form.addRow(f"Key {key} →", row)
            self.edits[key] = edit
        btns = QWidget(self); hb = QHBoxLayout(btns); hb.setContentsMargins(0, 0, 0, 0)
        ok = QPushButton("OK", self); cancel = QPushButton("Cancel", self)
        ok.clicked.connect(self.accept); cancel.clicked.connect(self.reject)
        hb.addStretch(1); hb.addWidget(ok); hb.addWidget(cancel); form.addRow(btns)
    def _browse_for(self, key: str, edit: QLineEdit):
        d = QFileDialog.getExistingDirectory(self, f"Choose folder for key {key}")
        if d: edit.setText(d)
    def values(self) -> Dict[str, str]:
        return {k: e.text().strip() for k, e in self.edits.items()}


# -------------------- Main window --------------------

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Image Quick Sorter (Async)")
        self.resize(1100, 800)

        self._load_token = None

        self.view = ImageView(self)
        self.setCentralWidget(self.view)

        self.status = QStatusBar(self); self.setStatusBar(self.status)
        self.view.requestOpenPath.connect(self.open_path)

        tb = QToolBar("Main", self); self.addToolBar(tb)
        self.act_open = QAction("Open Folder", self)
        self.act_prev = QAction("Prev", self)
        self.act_next = QAction("Next", self)
        self.act_fit  = QAction("Fit", self)
        self.act_settings = QAction("Settings…", self)

        self.act_undo = QAction("Undo", self)
        try:
            # Nice-to-have shortcut (Ctrl+Z / Cmd+Z)
            self.act_undo.setShortcut(QKeySequence.StandardKey.Undo)
        except Exception:
            pass
        self.act_undo.setEnabled(False)


        self.act_prev.setShortcut(QKeySequence(Qt.Key.Key_Left))
        self.act_next.setShortcut(QKeySequence(Qt.Key.Key_Right))
        self.act_fit.setShortcut(QKeySequence("/"))  # also '-' handled in keyPressEvent

        for a in (self.act_open, self.act_prev, self.act_next, self.act_fit, self.act_undo, self.act_settings):
            tb.addAction(a)
        self.act_open.triggered.connect(self.open_folder)
        self.act_prev.triggered.connect(lambda: self.goto_rel(-1))
        self.act_next.triggered.connect(lambda: self.goto_rel(+1))
        self.act_fit.triggered.connect(self.view.key_reset_zoom)
        self.act_undo.triggered.connect(self.undo_last_move)
        self.act_settings.triggered.connect(self.edit_settings)

        self.folder: Optional[str] = None
        self.files: List[str] = []
        self.index: int = -1

        self._undo_stack: List[dict] = []

        # Thread pool + wiring
        self.pool = QThreadPool.globalInstance()
        self.view.requestLoad.connect(self._enqueue_load)

        self.setAcceptDrops(True)

        self.act_open_file = QAction("Open Image…", self)
        tb.addAction(self.act_open_file)
        self.act_open_file.triggered.connect(self.open_file)

        self.config = load_config()
        # mapping = only digit keys 1..9 from config
        self.mapping = {k: v for k, v in self.config.items() if k.isdigit() and 1 <= int(k) <= 9}


    def undo_last_move(self):
        """Undo the last successful move_to_slot. Safe if file went missing."""
        if not self._undo_stack:
            return

        op = self._undo_stack.pop()
        src_path = op.get("src")        # original location
        dest_path = op.get("dest")      # where we moved it
        orig_index = int(op.get("src_index", 0))

        # If the moved file is gone (deleted or moved externally), just report & disable if empty.
        if not dest_path or not os.path.exists(dest_path):
            self.status.showMessage("Undo skipped: moved file is missing at destination", 4000)
            if not self._undo_stack:
                self.act_undo.setEnabled(False)
            return

        # Compute a restore path, avoiding collisions in the original folder
        src_dir  = os.path.dirname(src_path) if src_path else self.folder or os.path.dirname(dest_path)
        base     = os.path.basename(src_path) if src_path else os.path.basename(dest_path)
        restore  = os.path.join(src_dir, base)

        if os.path.exists(restore):
            stem, ext = os.path.splitext(base)
            k = 1
            while True:
                alt = os.path.join(src_dir, f"{stem}_restored_{k}{ext}")
                if not os.path.exists(alt):
                    restore = alt
                    break
                k += 1

        try:
            shutil.move(dest_path, restore)
        except Exception as e:
            QMessageBox.warning(self, "Undo failed", str(e))
            if not self._undo_stack:
                self.act_undo.setEnabled(False)
            return

        # If this window is still on the same folder, put the file back into the list
        if self.folder and os.path.dirname(restore) == self.folder:
            # Insert near the original index if possible; clamp to current list size
            ins = min(max(0, orig_index), len(self.files))
            self.files.insert(ins, restore)
            self.index = ins
        else:
            # Fallback: just append and show it
            self.files.append(restore)
            self.index = len(self.files) - 1

        self._show_current()

        if not self._undo_stack:
            self.act_undo.setEnabled(False)


    def open_file(self):
        p, _ = QFileDialog.getOpenFileName(self, "Choose an image")
        if p:
            self.open_path(p)

    def dragEnterEvent(self, ev):
        if ev.mimeData().hasUrls():
            # accept if any local file with an image-like extension
            for u in ev.mimeData().urls():
                if u.isLocalFile():
                    ext = os.path.splitext(u.toLocalFile())[1].lower()
                    if ext in SUPPORTED_EXTS:
                        ev.acceptProposedAction()
                        return
        ev.ignore()

    def dropEvent(self, ev):
        for u in ev.mimeData().urls():
            if u.isLocalFile():
                p = u.toLocalFile()
                ext = os.path.splitext(p)[1].lower()
                if ext in SUPPORTED_EXTS:
                    self.open_path(p)
                    ev.acceptProposedAction()
                    return
        ev.ignore()

    def open_path(self, path: str):
        """Open either a folder or a single image; start from that image."""
        path = os.path.abspath(path)
        if os.path.isdir(path):
            # behave like Open Folder
            self.folder = path
            self.files = self._scan_images(path)
            self.index = 0 if self.files else -1
            self._show_current()
            return

        # it's a file: load its parent folder, start at that file
        if not os.path.isfile(path):
            QMessageBox.warning(self, "Open failed", f"Not a file: {path}")
            return

        folder = os.path.dirname(path)
        self.folder = folder
        self.files = self._scan_images(folder)
        try:
            self.index = self.files.index(path)
        except ValueError:
            # If the file isn’t in top-level (e.g., was symlinked), just append it temporarily
            # but still keep navigation within this folder set.
            self.files.append(path)
            self.index = len(self.files) - 1
        self._show_current()


    # ---------- loading ----------
    def open_folder(self):
        d = QFileDialog.getExistingDirectory(self, "Choose folder with images")
        if not d: return
        self.folder = d
        self.files = self._scan_images(d)
        self.index = 0 if self.files else -1
        self._show_current()

    def _scan_images(self, d: str) -> List[str]:
        out = []
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if not os.path.isfile(p): continue
            if name.startswith("."): continue
            ext = os.path.splitext(name)[1].lower()
            if ext in SUPPORTED_EXTS: out.append(p)
        out.sort()
        self.status.showMessage(f"Loaded {len(out)} images from {d}", 4000)
        return out

    def _show_current(self):
        if 0 <= self.index < len(self.files):
            path = self.files[self.index]
            self.view.set_path(path)
            self.status.showMessage(f"[{self.index + 1}/{len(self.files)}] {path}")
            # persist last image path
            self.config["last_path"] = path
            save_config(self.config)
        else:
            self.view.clear_image()
            self.status.showMessage("No image")

    def _on_load_done(self, path: str, img: QImage, token: object):
        # Accept only the most recent request for the current path & mode
        if token != self._load_token:
            return
        if not (0 <= self.index < len(self.files)) or self.files[self.index] != path:
            return
        self.view.set_qimage(path, img)

    # ---------- async decode ----------
    def _enqueue_load(self, path: str, target: Optional[Tuple[int, int]]):
        # token captures the desired state at enqueue time
        token = (path, self.view.fit_mode, target)
        self._load_token = token

        job = LoadJob(path, target, token)
        job.s.done.connect(self._on_load_done)
        job.s.fail.connect(self._load_failed)
        self.pool.start(job)

    def _load_failed(self, path: str, err: str):
        # Ignore stale failures
        if 0 <= self.index < len(self.files) and self.files[self.index] == path:
            QMessageBox.warning(self, "Open failed", err)
            self.view.clear_image()

    # ---------- navigation ----------
    def goto_rel(self, delta: int):
        if not self.files:
            return
        # wrap around with modulo
        self.index = (self.index + delta) % len(self.files)
        self._show_current()

    # ---------- moving ----------
    def keyPressEvent(self, ev):
        key = ev.key()
        if key in (Qt.Key.Key_Slash, Qt.Key.Key_Minus):
            self.view.key_reset_zoom(); return
        if key == Qt.Key.Key_Left:
            self.goto_rel(-1); return
        if key == Qt.Key.Key_Right:
            self.goto_rel(+1); return
        if Qt.Key.Key_1 <= key <= Qt.Key.Key_9:
            digit = str(key - Qt.Key.Key_0)
            self.move_to_slot(digit); return
        if key == Qt.Key.Key_Home:
            if self.files:
                self.index = 0
                self._show_current()
            return
        if key == Qt.Key.Key_End:
            if self.files:
                self.index = len(self.files) - 1
                self._show_current()
            return

        if key == Qt.Key.Key_Space:
            self.goto_rel(+1);
            return

        if key == Qt.Key.Key_Escape:
            self.view.key_reset_zoom();
            return

        super().keyPressEvent(ev)

    def move_to_slot(self, digit: str):
        if not (0 <= self.index < len(self.files)): return
        dest_root = self.mapping.get(digit, "").strip()
        if not dest_root:
            QMessageBox.information(self, "No folder set",
                                    f"No destination folder for key {digit}. Use Settings…")
            return
        if not os.path.isdir(dest_root):
            try: os.makedirs(dest_root, exist_ok=True)
            except Exception as e:
                QMessageBox.warning(self, "Create folder failed", str(e)); return

        src = self.files[self.index]
        base = os.path.basename(src)
        dest = os.path.join(dest_root, base)
        if os.path.exists(dest):
            stem, ext = os.path.splitext(base); k = 1
            while True:
                alt = os.path.join(dest_root, f"{stem}_{k}{ext}")
                if not os.path.exists(alt): dest = alt; break
                k += 1

        try:
            shutil.move(src, dest)
            # NEW: record for undo
            self._undo_stack.append({"src": src, "dest": dest, "src_index": self.index})
            self.act_undo.setEnabled(True)
            # remove from list and show next
            del self.files[self.index]
            if not self.files:
                self.index = -1
            else:
                self.index = self.index % len(self.files)
            self._show_current()
        except Exception as e:
            QMessageBox.warning(self, "Move failed", str(e)); return


    # ---------- settings ----------
    def edit_settings(self):
        dlg = DestFoldersDialog(self.mapping, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            new_map = dlg.values()
            # update both mapping and config
            self.mapping.update(new_map)
            self.config.update(self.mapping)  # keep non-digit keys (like last_path) intact
            save_config(self.config)
            self.status.showMessage("Saved destination folders", 3000)

def parse_cli():
    """
    Parse optional named args without colliding with Qt's own args.
    --root-folder /path
    --1 /dest/for/key1  ... --9 /dest/for/key9
    --image /path/to/file.jpg  (overrides --root-folder)
    --save-mapping  (persist the mapping overrides to config)
    """
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--root-folder", dest="root_folder", help="Start with this folder.")
    p.add_argument("--image", dest="image", help="Start with this image (overrides --root-folder).")
    for i in range(1, 10):
        p.add_argument(f"--{i}", dest=f"slot{i}", help=f"Destination folder for key {i}.")
    p.add_argument("--save-mapping", action="store_true",
                   help="Persist CLI slot folders into config.")
    args, _ = p.parse_known_args()  # don't consume Qt args
    return args


def main():
    # Parse CLI first (so we can apply mapping/root before showing)
    args = parse_cli()

    app = QApplication(sys.argv)
    win = MainWindow()

    # Apply slot overrides
    updated = False
    for i in range(1, 10):
        val = getattr(args, f"slot{i}", None)
        if val:
            key = str(i)
            win.mapping[key] = val
            win.config[key] = val
            updated = True
    if updated and args.save_mapping:
        save_config(win.config)

    win.show()

    # Startup location precedence:
    # 1) --image  2) --root-folder  3) legacy positional arg  4) last_path
    if args.image and os.path.exists(args.image):
        win.open_path(args.image)
    elif args.root_folder and os.path.isdir(args.root_folder):
        win.open_path(args.root_folder)
    elif len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        win.open_path(sys.argv[1])
    else:
        lp = win.config.get("last_path")
        if lp and os.path.exists(lp):
            win.open_path(lp)

    sys.exit(app.exec())




if __name__ == "__main__":
    main()
