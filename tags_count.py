import os
import argparse
import threading
from collections import defaultdict
from queue import Queue

class FileProcessor(threading.Thread):
    def __init__(self, queue, tag_dict, tag_dict_lock, count_all_tags):
        threading.Thread.__init__(self)
        self.queue = queue
        self.tag_dict = tag_dict
        self.tag_dict_lock = tag_dict_lock
        self.count_all_tags = count_all_tags

    def run(self):
        while True:
            file_path = self.queue.get()
            try:
                with open(file_path, 'r') as f:
                    tags = f.readline().split(',')
                    if not self.count_all_tags:
                        tags = tags[:1]  # Only consider the first tag

                    for tag in tags:
                        tag = tag.strip()
                        with self.tag_dict_lock:
                            if tag in self.tag_dict:
                                self.tag_dict[tag] += 1
                            else:
                                self.tag_dict[tag] = 1
            finally:
                self.queue.task_done()

def multi_threaded_file_scan(paths, count_all_tags):
    # Thread-safe dictionary
    tag_dict = defaultdict(int)
    tag_dict_lock = threading.Lock()

    # Queue for storing file paths
    file_queue = Queue()

    # Create and start threads
    for i in range(10):
        worker = FileProcessor(file_queue, tag_dict, tag_dict_lock, count_all_tags)
        worker.setDaemon(True)
        worker.start()

    # Walk through each directory and add all TXT files to the queue
    for path in paths:
        for dirpath, dirnames, filenames in os.walk(path):
            for filename in filenames:
                if filename.endswith('.txt'):
                    file_queue.put(os.path.join(dirpath, filename))

    # Wait for all tasks in the queue to be processed
    file_queue.join()

    return tag_dict

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='This script scans the provided directories for TXT files and counts the occurrences of tags in these files. A tag is defined as a string delimited by commas.')
    parser.add_argument('--paths', nargs='+', help='A list of directories to scan for TXT files.', required=True)
    parser.add_argument('--count-all-tags', default=False, action=argparse.BooleanOptionalAction, help='If set to true, the script will count all tags in each TXT file. If not set or set to false, the script will only count the first tag in each TXT file.')
    args = parser.parse_args()

    tag_dict = multi_threaded_file_scan(args.paths, args.count_all_tags)

    # Sort the tags by count in descending order
    sorted_tags = sorted(tag_dict.items(), key=lambda item: item[1], reverse=True)

    for tag, count in sorted_tags:
        print(f'{tag} ({count})')

#python script.py --paths /path/to/directory1 /path/to/directory2 --count-all-tags