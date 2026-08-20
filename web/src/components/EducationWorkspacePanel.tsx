// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EducationWorkspacePanel.tsx — 顶部「AI+教育」Tab 工作台（复赛冲刺期）
// 下拉两个子 Tab：学生端「我的学习」/ 教师端「教师工作台」
// 原科研工作台（33 视图）不做任何改动、不分角色、人人可用；教育能力全部内聚在此。
// 学生端：学习计划 / 作业辅导 / 错题本 / 学情画像 / 学习进度 / 苏格拉底辅导 / 自动闭环周报 / 学习陪伴
// 教师端：备课教案 / 命题组卷 / 作业批改 / 班级学情 / 板书识别 / 思政内容审核
// 公共：教育复用资产（模板/案例）入口
import { useState } from "react";
import { GraduationCap, Presentation } from "lucide-react";
import { EducationPanel } from "./EducationPanel";
import { StudentLearningPanel } from "./StudentLearningPanel";
import { TeacherWorkspacePanel } from "./TeacherWorkspacePanel";
import { EducationAssetsPanel } from "./EducationAssetsPanel";

export type EducationRole = "student" | "teacher";

export function EducationWorkspacePanel() {
  const [role, setRole] = useState<EducationRole>("student");

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      {/* 顶部「AI+教育」Tab 头 + 子 Tab 切换 */}
      <div className="mb-3 flex items-center justify-between rounded-lg border bg-card px-3 py-2 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <GraduationCap className="h-4 w-4 text-emerald-600" />
          AI+教育
        </div>
        <div className="flex items-center gap-1 rounded-md bg-muted p-1 text-xs">
          <button
            onClick={() => setRole("student")}
            className={`flex items-center gap-1 rounded px-3 py-1 transition-colors ${
              role === "student" ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GraduationCap className="h-3.5 w-3.5" /> 学生端 · 我的学习
          </button>
          <button
            onClick={() => setRole("teacher")}
            className={`flex items-center gap-1 rounded px-3 py-1 transition-colors ${
              role === "teacher" ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Presentation className="h-3.5 w-3.5" /> 教师端 · 教师工作台
          </button>
        </div>
      </div>

      {/* 子 Tab 内容：新增能力 + 六大核心能力按角色分发（学生端 E1/E2/E3/E4/E6，教师端 E5） */}
      {role === "student" ? (
        <>
          <StudentLearningPanel />
          <EducationAssetsPanel role="student" />
          <div className="mt-3 h-[1200px] overflow-hidden">
            <EducationPanel role="student" />
          </div>
        </>
      ) : (
        <>
          <TeacherWorkspacePanel />
          <EducationAssetsPanel role="teacher" />
          <div className="mt-3 h-[1200px] overflow-hidden">
            <EducationPanel role="teacher" />
          </div>
        </>
      )}
    </div>
  );
}
