#!/usr/bin/env python3
"""Bot farm control panel. Drives engine.mjs over its local HTTP API."""

import json
import math
import queue
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox, simpledialog

BASE = "http://127.0.0.1:8765"
HERE = Path(__file__).resolve().parent
PROFILES_PATH = HERE / "profiles.json"
LAST_CONFIG_PATH = HERE / "last_config.json"

VIEW_DISTANCES = ["far", "normal", "short", "tiny"]
VERSIONS = ["1.21.11", "1.21.10", "1.21.9", "1.21.8", "1.21.4", "1.20.6"]
RESOURCE_PACK_MODES = ["accept", "decline", "ignore"]

PACKET_DEFS = [
    ("actWalk", "Walk (movement packets)", "Sends position/position_look packets as the bot walks. Core stress load."),
    ("actLook", "Look (rotation packets)", "Sends look/position_look rotation deltas. Smooth mouse-like."),
    ("actJump", "Jump", "Sends jump control (affects onGround + player_input jump bit)."),
    ("actSprint", "Sprint", "Sends start/stop sprinting entity_action + sprint input bit."),
    ("actSneak", "Sneak", "Sends sneak state via entity_action/player_input."),
    ("actSwing", "Swing arm", "Sends arm_animation packets."),
    ("actHotbar", "Hotbar switch", "Sends held_item_change packets."),
    ("actChat", "Chat", "Sends chat/command packets."),
]


def call(path, payload=None, timeout=2.0):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, method="GET" if data is None else "POST")
    req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


