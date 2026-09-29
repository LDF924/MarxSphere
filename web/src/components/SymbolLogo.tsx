// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// SymbolLogo.tsx — 品牌标记（群学求真 SocioSeek 的鲸）
//
// ⚠ 为什么用"自带白底的图标"而不是透明标记（2026-09-29 换标时实测定的）：
//   标记是**位图母版**（1536×1536 生成稿经 scripts/brand-assets.py 抠底/裁切后得到），
//   不是矢量 —— 想内联 SVG 就得描摹，而描摹会丢掉渐变与节点网络那层细节。
//   而透明标记**在深色主题下会糊掉**：鲸身是深蓝轮廓 + 白色腹部，放到深底上
//   只剩腹部一条白，实测 16px 完全不可辨。压测过白底 / 深底 / 中蓝底三个方案，
//   只有**白底**在 16px 仍认得出形状（透明像素 244/256，形状可辨）。
//   所以这里直接用**带白圆角底的图标**：它自带背景，浅色深色主题都不用换图。
//
// 尺寸档位与生成参数见 scripts/brand-assets.py —— 换母版时重跑那个脚本，别手改这里。
import type { FC } from "react";

export const SymbolLogo: FC<{ size?: number }> = ({ size = 40 }) => {
  return (
    <div className="symbol-logo" style={{ width: size, height: size }}>
      <img
        src="/brand-mark.png"
        alt="群学求真 SocioSeek"
        className="symbol-logo-img"
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </div>
  );
};
