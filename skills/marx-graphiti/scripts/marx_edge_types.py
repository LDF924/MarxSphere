"""
Curated relation types and entity constraints for the Marx capital-to-countryside domain.

These are designed to be passed as `edge_types` to Graphiti's add_episode / add_episode_bulk,
constraining the LLM to use ONLY these relation types with typed attribute schemas.

Usage:
  from marx_edge_types import MARX_EDGE_TYPES, MARX_ENTITY_TYPE_MAP
  await graphiti.add_episode(
      name=paper_name, episode_body=content,
      source_description="CSSCI 学术论文",
      edge_types=MARX_EDGE_TYPES,
  )
"""

from pydantic import BaseModel, Field


# ═══════════════════════════════════════════════════════════════════════════════
# Entity type taxonomy (33 domain types — maps to Graphiti entity labels)
# ═══════════════════════════════════════════════════════════════════════════════

MARX_ENTITY_TYPE_MAP = {
    # ── Core actors ──
    "工商资本": "industrial_commercial_capital",
    "政府主体": "government_actor",
    "村集体组织": "village_collective",
    "农户": "farm_household",
    "新型农业经营主体": "new_agricultural_operator",
    "龙头企业": "leading_enterprise",
    "合作社": "cooperative",
    "家庭农场": "family_farm",
    "社会资本": "social_capital",

    # ── Policy & regulation ──
    "政策文件": "policy_document",
    "土地制度": "land_system",
    "财政补贴": "fiscal_subsidy",
    "金融支持": "financial_support",
    "监管机制": "regulatory_mechanism",

    # ── Economic concepts ──
    "土地流转": "land_transfer",
    "规模经营": "scale_operation",
    "产业融合": "industrial_integration",
    "价值链": "value_chain",
    "利益联结机制": "benefit_linkage_mechanism",
    "集体经济": "collective_economy",

    # ── Social / governance ──
    "乡村治理": "rural_governance",
    "农户权益": "farmer_rights",
    "公共性": "publicness",
    "社会风险": "social_risk",
    "土地纠纷": "land_dispute",

    # ── Spatial / geographic ──
    "地理区域": "geographic_region",
    "产业园区": "industrial_park",
    "生产基地": "production_base",

    # ── Research / academic ──
    "理论概念": "theoretical_concept",
    "研究方法": "research_method",
    "指标体系": "indicator_system",

    # ── Temporal ──
    "时间节点": "temporal_marker",
    "政策阶段": "policy_phase",
}


# ═══════════════════════════════════════════════════════════════════════════════
# Curated relation types (15 core types for capital-to-countryside domain)
# ═══════════════════════════════════════════════════════════════════════════════

class IMPLEMENTS(BaseModel):
    """A policy/regulation/program is implemented by an actor or organization."""
    implementer: str = Field(..., description="执行主体名称")
    scope: str | None = Field(None, description="实施范围（如'全国''试点县'）")
    start_year: str | None = Field(None, description="开始年份")


class REGULATES(BaseModel):
    """A policy/regulation governs or constrains an activity or entity."""
    target_activity: str = Field(..., description="被规制的活动")
    mechanism: str | None = Field(None, description="规制手段（如'准入限制''补贴条件'）")
    legal_basis: str | None = Field(None, description="法律依据")


class TRANSFERS_TO(BaseModel):
    """Entity A transfers land / resources / rights to Entity B."""
    resource_type: str = Field(..., description="流转资源类型（土地/资金/股权/经营权）")
    area_mu: str | None = Field(None, description="面积（亩）")
    payment_mode: str | None = Field(None, description="支付方式（租金/分红/一次付清）")


class INVESTS_IN(BaseModel):
    """An actor invests capital/resources into a project/region/industry."""
    amount: str | None = Field(None, description="投资额度")
    industry: str | None = Field(None, description="投资产业方向")
    investment_form: str | None = Field(None, description="投资形式（独资/合资/参股）")


class CAUSES(BaseModel):
    """Entity/event A causes or leads to outcome B (causal chain)."""
    mechanism: str = Field(..., description="因果机制描述")
    direction: str = Field(default="positive", description="正向/负向影响")
    evidence_level: str | None = Field(None, description="证据强度（直接证据/案例推断/理论推导）")


class CONFLICTS_WITH(BaseModel):
    """Entity A is in conflict or tension with Entity B."""
    conflict_type: str = Field(..., description="冲突类型（利益/权利/文化/产权）")
    severity: str | None = Field(None, description="严重程度")
    resolution: str | None = Field(None, description="解决方式（如有）")


