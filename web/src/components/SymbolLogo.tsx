// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// SymbolLogo.tsx — 品牌 Logo（直接用图片 /marx-logo.png，高保真）
import type { FC } from "react";

export const SymbolLogo: FC<{ size?: number }> = ({ size = 40 }) => {
  return (
    <div
      className="symbol-logo"
      style={{ width: size, height: size }}
    >
      <img
        src="/marx-logo.png"
        alt="MarxSphere"
        className="symbol-logo-img"
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  );
};
