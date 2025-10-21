#!/usr/bin/env python3
# Pattern Replacer (PyQt6) — crash fix + UX updates
# - Fix: Add Pair click no longer passes a bool into setText
# - Layout: Pattern (top), Output (middle), Pairs & Help (collapsible, below Output)
# - Pairs panel slimmer (max height) and collapsed by default
# - Examples mention "Pairs -" and all supported tags
# - Buttons single row, left aligned, rounded
# - Pattern editor wraps long lines
# - Defaults auto-load on start; auto-save on close AND debounced auto-save on edits (survives most crashes)
# - Project save/load; Output save
# - Tags: <loop_N>, <rand_int_min_max>, <rand_float_min_max>, <sum_inc interval=... upper=... lower=... order=...>

from __future__ import annotations
import sys, re, json, random
from pathlib import Path
from decimal import Decimal, getcontext, ROUND_HALF_UP, ROUND_FLOOR

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QAction, QTextOption
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QLineEdit, QPlainTextEdit, QPushButton, QFileDialog,
    QScrollArea, QFrame, QToolButton, QSplitter, QSizePolicy, QSpacerItem
)
import hashlib

# ---------------------------- Processing helpers ----------------------------
getcontext().prec = 50
_attr_re = re.compile(r'(\w+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))')
_slot_pat = re.compile(r'(\b\w+\b)(\s*:\s*)(-?\d+(?:\.\d+)?)')


def _parse_attrs(attrs_s: str) -> dict:
    out = {}
    for k, v1, v2, v3 in _attr_re.findall(attrs_s or ""):
        out[k.lower()] = v1 or v2 or v3
    return out


def _dec_places(s: str) -> int:
    m = re.match(r"^\s*-?\d+(?:\.(\d+))?\s*$", s.strip())
    return len(m.group(1)) if m and m.group(1) else 0


def _quantizer(max_places: int) -> Decimal:
    return Decimal(1).scaleb(-max_places)


def _fmt(d: Decimal, q: Decimal) -> str:
    return str(d.quantize(q, rounding=ROUND_HALF_UP))


def _kmax_up(sum0: Decimal, step: Decimal, nslots: int, upper: Decimal) -> int:
    if nslots == 0:
        return -1
    inc_per_row = step * Decimal(nslots)
    if inc_per_row <= 0:
        return -1
    rem = (upper - sum0) / inc_per_row
    return int(rem.to_integral_value(rounding=ROUND_FLOOR))


def _kmax_down(sum0: Decimal, step: Decimal, nslots: int, lower: Decimal) -> int:
    if nslots == 0:
        return -1
    dec_per_row = step * Decimal(nslots)
    if dec_per_row <= 0:
        return -1
    rem = (sum0 - lower) / dec_per_row
    return int(rem.to_integral_value(rounding=ROUND_FLOOR))


