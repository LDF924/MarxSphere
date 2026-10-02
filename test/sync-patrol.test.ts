/**
 * sync-patrol.test.ts — 同步链路告警的硬判据(2026-10-02)。
 *
 * ═══ 这个文件守的是"静默失效藏了 9 天"这一类问题 ═══
 *
 * 实测: `SAG-open-source` 的 origin 被指到只读镜像 `gh-proxy.com`, push 一直失败。
 * 但脚本日志 09-23~10-01 连续 9 天写着 `push=未执行` —— 因为"没差异就早退"
 * 从不走到 push, **"不需要推"和"推不上去"长得一模一样**, 而那条计划任务没人看输出。
 *
 * 两道对策各有一组判据:
 *   ① 脚本侧: push 的三种结局必须**分开记**, 且连续失败要能累加;
 *   ② 平台侧: 状态文件 → alive 判读 → 写 alerts 表, 且**真因要留住**。
 *
 * 判据都锚在"能不能区分这件事"上, 而不是"有没有某个字符串"——
 * 后者正是当初让日志看起来一切正常的原因。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("① 脚本侧：push 的三种结局必须分开记", () => {
  const SYNC = read("scripts/sync-open.mjs");

  it("有 pushOutcome 四态, 而不是一个布尔", () => {
    /**
     * 原来只有 `pushed: boolean`。于是 `pushed: false` 同时表示
     *   "没推成"和"根本没到 push 那一步"(无差异早退) —— 两件事含义完全相反,
     *   却写成同一个值。9 天的静默就是这么来的。
     */
    expect(SYNC).toMatch(/pushOutcome/);
    expect(SYNC).toMatch(/"ok"\s*\|\s*"failed"\s*\|\s*"skipped"\s*\|\s*"not-reached"/);
  });

  it("日志里四种结局分别可辨(不再全挤在 push=未执行)", () => {
    const seg = SYNC.slice(SYNC.indexOf("pushOutcome === \"ok\""));
    const body = seg.slice(0, 500);
    expect(body).toMatch(/push=ok/);
    expect(body).toMatch(/push=失败/);
    expect(body).toMatch(/push=跳过/);
    expect(body).toMatch(/push=未到/);
  });

  it("连续失败要累加, 成功要清零", () => {
    // 单看一次 failed 可能只是网络抖动; **连续 N 次**才是通道坏了
    const seg = SYNC.slice(SYNC.indexOf("const failing = code !== 0"));
    expect(seg.slice(0, 300)).toMatch(/consecutiveFailures = failing \? .*\+ 1 : 0/);
  });

  it("lastSuccessAt 在失败时**保持不动** —— 与 at 的差就是停了多久", () => {
    const seg = SYNC.slice(SYNC.indexOf("lastSuccessAt:"));
    expect(seg.slice(0, 200)).toMatch(/failing \? \(prev\.lastSuccessAt \?\? null\)/);
  });

  it("⚠ push 失败要用 pipe 抓 stderr, 不能用 inherit", () => {
    /**
     * 实测踩到: `stdio: "inherit"` 把 stderr 直接送终端, execSync 的 error 上
     * **拿不到内容** —— 状态文件里只剩一句 `Command failed: git push origin main`。
     * 而真正有用的是那句 `unable to access ... Could not connect`。
     * 把原因丢了, 告警就只剩"推失败了", 用户还是不知道该修什么。
     */
    // ⚠ 从 execSync 那行往后取足 1500 字 —— pushErr.stderr 在注释之后,
    //   窗口开小会只读到注释(判据看不到被测对象, 本仓记过多次)
    const at = SYNC.indexOf("git push origin main");
    const seg = SYNC.slice(at, at + 1500);
    expect(seg).toMatch(/stdio: \["ignore", "pipe", "pipe"\]/);
    expect(seg).toMatch(/pushErr\?\.stderr/);
  });

  it("状态落点能从 --log 推导(否则已有计划任务不改参数就白做)", () => {
    // 计划任务是 `--log ...\.cache\sync-open.log`, 没有 --state。
    // 日志与状态本就该放一起, 不可能只想要其中一个。
    const seg = SYNC.slice(SYNC.indexOf("const STATE_FILE"));
    expect(seg.slice(0, 400)).toMatch(/path\.dirname\(LOG_FILE\)/);
    expect(seg.slice(0, 400)).toMatch(/sync-open-state\.json/);
  });

  it("写状态自己吞异常 —— 留痕绝不能反过来把同步搞挂", () => {
    const seg = SYNC.slice(SYNC.indexOf("function writeState"));
    expect(seg.slice(0, 1500)).toMatch(/catch/);
  });
});

