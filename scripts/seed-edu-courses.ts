// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// seed-edu-courses.ts — 示例课程一键入库（复赛冲刺期）
// 将 2 门示范课程（政治经济学 / 数学）切片写入 source_chunks 知识库
// 用法: npx tsx scripts/seed-edu-courses.ts
import { pool } from "../src/db/pool.js";

const SOURCE_ID = process.env.EDU_SOURCE_ID || "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

/** 示例课程：政治经济学《价值规律》+ 数学《配方法》 切片（模拟公开教材/文献文本） */
export const COURSES = [
  {
    subject: "政治经济学",
    chapters: [
      {
        title: "商品与价值",
        content: `商品是用来交换的劳动产品，具有使用价值和价值二因素。使用价值是商品能满足人们某种需要的属性，是价值的物质承担者；价值是凝结在商品中的无差别的人类劳动，是商品的社会属性。商品二因素由生产商品的劳动二重性决定：具体劳动创造使用价值，抽象劳动形成价值。价值量由生产商品的社会必要劳动时间决定，与劳动生产率成反比。`,
      },
      {
        title: "价值规律",
        content: `价值规律是商品经济的基本规律：商品的价值量由生产商品的社会必要劳动时间决定，商品交换以价值量为基础实行等价交换。价格受供求关系影响围绕价值上下波动，这是价值规律的表现形式。价值规律的作用：自发调节生产资料和劳动力在社会各生产部门之间的分配；刺激商品生产者改进技术、改善经营管理，提高劳动生产率；促使商品生产者优胜劣汰。`,
      },
      {
        title: "剩余价值",
        content: `剩余价值是雇佣工人在生产过程中创造的、被资本家无偿占有的超过劳动力价值的价值。剩余价值生产是资本主义生产的绝对规律：绝对剩余价值生产靠延长劳动日，相对剩余价值生产靠缩短必要劳动时间。剩余价值率 = 剩余价值 / 可变资本。剩余价值理论是马克思主义政治经济学的核心，揭示了资本主义剥削的秘密与资本主义基本矛盾。`,
      },
    ],
  },
  {
    subject: "数学",
    chapters: [
      {
        title: "一元二次方程与配方法",
        content: `配方法是解一元二次方程的基本方法之一。对于 ax² + bx + c = 0（a ≠ 0），配方步骤：① 化二次项系数为 1（两边除以 a）；② 移项，常数项移到等号右边；③ 配方，两边同时加一次项系数一半的平方；④ 左边写成完全平方，右边合并；⑤ 开平方求解，注意正负号。配方法还常用于求二次函数顶点式、证明恒等式与判别式分析。`,
      },
      {
        title: "因式分解",
        content: `因式分解是把一个多项式分解为几个整式乘积的形式，是配方法等后续学习的基础。常用方法：提公因式法（提取最大公因式）、公式法（平方差 a² - b² = (a+b)(a-b)、完全平方 a² ± 2ab + b² = (a±b)²）、十字相乘法（对二次三项式 ax² + bx + c）。因式分解是解一元二次方程（因式分解法）与化简分式的核心技能。`,
      },
    ],
  },
];

async function main() {
  console.log("[seed-edu-courses] 开始入库示例课程切片…");
  let total = 0;

  for (const course of COURSES) {
    for (const ch of course.chapters) {
      // 幂等：同标题不重复插入
      const exists = await pool.query(`select id from source_chunks where heading = $1 limit 1`, [ch.title]);
      if (exists.rows.length > 0) {
        console.log(`  - 跳过（已存在）: ${ch.title}`);
        continue;
      }
      const r = await pool.query(
        `insert into source_chunks (id, source_id, source_type, heading, content, raw_content, rank, metadata)
         values (gen_random_uuid(), $1, 'document', $2, $3, $3, 0, $4) returning id`,
        [SOURCE_ID, ch.title, ch.content, JSON.stringify({ subject: course.subject, kind: "示例课程" })]
      );
      console.log(`  + 入库: ${ch.title} (id=${r.rows[0].id})`);
      total += 1;
    }
  }

  console.log(`[seed-edu-courses] 完成，新增 ${total} 条切片`);
  console.log("  知识库检索验证: POST /api/education/tutoring { subject, topic: '价值规律' }");
  await pool.end();
}

main().catch((e) => {
  console.error("[seed-edu-courses] 失败:", e);
  process.exit(1);
});
