/**
 * agent-failure-honesty.test.ts — "失败必须被记成失败"的三条硬判据(2026-10-01)。
 *
 * ═══ 这个文件守的是一个**不报错的谎** ═══
 *
 * 2026-10-01 实测: 一个 PPT 技能生成的 agent 任务, 三个步骤**全部失败**
 *   (检索超时 / 推理超时 / 写作失败), 而任务最终状态是 `completed`、
 *   reflect 给了 0.70 判 pass、进度写着"完成于第 1 轮循环"。
 *   **用户拿到的是一个"成功"的空任务** —— 不报错、不告警、界面上一片祥和。
 *
 * 根因是三层叠加, 每一层单独看都"合理":
 *
 *   ① `generateHypothesis` 超时时返回 `{content:'生成超时，请重试', confidence:0.3, ...}`
 *      —— 形状与真结果**完全一样**, 下游从内容上分辨不出这是一句错误提示。
 *   ② 自适应路径(`adaptive-operators`)只把 content/confidence 存进 ctx.flags,
 *      把"我是降级的"这个信息直接丢了。
 *   ③ 步骤完成验证是 `!!out.result && out.result.length > 0` —— **只看有没有输出,
 *      不看输出是什么**。于是"生成超时"被记成成功, `failures` 数组始终为空,
 *      reflect 拿到一个"没有任何失败项"的任务, 理所当然判 pass。
 *
 * 对应修法: ①降级自报家门(`degraded`) ②标志一路上带 ③执行器显式 `ok:false`
 *   时落成 failed。这个文件盯住这三条**契约**, 防止日后被"顺手简化"掉。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("① 降级必须自报家门 —— 不能只靠下游从字面猜", () => {
  const INF = read("src/services/inference-service.ts");

  it("generateHypothesis 的返回类型里有 degraded", () => {
    // 判据锚在**类型声明本身**: 字段没了, 后面所有传递都是徒劳
    const sig = INF.slice(INF.indexOf("private async generateHypothesis"));
    expect(sig.slice(0, 2000)).toMatch(/degraded\?:\s*boolean/);
  });

  it("超时降级分支带 degraded: true —— 且判据能看到那正是那条分支", () => {
    // 反向验证: 必须同时看到占位文案与 degraded, 否则"有 degraded"可能是别处写的
    const m = INF.match(/if \(!llmRes\) \{[\s\S]{0,400}?\}/);
    expect(m, "找不到 !llmRes 的降级分支").not.toBeNull();
    expect(m![0]).toContain("生成超时，请重试");
    expect(m![0]).toMatch(/degraded:\s*true/);
  });
});

describe("② 降级标志必须一路上带 —— 中间任何一环丢了都白搭", () => {
  const OPS = read("src/services/adaptive-operators.ts");
  const INF = read("src/services/inference-service.ts");

  it("自适应算子把 degraded 写进 ctx.flags", () => {
    expect(OPS).toMatch(/ctx\.flags\['hypothesis_degraded'\]\s*=\s*!!hyp\.degraded/);
  });

  it("重生成那条分支也要写(它是另一条独立路径, 容易漏)", () => {
    expect(OPS).toMatch(/ctx\.flags\['hypothesis_degraded'\]\s*=\s*!!regenerated\.degraded/);
  });

  it("trace 组装时把 degraded 带回 hypothesis 对象", () => {
    const seg = INF.slice(INF.indexOf("hypothesis: {\n          content: hypothesisContent"));
    expect(seg.slice(0, 600)).toMatch(/degraded:\s*true/);
  });
});

describe("③ 执行器说失败, 就必须落成 failed —— 这是最后一公里", () => {
  const SVC = read("src/services/agent-task-service.ts");
  const API = read("src/api/server.ts");

  it("StepExecutionResult 有 ok 字段且说明了为什么需要它", () => {
    const seg = SVC.slice(SVC.indexOf("export interface StepExecutionResult"));
    // 窗口要盖住整段注释 + 字段声明 —— 注释在前、字段在后, 开小了只看得到注释
    expect(seg.slice(0, 2500)).toMatch(/ok\?:\s*boolean/);
    // 注释里必须留着这个坑的由来, 否则后人会把它当冗余字段删掉
    expect(seg.slice(0, 2500)).toMatch(/完成|失败/);
  });

  it("完成验证把 ok:false 判成失败, 而不是只看有没有输出", () => {
    expect(SVC).toMatch(/const execFailed = \(out as \{ ok\?: boolean \}\)\.ok === false/);
    // 关键: 失败要落 status:"failed"。落成 done + 标记的话,
    // 下游 summarizeResult/reflect 按 status 取"已完成步骤", 标记就被绕过了
    expect(SVC).toMatch(/status:\s*execFailed \? "failed" : "done"/);
  });

  it("verification.how 认得 executor_flag(内容判不出真假时, 只有执行器知道)", () => {
    expect(SVC).toMatch(/"executor_flag"/);
  });

  it("推理执行器: 既认 data.error, 也认 hypothesis.degraded", () => {
    const seg = API.slice(API.indexOf("result: content.substring(0, 120)"));
    const window = seg.slice(0, 900);
    expect(window).toMatch(/ok:\s*!errMsg/);
    expect(window).toMatch(/degraded/);
  });

  it("写作执行器: 没拿到 content 就是失败, 别让'（写作失败）'被当成一篇写好的段落", () => {
    const m = API.match(/const text = data\?\.choices\?\.\[0\]\?\.message\?\.content \|\| "（写作失败）"[\s\S]{0,300}?ok:\s*([^,\n]+)/);
    expect(m, "写作步骤没给 ok 标志").not.toBeNull();
    // 反向验证: 那个表达式必须真的判到了 content 存不存在
    expect(m![1]).toMatch(/choices/);
  });

  it("兜底 catch 也标 ok:false(执行器抛异常时同样不能被当成成功)", () => {
    const seg = API.slice(API.indexOf("return { result: `执行失败:"));
    expect(seg.slice(0, 400)).toMatch(/ok:\s*false/);
  });
});

describe("④ 结构性: 全仓不该再有把 error 对象当字符串用的地方", () => {
  const API = read("src/api/server.ts");

  it("没有 `|| data?.error ||` 这种把 {code,message} 直接塞进字符串的写法", () => {
    /**
     * 这是第 ①②③ 层之外的**第四个**同源缺陷: `data.error` 是对象,
     * 直接 `||` 进一个最终要 `.substring()` 的字符串, 会抛
     * `content.substring is not a function` —— 那个 TypeError 会**盖住真正的错误**,
     * 让"少传了必填的 sourceId"变成一句看不懂的内部报错(实测踩到)。
     */
    expect(API).not.toMatch(/\|\|\s*data\?\.error\s*\|\|/);
  });

  it("取错误信息统一走 typeof 判定后再取 message", () => {
    // 至少要有若干处是这么取的(说明约定被遵守, 而不是全靠"恰好没有人踩")
    const hits = API.match(/typeof data\?\.error === "string" \? data\.error : data\?\.error\?\.message/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});

describe("⑤ 工具分派必须看步骤类型 —— 否则 write 步骤会去检索", () => {
  const API = read("src/api/server.ts");
  const SVC = read("src/services/agent-task-service.ts");

  it("三处分派点都按 type 收窄到 retrieve/reason", () => {
    /**
     * 2026-10-01 实测: 原来不管什么类型都先问 LLM "选哪个工具", 而 LLM 面对任何步骤
     * 几乎都选 `sag_search` —— 于是 **write/review 步骤也在检索**。一个标题为
     * "撰写…综述报告"的 write 步骤产出的是 `【知识库检索】10 条结果`。
     * 后果不是"写作质量差", 而是**这条链从来产不出成品**。
     */
    const hits = API.match(/step\.type === "retrieve" \|\| step\.type === "reason"/g) || [];
    expect(hits.length, "应有三处分派点按类型收窄(runAgentTaskInner + agent/chat 两处)").toBeGreaterThanOrEqual(3);
  });

  it("写作步骤要真的拿到**前序步骤的检索材料**作为依据", () => {
    expect(SVC).toBeDefined(); // 保持与上面 read 的一致性
    expect(API).toMatch(/已检索材料/);
    expect(API).toMatch(/不要编造具体数据/);
  });

  it("取依据必须用**实时**计划, 不能用开跑时的快照", () => {
    /**
     * `task` 是 runAgentTask 起跑时抓的快照, 那时所有步骤 status 还是 pending、
     * result 还是空 —— 从中筛"已完成步骤"必然得到 0 条, 证据管道静默失效。
     * 实测症状: 检索步骤返回了 2000+ 字真实材料, 写作步骤却写下
     * "在缺乏可核验检索材料的前提下, 本报告仅构建综述框架"。
     */
    expect(API).toMatch(/getAgentTask\(task\.id\)[\s\S]{0,200}?livePlan/);
  });
});

describe("⑥ 交付物必须真的交付", () => {
  const SVC = read("src/services/agent-task-service.ts");

  it("跑满轮数的分支也要写 result", () => {
    /**
     * 原来只有"达标"分支写 result, 最大轮数分支只更新 status/progress ——
     * 于是跑满轮数收场的任务**交付物是 null**, 而它的 write 步骤可能已写出上千字正文。
     * 实测: 交付物长度 null → 修复后 3922 字。
     */
    const seg = SVC.slice(SVC.indexOf("if (loop + 1 >= MAX_LOOPS)"));
    expect(seg.slice(0, 900)).toMatch(/result = \$4/);
    expect(seg.slice(0, 900)).toMatch(/summarizeResult/);
  });

  it("refine/汇总读的是全文(stepText), 不是 120 字预览", () => {
    // result 是给界面看的截断预览, detail 才是全文; 拿 result 判断质量必然失真
    expect(SVC).toMatch(/function stepText/);
    expect(SVC).not.toMatch(/\(s\.result \|\| ""\)\.slice\(0, 80\)/);
  });

  it("写作/评审产出排在汇总前面(检索是证据, 不是成品)", () => {
    const seg = SVC.slice(SVC.indexOf("async function summarizeResult"));
    expect(seg.slice(0, 900)).toMatch(/isOutput/);
  });
});

describe("⑦ HITL 审批必须能继续跑 —— 否则审批门是死路", () => {
  const API = read("src/api/server.ts");

  it("批准之后要重新入队执行", () => {
    /**
     * 原来 `approveAgentStep` 把状态改回 running、给步骤打 approved:true,
     * 但**没有任何东西重新启动执行循环** —— 而循环早在 awaiting_approval 那一跳
     * 就 break 退出了。于是批准后任务永远停在 running 却没人跑(实测 13 分钟零事件)。
     * 这个门是**所有 write/review 步骤的必经之路**, 所以它一断整条链就全断。
     */
    const seg = API.slice(API.indexOf('app.post("/api/agent/tasks/:id/approve"'));
    const body = seg.slice(0, 3000);
    expect(body).toMatch(/enqueueTask/);
    expect(body).toMatch(/runner: "agent-task"/);
  });
});

describe("⑧ execute 步骤类型 —— 让「产出文件」这件事有地方安放", () => {
  const SVC = read("src/services/agent-task-service.ts");
  const API = read("src/api/server.ts");
  const ROUTER = read("src/services/agent-tool-router.ts");

  it("步骤类型里有 execute", () => {
    /**
     * 补之前**没有一类表示"去做一件会产生副作用的事"**, 只有四种"思考"型。
     * 于是"调用 PPT 技能生成 .pptx"只能被表达成 write, 而 write 只会写字 ——
     * 实测计划里明明写着要生成 .pptx, 执行完磁盘上没有文件, write 写出来的
     * 是一份**关于这次调用的报告**。
     */
    expect(SVC).toMatch(/"write" \| "review" \| "execute"/);
  });

  it("规划提示词里告诉模型有这个类型, 且**只在要产出实际产物时**用", () => {
    const seg = SVC.slice(SVC.indexOf("你是任务规划器"));
    const w = seg.slice(0, 1600);
    expect(w).toMatch(/execute\(/);
    expect(w).toMatch(/产出实际文件|实际操作/);
    expect(w).toMatch(/纯文字产出用 write/);
  });

  it("execute 走人工审批门, 且**不靠关键词猜**", () => {
    // 关键词判定有天然漏报("清理并重建索引"不含任何关键词却会删东西),
    // 而 execute 必然产生副作用 —— 一律要人批, 不做启发式
    expect(SVC).toMatch(/ALWAYS_APPROVE_TYPES/);
    const seg = SVC.slice(SVC.indexOf("function isHighRiskStep"));
    expect(seg.slice(0, 400)).toMatch(/ALWAYS_APPROVE_TYPES\.has\(step\.type\)\) return true/);
  });

  it("execute 只分派动作类工具(不收窄的话模型照样选 sag_search)", () => {
    expect(API).toMatch(/ACTION_TOOL_NAMES/);
    expect(API).toMatch(/"run_code", "file_write", "run_command", "apply_patch"/);
  });

  it("execute 选不出工具时**明确失败**, 不悄悄降级成写一段文字", () => {
    // 那正是修复前的病: 要 .pptx 的步骤最后交出一份"关于怎么生成 pptx 的报告"
    /**
     * ⚠ 锚点必须是**兜底分支里那句唯一的文案**。
     *   第一次我用的是 'if (step.type === "execute") {' —— 但那个字符串在文件里
     *   **先出现在 execContext 的构造处**(另一个同名判断), 于是判据一直在看错误的代码块,
     *   无论窗口开多大都匹配不到。这正是本仓记过的"判据看不到被测对象"。
     */
    const at = API.indexOf("（执行未完成：没有可用工具或工具执行失败）");
    expect(at, "找不到 execute 兜底分支").toBeGreaterThan(0);
    const body = API.slice(Math.max(0, at - 800), at + 400);
    expect(body).toMatch(/ok: false/);
    expect(body).toMatch(/工具没选出来/);
  });

  it("大参数单独生成(不套 JSON) —— 否则长代码必然被截断", () => {
    /**
     * 实测撞了三次: 300→827字符、2000→5221、8000→18271, 每次都是
     * `Unterminated string`。根因不是额度, 是**让模型把整段程序当 JSON 字符串吐出来**
     * 这个设计本身。所以拆成两步: 选工具只出小 JSON, 大参数单独裸文本生成。
     */
    expect(ROUTER).toMatch(/generateLargeArg/);
    expect(ROUTER).toMatch(/只输出\$\{key\}的内容本身/);
  });

  it("步骤级批准后, 工具级审批闸不再重复索要(它们无门可进, 是死锁不是安全)", () => {
    /**
     * 同一个动作上叠了三道闸: 步骤级(有真流程)、工具级 risk、自主级别。
     * 后两道只 return ok:false, **没有任何机制能批准它们** ——
     * 于是 run_code 这类动作工具从 agent 循环里永远够不到。
     */
    expect(ROUTER).toMatch(/stepApproved\?: boolean/);
    const riskGate = ROUTER.slice(ROUTER.indexOf('if (tool.risk === "review" || policy.requiresApproval)'));
    expect(riskGate.slice(0, 500)).toMatch(/if \(!opts\?\.stepApproved\)/);
    // 自主级别那道: 守卫与调用写在**同一行的条件**里 —— 用正则整体匹配,
    // 别用 indexOf 找调用点再往回看(那样会匹配到注释里的同一串)
    expect(ROUTER).toMatch(/if \(!opts\?\.stepApproved && requiresApprovalByAutonomy\(tool\.risk, minRole, role\)\)/);
  });

  it("沙箱 profile 按「步骤已批准」派生, 但**只到 workspace-write**(网络/进程仍不给)", () => {
    const seg = ROUTER.slice(ROUTER.indexOf("沙箱 profile 不能只看模型填没填"));
    const body = seg.slice(0, 1200);
    expect(body).toMatch(/workspace-write/);
    // full-access 绝不能因为一次点击就拿到 —— 那超出任何一次批准的授权范围
    expect(body).not.toMatch(/escalated.*full-access.*:/);
  });

  it("沙箱拦下的执行**标记成失败**, 不被记成「步骤成功」", () => {
    // 这是"只看有没有输出、不看输出是什么"那个老病的第四处
    expect(ROUTER).toMatch(/_sandbox-blocked/);
    expect(ROUTER).toMatch(/SELF_REPORTED_FAILURE/);
  });

  it("工具失败时把**原始返回**带给用户, 而不是只剩一句「你检查环境吧」", () => {
    expect(API).toMatch(/toolFailureNote/);
    // 且要留够长度 —— Python traceback 的最后一两行才是异常类型, 截太短会切掉它
    expect(API).toMatch(/toolFailureNote = .*slice\(0, 4000\)/);
  });

  it("提示词明确禁止 subprocess 一族(沙箱会拦, 且模型会误以为「调用技能」=开子进程)", () => {
    const seg = ROUTER.slice(ROUTER.indexOf("const actionHint"));
    expect(seg.slice(0, 1200)).toMatch(/subprocess/);
    expect(seg.slice(0, 1200)).toMatch(/只有这一次机会|一次写成/);
  });
});

describe("⑨ 一次批准要够用 —— 授权必须跨 replan 存活", () => {
  const SVC = read("src/services/agent-task-service.ts");
  const API = read("src/api/server.ts");
  const MIG = read("migrations/173_agent_autonomy_grant.sql");

  it("授权存在**任务行**上, 不在计划里的步骤上", () => {
    /**
     * 2026-10-01 实测: 一次"用技能生成 .pptx"要**批准 6-8 次**。因为 agent 循环
     * 一轮没达标就 replan, 而新计划里的步骤 `approved` 一律是 false ——
     * 授权若只记在步骤上, 必然随 replan 一起丢, 用户看到同一个意思的步骤被反复要求批准。
     * 记在任务行上才跨得过 replan。
     */
    expect(MIG).toMatch(/alter table agent_tasks/);
    expect(MIG).toMatch(/add column if not exists autonomy_grant/);
    // 理由必须留在迁移里, 否则后人会把它当冗余列删掉
    expect(MIG).toMatch(/replan/i);
  });

  it("批准一个 execute 步骤时才授予, 且用 coalesce 不覆盖已有值", () => {
    const seg = SVC.slice(SVC.indexOf("const approvedStep = task.plan[req.stepIdx]"));
    const body = seg.slice(0, 700);
    expect(body).toMatch(/approvedStep\?\.type === "execute"/);
    expect(body).toMatch(/coalesce\(autonomy_grant, 'workspace-write'\)/);
  });

  it("授权只顶掉「因为是 execute 才要批」那部分, **危词步骤仍然拦**", () => {
    /**
     * 这是这套机制的安全边界: "可以写工作区"与"可以动钱"是两种授权。
     * 一个标题含"转账"的 execute 步骤, 不能因为任务上有 workspace-write 就放行。
     */
    const seg = SVC.slice(SVC.indexOf("function needsApprovalNow"));
    const body = seg.slice(0, 900);
    expect(body).toMatch(/autonomyGrant === "workspace-write" && !hitsRiskKeyword\(step\)/);
  });

  it("高危关键词分两类 —— 歧义动词必须与受作用对象共现", () => {
    /**
     * 同一类假阳性实测踩了两次:
     *   · "检索…**发布**时间" → 命中"发布"
     *   · "确保**覆盖**引言章节的核心论点" → 命中"覆盖"
     * 学术中文里 覆盖/导入/批量/替换/发布 都是日常动词 ——
     * 按字面拦会把大量正常步骤变成"请你批准"(实测因此多批了 4 次)。
     */
    expect(SVC).toMatch(/AMBIGUOUS_RISK_KEYWORDS/);
    expect(SVC).toMatch(/RISK_OBJECTS/);
    // ⚠ 窗口必须**只取那一行** —— 后面紧挨着 AMBIGUOUS_RISK_KEYWORDS 的定义,
    //   开宽了就会把它里面的"覆盖/替换/导入/批量"也匹配进来(判据自己踩的坑)
    const kwLine = (SVC.match(/const HIGH_RISK_KEYWORDS = \[[^\]]*\]/) || [""])[0];
    expect(kwLine).toMatch(/删除|清空/);
    expect(kwLine).not.toMatch(/覆盖|替换|导入|批量/);
  });

  it("三处分派点都把授权当作已批准的来源之一", () => {
    const hits = API.match(/stepApproved: step\.type === "execute"[\s\S]{0,200}?autonomyGrant/g) || [];
    expect(hits.length, "三处(runAgentTaskInner + agent/chat 两处)都要接").toBeGreaterThanOrEqual(3);
  });
});

