import argparse
import os
import sys
from PyQt6.QtWidgets import (QApplication, QWidget, QLabel, QGridLayout, QVBoxLayout, QHBoxLayout,
                             QLineEdit, QPushButton, QSpinBox, QFrame, QTextEdit,
                             QScrollArea, QMessageBox, QSizePolicy, QAbstractItemView, QListView,
                             QStyledItemDelegate, QCheckBox)
from PyQt6.QtGui import QPixmap, QColor, QPalette, QAction, QImage, QTextCharFormat, QTextCursor, QDrag
from PyQt6.QtCore import Qt, QSize, QPoint, QTimer, QRegularExpression, pyqtSignal
from PyQt6.QtWidgets import QMainWindow, QMenu, QMenuBar, QDialog, QListWidget, QListWidgetItem
from PIL import Image, UnidentifiedImageError, ImageOps, ImageFile
import piexif
import json
import re

DEBUG = False

class ItemDelegate(QStyledItemDelegate):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.owner = parent

    def paint(self, painter, option, index):
        enabled = self.owner.tag_states.get(index.row(), False)  # Return False if key does not exist
        if enabled:
            painter.fillRect(option.rect, QColor('lime'))
        else:
            painter.fillRect(option.rect, QColor('grey'))

        super().paint(painter, option, index)

class CustomListWidget(QListWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setDragEnabled(True)
        self.setAcceptDrops(True)
        self.setDropIndicatorShown(True)
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setDragDropMode(QAbstractItemView.DragDropMode.InternalMove)
        self.setViewMode(QListView.ViewMode.IconMode)
        self.setResizeMode(QListView.ResizeMode.Adjust)
        self.setFlow(QListView.Flow.LeftToRight)
        self.setWrapping(True)
        self.setSizePolicy(QSizePolicy.Policy.MinimumExpanding, QSizePolicy.Policy.MinimumExpanding)
        #self.setFixedSize(400, 300)
        #self.setLayoutMode(QListView.Flow)
        self.setStyleSheet("""
        QListWidget::item {
            border-radius: 10px; 
            min-width: 50px; 
            min-height: 25px;
        }
        QListWidget::item:selected {
            color: yellow;
        }
        """)
        self.spacing = 4
        self.setSpacing(self.spacing)

        # constrain height to about one row
        row_h = self.fontMetrics().height() + 10  # text height + padding
        self.setMaximumHeight(2 * row_h + self.spacing * 3 + 2)

        # scrollbars if overflow
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)

        self.setToolTip("Left click to toggle enable/disable.\n"
                        "Middle click to delete.\n"
                        "Right click to add new.\n"
                        "Double click to edit.\n")
        self.tag_states = {}

        self.itemChanged.connect(self.handleItemChanged)
        self.spacing = 3
        self.setSpacing(self.spacing)  # Added padding between labels
        self.setItemDelegate(ItemDelegate(self))
        self.setLayoutMode(QListView.LayoutMode.SinglePass)  # Update layout mode to fix drag issue

        self.changed_callback = None
        self.tags_counter = 0


    def changed_add_callback(self, changed_callback_new):
        if DEBUG:
            print("changed")
        self.changed_callback = changed_callback_new



    def dropEvent(self, event):
        if event.source() == self:
            # Get the original source index and item
            source_item = self.currentItem()
            source_index = self.row(source_item)
            source_status = self.tag_states.get(source_index, False)

            # Calculate the target index
            pos = event.pos()
            target_index = self.drop_on(pos)
            if DEBUG:
                print(f"Target Index: {target_index}")  # Debugging print statement

            # Handle the items
            self.blockSignals(True)
            if target_index > source_index and target_index != self.count() - 1:  # dragged down, adjust target_index after remove
                target_index -= 1

            # Remove the original item from the list
            removed_item = self.takeItem(source_index)
            self.insertItem(target_index, removed_item)
            self.blockSignals(False)

            # Update the status for the moved item
            self.tag_states.pop(source_index, None)
            self.tag_states[target_index] = source_status

            # Update the rest of the tag states
            tag_states = {i: state for i, state in enumerate(self.tag_states.values())}
            self.tag_states = tag_states


        # super().dropEvent(event)
        self.clearSelection()  # Clear selection after drag and drop

    def drop_on(self, pos):
        """
        Determine the index of the item that is under the cursor.
        """
        for i in range(self.count() - 1):  # we exclude the last item because it has no next item
            current_item = self.item(i)
            next_item = self.item(i + 1)

            current_item_left = self.visualItemRect(current_item).left()
            next_item_left = self.visualItemRect(next_item).left()

            center_pos = (current_item_left + next_item_left) // 2

            if pos.x() < center_pos:
                return i

        # Special case for the last item
        last_item = self.item(self.count() - 1)
        last_item_left = self.visualItemRect(last_item).left()
        last_item_right = self.visualItemRect(last_item).right()
        last_item_center = (last_item_left + last_item_right) // 2

        if pos.x() < last_item_center:
            return self.count() - 2
        else:
            return self.count() - 1


    def handleItemChanged(self, item):
        # Estimate the size of the item based on the length of the text
        width = len(item.text()) * 7
        height = item.sizeHint().height()
        item.setSizeHint(QSize(width, height))

        # update tag states if the item text was changed
        item_row = self.row(item)
        if item_row in self.tag_states:
            self.tag_states[item_row] = self.tag_states.pop(item_row)

        # Rearrange the items to respect the new size
        self.doItemsLayout()

        if self.changed_callback:
            self.changed_callback()


    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            item = self.itemAt(event.pos())
            if item:
                self.editItem(item)
        else:
            super().mouseDoubleClickEvent(event)

    def mousePressEvent(self, event):
        changed = False

        if event.button() == Qt.MouseButton.MiddleButton: # Item delete
            item = self.itemAt(event.pos())
            if item:
                row = self.row(item)
                self.takeItem(row)
                if row in self.tag_states:
                    del self.tag_states[row]

            changed = True

        elif event.button() == Qt.MouseButton.RightButton: # Add new at end
            item = QListWidgetItem(f"Edit me #{self.tags_counter:03d}")
            self.tags_counter += 1
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsEditable)
            self.addItem(item)
            self.tag_states[self.row(item)] = False
            changed = True

        elif event.button() == Qt.MouseButton.LeftButton: # Toggle enabled
            item = self.itemAt(event.pos())
            if item:
                row = self.row(item)
                self.tag_states[row] = not self.tag_states.get(row, False)

            changed = True

        if changed:
            if self.changed_callback:
                self.changed_callback()

        super().mousePressEvent(event)

    def keyPressEvent(self, event):
        if event.key() in [Qt.Key.Key_Backspace, Qt.Key.Key_Delete]:
            for item in self.selectedItems():
                row = self.row(item)
                self.takeItem(row)
                if row in self.tag_states:
                    del self.tag_states[row]

    def startEditMode(self, pos):
        item = self.itemAt(pos)
        if item and not item.isSelected():
            self.editItem(item)

    def startDrag(self, supportedActions):
        drag = QDrag(self)
        mimeData = self.mimeData(self.selectedItems())
        drag.setMimeData(mimeData)
        result = drag.exec(supportedActions)

    def get_labels(self):
        labels = []
        for i in range(self.count()):
            item = self.item(i)
            enabled = self.tag_states.get(i, False)  # returns False if key doesn't exist
            labels.append((item.text(), enabled))
        return labels

    def set_labels(self, labels):
        self.clear()
        self.tag_states.clear()
        for i, (label, enabled) in enumerate(labels):
            item = QListWidgetItem(label)
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsEditable)
            self.addItem(item)
            self.tag_states[i] = enabled

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
        self.parent().process_list_input(self.text_box.toPlainText())
        self.accept()


