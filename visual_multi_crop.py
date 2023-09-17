import argparse
import os
import sys
from PyQt5.QtWidgets import (QApplication, QWidget, QLabel, QGridLayout, QVBoxLayout, QHBoxLayout,
                             QLineEdit, QPushButton, QSpinBox, QGraphicsDropShadowEffect, QFrame, QTextEdit,
                             QScrollArea, QMessageBox, QSizePolicy, QAbstractItemView, QListView, QAbstractScrollArea,
                             QStyledItemDelegate, QCheckBox)
from PyQt5.QtGui import QPixmap, QColor, QIcon, QPalette, QTransform, QImage, QTextCharFormat, QTextCursor, QDrag, \
    QBrush, QCursor, QPainter
from PyQt5.QtCore import Qt, QSize, QPoint, QTimer, QRegularExpression, QRect
from PyQt5.QtWidgets import QMainWindow, QAction, QMenu, QMenuBar, QDialog
from PyQt5.QtWidgets import QListWidget, QListWidgetItem
from PIL import Image, UnidentifiedImageError
import piexif
import json
from PyQt5.QtWidgets import QFileDialog

class ItemDelegate(QStyledItemDelegate):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.parent = parent

    def paint(self, painter, option, index):
        enabled = self.parent.tag_states.get(index.row(), False)  # Return False if key does not exist
        if enabled:
            painter.fillRect(option.rect, QColor('lime'))
        else:
            painter.fillRect(option.rect, QColor('grey'))

        super().paint(painter, option, index)


class ImageLabel(QLabel):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.path = None
        self.setFrameShape(QFrame.Panel)
        self.setLineWidth(3)
        self.__set_default_frame_color()
        self.__is_selected = False
        self.__is_highlighted = False

    def __set_default_frame_color(self):
        # Set the default frame color to the background color
        palette = self.palette()
        palette.setColor(QPalette.WindowText, palette.color(QPalette.Background))
        self.setPalette(palette)

    def __set_selected_frame_color(self):
        # Set the frame color to red
        palette = self.palette()
        palette.setColor(QPalette.WindowText, QColor(Qt.red))
        self.setPalette(palette)

    def __set_highlighted_frame_color(self):
        # Set the frame color to yellow
        palette = self.palette()
        palette.setColor(QPalette.WindowText, QColor(Qt.yellow))
        self.setPalette(palette)

    def set_selected(self, is_selected):
        if self.__is_selected != is_selected:
            self.__is_selected = is_selected

            if self.__is_selected:
                self.__set_selected_frame_color()
            else:
                if self.__is_highlighted:
                    self.__set_highlighted_frame_color()
                else:
                    self.__set_default_frame_color()


    def set_highlighted(self, is_highlighted):
        if self.__is_highlighted != is_highlighted:
            self.__is_highlighted = is_highlighted

            if self.__is_highlighted:
                if not self.__is_selected:
                    self.__set_highlighted_frame_color()
            else:
                if not self.__is_selected:
                    self.__set_default_frame_color()


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


