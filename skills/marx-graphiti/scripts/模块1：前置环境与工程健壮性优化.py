#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模块1：前置环境与工程健壮性优化
功能：
1. 环境自检与前置校验（Graphiti、Neo4j、API连通性+额度）
2. API密钥安全管理（测试/正式密钥一键切换）
3. 断点续跑与阶段备份（分阶段状态标记、自动dump、单阶段独立执行）
"""

import os
import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple
import requests

# 将上级目录加入 sys.path，确保 pipeline 包可导入
sys.path.insert(0, str(Path(__file__).parent))

from pipeline import (
    CONFIG, RUN_ENV, DEEPSEEK_API_KEY, QWEN_API_KEY,
    Neo4jConnection, get_logger, LoggerManager, LogLevel
)

logger = get_logger("module1")

# ======================== 运行配置 ========================
RUN_CONFIG = {
    "interactive_mode": False,
    "auto_backup_on_stage": True
}

# ======================== API密钥管理 ========================
API_KEYS = {
    "test": {
        "deepseek": os.environ.get("DEEPSEEK_TEST_KEY", DEEPSEEK_API_KEY),
        "qwen_embed": os.environ.get("QWEN_TEST_KEY", QWEN_API_KEY)
    },
    "production": {
        "deepseek": DEEPSEEK_API_KEY,
        "qwen_embed": QWEN_API_KEY
    }
}
CURRENT_ENV = RUN_ENV
SELECTED_KEYS = API_KEYS[CURRENT_ENV]


# ======================== 1. 环境自检与前置校验 ========================
class EnvironmentChecker:
    """环境自检类"""

    def __init__(self):
        self.neo4j_conn = None
        self.check_results = {
            "graphiti": False,
            "neo4j": False,
            "deepseek_api": False,
            "qwen_api": False,
            "neo4j_memory": False,
            "neo4j_vector_index": False
        }
        self.missing_files = []
        self.invalid_files = []
        self.valid_folders = []

    def check_graphiti(self) -> bool:
        try:
            import graphiti
            logger.info("✅ Graphiti 可用")
            return True
        except ImportError:
            logger.error("❌ Graphiti 未安装")
            return False

    def check_neo4j_connection(self) -> bool:
        try:
            from pipeline.neo4j import Neo4jConnection as NC
            self.neo4j_conn = NC()
            result = self.neo4j_conn.execute_query("RETURN 1 as test")
            if result[0]["test"] == 1:
                logger.info("✅ Neo4j 连接成功")
                return True
        except Exception as e:
            logger.error(f"❌ Neo4j 连接失败: {e}")
            return False

    def check_neo4j_memory(self) -> bool:
        try:
            result = self.neo4j_conn.execute_query("CALL dbms.memory.info()")
            memory_info = result[0]
            heap = memory_info.get("heap", {}).get("used", 0)
            if heap > 1024 * 1024 * 512:
                logger.info(f"✅ Neo4j 内存配置足够: {heap / 1024 / 1024:.0f} MB")
                return True
            else:
                logger.warning(f"⚠️ Neo4j 内存可能不足: {heap / 1024 / 1024:.0f} MB")
                return False
        except Exception as e:
            logger.warning(f"⚠️ 无法获取内存信息: {e}，降级通过")
            return True

    def check_neo4j_vector_index(self) -> bool:
        try:
            self.neo4j_conn.execute_write("""
                CREATE VECTOR INDEX entity_vector_idx IF NOT EXISTS
                FOR (e:Entity) ON (e.entity_vector)
                OPTIONS {indexConfig: {
                    `vector.dimensions`: 1024,
                    `vector.similarity_function`: 'cosine'
                }}
            """)
            logger.info("✅ Neo4j 向量索引支持正常")
            return True
        except Exception as e:
            logger.error(f"❌ Neo4j 向量索引不支持: {e}")
            logger.error("   提示: 请使用Neo4j 5.18+ 或升级企业版")
            return False

    def check_api_quota(self, api_type: str, api_key: str) -> bool:
        try:
            if api_type == "deepseek":
                url = "https://api.deepseek.com/v1/user/balance"
                headers = {"Authorization": f"Bearer {api_key}"}
                resp = requests.get(url, headers=headers, timeout=10)
                if resp.status_code == 200:
                    balance_info = resp.json()
                    available = float(balance_info.get("balance_available", 0))
                    if available > 0.1:
                        logger.info(f"✅ DeepSeek API 正常，剩余额度: {available:.2f} 元")
                        return True
                    else:
                        logger.error(f"❌ DeepSeek API 余额不足: {available:.2f} 元")
                        return False
                else:
                    logger.error(f"❌ DeepSeek API 校验失败: {resp.status_code}")
                    return False

            elif api_type == "qwen":
                url = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"
                headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                payload = {"model": "qwen3-embedding-4b", "input": {"texts": ["health_check"]}}
                resp = requests.post(url, headers=headers, json=payload, timeout=10)
                if resp.status_code == 200 and "output" in resp.json():
                    logger.info("✅ 通义Embedding API 正常，额度校验通过")
                    return True
                else:
                    logger.error(f"❌ 通义Embedding API 校验失败: {resp.status_code}")
                    return False
            else:
                return False

        except Exception as e:
            logger.error(f"❌ {api_type.upper()} API 连接失败: {e}")
            return False

    def validate_import_folder(self) -> Tuple[List[str], List, List]:
        base_path = Path("D:\\Desktop\\ov_import")
        if not base_path.exists():
            logger.error(f"❌ 导入目录不存在: {base_path}")
            return [], [], []

        missing = []
        invalid = []
        valid = []
        required_files = ["原文.original.md", "术语表.md", "问答.md", "摘要.md"]

        for folder in base_path.iterdir():
            if not folder.is_dir():
                continue

            missing_files = [f for f in required_files if not (folder / f).exists()]
            if missing_files:
                missing.append({"folder": folder.name, "missing": missing_files})
                logger.warning(f"⚠️ 文件夹 {folder.name} 缺失文件: {missing_files}，自动跳过")
                continue

            folder_valid = True
            for f in required_files:
                file_path = folder / f
                if file_path.stat().st_size < 50:
                    invalid.append({"folder": folder.name, "file": f, "reason": "文件过小/空文件"})
                    folder_valid = False
                    break
                try:
                    with open(file_path, 'r', encoding='utf-8') as fp:
                        fp.read(1024)
                except UnicodeDecodeError:
                    invalid.append({"folder": folder.name, "file": f, "reason": "UTF-8编码错误/乱码"})
                    folder_valid = False
                    break

            if folder_valid:
                valid.append(folder.name)

        logger.info(f"📊 文献校验完成：有效 {len(valid)} 篇，缺失文件 {len(missing)} 篇，无效文件 {len(invalid)} 个")
        self.valid_folders = valid
        self.missing_files = missing
        self.invalid_files = invalid
        return valid, missing, invalid

    def run_all_checks(self) -> Dict:
        logger.info("=" * 60)
        logger.info("开始环境自检与前置校验...")

        self.check_results["graphiti"] = self.check_graphiti()
        self.check_results["neo4j"] = self.check_neo4j_connection()

        if self.check_results["neo4j"]:
            self.check_results["neo4j_memory"] = self.check_neo4j_memory()
            self.check_results["neo4j_vector_index"] = self.check_neo4j_vector_index()

        self.check_results["deepseek_api"] = self.check_api_quota("deepseek", SELECTED_KEYS["deepseek"])
        self.check_results["qwen_api"] = self.check_api_quota("qwen", SELECTED_KEYS["qwen_embed"])

        self.validate_import_folder()
        self.check_results["folder_valid"] = len(self.valid_folders) > 0

        logger.info("=" * 60)
        logger.info("环境自检完成，结果汇总：")
        for key, value in self.check_results.items():
            status = "✅" if value else "❌"
            logger.info(f"  {status} {key}: {value}")

        return self.check_results


# ======================== 2. API密钥安全管理 ========================
class KeyManager:
    @staticmethod
    def switch_env(env: str):
        global CURRENT_ENV, SELECTED_KEYS
        if env not in API_KEYS:
            logger.error(f"❌ 未知环境: {env}")
            return False
        CURRENT_ENV = env
        SELECTED_KEYS = API_KEYS[env]
        logger.info(f"✅ 已切换到 {env} 环境")
        logger.info(f"   DeepSeek Key 前缀: {SELECTED_KEYS['deepseek'][:10]}...")
        return True

    @staticmethod
    def get_current_keys():
        return SELECTED_KEYS


# ======================== 3. 断点续跑与阶段备份 ========================
class CheckpointManager:
    CHECKPOINT_FILE = Path("D:\\checkpoints\\pipeline_state.json")

    def __init__(self):
        self.CHECKPOINT_FILE.parent.mkdir(exist_ok=True)
        self.state = self.load_state()

    def load_state(self) -> Dict:
        if self.CHECKPOINT_FILE.exists():
            with open(self.CHECKPOINT_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {
            "last_completed_stage": None,
            "stage_progress": {
                "extract_entities": [], "extract_relations": [],
                "entity_disambiguation": [], "conflict_detection": [],
                "community_clustering": [], "vectorization": [],
                "literature_distill": [], "domain_knowledge": []
            },
            "stats": {"entity_count": 0, "relation_count": 0,
                      "literature_distill_count": 0, "domain_knowledge_count": 0},
            "backup_records": []
        }

    def save_state(self):
        with open(self.CHECKPOINT_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.state, f, ensure_ascii=False, indent=2)

    def mark_folder_processed(self, stage: str, folder_name: str):
        if stage not in self.state["stage_progress"]:
            logger.warning(f"⚠️ 未知阶段 {stage}，跳过状态标记")
            return
        if folder_name not in self.state["stage_progress"][stage]:
            self.state["stage_progress"][stage].append(folder_name)
            self.save_state()

    def is_folder_processed(self, stage: str, folder_name: str) -> bool:
        if stage not in self.state["stage_progress"]:
            return False
        return folder_name in self.state["stage_progress"][stage]

    def get_unprocessed_folders(self, stage: str, all_valid_folders: List[str]) -> List[str]:
        if stage not in self.state["stage_progress"]:
            return all_valid_folders
        return [f for f in all_valid_folders if f not in self.state["stage_progress"][stage]]

    def mark_stage_completed(self, stage: str, auto_backup: bool = None):
        if auto_backup is None:
            auto_backup = RUN_CONFIG["auto_backup_on_stage"]
        self.state["last_completed_stage"] = stage
        self.save_state()
        logger.info(f"✅ 阶段 {stage} 已完成，状态已持久化")
        if auto_backup:
            logger.info("🔄 自动执行Neo4j全库备份...")
            backup_path = self.backup_neo4j()
            if backup_path:
                self.state["backup_records"].append({
                    "stage": stage,
                    "time": datetime.now().isoformat(),
                    "path": backup_path
                })
                self.save_state()

    @staticmethod
    def backup_neo4j() -> Optional[str]:
        backup_dir = Path("D:\\backups")
        backup_dir.mkdir(exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        dump_path = backup_dir / f"neo4j_dump_{timestamp}.dump"
        try:
            cmd = f"neo4j-admin dump --database=neo4j --to={dump_path}"
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            if result.returncode == 0:
                logger.info(f"✅ Neo4j 备份成功: {dump_path}")
                return str(dump_path)
            else:
                logger.error(f"❌ Neo4j 备份失败: {result.stderr}")
                return None
        except Exception as e:
            logger.error(f"❌ 备份异常: {e}")
            return None

    @staticmethod
    def restore_neo4j(dump_path: str) -> bool:
        try:
            cmd = f"neo4j-admin load --database=neo4j --from={dump_path}"
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            if result.returncode == 0:
                logger.info(f"✅ Neo4j 恢复成功: {dump_path}")
                return True
            else:
                logger.error(f"❌ Neo4j 恢复失败: {result.stderr}")
                return False
        except Exception as e:
            logger.error(f"❌ 恢复异常: {e}")
            return False


class StageRunner:
    STAGE_MAP = {
        "extract_entities": "module_2_extract_entities.py",
        "extract_relations": "module_2_extract_relations.py",
        "entity_disambiguation": "module_2_disambiguation.py",
        "conflict_detection": "module_2_conflict.py",
        "community_clustering": "module_2_clustering.py",
        "vectorization": "module_3_vectorization.py",
        "literature_distill": "module_4_literature_distill.py",
        "domain_knowledge": "module_4_domain_knowledge.py"
    }

    @staticmethod
    def run_stage(stage_name: str) -> bool:
        if stage_name not in StageRunner.STAGE_MAP:
            logger.error(f"❌ 未知阶段: {stage_name}")
            logger.error(f"   支持的阶段: {list(StageRunner.STAGE_MAP.keys())}")
            return False
        script_path = Path(f"D:\\scripts\\{StageRunner.STAGE_MAP[stage_name]}")
        if not script_path.exists():
            logger.error(f"❌ 脚本不存在: {script_path}")
            return False
        logger.info(f"🚀 开始独立执行阶段: {stage_name}")
        try:
            subprocess.run(["python", str(script_path)], check=True)
            logger.info(f"✅ 阶段 {stage_name} 执行完成")
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"❌ 阶段 {stage_name} 执行失败: {e}")
            return False


# ======================== 主函数 ========================
def main():
    logger.info("=" * 80)
    logger.info("模块1：前置环境与工程健壮性优化")
    logger.info("=" * 80)

    checker = EnvironmentChecker()
    results = checker.run_all_checks()

    critical_failed = not all([
        results["neo4j"], results["deepseek_api"],
        results["qwen_api"], results["folder_valid"]
    ])

    if critical_failed:
        logger.error("❌ 关键检查项失败，流水线终止")
        if RUN_CONFIG["interactive_mode"]:
            response = input("是否强制继续执行? (y/n): ")
            if response.lower() != 'y':
                logger.info("流水线已终止")
                return
        else:
            return

    logger.info(f"\n📋 可处理有效文献共 {len(checker.valid_folders)} 篇")

    key_manager = KeyManager()
    logger.info(f"\n当前运行环境: {CURRENT_ENV}")
    logger.info(f"DeepSeek密钥前缀: {SELECTED_KEYS['deepseek'][:10]}...")
    logger.info(f"通义Embedding密钥前缀: {SELECTED_KEYS['qwen_embed'][:10]}...")

    if RUN_CONFIG["interactive_mode"]:
        switch = input("\n是否切换环境? (test/production/直接回车保持): ")
        if switch in ["test", "production"]:
            key_manager.switch_env(switch)

    checkpoint = CheckpointManager()
    logger.info(f"\n📌 当前进度：上次完成阶段 = {checkpoint.state['last_completed_stage']}")
    for stage, folders in checkpoint.state["stage_progress"].items():
        if folders:
            logger.info(f"   {stage}: 已处理 {len(folders)} 篇")

    if RUN_CONFIG["interactive_mode"]:
        backup_choice = input("\n是否立即执行一次Neo4j全库备份? (y/n): ")
        if backup_choice.lower() == 'y':
            backup_path = checkpoint.backup_neo4j()
            if backup_path:
                logger.info(f"✅ 手动备份完成: {backup_path}")

        stage_choice = input("\n是否执行单阶段任务? (输入阶段名/回车跳过): ").strip()
        if stage_choice and stage_choice in StageRunner.STAGE_MAP:
            StageRunner.run_stage(stage_choice)

    logger.info("\n✅ 模块1前置校验全部执行完成")
    logger.info("后续模块可直接调用 EnvironmentChecker.valid_folders 获取有效文献列表")


if __name__ == "__main__":
    main()