def expand_sum_inc(match: re.Match) -> str:
    attrs = _parse_attrs(match.group(1) or "")
    template = match.group(2)

    interval_s = attrs.get("interval")
    upper_s = attrs.get("upper") or attrs.get("upper_bound") or attrs.get("stop")
    lower_s = attrs.get("lower") or attrs.get("lower_bound") or attrs.get("min")
    order = (attrs.get("order") or "up_first").strip().lower()

    try:
        step_mag = abs(Decimal(interval_s))
    except Exception:
        return "[sum_inc error: bad interval]"
    if step_mag <= 0:
        return "[sum_inc error: interval must be > 0]"

    base_vals = [Decimal(m.group(3)) for m in _slot_pat.finditer(template)]
    nslots = len(base_vals)
    if nslots == 0:
        return "[sum_inc note: no numeric slots name:value found]"

    sum0 = sum(base_vals, Decimal(0))

    upper = None
    lower = None
    if upper_s:
        try:
            upper = Decimal(upper_s)
        except Exception:
            return "[sum_inc error: bad upper]"
    if lower_s:
        try:
            lower = Decimal(lower_s)
        except Exception:
            return "[sum_inc error: bad lower]"
    if upper is None and lower is None:
        return "[sum_inc error: need upper=... or lower=...]"

    places = max(
        max((_dec_places(m.group(3)) for m in _slot_pat.finditer(template)), default=0),
        _dec_places(interval_s or ""),
        _dec_places(upper_s or ""),
        _dec_places(lower_s or "")
    )
    q = _quantizer(places)

    def step_up(base: Decimal, k: int) -> Decimal:
        return base + step_mag * Decimal(k)

    def step_down(base: Decimal, k: int) -> Decimal:
        return base - step_mag * Decimal(k)

    k_up_max = -1
    k_down_max = -1
    if upper is not None:
        k_up_max = _kmax_up(sum0, step_mag, nslots, upper)
        if k_up_max < 0 and sum0 <= upper:
            k_up_max = 0
    if lower is not None:
        k_down_max = _kmax_down(sum0, step_mag, nslots, lower)
        if k_down_max < 0 and sum0 >= lower:
            k_down_max = 0

    if (upper is None or k_up_max < 0) and (lower is None or k_down_max < 0):
        if upper is not None and sum0 > upper:
            return "[sum_inc note: upper is below initial sum]"
        if lower is not None and sum0 < lower:
            return "[sum_inc note: lower is above initial sum]"
        return "[sum_inc note: no rows to emit]"

    ks: list[int] = []
    if upper is not None and lower is not None:
        if order not in ("up_first", "down_first", "center_out"):
            order = "up_first"
        if order == "up_first":
            ks.extend(range(0, k_up_max + 1))
            ks.extend(range(-1, -k_down_max - 1, -1))
        elif order == "down_first":
            ks.extend(range(0, -k_down_max - 1, -1))
            ks.extend(range(1, k_up_max + 1))
        else:  # center_out
            limit = max(k_up_max, k_down_max)
            ks.append(0)
            for i in range(1, limit + 1):
                if i <= k_up_max:
                    ks.append(i)
                if i <= k_down_max:
                    ks.append(-i)
    elif upper is not None:
        ks = list(range(0, k_up_max + 1))
    else:
        ks = list(range(0, -k_down_max - 1, -1))

    def render_with_k(k: int) -> str:
        if k >= 0:
            def _repl(m: re.Match) -> str:
                name, colon, val_s = m.group(1), m.group(2), m.group(3)
                base = Decimal(val_s)
                return f"{name}{colon}{_fmt(step_up(base, k), q)}"
        else:
            kk = -k
            def _repl(m: re.Match) -> str:
                name, colon, val_s = m.group(1), m.group(2), m.group(3)
                base = Decimal(val_s)
                return f"{name}{colon}{_fmt(step_down(base, kk), q)}"
        return _slot_pat.sub(_repl, template).strip()

    lines = [render_with_k(k) for k in ks]
    return "\n".join(lines)


_loop_re = re.compile(r'<loop_(\d+)>(.*?)</loop>', re.DOTALL)
_rand_int_re = re.compile(r'<rand_int_(-?\d+)_(-?\d+)>')
_rand_float_re = re.compile(r'<rand_float_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)>')
_sum_inc_re = re.compile(r'<sum_inc\b([^>]*)>(.*?)</sum_inc>', re.DOTALL)


def _expand_loop(text: str) -> str:
    def repl(m: re.Match) -> str:
        n = int(m.group(1))
        body = m.group(2)
        return (body + "\n") * n
    return _loop_re.sub(repl, text)


def _replace_rand_int(text: str) -> str:
    def repl(m: re.Match) -> str:
        lo = int(m.group(1))
        hi = int(m.group(2))
        if lo > hi:
            lo, hi = hi, lo
        return str(random.randint(lo, hi))
    return _rand_int_re.sub(repl, text)


def _replace_rand_float(text: str) -> str:
    def repl(m: re.Match) -> str:
        lo = float(m.group(1))
        hi = float(m.group(2))
        if lo > hi:
            lo, hi = hi, lo
        return f"{random.uniform(lo, hi):.6f}"
    return _rand_float_re.sub(repl, text)


