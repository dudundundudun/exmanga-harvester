#!/usr/bin/env python3
"""ExManga Harvester Studio v2.2 — Native Messaging Host for Windows Explorer."""

import json
import os
import string
import struct
import subprocess
import sys

SKIP_DIRS = {
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "$recycle.bin",
    "system volume information",
    "node_modules",
    ".git",
    "recovery",
    "perflogs",
}


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0 or msg_len > 1024 * 1024:
        return None
    raw_data = sys.stdin.buffer.read(msg_len)
    if not raw_data:
        return None
    return json.loads(raw_data.decode("utf-8"))


def send_message(payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def resolve_safe_target(base_dir, sub_path):
    base_abs = os.path.abspath(str(base_dir or "").strip())
    if not base_abs:
        return None, "Base directory path is empty"

    target = base_abs
    if sub_path:
        clean_parts = [
            p for p in str(sub_path).replace("\\", "/").split("/")
            if p and p not in (".", "..")
        ]
        if clean_parts:
            candidate = os.path.abspath(os.path.join(base_abs, *clean_parts))
            try:
                if os.path.commonpath([base_abs, candidate]) == base_abs:
                    target = candidate
            except ValueError:
                return None, "Invalid target path"

    if os.path.exists(target):
        return target, None
    if os.path.exists(base_abs):
        return base_abs, None
    return None, f"Folder does not exist: {base_abs}"


def _has_marker(dir_path, marker_file):
    try:
        return os.path.isfile(os.path.join(dir_path, marker_file))
    except OSError:
        return False


def locate_folder_by_marker(folder_name, marker_file, hint_roots=None):
    if not folder_name or not marker_file:
        return None
    # Prevent path traversal in marker name
    if "/" in marker_file or "\\" in marker_file or ".." in marker_file:
        return None

    target_lower = folder_name.lower()
    roots = []

    if hint_roots:
        for r in hint_roots:
            if r and os.path.isdir(r):
                roots.append(r)

    user_home = os.path.expanduser("~")
    if os.path.isdir(user_home):
        for sub in ("Pictures", "Downloads", "Desktop", "Documents", "Videos", "OneDrive"):
            p = os.path.join(user_home, sub)
            if os.path.isdir(p):
                roots.append(p)
        roots.append(user_home)

    if os.name == "nt":
        for letter in string.ascii_uppercase:
            drive = f"{letter}:\\"
            if os.path.isdir(drive):
                roots.append(drive)

    seen_roots = set()
    unique_roots = []
    for r in roots:
        norm = os.path.normcase(os.path.abspath(r))
        if norm not in seen_roots:
            seen_roots.add(norm)
            unique_roots.append(os.path.abspath(r))

    # Fast check: direct child of each root (depth 1) and root itself
    for root in unique_roots:
        if os.path.basename(root.rstrip("\\/")).lower() == target_lower and _has_marker(root, marker_file):
            return root
        direct = os.path.join(root, folder_name)
        if os.path.isdir(direct) and _has_marker(direct, marker_file):
            return direct

    # Bounded BFS up to depth 3 across roots (skipping heavy system folders)
    visited = set()
    for root in unique_roots:
        queue = [(root, 0)]
        while queue:
            curr, depth = queue.pop(0)
            norm_curr = os.path.normcase(curr)
            if norm_curr in visited:
                continue
            visited.add(norm_curr)
            if depth >= 3:
                continue
            try:
                with os.scandir(curr) as it:
                    for entry in it:
                        if not entry.is_dir(follow_symlinks=False):
                            continue
                        name_l = entry.name.lower()
                        if name_l in SKIP_DIRS or name_l.startswith("."):
                            continue
                        if name_l == target_lower and _has_marker(entry.path, marker_file):
                            return entry.path
                        if depth + 1 < 3:
                            queue.append((entry.path, depth + 1))
            except OSError:
                continue

    return None


def pick_folder_dialog(initial_dir=""):
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass
        init = initial_dir if initial_dir and os.path.isdir(initial_dir) else os.path.expanduser("~")
        selected = filedialog.askdirectory(
            title="Выберите базовую папку для манги",
            initialdir=init,
            mustexist=True,
        )
        root.destroy()
        return os.path.normpath(selected) if selected else ""
    except Exception:
        return ""


def main():
    try:
        msg = read_message()
        if not isinstance(msg, dict):
            send_message({"ok": False, "error": "Empty or invalid request"})
            return

        action = msg.get("action")

        if action == "ping":
            send_message({"ok": True, "version": "2.2.0"})
            return

        if action == "openFolder":
            target, err = resolve_safe_target(msg.get("baseDir"), msg.get("subPath"))
            if err or not target:
                send_message({"ok": False, "error": err or "Path not found"})
                return

            if os.name == "nt":
                subprocess.Popen(
                    ["explorer.exe", os.path.normpath(target)],
                    close_fds=True,
                )

            send_message({"ok": True, "opened": target})
            return

        if action == "locateFolder":
            found = locate_folder_by_marker(
                msg.get("folderName"),
                msg.get("markerFile"),
                msg.get("hintRoots"),
            )
            if found:
                send_message({"ok": True, "path": os.path.normpath(found)})
            else:
                send_message({"ok": False, "error": "Folder not found automatically"})
            return

        if action == "pickFolderDialog":
            picked = pick_folder_dialog(msg.get("initialDir") or "")
            if picked:
                send_message({"ok": True, "path": picked})
            else:
                send_message({"ok": False, "cancelled": True})
            return

        send_message({"ok": False, "error": "Unknown action"})
    except Exception as exc:
        send_message({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
