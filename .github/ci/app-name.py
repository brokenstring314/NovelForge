#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读取打包后的 Electron 应用名（app.getName() 的来源）。

Electron 以 app.asar 内 package.json 的 productName / name 作为应用名，
而应用名决定用户数据目录（macOS: ~/Library/Application Support/<name>）。
名字不对，数据库与日志就会落到错误的目录里。

用法：app-name.py <NovelForge.app 路径>
输出：应用名（无法确定时输出 <未知>）
"""
import json
import sys


def read_package_json(asar_path: str):
    with open(asar_path, "rb") as handle:
        data = handle.read()
    # asar = 16 字节头 + JSON 头 + 文件数据区；文件数据相对数据区起点偏移
    header_size = int.from_bytes(data[12:16], "little")
    header = json.loads(data[16:16 + header_size].decode("utf-8"))
    entry = header["files"].get("package.json")
    if not entry:
        return None
    base = 16 + header_size
    offset, size = int(entry["offset"]), int(entry["size"])
    # 数据区存在 4 字节对齐填充，逐个尝试
    for padding in range(0, 8):
        start = base + offset + padding
        try:
            return json.loads(data[start:start + size].decode("utf-8"))
        except Exception:
            continue
    return None


def main() -> None:
    app = sys.argv[1]
    package = read_package_json(app + "/Contents/Resources/app.asar")
    if not package:
        print("<未知>")
        return
    print(package.get("productName") or package.get("name") or "<未知>")


if __name__ == "__main__":
    main()