describe("⑩ 沙箱输出路径：只写裸文件名", () => {
  const ROUTER = read("src/services/agent-tool-router.ts");

  it("提示词给出明确的输出路径约定", () => {
    /**
     * 2026-10-01 实测: 模型写的保存路径是 `agent_workspace/nature_paper_presentation.pptx`
     * → `FileNotFoundError: [Errno 2] No such file or directory`。
     * 它以为工作区是 cwd 下的**子目录**, 而实际正相反 ——
     * 沙箱在 workspace-write 下的 cwd **就是** agent_workspace 本身。
     * 代码逻辑全对、版式全对, 只因为多了一截路径前缀, 在 save() 最后一步炸掉。
     */
    expect(ROUTER).toMatch(/SANDBOX_OUTPUT_PATH_RULE/);
    expect(ROUTER).toMatch(/只写裸文件名/);
    expect(ROUTER).toMatch(/FileNotFoundError/);
  });
});

describe("⑪ 技能自带的质检脚本必须真的被用上", () => {
  const ROUTER = read("src/services/agent-tool-router.ts");
  const SKILLS = read("src/services/skills-service.ts");

  it("能列出技能捆绑的可执行资产(scripts/)", () => {
    /**
     * 在此之前, 平台对技能的使用**只到"把 SKILL.md 读成文本"为止** ——
     * 技能自带的脚本一个都没被用过。而这批脚本恰是作者沉淀的**确定性资产**:
     * `nature-paper2ppt/scripts/audit_pptx_quality.py` 会查"文字是否溢出画布"
     * "元素是否差几 pt 没对齐", 正是它自己在 output-and-quality.md 里定的交付标准。
     */
    expect(SKILLS).toMatch(/export function skillScripts/);
    expect(SKILLS).toMatch(/export function skillVerifierScripts/);
  });

  it("排除 generic-healthcheck —— 它是环境自检, 不是产物质检", () => {
    // 不排除的话 scholar-slides 会挑中它, 模型拿到的"自检脚本"是查依赖的
    expect(SKILLS).toMatch(/generic-healthcheck/);
    expect(SKILLS).toMatch(/环境自检/);
  });

  it("只返回校验类, 不混入构建器(那会误导调用方)", () => {
    expect(SKILLS).toMatch(/只留\*\*校验类\*\*|x\.r < 2/);
  });

  it("生成提示里交代了自检脚本 + 版式硬约束", () => {
    expect(ROUTER).toMatch(/ARTIFACT_QUALITY_RULES/);
    // 约束要具体到可校验的数字 —— "注意排版"这种话对代码生成没有约束力
    expect(ROUTER).toMatch(/13\.333/);
    expect(ROUTER).toMatch(/8pt/);
    // 并且只在**产出文件**时才注入, 不是所有参数都塞一遍
    expect(ROUTER).toMatch(/producesFile \? /);
  });

  it("约束里的数字与技能文档一致(不能自己编一套)", () => {
    /**
     * 这两条直接来自 `nature-paper2ppt/static/core/output-and-quality.md`:
     *   · Do not deliver slides with text extending beyond visible boxes...
     *   · Ensure layout alignment is intentional ... rather than drifting by a few points.
     * 而 alignment 的 2~8pt 判据来自它自带的 audit 脚本(min_delta=2pt, max_delta=8pt)。
     * 实测: 补上前者 high 20→0; 补上后者 low 32→7。
     */
    // ⚠ 锚到**定义处**（`export const ... =`）——只写名字的话会先命中下面的使用处,
    //   于是判据读的是 `${ARTIFACT_QUALITY_RULES}${verifier}` 那几行, 什么也看不到
    const at = ROUTER.indexOf("export const ARTIFACT_QUALITY_RULES");
    expect(at, "找不到规则定义").toBeGreaterThan(0);
    const body = ROUTER.slice(at, at + 1400);
    expect(body).toMatch(/落.*画布内|完全落在画布/);
    expect(body).toMatch(/2~8pt|相差 8pt/);
  });
});

