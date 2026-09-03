"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";

import { SettingsRow, SettingsSection } from "./settings-section";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Slider } from "./ui/slider";
import { useIsMobile } from "../lib/use-mobile";
import {
  UNIVERSE_VIEW_LIMITS,
  minimumUniverseCacheCapacity,
  normalizeUniverseViewPreferences,
  type UniverseViewPreferences,
} from "../lib/universe-view-preferences";
import { cn } from "../lib/utils";

export interface UniverseViewSettingsProps {
  preferences: UniverseViewPreferences;
  onChange: (preferences: UniverseViewPreferences) => void;
  onReset: () => void;
  entityCategories: string[];
  compact?: boolean;
  isMobile?: boolean;
}


const GRAPH_SETTINGS_MESSAGES = {
  "value.current": "当前",
  "value.recommended": (count: number) => `推荐 ${count}`,
  "cards.title": "节点卡片",
  "cards.description": "只控制可读卡片，不改变事件、实体和真实关系。",
  "cards.enabled.title": "启用事件与实体卡片",
  "cards.enabled.description": "关闭后仍保留完整星点网络，悬停或锁定时仍可查看当前关系。",
  "cards.enabled.aria": "启用事件与实体卡片",
  "cards.preview.title": "事件卡片数量",
  "cards.preview.description": "只限制画面中默认展开的事件卡片；事件窗口、实体和真实连线不受影响。",
  "cards.preview.aria": "默认显示的事件卡片数量",
  "entityTypes.title": "实体类型",
  "entityTypes.description": "筛选参与当前画面的实体类别；被筛掉的实体及其事项连线一起隐藏，事项与事项关系保留，且至少保留一种实体类型。",
  "entityTypes.all": "全部类型",
  "entityTypes.none": "暂无分类",
  "entityTypes.emptyDescription": "探索含实体的知识后，可用分类会自动同步到这里。",
  "window.title": "探索窗口",
  "window.description": "窗口决定当前构图规模，缓存只保存纯数据，海量探索仍保持有界。",
  "eventWindow.title": "事件窗口",
  "eventWindow.description": "控制参与当前构图的事件数量；实体随事件完整进入，旧事件从边缘自然退出。",
  "eventWindow.aria": "事件窗口数量",
  "cacheCapacity.title": "事件缓存",
  "cacheCapacity.description": "保存已加载的事件、实体和关系纯数据；达到上限后按进入顺序淘汰最旧记录。",
  "cacheCapacity.aria": "事件缓存容量",
  "temporal.title": "时空探索",
  "temporal.description": "只影响信息源时间探索的网络分页和前后准备，不改变同屏窗口。",
  "temporal.page.title": "分页大小",
  "temporal.page.description": "每次从时间线加载的事件数量。",
  "temporal.page.aria": "时空探索分页大小",
  "temporal.prefetch.title": "前后预取",
  "temporal.prefetch.description": "当前窗口前后各提前准备的页数；请求始终串行。",
  "temporal.prefetch.aria": "时空探索前后预取页数",
  "reset.savedLocally": "设置会立即同步到当前图谱，并保存在本浏览器。",
  "reset.action": "恢复默认",
};

function gsMessage(key: string, args?: Record<string, unknown>) {
  const entry = GRAPH_SETTINGS_MESSAGES[key as keyof typeof GRAPH_SETTINGS_MESSAGES];
  if (typeof entry === "function") return (entry as (count: number) => string)(args?.count as number);
  return entry as string;
}


