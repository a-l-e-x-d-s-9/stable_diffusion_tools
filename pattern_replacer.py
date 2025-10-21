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
    QScrollArea, QFrame, QToolButton, QSplitter, QSizePolicy, QSpacerItem,
    QComboBox, QMessageBox, QInputDialog
)
import time, hashlib
import math


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

    # ----- parse slots (names & initial numbers) -----
    slot_matches = list(_slot_pat.finditer(template))
    nslots = len(slot_matches)
    if nslots == 0:
        return "[sum_inc note: no numeric slots name:value found]"
    base_vals = [Decimal(m.group(3)) for m in slot_matches]

    # attributes
    upper_s = attrs.get("upper") or attrs.get("upper_bound") or attrs.get("stop")
    lower_s = attrs.get("lower") or attrs.get("lower_bound") or attrs.get("min")
    order = (attrs.get("order") or "up_first").strip().lower()

    # NEW: count-based mode detection (aka “interval count”)
    count_s = attrs.get("count") or attrs.get("interval_count") or attrs.get("sums") or attrs.get("count_sums")
    dist = (attrs.get("dist") or attrs.get("distribution") or "uniform").strip().lower()
    sigma_s = attrs.get("sigma")

    # decimal places / quantizer
    def places_for_all():
        return max(
            max((_dec_places(m.group(3)) for m in slot_matches), default=0),
            _dec_places(upper_s or ""),
            _dec_places(lower_s or ""),
            _dec_places(attrs.get("interval") or "")
        )
    q = _quantizer(places_for_all())

    # helper for rendering with a provided vector of values
    def render_with_values(vals: list[Decimal]) -> str:
        i = 0
        def _repl(m: re.Match) -> str:
            nonlocal i
            name, colon = m.group(1), m.group(2)
            d = vals[i]; i += 1
            return f"{name}{colon}{_fmt(d, q)}"
        return _slot_pat.sub(_repl, template).strip()

    # ----------------------------
    # COUNT MODE (new feature)
    # ----------------------------
    if count_s is not None:
        # require bounds
        if not (upper_s and lower_s):
            return "[sum_inc error: count-mode requires lower=... and upper=...]"
        try:
            count = int(count_s)
            if count <= 0:
                return "[sum_inc error: count must be > 0]"
        except Exception:
            return "[sum_inc error: bad count]"

        try:
            lower = Decimal(lower_s)
            upper = Decimal(upper_s)
        except Exception:
            return "[sum_inc error: bad lower/upper]"
        if upper < lower:
            # allow reverse; we’ll still produce ascending sums
            lower, upper = upper, lower

        # build target sums, evenly spaced, inclusive
        sums: list[Decimal] = []
        if count == 1:
            sums = [lower]
        else:
            step = (upper - lower) / Decimal(count - 1)
            for i in range(count):
                sums.append(lower + step * Decimal(i))

        # distribution profiles -> weights over variables
        if dist in ("uniform", "u"):
            weights = [Decimal(1) / Decimal(nslots)] * nslots
        else:
            # normal_* modes
            if dist in ("normal_center", "center", "normal", "gauss", "gauss_center"):
                mu = (nslots - 1) / 2.0
            elif dist in ("normal_start", "start", "gauss_start"):
                mu = 0.0
            elif dist in ("normal_end", "end", "gauss_end", "normal_send", "send"):
                mu = float(nslots - 1)
            else:
                # fallback to uniform if unknown
                weights = [Decimal(1) / Decimal(nslots)] * nslots
                mu = None

            if mu is not None:
                try:
                    sigma = float(sigma_s) if sigma_s is not None else max(0.8, (nslots - 1) / 3.0)
                    sigma = max(sigma, 1e-6)
                except Exception:
                    sigma = max(0.8, (nslots - 1) / 3.0)

                ws = []
                for j in range(nslots):
                    z = (j - mu) / sigma
                    ws.append(math.exp(-0.5 * z * z))
                total = sum(ws) or 1.0
                weights = [Decimal(w / total) for w in ws]

        # For each target sum, distribute across variables and render
        lines = []
        for S in sums:
            raw = [S * w for w in weights]  # Decimal * Decimal
            # round all but last, then fix the last to keep sum close
            vals = [d.quantize(q, rounding=ROUND_HALF_UP) for d in raw]
            # adjust minor rounding drift to the last slot to keep tighter sum
            drift = S - sum(vals, Decimal(0))
            if nslots > 0:
                vals[-1] = (vals[-1] + drift).quantize(q, rounding=ROUND_HALF_UP)
            lines.append(render_with_values(vals))

        # default is already ascending by sum
        return "\n".join(lines)

    # ----------------------------
    # ORIGINAL INTERVAL MODE (existing)
    # ----------------------------
    interval_s = attrs.get("interval")
    try:
        step_mag = abs(Decimal(interval_s))
    except Exception:
        return "[sum_inc error: bad interval]"
    if step_mag <= 0:
        return "[sum_inc error: interval must be > 0]"

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

    def step_up(base: Decimal, k: int) -> Decimal:
        return base + step_mag * Decimal(k)

    def step_down(base: Decimal, k: int) -> Decimal:
        return base - step_mag * Decimal(k)

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

    # Sorting by sum (optional attr: sort=none|desc)
    sort_mode = (attrs.get("sort") or "sum_asc").strip().lower()
    inc_per_row = (abs(Decimal(attrs.get("interval") or "0")) * Decimal(nslots)) if nslots else Decimal(0)
    def sum_for_k(k: int) -> Decimal:
        return sum0 + inc_per_row * Decimal(k)

    rows = [(sum_for_k(k), render_with_k(k)) for k in ks]
    if sort_mode in ("none", "off", "false", "0"):
        lines = [r for _, r in rows]
    elif sort_mode in ("desc", "sum_desc"):
        lines = [r for _, r in sorted(rows, key=lambda t: t[0], reverse=True)]
    else:
        lines = [r for _, r in sorted(rows, key=lambda t: t[0])]

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
    PATTERN_HISTORY_PATH = Path.home() / ".pattern_replacer_qt6_patterns.json"
    DEFAULT_RING_SIZE = 11  # default_0..default_10

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

        # Pattern header row (title + history dropdown + actions)
        hdr = QHBoxLayout()
        hdr.setSpacing(8)

        hdr.addWidget(QLabel("Pattern"))

        self.pattern_combo = QComboBox()
        self.pattern_combo.setEditable(True)  # to allow placeholder
        self.pattern_combo.lineEdit().setReadOnly(True)
        self.pattern_combo.lineEdit().setPlaceholderText("History…")
        self.pattern_combo.setMinimumWidth(220)
        self.pattern_combo.setToolTip("Pick a saved pattern from history")
        self.pattern_combo.currentTextChanged.connect(self._on_pattern_combo_changed)
        hdr.addWidget(self.pattern_combo, 1)  # stretch

        self.btn_hist_save = QPushButton("Save")
        self.btn_hist_save.setToolTip("Save current editor contents to this name (asks to overwrite if exists)")
        self.btn_hist_save.clicked.connect(self._on_history_save)
        hdr.addWidget(self.btn_hist_save)

        self.btn_hist_save_as = QPushButton("Save As")
        self.btn_hist_save_as.clicked.connect(self._on_history_save_as)
        hdr.addWidget(self.btn_hist_save_as)

        self.btn_hist_delete = QPushButton("Delete")
        self.btn_hist_delete.clicked.connect(self._on_history_delete)
        hdr.addWidget(self.btn_hist_delete)

        top_lay.addLayout(hdr)

        # CREATE the editor BEFORE adding it
        self.input_edit = QPlainTextEdit()
        self.input_edit.setPlaceholderText("Enter pattern text with tags here...")
        self.input_edit.setLineWrapMode(QPlainTextEdit.LineWrapMode.WidgetWidth)
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
            "  • <sum_inc interval=0.05 upper=1.15 lower=0.70 order=center_out> ... </sum_inc>\n"
            "  • New: count-based sum mode\n"
            "  •     <sum_inc count=5 lower=0.6 upper=1.1 dist=uniform> a:0,b:0,c:0 </sum_inc>\n"
            "  •     <sum_inc count=7 lower=0.6 upper=1.25 dist=normal_center sigma=0.9> a:0,b:0,c:0,d:0 </sum_inc>\n"
            "  •     dist = uniform | normal_center | normal_start | normal_end\n"
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

        self._last_saved_digest: bytes | None = None

        self._pattern_history: dict[str, str] = {}
        self._last_pattern_hash: bytes | None = None
        self._last_snapshot_hash: bytes | None = None
        self._last_snapshot_len: int = 0
        self._last_snapshot_ts: float = 0.0
        self._default_ring_index: int = 0

        # Load manual pattern history into combo
        self._load_pattern_history()
        self._refresh_pattern_combo()

        # Take periodic “default_*” snapshots on meaningful changes
        self.input_edit.textChanged.connect(self._schedule_snapshot)  # add this
        self._snapshot_timer = QTimer(self)
        self._snapshot_timer.setInterval(1200)
        self._snapshot_timer.setSingleShot(True)
        self._snapshot_timer.timeout.connect(self._snapshot_if_significant)

        # Auto-load defaults on start
        if self.DEFAULTS_PATH.exists():
            try:
                self.load_state(self.DEFAULTS_PATH)
            except Exception:
                pass



    # ---------- Pattern history (manual) ----------
    def _history_atomic_write(self, path: Path, data: dict):
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _load_pattern_history(self):
        try:
            if self.PATTERN_HISTORY_PATH.exists():
                data = json.loads(self.PATTERN_HISTORY_PATH.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    self._pattern_history = {str(k): str(v) for k, v in data.get("patterns", {}).items()}
            else:
                self._pattern_history = {}
        except Exception:
            self._pattern_history = {}

    def _save_pattern_history(self):
        try:
            self.PATTERN_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
            self._history_atomic_write(self.PATTERN_HISTORY_PATH, {"patterns": self._pattern_history})
        except Exception:
            pass

    def _refresh_pattern_combo(self, keep_selection: bool = False):
        current = self.pattern_combo.currentText() if keep_selection else ""
        self.pattern_combo.blockSignals(True)
        self.pattern_combo.clear()

        # Sort: non-default names first (alpha), then default_* (by index)
        def _sort_key(k: str):
            return (1, int(k.split("_")[1])) if k.startswith("default_") and k[8:].isdigit() else (0, k.lower())

        for name in sorted(self._pattern_history.keys(), key=_sort_key):
            self.pattern_combo.addItem(name)
        if keep_selection and current:
            idx = self.pattern_combo.findText(current)
            if idx >= 0:
                self.pattern_combo.setCurrentIndex(idx)
        self.pattern_combo.blockSignals(False)

    def _on_pattern_combo_changed(self, name: str):
        if not name:
            return
        text = self._pattern_history.get(name, "")
        if text:
            self.input_edit.setPlainText(text)

    def _on_history_save(self):
        name = self.pattern_combo.currentText().strip()
        if not name:
            # no name selected -> ask for one
            name, ok = QInputDialog.getText(self, "Save Pattern", "Name:")
            if not ok or not name.strip():
                return
            name = name.strip()

        content = self.input_edit.toPlainText()
        if name in self._pattern_history and self._pattern_history[name] != content:
            # confirm overwrite
            resp = QMessageBox.question(self, "Overwrite?",
                                        f"Pattern '{name}' exists. Overwrite?",
                                        QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
            if resp != QMessageBox.StandardButton.Yes:
                return

        self._pattern_history[name] = content
        self._save_pattern_history()
        self._refresh_pattern_combo(keep_selection=True)

    def _on_history_save_as(self):
        name, ok = QInputDialog.getText(self, "Save Pattern As", "New name:")
        if not ok or not name.strip():
            return
        name = name.strip()
        if name in self._pattern_history:
            resp = QMessageBox.question(self, "Overwrite?",
                                        f"Pattern '{name}' exists. Overwrite?",
                                        QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
            if resp != QMessageBox.StandardButton.Yes:
                return
        self._pattern_history[name] = self.input_edit.toPlainText()
        self._save_pattern_history()
        self._refresh_pattern_combo(keep_selection=True)
        idx = self.pattern_combo.findText(name)
        if idx >= 0:
            self.pattern_combo.setCurrentIndex(idx)

    def _on_history_delete(self):
        name = self.pattern_combo.currentText().strip()
        if not name:
            return
        resp = QMessageBox.question(self, "Delete?",
                                    f"Delete pattern '{name}' from history?",
                                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        if resp != QMessageBox.StandardButton.Yes:
            return
        if name in self._pattern_history:
            del self._pattern_history[name]
            self._save_pattern_history()
            self._refresh_pattern_combo()

    # ---------- Default_* rotating snapshots on significant change ----------
    def _schedule_snapshot(self):
        self._snapshot_timer.start()

    def _snapshot_if_significant(self):
        text = self.input_edit.toPlainText()
        if not text:
            return
        h = hashlib.sha256(text.encode("utf-8")).digest()
        now = time.time()
        length = len(text)

        # Heuristic for "significant" change:
        #  - hash changed AND (size changed by >= 48 chars OR at least 90s since last snapshot)
        size_changed = abs(length - (self._last_snapshot_len or 0)) >= 48
        time_passed = (now - (self._last_snapshot_ts or 0)) >= 90.0
        if (self._last_snapshot_hash == h) or (not size_changed and not time_passed):
            return

        slot = f"default_{self._default_ring_index % self.DEFAULT_RING_SIZE}"
        self._pattern_history[slot] = text
        self._save_pattern_history()
        self._refresh_pattern_combo(keep_selection=True)
        self._default_ring_index = (self._default_ring_index + 1) % self.DEFAULT_RING_SIZE

        self._last_snapshot_hash = h
        self._last_snapshot_len = length
        self._last_snapshot_ts = now

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
        tmp.replace(path)

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
        path, _ = QFileDialog.getSaveFileName(self, "Save Project As", "pattern_project.json",
                                              "Project (*.json);;All Files (*)")
        if not path:
            return
        data = json.dumps(self.serialize_state(), ensure_ascii=False, indent=2).encode("utf-8")
        self._atomic_write(Path(path), data)

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