class OverlayLabel(QLabel):
    def __init__(self, main_window, parent=None):
        super(OverlayLabel, self).__init__(parent)
        self.main_window = main_window
        self.start_position = None
        self.dragging = False
        self.resizing = False
        # To remove the white background:
        self.setWindowFlags(Qt.FramelessWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground)

    def mousePressEvent(self, event):
        # If Right Button is pressed, initiate resizing
        if event.button() == Qt.RightButton:
            self.resizing = True
            self.setCursor(QCursor(Qt.SizeFDiagCursor))
        else:
            self.dragging = True
        self.start_position = event.pos()

    def mouseMoveEvent(self, event):
        scaling_factor = 0.1  # Adjust this value to change the resizing speed
        if self.dragging:
            self.move(self.pos() + event.pos() - self.start_position)
        elif self.resizing:
            dx = (event.pos().x() - self.start_position.x()) * scaling_factor
            dy = (event.pos().y() - self.start_position.y()) * scaling_factor
            new_width = int(self.width() + dx)  # Convert to int
            new_height = int(self.height() + dy)  # Convert to int

            # Scale the ORIGINAL overlay pixmap to the new size
            scaled_pixmap = self.main_window.original_overlay_pixmap.scaled(new_width, new_height, Qt.KeepAspectRatio, Qt.FastTransformation)


            self.setPixmap(scaled_pixmap)
            self.resize(scaled_pixmap.size())

    def mouseReleaseEvent(self, event):
        self.dragging = False
        self.resizing = False
        self.setCursor(QCursor(Qt.ArrowCursor))
        if event.button() == Qt.MiddleButton:  # Reset to initial size on middle mouse button click
            self.reset_to_initial_size()

    def reset_to_initial_size(self):
        initial_size = QSize(100, 100)  # You can adjust this to your preferred initial size
        self.resize(initial_size)
        self.setPixmap(self.pixmap().scaled(initial_size, Qt.KeepAspectRatio, Qt.SmoothTransformation))

    def keyPressEvent(self, event):
        if event.key() == Qt.Key_Delete:  # Delete the overlay on pressing the 'Del' key
            self.deleteLater()


