"use client";

import type { ReactElement } from "react";

import { UniverseViewSettings } from "./UniverseViewSettingsPanel";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";
import { useIsMobile } from "../lib/use-mobile";
import {
  useUniverseEntityCategories,
  useUniverseViewPreferences,
} from "../lib/universe-view-preferences";
import { cn } from "../lib/utils";

export function UniverseViewSettingsDrawer({
  trigger,
}: {
  trigger: ReactElement;
}) {
  const t = { "drawer.title": "图谱显示设置", "drawer.description": "一套配置同时作用于时空探索与线索累积，调整后立即生效。" } as const;
  const common = { close: "关闭" } as const;
  const mobile = useIsMobile();
  const entityCategories = useUniverseEntityCategories();
  const { preferences, updatePreferences, resetPreferences } =
    useUniverseViewPreferences();

  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side={mobile ? "bottom" : "right"}
        overlayClassName="bg-black/30 backdrop-blur-[1px]"
        closeLabel={common.close}
        className={cn(
          "flex flex-col gap-0 overflow-hidden border-border/70 bg-background/95 p-0 shadow-lift backdrop-blur-xl",
          mobile
            ? "h-[82svh] max-h-[82svh] w-full max-w-none rounded-t-2xl"
            : "h-full w-[420px] max-w-[calc(100vw-1rem)] sm:max-w-[420px]",
        )}
      >
        <SheetHeader className="shrink-0 border-b border-border/70 px-5 py-4 pr-12 text-left">
          <SheetTitle className="text-base">{t["drawer.title"]}</SheetTitle>
          <SheetDescription className="text-xs leading-5">
            {t["drawer.description"]}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
          <UniverseViewSettings
            preferences={preferences}
            onChange={updatePreferences}
            onReset={resetPreferences}
            entityCategories={entityCategories}
            compact
            isMobile={mobile}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