describe("⑫ 质检闭环：技能自带的质检脚本必须**被自动调用**", () => {
  const VERIFY = read("src/services/artifact-verify-service.ts");
  const API = read("src/api/server.ts");

  it("有独立的质检服务, 而不是只把「该自检」写进提示词", () => {
    /**
     * 2026-10-01: 把约束写进提示词能把 high 从 20 压到 0, 但那靠**模型自觉** ——
     * 它可能这次照做、下次忘掉, 而且没有任何东西在交付前把关。
     * 这个服务补的就是那一环: 在 execute 完成后**确定性**地跑技能自带的脚本。
     */
    expect(VERIFY).toMatch(/export async function verifyProducedArtifact/);
    expect(VERIFY).toMatch(/skillVerifierScripts/);
  });

  it("⚠ 产物基准是「任务创建时间」, 不是「本步开始时间」", () => {
    /**
     * 实测踩到: 用本步开始时间时, 一个"核验已有 pptx"的步骤找不到文件 ——
     * 因为那个 pptx 是**上一步**产出的, mtime 早于本步起点。
     * 表现为质检永远报"没有在产出目录里找到新文件"(而文件明明在)。
     * 产物归属是**任务级**的: 看"这个任务做出了什么", 不是"这一步新建了什么"。
     */
    expect(API).toMatch(/const taskCreatedAt = task\?\.created_at/);
    expect(API).toMatch(/since: taskCreatedAt/);
    expect(API).not.toMatch(/since: stepStartedAt/);
  });

  it("脚本能不能验这种产物, 判据要看得见对象(大小写 + 文件名两个来源)", () => {
    /**
     * 第一版只读脚本正文前 4000 字找小写 `.pptx` —— 而 `audit_pptx_quality.py`
     * 正文里写的是**大写 PPTX**(小写只在文件名里), 于是最该认的那种产物被判成"不认",
     * 整条质检链直接短路。本仓反复记的"判据看不到被测对象", 这是又一个实例。
     */
    expect(VERIFY).toMatch(/base\.includes\(ext\)/);          // 文件名来源
    expect(VERIFY).toMatch(/const low = head\.toLowerCase\(\)/); // 正文小写化后再比
  });

  it("跑不起来时如实说「没验」, 不假装通过", () => {
    // ran:false + ok:true 而不是 ok:false —— 没有证据时既不能判合格也不能判不合格,
    //   但**必须**让上层知道"这次没验到"
    expect(VERIFY).toMatch(/ran: false/);
    expect(VERIFY).toMatch(/没有在产出目录里找到新文件|没有自带的质检脚本|没有识别到技能/);
  });

  it("质检**没过**必须让这一步失败 —— 不能交付一个明确不合格的东西还标成功", () => {
    expect(API).toMatch(/产物质检未通过/);
    const seg = API.slice(API.indexOf("产物质检未通过"));
    expect(seg.slice(0, 400)).toMatch(/ok: false/);
  });

  it("三处分派点都要接质检(少一处, 那条路进来的任务就绕过验证)", () => {
    const hits = API.match(/verifyArtifactNote|verifyProducedArtifact\(/g) || [];
    expect(hits.length, "主分派点 + 对话链两处").toBeGreaterThanOrEqual(3);
  });
});

describe("⑬ 工作区围栏：workspace-write 不能写穿到任意路径", () => {
  const SB = read("src/services/code-sandbox-service.ts");

  it("有确定性的路径越界判据", () => {
    /**
     * 2026-10-01 实测发现的**未记录缺口**: `workspace-write` 的档位描述写的是
     * "仅允许 agent_workspace 内读写", 而沙箱**只是把 cwd 设成它**, 对文件系统访问
     * 没有任何限制 —— 工作区里跑的代码成功写进了平台自己的 `src/` 源码目录。
     *
     * 这让我加的 execute 步骤类型有了远超其名义的权限: 用户在审批界面上看到的是
     * "生成一份 .pptx" 并据此点头, 而实际授予的是**整个文件系统的写权限**。
     * **同意必须是知情的**, 否则那道审批门就只是个形式。
     */
    expect(SB).toMatch(/export function codeEscapesWorkspace/);
  });

  it("拦字面量里的绝对路径 / UNC / 越级", () => {
    const seg = SB.slice(SB.indexOf("export function codeEscapesWorkspace"));
    const body = seg.slice(0, 1600);
    expect(body).toMatch(/\[A-Za-z\]:\[\\\\\/\]/);   // 盘符
    expect(body).toMatch(/UNC/);
    expect(body).toMatch(/\.\./);                     // 越级
  });

  it("判据**保守**, 明确声明做不到完备(不假装是 OS 级隔离)", () => {
    // 正则做不出完备沙箱; 假装能反倒更危险。注释里必须留着这句,
    // 否则后人会以为"加了检查 = 已经隔离", 再次据错误前提做授权判断。
    const seg = SB.slice(SB.indexOf("export function codeEscapesWorkspace") - 1500);
    expect(seg.slice(0, 1500)).toMatch(/不是宣称已经隔离|做到完备|做不到/);
  });

  it("档位描述如实 —— 不能把「约定」说成「隔离」", () => {
    /**
     * 原描述 "仅允许 agent_workspace 内读写" **是假的**。
     * 把约定说成隔离, 会让读代码的人(包括我)据它做出错误的授权判断 ——
     * 而那正是这个缺口藏了这么久的原因。
     *
     * ⚠ 断言锚**语义**不锚具体措辞: 文案会随表达打磨而改(实测改过两轮),
     *   但"如实交代它不是 OS 级隔离"这条要求不变。
     */
    const seg = SB.slice(SB.indexOf("SANDBOX_PROFILE_LABELS"));
    const body = seg.slice(0, 1200);
    expect(body).toMatch(/不是操作系统级隔离|非 OS 级隔离|规则层/);
    expect(body).toMatch(/绝对路径|越级路径/);
    expect(body).not.toMatch(/仅允许 agent_workspace 内读写/);
  });

  it("拦截在 full-access 下让路(显式升级才放行, 不是偷偷放宽)", () => {
    expect(SB).toMatch(/if \(profile !== "full-access"\)/);
  });

  it("拦截结果带 _sandbox-blocked 标记 → 上层会记成失败而不是成功", () => {
    // ⚠ 标记在**行首**, 从文案中间切窗口会漏掉它 —— 往回多取一点
    const at = SB.indexOf("代码引用了工作区之外的路径");
    expect(at).toBeGreaterThan(0);
    expect(SB.slice(Math.max(0, at - 300), at + 200)).toMatch(/_sandbox-blocked/);
  });
});

describe("⑭ 素材要「推进工作区」, 而不是放宽围栏", () => {
  const WS = read("src/services/agent-workspace-service.ts");
  const ROUTER = read("src/services/agent-tool-router.ts");
  const API = read("src/api/server.ts");

  it("有独立的素材推进服务", () => {
    /**
     * 围栏补上之后必然要回答"模型怎么拿素材": 论文配图/实证图表都在别的模块的
     * 绝对路径上, 而工作区围栏不允许引用它们。
     * 当时记下的取舍是"推进工作区, 不要放宽规则" —— 这个服务就是那句话的实现。
     */
    expect(WS).toMatch(/export function stageAssetsIntoWorkspace/);
    expect(WS).toMatch(/export function describeWorkspaceAssets/);
  });

  it("只复制不移动 —— 源文件属于别的模块", () => {
    // 移动过去会把实证工作台/用户附件的产物掏空
    expect(WS).toMatch(/copyFileSync/);
    expect(WS).not.toMatch(/renameSync|fs\.unlinkSync\(from\)/);
  });

  it("有扩展名白名单与体积上限(否则等于任意文件搬运工)", () => {
    expect(WS).toMatch(/ALLOWED_EXT/);
    expect(WS).toMatch(/MAX_FILE_BYTES/);
    expect(WS).toMatch(/MAX_TOTAL_BYTES/);
  });

  it("重复推进要幂等 —— 同名同大小视为已推过", () => {
    /**
     * 同一任务里每个 execute 步骤都可能触发一次推进。无条件"撞名就加序号"
     * 会造出 fig.png / fig-2.png / fig-3.png 一串内容相同的副本,
     * 模型随便挑一个 —— 挑错也不会有任何迹象。
     */
    expect(WS).toMatch(/已推过, 幂等跳过/);
  });

  it("素材清单要**主动告知**模型(否则等于没推)", () => {
    // 沙箱里模型只生成一次代码, 没有第二轮去看目录里有什么
    expect(ROUTER).toMatch(/workspaceAssets/);
    expect(ROUTER).toMatch(/用\*\*相对路径\*\*引用/);
  });

  it("建 PPT 任务时自动推进素材(走统一服务, 不再内联拉全量)", () => {
    expect(API).toMatch(/stageUserAssets\(user\.id\)/);
    // 内联那版拉的是**全平台**图形(无归属), 已被替换成带 user_id 过滤的服务
    expect(API).not.toMatch(/listObjects\("empirical\/figures\/"\)/);
  });

  it("推进失败**不阻断**建任务(没有配图也能出纯文字的稿子)", () => {
    expect(API).toMatch(/推进素材失败\(不阻断\)/);
  });
});

describe("⑮ 升级建议要按**实际生效的**档位给", () => {
  const ROUTER = read("src/services/agent-tool-router.ts");

  it("用 effProfile 而不是模型填的 profile", () => {
    /**
     * 2026-10-02 实测踩到: 模型从不填 `profile` 参数, 于是建议逻辑拿到空串、
     * 退回 "read-only" 语境去判 —— 而实际执行用的是 effProfile(步骤已批准时派生的
     * workspace-write)。结果一条**已经在工作区可写级别**的代码被拦时, 提示写着
     * "需工作区可写级别（使用 profile 参数升级）" —— 用户照着做也没用。
     * **误导比不提示更糟。**
     */
    const at = ROUTER.indexOf("suggestSandboxEscalation(String(a.code");
    expect(at).toBeGreaterThan(0);
    expect(ROUTER.slice(at, at + 200)).toMatch(/effProfile/);
    expect(ROUTER.slice(at, at + 200)).not.toMatch(/\(profile as any\) \|\| "read-only"/);
  });
});

describe("⑯ 素材来源：三类来源 + 用户隔离", () => {
  const SRC = read("src/services/asset-source-service.ts");
  const PDF = read("scripts/pdf_extract_figures.py");
  const API = read("src/api/server.ts");

  it("三类来源都有: 用户上传 / 自己的实证图表 / 自己的 PDF 取图", () => {
    expect(SRC).toMatch(/user_files[\s\S]{0,200}mime like 'image\/%'/);
    expect(SRC).toMatch(/empirical\/figures/);
    expect(SRC).toMatch(/extractFiguresFromPdf/);
    expect(SRC).toMatch(/mime = 'application\/pdf'/);
  });

  it("每条来源都带 user_id 过滤 —— 新代码不能复制已有缺口", () => {
    /**
     * ⚠ 核实过的事实: 实证图表的存储**本来就没有归属概念** ——
     *   图存在扁平的 `empirical/figures/` 下、没有 user_id;
     *   `GET /api/empirical/figures/:file` 也只要求登录、不校验归属。
     *   所以第一版内联读"全量图形"继承的是**既有现实**, 不是我新引入的问题。
     *   但新写的这条路径明确按 user_id 过滤 —— 不把一个已有缺口再复制一份。
     */
    expect(SRC).toMatch(/where user_id = \$1 and mime like 'image\/%'/);
    expect(SRC).toMatch(/where user_id = \$1 and mime = 'application\/pdf'/);
    expect(SRC).toMatch(/empirical\/figures\/\$\{userId\}\//);
  });

  it("取不到素材时**如实说明原因**, 不静默给一份没图的稿子", () => {
    expect(SRC).toMatch(/你没有上传过图片/);
    expect(SRC).toMatch(/还没有跑过实证分析/);
    expect(SRC).toMatch(/没有可用的位图/);
  });

  it("PDF 取图按**像素尺寸**过滤, 不是按文件大小", () => {
    /**
     * 压缩率差异极大: 白底折线图可能只有 20KB, 噪声纹理的小图标能到 200KB。
     * **大小判不出它是不是图**, 像素才判得出。
     */
    expect(PDF).toMatch(/--min-px/);
    expect(PDF).toMatch(/小于 .*px（图标\/装饰）/);
  });

  it("整页扫描要单独识别 —— 那是「扫描的页面」, 不是「论文里的图」", () => {
    expect(PDF).toMatch(/疑似整页扫描/);
  });

  it("建 PPT 任务走统一服务, 不再内联拉全量图表", () => {
    expect(API).toMatch(/stageUserAssets\(user\.id\)/);
    // 内联那版拉的是全平台图形, 已被替换
    expect(API).not.toMatch(/listObjects\("empirical\/figures\/"\)/);
  });

  it("取图脚本用 PyMuPDF, 且对「打不开/不存在」如实报错", () => {
    expect(PDF).toMatch(/import fitz/);
    expect(PDF).toMatch(/文件不存在|打不开 PDF/);
  });
});

describe("⑰ 前端不能存一份「和实现会漂移」的档位说明", () => {
  const API = read("src/api/server.ts");
  const APP = read("web/src/App.tsx");
  const CONSOLE = read("web/src/components/AgentConsole.tsx");

  it("后端把沙箱档位说明暴露成接口(让前端有真值可取)", () => {
    /**
     * 前端此前自己硬编码一组描述, 其中 `workspace-write` 写的是
     * "仅允许 agent_workspace 内读写" —— 与后端一样是**假话**。
     * 我改了后端标签, 前端那份没跟着动, 于是设置界面上仍然承诺一个做不到的隔离。
     * 本仓的老毛病就是"清单多处各存一份"(工具登记四处、权限列表多处)。
     */
    expect(API).toMatch(/app\.get\("\/api\/agent\/sandbox-profiles"/);
    expect(API).toMatch(/SANDBOX_PROFILE_LABELS/);
  });

  it("两处前端都从接口取, 不再硬编码档位描述", () => {
    expect(APP).toMatch(/\/api\/agent\/sandbox-profiles/);
    expect(CONSOLE).toMatch(/\/api\/agent\/sandbox-profiles/);
    // 旧的假描述不能再留在前端
    expect(APP).not.toMatch(/仅允许 agent_workspace 内读写/);
    expect(CONSOLE).not.toMatch(/只读\(默认\)\/工作区可写\/完全访问/);
  });

  it("审批界面要说清「这次同意给了什么」", () => {
    /**
     * 对 execute 步骤, 批准不只是放过这一步 —— 它会在任务上授予 workspace-write,
     * 于是**后续动作类步骤不再逐次询问**。用户以为在批"生成一份文件",
     * 实际同意的是"这个任务里所有文件操作"。只显示标题, 那道审批门就只是个形式。
     */
    const SVC = read("src/services/agent-task-service.ts");
    const PANEL = read("web/src/components/TaskPanel.tsx");
    expect(SVC).toMatch(/grant: executes/);
    expect(SVC).toMatch(/本任务后续的动作类步骤不再逐次询问/);
    expect(PANEL).toMatch(/approvalRequest\.grant/);
  });

  it("⚠ 授权范围要摆在**按钮旁边**, 不能只放折叠的详情里", () => {
    /**
     * 2026-10-02 实测: 批准按钮在紧凑行就能点, 而详情默认折叠。
     * 用户完全可能一键批准却从没看过它授予了什么 ——
     * **按钮在哪, 后果就得在哪**。
     */
    const PANEL = read("web/src/components/TaskPanel.tsx");
    const btnIdx = PANEL.indexOf('aria-label="批准高危步骤"');
    expect(btnIdx).toBeGreaterThan(0);
    // 前后各 900 字内必须能看到 grant 的渲染
    expect(PANEL.slice(Math.max(0, btnIdx - 900), btnIdx + 900)).toMatch(/approvalRequest\.grant/);
  });
});

describe("⑱ 目标澄清不能被反复追问", () => {
  const SVC = read("src/services/agent-task-service.ts");

  it("用户已表过态就不再问同一个问题", () => {
    /**
     * 2026-10-02 实测到的**死循环**(我自己上一轮的修法引入的):
     *   目标歧义检查在**每次** runAgentTask 开头都跑, 且没有"用户已回应"的记忆。
     *   加了「批准后重新入队」之后 →
     *     批准澄清 → 重新入队 → 又判"目标模糊" → 又挂起 → 再批准 → …
     *   实测连批 8 次仍停在同一条澄清上。
     *   (加 enqueue 之前它是**死路**: 批准后状态变 running 却没人跑。两种都不能用。)
     */
    expect(SVC).toMatch(/userAlreadyAcknowledged/);
    expect(SVC).toMatch(/clarifiability === "ambiguous" && !userAlreadyAcknowledged/);
  });
});