def process_text(src: str) -> str:
    out = src
    out = _expand_loop(out)
    out = _sum_inc_re.sub(lambda m: expand_sum_inc(m), out)
    out = _replace_rand_int(out)
    out = _replace_rand_float(out)
    return out

# ------------------------------- UI widgets --------------------------------
class Collapsible(QWidget):
    def __init__(self, title: str, parent: QWidget | None = None):
        super().__init__(parent)
        self.toggle = QToolButton(checkable=True, checked=False)
        self.toggle.setText(title)
        self.toggle.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.toggle.setArrowType(Qt.ArrowType.RightArrow)
        self.toggle.toggled.connect(self._on_toggled)

        self.body = QWidget()
        self.body.setVisible(False)
        self.body_layout = QVBoxLayout(self.body)
        self.body_layout.setContentsMargins(8, 4, 8, 8)
        self.body_layout.setSpacing(6)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.toggle)
        lay.addWidget(self.body)

    def _on_toggled(self, checked: bool):
        self.toggle.setArrowType(Qt.ArrowType.DownArrow if checked else Qt.ArrowType.RightArrow)
        self.body.setVisible(checked)

    def setContentLayout(self, layout: QVBoxLayout):
        QWidget().setLayout(self.body_layout)
        self.body_layout = layout
        self.body.setLayout(layout)


class PairRow(QWidget):
    def __init__(self, on_remove, parent=None):
        super().__init__(parent)
        h = QHBoxLayout(self)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(6)
        self.pattern = QLineEdit(placeholderText="pattern")
        self.replacement = QLineEdit(placeholderText="replacement")
        self.remove_btn = QToolButton(text="-")
        self.remove_btn.setToolTip("Remove this pair")
        self.remove_btn.clicked.connect(lambda: on_remove(self))
        h.addWidget(self.pattern)
        h.addWidget(self.replacement)
        h.addWidget(self.remove_btn)

    def value(self) -> tuple[str, str]:
        return self.pattern.text(), self.replacement.text()


