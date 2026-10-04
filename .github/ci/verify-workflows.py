#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""断言内置工作流已成功初始化。

这曾是一个验收盲区：健康接口（GET /）不依赖工作流数据，依赖回归
（sqlmodel 0.0.43+ 要求 timezone-aware datetime）导致 7 个内置工作流
全部初始化失败时，原有 L0-L5 关卡依然全绿。

用法：verify-workflows.py（要求后端已在 127.0.0.1:54321 运行）
"""
import json
import sys
import urllib.request

BASE_URL = "http://127.0.0.1:54321"
EXPECTED = [
    "核心蓝图",
    "世界观",
    "分卷大纲",
    "阶段大纲",
    "拆书工作流",
    "辩论测试",
    "项目创建·雪花创作法",
]


def main() -> None:
    with urllib.request.urlopen(BASE_URL + "/api/workflows", timeout=10) as response:
        payload = json.load(response)
    # 兼容 {status, data, message} 包装格式与裸数组两种返回
    if isinstance(payload, dict) and "data" in payload:
        payload = payload["data"]
    names = {item.get("name", "") for item in payload}
    missing = [name for name in EXPECTED if name not in names]
    if missing:
        print("::error::内置工作流缺失：" + "、".join(missing))
        print("  实际拿到的：" + ("、".join(sorted(names)) or "(空)"))
        sys.exit(1)
    print(f"内置工作流完整：{len(EXPECTED)}/{len(EXPECTED)}")


if __name__ == "__main__":
    main()
