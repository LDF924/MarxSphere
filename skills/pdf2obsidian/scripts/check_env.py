#!/usr/bin/env python3
"""环境检测脚本 — 检查本地 LLM 可用性并给出安装建议。"""

import os
import sys
import json
import platform


def detect() -> dict:
    report = {
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "cpu_cores": os.cpu_count() or 4,
    }

    # RAM
    try:
        import ctypes
        class MEM(ctypes.Structure):
            _fields_ = [("l", ctypes.c_ulong), ("pct", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                        ("avail", ctypes.c_ulonglong), ("pf", ctypes.c_ulonglong), ("af", ctypes.c_ulonglong),
                        ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("aev", ctypes.c_ulonglong)]
        m = MEM()
        m.l = ctypes.sizeof(MEM)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        report["ram_gb"] = round(m.total / (1024 ** 3), 1)
        report["ram_avail_gb"] = round(m.avail / (1024 ** 3), 1)
    except Exception:
        report["ram_gb"] = 0

    # GPU
    try:
        import subprocess
        gpu_out = subprocess.run(["wmic", "path", "win32_VideoController", "get", "name"],
                                 capture_output=True, text=True)
        gpus = [l.strip() for l in gpu_out.stdout.splitlines() if l.strip() and "Name" not in l]
        report["gpu"] = gpus
    except Exception:
        report["gpu"] = []

    # Ollama
    ollama_paths = [
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Ollama\ollama.exe"),
        os.path.expandvars(r"%PROGRAMFILES%\Ollama\ollama.exe"),
    ]
    for p in ollama_paths:
        if os.path.exists(p):
            report["ollama_exe"] = p
            report["ollama_installed"] = True
            break
    else:
        report["ollama_installed"] = False

    # llama-cpp-python
    try:
        import llama_cpp
        report["llama_cpp"] = True
    except ImportError:
        report["llama_cpp"] = False

    # PyTorch
    try:
        import torch
        report["pytorch"] = torch.__version__
        report["cuda"] = torch.cuda.is_available()
        if report["cuda"]:
            report["vram_gb"] = round(torch.cuda.get_device_properties(0).total_mem / (1024 ** 3), 1)
    except ImportError:
        report["pytorch"] = None
        report["cuda"] = False

    return report


def recommend(report: dict) -> str:
    """根据检测结果给出推荐方案。"""
    ram = report.get("ram_gb", 0)
    gpus = report.get("gpu", [])
    has_nvidia = any("nvidia" in g.lower() for g in gpus)
    has_amd = any("radeon" in g.lower() or "amd" in g.lower() for g in gpus)
    ollama = report.get("ollama_installed", False)
    llama_cpp = report.get("llama_cpp", False)
    pytorch = report.get("pytorch")
    cpu = report.get("cpu_cores", 4)
    intel_gpu = any("iris" in g.lower() or "uhd" in g.lower() or "arc" in g.lower() for g in gpus)

    options = []

    # Option 1: Ollama (easiest — recommended for most users)
    if ollama:
        options.append(("ollama", "已安装 Ollama，可直接使用。推荐模型：qwen3:4b（~2.5GB）"))
    elif not ollama:
        options.append(("ollama", f"推荐安装 Ollama（一键安装，支持 CPU/GPU 推理）：\n"
                                  f"   1. 下载 https://ollama.com/download/windows\n"
                                  f"   2. 安装后终端运行：ollama pull qwen3:4b"))

    # Option 2: llama-cpp-python (CPU-only, works everywhere)
    if llama_cpp:
        options.append(("llama.cpp", "已安装 llama-cpp-python，可直接使用。"))
    else:
        options.append(("llama.cpp", f"可选安装 llama-cpp-python（CPU 推理，无需 GPU）：\n"
                                     f"   pip install llama-cpp-python"))

    # Option 3: transformers (needs PyTorch)
    if pytorch:
        if report.get("cuda"):
            t = f"PyTorch {pytorch} + CUDA (VRAM: {report.get('vram_gb', 0)}GB)"
        else:
            t = f"PyTorch {pytorch} (CPU)"
        options.append(("transformers", f"已安装 {t}。可加载 Qwen2.5 等模型。"))
    else:
        cmd = "pip install torch --index-url https://download.pytorch.org/whl/cpu"
        options.append(("transformers", f"可选安装 PyTorch + Transformers（CPU 推理）：\n"
                                        f"   {cmd}\n"
                                        f"   pip install transformers accelerate"))

    # Summary recommendation
    if ollama and ram >= 8:
        rec = "ollama"
        detail = f"Ollama 已安装，推荐使用 qwen3:4b（{cpu}核 CPU, {ram}GB RAM 足够）。"
    elif ram >= 16:
        rec = "ollama"
        detail = "RAM 足够，推荐安装 Ollama + qwen3:4b 模型。"
    elif ram >= 8:
        rec = "ollama"
        detail = "RAM 紧凑，推荐 Ollama + qwen3:4b（~2.5GB）或使用 API。"
    else:
        rec = "api"
        detail = "RAM 不足（<8GB），推荐使用 API 模式。"

    return {"recommendation": rec, "detail": detail, "options": options}


def main():
    report = detect()
    rec = recommend(report)
    print("=== 环境检测 ===")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print()
    print("=== 推荐方案 ===")
    print(f"推荐: {rec['recommendation']}")
    print(f"理由: {rec['detail']}")
    print()
    print("可选方案:")
    for name, desc in rec["options"]:
        print(f"  [{name}] {desc}")


if __name__ == "__main__":
    main()
