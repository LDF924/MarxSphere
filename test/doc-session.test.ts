// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/doc-session.test.ts — V404-13: WriterLease/ChangeSet/锚点(纯函数+应用逻辑)
// 纯函数 applyOpsToText 可离线测; DB 链路(acquire/apply/conflict/锚点重映射)标注需库
import { describe, it, expect } from "vitest";
import { applyOpsToText } from "../src/services/doc-session-service.js";

describe("doc-session (V404-13)", () => {
  it("applyOpsToText: 单替换", () => {
    const r = applyOpsToText("你好世界", [{ op: "replace", start: 2, end: 4, text: "宇宙" }]);
    expect(r.text).toBe("你好宇宙");
  });

  it("applyOpsToText: 多操作按 start 升序(乱序输入也正确)", () => {
    const r = applyOpsToText("abcdef", [
      { op: "replace", start: 4, end: 6, text: "XY" },  // 后段
      { op: "replace", start: 0, end: 2, text: "12" },  // 前段(乱序)
    ]);
    expect(r.text).toBe("12cdXY");
  });

  it("applyOpsToText: 插入(空区间)与删除", () => {
    expect(applyOpsToText("ab", [{ op: "replace", start: 1, end: 1, text: "X" }]).text).toBe("aXb");
    expect(applyOpsToText("abcd", [{ op: "replace", start: 1, end: 3, text: "" }]).text).toBe("ad");
  });

  it("applyOpsToText: 区间非法/重叠拒绝", () => {
    expect(applyOpsToText("ab", [{ op: "replace", start: 5, end: 6, text: "x" }]).error).toContain("非法");
    const over = applyOpsToText("abcdef", [
      { op: "replace", start: 1, end: 4, text: "X" },
      { op: "replace", start: 3, end: 5, text: "Y" }, // 与上一区间 [1,4) 重叠
    ]);
    expect(over.error).toContain("重叠");
  });
});
