#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""API密钥健康检测脚本：主密钥 + 备用密钥双检测"""

import requests, json
from datetime import datetime

# 当前配置中的两个密钥
KEY_MAIN = ""
KEY_BACKUP = ""

API_DASHSCOPE = "https://dashscope.aliyuncs.com"
API_MAAS = "https://ws-of9v7c4da1zhezwm.cn-beijing.maas.aliyuncs.com"


def check_key_usable(sk, label="", endpoint="dashscope", model="qwen3.7-max"):
    """检测密钥能否正常调用 qwen3.7-max 模型"""
    base_url = API_DASHSCOPE if endpoint == "dashscope" else API_MAAS
    url = f"{base_url}/api/v1/services/aigc/text-generation/generation"

    headers = {"Authorization": f"Bearer {sk.strip()}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": "hi"}]},
        "parameters": {"max_tokens": 5}
    }

    result = {
        "label": label,
        "endpoint": endpoint,
        "sk_prefix": sk[:25] + "...",
        "timestamp": datetime.now().isoformat(),
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=45)
        result["http_code"] = resp.status_code

        if resp.status_code == 200:
            data = resp.json()
            usage = data.get("usage", {})
            result["usable"] = True
            result["token_used"] = usage.get("total_tokens", 0)
            result["input_tokens"] = usage.get("input_tokens", 0)
            result["output_tokens"] = usage.get("output_tokens", 0)
            result["reasoning_tokens"] = usage.get("output_tokens_details", {}).get("reasoning_tokens", 0)
            result["model_returned"] = data.get("output", {}).get("choices", [{}])[0].get("message", {}).get("content", "")[:50]
        elif resp.status_code == 401:
            result["usable"] = False
            result["error_msg"] = "认证失败(401): 密钥无效或已过期"
        elif resp.status_code == 403:
            result["usable"] = False
            result["error_msg"] = "权限拒绝(403): 无此模型访问权限或工作空间不匹配"
        elif resp.status_code == 429:
            result["usable"] = False
            result["error_msg"] = "限流(429): 请求过于频繁或QPS超限"
        else:
            result["usable"] = False
            body = resp.text[:400]
            result["error_msg"] = f"HTTP {resp.status_code}: {body}"

    except requests.Timeout:
        result["usable"] = False
        result["error_msg"] = "连接超时(45s): 网络不通或服务端卡死"
    except Exception as e:
        result["usable"] = False
        result["error_msg"] = f"异常: {type(e).__name__}: {str(e)[:200]}"

    return result


def get_account_balance(sk):
    """查询账户余额 / 资源包剩余"""
    headers = {"Authorization": f"Bearer {sk.strip()}"}
    try:
        resp = requests.get(f"{API_DASHSCOPE}/api/v1/user/balance", headers=headers, timeout=30)
        if resp.status_code == 200:
            return resp.json()
        else:
            return {"balance": None, "err": f"HTTP {resp.status_code}: {resp.text[:200]}"}
    except Exception as e:
        return {"balance": None, "err": str(e)}


def print_result(r):
    status = "OK" if r.get("usable") else "FAIL"
    print(f"  [{status}] {r.get('label','')} | endpoint={r.get('endpoint','')} | http={r.get('http_code','?')}")
    if r.get("usable"):
        print(f"         tokens: {r.get('token_used',0)} (in={r.get('input_tokens',0)} out={r.get('output_tokens',0)} reasoning={r.get('reasoning_tokens',0)})")
        print(f"         response: {r.get('model_returned','')}")
    else:
        print(f"         error: {r.get('error_msg','')[:150]}")
    print()


