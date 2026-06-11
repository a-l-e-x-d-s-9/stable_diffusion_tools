#!/usr/bin/env python3
"""
Image Histogram Comparator - PyQt6 UI

Purpose:
    Compare the RGB histograms of two images.

Features:
    - Drag & drop two image files.
    - Large images are safely downscaled for preview and histogram analysis.
    - Shows preview for each image.
    - Shows RGB histogram for each image.
    - Shows a larger comparison area:
        * signed difference: histogram 2 - histogram 1
        * absolute difference
    - Shows useful similarity/difference metrics.

Requirements:
    pip install PyQt6 pillow numpy matplotlib

Run:
    python3 image_histogram_comparator.py
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageOps, ImageQt

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QDragEnterEvent, QDropEvent, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
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
    QFileDialog,
)

from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure


SUPPORTED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".avif"
}

PREVIEW_MAX_SIZE = 480
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
        preview.thumbnail((PREVIEW_MAX_SIZE, PREVIEW_MAX_SIZE), Image.Resampling.LANCZOS)

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


class DropImageBox(QFrame):
    image_loaded = pyqtSignal(int, object)

    def __init__(self, index: int, title: str) -> None:
        super().__init__()
        self.index = index
        self.image_data: Optional[ImageData] = None

        self.setAcceptDrops(True)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setObjectName("DropImageBox")
        self.setMinimumHeight(260)

        self.title_label = QLabel(title)
        self.title_label.setObjectName("SlotTitle")

        self.preview_label = QLabel("Drag & drop image here\nor click Browse")
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setMinimumHeight(260)
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
            return

        qimage = ImageQt.ImageQt(self.image_data.preview_image)
        pixmap = QPixmap.fromImage(qimage)
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


class HistogramCanvas(FigureCanvas):
    def __init__(self, title: str = "", height: float = 2.4, min_height: int = 260) -> None:
        self.figure = Figure(figsize=(7.5, height), tight_layout=True)
        super().__init__(self.figure)
        self.title = title
        self.setMinimumHeight(min_height)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

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

    def plot_signed_difference(self, diff_rgb: np.ndarray) -> None:
        self.figure.clear()
        ax = self.figure.add_subplot(111)

        x = np.arange(256)
        labels = ["Red Δ", "Green Δ", "Blue Δ"]
        colors = ["red", "green", "blue"]

        for channel in range(3):
            ax.plot(x, diff_rgb[channel], label=labels[channel], color=colors[channel], alpha=0.85)

        ax.axhline(0, linewidth=1.0, alpha=0.7)
        ax.set_title("Signed histogram difference: Image 2 − Image 1")
        ax.set_xlim(0, 255)
        ax.set_xlabel("Brightness value")
        ax.set_ylabel("Normalized frequency difference")
        ax.grid(True, alpha=0.25)
        ax.legend(loc="upper right")
        self.draw()

    def plot_absolute_difference(self, abs_diff_rgb: np.ndarray) -> None:
        self.figure.clear()
        ax = self.figure.add_subplot(111)

        x = np.arange(256)
        labels = ["|Red Δ|", "|Green Δ|", "|Blue Δ|"]
        colors = ["red", "green", "blue"]

        for channel in range(3):
            ax.fill_between(x, abs_diff_rgb[channel], alpha=0.20, color=colors[channel])
            ax.plot(x, abs_diff_rgb[channel], label=labels[channel], color=colors[channel], alpha=0.85)

        ax.set_title("Absolute histogram difference")
        ax.set_xlim(0, 255)
        ax.set_xlabel("Brightness value")
        ax.set_ylabel("Absolute normalized difference")
        ax.grid(True, alpha=0.25)
        ax.legend(loc="upper right")
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

    mean_abs_by_channel = np.mean(np.abs(hist2 - hist1), axis=1)
    peak_diff_by_channel = np.max(np.abs(hist2 - hist1), axis=1)

    return {
        "correlation": correlation,
        "intersection": float(intersection),
        "l1": float(l1),
        "l2": l2,
        "chi_square": float(chi_square),
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

        main_layout = QVBoxLayout(root)
        main_layout.setContentsMargins(12, 12, 12, 12)
        main_layout.setSpacing(12)

        top_row = QHBoxLayout()
        top_row.setSpacing(12)

        self.drop1 = DropImageBox(1, "Image 1")
        self.drop2 = DropImageBox(2, "Image 2")
        self.drop1.setMinimumHeight(360)
        self.drop2.setMinimumHeight(360)
        self.drop1.image_loaded.connect(self.on_image_loaded)
        self.drop2.image_loaded.connect(self.on_image_loaded)

        top_row.addWidget(self.drop1)
        top_row.addWidget(self.drop2)
        main_layout.addLayout(top_row)

        histogram_panel = QWidget()
        hist_layout = QGridLayout(histogram_panel)
        hist_layout.setContentsMargins(0, 0, 0, 0)
        hist_layout.setHorizontalSpacing(12)
        hist_layout.setVerticalSpacing(12)

        self.hist_canvas_1 = HistogramCanvas(height=3.0, min_height=320)
        self.hist_canvas_2 = HistogramCanvas(height=3.0, min_height=320)
        self.hist_canvas_1.clear_plot("Load image 1")
        self.hist_canvas_2.clear_plot("Load image 2")

        hist_layout.addWidget(self.wrap_group("Histogram 1", self.hist_canvas_1), 0, 0)
        hist_layout.addWidget(self.wrap_group("Histogram 2", self.hist_canvas_2), 0, 1)
        main_layout.addWidget(histogram_panel)

        comparison_panel = QWidget()
        comparison_layout = QVBoxLayout(comparison_panel)
        comparison_layout.setContentsMargins(0, 0, 0, 0)
        comparison_layout.setSpacing(12)

        self.metrics_label = QLabel("Load two images to compare histograms.")
        self.metrics_label.setObjectName("MetricsLabel")
        self.metrics_label.setWordWrap(True)
        self.metrics_label.setMinimumHeight(86)
        comparison_layout.addWidget(self.metrics_label)

        self.diff_canvas = HistogramCanvas(height=4.0, min_height=430)
        self.abs_diff_canvas = HistogramCanvas(height=4.0, min_height=430)
        self.diff_canvas.clear_plot("Load two images")
        self.abs_diff_canvas.clear_plot("Load two images")

        comparison_layout.addWidget(self.wrap_group("Comparison - Signed Difference", self.diff_canvas))
        comparison_layout.addWidget(self.wrap_group("Comparison - Absolute Difference", self.abs_diff_canvas))
        main_layout.addWidget(comparison_panel)

        main_layout.addStretch(1)

        self.apply_style()

    @staticmethod
    def wrap_group(title: str, widget: QWidget) -> QGroupBox:
        group = QGroupBox(title)
        layout = QVBoxLayout(group)
        layout.addWidget(widget)
        return group

    def on_image_loaded(self, index: int, data: ImageData) -> None:
        if index == 1:
            self.image1 = data
            self.hist_canvas_1.plot_histogram(data.hist_rgb, f"Image 1: {data.path.name}")
        else:
            self.image2 = data
            self.hist_canvas_2.plot_histogram(data.hist_rgb, f"Image 2: {data.path.name}")

        self.update_comparison()

    def update_comparison(self) -> None:
        if not self.image1 or not self.image2:
            self.metrics_label.setText("Load two images to compare histograms.")
            return

        hist1 = self.image1.hist_rgb
        hist2 = self.image2.hist_rgb

        diff = hist2 - hist1
        abs_diff = np.abs(diff)
        metrics = histogram_metrics(hist1, hist2)

        self.diff_canvas.plot_signed_difference(diff)
        self.abs_diff_canvas.plot_absolute_difference(abs_diff)

        self.metrics_label.setText(
            "<b>Histogram similarity / difference</b><br>"
            f"Correlation: <b>{metrics['correlation']:.5f}</b> "
            f"(closer to 1 means more similar)&nbsp;&nbsp; | &nbsp;&nbsp;"
            f"Intersection: <b>{metrics['intersection']:.5f}</b> "
            f"(closer to 1 means more overlap)&nbsp;&nbsp; | &nbsp;&nbsp;"
            f"L1 distance: <b>{metrics['l1']:.5f}</b>&nbsp;&nbsp; | &nbsp;&nbsp;"
            f"L2 distance: <b>{metrics['l2']:.7f}</b>&nbsp;&nbsp; | &nbsp;&nbsp;"
            f"Chi-square: <b>{metrics['chi_square']:.5f}</b><br>"
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