class ImageLabel(QLabel):
    clicked = pyqtSignal(object)
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.path = None
        self.setFrameShape(QFrame.Shape.Panel)
        self.setLineWidth(3)
        self.__set_default_frame_color()
        self.__is_selected = False
        self.__is_highlighted = False

    def __palette_roles(self):
        # Works on PyQt6 now and PyQt6 later
        window = getattr(QPalette, "Window", getattr(QPalette.ColorRole, "Window"))
        window_text = getattr(QPalette, "WindowText", getattr(QPalette.ColorRole, "WindowText"))
        return window, window_text

    def __set_default_frame_color(self):
        palette = self.palette()
        window, window_text = self.__palette_roles()
        palette.setColor(window_text, palette.color(window))
        self.setPalette(palette)

    def __set_selected_frame_color(self):
        # Set the frame color to red
        palette = self.palette()
        _, window_text = self.__palette_roles()
        palette.setColor(window_text, QColor("red"))
        self.setPalette(palette)

    def __set_highlighted_frame_color(self):
        # Set the frame color to yellow
        palette = self.palette()
        _, window_text = self.__palette_roles()
        palette.setColor(window_text, QColor("yellow"))
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
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self)
        elif event.button() == Qt.MouseButton.RightButton:
            clipboard = QApplication.clipboard()
            if self.pixmap():
                clipboard.setPixmap(self.pixmap())
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
    def __init__(self, args, parent=None):
        super().__init__(parent)

        self.change_counter = 0
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
        self.grid_layout.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)

        # Grid Widget
        self.grid_widget = QWidget()
        self.grid_widget.setLayout(self.grid_layout)

        # Scroll Area
        self.scroll_area = QScrollArea(self)
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setWidget(self.grid_widget)
        self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)

        self.main_layout.addWidget(self.scroll_area, stretch=10)

        # Bottom layout
        self.bottom_layout = QHBoxLayout()
        self.bottom_layout.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignLeft)
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

        # Bottom layout for Labels
        self.bottom_layout_labels = QHBoxLayout()
        self.bottom_layout_labels.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignLeft)
        self.main_layout.addLayout(self.bottom_layout_labels)

        self.labels_labels = QLabel("Labels:", self)
        self.bottom_layout_labels.addWidget(self.labels_labels)

        # self.layout = QVBoxLayout(self)
        self.labels_list_widget = CustomListWidget(self)
        self.bottom_layout_labels.addWidget(self.labels_list_widget)

        self.checkboxes_layout = QVBoxLayout()
        self.checkboxes_layout.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        self.bottom_layout_labels.addLayout(self.checkboxes_layout)

        self.add_labels_checkbox = QCheckBox("Add labels on load", self)
        self.checkboxes_layout.addWidget(self.add_labels_checkbox)
        self.add_labels_checkbox.stateChanged.connect(self.add_labels_checkbox_changed)

        self.sync_labels_checkbox = QCheckBox("Sync labels", self)
        self.checkboxes_layout.addWidget(self.sync_labels_checkbox)
        self.sync_labels_checkbox.stateChanged.connect(self.sync_labels_checkbox_changed)

        self.sync_labels_changes_checkbox = QCheckBox("Sync labels changes", self)
        self.checkboxes_layout.addWidget(self.sync_labels_changes_checkbox)
        #self.sync_labels_changes_checkbox.stateChanged.connect(self.sync_labels_checkbox_changes_changed)

        self.labels_list_widget.changed_add_callback(self.labels_changed_callback)


        # Horizontal line
        self.line = QFrame(self)
        self.line.setFrameShape(QFrame.Shape.HLine)
        self.line.setFrameShadow(QFrame.Shadow.Sunken)
        self.main_layout.addWidget(self.line)

        # Bottom layout for remove
        self.bottom_layout_remove = QHBoxLayout()
        self.bottom_layout_remove.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignLeft)
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
        self.line.setFrameShape(QFrame.Shape.HLine)
        self.line.setFrameShadow(QFrame.Shadow.Sunken)
        self.main_layout.addWidget(self.line)

        # Bottom layout for search and replace
        self.search_and_replace_layout = QHBoxLayout()
        self.search_and_replace_layout.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignLeft)
        self.main_layout.addLayout(self.search_and_replace_layout)

        # Search field label
        self.search_and_replace_search_label = QLabel("Search:", self)
        self.search_and_replace_layout.addWidget(self.search_and_replace_search_label)

        # Search text input
        self.search_and_replace_search_input = QLineEdit(self)
        self.search_and_replace_search_input.setPlaceholderText("Enter text to search")
        self.search_and_replace_layout.addWidget(self.search_and_replace_search_input)

        # Replace field label
        self.search_and_replace_replace_label = QLabel("Replace:", self)
        self.search_and_replace_layout.addWidget(self.search_and_replace_replace_label)

        # Replace text input
        self.search_and_replace_replace_input = QLineEdit(self)
        self.search_and_replace_replace_input.setPlaceholderText("Enter replacement text")
        self.search_and_replace_layout.addWidget(self.search_and_replace_replace_input)

        self.search_and_replace_all_text = QCheckBox("All text", self)
        self.search_and_replace_layout.addWidget(self.search_and_replace_all_text)
        #self.search_and_replace_all_text.stateChanged.connect(self.search_and_replace_all_text_checkbox_changed)

        self.search_and_replace_use_re = QCheckBox("RE", self)
        self.search_and_replace_layout.addWidget(self.search_and_replace_use_re)

        # Search and Replace button
        self.search_and_replace_button = QPushButton("Search and Replace", self)
        self.search_and_replace_layout.addWidget(self.search_and_replace_button)
        self.search_and_replace_button.clicked.connect(
            self.search_and_replace)  # Connect the button to the search_and_replace method


        # Horizontal line
        self.line = QFrame(self)
        self.line.setFrameShape(QFrame.Shape.HLine)
        self.line.setFrameShadow(QFrame.Shadow.Sunken)
        self.main_layout.addWidget(self.line)

        # Captions layout
        self.captions_layout = QHBoxLayout()
        self.captions_layout.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignLeft)
        self.main_layout.addLayout(self.captions_layout)

        # Add captions text input/output

        self.caption_label = QLabel("Caption:", self)
        self.captions_layout.addWidget(self.caption_label)

        self.captions_io = QTextEdit(self)
        self.captions_io.setPlaceholderText("Select image to edit captions")
        self.captions_io.setLineWrapMode(QTextEdit.LineWrapMode.WidgetWidth)
        self.captions_io.textChanged.connect(self.adjust_text_height)
        self.captions_layout.addWidget(self.captions_io)

        self.current_label = None
        self.captions_io.textChanged.connect(self.on_captions_io_text_changed)

        self.save_captions_button = QPushButton("Save caption", self)
        self.captions_layout.addWidget(self.save_captions_button)

        self.save_captions_button.clicked.connect(self.save_captions)


        # Search layout
        self.search_layout = QHBoxLayout()
        self.search_layout.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignLeft)
        self.main_layout.addLayout(self.search_layout)

        # Add search label
        self.search_label = QLabel("Search in caption:", self)
        self.search_layout.addWidget(self.search_label)

        # Add search input
        self.search_input = QLineEdit(self)
        self.search_input.setPlaceholderText("Enter search text")
        self.search_layout.addWidget(self.search_input)

        self.captions_io.textChanged.connect(self.highlight_search_results)
        self.search_input.textChanged.connect(self.highlight_search_results)

        self.clear_search_button = QPushButton("Clear search", self)
        self.search_layout.addWidget(self.clear_search_button)

        self.clear_search_button.clicked.connect(self.clear_search)

        self.image_captions = {}

        # Search in all caption, indicate with yellow grid
        # Search all layout
        self.search_all_layout = QHBoxLayout()
        self.search_all_layout.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignLeft)
        self.main_layout.addLayout(self.search_all_layout)

        # Add search all label
        self.search_all_label = QLabel("Search in all captions:", self)
        self.search_all_layout.addWidget(self.search_all_label)

        # Add search all input
        self.search_all_input = QLineEdit(self)
        self.search_all_input.setPlaceholderText("Enter search all text")
        self.search_all_layout.addWidget(self.search_all_input)

        self.search_all_now_button = QPushButton("Search all now", self)
        self.search_all_layout.addWidget(self.search_all_now_button)
        self.search_all_now_button.clicked.connect(self.search_all_now)

        self.clear_search_all_button = QPushButton("Clear all search", self)
        self.search_all_layout.addWidget(self.clear_search_all_button)
        self.clear_search_all_button.clicked.connect(self.search_all_clear_search)


        # Horizontal line
        self.line = QFrame(self)
        self.line.setFrameShape(QFrame.Shape.HLine)
        self.line.setFrameShadow(QFrame.Shadow.Sunken)
        self.main_layout.addWidget(self.line)

        # Clear Images
        self.clear_button = QPushButton("Clear Images", self)
        self.clear_button.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
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
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setMinimumSize(int(self.min_width // 3), int(self.min_height - 20))
        self.preview_label.setFrameShape(QFrame.Shape.Box)
        self.preview_label.setFrameShadow(QFrame.Shadow.Sunken)
        self.preview_layout.addWidget(self.preview_label, stretch=2)

        self.images = []
        self.resize(self.min_width, self.min_height)
        self.setMinimumSize(self.min_width, self.min_height)

        self.adjust_text_height()


    def add_labels_checkbox_changed(self):
        if self.add_labels_checkbox.isChecked():
            #print("add_labels_checkbox_changed")
            self.sync_labels_on_change()

    # def search_and_replace_all_text_checkbox_changed(self):
    #     if self.search_and_replace_all_text.isChecked():
    #         # print("search_and_replace_all_text_checkbox_changed")
    #         None

    def sync_labels_checkbox_changed(self):
        if self.sync_labels_checkbox.isChecked():
            #print("sync_labels_checkbox_changed")
            self.sync_labels_on_change()

    def sync_labels_checkbox_changes_changed(self):
        if self.sync_labels_changes_checkbox.isChecked():
            #print("sync_labels_checkbox_changed")
            self.sync_labels_on_change()


    def labels_changed_callback(self):
        if DEBUG:
            print(f"labels_changed_callback, {self.change_counter}")
        self.change_counter += 1

        if self.sync_labels_checkbox.isChecked():
            if DEBUG:
                print("sync_labels_checkbox_changed")
            self.sync_labels_on_change()

        else:
            if self.sync_labels_changes_checkbox.isChecked():
                self.sync_labels_on_change(only_changes=True)


    def sync_labels_on_change(self, only_changes:bool = False):
        # When label toggled
        # When loading image
        label_and_state = self.labels_list_widget.get_labels()

        enabled_tags = []
        disabled_tags = []

        for (label, status) in label_and_state:
            if DEBUG:
                print(f"{label}, {status}")
            tags = self.caption_to_tag_list(label)

            is_add = (False == only_changes) or \
                     (status and (label in self.disabled_tags_last)) or \
                     (not status and (label in self.enabled_tags_last)) or \
                     (not (label in self.enabled_tags_last) and not (label in self.disabled_tags_last))

            if is_add:
                if status:
                    enabled_tags.extend(tags)
                else:
                    disabled_tags.extend(tags)

        self.enabled_tags_last = [item for item in self.enabled_tags_last if item not in disabled_tags]
        self.enabled_tags_last.extend(enabled_tags)

        self.disabled_tags_last = [item for item in self.disabled_tags_last if item not in enabled_tags]
        self.disabled_tags_last.extend(disabled_tags)

        comma_place_desired = 0

        if (enabled_tags != []) or (disabled_tags != []):
            for label in self.images:
                path = label.path
                if (enabled_tags != []):
                    self.add_captions_to_path(enabled_tags, comma_place_desired, path)

                if (disabled_tags != []):
                    self.remove_captions_from_path(disabled_tags, path)

    def load_args(self, args):
        self.args = args
        self.load_settings(self.args.configurations_file)

    def closing_app(self):
        self.save_settings(self.args.configurations_file)

    def save_settings(self, filepath):

        data = {
            "add_labels_on_load": self.add_labels_checkbox.isChecked(),
            "sync_labels": self.sync_labels_checkbox.isChecked(),
            "sync_labels_changes": self.sync_labels_changes_checkbox.isChecked(),
            "labels": self.labels_list_widget.get_labels()
        }
        with open(filepath, 'w') as file:
            json.dump(data, file)

    def init_last_labels(self, labels_info):
        self.enabled_tags_last = []
        self.disabled_tags_last = []

        for i, (label, enabled) in enumerate(labels_info):
            if enabled:
                self.enabled_tags_last.append(label)
            else:
                self.disabled_tags_last.append(label)

    def load_settings(self, filepath):
        try:
            if os.path.exists(filepath):
                with open(filepath, 'r') as file:
                    data = json.load(file)
                labels_info = data.get("labels", [])
                self.labels_list_widget.set_labels(labels_info)
                self.init_last_labels(labels_info)
                self.add_labels_checkbox.setChecked(data.get("add_labels_on_load", False))
                self.sync_labels_checkbox.setChecked(data.get("sync_labels", False))
                self.sync_labels_changes_checkbox.setChecked(data.get("sync_labels_changes", False))
            else:
                print(f"File '{filepath}' does not exist. Could not load labels.")
        except Exception as e:
            print(f"Loading file '{filepath}' error: {e}.")

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_A:  # 'a' key for left
            self.navigate_to_previous_image()
        elif event.key() == Qt.Key.Key_D:  # 'd' key for right
            self.navigate_to_next_image()
        elif event.key() == Qt.Key.Key_W:  # 'w' key for up
            self.navigate_to_previous_row_image()
        elif event.key() == Qt.Key.Key_S:  # 's' key for down
            self.navigate_to_next_row_image()
        elif event.key() in {Qt.Key.Key_Backspace, Qt.Key.Key_Delete}:
            if self.current_label is not None:
                self.remove_item(self.current_label)
        elif event.key() == Qt.Key.Key_F:
            self.flip_current_image()


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
                pixmap = pixmap.scaled(self.grid_item_width, self.grid_item_height, aspectRatioMode=Qt.AspectRatioMode.KeepAspectRatio)

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
            self.process_image(path)
            # You could reuse the logic in dropEvent here for adding images, or create another method
            # if path.endswith('.jpg') or path.endswith('.png'):
            #     if path not in [label.path for label in self.images]:
            #         pixmap = image_basic.load_image_with_exif(path)
            #
            #         # Check and flip the QPixmap image if it's not already flipped
            #         if pixmap.transformed(QTransform().scale(-1, 1), Qt.TransformationMode.SmoothTransformation) == pixmap:
            #             pixmap = pixmap.transformed(QTransform().scale(-1, 1), Qt.TransformationMode.SmoothTransformation)
            #
            #         pixmap = pixmap.scaled(self.grid_item_width, self.grid_item_height,
            #                                aspectRatioMode=Qt.AspectRatioMode.KeepAspectRatio)
            #         label = ImageLabel(self)
            #         label.path = path
            #         label.setPixmap(pixmap)
            #
            #         # Add close button to the label
            #         close_button = QPushButton("X", label)
            #         close_button.setStyleSheet("QPushButton { color: red; }")
            #         close_button.setFlat(True)
            #         close_button.setFixedSize(QSize(16, 16))
            #         close_button.clicked.connect(lambda checked, lbl=label: self.remove_item(lbl))
            #
            #         self.images.append(label)
            #         self.update_grid_layout()
            #     else:
            #         print(f"{path} already exists in the widget!")

    supported_formats_list = ['jpg', 'jpeg', 'png', 'bmp', 'tiff', 'webp']
    def is_supported_image_format(self, file_name):

        return any(file_name.lower().endswith(ext) for ext in self.supported_formats_list)


    def dropEvent(self, event):
        if DEBUG:
            print(f"dropEvent, urls len: {len(event.mimeData().urls())}")
        for url in event.mimeData().urls():
            path = url.toLocalFile()

            # If the path is a directory, iterate through all files in the directory
            if os.path.isdir(path):
                for root, dirs, files in os.walk(path):
                    for file in files:
                        if self.is_supported_image_format(file):
                            full_path = os.path.join(root, file)
                            self.process_image(full_path)
            # If the path is a file, process the file directly
            elif os.path.isfile(path) and self.is_supported_image_format(path):
                self.process_image(path)
            else:
                event.ignore()

        event.acceptProposedAction()

    def process_image(self, path):
        if path not in [label.path for label in self.images]:
            if self.is_supported_image_format(path):
                pixmap = image_basic.load_image_with_exif(path)
                if pixmap.isNull():
                    print(f"Skipping {path}: could not load image.")
                    return  # do not proceed with UI setup for a bad image

                pixmap = pixmap.scaled(
                    self.grid_item_width, self.grid_item_height,
                    aspectRatioMode=Qt.AspectRatioMode.KeepAspectRatio
                )
                label = ImageLabel(self)
                label.clicked.connect(self.on_image_clicked)
                label.path = path
                label.setPixmap(pixmap)

                close_button = QPushButton("X", label)
                close_button.setStyleSheet("QPushButton { color: red; }")
                close_button.setFlat(True)
                close_button.setFixedSize(QSize(16, 16))
                close_button.clicked.connect(lambda checked, lbl=label: self.remove_item(lbl))

                txt_path = os.path.splitext(path)[0] + '.txt'
                self.ensure_txt_file_exists(txt_path)
                with open(txt_path, 'r') as txt_file:
                    content = txt_file.read()
                    self.image_captions[path] = content

                self.images.append(label)
                self.update_grid_layout()

            if self.add_labels_checkbox.isChecked():
                self.sync_labels_on_change()
        else:
            print(f"{path} already exists in the widget!")


    def caption_to_tag_list(self, captions: str) -> list[str]:
        tags_list = [caption.strip() for caption in captions.split(',') if caption.strip()]

        # Remove duplicates while preserving order
        tag_list = list(dict.fromkeys(tags_list))

        return tag_list

    def tag_list_to_string(self, tags_list: list[str]):
        return ', '.join(tags_list)

    def add_captions(self):
        tags_to_add_list = self.caption_to_tag_list(self.caption_input.text())
        comma_place_desired = self.comma_place_input.value()

        for label in self.images:
            path = label.path
            self.add_captions_to_path(tags_to_add_list, comma_place_desired, path)

    def add_captions_to_path(self, tags_to_add_list, comma_place_desired, path):
        txt_path = os.path.splitext(path)[0] + '.txt'
        if not os.path.exists(txt_path):
            with open(txt_path, 'w') as txt_file:
                pass  # Create an empty txt file if it doesn't exist

        tags_list = self.caption_to_tag_list(self.image_captions[path])

        tags_to_add = [tag for tag in tags_to_add_list if
                       tag not in tags_list]  # Remove tags to add from captions to avoid duplicates

        comma_place = comma_place_desired
        if comma_place > len(tags_list):
            comma_place = len(tags_list)

        for tag in reversed(tags_to_add):  # Loop over tags to add and insert each one
            tags_list.insert(comma_place, tag)

        final_captions = self.tag_list_to_string(tags_list)
        # Update the caption in the map
        self.image_captions[path] = final_captions

        with open(txt_path, 'w') as txt_file:
            txt_file.write(final_captions)

    def remove_captions(self):
        tags_to_remove = self.caption_to_tag_list(self.remove_caption_input.text())

        for label in self.images:
            path = label.path
            self.remove_captions_from_path(tags_to_remove, path)

    # Define the search_and_replace method
    def search_and_replace(self):
        search_text = self.search_and_replace_search_input.text()
        replace_text = self.search_and_replace_replace_input.text()

        search_tags = search_text.split(',')
        replace_tags = replace_text.split(',')
        is_search_all_text = self.search_and_replace_all_text.isChecked()
        is_re = self.search_and_replace_use_re.isChecked()

        # Add your search and replace logic here
        if DEBUG:
            print(f"search_and_replace, search: \"{search_text}\", replace: \"{replace_text}\".")
        for label in self.images:
            path = label.path
            self.search_and_replace_in_path(is_search_all_text, is_re, search_text, search_tags, replace_text, replace_tags, path)

    def search_and_replace_in_path(self, is_search_all_text, is_re, search_text, search_tags, replace_text,
                                   replace_tags, path):
        txt_path = os.path.splitext(path)[0] + '.txt'

        if not os.path.exists(txt_path):
            return  # Skip if no corresponding text file

        with open(txt_path, 'r') as txt_file:
            content = txt_file.read()

        if is_search_all_text:
            if is_re:
                # Use regular expressions to search and replace in the whole text
                updated_content = re.sub(search_text, replace_text, content)
            else:
                # Simple string replace in the whole text
                updated_content = content.replace(search_text, replace_text)
        else:
            # Get current tags
            tag_list = self.caption_to_tag_list(self.image_captions[path])
            search_tag_removed = False
            new_tag_list = []

            for tag in tag_list:
                if is_re:
                    # If the tag matches the search pattern, replace it
                    if re.search(search_text, tag):
                        search_tag_removed = True
                        if replace_text not in new_tag_list:  # Prevent duplicates
                            new_tag_list.append(re.sub(search_text, replace_text, tag))
                    else:
                        new_tag_list.append(tag)
                else:
                    if tag.strip() in search_tags:
                        search_tag_removed = True
                        if replace_text not in new_tag_list:  # This might need adjusting based on how you handle multiple replace_tags
                            new_tag_list.extend(replace_tags)
                    else:
                        new_tag_list.append(tag)

            updated_content = self.tag_list_to_string(new_tag_list) if search_tag_removed else content

        # Update the captions dictionary if there was a change
        if content != updated_content:
            self.image_captions[path] = updated_content
            with open(txt_path, 'w') as txt_file:
                txt_file.write(updated_content)

    def remove_captions_from_path(self, tags_to_remove, path):
        txt_path = os.path.splitext(path)[0] + '.txt'

        if not os.path.exists(txt_path):
            return

        tag_list = self.caption_to_tag_list(self.image_captions[path])

        # Remove the specified tags from captions
        tag_list = [caption for caption in tag_list if caption.strip() not in tags_to_remove]
        captions = self.tag_list_to_string(tag_list)

        self.image_captions[path] = captions

        with open(txt_path, 'w') as txt_file:
            txt_file.write(captions)

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

        self.grid_layout.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)

    def minimumSizeHint(self):
        """Override minimumSizeHint to return a minimum size of 800x400 pixels."""
        return QSize(self.min_width, self.min_height)

    def clear_all(self):
        for label in self.images:
            self.grid_layout.removeWidget(label)
            label.deleteLater()
        self.images.clear()
        self.update_preview_clear()

        self.clear_caption()
        self.image_captions.clear()

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
            self.clear_caption()
            for img in self.images:
                img.set_selected(False)

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

    def reserved_for_preview_size(self) -> QPoint:
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

        return pixmap.scaled(new_width, new_height,
                             aspectRatioMode=Qt.AspectRatioMode.KeepAspectRatio,
                             transformMode=Qt.TransformationMode.SmoothTransformation)

    def update_preview_with_image_resize(self, label):
        pixmap = image_basic.load_image_with_exif(label.path)

        # pixmap = self.last_preview.pixmap().scaled(self.preview_label.size(), aspectRatioMode=Qt.AspectRatioMode.KeepAspectRatio,
        #                                            transformMode=Qt.TransformationMode.SmoothTransformation)
        # pixmap = pixmap.scaledToHeight(self.preview_label.height(), Qt.TransformationMode.SmoothTransformation)
        self.last_preview = label

        pixmap = self.update_preview_image_size(pixmap)

        self.preview_label.setPixmap(pixmap)

    def update_preview_simple(self):
        if self.last_preview and self.last_preview.pixmap():
            pixmap = self.update_preview_image_size(self.last_preview.pixmap())
            # pixmap = pixmap.scaledToHeight(int(self.preview_label.height()), Qt.TransformationMode.SmoothTransformation)

            #pixmap = self.update_preview_image_size(pixmap)

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
                QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Ignore | QMessageBox.StandardButton.Cancel
            )

            if reply == QMessageBox.StandardButton.Save:
                self.save_captions()
            elif reply == QMessageBox.StandardButton.Cancel:
                return

        self.current_label = label
        for i, img in enumerate(self.images):
            is_current_selected = img == label
            img.set_selected(is_current_selected)

            if is_current_selected:
                self.current_image_index = i  # update current image index


        txt_path = os.path.splitext(label.path)[0] + '.txt'
        self.ensure_txt_file_exists(txt_path)

        self.captions_io.blockSignals(True)  # Block signals to avoid triggering textChanged
        self.captions_io.setText(self.image_captions[label.path])
        self.highlight_search_results()
        self.captions_io.setProperty("text_modified", False)
        self.captions_io.setStyleSheet("")
        self.captions_io.blockSignals(False)



        self.update_preview_with_image_resize(label)

    def on_captions_io_text_changed(self):
        self.captions_io.setProperty("text_modified", True)
        self.captions_io.setStyleSheet("QTextEdit { border: 2px solid yellow; }")

    def save_captions(self):
        if self.current_label is not None:
            txt_path = os.path.splitext(self.current_label.path)[0] + '.txt'
            content = self.captions_io.toPlainText()

            new_captions = self.tag_list_to_string(self.caption_to_tag_list(content))

            # Update the caption in the map
            self.image_captions[self.current_label.path] = new_captions

            with open(txt_path, 'w') as txt_file:
                txt_file.write(new_captions)

            self.captions_io.blockSignals(True)
            self.captions_io.setText(new_captions)
            self.captions_io.setProperty("text_modified", False)
            self.captions_io.setStyleSheet("")
            self.captions_io.blockSignals(False)


    def caption_text_handle_cursor(self, cursor_position):
        cursor = self.captions_io.textCursor()  # get the QTextCursor associated with your QTextEdit
        cursor.setPosition(cursor_position)  # set the cursor position
        self.captions_io.setTextCursor(cursor)  # set the QTextCursor back to the QTextEdit

    def highlight_search_results(self):
        self.captions_io.blockSignals(True)  # block signals

        cursor_position = self.captions_io.textCursor().position()  # get the current cursor position


        # Clear existing formatting
        cursor = self.captions_io.textCursor()
        cursor.select(QTextCursor.SelectionType.Document)
        cursor.setCharFormat(QTextCharFormat())
        cursor.clearSelection()
        self.captions_io.setTextCursor(cursor)

        search_text = self.search_input.text()
        regex = QRegularExpression(search_text)
        if (not search_text) or (not regex.isValid()):
            self.caption_text_handle_cursor(cursor_position)
            self.captions_io.blockSignals(False)
            return

        # Build a QRegularExpression from the search text
        search_re = QRegularExpression(search_text)

        # Set up the format for matches
        highlight_format = QTextCharFormat()
        highlight_format.setBackground(QColor(144, 238, 144))

        # Use a QTextDocument to perform the search
        doc = self.captions_io.document()

        # Iterate over the matches in the text
        pos = 0
        match = search_re.match(doc.toPlainText(), pos)
        while match.hasMatch():
            start = match.capturedStart()
            end = match.capturedEnd()

            # Highlight the match
            cursor.setPosition(start)
            cursor.setPosition(end, QTextCursor.MoveMode.KeepAnchor)
            cursor.setCharFormat(highlight_format)

            # Look for the next match
            pos = end
            match = search_re.match(doc.toPlainText(), pos)

        self.caption_text_handle_cursor(cursor_position)

        self.captions_io.blockSignals(False)  # unblock signals after modifying the text




    def clear_search(self):
        self.search_input.setText("")
        self.clear_caption()

    def clear_caption(self):
        self.highlight_search_results()

    def search_all_now(self):
        # Search for captions in all opened captions, show found matches with yellow frame around image

        self.search_all_unselect()

        search_for_text = self.search_all_input.text()
        regex = QRegularExpression(search_for_text)
        if (not search_for_text) or (not regex.isValid()):
            return

        found_images_path = []

        for image_path, caption in self.image_captions.items():
            match = regex.match(caption)
            if match.hasMatch():
                found_images_path.append(image_path)
                #print(f"matching: {caption}")


        for found_image_path in found_images_path:
            for image in self.images:
                if image.path == found_image_path:
                    image.set_highlighted(True)


    def search_all_unselect(self):
        for image in self.images:
            image.set_highlighted(False)

    def search_all_clear_search(self):
        self.search_all_unselect()
        self.search_all_input.setText("")

    def search_for_all_captions(self):
        found_images = []
        search_text = self.search_all_input.text()
        regex = QRegularExpression(search_text)
        if (not search_text) or (not regex.isValid()):
            return found_images
        for image_path, caption in self.image_captions.items():
            if regex.match(caption).hasMatch():
                found_images.append(image_path)
        return found_images

