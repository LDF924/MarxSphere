"""pdf2obsidian 共享工具：配置加载、日志、重试装饰器、进度追踪。"""

import os
import sys
import json
import time
import logging
from pathlib import Path
from datetime import datetime
from functools import wraps
from typing import Optional, Any, Callable


def load_config(config_path: Optional[Path] = None) -> dict:
    """加载 config.env，解析 KEY=VALUE 对。不填路径则从技能目录找。"""
    if config_path is None:
        skill_dir = os.environ.get("CLAUDE_SKILL_DIR", "")
        if skill_dir:
            config_path = Path(skill_dir) / "config.env"
        else:
            config_path = Path(__file__).resolve().parent.parent / "config.env"
    else:
        config_path = Path(config_path)

    cfg = {}
    if config_path.exists():
        for line in config_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                cfg[key.strip()] = value.strip().strip("\"'")

    # Apply defaults for missing keys
    defaults = {
        "TRANSLATION_TARGET": "zh",
        "TRANSLATION_TEMPERATURE": "0.3",
        "GENERATION_TEMPERATURE": "0.5",
        "MAX_DAILY_PAGES": "900",
        "REQUEST_DELAY_FLASH": "15",
        "REQUEST_DELAY_PRECISION": "5",
        "MAX_RETRIES": "3",
    }
    for k, v in defaults.items():
        cfg.setdefault(k, v)

    return cfg


def find_skill_dir() -> Path:
    """定位技能根目录。"""
    env = os.environ.get("CLAUDE_SKILL_DIR", "")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent


def setup_logging(log_dir: Optional[Path] = None) -> logging.Logger:
    """配置日志：同时输出到控制台和文件。"""
    if log_dir is None:
        log_dir = find_skill_dir()
    logger = logging.getLogger("pdf2obsidian")
    logger.setLevel(logging.INFO)
    if logger.handlers:
        return logger

    formatter = logging.Formatter(
        "[%(asctime)s] %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )

    # Console - use replace for Windows GBK compatibility
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(formatter)
    # Ensure console output doesn't choke on Unicode
    try:
        ch.setStream(sys.stdout)
    except AttributeError:
        pass
    logger.addHandler(ch)

    # File (daily rotation via naming)
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"pipeline_{datetime.now():%Y%m%d}.log"
    fh = logging.FileHandler(str(log_file), encoding="utf-8")
    fh.setFormatter(formatter)
    logger.addHandler(fh)

    return logger


def retry(max_attempts: int = 3, backoff: float = 5.0, exceptions=(Exception,)):
    """装饰器：失败后指数退避重试。"""

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_err = None
            for attempt in range(1, max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    last_err = e
                    if attempt < max_attempts:
                        wait = backoff * (2 ** (attempt - 1))
                        logging.getLogger("pdf2obsidian").warning(
                            "%s 第 %d/%d 次失败: %s — %ds 后重试",
                            func.__name__, attempt, max_attempts, e, wait,
                        )
                        time.sleep(wait)
            raise last_err

        return wrapper

    return decorator


def slugify(filename: str) -> str:
    """从 PDF 文件名生成安全的 slug。保留中文，去除不安全字符。"""
    name = Path(filename).stem
    unsafe = r'[\\/:*?"<>|]'
    safe = __import__("re").sub(unsafe, "_", name)
    return safe.strip()[:80]


# -------- 状态追踪 --------

def load_state(output_dir: Path) -> dict:
    """加载 state.json，不存在则返回空。"""
    state_file = output_dir / ".pdf2obsidian_state.json"
    if state_file.exists():
        try:
            return json.loads(state_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_state(output_dir: Path, state: dict):
    """原子写入 state.json。"""
    state_file = output_dir / ".pdf2obsidian_state.json"
    tmp = output_dir / ".pdf2obsidian_state.json.tmp"
    output_dir.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(state_file)


def update_paper_state(output_dir: Path, slug: str, stage: str):
    """更新单篇论文的阶段状态（原子写入）。"""
    state = load_state(output_dir)
    state[slug] = stage
    save_state(output_dir, state)


def is_paper_done(output_dir: Path, slug: str) -> bool:
    """检查论文是否已完成。同时检查 state 状态（done/finished）和磁盘输出目录是否存在。"""
    state = load_state(output_dir)
    if state.get(slug) in ("done", "finished"):
        return True
    # 回退：检查磁盘上是否存在该 slug 对应的输出目录
    # 处理 state key 和输出目录名不一致的情况
    for candidate in (slug, slug[:80]):
        cand_dir = output_dir / candidate
        if cand_dir.is_dir() and (cand_dir / (candidate + ".index.md")).exists():
            return True
    return False


# -------- 每日配额追踪 --------

def get_daily_pages(output_dir: Path) -> int:
    """返回今日已处理的精度模式页数。"""
    state = load_state(output_dir)
    today = datetime.now().strftime("%Y-%m-%d")
    quota = state.get("_quota", {})
    return quota.get(today, 0)


def add_daily_pages(output_dir: Path, pages: int):
    """增加今日精度模式页数计数。"""
    state = load_state(output_dir)
    today = datetime.now().strftime("%Y-%m-%d")
    quota = state.get("_quota", {})
    # Clean old dates
    quota = {k: v for k, v in quota.items() if k >= today}
    quota[today] = quota.get(today, 0) + pages
    state["_quota"] = quota
    save_state(output_dir, state)


def check_daily_quota(output_dir: Path, max_pages: int) -> bool:
    """检查今日配额是否已满，返回 True 表示可以继续。"""
    used = get_daily_pages(output_dir)
    if used >= max_pages:
        logging.getLogger("pdf2obsidian").warning(
            "今日精度模式页数已达上限 (%d/%d)，暂停使用精度模式。",
            used, max_pages,
        )
        return False
    return True