class App:
    def __init__(self, root):
        self.root = root
        self.proc = None
        self.results = queue.Queue()
        self.stop_event = threading.Event()
        self.log_seen = 0
        self.packet_vars = {k: tk.BooleanVar(value=True) for k, _, _ in PACKET_DEFS}
        self.bot_names = []
        self.map_center = (0.0, 0.0)
        self.map_scale = 1.0
        self.live_after_id = None
        self.detail_windows = {}
        self.map_transform = None  # (cx, cz, scale, width, height)
        self.player_names = []

        root.title("bot farm")
        root.geometry("1320x860")
        root.minsize(1080, 720)

        self.build()
        try:
            cached = self.load_cached()
            if cached:
                self.apply_profile(cached)
        except Exception:
            pass
        self.start_engine()

        threading.Thread(target=self.poll_loop, daemon=True).start()
        self.root.after(200, self.drain)
        root.protocol("WM_DELETE_WINDOW", self.on_close)

    def build(self):
        top = ttk.Frame(self.root, padding=(10, 8))
        top.pack(fill="x")

        self.status_var = tk.StringVar(value="engine: starting")
        self.count_var = tk.StringVar(value="0 bots")

        ttk.Label(top, textvariable=self.status_var, font=("Segoe UI", 10, "bold")).pack(side="left")
        ttk.Label(top, textvariable=self.count_var).pack(side="right")

        self.build_profile_bar()

        body = ttk.Frame(self.root, padding=(10, 0))
        body.pack(fill="both", expand=True)

        left, self.left_canvas = self.make_scrollable(body, width=360, expand=False)
        right, self.right_canvas = self.make_scrollable(body, expand=True)
        self.left_inner = left
        self.right_inner = right

        self.build_target(left)
        self.build_bots(left)
        self.build_behaviour(left)
        self.build_messages(left)
        self.build_actions(left)
        self.build_table(right)
        self.build_map(right)
        self.build_log(right)

        self.bind_wheel(left, self.left_canvas)
        self.bind_wheel(right, self.right_canvas)
        try:
            self.left_canvas.bind("<MouseWheel>", lambda e: self._wheel(self.left_canvas, e), add="+")
            self.right_canvas.bind("<MouseWheel>", lambda e: self._wheel(self.right_canvas, e), add="+")
        except Exception:
            pass

    def make_scrollable(self, parent, width=None, expand=True):
        outer = ttk.Frame(parent)
        canvas = tk.Canvas(outer, highlightthickness=0, width=width or 0)
        scrollbar = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)
        inner = ttk.Frame(canvas)
        win_id = canvas.create_window((0, 0), window=inner, anchor="nw")

        def _inner_config(_event):
            try:
                canvas.configure(scrollregion=canvas.bbox("all"))
            except Exception:
                pass

        inner.bind("<Configure>", _inner_config)

        def _canvas_config(event):
            try:
                canvas.itemconfig(win_id, width=event.width)
            except Exception:
                pass

        canvas.bind("<Configure>", _canvas_config)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        if expand:
            outer.pack(side="left", fill="both", expand=True)
        else:
            outer.pack(side="left", fill="y", padx=(0, 10))
        return inner, canvas

    def _wheel(self, canvas, event):
        try:
            widget = event.widget
            if isinstance(widget, ttk.Treeview):
                widget.yview_scroll(-1 if event.delta > 0 else 1, "units")
            else:
                canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")
        except Exception:
            pass
        return "break"

    def bind_wheel(self, widget, canvas):
        if isinstance(widget, (tk.Text, tk.Entry, ttk.Combobox, ttk.Scale)):
            return
        try:
            widget.bind("<MouseWheel>", lambda e: self._wheel(canvas, e), add="+")
        except Exception:
            pass
        for child in widget.winfo_children():
            self.bind_wheel(child, canvas)

    def build_profile_bar(self):
        bar = ttk.Frame(self.root, padding=(10, 0))
        bar.pack(fill="x")
        ttk.Label(bar, text="profile:").pack(side="left")
        self.profile_var = tk.StringVar(value="")
        self.profile_combo = ttk.Combobox(bar, textvariable=self.profile_var, width=24, state="readonly")
        self.profile_combo.pack(side="left", padx=(6, 4))
        ttk.Button(bar, text="Load", width=7, command=self.on_profile_load).pack(side="left", padx=(0, 4))
        ttk.Button(bar, text="Save as", width=9, command=self.on_profile_save).pack(side="left", padx=(0, 4))
        ttk.Button(bar, text="Delete", width=9, command=self.on_profile_delete).pack(side="left")
        ttk.Label(bar, text="live keys apply instantly; host/count on next Start", foreground="#888").pack(side="right")
        self.refresh_profile_combo()

    # ---------- profiles ----------

    @staticmethod
    def builtin_profiles():
        base = {
            "host": "127.0.0.1", "port": 25565, "count": 20, "prefix": "lt_",
            "version": "1.21.11", "staggerMs": 1200, "waitForPreviousSpawn": False,
            "spawnWaitSeconds": 5, "viewDistance": "far", "movement": True,
            "autoReconnect": True, "chatIntervalMs": 200000, "chatChance": 0.5,
            "messages": ["gg", "anyone wanna duel", "brb", "how do i get coins", "lag"],
            "realisticNames": True, "wanderRadius": 20, "lookSpeed": 1.0,
            "sprintChance": 0.5, "sneakChance": 0.15,
            "actWalk": True, "actLook": True, "actJump": True, "actSprint": True,
            "actSneak": True, "actSwing": True, "actHotbar": True, "actChat": True,
            "fingerprint": True, "resourcePackMode": "accept",
            "followChance": 0.15, "followRadius": 5, "followRealPlayers": True, "followPlayer": "", "pathfinding": True,
        }
        idle = dict(base)
        idle.update({
            "count": 20, "wanderRadius": 8, "lookSpeed": 0.5, "sprintChance": 0.05,
            "sneakChance": 0.05, "followChance": 0.0, "chatIntervalMs": 300000,
            "chatChance": 0.1, "actSprint": False, "actSwing": False,
            "actHotbar": False,
            "messages": ["afk", "in lobby", "brb"],
        })
        chaos = dict(base)
        chaos.update({
            "count": 20, "staggerMs": 150, "wanderRadius": 30, "lookSpeed": 1.5,
            "sprintChance": 0.9, "sneakChance": 0.3, "followChance": 0.4,
            "followRadius": 4, "chatIntervalMs": 30000, "chatChance": 0.9,
            "messages": ["gg", "wp", "ez", "o7", "hello??", "check this out", "lagggg", "anyone??"],
        })
        return {"idle lobby": idle, "casual": base, "chaos": chaos}

    def load_user_profiles(self):
        try:
            data = json.loads(PROFILES_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def all_profiles(self):
        merged = dict(self.builtin_profiles())
        merged.update(self.load_user_profiles())
        return merged

    def refresh_profile_combo(self):
        names = list(self.all_profiles().keys())
        self.profile_combo.configure(values=names)
        if self.profile_var.get() not in names:
            self.profile_var.set(names[0] if names else "")

    def on_profile_load(self):
        name = self.profile_var.get()
        profiles = self.all_profiles()
        cfg = profiles.get(name)
        if cfg is None:
            messagebox.showwarning("profile", "no such profile")
            return
        self.apply_profile(cfg)
        self.status_var.set(f"profile loaded: {name} (host/count on next Start)")

    def on_profile_save(self):
        payload = self.collect()
        if payload is None:
            return
        name = simpledialog.askstring("save profile", "profile name:")
        if not name:
            return
        name = name.strip()
        if name in self.builtin_profiles():
            messagebox.showerror("profile", "built-in names are reserved")
            return
        user = self.load_user_profiles()
        user[name] = payload
        try:
            PROFILES_PATH.write_text(json.dumps(user, indent=2), encoding="utf-8")
        except Exception as exc:
            messagebox.showerror("profile", f"could not write profiles.json: {exc}")
            return
        self.refresh_profile_combo()
        self.profile_var.set(name)
        self.status_var.set(f"profile saved: {name}")

    def on_profile_delete(self):
        name = self.profile_var.get()
        if name in self.builtin_profiles():
            messagebox.showerror("profile", "built-in profiles cannot be deleted")
            return
        user = self.load_user_profiles()
        if name not in user:
            messagebox.showwarning("profile", "no such saved profile")
            return
        if not messagebox.askyesno("profile", f"delete saved profile '{name}'?"):
            return
        del user[name]
        PROFILES_PATH.write_text(json.dumps(user, indent=2), encoding="utf-8")
        self.refresh_profile_combo()
        self.status_var.set(f"profile deleted: {name}")

    def apply_profile(self, cfg):
        self.host_var.set(str(cfg.get("host", "127.0.0.1")))
        self.port_var.set(str(cfg.get("port", 25565)))
        self.count_entry_var.set(str(cfg.get("count", 20)))
        self.prefix_var.set(str(cfg.get("prefix", "lt_")))
        self.stagger_var.set(str(cfg.get("staggerMs", 1200)))
        self.wait_for_spawn_var.set(bool(cfg.get("waitForPreviousSpawn", False)))
        self.spawn_wait_var.set(str(cfg.get("spawnWaitSeconds", 5)))
        self.version_var.set(str(cfg.get("version", "1.21.11")))
        self.view_var.set(str(cfg.get("viewDistance", "far")))
        self.movement_var.set(bool(cfg.get("movement", True)))
        self.reconnect_var.set(bool(cfg.get("autoReconnect", True)))
        self.realistic_var.set(bool(cfg.get("realisticNames", True)))
        self.chat_interval_var.set(str(max(1, int(cfg.get("chatIntervalMs", 200000)) // 1000)))
        self.chat_chance_var.set(str(cfg.get("chatChance", 0.5)))
        self.wander_var.set(str(cfg.get("wanderRadius", 20)))
        self.look_speed_var.set(str(cfg.get("lookSpeed", 1.0)))
        self.sprint_chance_var.set(str(cfg.get("sprintChance", 0.5)))
        self.sneak_chance_var.set(str(cfg.get("sneakChance", 0.15)))
        self.follow_chance_var.set(str(cfg.get("followChance", 0.15)))
        self.follow_radius_var.set(str(cfg.get("followRadius", 5)))
        self.follow_real_var.set(bool(cfg.get("followRealPlayers", True)))
        self.follow_player_var.set(str(cfg.get("followPlayer", "") or ""))
        self.path_var.set(bool(cfg.get("pathfinding", True)))
        self.fingerprint_var.set(bool(cfg.get("fingerprint", True)))
        self.resource_pack_var.set(str(cfg.get("resourcePackMode", "accept")))
        for key, _, _ in PACKET_DEFS:
            if key in cfg:
                self.packet_vars[key].set(bool(cfg[key]))
        msgs = cfg.get("messages") or []
        self.messages_text.delete("1.0", "end")
        self.messages_text.insert("1.0", "\n".join(str(m) for m in msgs))
        try:
            self.chat_slider.set(float(self.chat_interval_var.get()))
        except Exception:
            pass
        self.sync_name_controls()
        self.push_live_config()

    def load_cached(self):
        try:
            data = json.loads(LAST_CONFIG_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def save_cached(self):
        # Best-effort raw snapshot (no validation popups on exit).
        try:
            messages = [line.strip() for line in self.messages_text.get("1.0", "end").splitlines() if line.strip()]
        except Exception:
            messages = []
        try:
            chat_ms = max(1, int(float(self.chat_interval_var.get() or 200) * 1000))
        except Exception:
            chat_ms = 200000
        data = {
            "host": self.host_var.get().strip() or "127.0.0.1",
            "port": self.port_var.get().strip() or "25565",
            "count": self.count_entry_var.get().strip() or "20",
            "prefix": self.prefix_var.get().strip() or "lt_",
            "version": self.version_var.get().strip() or "1.21.11",
            "staggerMs": self.stagger_var.get().strip() or "500",
            "waitForPreviousSpawn": bool(self.wait_for_spawn_var.get()),
            "spawnWaitSeconds": self.spawn_wait_var.get().strip() or "5",
            "viewDistance": self.view_var.get() or "far",
            "movement": bool(self.movement_var.get()),
            "autoReconnect": bool(self.reconnect_var.get()),
            "realisticNames": bool(self.realistic_var.get()),
            "chatIntervalMs": chat_ms,
            "chatChance": self.chat_chance_var.get().strip() or "0.5",
            "wanderRadius": self.wander_var.get().strip() or "20",
            "lookSpeed": self.look_speed_var.get().strip() or "1.0",
            "sprintChance": self.sprint_chance_var.get().strip() or "0.5",
            "sneakChance": self.sneak_chance_var.get().strip() or "0.15",
            "fingerprint": bool(self.fingerprint_var.get()),
            "resourcePackMode": self.resource_pack_var.get() or "accept",
            "followChance": self.follow_chance_var.get().strip() or "0.15",
            "followRadius": self.follow_radius_var.get().strip() or "5",
            "followRealPlayers": bool(self.follow_real_var.get()),
            "followPlayer": self.follow_player_var.get().strip() or "",
            "pathfinding": bool(self.path_var.get()),
            "messages": messages,
        }
        for key, _, _ in PACKET_DEFS:
            data[key] = bool(self.packet_vars[key].get())
        try:
            LAST_CONFIG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception:
            pass

    def build_target(self, parent):
        frame = ttk.LabelFrame(parent, text="target", padding=8)
        frame.pack(fill="x", pady=(0, 8))
        frame.columnconfigure(1, weight=1)

        self.host_var = tk.StringVar(value="127.0.0.1")
        self.port_var = tk.StringVar(value="25565")
        self.version_var = tk.StringVar(value="1.21.11")
        self.view_var = tk.StringVar(value="far")

        rows = [
            ("host", ttk.Entry(frame, textvariable=self.host_var)),
            ("port", ttk.Entry(frame, textvariable=self.port_var)),
            ("version", ttk.Combobox(frame, textvariable=self.version_var, values=VERSIONS, width=12)),
            ("view dist", ttk.Combobox(frame, textvariable=self.view_var, values=VIEW_DISTANCES, state="readonly", width=12)),
        ]
        for index, (label, widget) in enumerate(rows):
            ttk.Label(frame, text=label).grid(row=index, column=0, sticky="w", pady=2, padx=(0, 8))
            widget.grid(row=index, column=1, sticky="ew", pady=2)

    def build_bots(self, parent):
        frame = ttk.LabelFrame(parent, text="bots", padding=8)
        frame.pack(fill="x", pady=(0, 8))
        frame.columnconfigure(1, weight=1)

        self.count_entry_var = tk.StringVar(value="20")
        self.prefix_var = tk.StringVar(value="lt_")
        self.stagger_var = tk.StringVar(value="1200")
        self.wait_for_spawn_var = tk.BooleanVar(value=False)
        self.spawn_wait_var = tk.StringVar(value="5")
        self.realistic_var = tk.BooleanVar(value=True)

        rows = [
            ("count", ttk.Entry(frame, textvariable=self.count_entry_var)),
            ("name prefix", ttk.Entry(frame, textvariable=self.prefix_var)),
            ("stagger ms", ttk.Entry(frame, textvariable=self.stagger_var)),
            ("after spawn (s)", ttk.Entry(frame, textvariable=self.spawn_wait_var)),
        ]
        for index, (label, widget) in enumerate(rows):
            ttk.Label(frame, text=label).grid(row=index, column=0, sticky="w", pady=2, padx=(0, 8))
            widget.grid(row=index, column=1, sticky="ew", pady=2)
            if label == "name prefix":
                self.prefix_entry = widget

        ttk.Checkbutton(frame, text="wait for previous bot to spawn", variable=self.wait_for_spawn_var).grid(row=len(rows), column=0, columnspan=2, sticky="w", pady=(2, 0))
        ttk.Checkbutton(frame, text="realistic names", variable=self.realistic_var, command=self.sync_name_controls).grid(row=len(rows) + 1, column=0, columnspan=2, sticky="w", pady=(2, 0))
        self.fingerprint_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(frame, text="randomize client settings", variable=self.fingerprint_var).grid(row=len(rows) + 2, column=0, columnspan=2, sticky="w", pady=(2, 0))
        ttk.Label(frame, text="resource packs").grid(row=len(rows) + 3, column=0, sticky="w", pady=2, padx=(0, 8))
        self.resource_pack_var = tk.StringVar(value="accept")
        ttk.Combobox(frame, textvariable=self.resource_pack_var, values=RESOURCE_PACK_MODES, state="readonly", width=12).grid(row=len(rows) + 3, column=1, sticky="ew", pady=2)
        ttk.Button(frame, text="packets...", command=self.open_packets).grid(row=len(rows) + 4, column=0, columnspan=2, sticky="ew", pady=(4, 0))
        self.sync_name_controls()

    def sync_name_controls(self):
        try:
            if self.realistic_var.get():
                self.prefix_entry.configure(state="disabled")
            else:
                self.prefix_entry.configure(state="normal")
        except Exception:
            pass

    def open_packets(self):
        win = tk.Toplevel(self.root)
        win.title("packets / actions")
        win.geometry("460x420")
        ttk.Label(win, text="Choose which actions each bot performs. Hover for details.").pack(anchor="w", padx=10, pady=(10, 4))
        tip = tk.StringVar(value="")
        for key, label, desc in PACKET_DEFS:
            row = ttk.Frame(win, padding=(10, 2))
            row.pack(fill="x")
            cb = ttk.Checkbutton(row, text=label, variable=self.packet_vars[key], command=self.push_live_config)
            cb.pack(side="left")
            cb.bind("<Enter>", lambda e, d=desc: tip.set(d))
            cb.bind("<Leave>", lambda e: tip.set(""))
        ttk.Label(win, textvariable=tip, wraplength=420, foreground="#555").pack(fill="x", padx=10, pady=(8, 4))
        ttk.Button(win, text="close", command=win.destroy).pack(pady=8)

    def build_behaviour(self, parent):
        frame = ttk.LabelFrame(parent, text="behaviour", padding=8)
        frame.pack(fill="x", pady=(0, 8))
        frame.columnconfigure(1, weight=1)

        self.movement_var = tk.BooleanVar(value=True)
        self.reconnect_var = tk.BooleanVar(value=True)
        self.chat_interval_var = tk.StringVar(value="200")
        self.chat_chance_var = tk.StringVar(value="0.5")
        self.wander_var = tk.StringVar(value="20")
        self.look_speed_var = tk.StringVar(value="1.0")
        self.sprint_chance_var = tk.StringVar(value="0.5")
        self.sneak_chance_var = tk.StringVar(value="0.15")
        self.follow_chance_var = tk.StringVar(value="0.15")
        self.follow_radius_var = tk.StringVar(value="5")
        self.follow_real_var = tk.BooleanVar(value=True)
        self.follow_player_var = tk.StringVar(value="")
        self.path_var = tk.BooleanVar(value=True)

        ttk.Checkbutton(frame, text="move around", variable=self.movement_var).grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Checkbutton(frame, text="reconnect on kick", variable=self.reconnect_var).grid(row=1, column=0, columnspan=2, sticky="w")
        ttk.Checkbutton(frame, text="follow real players", variable=self.follow_real_var).grid(row=2, column=0, columnspan=2, sticky="w")
        ttk.Checkbutton(frame, text="pathfinding (A*)", variable=self.path_var, command=self.push_live_config).grid(row=3, column=0, columnspan=2, sticky="w")

        rows = [
            ("chat every (s)", ttk.Entry(frame, textvariable=self.chat_interval_var)),
            ("chat chance", ttk.Entry(frame, textvariable=self.chat_chance_var)),
            ("wander radius", ttk.Entry(frame, textvariable=self.wander_var)),
            ("look speed", ttk.Entry(frame, textvariable=self.look_speed_var)),
            ("sprint chance", ttk.Entry(frame, textvariable=self.sprint_chance_var)),
            ("sneak chance", ttk.Entry(frame, textvariable=self.sneak_chance_var)),
            ("follow chance", ttk.Entry(frame, textvariable=self.follow_chance_var)),
            ("follow radius", ttk.Entry(frame, textvariable=self.follow_radius_var)),
        ]
        FIRST_ROW = 3
        for index, (label, widget) in enumerate(rows, start=FIRST_ROW):
            ttk.Label(frame, text=label).grid(row=index, column=0, sticky="w", pady=2, padx=(0, 8))
            widget.grid(row=index, column=1, sticky="ew", pady=2)

        follow_row = FIRST_ROW + len(rows)
        ttk.Label(frame, text="follow player").grid(row=follow_row, column=0, sticky="w", pady=2, padx=(0, 8))
        self.follow_combo = ttk.Combobox(frame, textvariable=self.follow_player_var, values=[""], width=12)
        self.follow_combo.grid(row=follow_row, column=1, sticky="ew", pady=2)
        self.follow_combo.bind("<KeyRelease>", self.on_follow_player_key)
        ttk.Label(frame, text="empty = follow whoever is near; set = all bots herd to them instantly", foreground="#777").grid(row=follow_row + 1, column=0, columnspan=2, sticky="w", pady=(0, 2))

        # chat speed slider
        slider_row = follow_row + 2
        ttk.Label(frame, text="chat speed (s)").grid(row=slider_row, column=0, sticky="w", pady=2, padx=(0, 8))
        self.chat_slider = ttk.Scale(frame, from_=1, to=600, orient="horizontal", command=self.on_chat_slider)
        self.chat_slider.set(float(self.chat_interval_var.get()))
        self.chat_slider.grid(row=slider_row, column=1, sticky="ew", pady=2)

        ttk.Label(frame, text="per bot: every N seconds, roll randint < chance.", foreground="#777").grid(row=slider_row + 1, column=0, columnspan=2, sticky="w", pady=(4, 0))
        ttk.Label(frame, text="behaviour & packets apply live; count/host/names on next start", foreground="#2a7").grid(row=slider_row + 2, column=0, columnspan=2, sticky="w", pady=(2, 0))
        self.bind_live_settings()

    def bind_live_settings(self):
        for var in (self.movement_var, self.reconnect_var, self.realistic_var,
                    self.chat_interval_var, self.chat_chance_var, self.wander_var,
                    self.look_speed_var, self.sprint_chance_var, self.sneak_chance_var,
                    self.follow_chance_var, self.follow_radius_var, self.follow_real_var,
                    self.follow_player_var,
                    self.fingerprint_var, self.resource_pack_var):
            var.trace_add("write", lambda *_: self.schedule_live_push())

    def schedule_live_push(self):
        if self.live_after_id:
            try:
                self.root.after_cancel(self.live_after_id)
            except Exception:
                pass
        self.live_after_id = self.root.after(300, self.push_live_config)

    def collect_live(self):
        try:
            interval = float(self.chat_interval_var.get())
            chance = float(self.chat_chance_var.get())
            wander = float(self.wander_var.get())
            look = float(self.look_speed_var.get())
            sprint = float(self.sprint_chance_var.get())
            sneak = float(self.sneak_chance_var.get())
            follow_chance = float(self.follow_chance_var.get())
            follow_radius = float(self.follow_radius_var.get())
        except ValueError:
            return None
        messages = [line.strip() for line in self.messages_text.get("1.0", "end").splitlines() if line.strip()]
        payload = {
            "movement": bool(self.movement_var.get()),
            "autoReconnect": bool(self.reconnect_var.get()),
            "realisticNames": bool(self.realistic_var.get()),
            "fingerprint": bool(self.fingerprint_var.get()),
            "resourcePackMode": self.resource_pack_var.get() or "accept",
            "chatIntervalMs": max(1000, int(interval * 1000)),
            "chatChance": max(0.0, min(1.0, chance)),
            "messages": messages,
            "wanderRadius": wander,
            "lookSpeed": look,
            "sprintChance": max(0.0, min(1.0, sprint)),
            "sneakChance": max(0.0, min(1.0, sneak)),
            "followChance": max(0.0, min(1.0, follow_chance)),
            "followRadius": follow_radius,
            "followRealPlayers": bool(self.follow_real_var.get()),
            "followPlayer": self.follow_player_var.get().strip() or "",
            "pathfinding": bool(self.path_var.get()),
        }
        for key, _, _ in PACKET_DEFS:
            payload[key] = bool(self.packet_vars[key].get())
        return payload

    def push_live_config(self):
        self.live_after_id = None
        payload = self.collect_live()
        if payload is None:
            return
        try:
            call("/config", payload, timeout=1.5)
            self.status_var.set("engine: live settings applied")
        except Exception:
            pass

    def on_chat_slider(self, val):
        try:
            self.chat_interval_var.set(str(int(float(val))))
        except Exception:
            pass

    def build_messages(self, parent):
        frame = ttk.LabelFrame(parent, text="chat lines (one per row)", padding=8)
        frame.pack(fill="both", expand=True, pady=(0, 8))

        self.messages_text = tk.Text(frame, height=6, wrap="word")
        self.messages_text.pack(fill="both", expand=True)
        self.messages_text.insert("1.0", "gg\nanyone wanna duel\nbrb\nhow do i get coins\nlag")
        self.messages_text.bind("<KeyRelease>", lambda _event: self.schedule_live_push())

    def build_actions(self, parent):
        frame = ttk.Frame(parent)
        frame.pack(fill="x")

        ttk.Button(frame, text="Start", command=self.on_start).pack(fill="x", pady=2)
        ttk.Button(frame, text="Stop all", command=self.on_stop).pack(fill="x", pady=2)

        ttk.Label(frame, text="target bot (blank = all)").pack(anchor="w", pady=(4, 0))
        self.say_target_var = tk.StringVar(value="all")
        self.say_target = ttk.Combobox(frame, textvariable=self.say_target_var, values=["all"], width=20)
        self.say_target.pack(fill="x", pady=2)

        ttk.Label(frame, text="server player (search)").pack(anchor="w", pady=(6, 0))
        self.player_target_var = tk.StringVar(value="")
        self.player_combo = ttk.Combobox(frame, textvariable=self.player_target_var, values=[""], width=20)
        self.player_combo.pack(fill="x", pady=2)
        self.player_combo.bind("<KeyRelease>", self.filter_player_combo)
        ttk.Label(frame, text="empty = not addressed; chat is prefixed with their name, /commands as-is", foreground="#777").pack(anchor="w", pady=(0, 2))

        say = ttk.Frame(frame)
        say.pack(fill="x", pady=2)
        self.say_var = tk.StringVar(value="")
        entry = ttk.Entry(say, textvariable=self.say_var)
        entry.pack(side="left", fill="x", expand=True)
        entry.bind("<Return>", lambda _event: self.on_say())
        ttk.Button(say, text="Send", width=6, command=self.on_say).pack(side="left", padx=(4, 0))

        ttk.Label(frame, text="text starting with / runs a command", foreground="#777").pack(anchor="w", pady=(2, 0))

        ttk.Button(frame, text="Clear log", command=self.on_clear).pack(fill="x", pady=2)

    def build_table(self, parent):
        frame = ttk.LabelFrame(parent, text="bots", padding=6)
        frame.pack(fill="both", expand=True, pady=(0, 8))

        columns = ("state", "mode", "hp", "food", "ping", "x", "y", "z", "error")
        self.tree = ttk.Treeview(frame, columns=columns, show="tree headings", height=12)

        self.tree.heading("#0", text="name")
        self.tree.column("#0", width=130, anchor="w")

        widths = {"state": 80, "mode": 70, "hp": 40, "food": 40, "ping": 50, "x": 60, "y": 60, "z": 60, "error": 200}
        for column in columns:
            self.tree.heading(column, text=column)
            self.tree.column(column, width=widths[column], anchor="w")

        scroll = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.tree.bind("<Double-1>", lambda _event: self.open_selected_detail())
        self.tree.bind("<Return>", lambda _event: self.open_selected_detail())

    def build_map(self, parent):
        frame = ttk.LabelFrame(parent, text="map (top-down) — double-click a dot", padding=6)
        frame.pack(fill="x", pady=(0, 8))
        self.map_canvas = tk.Canvas(frame, height=200, bg="#1e1e1e", highlightthickness=0)
        self.map_canvas.pack(fill="x", expand=True)
        self.map_canvas.bind("<Double-1>", self.on_map_double_click)

    def on_map_double_click(self, event):
        if not self.map_transform:
            return
        cx, cz, scale, w, h = self.map_transform
        best_name = None
        best_d = 10.0
        for name in self.last_map_points:
            wx = self.last_map_points[name][0]
            wz = self.last_map_points[name][1]
            sx = w / 2 + (wx - cx) * scale
            sz = h / 2 + (wz - cz) * scale
            d = math.hypot(event.x - sx, event.y - sz)
            if d < best_d:
                best_d = d
                best_name = name
        if best_name:
            self.open_bot_detail(best_name)

    def open_selected_detail(self):
        sel = self.tree.selection()
        if sel:
            self.open_bot_detail(sel[0])

    def open_bot_detail(self, name):
        if name in self.detail_windows:
            win = self.detail_windows[name]
            try:
                win.lift()
                return
            except Exception:
                pass
        win = tk.Toplevel(self.root)
        win.title(f"bot: {name}")
        win.geometry("560x520")
        self.detail_windows[name] = win

        info_var = tk.StringVar(value="…")
        ttk.Label(win, textvariable=info_var, wraplength=520).pack(fill="x", padx=10, pady=(10, 4))
        ttk.Label(win, text="heard chat").pack(anchor="w", padx=10)
        chat_box = scrolledtext.ScrolledText(win, height=8, wrap="word", state="disabled")
        chat_box.pack(fill="both", expand=True, padx=10, pady=(0, 6))
        ttk.Label(win, text="command as this bot (text starting with / runs). result appears below.").pack(anchor="w", padx=10)
        row = ttk.Frame(win)
        row.pack(fill="x", padx=10, pady=(2, 6))
        cmd_var = tk.StringVar(value="")
        cmd_entry = ttk.Entry(row, textvariable=cmd_var)
        cmd_entry.pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="Run", width=8, command=lambda: self.run_detail_command(name, cmd_var, result_box)).pack(side="left", padx=(4, 0))
        ttk.Label(win, text="command result").pack(anchor="w", padx=10)
        result_box = scrolledtext.ScrolledText(win, height=5, wrap="word", state="disabled")
        result_box.pack(fill="both", expand=True, padx=10, pady=(0, 10))

        alive = {"v": True}

        def refresh():
            if not alive["v"] or not win.winfo_exists():
                alive["v"] = False
                self.detail_windows.pop(name, None)
                return
            try:
                data = call(f"/bot/{name}", timeout=1.2)
                conn_at = data.get("connectedAt") or 0
                since = f"{int(time.time() - conn_at / 1000)}s ago" if conn_at else "—"
                txt = (
                    f"state: {data.get('state')}  mode: {data.get('mode')}  hazard: {data.get('hazard') or '—'}\n"
                    f"hp {data.get('health')}  food {data.get('food')}  ping {data.get('ping')}\n"
                    f"pos {data.get('x')}, {data.get('y')}, {data.get('z')}  yaw {data.get('yaw')}\n"
                    f"following: {data.get('followTarget') or '—'}\n"
                    f"deaths: {data.get('deaths')}  packs: {data.get('resourcePacks')}  connected {since}\n"
                    f"error: {data.get('error') or ''}\n"
                    f"fingerprint: {data.get('fingerprint') or '—'}\n"
                    f"persona: {data.get('persona') or '—'}"
                )
                if data.get('kickHistory'):
                    txt += "\nkicks: " + "; ".join(
                        f"{k.get('alive', '?')}s {k.get('reason')}" + (f" [last: {k.get('prelude')}]" if k.get('prelude') else "")
                        for k in data["kickHistory"])
                if data.get('recentEvents'):
                    txt += "\nevents: " + " ;; ".join(str(e.get('text', '')) for e in data["recentEvents"][-4:])
                info_var.set(txt)
                chat_box.configure(state="normal")
                chat_box.delete("1.0", "end")
                for line in data.get("recentChat", []):
                    if isinstance(line, dict):
                        chat_box.insert("end", f"[{line.get('t', 0)}] {line.get('text', '')}\n")
                    else:
                        chat_box.insert("end", f"{line}\n")
                chat_box.see("end")
                chat_box.configure(state="disabled")
            except Exception as exc:
                info_var.set(f"error: {exc}")
            if alive["v"]:
                win.after(1200, refresh)

        win.protocol("WM_DELETE_WINDOW", lambda: (alive.__setitem__("v", False), self.detail_windows.pop(name, None), win.destroy()))
        refresh()

    def run_detail_command(self, name, cmd_var, result_box):
        text = cmd_var.get().strip()
        if not text:
            return
        endpoint = "/command" if text.startswith("/") else "/say"
        try:
            resp = call(endpoint, {"text": text, "target": name}, timeout=6.0)
            result_box.configure(state="normal")
            resps = resp.get("responses", [])
            if not resps:
                result_box.insert("end", "(no response captured)\n")
            for r in resps:
                result_box.insert("end", f"[{r.get('name')}] {r.get('text')}\n")
            result_box.see("end")
            result_box.configure(state="disabled")
        except Exception as exc:
            messagebox.showerror("engine", f"could not reach engine: {exc}")
        cmd_var.set("")

    def build_log(self, parent):
        frame = ttk.LabelFrame(parent, text="engine log", padding=6)
        frame.pack(fill="both", expand=False)

        self.log_widget = scrolledtext.ScrolledText(frame, height=8, wrap="none", state="disabled")
        self.log_widget.pack(fill="both", expand=True)

        self.cmd_results = scrolledtext.ScrolledText(frame, height=5, wrap="word", state="disabled")
        self.cmd_results.pack(fill="both", expand=True, pady=(4, 0))

    def start_engine(self):
        if self.proc is not None and self.proc.poll() is None:
            return
        logfile = open(HERE / "engine.log", "a", encoding="utf-8")
        try:
            self.proc = subprocess.Popen(["node", "engine.mjs"], cwd=str(HERE), stdout=logfile, stderr=logfile)
        except FileNotFoundError:
            self.status_var.set("engine: node not found on PATH")
            return
        for _attempt in range(40):
            try:
                call("/status", timeout=0.6)
                self.status_var.set("engine: online")
                return
            except Exception:
                time.sleep(0.25)
        self.status_var.set("engine: failed to start (see engine.log)")

    def poll_loop(self):
        tick = 0
        while not self.stop_event.is_set():
            try:
                self.results.put(("status", call("/status", timeout=1.5)))
            except Exception as exc:
                self.results.put(("down", str(exc)))
            tick += 1
            if tick % 5 == 0:
                try:
                    self.results.put(("players", call("/players", timeout=1.5)))
                except Exception:
                    pass
            time.sleep(1.0)

    def drain(self):
        latest = None
        while True:
            try:
                kind, payload = self.results.get_nowait()
            except queue.Empty:
                break
            if kind == "status":
                latest = payload
            elif kind == "players":
                self.on_players(payload.get("players", []) if isinstance(payload, dict) else payload)
            else:
                self.status_var.set("engine: offline")
        if latest is not None:
            self.render(latest)
        self.root.after(250, self.drain)

    def on_players(self, players):
        try:
            names = [p.get("name") if isinstance(p, dict) else str(p) for p in players]
            names = sorted({n for n in names if n})
        except Exception:
            return
        if not names:
            return
        self.player_names = names
        self.filter_player_combo(None)
        self.filter_combo_into(self.follow_combo, self.follow_player_var)

    def filter_combo_into(self, combo, var):
        q = var.get().strip().lower()
        if q:
            vals = [""] + [n for n in self.player_names if q in n.lower()]
            if not vals[1:]:
                vals = [var.get().strip()]
        else:
            vals = [""] + self.player_names
        try:
            combo.configure(values=vals)
        except Exception:
            pass

    def filter_player_combo(self, event):
        self.filter_combo_into(self.player_combo, self.player_target_var)

    def on_follow_player_key(self, event):
        self.filter_combo_into(self.follow_combo, self.follow_player_var)

    def render(self, data):
        self.status_var.set("engine: online" if data.get("running") else "engine: idle")
        bots = data.get("bots", [])
        live = sum(1 for b in bots if b.get("state") == "spawned")
        self.count_var.set(f"{live} / {len(bots)} spawned")

        seen = set()
        for bot in bots:
            seen.add(bot["name"])
            values = (
                bot.get("state"),
                bot.get("mode") or "",
                "" if bot.get("health") is None else bot["health"],
                "" if bot.get("food") is None else bot["food"],
                "" if bot.get("ping") is None else bot["ping"],
                "" if bot.get("x") is None else bot["x"],
                "" if bot.get("y") is None else bot["y"],
                "" if bot.get("z") is None else bot["z"],
                (bot.get("error") or "")[:120],
            )
            if self.tree.exists(bot["name"]):
                self.tree.item(bot["name"], values=values)
            else:
                self.tree.insert("", "end", iid=bot["name"], text=bot["name"], values=values)

        for existing in self.tree.get_children():
            if existing not in seen:
                self.tree.delete(existing)

        # update target dropdown
        names = sorted(seen)
        self.bot_names = names
        cur = self.say_target_var.get()
        vals = ["all"] + names
        self.say_target.configure(values=vals)
        if cur not in vals:
            self.say_target_var.set("all")

        self.render_log(data.get("log", []))
        cfg = data.get("config") or {}
        self.render_map(bots, data.get("followPlayerPos"), cfg.get("followRadius", 5))

    def render_log(self, lines):
        if len(lines) < self.log_seen:
            self.log_seen = 0
        fresh = lines[self.log_seen:]
        if not fresh:
            return
        self.log_seen = len(lines)
        self.log_widget.configure(state="normal")
        for line in fresh:
            self.log_widget.insert("end", line + "\n")
        self.log_widget.see("end")
        self.log_widget.configure(state="disabled")

    def render_map(self, bots, follow_pos=None, follow_radius=5):
        c = self.map_canvas
        c.delete("all")
        pts = [(b.get("x"), b.get("z"), b.get("state"), b.get("name"), b.get("trail") or [], b.get("wp"), b.get("mode"), b.get("path") or []) for b in bots if b.get("x") is not None and b.get("z") is not None]
        self.last_map_points = {}
        if not pts:
            self.map_transform = None
            c.create_text(c.winfo_width() // 2 or 200, 100, text="no positions yet", fill="#888")
            return
        xs = [p[0] for p in pts]
        zs = [p[1] for p in pts]
        if follow_pos and follow_pos.get("x") is not None and follow_pos.get("z") is not None:
            xs.append(follow_pos["x"])
            zs.append(follow_pos["z"])
            try:
                r = float(follow_radius or 5)
                xs.extend([follow_pos["x"] - r, follow_pos["x"] + r])
                zs.extend([follow_pos["z"] - r, follow_pos["z"] + r])
            except Exception:
                pass
        minx, maxx = min(xs), max(xs)
        minz, maxz = min(zs), max(zs)
        spanx = max(1.0, maxx - minx)
        spanz = max(1.0, maxz - minz)
        w = max(200, c.winfo_width())
        h = 200
        pad = 12
        scale = min((w - 2 * pad) / spanx, (h - 2 * pad) / spanz)
        cx = (minx + maxx) / 2.0
        cz = (minz + maxz) / 2.0
        self.map_transform = (cx, cz, scale, w, h)

        def to_px(wx, wz):
            return (w / 2 + (wx - cx) * scale, h / 2 + (wz - cz) * scale)

        # pathfinding: recent trails + destination legs, under the dots
        for x, z, state, name, trail, wp, mode, path in pts:
            col = "#3aa655" if mode == "follow" else ("#2f9d8f" if mode == "walk" else "#555555")
            if len(path) >= 2:
                coords = []
                for pxw, pzw in path:
                    px, pz = to_px(pxw, pzw)
                    coords.extend([px, pz])
                c.create_line(*coords, fill="#7c4dff" if mode == "follow" else ("#9b7bd4" if mode == "walk" else "#999999"), width=2)
            if len(trail) >= 2:
                coords = []
                for tx, tz in trail:
                    px, pz = to_px(tx, tz)
                    coords.extend([px, pz])
                c.create_line(*coords, fill=col, width=1, stipple="gray50")
            if wp and (mode == "walk" or mode == "follow"):
                px, pz = to_px(x, z)
                qx, qz = to_px(wp["x"], wp["z"])
                c.create_line(px, pz, qx, qz, fill=col, width=1, dash=(3, 3))

        for x, z, state, name, trail, wp, mode, path in pts:
            sx, sz = to_px(x, z)
            self.last_map_points[name] = (x, z)
            color = "#4caf50" if state == "spawned" else ("#ff9800" if state in ("connecting", "born") else "#f44336")
            c.create_oval(sx - 3, sz - 3, sx + 3, sz + 3, fill=color, outline="")
        # followed player marker
        if follow_pos and follow_pos.get("x") is not None:
            px, pz = to_px(follow_pos["x"], follow_pos["z"])
            try:
                rpx = float(follow_radius or 5) * scale
            except Exception:
                rpx = 18
            c.create_oval(px - rpx, pz - rpx, px + rpx, pz + rpx, outline="#e74c3c", width=1, dash=(4, 4))
            c.create_oval(px - 5, pz - 5, px + 5, pz + 5, fill="#e74c3c", outline="#ffffff", width=1)
            c.create_text(px, pz - 11, text=str(follow_pos.get("name") or "player"), fill="#e74c3c", font=("Segoe UI", 8, "bold"))
        # legend
        c.create_text(8, 8, anchor="nw", text=f"{len(pts)} bots  scale {scale:.1f}px/block  violet=planned path  dotted=trail  dashed=dest", fill="#aaa", font=("Segoe UI", 8))

    def collect(self):
        try:
            count = int(self.count_entry_var.get())
            port = int(self.port_var.get())
            stagger = int(self.stagger_var.get())
            spawn_wait = float(self.spawn_wait_var.get())
            interval = float(self.chat_interval_var.get())
            chance = float(self.chat_chance_var.get())
            wander = float(self.wander_var.get())
            look_speed = float(self.look_speed_var.get())
            sprint_chance = float(self.sprint_chance_var.get())
            sneak_chance = float(self.sneak_chance_var.get())
            follow_chance = float(self.follow_chance_var.get())
            follow_radius = float(self.follow_radius_var.get())
        except ValueError as exc:
            messagebox.showerror("bad value", str(exc))
            return None
        if not math.isfinite(spawn_wait) or spawn_wait < 0:
            messagebox.showerror("bad value", "after spawn (s) must be a finite number zero or greater")
            return None
        messages = [line.strip() for line in self.messages_text.get("1.0", "end").splitlines() if line.strip()]
        payload = {
            "host": self.host_var.get().strip(),
            "port": port,
            "count": count,
            "prefix": self.prefix_var.get().strip() or "lt_",
            "version": self.version_var.get().strip(),
            "staggerMs": stagger,
            "waitForPreviousSpawn": bool(self.wait_for_spawn_var.get()),
            "spawnWaitSeconds": spawn_wait,
            "viewDistance": self.view_var.get(),
            "movement": bool(self.movement_var.get()),
            "autoReconnect": bool(self.reconnect_var.get()),
            "chatIntervalMs": int(interval * 1000),
            "chatChance": max(0.0, min(1.0, chance)),
            "messages": messages,
            "realisticNames": bool(self.realistic_var.get()),
            "wanderRadius": wander,
            "lookSpeed": look_speed,
            "sprintChance": max(0.0, min(1.0, sprint_chance)),
            "sneakChance": max(0.0, min(1.0, sneak_chance)),
            "fingerprint": bool(self.fingerprint_var.get()),
            "resourcePackMode": self.resource_pack_var.get() or "accept",
            "followChance": max(0.0, min(1.0, follow_chance)),
            "followRadius": follow_radius,
            "followRealPlayers": bool(self.follow_real_var.get()),
            "followPlayer": self.follow_player_var.get().strip() or "",
            "pathfinding": bool(self.path_var.get()),
        }
        for key, _, _ in PACKET_DEFS:
            payload[key] = bool(self.packet_vars[key].get())
        return payload

    def on_start(self):
        payload = self.collect()
        if payload is None:
            return
        try:
            call("/start", payload, timeout=5.0)
        except Exception as exc:
            messagebox.showerror("engine", f"could not reach engine: {exc}")
            return
        self.log_seen = 0
        self.status_var.set("starting")
        try:
            self.save_cached()
        except Exception:
            pass

    def on_stop(self):
        try:
            call("/stop", {}, timeout=5.0)
        except Exception as exc:
            messagebox.showerror("engine", f"could not reach engine: {exc}")

    def on_say(self):
        text = self.say_var.get().strip()
        if not text:
            return
        target = self.say_target_var.get().strip() or "all"
        player = ""
        try:
            player = self.player_target_var.get().strip()
        except Exception:
            player = ""
        endpoint = "/command" if text.startswith("/") else "/say"
        payload = {"text": text, "target": target}
        if player:
            payload["player"] = player
        try:
            resp = call(endpoint, payload, timeout=6.0)
            resps = resp.get("responses", [])
            if resps:
                self.cmd_results.configure(state="normal")
                for r in resps:
                    self.cmd_results.insert("end", f"[{r['name']}] {r['text']}\n")
                self.cmd_results.see("end")
                self.cmd_results.configure(state="disabled")
        except Exception as exc:
            messagebox.showerror("engine", f"could not reach engine: {exc}")
        self.say_var.set("")

    def on_clear(self):
        self.log_widget.configure(state="normal")
        self.log_widget.delete("1.0", "end")
        self.log_widget.configure(state="disabled")

    def on_close(self):
        self.stop_event.set()
        try:
            self.save_cached()
        except Exception:
            pass
        try:
            call("/shutdown", {}, timeout=1.5)
        except Exception:
            pass
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except Exception:
                pass
        self.root.destroy()


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("clam")
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