if __name__ == "__main__":
    print("=" * 70)
    print("  Qwen3.7-Max API 密钥健康检测")
    print(f"  检测时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)
    print()

    # ---- 1. 主密钥 DashScope 兼容模式 ----
    print("--- 1. 主密钥 DashScope 兼容模式 ---")
    r1 = check_key_usable(KEY_MAIN, label="主密钥-compatible", endpoint="dashscope")
    # compatible mode 用的是不同 URL
    headers = {"Authorization": f"Bearer {KEY_MAIN.strip()}", "Content-Type": "application/json"}
    try:
        resp = requests.post(
            f"{API_DASHSCOPE}/compatible-mode/v1/chat/completions",
            headers=headers,
            json={"model": "qwen3.7-max", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5},
            timeout=45)
        r1["compatible_mode"] = {"http_code": resp.status_code, "ok": resp.status_code == 200}
        if resp.status_code == 200:
            data = resp.json()
            r1["compatible_mode"]["tokens"] = data.get("usage", {}).get("total_tokens", 0)
    except Exception as e:
        r1["compatible_mode"] = {"http_code": 0, "ok": False, "error": str(e)[:100]}
    print_result(r1)
    print(f"    compatible-mode: http={r1.get('compatible_mode',{}).get('http_code','?')} ok={r1.get('compatible_mode',{}).get('ok',False)}")

    # ---- 2. 主密钥原生 DashScope API ----
    print()
    print("--- 2. 主密钥原生 DashScope API ---")
    r2 = check_key_usable(KEY_MAIN, label="主密钥-native", endpoint="dashscope")
    print_result(r2)

    # ---- 3. 备用密钥 DashScope 兼容模式 ----
    print("--- 3. 备用密钥 DashScope 兼容模式 ---")
    try:
        resp = requests.post(
            f"{API_DASHSCOPE}/compatible-mode/v1/chat/completions",
            headers={"Authorization": f"Bearer {KEY_BACKUP.strip()}", "Content-Type": "application/json"},
            json={"model": "qwen3.7-max", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5},
            timeout=45)
        print(f"  http={resp.status_code}")
        if resp.status_code != 200:
            print(f"  body: {resp.text[:300]}")
    except Exception as e:
        print(f"  FAIL: {e}")

    # ---- 4. 备用密钥原生 DashScope API ----
    print()
    print("--- 4. 备用密钥原生 DashScope API ---")
    r4 = check_key_usable(KEY_BACKUP, label="备用密钥-native", endpoint="dashscope")
    print_result(r4)

    # ---- 5. 备用密钥 MaaS 工作空间端点 ----
    print("--- 5. 备用密钥 MaaS 工作空间端点 ---")
    r5 = check_key_usable(KEY_BACKUP, label="备用密钥-MaaS", endpoint="maas")
    print_result(r5)

    # ---- 6. qwen-max 兼容模式（备用密钥）- 降级方案 ----
    print("--- 6. 备用密钥 qwen-max 兼容模式 ---")
    try:
        resp = requests.post(
            f"{API_DASHSCOPE}/compatible-mode/v1/chat/completions",
            headers={"Authorization": f"Bearer {KEY_BACKUP.strip()}", "Content-Type": "application/json"},
            json={"model": "qwen-max", "messages": [{"role": "user", "content": "hi"}]},
            timeout=45)
        print(f"  http={resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            print(f"  tokens: {data.get('usage',{}).get('total_tokens',0)}")
            print(f"  model: {data.get('model','?')}")
        else:
            print(f"  body: {resp.text[:300]}")
    except Exception as e:
        print(f"  FAIL: {e}")

    # ---- 7. 账户余额查询 ----
    print()
    print("--- 7. 账户余额（备用密钥鉴权）---")
    balance = get_account_balance(KEY_BACKUP)
    print(json.dumps(balance, ensure_ascii=False, indent=2))

    # ---- 汇总结论 ----
    print()
    print("=" * 70)
    print("  汇总结论")
    print("=" * 70)
    print(f"  主密钥: {'可用' if r2.get('usable') else '不可用'} (native API)")
    print(f"  备用密钥: {'可用' if r4.get('usable') else '不可用'} (native API)")
    print(f"  推荐使用: {'备用密钥 (原生API) — 已验证稳定' if r4.get('usable') else '主密钥 (compatible-mode)'}")

    if not r4.get("usable") and not r2.get("usable"):
        print()
        print("  !! 两个密钥均不可用，请检查:")
        print("     1. 阿里云百炼控制台 -> 模型服务 -> 确认 qwen3.7-max 已开通")
        print("     2. 费用中心 -> 确认账户余额充足")
        print("     3. 工作空间 -> 确认 API Key 未过期/未禁用")
