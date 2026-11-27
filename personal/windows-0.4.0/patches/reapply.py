#!/usr/bin/env python3
"""LenBot 本地补丁：检查 / 重放 / 回滚（幂等，不依赖行号）。

用法（在部署根目录或任意位置）：
    python patches/reapply.py --check     只报告每个补丁的状态，不改动文件
    python patches/reapply.py --apply     应用缺失的补丁（已应用的自动跳过）
    python patches/reapply.py --revert    反向替换，撤销补丁（仅同一版本适用）
    python patches/reapply.py --apply --root D:\\other\\lenbot   指定另一份部署包

升级后面板会替换 releases/ 内的官方文件，跑一次 --apply 即可复原。
脚本按「唯一文本块」定位，若升级后官方改写了对应段落，会明确报
NEEDS_MANUAL 并指向 diffs/ 中的差异文件，绝不猜测或强行覆盖。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent
MANIFEST = HERE / "patches.json"


def current_version(root: Path) -> str:
    marker = root / "current.json"
    if marker.is_file():
        try:
            return str(json.loads(marker.read_text(encoding="utf-8"))["version"])
        except (ValueError, KeyError, OSError):
            pass
    releases = sorted(p.name for p in (root / "releases").iterdir() if p.is_dir())
    return releases[-1] if releases else "0.2.7"


def resolve(root: Path, rel: str, version: str) -> Path:
    """把清单里写死的 releases/<版本>/ 换成当前部署包的实际版本。"""
    candidate = re.sub(r"^releases/[^/]+/", f"releases/{version}/", rel)
    path = root / Path(candidate)
    if path.exists():
        return path
    if rel.startswith("releases/"):
        # 只在当前版本目录里找同名文件：多个版本共存时，跨版本 glob 会匹配到旧版本的文件，
        # 把「新版已换 hash 的前端资源」误判成 APPLIED。
        suffix = rel.split("/", 2)[2]
        version_dir = root / "releases" / version
        matches = sorted(version_dir.glob(suffix)) if version_dir.is_dir() else []
        if len(matches) == 1:
            return matches[0]
    return path


def backup(path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = path.with_name(f"{path.name}.bak-reapply-{stamp}")
    shutil.copy2(path, target)
    return target


def read_normalized(path: Path) -> tuple[str, bool]:
    """Read as text with LF-only newlines; report whether the file uses CRLF.

    Path.read_text()/write_text() translate newlines on Windows and would silently
    convert an all-LF official file into CRLF. Byte IO keeps the original style.
    """
    text = path.read_bytes().decode("utf-8")
    crlf = "\r\n" in text
    return (text.replace("\r\n", "\n"), crlf)


def write_denormalized(path: Path, text: str, crlf: bool) -> None:
    out = text.replace("\n", "\r\n") if crlf else text
    path.write_bytes(out.encode("utf-8"))


def composed_text(patch: dict, patches: dict[str, dict]) -> str | None:
    """A later patch may intentionally add to this patch's exact replacement block."""
    text = patch["new"]
    for id in patch.get("composed_with", []):
        later = patches[id]
        if later.get("obsolete") or later["path"] != patch["path"] or text.count(later["old"]) != 1:
            return None
        text = text.replace(later["old"], later["new"], 1)
    return None if text == patch["new"] else text


def classify(text: str, patch: dict, patches: dict[str, dict]) -> str:
    if text.count(patch["new"]) == 1:
        return "APPLIED"
    composed = composed_text(patch, patches)
    if composed is not None and text.count(composed) == 1:
        return "APPLIED_COMPOSED"
    # A lone marker can be stale or shared by related changes. Never replay on that evidence.
    if patch["marker"] in text:
        return "NEEDS_MANUAL"
    if text.count(patch["old"]) == 1:
        return "PENDING"
    return "NEEDS_MANUAL"


def main() -> int:
    ap = argparse.ArgumentParser(description="LenBot 本地补丁重放工具")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="只检查，不改动")
    mode.add_argument("--apply", action="store_true", help="应用缺失补丁")
    mode.add_argument("--revert", action="store_true", help="撤销补丁")
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="部署包根目录")
    args = ap.parse_args()

    root = args.root.resolve()
    if not (root / "current.json").is_file() and not (root / "releases").is_dir():
        ap.error(f"不像 LenBot 部署包根目录：{root}")
    version = current_version(root)
    patches = json.loads(MANIFEST.read_text(encoding="utf-8"))

    print(f"部署包：{root}")
    print(f"当前版本：{version}")
    print(f"补丁数：{len(patches)}    模式：{'check' if args.check else 'apply' if args.apply else 'revert'}")
    print("-" * 78)

    counts: dict[str, int] = {}
    indexed = {p["id"]: p for p in patches}
    results: dict[str, str] = {}
    for p in (reversed(patches) if args.revert else patches):
        def remember(state: str) -> None:
            results[p["id"]] = state
            counts[state] = counts.get(state, 0) + 1
        if p.get("obsolete"):
            state = "OBSOLETE"
            print(f"[{state:>17}] {p['id']:<32} {p['obsolete']}")
            remember(state)
            continue
        path = resolve(root, p["path"], version)
        if not path.is_file():
            state = "MISSING_FILE"
            print(f"[{state:>17}] {p['id']}  ->  {path}")
            remember(state)
            continue
        text, crlf = read_normalized(path)
        state = classify(text, p, indexed)
        detail = ""
        prerequisite = next((dep for dep in p.get("requires", [])
                             if results.get(dep) not in {"APPLIED", "APPLIED_COMPOSED", "APPLIED_NOW"}), None)
        dependent = next((other["id"] for other in patches if p["id"] in other.get("requires", [])
                          and results.get(other["id"]) not in {"PENDING", "REVERTED", "OBSOLETE"}), None)
        if args.apply and state == "PENDING" and prerequisite is not None:
            state, detail = "NEEDS_MANUAL", f"  依赖 {prerequisite} 未确认，不重放"
        elif args.revert and state == "APPLIED" and dependent is not None:
            state, detail = "NEEDS_MANUAL", f"  依赖此项的 {dependent} 未撤销，不移除"
        elif args.apply and state == "PENDING":
            bak = backup(path)
            write_denormalized(path, text.replace(p["old"], p["new"], 1), crlf)
            state, detail = "APPLIED_NOW", f"  备份 {bak.name}"
        elif args.revert and state == "APPLIED":
            bak = backup(path)
            write_denormalized(path, text.replace(p["new"], p["old"], 1), crlf)
            state, detail = "REVERTED", f"  备份 {bak.name}"
        elif state == "NEEDS_MANUAL" or args.revert and state == "APPLIED_COMPOSED":
            state = "NEEDS_MANUAL"
            detail = f"  不能确认完整替换块，请人工比对 diffs/{p['id']}.diff"
        print(f"[{state:>17}] {p['id']:<32} {p['path']}{detail}")
        remember(state)

    print("-" * 78)
    print("  " + " | ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if counts.get("NEEDS_MANUAL") or counts.get("MISSING_FILE"):
        print("\n有补丁无法自动处理：升级改写了对应段落或目录结构。")
        print("请对照 patches/diffs/ 里的差异手工合并，改完再跑一次 --check。")
        return 2
    if args.check and counts.get("PENDING"):
        print("\n存在未应用的补丁，升级后请运行： python patches/reapply.py --apply")
        return 1
    if args.apply or args.revert:
        print("\n完成后请重启 LenBot 使改动生效，并到面板或 QQ 发一句验证。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
