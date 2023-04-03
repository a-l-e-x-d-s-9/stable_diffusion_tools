import os
import sys
from PyQt5.QtWidgets import (QApplication, QWidget, QLabel, QGridLayout, QVBoxLayout, QHBoxLayout,
                             QLineEdit, QPushButton, QSpinBox, QGraphicsDropShadowEffect, QFrame, QTextEdit,
                             QScrollArea, QMessageBox)
from PyQt5.QtGui import QPixmap, QColor, QIcon, QPalette
from PyQt5.QtCore import Qt, QSize, QPoint, QTimer


class ImageLabel(QLabel):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.path = None
        self.setFrameShape(QFrame.Panel)
        self.setLineWidth(3)
        self.set_default_frame_color()

    def set_default_frame_color(self):
        # Set the default frame color to the background color
        palette = self.palette()
        palette.setColor(QPalette.WindowText, palette.color(QPalette.Background))
        self.setPalette(palette)

    def set_selected_frame_color(self):
        # Set the frame color to red
        palette = self.palette()
        palette.setColor(QPalette.WindowText, QColor(Qt.red))
        self.setPalette(palette)

    def set_unselected_frame_color(self):
        # Set the frame color to the background color
        self.set_default_frame_color()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.parent().parent().parent().parent().on_image_clicked(self)
        super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event):
        if self.path:
            if sys.platform.startswith('linux'):
                os.system(f"xdg-open '{self.path}'")
            elif sys.platform.startswith('win'):
                os.system(f"start '{self.path}'")
            elif sys.platform.startswith('darwin'):
                os.system(f"open '{self.path}'")


class ImageDropWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)

        self.grid_item_width = 128
        self.grid_item_height = 128
        self.grid_spacing = 10
        self.min_width = 800
        self.min_height = 400
        self.setAcceptDrops(True)
        self.last_preview = None
        self.resize_timer = QTimer()
        self.resize_timer.timeout.connect(self.resize_done)

        # Create horizontal layout
        self.h_layout = QHBoxLayout(self)

        # Main layout
        self.main_layout = QVBoxLayout()
        self.preview_layout = QVBoxLayout()

        self.h_layout.addLayout(self.main_layout)
        self.h_layout.addLayout(self.preview_layout)
        self.setLayout(self.h_layout)

        # Grid layout
        self.grid_layout = QGridLayout()
        self.grid_layout.setSpacing(self.grid_spacing)
        self.grid_layout.setAlignment(Qt.AlignTop | Qt.AlignLeft)

        # Grid Widget
        self.grid_widget = QWidget()
        self.grid_widget.setLayout(self.grid_layout)
        self.grid_widget.setStyleSheet("background-color: #dddddd;")  # Set the background color of the grid

        # Scroll Area
        self.scroll_area = QScrollArea(self)
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setWidget(self.grid_widget)
        self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)

        self.main_layout.addWidget(self.scroll_area, stretch=10)

        # Bottom layout
        self.bottom_layout = QHBoxLayout()
        self.bottom_layout.setAlignment(Qt.AlignBottom | Qt.AlignLeft)
        self.main_layout.addLayout(self.bottom_layout)

        # Add caption label
        self.caption_label = QLabel("Add caption for all:", self)
        self.bottom_layout.addWidget(self.caption_label)

        # Add caption text input
        self.caption_input = QLineEdit(self)
        self.caption_input.setPlaceholderText("Add caption to all shown images")
        self.bottom_layout.addWidget(self.caption_input)

        self.caption_label = QLabel("Comma position:", self)
        self.bottom_layout.addWidget(self.caption_label)

        # Add comma place input
        self.comma_place_input = QSpinBox(self)
        self.bottom_layout.addWidget(self.comma_place_input)

        # Add captions button
        self.add_captions_button = QPushButton("Add to all", self)
        self.bottom_layout.addWidget(self.add_captions_button)
        self.add_captions_button.clicked.connect(self.add_captions)  # Connect the button to the add_captions method

        self.clear_button = QPushButton("Clear Images", self)
        self.bottom_layout.addWidget(self.clear_button)
        self.clear_button.clicked.connect(self.clear_all)

        # Captions layout
        self.captions_layout = QHBoxLayout()
        self.captions_layout.setAlignment(Qt.AlignBottom | Qt.AlignLeft)
        self.main_layout.addLayout(self.captions_layout)

        # Add captions text input/output

        self.caption_label = QLabel("For image:", self)
        self.captions_layout.addWidget(self.caption_label)

        self.captions_io = QTextEdit(self)
        self.captions_io.setPlaceholderText("Select image to edit captions")
        self.captions_io.setLineWrapMode(QTextEdit.WidgetWidth)
        self.captions_io.textChanged.connect(self.adjust_text_height)
        self.captions_layout.addWidget(self.captions_io)

        self.current_label = None
        self.captions_io.textChanged.connect(self.on_captions_io_text_changed)

        self.save_captions_button = QPushButton("Save caption", self)
        self.captions_layout.addWidget(self.save_captions_button)
        self.save_captions_button.clicked.connect(self.save_captions)

        # Preview label
        self.preview_label = QLabel(self)
        self.preview_label.setAlignment(Qt.AlignCenter)
        self.preview_label.setMinimumSize(int(self.min_width // 3), int(self.min_height - 10))
        self.preview_label.setFrameShape(QFrame.Box)
        self.preview_label.setFrameShadow(QFrame.Sunken)
        self.preview_label.setStyleSheet("background-color: #ffffff;")
        self.preview_layout.addWidget(self.preview_label, stretch=2)

        self.images = []
        self.resize(self.min_width, self.min_height)
        self.setMinimumSize(self.min_width, self.min_height)

        self.adjust_text_height()

    def adjust_text_height(self):
        document_height = self.captions_io.document().size().height()
        scroll_bar_height = self.captions_io.verticalScrollBar().sizeHint().height()
        widget_height = self.captions_io.sizeHint().height()

        if self.captions_io.toPlainText() == "":
            self.captions_io.setFixedHeight(min(100, widget_height))
        elif document_height + scroll_bar_height > widget_height:
            self.captions_io.setFixedHeight(int(document_height + scroll_bar_height))

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.accept()
        else:
            event.ignore()

    def dropEvent(self, event):
        print(f"dropEvent, urls len: {len(event.mimeData().urls())}")
        for url in event.mimeData().urls():
            path = url.toLocalFile()
            if path.endswith('.jpg') or path.endswith('.png'):
                if path not in [label.path for label in self.images]:
                    pixmap = QPixmap(path)
                    pixmap = pixmap.scaled(self.grid_item_width, self.grid_item_height,
                                           aspectRatioMode=Qt.KeepAspectRatio)
                    label = ImageLabel(self)
                    label.path = path
                    label.setPixmap(pixmap)

                    # Add close button to the label
                    close_button = QPushButton("X", label)
                    close_button.setStyleSheet("QPushButton { color: red; }")
                    close_button.setFlat(True)
                    close_button.setFixedSize(QSize(16, 16))
                    close_button.clicked.connect(lambda checked, lbl=label: self.remove_item(lbl))

                    self.images.append(label)
                    self.update_grid_layout()

                else:
                    print(f"{path} already exists in the widget!")
        else:
            event.ignore()

    def add_captions(self):
        caption_text = self.caption_input.text()
        comma_place_desired = self.comma_place_input.value()

        for label in self.images:
            path = label.path
            txt_path = os.path.splitext(path)[0] + '.txt'

            if not os.path.exists(txt_path):
                with open(txt_path, 'w') as txt_file:
                    pass  # Create an empty txt file if it doesn't exist

            with open(txt_path, 'r') as txt_file:
                captions = txt_file.read().strip().split(',')

            comma_place = comma_place_desired
            if comma_place > len(captions):
                comma_place = len(captions)

            if not caption_text.startswith(' '):
                caption_text = ' ' + caption_text

            captions.insert(comma_place, caption_text)

            with open(txt_path, 'w') as txt_file:
                txt_file.write(','.join(captions))

    def resizeEvent(self, event):
        self.update_grid_layout()
        self.update_preview_simple()
        super().resizeEvent(event)

    def update_grid_layout(self):
        window_size = self.size()
        items_in_grid_line = max(1, int((window_size.width() - self.preview_label.size().width()) / (self.grid_item_width + self.grid_spacing)))

        for i, label in enumerate(self.images):
            label.setMinimumSize(self.grid_item_width, self.grid_item_height)
            self.grid_layout.addWidget(label, i // items_in_grid_line, i % items_in_grid_line)

            # Position close button at the top-right corner of the label
            close_button = label.findChild(QPushButton)
            close_button.move(QPoint(0, 0))

        self.grid_layout.setAlignment(Qt.AlignTop | Qt.AlignLeft)

    def minimumSizeHint(self):
        """Override minimumSizeHint to return a minimum size of 800x400 pixels."""
        return QSize(self.min_width, self.min_height)

    def clear_all(self):
        for label in self.images:
            self.grid_layout.removeWidget(label)
            label.deleteLater()
        self.images.clear()

        self.captions_io.setText("")

    def remove_item(self, label):
        was_selected = False
        if self.current_label == label:
            was_selected = True

        self.images.remove(label)
        self.grid_layout.removeWidget(label)
        label.deleteLater()
        self.update_grid_layout()

        # Clear captions_io and reset frame color if the removed label was currently selected
        if was_selected:
            self.update_preview_clear()
            self.current_label = None
            self.captions_io.setText("")
            for img in self.images:
                img.set_unselected_frame_color()

    def ensure_txt_file_exists(self, txt_path):
        if not os.path.exists(txt_path):
            with open(txt_path, 'w') as txt_file:
                pass  # Create an empty txt file if it doesn't exist

    def update_preview_clear(self):
        self.resize_timer.stop()
        self.last_preview = None
        self.preview_label.setPixmap(QPixmap())


    def update_preview_with_image_resize(self, label):
        pixmap = QPixmap(label.path)

        # pixmap = self.last_preview.pixmap().scaled(self.preview_label.size(), aspectRatioMode=Qt.KeepAspectRatio,
        #                                            transformMode=Qt.SmoothTransformation)
        pixmap = pixmap.scaledToHeight(int(self.preview_label.height()), Qt.SmoothTransformation)

        # pixmap = pixmap.scaledToHeight(self.preview_label.height(), Qt.SmoothTransformation)
        self.last_preview = label
        self.preview_label.setPixmap(pixmap)

    def update_preview_simple(self):
        if (None != self.last_preview):
            pixmap = self.last_preview.pixmap().scaled(self.preview_label.size(), aspectRatioMode=Qt.KeepAspectRatio,
                                                       transformMode=Qt.SmoothTransformation)
            pixmap = pixmap.scaledToHeight(int(self.preview_label.height()), Qt.SmoothTransformation)

            self.preview_label.setPixmap(pixmap)
            self.preview_label.setMinimumSize(int(self.window().size().width() // 3),
                                              int(self.window().size().height() - 10))
            self.resize_timer.stop()
            self.resize_timer.setInterval(500)
            self.resize_timer.setSingleShot(True)
            self.resize_timer.start()

    def resize_done(self):
        self.resize_timer.stop()
        if (None != self.last_preview):
            # print("resize_done")

            self.update_preview_with_image_resize(self.last_preview)

    def on_image_clicked(self, label):
        if self.current_label is not None and self.captions_io.property("text_modified"):
            reply = QMessageBox.question(
                self, "Save changes", "Do you want to save changes to the current caption?",
                QMessageBox.Save | QMessageBox.Ignore | QMessageBox.Cancel
            )

            if reply == QMessageBox.Save:
                self.save_captions()
            elif reply == QMessageBox.Cancel:
                return

        self.current_label = label
        for img in self.images:
            if img == label:
                img.set_selected_frame_color()
            else:
                img.set_unselected_frame_color()

        txt_path = os.path.splitext(label.path)[0] + '.txt'
        self.ensure_txt_file_exists(txt_path)

        with open(txt_path, 'r') as txt_file:
            content = txt_file.read()
            self.captions_io.blockSignals(True)  # Block signals to avoid triggering textChanged
            self.captions_io.setText(content)
            self.captions_io.blockSignals(False)  # Unblock signals

        self.captions_io.setProperty("text_modified", False)
        self.captions_io.setStyleSheet("")

        self.update_preview_with_image_resize(label)

    def on_captions_io_text_changed(self):
        self.captions_io.setProperty("text_modified", True)
        self.captions_io.setStyleSheet("QTextEdit { border: 2px solid yellow; }")

    def save_captions(self):
        if self.current_label is not None:
            txt_path = os.path.splitext(self.current_label.path)[0] + '.txt'
            content = self.captions_io.toPlainText()
            with open(txt_path, 'w') as txt_file:
                txt_file.write(content)

            self.captions_io.setProperty("text_modified", False)
            self.captions_io.setStyleSheet("")


if __name__ == '__main__':
    app = QApplication(sys.argv)
    widget = ImageDropWidget()
    widget.show()
    sys.exit(app.exec_())