class image_basic():

    skip_rotation = False

    @staticmethod
    def load_image_with_exif(path):
        def _open_with_optional_exif(img_path):
            img = Image.open(img_path)
            # Apply EXIF transpose if available and not explicitly skipped
            if not image_basic.skip_rotation:
                try:
                    img = ImageOps.exif_transpose(img)
                except Exception:
                    # If EXIF is corrupted, continue without transpose
                    pass
            return img

        try:
            image = _open_with_optional_exif(path)
        except (FileNotFoundError, UnidentifiedImageError) as e:
            print(f"Failed to open the image file at {path}: {e}")
            return QPixmap()
        except OSError as e:
            # Typical for broken JPEGs: "Truncated File Read"
            print(f"Warning: {path} could not be read normally ({e}). Trying truncated read fallback...")
            prev = ImageFile.LOAD_TRUNCATED_IMAGES
            ImageFile.LOAD_TRUNCATED_IMAGES = True
            try:
                image = _open_with_optional_exif(path)
            except Exception as e2:
                print(f"Failed again to open image {path}: {e2}")
                ImageFile.LOAD_TRUNCATED_IMAGES = prev
                return QPixmap()
            finally:
                ImageFile.LOAD_TRUNCATED_IMAGES = prev

        try:
            if image.mode != "RGBA":
                image = image.convert("RGBA")
            data = image.tobytes("raw", "RGBA")
        except Exception as e:
            print(f"Error converting image to RGBA for {path}: {e}")
            return QPixmap()

        qimage = QImage(data, image.size[0], image.size[1], QImage.Format.Format_RGBA8888)
        return QPixmap.fromImage(qimage)


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
        self.input_dialog.exec()

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
                    for img_ext in self.image_drop_widget.supported_formats_list:
                        img_path = os.path.join(dir_path, base_name + '.' + img_ext)
                        if os.path.isfile(img_path):
                            paths.append(img_path)
                            break
                elif self.image_drop_widget.is_supported_image_format(path):
                    paths.append(path)

        # Now, `paths` contains all the image paths that need to be added to the preview area
        # You will need to handle the addition of images to the preview area.
        # For example:
        self.image_drop_widget.add_images_to_preview_area(paths)

    def load_args(self, args):
        self.image_drop_widget.load_args(args)

    def closeEvent(self, event):
        self.image_drop_widget.closing_app()
        event.accept()  # let the window close

if __name__ == '__main__':
    # Create the command-line argument parser
    parser = argparse.ArgumentParser(description='Custom widget with labels.')
    parser.add_argument('--configurations_file', type=str, default="caption_helper_settings.json", help='Path to the JSON file with label configurations.')
    # Parse the arguments
    args = parser.parse_args()

    app = QApplication(sys.argv)
    main_window = MainWindow()
    main_window.load_args(args)
    main_window.show()
    sys.exit(app.exec())