describe("② 平台侧：巡检要认得这些状态", () => {
  const PATROL = read("src/services/sync-patrol-service.ts");

  it("连续失败达门槛写 error 并带上真因", () => {
    expect(PATROL).toMatch(/consecutiveFailures >= ALERT_AFTER/);
    // 详情里必须有 pushError —— 只有"推失败了"等于没说
    const seg = PATROL.slice(PATROL.indexOf("consecutiveFailures >= ALERT_AFTER"));
    expect(seg.slice(0, 800)).toMatch(/pushError: st\.pushError/);
  });

  it("没到门槛也先用 warning 说一声(别等第 3 天才第一次看见)", () => {
    expect(PATROL).toMatch(/连续 \$\{st\.consecutiveFailures\} 次，达 \$\{ALERT_AFTER\} 次将升级为错误/);
  });

  it("状态太久没更新**单独报** —— 那是计划任务没跑, 与同步失败是两回事", () => {
    // 混在一起会指向错误的排查方向
    expect(PATROL).toMatch(/STALE_STATE_HOURS/);
    expect(PATROL).toMatch(/计划任务可能没在跑/);
  });

  it("读不到状态文件时如实说，不假装同步正常", () => {
    expect(PATROL).toMatch(/还没有同步状态记录/);
    // 但级别是 info —— 全新环境本来就没有, 报 error 会变噪音
    // ⚠ 往前取 —— `level: "info"` 写在 message **之前**, slice(-300) 取的是后面
    const at = PATROL.indexOf("还没有同步状态记录");
    expect(PATROL.slice(Math.max(0, at - 400), at + 100)).toMatch(/level: "info"/);
  });

  it("告警文案不含 markdown 标记(界面会原样显示星号)", () => {
    // 本仓已有先例: `**连续 3 次失败**` 会连着星号一起显示在告警中心
    const msgs = PATROL.match(/message: `[^`]*`/g) || [];
    for (const m of msgs) expect(m, `告警文案含 markdown: ${m.slice(0, 60)}`).not.toMatch(/\*\*/);
  });

  it("巡检只看状态文件, 不让同步脚本依赖数据库", () => {
    /**
     * `sync-open.mjs` 是纯文件同步脚本。让它连 pg 就等于给它加了对 .env / 数据库
     * 可达性的依赖 —— 网络或库不可用时**同步本身会因此挂掉**, 本末倒置。
     */
    const SYNC = read("scripts/sync-open.mjs");
    expect(SYNC).not.toMatch(/from "pg"|require\(['"]pg['"]\)|db\/pool/);
  });
});

describe("③ 接入与配置", () => {
  it("巡检在启动任务里被拉起, 且有开关", () => {
    const IDX = read("src/index.ts");
    expect(IDX).toMatch(/startupTask\("sync-patrol"/);
    expect(IDX).toMatch(/SAG_SYNC_PATROL !== "0"/);
  });

  it("两棵树里的 service 内容一致(worktree 与主仓, 否则同步会覆盖回去)", () => {
    /**
     * 实测踩到: 我把 service 写在 worktree, 而 `sync-open.mjs` 从**主仓工作区**复制 ——
     * 结果是工作区里的新文件被主仓的旧版本覆盖。两处必须同时更新。
     * (本仓对这条有专门的 memory: worktree-vs-main-cwd-confusion)
     */
    const main = path.resolve(ROOT, "src/services/sync-patrol-service.ts");
    const wt = path.resolve(ROOT, ".claude/worktrees/elastic-archimedes-c59e44/src/services/sync-patrol-service.ts");
    if (!fs.existsSync(wt)) return;   // 不在 worktree 里跑时不假失败
    expect(fs.readFileSync(main, "utf8")).toBe(fs.readFileSync(wt, "utf8"));
  });
});

describe("④ 一致性检查不能把行尾差异报成「落后」", () => {
  const REPOS = read("scripts/sync-repos.mjs");
  const SYNC = read("scripts/sync-open.mjs");

  it("对比文件时归一化行尾(两个仓的 autocrlf 不同)", () => {
    /**
     * 实测(2026-10-02): `sync-repos.mjs --check` 每次报 "6 处差异 — 需人工检查!",
     * 而逐个人工核完发现**内容完全相同**, 只是行尾不同(主仓工作区 LF / open CRLF)。
     * 一个永远为真的警报 = 等于没有警报 —— 人会学会忽略它。
     *
     * 更糟的是**同步模式用同一套哈希**: 它把 open 的 CRLF 写进主仓、
     * 下次又反过来, 工作区永远是脏的。
     */
    // 判据锚"归一化这个动作", 不锚具体转义写法 —— 后者改一下就会假失败
    expect(REPOS).toMatch(/latin1/);
    expect(REPOS).toMatch(/\\r\\n/);
    expect(REPOS).toMatch(/createHash\("sha1"\)\.update\(normalized\)/);
  });

  it("两个脚本用同一条「算不算相同」的规则", () => {
    // sync-open 早就归一化了(sameContent), sync-repos 此前没有 —— 两套规则必然打架
    expect(SYNC).toMatch(/function sameContent/);
    expect(SYNC).toMatch(/\\r\\n/);
  });

  it("归一化只影响判等, 不改动文件本身", () => {
    // 复制走的仍是原文件(copyFile 用 f.src), 不是归一化后的内容
    const seg = REPOS.slice(REPOS.indexOf("function copyFile"));
    expect(seg.slice(0, 600)).toMatch(/cpSync|copyFileSync/);
  });
});
