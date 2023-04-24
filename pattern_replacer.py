import tkinter as tk
from tkinter import messagebox
import re


def replace_all():
    global undo_stack
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


def add_regex_pair():
    pattern_entry = tk.Entry(window)
    replacement_entry = tk.Entry(window)
    pattern_entry.grid(row=len(regex_replacements) + 2, column=0, padx=5, pady=5)
    replacement_entry.grid(row=len(regex_replacements) + 2, column=1, padx=5, pady=5)
    regex_replacements.append((pattern_entry, replacement_entry))


def remove_regex_pair():
    if regex_replacements:
        pair = regex_replacements.pop()
        pair[0].grid_forget()
        pair[1].grid_forget()


undo_stack = []
regex_replacements = []

window = tk.Tk()
window.title("Pattern Replacer")
window.geometry("600x400")

text_input = tk.Text(window, wrap=tk.WORD)
text_input.grid(row=0, column=0, columnspan=2, padx=5, pady=5)

add_regex_pair()

replace_button = tk.Button(window, text="Replace All", command=replace_all)
replace_button.grid(row=1, column=0, padx=5, pady=5)

undo_button = tk.Button(window, text="Undo", command=undo)
undo_button.grid(row=1, column=1, padx=5, pady=5)

add_pair_button = tk.Button(window, text="Add Pair", command=add_regex_pair)
add_pair_button.grid(row=1000, column=0, padx=5, pady=5)

remove_pair_button = tk.Button(window, text="Remove Pair", command=remove_regex_pair)
remove_pair_button.grid(row=1000, column=1, padx=5, pady=5)

window.mainloop()