class ImageDropWidget(QWidget):
    def __init__(self, args, parent=None):
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
        self.preview_label.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Expanding)
        self.preview_label.setAlignment(Qt.AlignTop | Qt.AlignHCenter)

        self.preview_layout.addWidget(self.preview_label, stretch=2)

        self.images = []
        self.resize(self.min_width, self.min_height)
        self.setMinimumSize(self.min_width, self.min_height)

        # self.adjust_text_height()

        # Existing variables for overlay image path and pixmap
        self.overlay_image_path = None
        self.overlay_image_pixmap = None

        # Initialize the vertical layout for buttons
        self.overlay_buttons_layout = QVBoxLayout()


        self.crop_current = QPushButton("Crop", self)
        #self.crop_current.clicked.connect(self.do1)
        self.overlay_buttons_layout.addWidget(self.crop_current)

        self.crop_all = QPushButton("Crop All", self)
        #self.crop_all.clicked.connect(self.do1)
        self.overlay_buttons_layout.addWidget(self.crop_all)

        self.overlay_buttons_layout.setAlignment(Qt.AlignRight)


        self.overlay_ui_layout = QHBoxLayout()

        self.overlay_ui_layout.addLayout(self.overlay_buttons_layout)

        # Add the horizontal layout to the main preview layout
        self.preview_layout.addLayout(self.overlay_ui_layout)

        self.base_image_pixmap = None

    change_counter = 0

    def load_args(self, args):
        self.args = args
        self.load_settings(self.args.configurations_file)

    def clossing_app(self):
        self.save_settings(self.args.configurations_file)

    def save_settings(self, filepath):

        data = {
            "add_labels_on_load": False, #self.add_labels_checkbox.isChecked(),
            "sync_labels": False,#self.sync_labels_checkbox.isChecked(),
            "labels": False,#self.labels_list_widget.get_labels()
        }
        with open(filepath, 'w') as file:
            json.dump(data, file)

    def load_settings(self, filepath):
        try:
            if os.path.exists(filepath):
                with open(filepath, 'r') as file:
                    data = json.load(file)
                self.labels_list_widget.set_labels(data.get("labels", []))
                #self.add_labels_checkbox.setChecked(data.get("add_labels_on_load", False))
                self.sync_labels_checkbox.setChecked(data.get("sync_labels", False))
            else:
                print(f"File '{filepath}' does not exist. Could not load labels.")
        except Exception as e:
            print(f"Loading file '{filepath}' error: {e}.")

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
            self.process_image(path)


    def dropEvent(self, event):
        print(f"dropEvent, urls len: {len(event.mimeData().urls())}")
        for url in event.mimeData().urls():
            path = url.toLocalFile()

            # If the path is a directory, iterate through all files in the directory
            if os.path.isdir(path):
                for root, dirs, files in os.walk(path):
                    for file in files:
                        if file.endswith('.jpg') or file.endswith('.jpeg') or file.endswith('.png'):
                            full_path = os.path.join(root, file)
                            self.process_image(full_path)
            # If the path is a file, process the file directly
            elif os.path.isfile(path) and (path.endswith('.jpg') or path.endswith('.jpeg')  or path.endswith('.png')):
                self.process_image(path)
            else:
                event.ignore()

    def process_image(self, path):
        if path not in [label.path for label in self.images]:
            if path.endswith('.jpg') or path.endswith('.jpeg')  or path.endswith('.png'):
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

        # Clear and reset frame color if the removed label was currently selected
        if was_selected:
            self.update_preview_clear()

            for img in self.images:
                img.set_selected(False)

        # If there's any image left, select the one that was next to the removed one
        if self.images:
            self.on_image_clicked(self.images[next_index])


    def update_preview_clear(self):
        self.resize_timer.stop()
        self.last_preview = None
        self.preview_label.setPixmap(QPixmap())

    def  reserved_for_preview_size(self) -> QPoint:
        window_size = self.size()
        return QPoint(int(window_size.width() // 3), int(window_size.height() - 150))

    def update_preview_image_size(self, pixmap) -> QPixmap:
        reserved_for_preview = self.reserved_for_preview_size()

        preview_aspect_ratio = reserved_for_preview.x() / reserved_for_preview.y()
        height = pixmap.height()
        width = pixmap.width()
        if (height == 0) or (width == 0):
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

        self.base_image_pixmap = pixmap
        self.preview_label.setPixmap(pixmap)

    def update_preview_simple(self):
        if (None != self.last_preview) and (None != self.last_preview.pixmap()):
            pixmap = self.last_preview.pixmap().scaled(self.preview_label.size(), aspectRatioMode=Qt.KeepAspectRatio,
                                                       transformMode=Qt.SmoothTransformation)
            # pixmap = pixmap.scaledToHeight(int(self.preview_label.height()), Qt.SmoothTransformation)

            pixmap = self.update_preview_image_size(pixmap)
            self.base_image_pixmap = pixmap

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

        self.current_label = label
        for i, img in enumerate(self.images):
            is_current_selected = img == label
            img.set_selected(is_current_selected)

            if is_current_selected:
                self.current_image_index = i  # update current image index


        self.update_preview_with_image_resize(label)



class image_basic():

    skip_rotation = False
    def load_image_with_exif(path):

        skip_rotation = False
        try:
            # Open the image file with PIL and get the EXIF data
            image = Image.open(path)
        except (FileNotFoundError, UnidentifiedImageError):
            print(f"Failed to open the image file at {path}.")
            return QPixmap()

        exif = image._getexif()
        if not exif:
            #print(f"No EXIF data found for the image at {path}.")
            # You could return a default QPixmap here if you want
            #return QPixmap()
            skip_rotation = True

        if False == skip_rotation:
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
                #print(f"Invalid EXIF orientation value {orientation} for the image at {path}.")
                # You could return a default QPixmap here if you want
                #return QPixmap()
                skip_rotation = True

        # Convert the PIL image to QPixmap
        data = image.tobytes("raw", "RGBA")
        qimage = QImage(data, image.size[0], image.size[1], QImage.Format_RGBA8888)
        pixmap = QPixmap.fromImage(qimage)

        return pixmap


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

    def load_args(self, args):
        self.image_drop_widget.load_args(args)

    def closeEvent(self, event):
        self.image_drop_widget.clossing_app()
        event.accept()  # let the window close

if __name__ == '__main__':
    # Create the command-line argument parser
    parser = argparse.ArgumentParser(description='Custom widget with labels.')
    parser.add_argument('--configurations_file', type=str, default="configuration_settings.json", help='Path to the JSON file with label configurations.')
    # Parse the arguments
    args = parser.parse_args()

    app = QApplication(sys.argv)
    main_window = MainWindow()
    main_window.load_args(args)
    main_window.show()
    sys.exit(app.exec_())
