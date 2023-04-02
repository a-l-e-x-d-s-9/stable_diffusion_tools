import sys
from PyQt5.QtWidgets import QApplication, QWidget, QLabel, QGridLayout
from PyQt5.QtGui import QPixmap
from PyQt5.QtCore import Qt, QSize


class ImageDropWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)

        self.grid_item_width = 128
        self.grid_item_height = 128
        self.grid_spacing = 10
        self.min_width = 500
        self.min_height = 300
        self.setAcceptDrops(True)
        self.grid_layout = QGridLayout(self)
        self.grid_layout.setSpacing(self.grid_spacing)
        self.grid_layout.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        self.images = []
        self.resize(self.min_width, self.min_height)
        self.setMinimumSize(self.min_width, self.min_height)

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.accept()
        else:
            event.ignore()

    def dropEvent(self, event):
        for url in event.mimeData().urls():
            path = url.toLocalFile()
            if path.endswith('.jpg') or path.endswith('.png'):
                if path not in [label.path for label in self.images]:
                    pixmap = QPixmap(path)
                    pixmap = pixmap.scaled(self.grid_item_width, self.grid_item_height, aspectRatioMode=Qt.KeepAspectRatio)
                    label = QLabel(self)
                    label.path = path
                    label.setPixmap(pixmap)
                    self.images.append(label)
                    self.update_grid_layout()
                    break
                else:
                    print(f"{path} already exists in the widget!")
        else:
            event.ignore()

    def resizeEvent(self, event):
        self.update_grid_layout()
        super().resizeEvent(event)

    def update_grid_layout(self):
        window_size = self.size()
        items_in_grid_line = max(1, int(window_size.width() / (self.grid_item_width + self.grid_spacing)))

        for i, label in enumerate(self.images):
            self.grid_layout.addWidget(label, i // items_in_grid_line, i % items_in_grid_line)

        self.grid_layout.setAlignment(Qt.AlignTop | Qt.AlignLeft)

    def minimumSizeHint(self):
        """Override minimumSizeHint to return a minimum size of 500x300 pixels."""
        return QSize(500, 300)


if __name__ == '__main__':
    app = QApplication(sys.argv)
    widget = ImageDropWidget()
    widget.show()
    sys.exit(app.exec_())