function SettingSlider({
  ariaLabel,
  value,
  min,
  max,
  step,
  recommended,
  onChange,
}: {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  recommended: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{gsMessage("value.current")}</span>
        <span className="font-mono font-semibold tabular-nums">{value}</span>
      </div>
      <Slider
        aria-label={ariaLabel}
        max={max}
        min={min}
        onValueChange={([next]) => {
          if (next !== undefined) onChange(next);
        }}
        step={step}
        value={[value]}
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{min}</span>
        <span>{gsMessage("value.recommended", { count: recommended })}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

export function UniverseViewSettings({
  preferences,
  onChange,
  onReset,
  entityCategories,
  compact = false,
  isMobile,
}: UniverseViewSettingsProps) {
  const locale = "zh-CN";
  const detectedMobile = useIsMobile();
  const mobile = isMobile ?? detectedMobile;
  const normalized = React.useMemo(
    () => normalizeUniverseViewPreferences(preferences),
    [preferences],
  );
  const availableTypes = React.useMemo(() => {
    const selected = normalized.entityTypes ?? [];
    return [...new Set([...entityCategories, ...selected]
      .map((category) => category.trim())
      .filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, locale));
  }, [entityCategories, locale, normalized.entityTypes]);

  const emit = React.useCallback((patch: Partial<UniverseViewPreferences>) => {
    onChange(normalizeUniverseViewPreferences({ ...normalized, ...patch }));
  }, [normalized, onChange]);

  const toggleType = React.useCallback((category: string, checked: boolean) => {
    const next = new Set(normalized.entityTypes ?? availableTypes);
    if (checked) next.add(category);
    else {
      if (next.size <= 1) return;
      next.delete(category);
    }
    const selected = availableTypes.filter((item) => next.has(item));
    emit({
      entityTypes: selected.length === availableTypes.length
        ? null
        : selected,
    });
  }, [availableTypes, emit, normalized.entityTypes]);

  const allTypesSelected = normalized.entityTypes === null;
  const selectedTypeCount = normalized.entityTypes?.length
    ?? availableTypes.length;
  const minimumCache = minimumUniverseCacheCapacity(
    normalized.eventWindowSize,
    normalized.temporalPageSize,
    normalized.temporalPrefetchPages,
  );

  return (
    <div
      className={cn("flex flex-col", compact ? "gap-4" : "gap-6")}
      data-settings-section="graph"
      data-settings-compact={compact}
      data-settings-device={mobile ? "mobile" : "desktop"}
      data-event-window-size={normalized.eventWindowSize}
      data-event-card-preview-count={normalized.eventCardPreviewCount}
      data-cache-capacity={normalized.cacheCapacity}
    >
      <SettingsSection
        title={gsMessage("cards.title")}
        description={gsMessage("cards.description")}
      >
        <SettingsRow
          title={gsMessage("cards.enabled.title")}
          description={gsMessage("cards.enabled.description")}
          layout="inline"
          className={cn(compact && "sm:flex-row sm:items-center")}
        >
          <Checkbox
            aria-label={gsMessage("cards.enabled.aria")}
            checked={normalized.cardsEnabled}
            onCheckedChange={(value) => emit({ cardsEnabled: value === true })}
          />
        </SettingsRow>
        <SettingsRow
          title={gsMessage("cards.preview.title")}
          description={gsMessage("cards.preview.description")}
        >
          <SettingSlider
            ariaLabel={gsMessage("cards.preview.aria")}
            value={normalized.eventCardPreviewCount}
            min={UNIVERSE_VIEW_LIMITS.eventCardPreviewCount.min}
            max={Math.min(
              normalized.eventWindowSize,
              UNIVERSE_VIEW_LIMITS.eventCardPreviewCount.max,
            )}
            step={UNIVERSE_VIEW_LIMITS.eventCardPreviewCount.step}
            recommended={UNIVERSE_VIEW_LIMITS.eventCardPreviewCount.default}
            onChange={(eventCardPreviewCount) => emit({
              eventCardPreviewCount,
            })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title={gsMessage("entityTypes.title")}
        description={gsMessage("entityTypes.description")}
      >
        <div className="p-4 sm:p-5">
          <div className="overflow-hidden rounded-lg border">
            <label className={cn(
              "flex items-center gap-3 border-b px-3 py-2.5 text-sm font-medium",
              allTypesSelected ? "cursor-default" : "cursor-pointer",
            )}>
              <Checkbox
                checked={allTypesSelected}
                disabled={allTypesSelected}
                onCheckedChange={(value) => {
                  if (value === true) emit({ entityTypes: null });
                }}
              />
              {gsMessage("entityTypes.all")}
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {availableTypes.length || gsMessage("entityTypes.none")}
              </span>
            </label>
            {availableTypes.length > 0 ? (
              <div className={cn(
                "grid max-h-48 overflow-y-auto py-1",
                !compact && "sm:grid-cols-2",
              )}>
                {availableTypes.map((category) => {
                  const checked = allTypesSelected
                    || Boolean(normalized.entityTypes?.includes(category));
                  const lastSelected = checked && selectedTypeCount <= 1;
                  return (
                    <label
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 text-sm",
                        lastSelected
                          ? "cursor-default"
                          : "cursor-pointer hover:bg-muted/60",
                      )}
                      key={category}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={lastSelected}
                        onCheckedChange={(value) =>
                          toggleType(category, value === true)}
                      />
                      <span className="min-w-0 truncate" title={category}>
                        {category}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="px-3 py-3 text-sm text-muted-foreground">
                {gsMessage("entityTypes.emptyDescription")}
              </p>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={gsMessage("window.title")}
        description={gsMessage("window.description")}
      >
        <SettingsRow
          title={gsMessage("eventWindow.title")}
          description={gsMessage("eventWindow.description")}
        >
          <SettingSlider
            ariaLabel={gsMessage("eventWindow.aria")}
            value={normalized.eventWindowSize}
            min={UNIVERSE_VIEW_LIMITS.eventWindowSize.min}
            max={UNIVERSE_VIEW_LIMITS.eventWindowSize.max}
            step={UNIVERSE_VIEW_LIMITS.eventWindowSize.step}
            recommended={UNIVERSE_VIEW_LIMITS.eventWindowSize.default}
            onChange={(eventWindowSize) => emit({ eventWindowSize })}
          />
        </SettingsRow>

        <SettingsRow
          title={gsMessage("cacheCapacity.title")}
          description={gsMessage("cacheCapacity.description")}
        >
          <SettingSlider
            ariaLabel={gsMessage("cacheCapacity.aria")}
            value={normalized.cacheCapacity}
            min={minimumCache}
            max={UNIVERSE_VIEW_LIMITS.cacheCapacity.max}
            step={UNIVERSE_VIEW_LIMITS.cacheCapacity.step}
            recommended={UNIVERSE_VIEW_LIMITS.cacheCapacity.default}
            onChange={(cacheCapacity) => emit({ cacheCapacity })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title={gsMessage("temporal.title")}
        description={gsMessage("temporal.description")}
      >
        <SettingsRow
          title={gsMessage("temporal.page.title")}
          description={gsMessage("temporal.page.description")}
        >
          <SettingSlider
            ariaLabel={gsMessage("temporal.page.aria")}
            value={normalized.temporalPageSize}
            min={UNIVERSE_VIEW_LIMITS.temporalPageSize.min}
            max={UNIVERSE_VIEW_LIMITS.temporalPageSize.max}
            step={UNIVERSE_VIEW_LIMITS.temporalPageSize.step}
            recommended={UNIVERSE_VIEW_LIMITS.temporalPageSize.default}
            onChange={(temporalPageSize) => emit({ temporalPageSize })}
          />
        </SettingsRow>
        <SettingsRow
          title={gsMessage("temporal.prefetch.title")}
          description={gsMessage("temporal.prefetch.description")}
        >
          <SettingSlider
            ariaLabel={gsMessage("temporal.prefetch.aria")}
            value={normalized.temporalPrefetchPages}
            min={UNIVERSE_VIEW_LIMITS.temporalPrefetchPages.min}
            max={UNIVERSE_VIEW_LIMITS.temporalPrefetchPages.max}
            step={UNIVERSE_VIEW_LIMITS.temporalPrefetchPages.step}
            recommended={UNIVERSE_VIEW_LIMITS.temporalPrefetchPages.default}
            onChange={(temporalPrefetchPages) => emit({
              temporalPrefetchPages,
            })}
          />
        </SettingsRow>
      </SettingsSection>

      <div className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card px-4 py-3 shadow-soft",
        !compact && "sm:flex-row sm:items-center sm:justify-between sm:px-5",
      )}>
        <p className="text-xs leading-5 text-muted-foreground">
          {gsMessage("reset.savedLocally")}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onReset}>
          <RotateCcw />
          {gsMessage("reset.action")}
        </Button>
      </div>
    </div>
  );
}
