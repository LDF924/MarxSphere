"""AI 内容生成：摘要、术语表、问答。通过 llm.py 统一抽象层。"""

import json
import logging
import re
from typing import Optional
from llm import chat, get_llm_mode, get_model_name

logger = logging.getLogger("pdf2obsidian")

# 研究领域上下文（注入 prompt 中）
FIELD_CONTEXT = (
    "资本规范与引导、资本治理、资本市场、资本监管、资本健康发展、"
    "金融监管/金融监管改革、证券市场监管、资本无序扩张、平台经济反垄断、"
    "社会资本、政府与社会资本合作(PPP)、民间资本、私募基金/私募股权、"
    "公司法/公司治理、新公司法、注册资本、企业合规、"
    "信息披露、会计规范、投资者保护、"
    "数字经济/数字资本、数字经济治理、"
    "工商资本、共同富裕、合作社、农民增收/农民收入、农业经济、农业农村现代化、"
    "三农、田野调查、乡村产业振兴、乡村干部/乡镇干部、乡村农业/乡镇农业、"
    "乡村企业/乡镇企业、乡村振兴、乡村治理/乡村基层治理/乡镇治理、"
    "中国式现代化、资本参与、资本下乡"
)


def generate_summary(markdown: str, config: dict) -> Optional[str]:
    system = f"""你是中国社会科学、金融经济学、公共管理与资本市场治理领域的资深学术编辑。
研究领域覆盖：{FIELD_CONTEXT}。

阅读以下论文，生成 10 条编号要点摘要，每条 80-120 字。要求：
- 每条引用正文中对应的文献编号（如 [5]、[8,10]）
- 覆盖：核心概念界定、理论框架、研究方法与数据来源、主要实证发现、政策建议
- 对涉及金融/资本市场的论文，指出具体监管政策文件、时间节点
- 对涉及田野调查的论文，指出调查地点、样本量和研究方法
- 区分"资本下乡""社会资本""资本要素""资本无序扩张"等不同语境

只输出摘要内容，不要任何标题或其他说明。"""

    excerpt = markdown[:12000]
    logger.info("  生成摘要...")
    return chat(system, excerpt, config, max_tokens=4096, usage_key="summary")


def generate_glossary(markdown: str, config: dict) -> Optional[list[dict]]:
    system = f"""你是中国社会科学、金融经济学、公共管理与资本市场治理领域的术语专家。
研究领域覆盖：{FIELD_CONTEXT}。

从论文中提取 15-25 个关键学术术语，输出 JSON 数组。每个术语给出在该论文语境下的精准学术释义（1-2句）。

特别关注以下类型术语：
- 核心概念：论文提出或重点讨论的学术概念（如"资本红绿灯""资本无序扩张""耐心资本""注册制""代表人诉讼"等）
- 政策术语：中央经济工作会议、金融监管政策文件中的专有名词
- 金融/法律术语：信息披露、关联交易、合规管理、实缴资本、认缴制、PPP等
- 研究方法：田野调查、双重差分、案例分析、实证研究等
- 理论框架：制度变迁理论、嵌入性理论、利益联结机制、资本有机构成等
- 经济学术语：资本要素、市场准入、反垄断、多层次资本市场等

输出纯 JSON 数组：
[
  {{"term": "中文术语", "english": "English Term", "definition": "基于本文的精准学术释义"}},
  ...
]"""

    excerpt = markdown[:12000]
    logger.info("  生成术语表...")
    result = chat(system, excerpt, config, max_tokens=4096, usage_key="glossary")
    if not result:
        return None
    return _parse_json_response(result)


def generate_qa(markdown: str, config: dict) -> Optional[list[dict]]:
    system = f"""你是中国社会科学、金融经济学、公共管理与资本市场治理领域的教学专家。
研究领域覆盖：{FIELD_CONTEXT}。

基于论文生成 8-12 道复习问答。要求：
- 覆盖以下维度：
  * methodology（研究方法：数据来源、样本量、调查地点、计量模型）
  * finding（主要发现：实证结果、案例总结、机制分析）
  * theory（理论框架：核心概念、理论假说、分析框架）
  * policy（政策启示：政策建议、现实意义、制度设计）
- 问题要具体，答案要以"答："开头，引用论文中的具体内容
- 对涉及田野调查的论文，至少 1 道关于研究方法的题目
- 对涉及政策建议的论文，至少 1 道关于政策启示的题目
- 区分"资本下乡""社会资本""资本要素""资本无序扩张""金融资本"等不同语境

输出纯 JSON 数组：
[
  {{"question": "具体问题？", "answer": "答：基于论文内容的具体回答。", "type": "methodology|finding|theory|policy"}},
  ...
]"""

    excerpt = markdown[:12000]
    logger.info("  生成问答...")
    result = chat(system, excerpt, config, max_tokens=4096, usage_key="qa")
    if not result:
        return None
    return _parse_json_response(result)


def generate_all(markdown: str, config: dict) -> dict:
    mode = get_llm_mode(config)
    model = get_model_name(config)
    tag = f"{model} ({mode})"
    logger.info("  LLM: %s", tag)
    return {
        "summary": generate_summary(markdown, config),
        "glossary": generate_glossary(markdown, config),
        "qa": generate_qa(markdown, config),
        "_llm": tag,
    }


def _parse_json_response(text: str) -> Optional[list]:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1]) if len(lines) > 2 else text
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass
    m = re.search(r"\[\s*\{.*?\}\s*\]", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    logger.warning("  无法解析 LLM JSON: %s...", text[:100])
    return None
