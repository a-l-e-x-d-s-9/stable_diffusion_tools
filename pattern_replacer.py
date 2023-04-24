import tkinter as tk
from tkinter import messagebox
import re
import json
import os
import threading

MEMORY_FILE = "pattern_replacer_memory.json"


def replace_all():
    global undo_stack
    save_memory()
    try:
        text = text_input.get(1.0, tk.END)
        undo_stack.append(text)
        for pattern_entry, replacement_entry in regex_replacements:
            pattern = pattern_entry.get()
            replacement = replacement_entry.get()
            text = re.sub(pattern, replacement, text)
        text_input.delete(1.0, tk.END)
        text_input.insert(tk.END, text)
    except re.error:
        messagebox.showerror("Error", "Invalid regular expression")
        undo()


def undo():
    global undo_stack
    if undo_stack:
        text_input.delete(1.0, tk.END)
        text_input.insert(tk.END, undo_stack.pop())


def update_window_size():
    base_height = 550
    row_height = 35
    num_rows = len(regex_replacements) + 1
    window.geometry(f"800x{base_height + num_rows * row_height}")


def add_regex_pair(pattern="", replacement=""):
    row_index = len(regex_replacements) + 2
    pattern_entry = tk.Entry(window)
    replacement_entry = tk.Entry(window)
    remove_pair_button = tk.Button(window, text="Remove Pair", command=lambda: remove_regex_pair(row_index))

    pattern_entry.insert(tk.END, pattern)
    replacement_entry.insert(tk.END, replacement)

    pattern_entry.grid(row=row_index, column=0, padx=5, pady=5)
    replacement_entry.grid(row=row_index, column=1, padx=5, pady=5)
    remove_pair_button.grid(row=row_index, column=2, padx=5, pady=5)

    regex_replacements.append((pattern_entry, replacement_entry, remove_pair_button))
    update_window_size()


def remove_regex_pair(row_index):
    pair = None
    for p in regex_replacements:
        if p[0].grid_info()["row"] == row_index:
            pair = p
            break

    if pair:
        regex_replacements.remove(pair)
        pair[0].grid_forget()
        pair[1].grid_forget()
        pair[2].grid_forget()
        update_window_size()


def save_memory():
    memory = {
        "text": text_input.get(1.0, tk.END),
        "regex_replacements": [(pair[0].get(), pair[1].get()) for pair in regex_replacements],
    }

    with open(MEMORY_FILE, "w") as f:
        json.dump(memory, f)


def load_memory():
    if os.path.exists(MEMORY_FILE):
        with open(MEMORY_FILE, "r") as f:
            memory = json.load(f)

        text_input.insert(tk.END, memory.get("text", ""))
        regex_replacements_data = memory.get("regex_replacements", [])

        if not regex_replacements_data:  # Add an empty pair if there are no regex replacement pairs in memory
            add_regex_pair()

        for pattern, replacement in regex_replacements_data:
            add_regex_pair(pattern, replacement)
    else:
        add_regex_pair()  # Add an empty pair if the memory file does not exist



def schedule_memory_save():
    save_memory()
    threading.Timer(60, schedule_memory_save).start()


undo_stack = []
regex_replacements = []

window = tk.Tk()
window.title("Pattern Replacer")
window.geometry("800x600")

text_input = tk.Text(window, wrap=tk.WORD)
text_input.grid(row=0, column=0, columnspan=2, padx=5, pady=5)

replace_button = tk.Button(window, text="Replace All", command=replace_all)
replace_button.grid(row=1, column=0, padx=5, pady=5)

undo_button = tk.Button(window, text="Undo", command=undo)
undo_button.grid(row=1, column=1, padx=5, pady=5)

add_pair_button = tk.Button(window, text="Add Pair", command=add_regex_pair)
add_pair_button.grid(row=1000, column=0, padx=5, pady=5)

load_memory()
schedule_memory_save()

window.protocol("WM_DELETE_WINDOW", lambda: (save_memory(), window.destroy()))
window.mainloop()
