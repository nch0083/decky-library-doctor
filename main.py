import asyncio
import base64
import json
import os
import shutil
import struct
import threading
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import decky


class Plugin:
    MAX_DISCOVERED_EXES = 5000
    MAX_ARTWORK_PREVIEW_BYTES = 3 * 1024 * 1024
    ARTWORK_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
    SIZE_CACHE_TTL_SECONDS = 6 * 60 * 60

    def _settings_file(self) -> Path:
        return Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "settings.json"

    def _load_settings(self):
        defaults = {
            "watchedFolders": [],
            "recursiveFolderScan": True,
            "ignoredExecutables": [],
            "defaultCompatTool": "",
        }
        path = self._settings_file()
        if not path.exists():
            return defaults

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            raw_folders = data.get("watchedFolders")
            if not isinstance(raw_folders, list):
                # v0.7 and earlier migration
                legacy = str(data.get("watchedFolder", "")).strip()
                raw_folders = [legacy] if legacy else []
            watched_folders = []
            for value in raw_folders:
                value = str(value or "").strip()
                if value and value not in watched_folders:
                    watched_folders.append(value)
            ignored = []
            raw_ignored = data.get("ignoredExecutables", [])
            if isinstance(raw_ignored, list):
                for value in raw_ignored:
                    value = self._canonical_path(str(value or ""))
                    if value and value not in ignored:
                        ignored.append(value)
            return {
                "watchedFolders": watched_folders,
                "recursiveFolderScan": True,
                "ignoredExecutables": ignored,
                "defaultCompatTool": str(data.get("defaultCompatTool", defaults["defaultCompatTool"]) or ""),
            }
        except Exception as exc:
            decky.logger.exception("Failed reading Library Doctor settings: %s", exc)
            return defaults


    def _protected_delete_paths(self):
        protected = {
            "/", "/home", "/home/deck", "/run", "/run/media", "/run/media/deck",
            "/mnt", "/media",
        }
        for folder in self._load_settings().get("watchedFolders", []):
            c = self._canonical_path(folder)
            if c:
                protected.add(c)
        return protected

    def _validate_delete_target(self, target_path: str, exe_path: str = ""):
        target = self._canonical_path(target_path)
        exe = self._canonical_path(exe_path) if exe_path else ""
        if not target or not os.path.isabs(target):
            return False, "Deletion target must be an absolute path.", target
        if target in self._protected_delete_paths():
            return False, "Protected/root folder cannot be deleted.", target
        p = Path(target)
        # Refuse dangerously shallow paths such as /home/foo or /run/media/card.
        if len(p.parts) < 4:
            return False, "Deletion target is too close to a filesystem root.", target
        storage = self._storage_root(target)
        if storage and target == self._canonical_path(storage):
            return False, "Storage root cannot be deleted.", target
        if exe:
            try:
                Path(exe).relative_to(Path(target))
            except ValueError:
                return False, "Executable is outside the selected deletion folder.", target
        return True, "", target

    async def prepare_delete_candidate(self, exe_path: str, start_dir: str = ""):
        exe = self._canonical_path(exe_path)
        settings = self._load_settings()
        suggested = ""
        for watched in settings.get("watchedFolders", []):
            watched_path = Path(self._canonical_path(watched))
            try:
                Path(exe).relative_to(watched_path)
            except (ValueError, OSError):
                continue
            root, _confidence = self._infer_game_root(exe, watched_path)
            if root:
                suggested = self._canonical_path(root)
                break
        if not suggested:
            start = self._canonical_path(start_dir) if start_dir else ""
            if start:
                try:
                    Path(exe).relative_to(Path(start))
                    suggested = start
                except ValueError:
                    pass
        if not suggested:
            suggested = str(Path(exe).parent) if exe else ""
        ok, reason, suggested = self._validate_delete_target(suggested, exe)
        return {"exePath": exe, "deletePath": suggested, "canDelete": ok, "reason": reason}

    async def adjust_delete_path(self, current_path: str, exe_path: str, direction: str):
        current = Path(self._canonical_path(current_path))
        exe = Path(self._canonical_path(exe_path))
        candidate = current
        if direction == "wider":
            parent = current.parent
            if parent != current:
                candidate = parent
        elif direction == "narrower":
            try:
                rel = exe.relative_to(current)
                # Walk one level toward the executable, but never select the executable itself.
                if len(rel.parts) > 1:
                    candidate = current / rel.parts[0]
            except ValueError:
                pass
        ok, reason, normalized = self._validate_delete_target(str(candidate), str(exe))
        return {"deletePath": normalized, "canDelete": ok, "reason": reason}

    async def delete_game_directory(self, target_path: str, exe_path: str):
        ok, reason, target = self._validate_delete_target(target_path, exe_path)
        if not ok:
            return {"success": False, "error": reason, "path": target}
        p = Path(target)
        if not p.exists():
            return {"success": True, "path": target, "alreadyMissing": True}
        if not p.is_dir():
            return {"success": False, "error": "Deletion target is not a directory.", "path": target}
        try:
            shutil.rmtree(p)
            return {"success": True, "path": target, "alreadyMissing": False}
        except Exception as exc:
            decky.logger.exception("Failed deleting game directory %s: %s", target, exc)
            return {"success": False, "error": str(exc), "path": target}

    async def get_settings(self):
        return self._load_settings()

    async def save_settings(self, watched_folders, recursive_folder_scan: bool, ignored_executables=None, default_compat_tool: str = ""):
        if not isinstance(watched_folders, list):
            watched_folders = []
        cleaned = []
        for value in watched_folders:
            value = str(value or "").strip()
            if value and value not in cleaned:
                cleaned.append(value)
        ignored = []
        if isinstance(ignored_executables, list):
            for value in ignored_executables:
                value = self._canonical_path(str(value or ""))
                if value and value not in ignored:
                    ignored.append(value)
        else:
            ignored = self._load_settings().get("ignoredExecutables", [])
        settings = {
            "watchedFolders": cleaned,
            "recursiveFolderScan": True,
            "ignoredExecutables": ignored,
            "defaultCompatTool": str(default_compat_tool or ""),
        }
        path = self._settings_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
        return settings

    def _steam_userdata_root(self) -> Path:
        return Path(decky.DECKY_USER_HOME) / ".local" / "share" / "Steam" / "userdata"

    def _candidate_shortcuts_files(self):
        root = self._steam_userdata_root()
        if not root.exists():
            return []

        candidates = []
        for child in root.iterdir():
            if not child.is_dir():
                continue
            p = child / "config" / "shortcuts.vdf"
            if p.exists():
                candidates.append(p)
        return candidates

    def _normalize_exe(self, value: str) -> str:
        value = (value or "").strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1]
        value = os.path.expanduser(os.path.expandvars(value))
        return os.path.normpath(value) if value else value

    def _canonical_path(self, value: str) -> str:
        normalized = self._normalize_exe(value)
        if not normalized:
            return ""
        try:
            return os.path.realpath(normalized)
        except Exception:
            return normalized

    def _scan_path(self, value: str) -> str:
        """Normalize a watched/discovered path without resolving symlinks.

        Discovery must stay inside the folder the user actually selected. Using
        realpath() on the watched root can silently redirect a lexical path into
        another Steam/library tree and makes scan scope difficult to reason about.
        """
        value = str(value or "").strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        value = os.path.expanduser(os.path.expandvars(value))
        return os.path.abspath(os.path.normpath(value)) if value else ""

    def _is_utility_shortcut(self, name: str, exe: str, launch_options: str) -> bool:
        """Hide obvious desktop applications/generic launchers from cleanup views.

        They remain part of the total shortcut count and are never deleted automatically.
        """
        lname = (name or "").strip().lower()
        lex = self._canonical_path(exe).lower()
        lopts = (launch_options or "").strip().lower()
        base = os.path.basename(lex)

        # Generic application launchers create false duplicate groups because many apps
        # share the same executable and differ only in LaunchOptions.
        if base in {"flatpak", "snap", "xdg-open"}:
            return True
        if base == "flatpak" or ("flatpak" in lex and lopts.startswith("run ")):
            return True

        browser_tokens = (
            "google chrome", "chrome", "chromium", "microsoft edge",
            "firefox", "brave", "vivaldi", "opera",
        )
        if any(token in lname for token in browser_tokens):
            return True
        if any(token in base for token in ("chrome", "chromium", "firefox", "brave", "vivaldi", "opera")):
            return True

        # Steam/SteamOS desktop helper shortcuts are useful applications, not games.
        # Hiding them prevents noisy Missing/Duplicate groups when their launch paths
        # change across SteamOS updates.
        desktop_shortcut_tokens = (
            "nested desktop",
            "nested desktop mode",
            "return to gaming mode",
        )
        if any(token in lname for token in desktop_shortcut_tokens):
            return True
        return False

    def _is_non_game_executable(self, path: Path) -> bool:
        """Filter helper/setup/runtime executables from EXE discovery.

        This intentionally uses conservative filename rules only. Directory names are
        not used so a game installed under folders such as 'setup' or 'tools' is not
        accidentally hidden.
        """
        stem = path.stem.strip().lower().replace("-", "_")
        compact = stem.replace(" ", "").replace("_", "")

        exact = {
            "python", "pythonw", "zsync",
            "setup", "install", "installer", "uninstall", "uninstaller",
            "notification", "payload", "exprotocol",
            "unitycrashhandler", "unitycrashhandler32", "unitycrashhandler64",
            "crashpadhandler", "crashreportclient",
            "dxsetup", "vcredist", "vcredistx86", "vcredistx64",
        }
        if compact in exact:
            return True

        prefixes = (
            "python",
            "zsync",
            "setup",
            "uninstall",
            "unins",
            "notification",
            "unitycrashhandler",
            "payload",
            "exprotocol",
            "vcredist",
            "vc_redist",
            "crashpadhandler",
        )
        return any(stem.startswith(prefix) or compact.startswith(prefix.replace("_", "")) for prefix in prefixes)


    def _looks_like_game_root(self, folder: Path) -> bool:
        """Conservatively detect whether a folder itself looks like one game install root.

        The same directory can be checked many times while scanning a parent that holds
        many games, so cache the result for the lifetime of one scan. This avoids
        repeatedly enumerating large directories on slow SD cards.
        """
        key = self._canonical_path(str(folder))
        cache = getattr(self, "_game_root_marker_cache", None)
        if cache is not None and key in cache:
            return cache[key]

        result = False
        try:
            if not folder.exists() or not folder.is_dir():
                result = False
            else:
                entries = list(folder.iterdir())
                names = {entry.name.lower() for entry in entries}

                # Common engine/layout markers found at a game's install root.
                if any(name in names for name in ("binaries", "engine", "content")):
                    result = True
                elif any(entry.is_dir() and entry.name.lower().endswith("_data") for entry in entries):
                    result = True
                else:
                    # Common runtime files. Keep this intentionally narrow.
                    for entry in entries:
                        if not entry.is_file():
                            continue
                        name = entry.name.lower()
                        if name in {"unityplayer.dll", "gameassembly.dll"}:
                            result = True
                            break
                        if name.startswith("steam_api") and name.endswith(".dll"):
                            result = True
                            break
                        if name.endswith(".pak"):
                            result = True
                            break
        except (OSError, PermissionError):
            result = False

        if cache is not None:
            cache[key] = result
        return result

    def _infer_game_root(self, exe_path: str, watched_folder: Path):
        """Infer one game's root using path structure only.

        Do not inspect directory contents here. Older builds called iterdir()/stat
        repeatedly while evaluating every EXE, which could stall indefinitely on
        large/removable libraries. The watched-folder layout is enough for grouping:
        /Games/GameName/... and /Games/H/GameName/... are both handled.
        """
        try:
            watched = Path(os.path.normpath(str(watched_folder)))
            exe = Path(os.path.normpath(exe_path))
            rel = exe.relative_to(watched)
        except (ValueError, OSError):
            return None, None

        parts = rel.parts
        if not parts:
            return None, None
        if len(parts) == 1:
            return str(watched), "fallback"

        common_internal_dirs = {
            "binaries", "binary", "bin", "engine", "content", "data",
            "win64", "win32", "x64", "x86", "game", "redist", "tools"
        }
        first = parts[0]
        if first.lower() in common_internal_dirs:
            return str(watched), "fallback"

        # Alphabet/number bucket layout: /Games/H/GameName/...
        if len(parts) >= 3 and len(first) == 1 and first.isalnum():
            return str(watched / first / parts[1]), "fallback"

        return str(watched / first), "fallback"

    def _registered_game_roots(self, registered_exes, watched_folder: Path):
        roots = set()
        for exe in registered_exes:
            if not exe:
                continue
            root, _confidence = self._infer_game_root(exe, watched_folder)
            if root:
                roots.add(self._scan_path(root))
        return roots

    def _game_candidate_score(self, path: Path):
        """Heuristic game-likelihood score for discovered EXEs (0-100)."""
        score = 50
        stem = path.stem.lower()
        lpath = str(path).lower()

        strong_tokens = ("game", "win64", "shipping", "binaries", "x64")
        weak_tokens = ("launcher", "client", "start")
        helper_tokens = ("helper", "service", "updater", "update", "patcher", "bootstrap", "diagnostic", "report")

        if any(t in lpath for t in ("/binaries/win64/", "\\binaries\\win64\\")):
            score += 25
        if stem.endswith("-win64-shipping") or stem.endswith("_win64_shipping"):
            score += 25
        elif any(t in stem for t in strong_tokens):
            score += 10
        if any(t in stem for t in weak_tokens):
            score += 2
        if any(t in stem for t in helper_tokens):
            score -= 25

        # Do not stat every discovered executable here. On Downloads/removable
        # trees a single problematic file can block the scanner and make even
        # cancellation appear hung. Filename/path heuristics are intentionally
        # used alone during discovery; no file metadata is required.

        score = max(0, min(100, score))
        label = "high" if score >= 70 else "medium" if score >= 45 else "low"
        return score, label

    def _storage_root(self, exe_path: str):
        prefix = "/run/media/"
        if not exe_path.startswith(prefix):
            return None

        parts = Path(exe_path).parts
        if len(parts) >= 5 and parts[1:3] == ("run", "media") and parts[3] == "deck":
            return str(Path(*parts[:5]))
        if len(parts) >= 4 and parts[1:3] == ("run", "media"):
            return str(Path(*parts[:4]))
        return None

    def _status_for_exe(self, exe_path: str):
        if not exe_path:
            return "invalid", None
        if os.path.exists(exe_path):
            return "healthy", None
        storage_root = self._storage_root(exe_path)
        if storage_root and not os.path.exists(storage_root):
            return "storage_offline", storage_root
        return "missing", storage_root

    def _parse_binary_vdf(self, path: Path):
        data = path.read_bytes()
        pos = 0

        def read_cstr():
            nonlocal pos
            end = data.find(b"\x00", pos)
            if end < 0:
                raise ValueError("Invalid VDF: unterminated string")
            value = data[pos:end].decode("utf-8", errors="replace")
            pos = end + 1
            return value

        def need(n):
            if pos + n > len(data):
                raise ValueError("Invalid VDF: unexpected EOF")

        def parse_object():
            nonlocal pos
            obj = {}
            while pos < len(data):
                type_byte = data[pos]
                pos += 1
                if type_byte == 0x08:
                    break
                key = read_cstr()
                if type_byte == 0x00:
                    obj[key] = parse_object()
                elif type_byte == 0x01:
                    obj[key] = read_cstr()
                elif type_byte in (0x02, 0x04):
                    need(4)
                    obj[key] = struct.unpack_from("<I", data, pos)[0]
                    pos += 4
                elif type_byte == 0x03:
                    need(4)
                    obj[key] = struct.unpack_from("<f", data, pos)[0]
                    pos += 4
                elif type_byte == 0x05:
                    chars = bytearray()
                    while True:
                        need(2)
                        pair = data[pos:pos + 2]
                        pos += 2
                        if pair == b"\x00\x00":
                            break
                        chars.extend(pair)
                    obj[key] = chars.decode("utf-16-le", errors="replace")
                elif type_byte == 0x06:
                    need(4)
                    obj[key] = data[pos:pos + 4]
                    pos += 4
                elif type_byte == 0x07:
                    need(8)
                    obj[key] = struct.unpack_from("<Q", data, pos)[0]
                    pos += 8
                elif type_byte == 0x0A:
                    need(8)
                    obj[key] = struct.unpack_from("<q", data, pos)[0]
                    pos += 8
                else:
                    raise ValueError(f"Unsupported VDF type 0x{type_byte:02x} at offset {pos - 1}")
            return obj

        return parse_object()

    def _find_artwork_file(self, grid_dir: Path, stem: str):
        for ext in self.ARTWORK_EXTENSIONS:
            candidate = grid_dir / f"{stem}{ext}"
            if candidate.exists() and candidate.is_file():
                return candidate
        return None

    def _artwork_summary(self, appid, shortcuts_path: Path):
        empty = {
            "capsule": False,
            "wide": False,
            "hero": False,
            "logo": False,
            "icon": False,
            "count": 0,
        }
        if not isinstance(appid, int):
            return empty

        grid_dir = shortcuts_path.parent / "grid"
        appid_text = str(appid & 0xFFFFFFFF)
        slots = {
            "capsule": self._find_artwork_file(grid_dir, f"{appid_text}p"),
            "wide": self._find_artwork_file(grid_dir, appid_text),
            "hero": self._find_artwork_file(grid_dir, f"{appid_text}_hero"),
            "logo": self._find_artwork_file(grid_dir, f"{appid_text}_logo"),
            "icon": self._find_artwork_file(grid_dir, f"{appid_text}_icon"),
        }
        result = {key: value is not None for key, value in slots.items()}
        result["count"] = sum(1 for value in slots.values() if value is not None)
        return result

    def _all_grid_dirs(self):
        dirs = []
        for shortcuts in self._candidate_shortcuts_files():
            grid = shortcuts.parent / "grid"
            if grid.exists() and grid.is_dir():
                dirs.append(grid)
        return dirs

    def _mime_for_artwork(self, path: Path):
        ext = path.suffix.lower()
        return {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(ext, "application/octet-stream")

    async def get_artwork_preview(self, app_id: int):
        try:
            appid = int(app_id) & 0xFFFFFFFF
        except Exception:
            return {"items": [], "error": "Invalid AppID"}

        preferred = [
            ("capsule", f"{appid}p"),
            ("wide", str(appid)),
            ("hero", f"{appid}_hero"),
            ("logo", f"{appid}_logo"),
            ("icon", f"{appid}_icon"),
        ]
        items = []
        seen = set()
        for grid_dir in self._all_grid_dirs():
            for slot, stem in preferred:
                artwork = self._find_artwork_file(grid_dir, stem)
                if not artwork or str(artwork) in seen:
                    continue
                seen.add(str(artwork))
                try:
                    size = artwork.stat().st_size
                    entry = {"found": True, "slot": slot, "fileName": artwork.name, "size": size}
                    if size <= self.MAX_ARTWORK_PREVIEW_BYTES:
                        encoded = base64.b64encode(artwork.read_bytes()).decode("ascii")
                        entry["tooLarge"] = False
                        entry["dataUrl"] = f"data:{self._mime_for_artwork(artwork)};base64,{encoded}"
                    else:
                        entry["tooLarge"] = True
                    items.append(entry)
                    if len(items) >= 2:
                        return {"items": items}
                except Exception as exc:
                    decky.logger.warning("Artwork read failed for %s: %s", artwork, exc)
        return {"items": items}

    def _read_shortcuts(self, path: Path):
        data = self._parse_binary_vdf(path)
        shortcuts = data.get("shortcuts", {})
        items = []
        if not isinstance(shortcuts, dict):
            return items

        for key, sc in shortcuts.items():
            if not isinstance(sc, dict):
                continue
            lower = {str(k).lower(): v for k, v in sc.items()}
            name = str(lower.get("appname", "Unnamed shortcut"))
            exe = self._normalize_exe(str(lower.get("exe", "")))
            status, storage_root = self._status_for_exe(exe)
            appid = lower.get("appid")
            if isinstance(appid, int):
                appid &= 0xFFFFFFFF
            else:
                appid = None

            launch_options = str(lower.get("launchoptions", ""))
            artwork = self._artwork_summary(appid, path)
            utility_shortcut = self._is_utility_shortcut(name, exe, launch_options)

            items.append({
                "key": str(key),
                "appId": appid,
                "artwork": artwork,
                "name": name,
                "exe": exe,
                "startDir": self._normalize_exe(str(lower.get("startdir", ""))),
                "launchOptions": launch_options,
                "status": status,
                "storageRoot": storage_root,
                "utilityShortcut": utility_shortcut,
                "shortcutsFile": str(path),
            })
        return items

    def _duplicate_groups(self, items):
        groups = defaultdict(list)
        for item in items:
            if item.get("utilityShortcut"):
                continue
            canonical = self._canonical_path(item.get("exe", ""))
            if canonical:
                groups[canonical].append(item)

        result = []
        for canonical, members in groups.items():
            if len(members) < 2:
                continue
            result.append({
                "exe": canonical,
                "count": len(members),
                "items": members,
            })
        result.sort(key=lambda group: (-group["count"], group["exe"].lower()))
        return result

    def _scan_unregistered_exes(self, registered_exes, settings, cancel_event=None, scan_id=None):
        raw_folders = settings.get("watchedFolders", [])
        if not isinstance(raw_folders, list) or not raw_folders:
            # No watched folders is a valid configuration. Keep the return
            # shape identical to the normal scan path so callers can safely
            # unpack (items, error, truncated, cancelled).
            return [], None, False, False

        recursive = True
        # Discovery must be purely lexical. realpath()/stat on arbitrary
        # Downloads trees can block on broken links, FUSE mounts or stale media.
        registered_paths = [self._scan_path(path) for path in registered_exes if path]
        registered = set(registered_paths)
        discovered_by_path = {}
        errors = []
        truncated = False
        visited_count = 0
        exe_count = 0

        def update_progress(current_folder="", root_folder=""):
            if scan_id is None:
                return
            with self._scan_state_lock:
                if self._scan_state.get("scanId") != scan_id:
                    return
                now = time.time()
                if self._scan_state.get("phase") != "walking":
                    self._scan_state["phaseStartedAt"] = now
                self._scan_state.update({
                    "active": True,
                    "currentFolder": str(current_folder or ""),
                    "rootFolder": str(root_folder or self._scan_state.get("rootFolder", "")),
                    "visitedFolders": visited_count,
                    "foundExes": exe_count,
                    "phase": "walking",
                    "phaseDetail": "directory traversal",
                    "lastUpdateAt": now,
                })

        for raw_folder in raw_folders:
            if cancel_event is not None and cancel_event.is_set():
                break
            raw_folder = str(raw_folder or "").strip()
            if not raw_folder:
                continue
            folder = Path(self._scan_path(raw_folder))
            if not folder.exists():
                errors.append(f"Not found: {folder}")
                continue
            if not folder.is_dir():
                errors.append(f"Not a folder: {folder}")
                continue

            registered_game_roots = self._registered_game_roots(registered_paths, folder)
            update_progress(folder, folder)

            def consider(path: Path):
                nonlocal truncated, exe_count
                if path.suffix.lower() != ".exe":
                    return
                exe_count += 1
                if exe_count % 4 == 0:
                    update_progress(path.parent, folder)
                if self._is_non_game_executable(path):
                    return
                candidate_path = self._scan_path(str(path))
                root_path = self._scan_path(str(folder))
                try:
                    if os.path.commonpath([candidate_path, root_path]) != root_path:
                        errors.append(f"Out of scope skipped: {candidate_path}")
                        return
                except (ValueError, OSError):
                    return
                if candidate_path in registered or candidate_path in discovered_by_path:
                    return

                # If another executable from the same inferred game folder is already
                # registered in Steam, do not list this helper/alternate executable as
                # an unregistered game. Ambiguous roots return None and remain visible.
                inferred_root, _confidence = self._infer_game_root(candidate_path, folder)
                if inferred_root and self._scan_path(inferred_root) in registered_game_roots:
                    return

                score, score_label = self._game_candidate_score(path)
                group_root = self._scan_path(inferred_root) if inferred_root else self._scan_path(str(path.parent))
                discovered_by_path[candidate_path] = {
                    "name": path.name,
                    "path": candidate_path,
                    "relativePath": os.path.relpath(candidate_path, str(folder)),
                    "rootFolder": str(folder),
                    "gameRoot": group_root,
                    "gameName": Path(group_root).name or path.stem,
                    "candidateScore": score,
                    "candidateLabel": score_label,
                }
                if len(discovered_by_path) >= self.MAX_DISCOVERED_EXES:
                    truncated = True

            try:
                # SteamOS SD/external libraries can contain symlinked directories.
                # Walk them explicitly while tracking resolved directories so links are
                # followed without allowing cycles. Permission failures are isolated to
                # the affected directory instead of aborting the whole watched folder.
                # (path, depth). Keep traversal bounded: normal game layouts are
                # shallow, while accidental symlink/mount trees can become enormous.
                pending = [(folder, 0)]
                visited_dirs = set()
                max_depth = 16
                # Large asset/cache trees almost never contain the game's primary
                # executable and are extremely expensive to traverse on SD cards.
                # Keep this list conservative: executable-bearing folders such as
                # Binaries, Win64, bin, Engine and *_Data are intentionally NOT
                # skipped.
                skip_dir_names = {
                    # Large asset/cache trees.
                    "paks", "movies", "screenshots", "logs", "log",
                    "shadercache", "shader_cache", "deriveddatacache",
                    "node_modules", "__pycache__", ".git", ".svn",
                    "crashreports", "crashreport", "temp", "tmp",
                    # Windows/Wine runtime trees frequently found under Downloads.
                    # They contain thousands of helper EXEs but are not game roots.
                    "windows", "system32", "syswow64", "winsxs",
                    "programdata", "appdata", "microsoft.net", "assembly",
                    "servicing", "installer", "fonts"
                }
                while pending and not truncated and not (cancel_event is not None and cancel_event.is_set()):
                    current, depth = pending.pop()
                    visited_count += 1
                    if visited_count == 1 or visited_count % 8 == 0:
                        update_progress(current, folder)
                    try:
                        # Do not call realpath() for every directory. On removable
                        # filesystems that can block on a problematic symlink/mount.
                        current_key = os.path.normcase(os.path.normpath(str(current)))
                        if current_key in visited_dirs:
                            continue
                        visited_dirs.add(current_key)
                        with os.scandir(current) as entries:
                            for entry in entries:
                                if cancel_event is not None and cancel_event.is_set():
                                    break
                                name = entry.name
                                if name.startswith("."):
                                    continue
                                lname = name.lower()
                                try:
                                    # Fast path: only stat regular files when the
                                    # filename can actually be a candidate. The old
                                    # implementation called is_file() for every asset.
                                    # Never resolve file symlinks during discovery. A broken
                                    # or remote symlink can block in stat()/realpath() and cannot
                                    # be interrupted cleanly from a Python thread.
                                    if entry.is_symlink():
                                        continue

                                    if lname.endswith(".exe"):
                                        if entry.is_file(follow_symlinks=False):
                                            consider(Path(entry.path))
                                            if truncated:
                                                break
                                        continue

                                    # Everything else only needs a directory check.
                                    # DirEntry usually answers this from d_type without
                                    # an extra filesystem stat, which matters on SD.
                                    if lname in skip_dir_names or depth >= max_depth:
                                        continue

                                    if entry.is_dir(follow_symlinks=False):
                                        pending.append((Path(entry.path), depth + 1))
                                except OSError as exc:
                                    errors.append(f"{entry.path}: {exc}")
                    except (PermissionError, FileNotFoundError, OSError) as exc:
                        errors.append(f"{current}: {exc}")
            except Exception as exc:
                errors.append(f"{folder}: {exc}")
            if truncated:
                break

        if scan_id is not None:
            with self._scan_state_lock:
                if self._scan_state.get("scanId") == scan_id:
                    now = time.time()
                    self._scan_state.update({
                        "phase": "sort_unregistered",
                        "phaseDetail": f"{len(discovered_by_path)} candidate(s)",
                        "currentFolder": "",
                        "lastUpdateAt": now,
                        "phaseStartedAt": now,
                    })
        discovered = list(discovered_by_path.values())
        discovered.sort(key=lambda item: (item["rootFolder"].lower(), item["relativePath"].lower()))
        cancelled = bool(cancel_event is not None and cancel_event.is_set())
        return discovered, "; ".join(errors) if errors else None, truncated, cancelled


    def _size_cache_file(self) -> Path:
        return Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "folder_sizes.json"

    def _load_size_cache(self):
        path = self._size_cache_file()
        if not path.exists():
            return {"version": 1, "entries": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
                raise ValueError("invalid cache")
            return data
        except Exception:
            return {"version": 1, "entries": {}}

    def _save_size_cache(self, cache):
        path = self._size_cache_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)

    def _folder_size_sync(self, root: str) -> int:
        total = 0
        stack = [root]
        while stack:
            current = stack.pop()
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(entry.path)
                            elif entry.is_file(follow_symlinks=False):
                                total += entry.stat(follow_symlinks=False).st_size
                        except (OSError, PermissionError):
                            continue
            except (OSError, PermissionError, FileNotFoundError):
                continue
        return total

    def _storage_game_root(self, item, watched):
        exe = self._canonical_path(item.get("exe", ""))
        if not exe:
            return ""
        matching = []
        for folder in watched:
            try:
                Path(exe).relative_to(folder)
                matching.append(folder)
            except (ValueError, OSError):
                continue
        for folder in sorted(matching, key=lambda value: len(str(value)), reverse=True):
            root, _confidence = self._infer_game_root(exe, folder)
            if root:
                return self._canonical_path(root)
        start_dir = self._canonical_path(item.get("startDir", ""))
        if start_dir and os.path.isdir(start_dir):
            try:
                Path(exe).relative_to(Path(start_dir))
                return start_dir
            except (ValueError, OSError):
                pass
        return self._canonical_path(str(Path(exe).parent))

    def _library_storage_sync(self, force=False):
        all_items = []
        for path in self._candidate_shortcuts_files():
            try:
                all_items.extend(self._read_shortcuts(path))
            except Exception as exc:
                decky.logger.exception("Failed reading %s for storage view: %s", path, exc)

        dedup = {}
        for item in all_items:
            key = f"appid:{item['appId']}" if item.get("appId") is not None else f"{item.get('shortcutsFile','')}:{item.get('key','')}"
            dedup[key] = item
        items = [item for item in dedup.values() if not item.get("utilityShortcut") and item.get("exe")]

        settings = self._load_settings()
        watched = [Path(self._canonical_path(str(value))) for value in settings.get("watchedFolders", []) if value]
        grouped = {}
        for item in items:
            root = self._storage_game_root(item, watched)
            if not root:
                continue
            group = grouped.setdefault(root, {
                "root": root,
                "name": Path(root).name or item.get("name") or "Unknown",
                "appIds": [],
                "names": [],
                "exe": item.get("exe", ""),
                "startDir": item.get("startDir", ""),
            })
            if item.get("appId") is not None:
                group["appIds"].append(int(item["appId"]))
            if item.get("name"):
                group["names"].append(str(item["name"]))

        cache = self._load_size_cache()
        cache_entries = cache.setdefault("entries", {})
        now = time.time()
        result = []
        cache_changed = False
        for root, group in grouped.items():
            exists = os.path.isdir(root)
            cached = cache_entries.get(root, {})
            cache_age = now - float(cached.get("checkedAt") or 0)
            use_cache = (
                not force
                and exists
                and isinstance(cached.get("sizeBytes"), int)
                and cache_age >= 0
                and cache_age < self.SIZE_CACHE_TTL_SECONDS
            )
            if use_cache:
                size_bytes = int(cached["sizeBytes"])
                checked_at = float(cached.get("checkedAt") or now)
            else:
                size_bytes = self._folder_size_sync(root) if exists else 0
                checked_at = now
                cache_entries[root] = {"sizeBytes": size_bytes, "checkedAt": checked_at}
                cache_changed = True

            ok, reason, safe_root = self._validate_delete_target(root, group["exe"])
            names = list(dict.fromkeys(group["names"]))
            result.append({
                "root": safe_root or root,
                "name": names[0] if len(names) == 1 else group["name"],
                "sizeBytes": size_bytes,
                "appIds": list(dict.fromkeys(group["appIds"])),
                "shortcutCount": len(set(group["appIds"])),
                "exe": self._canonical_path(group["exe"]),
                "startDir": group["startDir"],
                "exists": exists,
                "canDelete": bool(ok and exists),
                "reason": reason or ("" if exists else "Game folder is missing."),
                "cached": bool(use_cache),
                "storageRoot": self._storage_root(root) or "",
                "checkedAt": int(checked_at * 1000),
            })

        live_roots = set(grouped)
        for key in list(cache_entries):
            if key not in live_roots and now - float(cache_entries[key].get("checkedAt") or 0) > 7 * 24 * 60 * 60:
                del cache_entries[key]
                cache_changed = True
        if cache_changed:
            try:
                self._save_size_cache(cache)
            except Exception as exc:
                decky.logger.warning("Could not save folder-size cache: %s", exc)

        result.sort(key=lambda item: (-item["sizeBytes"], item["name"].lower(), item["root"].lower()))
        return {
            "games": result,
            "totalBytes": sum(item["sizeBytes"] for item in result if item["exists"]),
            "calculatedAt": int(now * 1000),
            "cacheTtlSeconds": self.SIZE_CACHE_TTL_SECONDS,
        }

    async def get_library_storage(self, force: bool = False):
        return await asyncio.to_thread(self._library_storage_sync, bool(force))

    async def list_directories(self, path: str):
        """Return browsable child folders for the in-QAM folder browser."""
        requested = str(path or "").strip()
        if not requested:
            requested = "/home/deck"

        try:
            current = Path(os.path.realpath(os.path.expanduser(requested)))
            if not current.exists() or not current.is_dir():
                return {
                    "path": str(current),
                    "parent": str(current.parent),
                    "folders": [],
                    "error": f"Folder is not accessible: {current}",
                }

            folders = []
            try:
                entries = list(current.iterdir())
            except PermissionError:
                return {
                    "path": str(current),
                    "parent": str(current.parent),
                    "folders": [],
                    "error": f"Permission denied: {current}",
                }

            for child in entries:
                try:
                    if not child.is_dir() or child.name.startswith("."):
                        continue
                    folders.append({
                        "name": child.name,
                        "path": str(child.resolve()),
                    })
                except (OSError, PermissionError):
                    continue

            folders.sort(key=lambda item: item["name"].lower())
            return {
                "path": str(current),
                "parent": str(current.parent),
                "folders": folders[:300],
                "error": None,
            }
        except Exception as exc:
            return {
                "path": requested,
                "parent": "/",
                "folders": [],
                "error": f"Folder browser failed: {exc}",
            }

    def _record_scan_checkpoint(self, scan_id, label, detail=""):
        if scan_id is None:
            return
        now = time.time()
        with self._scan_state_lock:
            if self._scan_state.get("scanId") != scan_id:
                return
            seq = int(self._scan_state.get("checkpointSeq") or 0) + 1
            started = float(self._scan_state.get("startedAt") or now)
            entry = {
                "seq": seq,
                "label": str(label),
                "detail": str(detail or ""),
                "atMs": max(0, int((now - started) * 1000)),
            }
            history = list(self._scan_state.get("checkpointHistory") or [])
            history.append(entry)
            if len(history) > 12:
                history = history[-12:]
            self._scan_state["checkpointSeq"] = seq
            self._scan_state["lastCheckpoint"] = entry
            self._scan_state["checkpointHistory"] = history
            self._scan_state["lastUpdateAt"] = now

    def _scan_shortcuts_sync(self, cancel_event=None, scan_id=None):
        def set_phase(phase, detail="", current_folder=None, root_folder=None, **extra):
            if scan_id is None:
                return
            with self._scan_state_lock:
                if self._scan_state.get("scanId") != scan_id:
                    return
                now = time.time()
                phase_changed = self._scan_state.get("phase") != phase
                if phase_changed:
                    self._scan_state["phaseStartedAt"] = now
                payload = {
                    "phase": phase,
                    "phaseDetail": str(detail or ""),
                    "lastUpdateAt": now,
                }
                if current_folder is not None:
                    payload["currentFolder"] = str(current_folder)
                if root_folder is not None:
                    payload["rootFolder"] = str(root_folder)
                payload.update(extra)
                self._scan_state.update(payload)
                if phase_changed:
                    seq = int(self._scan_state.get("checkpointSeq") or 0) + 1
                    started = float(self._scan_state.get("startedAt") or now)
                    entry = {"seq": seq, "label": f"phase:{phase}", "detail": str(detail or ""), "atMs": max(0, int((now - started) * 1000))}
                    history = list(self._scan_state.get("checkpointHistory") or [])
                    history.append(entry)
                    self._scan_state["checkpointSeq"] = seq
                    self._scan_state["lastCheckpoint"] = entry
                    self._scan_state["checkpointHistory"] = history[-12:]

        set_phase("shortcut_files", "locating shortcuts.vdf")
        files = self._candidate_shortcuts_files()
        set_phase("read_shortcuts", f"{len(files)} shortcuts.vdf file(s)", shortcutFiles=len(files))
        all_items = []
        for path in files:
            try:
                all_items.extend(self._read_shortcuts(path))
            except Exception as exc:
                decky.logger.exception("Failed reading %s: %s", path, exc)

        set_phase("dedup_shortcuts", f"{len(all_items)} raw shortcut item(s)", shortcutItems=len(all_items))
        dedup = {}
        for item in all_items:
            dedup_key = (
                f"appid:{item['appId']}"
                if item.get("appId") is not None
                else f"{item['shortcutsFile']}:{item['key']}"
            )
            dedup[dedup_key] = item

        items = list(dedup.values())
        visible_items = [item for item in items if not item.get("utilityShortcut")]
        set_phase("load_settings", f"{len(items)} unique shortcut(s)", shortcutItems=len(items))
        settings = self._load_settings()
        set_phase("duplicate_groups", "grouping duplicate shortcuts")
        duplicate_groups = self._duplicate_groups(items)
        set_phase("duplicate_roots", f"{len(duplicate_groups)} duplicate group(s)", duplicateGroups=len(duplicate_groups))
        watched = [Path(self._canonical_path(str(x))) for x in settings.get("watchedFolders", []) if x]
        for group in duplicate_groups:
            exe = group.get("exe", "")
            inferred = None
            # Prefer the longest matching watched folder so nested scan roots behave predictably.
            matching = []
            for wf in watched:
                try:
                    Path(self._canonical_path(exe)).relative_to(wf)
                    matching.append(wf)
                except (ValueError, OSError):
                    continue
            for wf in sorted(matching, key=lambda x: len(str(x)), reverse=True):
                inferred, _confidence = self._infer_game_root(exe, wf)
                if inferred:
                    break
            group_root = self._canonical_path(inferred) if inferred else self._canonical_path(str(Path(exe).parent))
            group["gameRoot"] = group_root
            group["gameName"] = Path(group_root).name or Path(exe).stem
        watched_folders = [str(x) for x in settings.get("watchedFolders", []) if x]
        set_phase("prepare_folder_scan", f"{len(watched_folders)} watched folder(s)", root_folder=(watched_folders[0] if watched_folders else ""))
        unregistered, folder_error, truncated, scan_cancelled = self._scan_unregistered_exes(
            [item.get("exe", "") for item in items],
            settings,
            cancel_event,
            scan_id,
        )
        # Paths emitted by _scan_unregistered_exes are already canonical. Avoid
        # resolving every result again here; on removable media realpath() can be
        # surprisingly expensive and made large scans appear to hang after walking
        # had already finished.
        self._record_scan_checkpoint(scan_id, "worker:folder-scan-returned", f"unregistered={len(unregistered)} cancelled={scan_cancelled}")
        set_phase("filter_ignored", f"{len(unregistered)} discovered EXE(s)", unregisteredFound=len(unregistered))
        ignored_set = {self._canonical_path(x) for x in settings.get("ignoredExecutables", []) if x}
        ignored = [x for x in unregistered if x.get("path", "") in ignored_set]
        unregistered = [x for x in unregistered if x.get("path", "") not in ignored_set]
        set_phase("build_result", f"{len(unregistered)} unregistered / {len(ignored)} ignored", unregisteredFound=len(unregistered))
        self._record_scan_checkpoint(scan_id, "worker:result-build-start", f"unregistered={len(unregistered)} ignored={len(ignored)}")
        result = {
            "total": len(items),
            "healthy": sum(1 for x in visible_items if x["status"] == "healthy"),
            "missing": sum(1 for x in visible_items if x["status"] == "missing"),
            "storageOffline": sum(1 for x in visible_items if x["status"] == "storage_offline"),
            "invalid": sum(1 for x in visible_items if x["status"] == "invalid"),
            "filteredUtilities": sum(1 for x in items if x.get("utilityShortcut")),
            "duplicateGroups": duplicate_groups,
            "duplicateShortcuts": sum(group["count"] - 1 for group in duplicate_groups),
            "unregisteredExecutables": unregistered,
            "ignoredExecutables": ignored,
            "watchedFolders": settings.get("watchedFolders", []),
            "folderScanError": folder_error,
            "folderScanTruncated": truncated,
            "scanCancelled": scan_cancelled,
            "items": items,
        }
        self._record_scan_checkpoint(scan_id, "worker:result-build-done", f"items={len(items)}")
        set_phase("returning", "worker return imminent")
        self._record_scan_checkpoint(scan_id, "worker:return-imminent", "about to return ScanResult from worker thread")
        return result

    async def start_scan(self):
        """Start a background scan and return immediately with its scan id.

        This avoids holding a long-lived Decky RPC request open while the filesystem
        worker runs. Some Decky builds can leave the frontend promise pending even
        after the Python coroutine has finished, especially while status polling is
        happening concurrently.
        """
        cancel_event = threading.Event()
        with self._scan_state_lock:
            self._scan_sequence += 1
            scan_id = self._scan_sequence
            previous = self._active_scan_event
            if previous is not None:
                previous.set()
            self._active_scan_event = cancel_event
            now = time.time()
            self._last_scan_result = None
            self._last_scan_result_id = scan_id
            self._last_scan_error = None
            self._scan_state = {
                "active": True, "scanId": scan_id, "currentFolder": "",
                "rootFolder": "", "visitedFolders": 0, "foundExes": 0,
                "phase": "starting", "phaseDetail": "background scan started",
                "startedAt": now, "phaseStartedAt": now, "lastUpdateAt": now,
                "stopRequested": False, "resultReady": False, "resultError": None,
                "checkpointSeq": 0, "lastCheckpoint": None, "checkpointHistory": [],
                "workerThreadAlive": False, "futureResolved": False, "resultStored": False,
            }
        task = asyncio.create_task(self._run_scan_background(cancel_event, scan_id))
        self._active_scan_task = task
        return {"success": True, "scanId": scan_id}

    async def _run_scan_background(self, cancel_event, scan_id):
        self._record_scan_checkpoint(scan_id, "async:before-to-thread", "about to await worker thread")
        with self._scan_state_lock:
            if self._scan_state.get("scanId") == scan_id:
                self._scan_state["workerThreadAlive"] = True
        try:
            result = await asyncio.to_thread(self._scan_shortcuts_sync, cancel_event, scan_id)
            self._record_scan_checkpoint(scan_id, "async:to-thread-returned", "worker future resolved")
            with self._scan_state_lock:
                if self._scan_state.get("scanId") == scan_id:
                    self._scan_state["workerThreadAlive"] = False
                    self._scan_state["futureResolved"] = True
            self._record_scan_checkpoint(scan_id, "async:before-result-store", "storing ScanResult on plugin object")
            with self._scan_state_lock:
                if self._scan_state.get("scanId") == scan_id:
                    self._last_scan_result = result
                    self._last_scan_result_id = scan_id
                    self._last_scan_error = None
                    self._scan_state["resultReady"] = True
                    self._scan_state["resultStored"] = True
                    self._scan_state["resultError"] = None
                    self._scan_state["phaseDetail"] = "result stored; waiting for UI fetch"
                    self._scan_state["lastUpdateAt"] = time.time()
            self._record_scan_checkpoint(scan_id, "async:result-stored", "resultReady=true")
        except Exception as exc:
            decky.logger.exception("Background scan failed: %s", exc)
            self._record_scan_checkpoint(scan_id, "async:exception", str(exc))
            with self._scan_state_lock:
                if self._scan_state.get("scanId") == scan_id:
                    self._last_scan_result = None
                    self._last_scan_result_id = scan_id
                    self._last_scan_error = str(exc)
                    self._scan_state["workerThreadAlive"] = False
                    self._scan_state["futureResolved"] = True
                    self._scan_state["resultReady"] = False
                    self._scan_state["resultError"] = str(exc)
                    self._scan_state["phaseDetail"] = f"scan failed: {exc}"
                    self._scan_state["lastUpdateAt"] = time.time()
        finally:
            self._record_scan_checkpoint(scan_id, "async:finally-enter", "background task finalizing")
            with self._scan_state_lock:
                if self._scan_state.get("scanId") == scan_id:
                    self._scan_state["active"] = False
                    self._scan_state["currentFolder"] = ""
                    self._scan_state["phase"] = "idle"
                    self._scan_state["lastUpdateAt"] = time.time()
                if self._active_scan_event is cancel_event:
                    self._active_scan_event = None
                if getattr(self, "_active_scan_task", None) is asyncio.current_task():
                    self._active_scan_task = None
            self._record_scan_checkpoint(scan_id, "async:finally-exit", "background task finalized")

    async def get_scan_result(self, scan_id):
        wanted = int(scan_id)
        self._record_scan_checkpoint(wanted, "rpc:get-result-enter", "get_scan_result RPC entered")
        with self._scan_state_lock:
            result_id = self._last_scan_result_id
            result_error = self._last_scan_error
            result = self._last_scan_result
        self._record_scan_checkpoint(wanted, "rpc:get-result-lock-exit", f"result_id={result_id}; has_result={result is not None}")
        if result_id != wanted:
            envelope = {"ready": False, "scanId": wanted, "result": None, "error": None}
        elif result_error:
            envelope = {"ready": False, "scanId": wanted, "result": None, "error": result_error}
        elif result is None:
            envelope = {"ready": False, "scanId": wanted, "result": None, "error": None}
        else:
            envelope = {"ready": True, "scanId": wanted, "result": result, "error": None}
        self._record_scan_checkpoint(wanted, "rpc:get-result-return", f"ready={envelope['ready']}; returning envelope")
        return envelope

    async def get_scan_result_json(self, scan_id):
        """Return the completed scan as one pre-serialized JSON string.

        Decky's Python bridge can stall while recursively serializing a large nested
        ScanResult object even after this coroutine has returned. Serializing here
        keeps the bridge payload to a single primitive string and also gives us a
        precise checkpoint if JSON encoding itself ever fails.
        """
        wanted = int(scan_id)
        self._record_scan_checkpoint(wanted, "rpc-json:enter", "get_scan_result_json RPC entered")
        with self._scan_state_lock:
            result_id = self._last_scan_result_id
            result_error = self._last_scan_error
            result = self._last_scan_result
        if result_id != wanted:
            envelope = {"ready": False, "scanId": wanted, "result": None, "error": None}
        elif result_error:
            envelope = {"ready": False, "scanId": wanted, "result": None, "error": result_error}
        elif result is None:
            envelope = {"ready": False, "scanId": wanted, "result": None, "error": None}
        else:
            envelope = {"ready": True, "scanId": wanted, "result": result, "error": None}
        self._record_scan_checkpoint(wanted, "rpc-json:encode-start", f"ready={envelope['ready']}")
        try:
            # File names on Linux may contain undecodable byte sequences. Python
            # represents those with surrogateescape code points; ensure_ascii=False
            # can then fail when the bridge encodes the JSON string as UTF-8.
            # ASCII-escaped JSON is safe for arbitrary filesystem names and the
            # frontend's JSON.parse() restores ordinary Unicode transparently.
            payload = json.dumps(
                envelope,
                ensure_ascii=True,
                separators=(",", ":"),
                default=str,
            )
            payload_bytes = len(payload.encode("ascii"))
            self._record_scan_checkpoint(wanted, "rpc-json:encoded", f"payload={payload_bytes} bytes")
            return payload
        except Exception as exc:
            # Never let result serialization surface as an opaque Decky Python
            # exception. Return a small, guaranteed-safe JSON error envelope.
            self._record_scan_checkpoint(wanted, "rpc-json:encode-error", repr(exc))
            safe_error = {
                "ready": False,
                "scanId": wanted,
                "result": None,
                "error": f"Scan result serialization failed: {type(exc).__name__}: {exc!r}",
            }
            return json.dumps(safe_error, ensure_ascii=True, separators=(",", ":"), default=str)

    async def scan_shortcuts(self):
        # Every scan owns its own cancellation token. A later scan must never
        # clear/reuse an older worker's token, otherwise a cancelled SD-card
        # traversal can resume in the background.
        cancel_event = threading.Event()
        with self._scan_state_lock:
            self._scan_sequence += 1
            scan_id = self._scan_sequence
            previous = self._active_scan_event
            if previous is not None:
                previous.set()
            self._active_scan_event = cancel_event
            now = time.time()
            self._scan_state = {
                "active": True, "scanId": scan_id, "currentFolder": "",
                "rootFolder": "", "visitedFolders": 0, "foundExes": 0,
                "phase": "starting", "phaseDetail": "starting scan",
                "startedAt": now, "phaseStartedAt": now, "lastUpdateAt": now,
                "stopRequested": False,
            }
        try:
            return await asyncio.to_thread(self._scan_shortcuts_sync, cancel_event, scan_id)
        finally:
            with self._scan_state_lock:
                if self._scan_state.get("scanId") == scan_id:
                    self._scan_state["active"] = False
                    self._scan_state["currentFolder"] = ""
                    self._scan_state["phase"] = "idle"
                    self._scan_state["phaseDetail"] = "scan worker finished"
                    self._scan_state["lastUpdateAt"] = time.time()
                if self._active_scan_event is cancel_event:
                    self._active_scan_event = None

    async def stop_scan(self):
        with self._scan_state_lock:
            event = self._active_scan_event
        if event is not None:
            event.set()
            self._record_scan_checkpoint(self._scan_state.get("scanId"), "ui:stop-request", "stop_scan RPC received")
            with self._scan_state_lock:
                self._scan_state["stopRequested"] = True
                self._scan_state["phaseDetail"] = "stop requested; waiting for worker checkpoint"
                self._scan_state["lastUpdateAt"] = time.time()
        return {"success": True}

    async def get_scan_status(self):
        with self._scan_state_lock:
            state = dict(self._scan_state)
        now = time.time()
        started = float(state.get("startedAt") or now)
        phase_started = float(state.get("phaseStartedAt") or started)
        last_update = float(state.get("lastUpdateAt") or started)
        state["elapsedMs"] = max(0, int((now - started) * 1000))
        state["phaseElapsedMs"] = max(0, int((now - phase_started) * 1000))
        state["staleMs"] = max(0, int((now - last_update) * 1000))
        return state

    async def backup_shortcuts(self):
        files = self._candidate_shortcuts_files()
        if not files:
            return {"success": False, "files": [], "error": "shortcuts.vdf not found"}

        backup_dir = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        created = []
        for i, src in enumerate(files, start=1):
            suffix = "" if len(files) == 1 else f"_{i}"
            dst = backup_dir / f"shortcuts_{stamp}{suffix}.vdf"
            shutil.copy2(src, dst)
            created.append(str(dst))
        return {"success": True, "files": created}

    async def _main(self):
        self._scan_state_lock = threading.Lock()
        self._active_scan_event = None
        self._active_scan_task = None
        self._scan_sequence = 0
        self._last_scan_result = None
        self._last_scan_result_id = 0
        self._last_scan_error = None
        now = time.time()
        self._scan_state = {"active": False, "scanId": 0, "currentFolder": "", "rootFolder": "", "visitedFolders": 0, "foundExes": 0, "phase": "idle", "phaseDetail": "", "startedAt": now, "phaseStartedAt": now, "lastUpdateAt": now, "stopRequested": False, "resultReady": False, "resultError": None, "checkpointSeq": 0, "lastCheckpoint": None, "checkpointHistory": [], "workerThreadAlive": False, "futureResolved": False, "resultStored": False}
        decky.logger.info("Library Doctor loaded")

    async def _unload(self):
        decky.logger.info("Library Doctor unloaded")