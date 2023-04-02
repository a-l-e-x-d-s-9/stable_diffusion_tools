import os
import sys
from PyQt5.QtWidgets import (QApplication, QWidget, QLabel, QGridLayout, QVBoxLayout, QHBoxLayout,
                             QLineEdit, QPushButton, QSpinBox, QGraphicsDropShadowEffect, QFrame)
from PyQt5.QtGui import QPixmap, QColor, QIcon
from PyQt5.QtCore import Qt, QSize, QPoint

class ImageDropWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)

        self.grid_item_width = 128
        self.grid_item_height = 128
        self.grid_spacing = 10
        self.min_width = 500
        self.min_height = 300
        self.setAcceptDrops(True)

        # Main layout
        self.main_layout = QVBoxLayout(self)
        self.setLayout(self.main_layout)

        # Grid layout
        self.grid_layout = QGridLayout()
        self.grid_layout.setSpacing(self.grid_spacing)
        self.grid_layout.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        self.main_layout.addLayout(self.grid_layout)

        # Bottom layout
        self.bottom_layout = QHBoxLayout()
        self.bottom_layout.setAlignment(Qt.AlignBottom | Qt.AlignLeft)
        self.main_layout.addLayout(self.bottom_layout)

        # Add caption label
        self.caption_label = QLabel("Add caption", self)
        self.bottom_layout.addWidget(self.caption_label)

        # Add caption text input
        self.caption_input = QLineEdit(self)
        self.bottom_layout.addWidget(self.caption_input)

        # Add comma place input
        self.comma_place_input = QSpinBox(self)
        self.bottom_layout.addWidget(self.comma_place_input)


        # Add captions button
        self.add_captions_button = QPushButton("Add captions", self)
        self.bottom_layout.addWidget(self.add_captions_button)
        self.add_captions_button.clicked.connect(self.add_captions)  # Connect the button to the add_captions method

        self.clear_button = QPushButton("Clear", self)
        self.bottom_layout.addWidget(self.clear_button)
        self.clear_button.clicked.connect(self.clear_grid)

        # Captions layout
        self.captions_layout = QHBoxLayout()
        self.captions_layout.setAlignment(Qt.AlignBottom | Qt.AlignLeft)
        self.main_layout.addLayout(self.captions_layout)

        # Add captions text input/output
        self.captions_io = QLineEdit(self)
        self.captions_layout.addWidget(self.captions_io)

        self.images = []
        self.resize(self.min_width, self.min_height)
        self.setMinimumSize(self.min_width, self.min_height)

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
                    pixmap = pixmap.scaled(self.grid_item_width, self.grid_item_height, aspectRatioMode=Qt.KeepAspectRatio)
                    label = QLabel(self)
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
        comma_place = self.comma_place_input.value()

        for label in self.images:
            path = label.path
            txt_path = os.path.splitext(path)[0] + '.txt'

            if not os.path.exists(txt_path):
                with open(txt_path, 'w') as txt_file:
                    pass  # Create an empty txt file if it doesn't exist

            with open(txt_path, 'r') as txt_file:
                captions = txt_file.read().strip().split(',')

            if comma_place > len(captions):
                comma_place = len(captions)

            if not caption_text.startswith(' '):
                caption_text = ' ' + caption_text

            captions.insert(comma_place, caption_text)



            with open(txt_path, 'w') as txt_file:
                txt_file.write(','.join(captions))

    def resizeEvent(self, event):
        self.update_grid_layout()
        super().resizeEvent(event)

    def update_grid_layout(self):
        window_size = self.size()
        items_in_grid_line = max(1, int(window_size.width() / (self.grid_item_width + self.grid_spacing)))

        for i, label in enumerate(self.images):
            self.grid_layout.addWidget(label, i // items_in_grid_line, i % items_in_grid_line)

            # Position close button at the top-right corner of the label
            close_button = label.findChild(QPushButton)
            close_button.move(QPoint(0, 0))

        self.grid_layout.setAlignment(Qt.AlignTop | Qt.AlignLeft)

    def minimumSizeHint(self):
        """Override minimumSizeHint to return a minimum size of 500x300 pixels."""
        return QSize(500, 300)

    def clear_grid(self):
        for label in self.images:
            self.grid_layout.removeWidget(label)
            label.deleteLater()
        self.images.clear()

    def remove_item(self, label):
        self.images.remove(label)
        self.grid_layout.removeWidget(label)
        label.deleteLater()
        self.update_grid_layout()



if __name__ == '__main__':
    app = QApplication(sys.argv)
    widget = ImageDropWidget()
    widget.show()
    sys.exit(app.exec_())
