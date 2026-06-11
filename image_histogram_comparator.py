#!/usr/bin/env python3
"""
Image Histogram Comparator - PyQt6 UI

Version: 1.3 top-results layout

Purpose:
    Compare the RGB histograms of two images.

Features:
    - Starts with only the two image input boxes visible.
    - Drag & drop two image files, or use Browse.
    - Large images are safely downscaled for preview and histogram analysis.
    - After images are loaded:
        * comparison appears at the top
        * individual histograms appear above the image inputs
        * image inputs stay at the bottom for changing images
    - Adjustable vertical splitters let you resize comparison / histogram / input areas.
    - Comparison view supports channel toggles:
        * Combined / all colors enabled by default
        * Red, Green, Blue optional
    - Shows useful similarity/difference metrics.

Requirements:
    pip install PyQt6 pillow numpy matplotlib

Run:
    python3 image_histogram_comparator_v1_3_top_results_channel_toggles.py
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageOps

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QDragEnterEvent, QDropEvent, QImage, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QScrollArea,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure


SUPPORTED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".avif"
}

PREVIEW_MAX_WIDTH = 760
PREVIEW_MAX_HEIGHT = 300
ANALYSIS_MAX_DIMENSION = 4096


@dataclass
class ImageData:
    path: Path
    preview_image: Image.Image
    analysis_image: Image.Image
    hist_rgb: np.ndarray  # shape: (3, 256), normalized
    raw_counts: np.ndarray  # shape: (3, 256), raw counts
    pixel_count: int
    size_original: tuple[int, int]
    size_analysis: tuple[int, int]


def normalize_histogram(counts: np.ndarray) -> np.ndarray:
    total = counts.sum(axis=1, keepdims=True)
    total[total == 0] = 1
    return counts / total


def load_image_data(path: Path) -> ImageData:
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        original_size = img.size

        rgb = img.convert("RGB")

        analysis = rgb.copy()
        analysis.thumbnail(
            (ANALYSIS_MAX_DIMENSION, ANALYSIS_MAX_DIMENSION),
            Image.Resampling.LANCZOS,
        )

        arr = np.asarray(analysis, dtype=np.uint8)
        raw_counts = np.vstack([
            np.bincount(arr[:, :, channel].ravel(), minlength=256)
            for channel in range(3)
        ]).astype(np.float64)

        hist_rgb = normalize_histogram(raw_counts)
        pixel_count = int(arr.shape[0] * arr.shape[1])

        preview = rgb.copy()
        preview.thumbnail((PREVIEW_MAX_WIDTH, PREVIEW_MAX_HEIGHT), Image.Resampling.LANCZOS)

    return ImageData(
        path=path,
        preview_image=preview,
        analysis_image=analysis,
        hist_rgb=hist_rgb,
        raw_counts=raw_counts,
        pixel_count=pixel_count,
        size_original=original_size,
        size_analysis=analysis.size,
    )


def pil_rgb_to_qpixmap(image: Image.Image) -> QPixmap:
    """
    Convert a PIL RGB image into a QPixmap safely.

    This avoids ImageQt buffer lifetime / stride issues that can show corrupted
    horizontal bands with some large WebP/JPEG images.
    """
    rgb = image.convert("RGB")
    arr = np.ascontiguousarray(np.asarray(rgb, dtype=np.uint8))
    height, width, channels = arr.shape
    bytes_per_line = channels * width

    qimage = QImage(
        arr.data,
        width,
        height,
        bytes_per_line,
        QImage.Format.Format_RGB888,
    ).copy()

    return QPixmap.fromImage(qimage)


class DropImageBox(QFrame):
    image_loaded = pyqtSignal(int, object)

    def __init__(self, index: int, title: str) -> None:
        super().__init__()
        self.index = index
        self.image_data: Optional[ImageData] = None

        self.setAcceptDrops(True)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setObjectName("DropImageBox")
        self.setMinimumHeight(430)

        self.title_label = QLabel(title)
        self.title_label.setObjectName("SlotTitle")

        self.preview_label = QLabel("Drag & drop image here\nor click Browse")
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setMinimumHeight(310)
        self.preview_label.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

        self.info_label = QLabel("")
        self.info_label.setWordWrap(True)
        self.info_label.setObjectName("InfoLabel")

        self.browse_button = QPushButton("Browse")
        self.browse_button.clicked.connect(self.browse_file)

        layout = QVBoxLayout(self)
        layout.addWidget(self.title_label)
        layout.addWidget(self.preview_label, stretch=1)
        layout.addWidget(self.info_label)
        layout.addWidget(self.browse_button)

    def browse_file(self) -> None:
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Select image",
            "",
            "Images (*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff *.avif);;All files (*)",
        )
        if file_path:
            self.set_image(Path(file_path))

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:
        if event.mimeData().hasUrls():
            for url in event.mimeData().urls():
                path = Path(url.toLocalFile())
                if path.suffix.lower() in SUPPORTED_EXTENSIONS:
                    event.acceptProposedAction()
                    return
        event.ignore()

    def dropEvent(self, event: QDropEvent) -> None:
        urls = event.mimeData().urls()
        for url in urls:
            path = Path(url.toLocalFile())
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS:
                self.set_image(path)
                event.acceptProposedAction()
                return

    def set_image(self, path: Path) -> None:
        try:
            data = load_image_data(path)
        except Exception as exc:
            QMessageBox.critical(self, "Failed to load image", f"{path}\n\n{exc}")
            return

        self.image_data = data
        self.update_preview()
        self.image_loaded.emit(self.index, data)

    def update_preview(self) -> None:
        if not self.image_data:
            self.clear_preview()
            return

        pixmap = pil_rgb_to_qpixmap(self.image_data.preview_image)
        self.preview_label.setPixmap(pixmap)
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        original = self.image_data.size_original
        analysis = self.image_data.size_analysis
        self.info_label.setText(
            f"{self.image_data.path.name}\n"
            f"Original: {original[0]}×{original[1]} | "
            f"Analyzed: {analysis[0]}×{analysis[1]} | "
            f"Pixels: {self.image_data.pixel_count:,}"
        )

    def set_data_direct(self, data: Optional[ImageData]) -> None:
        self.image_data = data
        self.update_preview()

    def clear_preview(self) -> None:
        self.preview_label.clear()
        self.preview_label.setText("Drag & drop image here\nor click Browse")
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.info_label.setText("")


class HistogramCanvas(FigureCanvas):
    def __init__(self, title: str = "", height: float = 3.0, min_height: int = 320) -> None:
        self.figure = Figure(figsize=(7.5, height), tight_layout=True)
        super().__init__(self.figure)
        self.title = title
        self.setMinimumHeight(min_height)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def clear_plot(self, message: str = "") -> None:
        self.figure.clear()
        ax = self.figure.add_subplot(111)
        ax.set_title(self.title)
        ax.text(0.5, 0.5, message, ha="center", va="center", transform=ax.transAxes)
        ax.set_xticks([])
        ax.set_yticks([])
        self.draw()

    def plot_histogram(self, hist_rgb: np.ndarray, title: str) -> None:
        self.figure.clear()
        ax = self.figure.add_subplot(111)

        x = np.arange(256)
        labels = ["Red", "Green", "Blue"]
        colors = ["red", "green", "blue"]

        for channel in range(3):
            ax.plot(x, hist_rgb[channel], label=labels[channel], color=colors[channel], alpha=0.85)

        ax.set_title(title)
        ax.set_xlim(0, 255)
        ax.set_xlabel("Brightness value")
        ax.set_ylabel("Normalized frequency")
        ax.grid(True, alpha=0.25)
        ax.legend(loc="upper right")
        self.draw()

    def plot_signed_difference(
        self,
        diff_rgb: np.ndarray,
        show_combined: bool = True,
        show_red: bool = False,
        show_green: bool = False,
        show_blue: bool = False,
    ) -> None:
        self.figure.clear()
        ax = self.figure.add_subplot(111)

        x = np.arange(256)
        plotted = False

        if show_combined:
            combined = diff_rgb.mean(axis=0)
            ax.plot(
                x,
                combined,
                label="Combined RGB Δ",
                color="black",
                linewidth=2.2,
                alpha=0.95,
            )
            plotted = True

        channel_options = [
            (show_red, 0, "Red Δ", "red"),
            (show_green, 1, "Green Δ", "green"),
            (show_blue, 2, "Blue Δ", "blue"),
        ]

        for enabled, channel, label, color in channel_options:
            if enabled:
                ax.plot(
                    x,
                    diff_rgb[channel],
                    label=label,
                    color=color,
                    linewidth=1.2,
                    alpha=0.80,
                )
                plotted = True

        ax.axhline(0, linewidth=1.0, alpha=0.7)
        ax.set_title("Signed histogram difference: Image 2 − Image 1")
        ax.set_xlim(0, 255)
        ax.set_xlabel("Brightness value")
        ax.set_ylabel("Normalized frequency difference")
        ax.grid(True, alpha=0.25)

        if plotted:
            ax.legend(loc="upper right")
        else:
            ax.text(
                0.5,
                0.5,
                "Enable at least one channel above",
                ha="center",
                va="center",
                transform=ax.transAxes,
            )

        self.draw()


def histogram_metrics(hist1: np.ndarray, hist2: np.ndarray) -> dict[str, float]:
    eps = 1e-12

    flat1 = hist1.ravel()
    flat2 = hist2.ravel()

    intersection = np.minimum(flat1, flat2).sum() / 3.0
    l1 = np.abs(flat2 - flat1).sum() / 3.0
    l2 = float(np.sqrt(np.mean((flat2 - flat1) ** 2)))
    chi_square = 0.5 * np.sum(((flat2 - flat1) ** 2) / (flat2 + flat1 + eps)) / 3.0

    if np.std(flat1) < eps or np.std(flat2) < eps:
        correlation = 0.0
    else:
        correlation = float(np.corrcoef(flat1, flat2)[0, 1])

    combined1 = hist1.mean(axis=0)
    combined2 = hist2.mean(axis=0)
    combined_l1 = float(np.abs(combined2 - combined1).sum())
    combined_peak = float(np.max(np.abs(combined2 - combined1)))

    mean_abs_by_channel = np.mean(np.abs(hist2 - hist1), axis=1)
    peak_diff_by_channel = np.max(np.abs(hist2 - hist1), axis=1)

    return {
        "correlation": correlation,
        "intersection": float(intersection),
        "l1": float(l1),
        "l2": l2,
        "chi_square": float(chi_square),
        "combined_l1": combined_l1,
        "combined_peak": combined_peak,
        "mean_abs_red": float(mean_abs_by_channel[0]),
        "mean_abs_green": float(mean_abs_by_channel[1]),
        "mean_abs_blue": float(mean_abs_by_channel[2]),
        "peak_red": float(peak_diff_by_channel[0]),
        "peak_green": float(peak_diff_by_channel[1]),
        "peak_blue": float(peak_diff_by_channel[2]),
    }


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()

        self.setWindowTitle("Image Histogram Comparator")
        self.resize(1450, 1000)

        self.image1: Optional[ImageData] = None
        self.image2: Optional[ImageData] = None

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.setCentralWidget(scroll)

        root = QWidget()
        scroll.setWidget(root)

        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(12, 12, 12, 12)
        root_layout.setSpacing(12)

        self.main_splitter = QSplitter(Qt.Orientation.Vertical)
        self.main_splitter.setChildrenCollapsible(False)
        root_layout.addWidget(self.main_splitter)

        self.comparison_panel = self.build_comparison_panel()
        self.histogram_panel = self.build_histogram_panel()
        self.input_panel = self.build_input_panel()

        self.main_splitter.addWidget(self.comparison_panel)
        self.main_splitter.addWidget(self.histogram_panel)
        self.main_splitter.addWidget(self.input_panel)

        # Start clean: only inputs are visible until the user loads images.
        self.comparison_panel.setVisible(False)
        self.histogram_panel.setVisible(False)

        self.main_splitter.setSizes([520, 360, 440])

        self.apply_style()

    def build_comparison_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)

        self.metrics_label = QLabel("Load two images to compare histograms.")
        self.metrics_label.setObjectName("MetricsLabel")
        self.metrics_label.setWordWrap(True)
        self.metrics_label.setMinimumHeight(86)
        layout.addWidget(self.metrics_label)

        controls = QHBoxLayout()
        controls.setSpacing(18)

        self.chk_combined = QCheckBox("Combined / all colors")
        self.chk_red = QCheckBox("Red")
        self.chk_green = QCheckBox("Green")
        self.chk_blue = QCheckBox("Blue")

        self.chk_combined.setChecked(True)
        self.chk_red.setChecked(False)
        self.chk_green.setChecked(False)
        self.chk_blue.setChecked(False)

        for checkbox in [self.chk_combined, self.chk_red, self.chk_green, self.chk_blue]:
            checkbox.stateChanged.connect(self.update_comparison)
            controls.addWidget(checkbox)

        controls.addStretch(1)
        layout.addLayout(controls)

        self.diff_canvas = HistogramCanvas(height=4.6, min_height=520)
        self.diff_canvas.clear_plot("Load two images")
        layout.addWidget(self.wrap_group("Comparison - Signed Difference", self.diff_canvas))

        return panel

    def build_histogram_panel(self) -> QWidget:
        panel = QWidget()
        layout = QGridLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setHorizontalSpacing(12)
        layout.setVerticalSpacing(12)

        self.hist_canvas_1 = HistogramCanvas(height=3.1, min_height=350)
        self.hist_canvas_2 = HistogramCanvas(height=3.1, min_height=350)
        self.hist_canvas_1.clear_plot("Load image 1")
        self.hist_canvas_2.clear_plot("Load image 2")

        layout.addWidget(self.wrap_group("Histogram 1", self.hist_canvas_1), 0, 0)
        layout.addWidget(self.wrap_group("Histogram 2", self.hist_canvas_2), 0, 1)

        return panel

    def build_input_panel(self) -> QWidget:
        panel = QWidget()
        layout = QHBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(12)

        self.drop1 = DropImageBox(1, "Image 1")
        self.drop2 = DropImageBox(2, "Image 2")
        self.drop1.image_loaded.connect(self.on_image_loaded)
        self.drop2.image_loaded.connect(self.on_image_loaded)

        swap_col = QVBoxLayout()
        swap_col.setContentsMargins(0, 0, 0, 0)
        swap_col.addStretch(1)

        self.swap_button = QPushButton("⇄")
        self.swap_button.setObjectName("SwapButton")
        self.swap_button.setToolTip("Swap Image 1 and Image 2")
        self.swap_button.clicked.connect(self.swap_images)
        swap_col.addWidget(self.swap_button)

        swap_col.addStretch(1)

        layout.addWidget(self.drop1, stretch=1)
        layout.addLayout(swap_col)
        layout.addWidget(self.drop2, stretch=1)

        return panel

    @staticmethod
    def wrap_group(title: str, widget: QWidget) -> QGroupBox:
        group = QGroupBox(title)
        layout = QVBoxLayout(group)
        layout.addWidget(widget)
        return group

    def on_image_loaded(self, index: int, data: ImageData) -> None:
        if index == 1:
            self.image1 = data
        else:
            self.image2 = data

        self.refresh_all_views()

        if self.image1 and self.image2:
            # Put useful results in view immediately after the second image loads.
            self.main_splitter.setSizes([560, 370, 430])

    def swap_images(self) -> None:
        self.image1, self.image2 = self.image2, self.image1

        self.drop1.set_data_direct(self.image1)
        self.drop2.set_data_direct(self.image2)

        self.refresh_all_views()

    def refresh_all_views(self) -> None:
        if self.image1:
            self.hist_canvas_1.plot_histogram(self.image1.hist_rgb, f"Image 1: {self.image1.path.name}")
        else:
            self.hist_canvas_1.clear_plot("Load image 1")

        if self.image2:
            self.hist_canvas_2.plot_histogram(self.image2.hist_rgb, f"Image 2: {self.image2.path.name}")
        else:
            self.hist_canvas_2.clear_plot("Load image 2")

        self.histogram_panel.setVisible(bool(self.image1 or self.image2))
        self.comparison_panel.setVisible(bool(self.image1 and self.image2))

        if self.image1 and self.image2:
            self.update_comparison()
        else:
            self.metrics_label.setText("Load two images to compare histograms.")
            self.diff_canvas.clear_plot("Load two images")

    def update_comparison(self) -> None:
        if not self.image1 or not self.image2:
            return

        hist1 = self.image1.hist_rgb
        hist2 = self.image2.hist_rgb

        diff = hist2 - hist1
        metrics = histogram_metrics(hist1, hist2)

        self.diff_canvas.plot_signed_difference(
            diff,
            show_combined=self.chk_combined.isChecked(),
            show_red=self.chk_red.isChecked(),
            show_green=self.chk_green.isChecked(),
            show_blue=self.chk_blue.isChecked(),
        )

        self.metrics_label.setText(
            "<b>Histogram similarity / difference</b><br>"
            f"Correlation: <b>{metrics['correlation']:.5f}</b> "
            f"(closer to 1 means more similar)&nbsp;&nbsp; | &nbsp;&nbsp;"
            f"Intersection: <b>{metrics['intersection']:.5f}</b> "
            f"(closer to 1 means more overlap)&nbsp;&nbsp; | &nbsp;&nbsp;"
            f"L1 distance: <b>{metrics['l1']:.5f}</b>&nbsp;&nbsp; | &nbsp;&nbsp;"
            f"L2 distance: <b>{metrics['l2']:.7f}</b>&nbsp;&nbsp; | &nbsp;&nbsp;"
            f"Chi-square: <b>{metrics['chi_square']:.5f}</b><br>"
            f"Combined/all colors — "
            f"L1: <b>{metrics['combined_l1']:.5f}</b>, "
            f"Peak bin diff: <b>{metrics['combined_peak']:.7f}</b><br>"
            f"Mean absolute channel diff — "
            f"R: <b>{metrics['mean_abs_red']:.7f}</b>, "
            f"G: <b>{metrics['mean_abs_green']:.7f}</b>, "
            f"B: <b>{metrics['mean_abs_blue']:.7f}</b><br>"
            f"Peak bin diff — "
            f"R: <b>{metrics['peak_red']:.7f}</b>, "
            f"G: <b>{metrics['peak_green']:.7f}</b>, "
            f"B: <b>{metrics['peak_blue']:.7f}</b>"
        )

    def apply_style(self) -> None:
        self.setStyleSheet("""
            QMainWindow {
                background: #202124;
                color: #e8eaed;
            }
            QWidget {
                background: #202124;
                color: #e8eaed;
                font-size: 12px;
            }
            QGroupBox {
                border: 1px solid #3c4043;
                border-radius: 8px;
                margin-top: 10px;
                padding-top: 10px;
                font-weight: bold;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 12px;
                padding: 0 4px;
            }
            #DropImageBox {
                border: 2px dashed #5f6368;
                border-radius: 10px;
                background: #292a2d;
            }
            #DropImageBox:hover {
                border-color: #8ab4f8;
            }
            #SlotTitle {
                font-size: 16px;
                font-weight: bold;
            }
            QLabel {
                selection-background-color: #8ab4f8;
            }
            #InfoLabel {
                color: #bdc1c6;
            }
            #MetricsLabel {
                background: #292a2d;
                border: 1px solid #3c4043;
                border-radius: 8px;
                padding: 10px;
                font-size: 13px;
            }
            QCheckBox {
                spacing: 8px;
                font-size: 13px;
            }
            QCheckBox::indicator {
                width: 16px;
                height: 16px;
            }
            #SwapButton {
                font-size: 28px;
                font-weight: bold;
                min-width: 56px;
                max-width: 56px;
                min-height: 56px;
                max-height: 56px;
                border-radius: 28px;
                padding: 0;
            }
            QPushButton {
                background: #3c4043;
                border: 1px solid #5f6368;
                border-radius: 6px;
                padding: 6px 12px;
            }
            QPushButton:hover {
                background: #4a4d51;
                border-color: #8ab4f8;
            }
            QScrollArea {
                border: none;
            }
            QScrollBar:vertical {
                background: #202124;
                width: 14px;
                margin: 0;
            }
            QScrollBar::handle:vertical {
                background: #5f6368;
                border-radius: 6px;
                min-height: 40px;
            }
            QScrollBar::handle:vertical:hover {
                background: #7a7d81;
            }
            QScrollBar::add-line:vertical,
            QScrollBar::sub-line:vertical {
                height: 0;
            }
            QSplitter::handle {
                background: #3c4043;
                height: 10px;
            }
            QSplitter::handle:hover {
                background: #8ab4f8;
            }
        """)


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Image Histogram Comparator")

    window = MainWindow()
    window.show()

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
