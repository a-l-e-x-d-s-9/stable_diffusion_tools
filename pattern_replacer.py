import tkinter as tk
from tkinter import messagebox, filedialog
import re
import json
import os
import threading
import random

MEMORY_FILE = "pattern_replacer_memory.json"
UNDO_LIMIT = 20
undo_stack = []
regex_replacements = []
stop_event = threading.Event()


def replace_all():
    global undo_stack
    save_memory()
    text = input_text.get(1.0, tk.END)
    push_undo_state(text)

    # Apply regex replacements
    for pattern_entry, replacement_entry, _ in regex_replacements:
        pattern = pattern_entry.get()
        replacement = replacement_entry.get()
        text = re.sub(pattern, replacement, text)

    # Expand loop tags
    text = re.sub(r'<loop_(\d+)>(.*?)</loop>', expand_loop, text, flags=re.DOTALL)

    # Replace random number placeholders
    text = re.sub(r'<rand_int_(-?\d+)_(-?\d+)>', replace_rand_int, text)
    text = re.sub(r'<rand_float_(-?[0-9]*\.?[0-9]+)_(-?[0-9]*\.?[0-9]+)>', replace_rand_float, text)

    output_text.config(state=tk.NORMAL)
    output_text.delete(1.0, tk.END)
    output_text.insert(tk.END, text)
    output_text.config(state=tk.DISABLED)


def expand_loop(match):
    count = int(match.group(1))
    text = match.group(2)
    return text * count


def replace_rand_int(match):
    low = int(match.group(1))
    high = int(match.group(2))
    return str(random.randint(low, high))


def replace_rand_float(match):
    low = float(match.group(1))
    high = float(match.group(2))
    return f"{random.uniform(low, high):.3f}"  # Format to 3 decimal places


def push_undo_state(text_state):
    if not undo_stack or undo_stack[-1] != text_state:
        undo_stack.append(text_state)
        if len(undo_stack) > UNDO_LIMIT:
            undo_stack.pop(0)


def undo():
    global undo_stack
    if undo_stack:
        input_text.delete(1.0, tk.END)
        input_text.insert(tk.END, undo_stack.pop())


def update_window_size():
    base_height = 200
    row_height = 35
    num_rows = len(regex_replacements) + 1
    window.geometry(f"800x{base_height + num_rows * row_height}")


def validate_regex(event, entry_widget=None):
    if entry_widget is None:
        entry_widget = event.widget

    try:
        re.compile(entry_widget.get())
        entry_widget.configure(bg="#98FB98")  # Light green
    except re.error:
        entry_widget.configure(bg="#F08080")  # Light coral (a soft red shade)


def remove_regex_pair(pattern_entry):
    global regex_replacements
    for pair in regex_replacements:
        if pair[0] == pattern_entry:
            regex_replacements.remove(pair)
            pair[0].grid_forget()
            pair[1].grid_forget()
            pair[2].grid_forget()
            update_window_size()
            break

    # Ensure Add Pair button remains visible
    if not regex_replacements:
        add_pair_button.grid(row=len(regex_replacements) + 3, column=5, padx=5, pady=5)


def add_regex_pair(pattern="", replacement=""):
    row_index = len(regex_replacements) + 5
    pattern_entry = tk.Entry(window)
    replacement_entry = tk.Entry(window)
    remove_pair_button = tk.Button(window, text="Remove", command=lambda: remove_regex_pair(pattern_entry))

    pattern_entry.insert(tk.END, pattern)
    replacement_entry.insert(tk.END, replacement)
    pattern_entry.grid(row=row_index, column=0, padx=5, pady=5)
    replacement_entry.grid(row=row_index, column=1, padx=5, pady=5)
    remove_pair_button.grid(row=row_index, column=2, padx=5, pady=5)

    pattern_entry.bind('<KeyRelease>', validate_regex)
    validate_regex(None, pattern_entry)

    regex_replacements.append((pattern_entry, replacement_entry, remove_pair_button))
    update_window_size()


def save_memory():
    memory = {
        "text": input_text.get(1.0, tk.END),
        "regex_replacements": [(pair[0].get(), pair[1].get()) for pair in regex_replacements],
    }
    with open(MEMORY_FILE, "w") as f:
        json.dump(memory, f)


def load_memory():
    if os.path.exists(MEMORY_FILE):
        with open(MEMORY_FILE, "r") as f:
            memory = json.load(f)
        input_text.insert(tk.END, memory.get("text", ""))
        for pattern, replacement in memory.get("regex_replacements", []):
            add_regex_pair(pattern, replacement)
    else:
        add_regex_pair()


def schedule_memory_save():
    if not stop_event.is_set():
        save_memory()
        threading.Timer(60, schedule_memory_save).start()


def save_as_file():
    file_path = filedialog.asksaveasfilename(defaultextension=".json",
                                             filetypes=[("JSON files", "*.json"), ("All Files", "*.*")])
    if file_path:
        save_memory()
        os.rename(MEMORY_FILE, file_path)


def load_from_file():
    file_path = filedialog.askopenfilename(filetypes=[("JSON files", "*.json"), ("All Files", "*.*")])
    if file_path:
        with open(file_path, "r") as f:
            memory = json.load(f)
        input_text.delete(1.0, tk.END)
        input_text.insert(tk.END, memory.get("text", ""))
        for pattern, replacement in memory.get("regex_replacements", []):
            add_regex_pair(pattern, replacement)


def close_window():
    stop_event.set()
    save_memory()
    os._exit(0)  # Forcefully stops all threads and exits


# Create main window
window = tk.Tk()
window.title("Pattern Replacer")
window.geometry("800x400")
window.minsize(800, 400)

# Information label placed above the buttons (not hiding input text)
info_text = tk.Text(window, height=2, wrap=tk.WORD)
info_text.insert(tk.END, "Use <loop_X>text</loop> for loops.\n"
                         "Use <rand_int_min_max> or <rand_float_min_max> for random numbers.")
info_text.config(state=tk.DISABLED)  # Prevent editing
info_text.grid(row=2, column=0, columnspan=5, padx=5, pady=5, sticky="w")

# Text input and output
input_text = tk.Text(window, wrap=tk.WORD, height=10, width=70)
input_text.grid(row=0, column=0, columnspan=5, sticky="nsew")

output_text = tk.Text(window, wrap=tk.WORD, state=tk.DISABLED, height=10, width=70)
output_text.grid(row=1, column=0, columnspan=5, sticky="nsew")

# Buttons
replace_button = tk.Button(window, text="Replace All", command=replace_all)
replace_button.grid(row=3, column=0, padx=5, pady=5)

undo_button = tk.Button(window, text="Undo", command=undo)
undo_button.grid(row=3, column=1, padx=5, pady=5)

save_button = tk.Button(window, text="Save As", command=save_as_file)
save_button.grid(row=3, column=2, padx=5, pady=5)

load_button = tk.Button(window, text="Load", command=load_from_file)
load_button.grid(row=3, column=3, padx=5, pady=5)

window.grid_rowconfigure(0, weight=1)
window.grid_rowconfigure(1, weight=1)
window.grid_columnconfigure(0, weight=1)
window.grid_columnconfigure(1, weight=1)
window.grid_columnconfigure(2, weight=1)
window.grid_columnconfigure(3, weight=1)
window.grid_columnconfigure(4, weight=1)

add_pair_button = tk.Button(window, text="Add Pair", command=add_regex_pair)
add_pair_button.grid(row=3, column=5, padx=5, pady=5)


load_memory()
schedule_memory_save()
window.protocol("WM_DELETE_WINDOW", close_window)
window.mainloop()