class PARTICIPATES_IN(BaseModel):
    """An actor participates in an activity/program/organization."""
    role: str = Field(..., description="参与角色（主导/配合/受益/被排斥）")
    participation_form: str | None = Field(None, description="参与形式（入股/务工/出租/合作）")
    benefit_distribution: str | None = Field(None, description="利益分配方式")


class BENEFITS(BaseModel):
    """Entity A benefits (economically/socially) from Entity B."""
    benefit_type: str = Field(..., description="受益类型（经济/社会/政治/生态）")
    magnitude: str | None = Field(None, description="受益程度")


class HARMED_BY(BaseModel):
    """Entity A is negatively affected/harmed by Entity B."""
    harm_type: str = Field(..., description="损害类型（经济/权益/环境/社会关系）")
    affected_group: str | None = Field(None, description="受影响群体")


class CONTAINS(BaseModel):
    """A larger concept/region/policy contains or encompasses a sub-component."""
    containment_type: str = Field(..., description="包含类型（地理/行政/概念/政策）")
    hierarchy_level: str | None = Field(None, description="层级关系")


class DEPENDS_ON(BaseModel):
    """Entity A depends on Entity B for resources/support/legitimacy."""
    dependency_type: str = Field(..., description="依赖类型（资源/制度/市场/技术）")
    criticality: str | None = Field(None, description="依赖关键程度（不可替代/可替代/互补）")


class TRANSFORMS(BaseModel):
    """Entity A transforms/changes Entity B in a structural way."""
    transformation_aspect: str = Field(..., description="变化的方面（结构/关系/功能/性质）")
    before_state: str | None = Field(None, description="变化前状态")
    after_state: str | None = Field(None, description="变化后状态")


class CONSTRAINS(BaseModel):
    """Entity A limits or constrains Entity B (not necessarily conflict)."""
    constraint_type: str = Field(..., description="约束类型（制度/资源/认知/结构）")
    severity: str | None = Field(None, description="约束强度")


class FACILITATES(BaseModel):
    """Entity A enables/facilitates Entity B (positive enabling, not direct cause)."""
    facilitation_mechanism: str = Field(..., description="促进机制")
    condition: str | None = Field(None, description="促进的前提条件")


class EMBODIES(BaseModel):
    """Entity A represents or embodies the characteristics/values of Entity B."""
    aspect: str = Field(..., description="体现的方面（价值/逻辑/特征/模式）")
    typicality: str | None = Field(None, description="典型性（典型案例/普遍现象/特例）")


# ═══════════════════════════════════════════════════════════════════════════════
# Assembled edge_types dict for Graphiti
# ═══════════════════════════════════════════════════════════════════════════════

MARX_EDGE_TYPES: dict[str, type[BaseModel]] = {
    "IMPLEMENTS": IMPLEMENTS,
    "REGULATES": REGULATES,
    "TRANSFERS_TO": TRANSFERS_TO,
    "INVESTS_IN": INVESTS_IN,
    "CAUSES": CAUSES,
    "CONFLICTS_WITH": CONFLICTS_WITH,
    "PARTICIPATES_IN": PARTICIPATES_IN,
    "BENEFITS": BENEFITS,
    "HARMED_BY": HARMED_BY,
    "CONTAINS": CONTAINS,
    "DEPENDS_ON": DEPENDS_ON,
    "TRANSFORMS": TRANSFORMS,
    "CONSTRAINS": CONSTRAINS,
    "FACILITATES": FACILITATES,
    "EMBODIES": EMBODIES,
}

# Short description of each type for LLM extraction prompts
MARX_EDGE_TYPE_DESCRIPTIONS = {
    "IMPLEMENTS":      "政策或制度被某个主体执行实施",
    "REGULATES":        "政策/法规对某活动/主体的规制约束",
    "TRANSFERS_TO":     "土地/资源/权益从一方向另一方流转",
    "INVESTS_IN":       "资本/资源投入到项目/地区/产业",
    "CAUSES":           "因果链条：A导致B发生/变化",
    "CONFLICTS_WITH":   "利益/权利/产权冲突对立关系",
    "PARTICIPATES_IN":  "主体参与活动/项目/组织并承担角色",
    "BENEFITS":         "A从B中获得收益（经济/社会/政治）",
    "HARMED_BY":        "A受到B的损害或负面影响",
    "CONTAINS":         "概念/区域/政策包含子组件",
    "DEPENDS_ON":       "A在资源/制度/市场上依赖于B",
    "TRANSFORMS":       "A结构性改变B的状态/关系/功能",
    "CONSTRAINS":       "A约束/限制B的发展或行动空间",
    "FACILITATES":      "A创造有利条件促进B的发展",
    "EMBODIES":         "A代表/体现B的价值/逻辑/特征",
}
