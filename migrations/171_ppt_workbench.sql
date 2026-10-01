-- 171_ppt_workbench.sql — PPT 生成工作台的任务与页面状态(2026-10-01)
--
-- 由来: 复盘旧项目 AItoolman 时, M9 是**全项目最大的一个模块**(111 个函数):
--   大纲 → 脚本 → 配图 → 导出, 带单页重生、风格模仿、参考图、批注重绘、版本管理。
--   本项目此前只有 `paper-outline-service.exportOutlinePptx` —— 论文大纲导出 PPTX
--   的封面 + 每章一页, 既没有页面脚本/备注, 也没有配图、单页重生与版本。
--
-- 两条设计决定(都不是随手定的):
--
-- ① **页面在库里, 不在某个 JSON 大字段里**。
--   旧项目把整个 job 状态塞进一个 state 文件(m9_save_job_state), 单页重生要先把
--   整份状态反序列化再写回 —— 并发生成两页时后写的那次会把先写的那页盖掉。
--   这里一页一行(ppt_pages), "只重生成第 3 页"就是 update 一行, 不碰别的页。
--   同步词法判据: 下面**绝不会有** jsonb 列去装页面数组。
--
-- ② **任务目录同时落库与落盘**。
--   既要 `中断后恢复`(库里查 status='running' 的僵尸任务 + 磁盘上留着半成品),
--   也要人可读(旧项目那套 m9_create_new_task_dir 的价值: 出问题时能直接翻目录)。
--   `work_dir` 存相对 <DATA_DIR> 的路径, 见 services/ppt-workbench-service.taskDir。
--
-- 幂等: 全部 CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。

-- ════════════════════ 任务 ════════════════════
create table if not exists ppt_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  title         text not null default '',
  -- 素材来源: 一个主题 / 一篇论文(带 paperId 时脚本阶段可以去检索原论文)
  topic         text not null default '',
  source_kind   text not null default 'topic' check (source_kind in ('topic','paper','outline')),
  source_ref    text not null default '',
  -- 表现形态。style 是一个**自由文本的视觉规范描述**, 不是枚举 ——
  --   "参考图"提取出来的那套配色/版式也写成文字后塞进这里(见 ppt-render-service.inferStyleFromReference)
  style         text not null default '',
  -- 用户投喂的参考图(落 <DATA_DIR>/ppt-files/... , 与 user-files 同一层)
  reference_image text not null default '',

  -- 状态机: created → outline_ready → scripting → scripted → rendering → done
  --         任意阶段 → failed; 用户在中间态调用即回到上一个稳定态
  --   `running` 那些中间态(scripting/rendering)是**可恢复**的判定依据:
  --     服务启动时扫 status in ('scripting','rendering') 的行 = 进程死掉留下的僵尸任务。
  status        text not null default 'created'
                check (status in ('created','outline_ready','scripting','scripted','rendering','done','failed')),
  -- 阶段与进度分开: stage 说"在哪一步", progress 说"这一步走了多少"(0-100)
  stage         text not null default '',
  progress      int  not null default 0 check (progress between 0 and 100),
  error         text not null default '',

  slide_count   int  not null default 0,
  -- 每页要点数量的约束(旧项目"约束每页要点数量"那条): 脚本阶段据此裁剪/拆分
  max_bullets   int  not null default 5 check (max_bullets between 1 and 12),
  -- 任务目录, 相对 <DATA_DIR>(形如 ppt-tasks/<uid>/<jobId>)。留空 = 还没建过目录
  work_dir      text not null default '',

  -- 导出进度可查询: 不另开 export 表, 一次任务一个导出形态, 成功即 done_export
  export_status   text not null default '' check (export_status in ('','running','done','failed')),
  export_progress int  not null default 0 check (export_progress between 0 and 100),
  export_mode     text not null default '' check (export_mode in ('','editable','image')),
  export_rel      text not null default '',
  export_error    text not null default '',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 僵尸任务扫描 + "我的演示稿列表" 都按 (user_id, status, 时间) 走
create index if not exists idx_ppt_jobs_user on ppt_jobs (user_id, created_at desc);
create index if not exists idx_ppt_jobs_status on ppt_jobs (status) where status in ('scripting','rendering');

