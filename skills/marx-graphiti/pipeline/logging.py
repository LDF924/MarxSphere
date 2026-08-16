#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一的日志系统，集成模块6的 LoggerManager（耗时、Token、成本统计）
消除 6 个模块的 logging.basicConfig boilerplate
"""

import logging
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Callable, Tuple


class LogLevel(Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"
    DEBUG = "DEBUG"


@dataclass
class LogEntry:
    timestamp: datetime
    level: LogLevel
    module: str
    message: str
    duration: float = 0.0
    token_usage: int = 0
    cost: float = 0.0
    details: Dict = field(default_factory=dict)


@dataclass
class LiteratureProcessRecord:
    literature_id: str
    stage: str
    status: str
    start_time: datetime
    end_time: Optional[datetime] = None
    duration: float = 0.0
    token_usage: int = 0
    cost: float = 0.0
    error_msg: str = ""


_LOG_DIR = Path("D:/logs")
try:
    _LOG_DIR.mkdir(exist_ok=True)
except PermissionError:
    import tempfile
    _LOG_DIR = Path(tempfile.gettempdir()) / "pipeline_logs"
    _LOG_DIR.mkdir(exist_ok=True)

_LOGGER = None
_LOGGER_MANAGER = None


def get_logger(name: str = "pipeline") -> logging.Logger:
    """获取标准 Python logger（兼容旧代码）"""
    global _LOGGER
    if _LOGGER is not None:
        return _LOGGER.getChild(name) if name != "pipeline" else _LOGGER

    log_file = _LOG_DIR / f"pipeline_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    _LOGGER = logging.getLogger("pipeline")
    _LOGGER.setLevel(logging.INFO)
    _LOGGER.handlers.clear()

    fmt = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    _LOGGER.addHandler(fh)
    _LOGGER.addHandler(sh)

    return _LOGGER if name == "pipeline" else _LOGGER.getChild(name)


class LoggerManager:
    """分级日志管理器（含耗时统计、Token 核算、批量重试）"""

    def __init__(self, log_dir: Path = None):
        self.log_dir = log_dir or _LOG_DIR
        self.log_dir.mkdir(exist_ok=True)
        self.current_log_file = self.log_dir / f"pipeline_{datetime.now().strftime('%Y%m%d')}.log"
        self.error_log_file = self.log_dir / f"errors_{datetime.now().strftime('%Y%m%d')}.log"
        self.warning_log_file = self.log_dir / f"warnings_{datetime.now().strftime('%Y%m%d')}.log"

        self.entries: List[LogEntry] = []
        self.literature_records: Dict[str, LiteratureProcessRecord] = {}
        self.total_token_usage = 0
        self.total_cost = 0.0
        self._logger = get_logger("LoggerManager")

    def log(self, level: LogLevel, module: str, message: str,
            duration: float = 0, token_usage: int = 0, cost: float = 0,
            details: Dict = None):
        entry = LogEntry(
            timestamp=datetime.now(), level=level, module=module, message=message,
            duration=duration, token_usage=token_usage, cost=cost, details=details or {}
        )
        self.entries.append(entry)
        self.total_token_usage += token_usage
        self.total_cost += cost

        log_line = (f"{entry.timestamp.isoformat()} - {level.value} - {module} - {message}"
                    f" | 耗时:{duration:.2f}s | Token:{token_usage} | 成本:{cost:.4f}元")
        with open(self.current_log_file, "a", encoding="utf-8") as f:
            f.write(log_line + "\n")

        if level == LogLevel.ERROR:
            with open(self.error_log_file, "a", encoding="utf-8") as f:
                f.write(log_line + f" - {json.dumps(details, ensure_ascii=False)}\n")
        elif level == LogLevel.WARNING:
            with open(self.warning_log_file, "a", encoding="utf-8") as f:
                f.write(log_line + "\n")

        if level == LogLevel.ERROR:
            self._logger.error(message)
        elif level == LogLevel.WARNING:
            self._logger.warning(message)
        else:
            self._logger.info(message)

    def start_literature(self, literature_id: str, stage: str):
        self.literature_records[literature_id] = LiteratureProcessRecord(
            literature_id=literature_id, stage=stage, status="pending", start_time=datetime.now()
        )

    def finish_literature(self, literature_id: str, stage: str, success: bool = True,
                          token_usage: int = 0, error_msg: str = ""):
        record = self.literature_records.get(literature_id)
        if not record:
            return
        record.end_time = datetime.now()
        record.duration = (record.end_time - record.start_time).total_seconds()
        record.status = "success" if success else "failed"
        record.token_usage = token_usage
        from .config import CONFIG
        record.cost = token_usage / 1000 * CONFIG.get("api", {}).get("deepseek", {}).get("price_per_1k_tokens", 0.001)
        record.error_msg = error_msg
        self.total_token_usage += token_usage
        self.total_cost += record.cost

        if success:
            self.log(LogLevel.INFO, "LITERATURE",
                     f"文献 {literature_id} {stage} 阶段完成",
                     duration=record.duration, token_usage=token_usage, cost=record.cost)
        else:
            self.log(LogLevel.ERROR, "LITERATURE",
                     f"文献 {literature_id} {stage} 阶段失败: {error_msg}",
                     duration=record.duration, token_usage=token_usage, cost=record.cost)

    def get_failed_literatures(self, stage: str = None) -> List[Dict]:
        failed = []
        for record in self.literature_records.values():
            if record.status == "failed":
                if stage is None or record.stage == stage:
                    failed.append({
                        "literature_id": record.literature_id,
                        "stage": record.stage,
                        "error": record.error_msg,
                        "timestamp": record.end_time.isoformat() if record.end_time else ""
                    })
        return failed

    def export_failure_list(self, file_path: Path = None) -> Path:
        if not file_path:
            file_path = self.log_dir / f"failed_literatures_{datetime.now().strftime('%Y%m%d')}.json"
        import json
        failed_list = self.get_failed_literatures()
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(failed_list, f, ensure_ascii=False, indent=2)
        self.log(LogLevel.INFO, "EXPORT", f"失败清单已导出: {file_path} (共 {len(failed_list)} 条)")
        return file_path

    def batch_retry(self, stage: str, retry_func: Callable[[str], bool]) -> Tuple[int, int]:
        failed_items = self.get_failed_literatures(stage)
        if not failed_items:
            self.log(LogLevel.INFO, "RETRY", f"{stage} 阶段无失败记录，无需重试")
            return 0, 0
        self.log(LogLevel.INFO, "RETRY", f"开始批量重试 {stage} 阶段，共 {len(failed_items)} 条")
        success_count = 0
        fail_count = 0
        for item in failed_items:
            lit_id = item["literature_id"]
            try:
                self.start_literature(lit_id, stage)
                result = retry_func(lit_id)
                if result:
                    self.finish_literature(lit_id, stage, success=True)
                    success_count += 1
                else:
                    self.finish_literature(lit_id, stage, success=False, error_msg="重试后仍失败")
                    fail_count += 1
            except Exception as e:
                self.finish_literature(lit_id, stage, success=False, error_msg=str(e))
                fail_count += 1
        self.log(LogLevel.INFO, "RETRY", f"批量重试完成: 成功 {success_count} 条，失败 {fail_count} 条")
        return success_count, fail_count

    def get_cost_summary(self) -> Dict:
        return {
            "total_token": self.total_token_usage,
            "total_cost": round(self.total_cost, 4),
            "processed_literatures": len(self.literature_records),
            "failed_count": len(self.get_failed_literatures())
        }
