// viz-agent-service 回归: 图表类型标签必须与输入意图一致
// 由来(2026-09-11): 实测"画论文方法流程图"被标成"折线图" — 流程图常用 plt.plot 画连线,
//   把 plot( 当折线信号会误判; 且文件类型判断须先于绘图 API 判断。
import { describe, expect, it } from "vitest";
import { classifyChart } from "../src/services/viz-agent-service.js";

describe("classifyChart 图表类型判定", () => {
  it("流程图优先于 plt.plot 连线(实测回归)", () => {
    const code = [
      "import matplotlib.pyplot as plt",
      "fig, ax = plt.subplots()",
      "ax.plot([0.2, 0.2], [0.8, 0.6], color='k')  # 阶段间连线",
      "ax.text(0.2, 0.9, '数据预处理')",
    ].join("\n");
    expect(classifyChart("画一个论文方法流程图(概念示意)", code)).toBe("流程图");
  });

  it("折线图仍按意图识别", () => {
    expect(classifyChart("画折线图展示 2019-2023 趋势", "ax.plot(x, y)")).toBe("折线图");
  });

  it("柱状图 / 散点图 / 箱线图", () => {
    expect(classifyChart("画柱状图", "ax.bar(x, y)")).toBe("柱状图");
    expect(classifyChart("画散点图加趋势线", "plt.scatter(x, y)")).toBe("散点图");
    expect(classifyChart("画箱线图", "sns.boxplot(data=df)")).toBe("箱线图");
  });

  it("无法判定时返回空串(前端不显示错误标签)", () => {
    expect(classifyChart("画点东西", "ax.axis('off')")).toBe("");
  });
});
