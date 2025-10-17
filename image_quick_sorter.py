#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os, sys, json, shutil
from typing import List, Dict, Optional, Tuple

from PyQt6.QtCore import (
    Qt, QRectF, QSize, QTimer, QRunnable, QThreadPool, pyqtSignal, QObject, QMimeData, QUrl
)
from PyQt6.QtGui import (
    QPixmap, QAction, QKeySequence, QPainter, QImage, QDrag
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
from PyQt6.QtCore import QPoint, QRect
from PyQt6.QtGui import QCursor
from PyQt6.QtWidgets import QRubberBand
from PIL import PngImagePlugin
from pathlib import Path  # NEW
try:
    from send2trash import send2trash  # NEW: OS trash
except Exception:
    send2trash = None

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
    requestOpenPath = pyqtSignal(str)
    cropSelected = pyqtSignal(QRectF)
    selectionChanged = pyqtSignal(bool)

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self._drag_out_start = None  # NEW: start point for Shift+drag (external DnD)
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

        self._rubber: Optional[QRubberBand] = None
        self._crop_origin: Optional[QPoint] = None
        self._cropping: bool = False
        self._orig_size_cache: Optional[Tuple[int,int]] = None  # oriented original (w,h)
        self._pending_sel_scene: Optional[QRectF] = None
        self._drag_mode: Optional[str] = None  # 'move','n','s','e','w','ne','nw','se','sw','new'
        self._last_scene_pt = None  # last mouse pos in scene
        self.set_crop_mode(True)  # selection enabled by default

    def has_visible_selection(self) -> bool:
        """Selection exists and rubber band is currently visible."""
        return self._pending_sel_scene is not None and self._rubber is not None and self._rubber.isVisible()

    def _cursor_for_mode(self, mode: str) -> Qt.CursorShape:
        return {
            "n": Qt.CursorShape.SizeVerCursor,
            "s": Qt.CursorShape.SizeVerCursor,
            "e": Qt.CursorShape.SizeHorCursor,
            "w": Qt.CursorShape.SizeHorCursor,
            "ne": Qt.CursorShape.SizeBDiagCursor,  # ↗↙
            "sw": Qt.CursorShape.SizeBDiagCursor,
            "nw": Qt.CursorShape.SizeFDiagCursor,  # ↖↘
            "se": Qt.CursorShape.SizeFDiagCursor,
            "move": Qt.CursorShape.SizeAllCursor,
            "new": Qt.CursorShape.CrossCursor,
            "none": Qt.CursorShape.CrossCursor,
        }.get(mode, Qt.CursorShape.ArrowCursor)

    def pending_selection(self) -> Optional[QRectF]:
        return self._pending_sel_scene

    def clear_selection(self):
        self._pending_sel_scene = None
        self._drag_mode = None
        self._last_scene_pt = None
        if self._rubber:
            self._rubber.hide()
        self.selectionChanged.emit(False)

    def _update_rubber_from_selection(self):
        """Mirror _pending_sel_scene onto the rubber band."""
        if not self._rubber:
            self._rubber = QRubberBand(QRubberBand.Shape.Rectangle, self.viewport())
        if self._pending_sel_scene is None or self.pix_item is None:
            self._rubber.hide()
            return
        # Map the scene rect to viewport coords
        tl = self.mapFromScene(self._pending_sel_scene.topLeft())
        br = self.mapFromScene(self._pending_sel_scene.bottomRight())
        r = QRect(tl, br).normalized()
        # Keep a minimum 1×1 box
        if r.width() < 1: r.setWidth(1)
        if r.height() < 1: r.setHeight(1)
        self._rubber.setGeometry(r)
        self._rubber.show()
        self.selectionChanged.emit(self.has_visible_selection())

    def _clamp_rect_to_image(self, r: QRectF) -> QRectF:
        if not self.pix_item:
            return r
        return r.intersected(self.pix_item.boundingRect())

    def _hit_test_selection(self, pos_view) -> str:
        """
        Return which part of the selection is grabbed:
        'ne','nw','se','sw','n','s','e','w','move','none'
        Hit-test is done in VIEW coordinates with ~6 px tolerance.
        """
        if self._pending_sel_scene is None:
            return "none"
        # selection in view coords
        rect_view = QRect(self.mapFromScene(self._pending_sel_scene.topLeft()),
                          self.mapFromScene(self._pending_sel_scene.bottomRight())).normalized()
        if rect_view.isEmpty():
            return "none"
        m = 6  # px tolerance
        x, y = pos_view.x(), pos_view.y()
        L, T, R, B = rect_view.left(), rect_view.top(), rect_view.right(), rect_view.bottom()
        nearL, nearR = abs(x - L) <= m, abs(x - R) <= m
        nearT, nearB = abs(y - T) <= m, abs(y - B) <= m
        inside = rect_view.adjusted(m, m, -m, -m).contains(pos_view)

        # corners first
        if nearL and nearT: return "nw"
        if nearR and nearT: return "ne"
        if nearL and nearB: return "sw"
        if nearR and nearB: return "se"
        # edges
        if nearT: return "n"
        if nearB: return "s"
        if nearL: return "w"
        if nearR: return "e"
        # move
        if inside: return "move"
        return "none"

    def set_crop_mode(self, on: bool):
        self._cropping = bool(on)
        if not on and self._rubber:
            self._rubber.hide()
        self.setCursor(QCursor(Qt.CursorShape.CrossCursor) if on else QCursor(Qt.CursorShape.ArrowCursor))

    def _get_oriented_size(self) -> Tuple[Optional[int], Optional[int]]:
        if self._orig_size_cache and self._path:
            return self._orig_size_cache
        if not self._path:
            return (None, None)
        try:
            im = Image.open(self._path)
            im = ImageOps.exif_transpose(im)
            self._orig_size_cache = (im.width, im.height)
            return self._orig_size_cache
        except Exception:
            return (None, None)

    def mousePressEvent(self, ev):
        # Shift + Left = begin external drag (file reference)
        if (ev.button() == Qt.MouseButton.LeftButton
                and (ev.modifiers() & Qt.KeyboardModifier.ShiftModifier)
                and self._path):
            self._drag_out_start = ev.position().toPoint()
            ev.accept()
            return

        if self._cropping and ev.button() == Qt.MouseButton.LeftButton and self.pix_item:
            pos_view = ev.position().toPoint()

            # If a selection exists and the click is outside it → cancel selection
            if self._pending_sel_scene is not None:
                mode = self._hit_test_selection(pos_view)
                if mode == "none":
                    self.clear_selection()
                    self.setCursor(self._cursor_for_mode("new"))
                    ev.accept()
                    return

            # If we have a selection, check if user wants to move/resize it
            mode = self._hit_test_selection(pos_view) if self._pending_sel_scene else "none"
            if mode != "none":
                self._drag_mode = mode
                self._last_scene_pt = self.mapToScene(pos_view)
                ev.accept()
                return
            # Start a new selection anywhere; the rect will be clamped to image on move
            if not self._rubber:
                self._rubber = QRubberBand(QRubberBand.Shape.Rectangle, self.viewport())
            self._drag_mode = "new"
            self._crop_origin = pos_view
            self._rubber.setGeometry(QRect(self._crop_origin, QSize(1, 1)))
            self._rubber.show()
            self._last_scene_pt = self.mapToScene(pos_view)
            self.setCursor(self._cursor_for_mode("new"))
            ev.accept()
            return
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev):
        # External drag if Shift is held and we primed it
        if (self._drag_out_start is not None
                and (ev.buttons() & Qt.MouseButton.LeftButton)
                and (ev.modifiers() & Qt.KeyboardModifier.ShiftModifier)
                and self._path):
            if (ev.position().toPoint() - self._drag_out_start).manhattanLength() >= QApplication.startDragDistance():
                mime = QMimeData()
                # browsers expect text/uri-list
                mime.setUrls([QUrl.fromLocalFile(self._path)])
                # optional: also set text
                mime.setText(self._path)

                drag = QDrag(self)
                drag.setMimeData(mime)
                # pretty drag pixmap if we have one
                if self.pix_item:
                    pm = self.pix_item.pixmap()
                    if not pm.isNull():
                        drag.setPixmap(pm.scaled(96, 96, Qt.AspectRatioMode.KeepAspectRatio,
                                                 Qt.TransformationMode.SmoothTransformation))
                drag.exec(Qt.DropAction.CopyAction)
                self._drag_out_start = None
                ev.accept()
                return
            # don’t fall through into crop logic while Shift is held
            ev.accept()
            return

        if self._cropping and self.pix_item:
            pos_view = ev.position().toPoint()

            # When NOT dragging, just update cursor based on hit test
            if not self._drag_mode:
                mode = self._hit_test_selection(pos_view) if self._pending_sel_scene else "new"
                self.setCursor(self._cursor_for_mode(mode))
                # still allow default behavior to handle panning etc. when not cropping a selection
                super().mouseMoveEvent(ev)
                return

            # DRAGGING branch
            cur_scene = self.mapToScene(pos_view)

            if self._drag_mode == "new" and self._crop_origin:
                rect = QRect(self._crop_origin, pos_view).normalized()
                tl = self.mapToScene(rect.topLeft())
                br = self.mapToScene(rect.bottomRight())
                sel = QRectF(tl, br).normalized()
                sel = self._clamp_rect_to_image(sel)
                self._pending_sel_scene = sel
                self._update_rubber_from_selection()
                self.setCursor(self._cursor_for_mode("new"))

            elif self._pending_sel_scene is not None and self._last_scene_pt is not None:
                dx = cur_scene.x() - self._last_scene_pt.x()
                dy = cur_scene.y() - self._last_scene_pt.y()
                r = QRectF(self._pending_sel_scene)

                if self._drag_mode == "move":
                    r.translate(dx, dy)
                    img = self.pix_item.boundingRect()
                    if r.left() < img.left():   r.moveLeft(img.left())
                    if r.top() < img.top():     r.moveTop(img.top())
                    if r.right() > img.right(): r.moveRight(img.right())
                    if r.bottom() > img.bottom(): r.moveBottom(img.bottom())
                else:
                    if "w" in self._drag_mode: r.setLeft(r.left() + dx)
                    if "e" in self._drag_mode: r.setRight(r.right() + dx)
                    if "n" in self._drag_mode: r.setTop(r.top() + dy)
                    if "s" in self._drag_mode: r.setBottom(r.bottom() + dy)
                    r = r.normalized()
                    r = self._clamp_rect_to_image(r)
                    if r.width() < 2 or r.height() < 2:
                        r = self._pending_sel_scene

                self._pending_sel_scene = r
                self._update_rubber_from_selection()
                self._last_scene_pt = cur_scene
                self.setCursor(self._cursor_for_mode(self._drag_mode))

            # live size feedback
            if self._pending_sel_scene is not None:
                sel = self._pending_sel_scene
                dw = self.pix_item.pixmap().width()
                dh = self.pix_item.pixmap().height()
                ow, oh = self._get_oriented_size()
                if dw > 0 and dh > 0 and ow and oh:
                    sx = ow / dw;
                    sy = oh / dh
                    w = int(round(sel.width() * sx));
                    h = int(round(sel.height() * sy))
                    if self.window():
                        self.window().status.showMessage(f"Crop: {w}×{h}px", 0)

            ev.accept()
            return

        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev):
        if (self._drag_out_start is not None
                and ev.button() == Qt.MouseButton.LeftButton):
            self._drag_out_start = None
            ev.accept()
            return

        if self._cropping and ev.button() == Qt.MouseButton.LeftButton and self.pix_item:
            # at the end of your custom branch, before return:
            self._drag_mode = None
            self._last_scene_pt = None
            if self._pending_sel_scene is not None:
                self._pending_sel_scene = self._clamp_rect_to_image(self._pending_sel_scene.normalized())
                self._update_rubber_from_selection()
                self.selectionChanged.emit(self.has_visible_selection())
            # set hover cursor after release
            mode = self._hit_test_selection(ev.position().toPoint()) if self._pending_sel_scene else "new"
            self.setCursor(self._cursor_for_mode(mode))
            ev.accept()
            return

        super().mouseReleaseEvent(ev)

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
        self._orig_size_cache = None
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
        self._pending_sel_scene = None
        if self._rubber: self._rubber.hide()
        self.scene.clear()
        pm = QPixmap.fromImage(img)
        self.pix_item = self.scene.addPixmap(pm)
        self._update_rubber_from_selection()
        self.scene.setSceneRect(QRectF(pm.rect()))
        if self.fit_mode:
            self.resetTransform()
            self.fit_in_view()

        # after fit_in_view / scene setup
        self._update_rubber_from_selection()
        self.setCursor(self._cursor_for_mode("new"))

    def clear_image(self):
        self._path = None
        self._pending_sel_scene = None  # NEW
        if self._rubber: self._rubber.hide()  # NEW
        self.scene.clear()
        self.pix_item = None

        self.setCursor(Qt.CursorShape.ArrowCursor)

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

        tb = QToolBar("Main", self)
        self.addToolBar(tb)
        tb.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextUnderIcon)

        # Pretty style
        tb.setStyleSheet("""
        QToolBar { spacing: 6px; }
        QToolButton {
          padding: 6px 10px;
          border-radius: 8px;
          border: 1px solid #d0d0d0;
          background: qlineargradient(x1:0,y1:0, x2:0,y2:1,
                                      stop:0 #0a0a0a, stop:1 #000000);
        }
        QToolButton:hover { background: #0e060f; }
        QToolButton[group="nav"]   { background: #0a040f; }
        QToolButton[group="edit"]  { background: #0f040b; }
        QToolButton[group="danger"]{ background: #0f0909; }
        """)

        # Actions (emoji + clearer titles)
        self.act_open_any = QAction("📂 Open…", self)  # merged open
        self.act_prev = QAction("⬅️ Prev", self)
        self.act_next = QAction("➡️ Next", self)
        self.act_fit = QAction("🔍 Fit", self)

        self.act_undo = QAction("↩️ Undo", self)
        try:
            self.act_undo.setShortcut(QKeySequence.StandardKey.Undo)
        except Exception:
            pass
        self.act_crop = QAction("✂️ Crop", self)
        self.act_crop_copy = QAction("🧩 Crop As Copy", self)

        self.act_settings = QAction("⚙️ Settings…", self)

        # Shortcuts
        self.act_prev.setShortcut(QKeySequence(Qt.Key.Key_Left))
        self.act_next.setShortcut(QKeySequence(Qt.Key.Key_Right))
        self.act_fit.setShortcut(QKeySequence("/"))
        self.act_crop_copy.setShortcut(QKeySequence("Shift+C"))

        # Wire up
        self.act_open_any.triggered.connect(self.open_any)
        self.act_prev.triggered.connect(lambda: self.goto_rel(-1))
        self.act_next.triggered.connect(lambda: self.goto_rel(+1))
        self.act_fit.triggered.connect(self.view.key_reset_zoom)
        self.act_undo.triggered.connect(self.undo_last_move)
        self.act_crop.triggered.connect(self.apply_crop_now)
        self.act_crop_copy.triggered.connect(self.apply_crop_copy_now)
        self.act_settings.triggered.connect(self.edit_settings)

        # Add to toolbar with groups + separators
        for a in (self.act_open_any, self.act_prev, self.act_next, self.act_fit):
            tb.addAction(a)
        tb.addSeparator()
        for a in (self.act_crop, self.act_crop_copy, self.act_undo):
            tb.addAction(a)
        tb.addSeparator()
        tb.addAction(self.act_settings)

        # Tag buttons with a "group" property for CSS tinting
        def _tag(tb, act, grp):
            btn = tb.widgetForAction(act)
            if btn:
                btn.setProperty("group", grp)
                btn.style().unpolish(btn)
                btn.style().polish(btn)

        for a in (self.act_open_any, self.act_prev, self.act_next, self.act_fit):
            _tag(tb, a, "nav")
        for a in (self.act_crop, self.act_crop_copy, self.act_undo):
            _tag(tb, a, "edit")
        _tag(tb, self.act_settings, "danger")  # or just leave ungrouped

        # Initially disable crop actions until there is a selection
        self.act_crop.setEnabled(False)
        self.act_crop_copy.setEnabled(False)

        self.folder: Optional[str] = None
        self.files: List[str] = []
        self.index: int = -1

        self._undo_stack: List[dict] = []
        self._sel_last_rect = None  # type: Optional[tuple[int,int,int,int]]
        self._sel_used_for_copy = False  # selection has been used for Crop As Copy since last change
        self.view.selectionChanged.connect(self._on_sel_state)

        # Thread pool + wiring
        self.pool = QThreadPool.globalInstance()
        self.view.requestLoad.connect(self._enqueue_load)

        self.setAcceptDrops(True)

        self.config = load_config()
        # mapping = only digit keys 1..9 from config
        self.mapping = {k: v for k, v in self.config.items() if k.isdigit() and 1 <= int(k) <= 9}

    def _to_jpeg_compatible(self, im: Image.Image, bg=(255, 255, 255)) -> Image.Image:
        """
        Ensure a PIL image can be saved as JPEG:
        - If it has alpha (RGBA/LA or P with transparency), flatten onto a solid background.
        - Convert unusual modes (CMYK, etc.) to RGB.
        """
        if im.mode in ("RGB", "L"):  # JPEG accepts RGB or L (grayscale)
            return im

        # Paletted with transparency
        if im.mode == "P":
            if "transparency" in im.info:
                im = im.convert("RGBA")
            else:
                return im.convert("RGB")

        # Has alpha (RGBA/LA) → flatten onto bg
        if im.mode in ("RGBA", "LA"):
            rgba = im.convert("RGBA")
            bg_im = Image.new("RGB", rgba.size, bg)
            bg_im.paste(rgba, mask=rgba.split()[-1])  # alpha mask
            return bg_im

        # Other modes (CMYK, YCbCr, I;16, etc.)
        return im.convert("RGB")

    def _legacy_trash_dir_for(self, path: str) -> str:
        """Old behavior: <working-folder>/.trash (unique per working folder)."""
        base = self.folder if self.folder else os.path.dirname(path)
        d = os.path.join(base, ".trash")
        os.makedirs(d, exist_ok=True)
        return d

    def _move_to_legacy_trash(self, path: str) -> str:
        """Move to local .trash with a collision-safe name. Return final dest path."""
        trash_dir = self._legacy_trash_dir_for(path)
        base = os.path.basename(path)
        dest = os.path.join(trash_dir, base)
        if os.path.exists(dest):
            stem, ext = os.path.splitext(base)
            k = 1
            while True:
                cand = os.path.join(trash_dir, f"{stem}_del_{k}{ext}")
                if not os.path.exists(cand):
                    dest = cand
                    break
                k += 1
        shutil.move(path, dest)
        return dest

    def _trash_with_fallback(self, path: str) -> tuple[str, str | None]:
        """
        Try OS trash first; on failure, fall back to legacy .trash move.
        Returns (method, legacy_dest):
          method ∈ {"os", "legacy", "none", "fail"}
          legacy_dest is the destination path if method == "legacy", else None.
        """
        if not os.path.exists(path):
            return ("none", None)

        if send2trash:
            try:
                send2trash(path)
                return ("os", None)
            except Exception as err:
                # Surface why OS trash failed (e.g., permission, mount without trash support, etc.)
                self.status.showMessage(f"OS trash failed, using .trash: {err}", 6000)

        # Legacy fallback
        try:
            dest = self._move_to_legacy_trash(path)
            return ("legacy", dest)
        except Exception as e:
            QMessageBox.warning(self, "Trash failed", f"Couldn't move to trash:\n{e}")
            return ("fail", None)

    def _app_cache_dir(self) -> str:
        """Cross-platform writable cache dir."""
        if sys.platform.startswith("win"):
            base = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
            return os.path.join(base, "image_quick_sorter")
        elif sys.platform == "darwin":
            return os.path.join(os.path.expanduser("~/Library/Caches"), "image_quick_sorter")
        else:
            return os.path.join(os.path.expanduser("~/.cache"), "image_quick_sorter")

    def _stash_dir(self) -> str:
        d = os.path.join(self._app_cache_dir(), "undo_stash")
        os.makedirs(d, exist_ok=True)
        return d


    def delete_current(self):
        """Move current image to OS trash (or legacy .trash on fallback) and record undo via a cache-stashed copy."""
        if not self._ensure_no_pending_crop():
            return
        if not (0 <= self.index < len(self.files)):
            return

        src = self.files[self.index]
        base = os.path.basename(src)

        # Make a stash copy for Undo (session-lifetime only)
        stash_dir = self._stash_dir()
        stash = os.path.join(stash_dir, base)
        if os.path.exists(stash):
            stem, ext = os.path.splitext(base)
            k = 1
            while True:
                cand = os.path.join(stash_dir, f"{stem}_stash_{k}{ext}")
                if not os.path.exists(cand):
                    stash = cand
                    break
                k += 1
        try:
            shutil.copy2(src, stash)
        except Exception as e:
            QMessageBox.warning(self, "Delete failed", f"Couldn't create undo copy:\n{e}")
            return

        method, legacy_path = self._trash_with_fallback(src)
        if method == "fail":
            # Keep stash so user can manually restore; do not mutate list/index
            self.status.showMessage("Trash failed; kept a safety copy in cache (no changes applied).", 5000)
            return

        # Record undo (we always undo from stash, never from OS/.trash)
        self._undo_stack.append({"op": "delete", "src": src, "stash": stash, "src_index": self.index})
        self.act_undo.setEnabled(True)

        # Update list & show next/prev
        del self.files[self.index]
        if not self.files:
            self.index = -1
        else:
            self.index = self.index % len(self.files)
        self._show_current()

        if method == "os":
            self.status.showMessage(f"Moved to OS trash: {base}", 3000)
        elif method == "legacy":
            self.status.showMessage(f"Moved to .trash: {os.path.basename(legacy_path)}", 3000)
        else:
            self.status.showMessage("Nothing to delete", 2000)

    def _on_sel_state(self, has: bool):
        # button enable/disable as before
        self.act_crop.setEnabled(has)
        self.act_crop_copy.setEnabled(has)

        # Track selection geometry; if it changed, clear the "already used" flag
        cur = self.view.pending_selection()
        if cur is None:
            self._sel_last_rect = None
            self._sel_used_for_copy = False
        else:
            r = (int(cur.x()), int(cur.y()), int(cur.width()), int(cur.height()))
            if self._sel_last_rect != r:
                self._sel_last_rect = r
                self._sel_used_for_copy = False

    def apply_crop_copy_now(self) -> bool:
        """Save the crop as a new file '<name>_cropped.ext' (preserves EXIF/ICC/text)."""
        if not (0 <= self.index < len(self.files)) or not self.view.pix_item:
            return False
        sel_scene = self.view.pending_selection()
        if not sel_scene:
            self.status.showMessage("No selection to crop", 2500)
            return False

        path = self.files[self.index]
        dw = self.view.pix_item.pixmap().width()
        dh = self.view.pix_item.pixmap().height()
        if dw <= 0 or dh <= 0:
            return False

        try:
            im = Image.open(path)
            im = ImageOps.exif_transpose(im)
        except Exception as e:
            QMessageBox.warning(self, "Crop failed", f"Open error: {e}")
            return False

        ow, oh = im.width, im.height
        sx = ow / dw;
        sy = oh / dh

        left = max(0, min(ow, int(round(sel_scene.left() * sx))))
        top = max(0, min(oh, int(round(sel_scene.top() * sy))))
        right = max(0, min(ow, int(round(sel_scene.right() * sx))))
        bottom = max(0, min(oh, int(round(sel_scene.bottom() * sy))))
        if right - left < 2 or bottom - top < 2:
            self.status.showMessage("Crop too small", 3000)
            return False

        w = right - left;
        h = bottom - top

        try:
            fmt = (im.format or os.path.splitext(path)[1].lstrip(".")).upper()
            exif_bytes = im.info.get("exif", None)
            icc = im.info.get("icc_profile", None)
            cropped = im.crop((left, top, right, bottom))

            folder = os.path.dirname(path)
            stem, ext = os.path.splitext(os.path.basename(path))
            out = os.path.join(folder, f"{stem}_cropped{ext}")
            if os.path.exists(out):
                k = 1
                while True:
                    cand = os.path.join(folder, f"{stem}_cropped_{k}{ext}")
                    if not os.path.exists(cand):
                        out = cand
                        break
                    k += 1

            if fmt in ("JPG", "JPEG"):
                cropped = self._to_jpeg_compatible(cropped)  # <<< add this line
                kw = {"quality": 95}
                if exif_bytes: kw["exif"] = exif_bytes
                if icc: kw["icc_profile"] = icc
                cropped.save(out, format="JPEG", **kw)
            elif fmt == "PNG":
                pnginfo = PngImagePlugin.PngInfo()
                for k, v in im.info.items():
                    if k in ("exif", "icc_profile"): continue
                    if isinstance(v, str):
                        try:
                            pnginfo.add_text(k, v)
                        except:
                            pass
                kw = {"pnginfo": pnginfo}
                if icc: kw["icc_profile"] = icc
                cropped.save(out, format="PNG", **kw)
            elif fmt == "WEBP":
                kw = {}
                if exif_bytes: kw["exif"] = exif_bytes
                if icc: kw["icc_profile"] = icc
                cropped.save(out, format="WEBP", **kw)
            else:
                cropped.save(out)

            # Add the new file into the browsing list (next to current)
            if self.folder and os.path.dirname(out) == self.folder:
                if out not in self.files:
                    self.files.insert(min(self.index + 1, len(self.files)), out)

            self.status.showMessage(f"Saved copy: {os.path.basename(out)} ({w}×{h}px)", 4000)
            self._sel_used_for_copy = True  # allow silent navigation with this crop box
            # keep selection visible for consecutive Crop As Copy actions

            return True
        except Exception as e:
            QMessageBox.warning(self, "Crop failed", str(e))
            return False

    def apply_crop_now(self) -> bool:
        """Apply current selection if any; return True on success, False if canceled/failed/no selection."""
        if not (0 <= self.index < len(self.files)) or not self.view.pix_item:
            return False

        sel_scene = self.view.pending_selection()
        if not sel_scene:
            self.status.showMessage("No selection to crop", 2500)
            return False

        path = self.files[self.index]
        dw = self.view.pix_item.pixmap().width()
        dh = self.view.pix_item.pixmap().height()
        if dw <= 0 or dh <= 0:
            return False

        # open oriented original
        try:
            im = Image.open(path)
            im = ImageOps.exif_transpose(im)
        except Exception as e:
            QMessageBox.warning(self, "Crop failed", f"Open error: {e}")
            return False

        ow, oh = im.width, im.height
        sx = ow / dw
        sy = oh / dh

        left = max(0, min(ow, int(round(sel_scene.left() * sx))))
        top = max(0, min(oh, int(round(sel_scene.top() * sy))))
        right = max(0, min(ow, int(round(sel_scene.right() * sx))))
        bottom = max(0, min(oh, int(round(sel_scene.bottom() * sy))))
        if right - left < 2 or bottom - top < 2:
            self.status.showMessage("Crop too small", 3000)
            return False

        w = right - left
        h = bottom - top

        # prepare save
        fmt = (im.format or os.path.splitext(path)[1].lstrip(".")).upper()
        exif_bytes = self._strip_orientation_exif_bytes(im.info.get("exif", None))
        icc = im.info.get("icc_profile", None)
        cropped = im.crop((left, top, right, bottom))
        tmp_path = path + ".crop_tmp"

        try:
            # write to tmp with metadata preserved
            if fmt in ("JPG", "JPEG"):
                cropped = self._to_jpeg_compatible(cropped)  # <<< add this line
                kw = {"quality": 95}
                if exif_bytes: kw["exif"] = exif_bytes
                if icc: kw["icc_profile"] = icc
                cropped.save(tmp_path, format="JPEG", **kw)
            elif fmt == "PNG":
                pnginfo = PngImagePlugin.PngInfo()
                for k, v in im.info.items():
                    if k in ("exif", "icc_profile"): continue
                    if isinstance(v, str):
                        try:
                            pnginfo.add_text(k, v)
                        except:
                            pass
                kw = {"pnginfo": pnginfo}
                if icc: kw["icc_profile"] = icc
                cropped.save(tmp_path, format="PNG", **kw)
            elif fmt == "WEBP":
                kw = {}
                if exif_bytes: kw["exif"] = exif_bytes
                if icc: kw["icc_profile"] = icc
                cropped.save(tmp_path, format="WEBP", **kw)
            else:
                cropped.save(tmp_path)

            # BACKUP original into cache stash BEFORE replacing (so undo can restore)
            stash_dir = self._stash_dir()
            stem, ext = os.path.splitext(os.path.basename(path))
            backup = os.path.join(stash_dir, f"{stem}_precrop{ext}")
            bk = 1
            while os.path.exists(backup):
                backup = os.path.join(stash_dir, f"{stem}_precrop_{bk}{ext}")
                bk += 1
            shutil.copy2(path, backup)

            # atomically replace
            os.replace(tmp_path, path)

            # record undo
            self._undo_stack.append({"op": "crop", "orig": path, "backup": backup, "index": self.index})
            self.act_undo.setEnabled(True)

            self.status.showMessage(f"Cropped → {w}×{h}px", 4000)
            self.view.clear_selection()  # clear pending selection
            self.view.set_path(path)  # reload current image
            return True

        except Exception as e:
            # best-effort tmp cleanup
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except Exception:
                pass
            QMessageBox.warning(self, "Crop failed", str(e))
            return False

    def _confirm_and_crop(self, sel_scene: QRectF):
        """Confirm and write crop in-place, preserving metadata."""
        if not (0 <= self.index < len(self.files)):
            return
        path = self.files[self.index]
        # displayed pixmap size
        if not self.view.pix_item:
            return
        dw = self.view.pix_item.pixmap().width()
        dh = self.view.pix_item.pixmap().height()
        if dw <= 0 or dh <= 0:
            return

        # oriented original pixels
        try:
            im = Image.open(path)
            im = ImageOps.exif_transpose(im)
        except Exception as e:
            QMessageBox.warning(self, "Crop failed", f"Open error: {e}")
            return

        ow, oh = im.width, im.height
        sx = ow / dw
        sy = oh / dh

        # Map selection to original pixel box
        left = max(0, min(ow, int(round(sel_scene.left() * sx))))
        top = max(0, min(oh, int(round(sel_scene.top() * sy))))
        right = max(0, min(ow, int(round(sel_scene.right() * sx))))
        bottom = max(0, min(oh, int(round(sel_scene.bottom() * sy))))

        if right - left < 2 or bottom - top < 2:
            self.status.showMessage("Crop too small", 3000)
            return

        w = right - left
        h = bottom - top
        if QMessageBox.question(
                self, "Confirm crop",
                f"Crop to {w}×{h}px and overwrite the file?\n(Metadata will be preserved)",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel
        ) != QMessageBox.StandardButton.Yes:
            return

        # Preserve metadata (EXIF/ICC/text where applicable)
        try:
            fmt = (im.format or os.path.splitext(path)[1].lstrip(".")).upper()
            exif_bytes = self._strip_orientation_exif_bytes(im.info.get("exif", None))
            icc = im.info.get("icc_profile", None)

            cropped = im.crop((left, top, right, bottom))

            tmp_path = path + ".crop_tmp"

            if fmt in ("JPG", "JPEG"):
                save_kwargs = {"quality": 95}
                if exif_bytes: save_kwargs["exif"] = exif_bytes
                if icc: save_kwargs["icc_profile"] = icc
                cropped.save(tmp_path, format="JPEG", **save_kwargs)
            elif fmt == "PNG":
                pnginfo = PngImagePlugin.PngInfo()
                # copy textual metadata
                for k, v in im.info.items():
                    if k in ("exif", "icc_profile"):
                        continue
                    if isinstance(v, str):
                        try:
                            pnginfo.add_text(k, v)
                        except Exception:
                            pass
                save_kwargs = {"pnginfo": pnginfo}
                if icc: save_kwargs["icc_profile"] = icc
                cropped.save(tmp_path, format="PNG", **save_kwargs)
            elif fmt == "WEBP":
                save_kwargs = {}
                if exif_bytes: save_kwargs["exif"] = exif_bytes
                if icc: save_kwargs["icc_profile"] = icc
                cropped.save(tmp_path, format="WEBP", **save_kwargs)
            else:
                # fallback: keep ext-driven format
                cropped.save(tmp_path)

            os.replace(tmp_path, path)
            self.status.showMessage(f"Cropped → {w}×{h}px", 4000)
            # reload (respect fit/zoom)
            self.view.set_path(path)
            self.act_crop.setChecked(False)  # exit crop mode
        except Exception as e:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except Exception:
                pass
            QMessageBox.warning(self, "Crop failed", str(e))

    def _strip_orientation_exif_bytes(self, exif_bytes: bytes | None) -> bytes | None:
        if not exif_bytes:
            return None
        try:
            import piexif  # optional dependency
            exif_dict = piexif.load(exif_bytes)
            if piexif.ImageIFD.Orientation in exif_dict.get("0th", {}):
                del exif_dict["0th"][piexif.ImageIFD.Orientation]
            return piexif.dump(exif_dict)
        except Exception:
            # If piexif isn't available or parsing fails, keep original EXIF.
            return exif_bytes

    def _ensure_no_pending_crop(self) -> bool:
        """
        If a visible selection is pending, ask what to do:
          - Crop   → apply_crop_now() and proceed on success
          - Ignore → clear selection and proceed
          - Cancel → stop the action
        Returns True if it is safe to proceed.
        """
        if not self.view.has_visible_selection():
            return True
        if self._sel_used_for_copy:
            # Selection was used for 'Crop As Copy' at least once since last edit → no prompt
            return True

        mb = QMessageBox(self)
        mb.setIcon(QMessageBox.Icon.Question)
        mb.setWindowTitle("Pending crop")
        mb.setText("You have a crop selection. What would you like to do?")
        crop_btn = mb.addButton("Crop", QMessageBox.ButtonRole.AcceptRole)
        ignore_btn = mb.addButton("Ignore", QMessageBox.ButtonRole.DestructiveRole)
        cancel_btn = mb.addButton("Cancel", QMessageBox.ButtonRole.RejectRole)
        mb.setDefaultButton(crop_btn)
        mb.exec()

        clicked = mb.clickedButton()
        if clicked is crop_btn:
            return self.apply_crop_now()  # this clears selection on success
        elif clicked is ignore_btn:
            self.view.clear_selection()
            self.status.showMessage("Crop ignored", 2000)
            return True
        else:
            # Cancel
            return False

    def undo_last_move(self):
        """Undo last operation: move, delete, or crop. Safe if files are missing."""
        if not self._undo_stack:
            return

        op = self._undo_stack.pop()
        typ = op.get("op", "move")

        try:
            if typ in ("move", "delete"):
                src_path = op.get("src")
                orig_index = int(op.get("src_index", 0))
                restore_from = op.get("dest") if typ == "move" else op.get("stash")

                if not restore_from or not os.path.exists(restore_from):
                    self.status.showMessage("Undo skipped: file missing at stored location", 4000)
                    return

                src_dir = os.path.dirname(src_path) if src_path else (self.folder or os.path.dirname(restore_from))
                base = os.path.basename(src_path) if src_path else os.path.basename(restore_from)
                restore = os.path.join(src_dir, base)
                if os.path.exists(restore):
                    stem, ext = os.path.splitext(base);
                    k = 1
                    while os.path.exists(os.path.join(src_dir, f"{stem}_restored_{k}{ext}")):
                        k += 1
                    restore = os.path.join(src_dir, f"{stem}_restored_{k}{ext}")

                shutil.move(restore_from, restore)

                if self.folder and os.path.dirname(restore) == self.folder:
                    ins = min(max(0, orig_index), len(self.files))
                    self.files.insert(ins, restore)
                    self.index = ins
                else:
                    self.files.append(restore)
                    self.index = len(self.files) - 1

                self._show_current()
                self.status.showMessage("Undo: restored file", 3000)

            elif typ == "crop":
                orig = op.get("orig")
                backup = op.get("backup")
                idx = int(op.get("index", self.index))
                if not (orig and backup and os.path.exists(backup)):
                    self.status.showMessage("Undo crop skipped: backup missing", 4000)
                    return

                # put backup over the current (cropped) file
                tmp = orig + ".undo_tmp"
                shutil.copy2(backup, tmp)
                os.replace(tmp, orig)

                # show it
                if self.folder and os.path.dirname(orig) == self.folder:
                    # ensure file is listed
                    if orig not in self.files:
                        self.files.insert(min(idx, len(self.files)), orig)
                    self.index = self.files.index(orig)
                else:
                    if orig not in self.files:
                        self.files.append(orig)
                    self.index = self.files.index(orig)

                self._show_current()
                self.status.showMessage("Undo: restored pre-crop image", 3000)

        except Exception as e:
            QMessageBox.warning(self, "Undo failed", str(e))

        finally:
            self.act_undo.setEnabled(bool(self._undo_stack))

    def open_any(self):
        """
        Single dialog that lets you pick either a file or a folder.
        Uses a non-native QFileDialog so selecting a directory works on all platforms.
        """
        dlg = QFileDialog(self, "Open Image or Folder")
        dlg.setOption(QFileDialog.Option.DontUseNativeDialog, True)
        dlg.setFileMode(QFileDialog.FileMode.ExistingFiles)
        # show images by default, but folders remain selectable in the list
        dlg.setNameFilters(
            ["Images (*.jpg *.jpeg *.png *.webp *.bmp *.tif *.tiff *.gif *.heic *.heif)", "All files (*)"])
        if dlg.exec():
            paths = dlg.selectedFiles()
            if not paths:
                return
            # If a single directory was chosen, open it; otherwise treat first as a path
            selected = paths[0]
            if os.path.isdir(selected):
                self.open_path(selected)
            else:
                self.open_path(selected)

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
        if not self._ensure_no_pending_crop():
            return

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

            # Try to read oriented size from the current pixmap (fast)
            res = "?"
            pi = getattr(self.view, "pix_item", None)
            if pi is not None:
                pm = pi.pixmap()
                if not pm.isNull():
                    res = f"{pm.width()}×{pm.height()}"
            else:
                # Fallback: open once with PIL and honor EXIF orientation
                try:
                    im = Image.open(path)
                    im = ImageOps.exif_transpose(im)
                    res = f"{im.width}×{im.height}"
                except Exception:
                    pass

            self.status.showMessage(f"{res} [{self.index + 1}/{len(self.files)}] {path}")

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
        if not self._ensure_no_pending_crop():
            return

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

        if key in (Qt.Key.Key_C, Qt.Key.Key_Return, Qt.Key.Key_Enter):
            self.apply_crop_now()
            return

        if key in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self.delete_current()
            return

        super().keyPressEvent(ev)

    def move_to_slot(self, digit: str):
        if not self._ensure_no_pending_crop():
            return

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
            # record for undo
            self._undo_stack.append({"op":"move", "src": src, "dest": dest, "src_index": self.index})
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
    def closeEvent(self, ev):
        if self._ensure_no_pending_crop():
            ev.accept()
        else:
            ev.ignore()


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