-- ════════════════════ 页面 ════════════════════
-- 一页一行。"只重生成某一页"就是只 update 这一行 —— 这是本表存在的理由(见文件头 ①)。
create table if not exists ppt_pages (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references ppt_jobs(id) on delete cascade,
  -- 页序。**不用 1..n 连续编号** —— 增删页只改动一行的话, 重编号要动全表,
  --   而中途失败就留下一份页序错乱的稿子。10/20/30 留空档, 插入不必重排。
  seq         int  not null,
  -- 页型决定渲染模板与是否进目录
  kind        text not null default 'content'
              check (kind in ('cover','toc','section','content','end')),
  title       text not null default '',
  bullets     jsonb not null default '[]'::jsonb,
  -- 讲稿备注 → 写进 pptx 的 notes(演示者视图). 与 bullets 分开存:
  --   备注是"讲给人听的", 要点是"打在屏幕上的", 两者不该互相覆盖
  notes       text not null default '',

  -- 配图。prompt 是"想要什么", rel 是"实际拿到什么"
  image_prompt text not null default '',
  image_rel    text not null default '',
  -- 图怎么用: none 无图 / right 右侧配图 / background 铺满作背景(旧项目的"将图片写为幻灯片背景")
  image_layout text not null default 'none' check (image_layout in ('none','right','background')),
  image_source text not null default '' check (image_source in ('','service','placeholder')),
  -- 图片来源要**能被人看见**: 占位图与真生图在界面上是同一张 png,
  --   不落这一列的话,"这是 AI 画的"与"这是降级凑的"就再也分不出来了
  image_note   text not null default '',

  -- 被用户锁定的页: 批量重生成/改风格时**跳过**(用户手改过的页面不能被覆盖)
  locked      boolean not null default false,
  -- 页级状态, 与 job.status 独立 —— 一页失败不该让整个任务失败(单页重生要能重试那一页)
  status      text not null default 'draft' check (status in ('draft','scripted','rendered','failed')),
  error       text not null default '',

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- (job_id, seq) 唯一: 页序不能重 —— 重了的话"第 3 页"就有两行, 单页重生会改错那行
  unique (job_id, seq)
);
create index if not exists idx_ppt_pages_job on ppt_pages (job_id, seq);

-- ════════════════════ 页面版本 ════════════════════
-- 每次改动页面(重生/手改/批注重绘)前, 先把**旧的那份**存进来。
-- 只存内容快照与产物路径, 不存字节(png 在磁盘上按 版本号 命名, 见 render 服务)——
-- 版本切换因此是"换一个指针", 不搬数据。
create table if not exists ppt_page_versions (
  id          uuid primary key default gen_random_uuid(),
  page_id     uuid not null references ppt_pages(id) on delete cascade,
  job_id      uuid not null references ppt_jobs(id) on delete cascade,
  -- 页内单调递增的版本号, 1 起。回滚 = 把某个历史版本的快照拷回 ppt_pages
  version     int  not null,
  title       text not null default '',
  bullets     jsonb not null default '[]'::jsonb,
  notes       text not null default '',
  image_prompt text not null default '',
  image_rel   text not null default '',
  image_layout text not null default 'none',
  image_source text not null default '',
  -- 这个版本是怎么来的: scripts(脚本阶段) / regen(单页重生) / annotate(批注重绘) / manual(手改)
  --   `annotate` 要能看出来 —— 批注重绘只改局部, 出了偏差时得知道拿哪个版本做基线
  origin      text not null default 'manual'
              check (origin in ('scripts','regen','annotate','manual','rollback')),
  annotation  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (page_id, version)
);
create index if not exists idx_ppt_page_versions_page on ppt_page_versions (page_id, version desc);

comment on table ppt_jobs is 'V426 PPT 生成工作台任务(状态机 created→outline_ready→scripted→rendering→done; scripting/rendering 是可恢复的中间态)';
comment on table ppt_pages is 'V426 演示稿的一页。一页一行 —— 单页重生只 update 这一行, 不碰其它页';
comment on column ppt_pages.image_source is '配图来源: service=真生图 / placeholder=本地降级生成 / 空=无图。降级不许冒充真图';
comment on column ppt_page_versions.origin is '版本来源: scripts/regens/annotate/manual/rollback。annotate=批注重绘(只改局部)';
