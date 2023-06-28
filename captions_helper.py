import os
import sys
from PyQt5.QtWidgets import (QApplication, QWidget, QLabel, QGridLayout, QVBoxLayout, QHBoxLayout,
                             QLineEdit, QPushButton, QSpinBox, QGraphicsDropShadowEffect, QFrame, QTextEdit,
                             QScrollArea, QMessageBox, QSizePolicy)
from PyQt5.QtGui import QPixmap, QColor, QIcon, QPalette, QTransform, QImage
from PyQt5.QtCore import Qt, QSize, QPoint, QTimer
from PyQt5.QtWidgets import QMainWindow, QAction, QMenu, QMenuBar, QDialog, QVBoxLayout, QTextEdit, QPushButton
from PIL import Image, UnidentifiedImageError
import piexif

class ListInputDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Add List")
        self.layout = QVBoxLayout(self)

        # Textbox for user input
        self.text_box = QTextEdit(self)
        self.layout.addWidget(self.text_box)

        # Add button
        self.add_button = QPushButton("Add", self)
        self.layout.addWidget(self.add_button)
        self.add_button.clicked.connect(self.on_add_button_clicked)

    def on_add_button_clicked(self):
        text = self.text_box.toPlainText()
        self.parent().process_list_input(text)
        self.close()


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

        if event.button() == Qt.RightButton:
            # Right button was pressed, copy image to clipboard
            clipboard = QApplication.clipboard()
            pixmap = self.pixmap()
            if pixmap:
                clipboard.setPixmap(pixmap)

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

        self.current_image_index = 0

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


        # Horizontal line
        self.line = QFrame(self)
        self.line.setFrameShape(QFrame.HLine)
        self.line.setFrameShadow(QFrame.Sunken)
        self.main_layout.addWidget(self.line)

        # Bottom layout for remove
        self.bottom_layout_remove = QHBoxLayout()
        self.bottom_layout_remove.setAlignment(Qt.AlignBottom | Qt.AlignLeft)
        self.main_layout.addLayout(self.bottom_layout_remove)

        # Remove caption label
        self.remove_caption_label = QLabel("Remove caption for all:", self)
        self.bottom_layout_remove.addWidget(self.remove_caption_label)

        # Remove caption text input
        self.remove_caption_input = QLineEdit(self)
        self.remove_caption_input.setPlaceholderText("Remove caption to all shown images")
        self.bottom_layout_remove.addWidget(self.remove_caption_input)

        # Remove captions button
        self.remove_captions_button = QPushButton("Remove from all", self)
        self.bottom_layout_remove.addWidget(self.remove_captions_button)
        self.remove_captions_button.clicked.connect(self.remove_captions)  # Connect the button to the add_captions method


        # Horizontal line
        self.line = QFrame(self)
        self.line.setFrameShape(QFrame.HLine)
        self.line.setFrameShadow(QFrame.Sunken)
        self.main_layout.addWidget(self.line)



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

        # Horizontal line
        self.line = QFrame(self)
        self.line.setFrameShape(QFrame.HLine)
        self.line.setFrameShadow(QFrame.Sunken)
        self.main_layout.addWidget(self.line)

        # Clear Images
        self.clear_button = QPushButton("Clear Images", self)
        self.clear_button.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        self.clear_button.setStyleSheet("QPushButton { color: red; }")
        self.clear_button.setStyleSheet("QPushButton { background-color: red; }")
        self.main_layout.addWidget(self.clear_button)
        self.clear_button.clicked.connect(self.clear_all)

        # Key help
        self.key_help_label = QLabel(
            "<span style='color: gray;'>Key controls: 'A' - left, 'D' - right, 'W' - top, 'S' - bottom, 'Backspace' - remove, 'F' - flip image horizontally</span>",
            self
        )
        self.main_layout.addWidget(self.key_help_label)

        # Preview label
        self.preview_label = QLabel(self)
        self.preview_label.setAlignment(Qt.AlignCenter)
        self.preview_label.setMinimumSize(int(self.min_width // 3), int(self.min_height - 20))
        self.preview_label.setFrameShape(QFrame.Box)
        self.preview_label.setFrameShadow(QFrame.Sunken)
        self.preview_label.setStyleSheet("background-color: #ffffff;")
        self.preview_layout.addWidget(self.preview_label, stretch=2)

        self.images = []
        self.resize(self.min_width, self.min_height)
        self.setMinimumSize(self.min_width, self.min_height)

        self.adjust_text_height()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key_A:  # 'a' key for left
            self.navigate_to_previous_image()
        elif event.key() == Qt.Key_D:  # 'd' key for right
            self.navigate_to_next_image()
        elif event.key() == Qt.Key_W:  # 'w' key for up
            self.navigate_to_previous_row_image()
        elif event.key() == Qt.Key_S:  # 's' key for down
            self.navigate_to_next_row_image()
        elif event.key() in {Qt.Key_Backspace, Qt.Key_Delete}:
            if self.current_label is not None:
                self.remove_item(self.current_label)
        elif event.key() == Qt.Key_F:
            self.flip_current_image()

    import piexif

    def flip_current_image(self):
        if self.current_label is not None:
            try:
                # Open the image using PIL
                img = Image.open(self.current_label.path)

                # Flip the image horizontally
                img = img.transpose(Image.FLIP_LEFT_RIGHT)

                # Create new EXIF data with a normal orientation
                exif_dict = {"0th": {piexif.ImageIFD.Orientation: 1}}
                exif_bytes = piexif.dump(exif_dict)

                # Save the image back to the same path with new EXIF data
                img.save(self.current_label.path, exif=exif_bytes)

                # Reload the image into QPixmap
                pixmap = QPixmap(self.current_label.path)

                # Scale the image to the appropriate size for the grid
                pixmap = pixmap.scaled(self.grid_item_width, self.grid_item_height, aspectRatioMode=Qt.KeepAspectRatio)

                # Update the label's pixmap and refresh the label
                self.current_label.setPixmap(pixmap)
                self.current_label.update()

                # Replace the old label in the self.images list with the new one
                self.images[self.images.index(self.current_label)] = self.current_label

                # Update the preview with the new pixmap
                self.update_preview_with_image_resize(self.current_label)

            except Exception as e:
                print(f"Error when flipping image: {e}")


    def navigate_to_previous_image(self):
        if self.current_image_index > 0:  # prevent underflow
            self.current_image_index -= 1
        self.select_current_image()

    def navigate_to_next_image(self):
        if self.current_image_index < len(self.images) - 1:  # prevent overflow
            self.current_image_index += 1
        self.select_current_image()

    def navigate_to_previous_row_image(self):
        items_in_grid_line = max(1, int((self.size().width() - self.preview_label.size().width()) / (self.grid_item_width + self.grid_spacing)))
        if self.current_image_index >= items_in_grid_line:  # if there's a row above
            self.current_image_index -= items_in_grid_line
        self.select_current_image()

    def navigate_to_next_row_image(self):
        items_in_grid_line = max(1, int((self.size().width() - self.preview_label.size().width()) / (self.grid_item_width + self.grid_spacing)))
        if self.current_image_index < len(self.images) - items_in_grid_line:  # if there's a row below
            self.current_image_index += items_in_grid_line
        self.select_current_image()

    def select_current_image(self):
        self.on_image_clicked(self.images[self.current_image_index])

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

    def add_images_to_preview_area(self, paths):
        # Check if paths is a list
        if not isinstance(paths, list):
            raise TypeError("paths must be a list")

        # Loop through the image paths and add them to the preview area
        for path in paths:
            # You could reuse the logic in dropEvent here for adding images, or create another method
            if path.endswith('.jpg') or path.endswith('.png'):
                if path not in [label.path for label in self.images]:
                    pixmap = image_basic.load_image_with_exif(path)

                    # Check and flip the QPixmap image if it's not already flipped
                    if pixmap.transformed(QTransform().scale(-1, 1), Qt.SmoothTransformation) == pixmap:
                        pixmap = pixmap.transformed(QTransform().scale(-1, 1), Qt.SmoothTransformation)

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

    def dropEvent(self, event):
        print(f"dropEvent, urls len: {len(event.mimeData().urls())}")
        for url in event.mimeData().urls():
            path = url.toLocalFile()
            if path.endswith('.jpg') or path.endswith('.png'):
                if path not in [label.path for label in self.images]:
                    pixmap = image_basic.load_image_with_exif(path)
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
        caption_text = self.caption_input.text().strip()  # Remove any leading/trailing spaces
        tags_to_add = [tag.strip() for tag in caption_text.split(',')]  # Multiple tags separated by commas

        comma_place_desired = self.comma_place_input.value()

        for label in self.images:
            path = label.path
            txt_path = os.path.splitext(path)[0] + '.txt'

            if not os.path.exists(txt_path):
                with open(txt_path, 'w') as txt_file:
                    pass  # Create an empty txt file if it doesn't exist

            with open(txt_path, 'r') as txt_file:
                captions = [caption.strip() for caption in txt_file.read().split(',')]

            # Ensure there are no duplicates by using set operations
            captions = list(set(captions) - set(tags_to_add))  # Remove tags to add from captions to avoid duplicates

            comma_place = comma_place_desired
            if comma_place > len(captions):
                comma_place = len(captions)

            for tag in reversed(tags_to_add):  # Loop over tags to add and insert each one
                captions.insert(comma_place, tag)

            with open(txt_path, 'w') as txt_file:
                txt_file.write(', '.join(captions))

    def remove_captions(self):
        caption_text = self.remove_caption_input.text().strip()  # Remove any leading/trailing spaces

        tags_to_remove = [tag.strip() for tag in caption_text.split(',')]

        for label in self.images:
            path = label.path
            txt_path = os.path.splitext(path)[0] + '.txt'

            if not os.path.exists(txt_path):
                continue

            with open(txt_path, 'r') as txt_file:
                captions = [caption.strip() for caption in txt_file.read().split(',')]

            # Remove the specified tags from captions
            captions = [caption for caption in captions if caption.strip() not in tags_to_remove]

            with open(txt_path, 'w') as txt_file:
                txt_file.write(', '.join(captions))

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
        self.update_preview_clear()

        self.captions_io.setText("")

    def remove_item(self, label):
        was_selected = False
        if self.current_label == label:
            was_selected = True

        # Remember the index of the item to be removed
        removed_index = self.images.index(label)
        next_index = min(removed_index, len(self.images) - 2)  # Make sure the index is in range

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

        # If there's any image left, select the one that was next to the removed one
        if self.images:
            self.on_image_clicked(self.images[next_index])


    def ensure_txt_file_exists(self, txt_path):
        if not os.path.exists(txt_path):
            with open(txt_path, 'w') as txt_file:
                pass  # Create an empty txt file if it doesn't exist

    def update_preview_clear(self):
        self.resize_timer.stop()
        self.last_preview = None
        self.preview_label.setPixmap(QPixmap())

    def  reserved_for_preview_size(self) -> QPoint:
        window_size = self.size()
        return QPoint(int(window_size.width() // 3), int(window_size.height() - 20))

    def update_preview_image_size(self, pixmap) -> QPixmap:
        reserved_for_preview = self.reserved_for_preview_size()

        preview_aspect_ratio = reserved_for_preview.x() / reserved_for_preview.y()
        height = pixmap.height()
        width = pixmap.width()
        if ( height == 0) or ( width == 0):
            print(f"Warning: Image {self.current_label.path} has a wrong size: ({height}x{width}). Cannot calculate aspect ratio.")
            return pixmap

        image_aspect_ratio = pixmap.width() / pixmap.height()


        if image_aspect_ratio > preview_aspect_ratio:
            # Image is wider compared to the preview area, so scale based on width
            new_width = reserved_for_preview.x()
            new_height = int(new_width / image_aspect_ratio)
        else:
            # Image is taller compared to the preview area, so scale based on height
            new_height = reserved_for_preview.y()
            new_width = int(new_height * image_aspect_ratio)

        return pixmap.scaledToHeight(int(new_height), Qt.SmoothTransformation)  # self.preview_label.height()

    def update_preview_with_image_resize(self, label):
        pixmap = image_basic.load_image_with_exif(label.path)

        # pixmap = self.last_preview.pixmap().scaled(self.preview_label.size(), aspectRatioMode=Qt.KeepAspectRatio,
        #                                            transformMode=Qt.SmoothTransformation)
        # pixmap = pixmap.scaledToHeight(self.preview_label.height(), Qt.SmoothTransformation)
        self.last_preview = label

        pixmap = self.update_preview_image_size(pixmap)

        self.preview_label.setPixmap(pixmap)

    def update_preview_simple(self):
        if (None != self.last_preview) and (None != self.last_preview.pixmap()):
            pixmap = self.last_preview.pixmap().scaled(self.preview_label.size(), aspectRatioMode=Qt.KeepAspectRatio,
                                                       transformMode=Qt.SmoothTransformation)
            # pixmap = pixmap.scaledToHeight(int(self.preview_label.height()), Qt.SmoothTransformation)

            pixmap = self.update_preview_image_size(pixmap)

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
        for i, img in enumerate(self.images):
            if img == label:
                img.set_selected_frame_color()
                self.current_image_index = i  # update current image index
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


class image_basic():
    def load_image_with_exif(path):
        try:
            # Open the image file with PIL and get the EXIF data
            image = Image.open(path)
        except (FileNotFoundError, UnidentifiedImageError):
            print(f"Failed to open the image file at {path}.")
            return QPixmap()

        exif = image._getexif()
        if not exif:
            print(f"No EXIF data found for the image at {path}.")
            # You could return a default QPixmap here if you want
            return QPixmap()

        # Get the orientation tag (if it exists)
        orientation = exif.get(0x0112)

        # Rotate or flip the image based on the orientation
        try:
            if orientation == 2:
                # Flipped horizontally
                image = image.transpose(Image.FLIP_LEFT_RIGHT)
            elif orientation == 3:
                # Rotated 180 degrees
                image = image.rotate(180)
            elif orientation == 4:
                # Flipped vertically
                image = image.transpose(Image.FLIP_TOP_BOTTOM)
            elif orientation == 5:
                # Flipped along the left-top to right-bottom axis
                image = image.transpose(Image.FLIP_LEFT_RIGHT).rotate(270)
            elif orientation == 6:
                # Rotated 90 degrees
                image = image.rotate(270)
            elif orientation == 7:
                # Flipped along the left-bottom to right-top axis
                image = image.transpose(Image.FLIP_LEFT_RIGHT).rotate(90)
            elif orientation == 8:
                # Rotated 270 degrees
                image = image.rotate(90)
        except ValueError:
            print(f"Invalid EXIF orientation value {orientation} for the image at {path}.")
            # You could return a default QPixmap here if you want
            return QPixmap()

        # Convert the PIL image to QPixmap
        data = image.tobytes("raw", "RGBA")
        qimage = QImage(data, image.size[0], image.size[1], QImage.Format_RGBA8888)
        pixmap = QPixmap.fromImage(qimage)

        return pixmap

class MainWindow(QMainWindow):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.image_drop_widget = ImageDropWidget(self)
        self.setCentralWidget(self.image_drop_widget)

        # Create menu bar
        self.menu_bar = QMenuBar(self)
        self.setMenuBar(self.menu_bar)

        # Create menu
        self.file_menu = QMenu("File", self)
        self.menu_bar.addMenu(self.file_menu)

        # Create menu item
        self.add_list_action = QAction("Add List", self)
        self.file_menu.addAction(self.add_list_action)
        self.add_list_action.triggered.connect(self.open_list_input_dialog)

    def open_list_input_dialog(self):
        self.input_dialog = ListInputDialog(self)
        self.input_dialog.exec_()

    def process_list_input(self, text):
        lines = text.split("\n")
        paths = []
        for line in lines:
            path = line.split(':')[0].strip()
            # Processing the path and checking if it is a txt or image
            if os.path.isfile(path):
                if path.lower().endswith('.txt'):
                    # Check if there is a corresponding image file
                    dir_path, file_name = os.path.split(path)
                    base_name, _ = os.path.splitext(file_name)
                    for img_ext in ['jpg', 'jpeg', 'png', 'bmp', 'tiff', 'gif']:
                        img_path = os.path.join(dir_path, base_name + '.' + img_ext)
                        if os.path.isfile(img_path):
                            paths.append(img_path)
                            break
                elif path.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.gif')):
                    paths.append(path)

        # Now, `paths` contains all the image paths that need to be added to the preview area
        # You will need to handle the addition of images to the preview area.
        # For example:
        self.image_drop_widget.add_images_to_preview_area(paths)


if __name__ == '__main__':
    app = QApplication(sys.argv)
    main_window = MainWindow()
    main_window.show()
    sys.exit(app.exec_())
