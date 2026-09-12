# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：把 NovelForge 后端打成自包含的独立程序。

用法（在 backend 目录下执行）：
    pip install -r requirements.txt pyinstaller
    pyinstaller NovelForgeBackend.spec --noconfirm --clean

产物：
    dist/NovelForgeBackend/NovelForgeBackend      （macOS / Linux）
    dist/NovelForgeBackend/NovelForgeBackend.exe  （Windows）
"""
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# 内置知识库 / 提示词 / 工作流：后端启动时会从 app/bootstrap 下按相对路径读取
datas = [
    ('app/bootstrap/knowledge', 'app/bootstrap/knowledge'),
    ('app/bootstrap/prompts', 'app/bootstrap/prompts'),
    ('app/bootstrap/workflows', 'app/bootstrap/workflows'),
]

hiddenimports = [
    'uvicorn.logging',
    'uvicorn.loops.auto',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan.on',
]

# 以下包内部存在动态导入，静态分析容易漏，显式收集全部子模块
for package in (
    'langchain',
    'langchain_core',
    'langchain_openai',
    'langchain_anthropic',
    'langchain_google_genai',
    'langchain_qwq',
    'langgraph',
    'tiktoken_ext',
):
    try:
        hiddenimports += collect_submodules(package)
    except Exception:
        pass

try:
    datas += collect_data_files('tiktoken_ext')
except Exception:
    pass

a = Analysis(
    ['run_backend.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'pytest',
        'IPython',
        'matplotlib',
        'PyQt5',
        'PyQt6',
        'PySide2',
        'PySide6',
        'notebook',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='NovelForgeBackend',
    debug=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='NovelForgeBackend',
)
