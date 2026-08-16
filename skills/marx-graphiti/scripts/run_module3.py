#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
向量化（Embedding）— 执行入口
直接调用模块3主流程，解决 curl/Bash 编码问题
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import subprocess
subprocess.run([
    sys.executable,
    str(Path(__file__).parent / "模块3：向量化（Embedding）.py")
], check=True)