# --------------------------------- Window ----------------------------------
class MainWindow(QMainWindow):
    DEFAULTS_PATH = Path.home() / ".pattern_replacer_qt6.json"

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Pattern Replacer - Qt6")
        self.resize(1100, 720)

        # Splitter: Pattern (top) / Output + Pairs (bottom)
        splitter = QSplitter(Qt.Orientation.Vertical)

        # --- Pattern panel (top) ---
        top = QWidget()
        top_lay = QVBoxLayout(top)
        top_lay.setContentsMargins(10, 10, 10, 6)
        top_lay.setSpacing(8)

        top_lay.addWidget(QLabel("Pattern"))
        self.input_edit = QPlainTextEdit()
        self.input_edit.setPlaceholderText("Enter pattern text with tags here...")
        self.input_edit.setLineWrapMode(QPlainTextEdit.LineWrapMode.WidgetWidth)  # wrap long lines
        self.input_edit.setWordWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        self.input_edit.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        top_lay.addWidget(self.input_edit, 1)

        # --- Output + Pairs (bottom) ---
        bottom = QWidget()
        bottom_lay = QVBoxLayout(bottom)
        bottom_lay.setContentsMargins(10, 6, 10, 10)
        bottom_lay.setSpacing(10)

        bottom_lay.addWidget(QLabel("Output"))
        self.output_edit = QPlainTextEdit(readOnly=True)
        self.output_edit.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        bottom_lay.addWidget(self.output_edit, 1)

        # Collapsible Pairs & Help, located below output
        pairs_panel = Collapsible("Pairs & help (applied after tag expansion)")
        pairs_panel.toggle.setChecked(False)  # collapsed by default
        pp_layout = QVBoxLayout()
        pp_layout.setContentsMargins(6, 6, 6, 6)
        pp_layout.setSpacing(6)

        guide = QLabel(
            "Pairs are simple literal string replacements performed AFTER tags.\n"
            "Supported tags: <loop_N>, <rand_int_min_max>, <rand_float_min_max>,\n"
            "<sum_inc interval=... upper=... lower=... order=up_first|down_first|center_out>."
        )
        guide.setWordWrap(True)
        guide.setStyleSheet("QLabel{color:#9aa4b2;font-size:12px}")
        pp_layout.addWidget(guide)

        # Compact, scrollable pairs list
        self.pairs_container = QWidget()
        self.pairs_layout = QVBoxLayout(self.pairs_container)
        self.pairs_layout.setContentsMargins(0, 0, 0, 0)
        self.pairs_layout.setSpacing(4)
        self.pairs_layout.addStretch(1)

        pairs_scroll = QScrollArea()
        pairs_scroll.setWidgetResizable(True)
        pairs_scroll.setFrameShape(QFrame.Shape.NoFrame)
        pairs_scroll.setWidget(self.pairs_container)
        pairs_scroll.setMaximumHeight(160)  # slimmer
        pp_layout.addWidget(pairs_scroll)

        # Add Pair button (fix: avoid passing bool via clicked)
        btn_row_pairs = QHBoxLayout()
        self.add_pair_btn = QPushButton("Add Pair")
        self.add_pair_btn.setToolTip("Add a pattern–replacement row. Use the minus to remove.")
        self.add_pair_btn.clicked.connect(lambda: self.add_pair())
        btn_row_pairs.addWidget(self.add_pair_btn)
        btn_row_pairs.addSpacerItem(QSpacerItem(10, 10, QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Minimum))
        pp_layout.addLayout(btn_row_pairs)

        # Examples text (auto scrollable)
        examples = QPlainTextEdit(readOnly=True)
        examples.setLineWrapMode(QPlainTextEdit.LineWrapMode.WidgetWidth)
        examples.setPlainText(
            "Examples & help (including Pairs):\n\n"
            "  • <loop_3>a</loop> → repeats body 3 times.\n"
            "  • <rand_int_-5_5> → random int in [-5,5].\n"
            "  • <rand_float_0.1_0.9> → random float.\n"
            "  • <sum_inc interval=0.05 upper=1.15> a_:0.5,as,b_:0.35 </sum_inc>\n"
            "  • <sum_inc interval=0.05 lower=0.70> a_:0.50,as,b_:0.35 </sum_inc>\n"
            "  • <sum_inc interval=0.05 upper=1.15 lower=0.70 order=center_out> ... </sum_inc>\n\n"
            "Pairs usage: After expansion, each row 'pattern' → 'replacement'."
        )
        pp_layout.addWidget(examples)
        pairs_panel.setContentLayout(pp_layout)
        bottom_lay.addWidget(pairs_panel, 0)

        splitter.addWidget(top)
        splitter.addWidget(bottom)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)

        # Bottom button bar
        bar = QWidget()
        bar_lay = QHBoxLayout(bar)
        bar_lay.setContentsMargins(10, 0, 10, 10)
        bar_lay.setSpacing(8)
        self.replace_btn = QPushButton("Replace All")
        self.undo_btn = QPushButton("Undo")
        self.save_project_btn = QPushButton("Save Project")
        self.load_project_btn = QPushButton("Load Project")
        # self.save_defaults_btn = QPushButton("Save Defaults")
        # self.load_defaults_btn = QPushButton("Load Defaults")
        self.save_output_btn = QPushButton("Save Output")
        for b in (
            self.replace_btn, self.undo_btn, self.save_project_btn, self.load_project_btn,
            self.save_output_btn
        ):  # self.save_defaults_btn, self.load_defaults_btn,
            bar_lay.addWidget(b)
        bar_lay.addSpacerItem(QSpacerItem(10, 10, QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Minimum))

        # Compose
        central = QWidget()
        c_lay = QVBoxLayout(central)
        c_lay.setContentsMargins(0, 0, 0, 0)
        c_lay.setSpacing(0)
        c_lay.addWidget(splitter, 1)
        c_lay.addWidget(bar, 0)
        self.setCentralWidget(central)

        # Wire buttons
        self.replace_btn.clicked.connect(self.on_replace)
        self.undo_btn.clicked.connect(self.on_undo)
        self.save_project_btn.clicked.connect(self.on_save_project)
        self.load_project_btn.clicked.connect(self.on_load_project)
        # self.save_defaults_btn.clicked.connect(self.on_save_defaults)
        # self.load_defaults_btn.clicked.connect(self.on_load_defaults)
        self.save_output_btn.clicked.connect(self.on_save_output)

        # Menu (optional)
        file_menu = self.menuBar().addMenu("File")
        act_load_project = QAction("Load Project...", self)
        act_load_project.triggered.connect(self.on_load_project)
        file_menu.addAction(act_load_project)
        act_save_project = QAction("Save Project...", self)
        act_save_project.triggered.connect(self.on_save_project)
        file_menu.addAction(act_save_project)
        file_menu.addSeparator()
        act_save_output = QAction("Save Output...", self)
        act_save_output.triggered.connect(self.on_save_output)
        file_menu.addAction(act_save_output)
        file_menu.addSeparator()
        act_save_defaults = QAction("Save Defaults", self)
        act_save_defaults.triggered.connect(self.on_save_defaults)
        file_menu.addAction(act_save_defaults)
        act_load_defaults = QAction("Load Defaults", self)
        act_load_defaults.triggered.connect(self.on_load_defaults)
        file_menu.addAction(act_load_defaults)

        # Keep last output for Undo
        self._last_output = ""

        # Auto-save defaults (debounced) so a crash loses little
        self._autosave_timer = QTimer(self)
        self._autosave_timer.setInterval(800)
        self._autosave_timer.setSingleShot(True)
        self._autosave_timer.timeout.connect(self.on_save_defaults)
        self.input_edit.textChanged.connect(self._schedule_autosave)

        self.apply_dark_theme()

        # Auto-load defaults on start
        if self.DEFAULTS_PATH.exists():
            try:
                self.load_state(self.DEFAULTS_PATH)
            except Exception:
                pass

        self._last_saved_digest: bytes | None = None

    def _encode_state(self) -> bytes:
        """Stable JSON bytes for change detection."""
        return json.dumps(
            self.serialize_state(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":")
        ).encode("utf-8")

    def _digest(self, data: bytes) -> bytes:
        return hashlib.sha256(data).digest()


    # ------------------------------- State I/O ------------------------------
    def _schedule_autosave(self):
        self._autosave_timer.start()

    def add_pair(self, pat: str = "", rep: str = ""):
        def remove_row(row: PairRow):
            row.setParent(None)
            row.deleteLater()
            self._schedule_autosave()
        stretch_index = self.pairs_layout.count() - 1
        row = PairRow(remove_row)
        row.pattern.setText(str(pat))
        row.replacement.setText(str(rep))
        row.pattern.textChanged.connect(self._schedule_autosave)
        row.replacement.textChanged.connect(self._schedule_autosave)
        self.pairs_layout.insertWidget(stretch_index, row)
        self._schedule_autosave()

    def gather_pairs(self) -> list[tuple[str, str]]:
        pairs: list[tuple[str, str]] = []
        for i in range(self.pairs_layout.count() - 1):  # skip stretch
            w = self.pairs_layout.itemAt(i).widget()
            if isinstance(w, PairRow):
                pat, rep = w.value()
                if pat:
                    pairs.append((pat, rep))
        return pairs

    def serialize_state(self) -> dict:
        return {
            "pattern_text": self.input_edit.toPlainText(),
            "pairs": [{"pattern": p, "replacement": r} for p, r in self.gather_pairs()],
        }

    def load_state(self, path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.input_edit.setPlainText(data.get("pattern_text", ""))
        # clear pairs
        for i in reversed(range(self.pairs_layout.count() - 1)):
            w = self.pairs_layout.itemAt(i).widget()
            if w:
                w.setParent(None)
                w.deleteLater()
        for item in data.get("pairs", []):
            self.add_pair(item.get("pattern", ""), item.get("replacement", ""))

    def _atomic_write(self, path: Path, data_bytes: bytes):
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(data_bytes)
        tmp.replace(path)  # atomic on POSIX

    def on_save_defaults(self):
        data_bytes = self._encode_state()
        new_digest = self._digest(data_bytes)

        # short-circuit if we already wrote this exact content
        if self._last_saved_digest == new_digest:
            return

        # optional: also compare to file contents (survives restarts)
        try:
            if self.DEFAULTS_PATH.exists() and self.DEFAULTS_PATH.read_bytes() == data_bytes:
                self._last_saved_digest = new_digest
                return
        except Exception:
            pass

        self.DEFAULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_write(self.DEFAULTS_PATH, data_bytes)
        self._last_saved_digest = new_digest

    def on_load_defaults(self):
        if self.DEFAULTS_PATH.exists():
            self.load_state(self.DEFAULTS_PATH)
            # record digest of what’s on disk
            try:
                self._last_saved_digest = self._digest(self.DEFAULTS_PATH.read_bytes())
            except Exception:
                self._last_saved_digest = None

    def on_save_project(self):
        path, _ = QFileDialog.getSaveFileName(self, "Save Project As", "pattern_project.json", "Project (*.json);;All Files (*)")
        if not path:
            return
        self._atomic_write(Path(path), json.dumps(self.serialize_state(), ensure_ascii=False, indent=2))

    def on_load_project(self):
        path, _ = QFileDialog.getOpenFileName(self, "Load Project", "", "Project (*.json);;All Files (*)")
        if not path:
            return
        self.load_state(Path(path))

    def on_save_output(self):
        path, _ = QFileDialog.getSaveFileName(self, "Save Output As", "output.txt", "Text Files (*.txt);;All Files (*)")
        if not path:
            return
        Path(path).write_text(self.output_edit.toPlainText(), encoding="utf-8")

    def closeEvent(self, e):
        try:
            self.on_save_defaults()
        finally:
            super().closeEvent(e)

    # -------------------------------- Actions --------------------------------
    def on_replace(self):
        text = self.input_edit.toPlainText()
        out = process_text(text)
        for pat, rep in self.gather_pairs():
            out = out.replace(pat, rep)
        self._last_output = self.output_edit.toPlainText()
        self.output_edit.setPlainText(out)

    def on_undo(self):
        self.output_edit.setPlainText(self._last_output)

    # -------------------------------- Styling -------------------------------
    def apply_dark_theme(self):
        self.setStyleSheet(
            """
            QMainWindow { background: #15161a; }
            QWidget { color: #e5e7eb; background: #15161a; font-size: 14px; }
            QPlainTextEdit, QLineEdit { background: #0f1115; color: #e5e7eb; border: 1px solid #2a2d34; border-radius: 8px; }
            QLabel { color: #cbd5e1; }
            QToolButton { background: #1b1e24; border: 1px solid #2a2d34; border-radius: 8px; padding: 4px 8px; }
            QToolButton:hover { background: #22252c; }
            QPushButton { background: #1f2937; border: 1px solid #2a2d34; border-radius: 12px; padding: 6px 12px; }
            QPushButton:hover { background: #273244; }
            QPushButton:pressed { background: #2f3b50; }
            QScrollArea { background: #15161a; border: none; }
            QSplitter::handle { background: #0f1115; height: 6px; }
            QMenuBar { background: #15161a; color: #e5e7eb; }
            QMenuBar::item:selected { background: #273244; }
            QMenu { background: #15161a; color: #e5e7eb; border: 1px solid #2a2d34; }
            QMenu::item:selected { background: #273244; }
            """
        )


# --------------------------------- Entrypoint -------------------------------
if __name__ == "__main__":
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())
