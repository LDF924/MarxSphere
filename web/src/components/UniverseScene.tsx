// universe-scene.tsx — 3D 场景 React 封装(对齐 Zleap universe-scene.tsx)
// 动态导入 3d-force-graph 与 UniverseForceSceneEngine;失败按原因分类上报
// (dynamic-import/context-disabled/context-creation/initialization/context-lost),
// WebGL 上下文失败是预期能力边界,不抛未捕获错误。
// 注: 原版用 next-intl useTranslations,本地用中文字面量替代(Zleap zh-CN 消息)。
"use client";

import * as React from "react";
import * as THREE from "three";
import type { ForceGraph3DInstance } from "3d-force-graph";

import { classifyUniverseWebGLContextFailure } from "../lib/universe-webgl-capability";
import type {
  UniverseSceneHandle,
  UniverseSceneProps,
  UniverseSceneUnavailableReason,
} from "../lib/universe-scene-contract";
import {
  UniverseForceSceneEngine,
  type ForceLink,
  type ForceNode,
  type UniverseSceneText,
} from "../lib/universe-scene-engine";

export {
  UNIVERSE_BRAND_GOLD,
  universeSourceAccent,
} from "../lib/universe-scene-engine";
export type {
  UniverseSceneData,
  UniverseSceneExplorationView,
  UniverseSceneHandle,
  UniverseSceneHover,
  UniverseSceneLink,
  UniverseSceneNode,
  UniverseSceneNodeKind,
  UniverseSceneProps,
  UniverseSceneStrategy,
  UniverseSceneTemporalFlight,
  UniverseSceneUnavailableReason,
  UniverseSceneView,
  UniverseSelectionClearOptions,
  UniverseTimelineDirection,
  UniverseTimelineIntentResult,
  UniverseTimelineJourney,
} from "../lib/universe-scene-contract";

const UNIVERSE_SCENE_MESSAGES = {
  aria: "知识宇宙 3D 图谱",
  keyboardInstructions:
    "按方向键浏览图谱，按 Enter 或空格打开或锁定当前项，按 Escape 清除焦点；"
    + "拖动旋转视角，滚轮平滑缩放；进入信息源时间线后，滚轮同时推进或回退时间。",
  keyboardStatus: (label: string, index: number, total: number) =>
    `${label} 第 ${index} 个，共 ${total} 个。`,
  exploreSource: (label: string) => `探索信息源 ${label}`,
  sourceStats: (events: number, entities: number) =>
    `${events} 事件 · ${entities} 实体`,
  sourceStatsBuilding: (events: number) => `${events} 事件 · 实体统计中`,
  exploreNode: (kind: "event" | "entity", label: string) =>
    `探索${kind === "event" ? "事件" : "实体"} ${label}`,
  kind: (kind: "event" | "entity") => (kind === "event" ? "事件" : "实体"),
  relatedEvents: (count: number, category: string) =>
    `${count} 个关联事件 · ${category}`,
  continueExploring: (progress: number, total: number | string) =>
    `继续探索 ${progress}/${total}`,
  explorationProgress: (progress: number, total: number | string) =>
    `已探索 ${progress}/${total}`,
  explorationComplete: (progress: number, total: number | string) =>
    `关联已呈现 ${progress}/${total}`,
  extractedEvent: "已抽取事件",
};

export const UniverseScene = React.forwardRef<UniverseSceneHandle, UniverseSceneProps>(
  function UniverseScene(
    {
      data,
      strategy,
      policy,
      sourceHits,
      selectedId,
      darkTheme,
      interactive,
      reducedMotion,
      viewPreferences,
      timelineJourney,
      onNodeClick,
      onHover,
      onViewChange,
      onSourceLod,
      onSourceWheel,
      onSelectionClear,
      onBackRequest,
      onBackgroundClick,
      actionLabels,
      onViewDetails,
      onExploreMore,
      onAskNode,
      onUserInteraction,
      onTimelineIntent,
      onTimelineSettled,
      onUnavailable,
    },
    forwardedRef,
  ) {
    const text = React.useMemo<UniverseSceneText>(() => ({
      locale: "zh-CN",
      aria: UNIVERSE_SCENE_MESSAGES.aria,
      keyboardInstructions: UNIVERSE_SCENE_MESSAGES.keyboardInstructions,
      keyboardStatus: UNIVERSE_SCENE_MESSAGES.keyboardStatus,
      exploreSource: UNIVERSE_SCENE_MESSAGES.exploreSource,
      sourceStats: UNIVERSE_SCENE_MESSAGES.sourceStats,
      sourceStatsBuilding: UNIVERSE_SCENE_MESSAGES.sourceStatsBuilding,
      exploreNode: UNIVERSE_SCENE_MESSAGES.exploreNode,
      kind: UNIVERSE_SCENE_MESSAGES.kind,
      relatedEvents: UNIVERSE_SCENE_MESSAGES.relatedEvents,
      continueExploring: UNIVERSE_SCENE_MESSAGES.continueExploring,
      explorationProgress: UNIVERSE_SCENE_MESSAGES.explorationProgress,
      explorationComplete: UNIVERSE_SCENE_MESSAGES.explorationComplete,
      extractedEvent: UNIVERSE_SCENE_MESSAGES.extractedEvent,
      viewDetailsAction: actionLabels?.viewDetails,
      exploreMoreAction: actionLabels?.exploreMore,
      askAiAction: actionLabels?.askAi,
    }), [
      actionLabels?.askAi,
      actionLabels?.exploreMore,
      actionLabels?.viewDetails,
    ]);
    const keyboardInstructionsId = React.useId();
    const hostRef = React.useRef<HTMLDivElement>(null);
    const keyboardStatusRef = React.useRef<HTMLSpanElement>(null);
    const engineRef = React.useRef<UniverseForceSceneEngine | null>(null);
    const latestRef = React.useRef({
      data,
      strategy,
      policy,
      sourceHits,
      selectedId,
      darkTheme,
      interactive,
      reducedMotion,
      viewPreferences,
      timelineJourney,
      onNodeClick,
      onHover,
      onViewChange,
      onSourceLod,
      onSourceWheel,
      onSelectionClear,
      onBackRequest,
      onBackgroundClick,
      onViewDetails,
      onExploreMore,
      onAskNode,
      onUserInteraction,
      onTimelineIntent,
      onTimelineSettled,
      onUnavailable,
      text,
    });
    latestRef.current = {
      data,
      strategy,
      policy,
      sourceHits,
      selectedId,
      darkTheme,
      interactive,
      reducedMotion,
      viewPreferences,
      timelineJourney,
      onNodeClick,
      onHover,
      onViewChange,
      onSourceLod,
      onSourceWheel,
      onSelectionClear,
      onBackRequest,
      onBackgroundClick,
      onViewDetails,
      onExploreMore,
      onAskNode,
      onUserInteraction,
      onTimelineIntent,
      onTimelineSettled,
      onUnavailable,
      text,
    };
    const unavailableNotifiedRef = React.useRef(false);
    const notifyUnavailable = React.useCallback((reason: UniverseSceneUnavailableReason) => {
      if (unavailableNotifiedRef.current) return;
      unavailableNotifiedRef.current = true;
      if (hostRef.current) hostRef.current.dataset.universeEngine = reason;
      latestRef.current.onUnavailable?.(reason);
    }, []);

    React.useEffect(() => {
      if (!hostRef.current || !keyboardStatusRef.current) return;
      let cancelled = false;
      const host = hostRef.current;
      const keyboardStatusElement = keyboardStatusRef.current;
      void (async () => {
        let ForceGraph3D: typeof import("3d-force-graph")["default"];
        try {
          ({ default: ForceGraph3D } = await import("3d-force-graph"));
        } catch (reason) {
          console.warn("[KnowledgeUniverse] Failed to load the 3D scene module", reason);
          if (!cancelled) notifyUnavailable("dynamic-import");
          return;
        }
        if (cancelled) return;

        let engine: UniverseForceSceneEngine | null = null;
        try {
          const current = latestRef.current;
          engine = new UniverseForceSceneEngine(
            host,
            current.policy,
            current.viewPreferences,
            current.text,
            keyboardStatusElement,
            ForceGraph3D as unknown as new (
              element: HTMLElement,
              options?: {
                controlType?: "orbit";
                rendererConfig?: THREE.WebGLRendererParameters;
              },
            ) => ForceGraph3DInstance<ForceNode, ForceLink>,
          );
          engineRef.current = engine;
          engine.setCallbacks({
            onNodeClick: current.onNodeClick,
            onHover: current.onHover,
            onViewChange: current.onViewChange,
            onSourceLod: current.onSourceLod,
            onSourceWheel: current.onSourceWheel,
            onSelectionClear: current.onSelectionClear,
            onBackRequest: current.onBackRequest,
            onBackgroundClick: current.onBackgroundClick,
            onViewDetails: current.onViewDetails,
            onExploreMore: current.onExploreMore,
            onAskNode: current.onAskNode,
            onUserInteraction: current.onUserInteraction ?? (() => undefined),
            onTimelineIntent: current.onTimelineIntent,
            onTimelineSettled: current.onTimelineSettled,
            onUnavailable: notifyUnavailable,
          });
          engine.setOptions({
            interactive: current.interactive,
            strategy: current.strategy,
            reducedMotion: current.reducedMotion,
            darkTheme: current.darkTheme,
            viewPreferences: current.viewPreferences,
            timelineJourney: current.timelineJourney,
            text: current.text,
          });
          if (current.interactive) {
            engine.setData(current.data, current.policy, current.sourceHits);
            engine.setSelection(current.selectedId);
            engine.resume();
          }
        } catch (reason) {
          const unavailableReason = classifyUniverseWebGLContextFailure(reason)
            ?? "initialization";
          // A renderer failure is an expected capability boundary, not an
          // uncaught application error. console.error makes the Next dev
          // overlay cover the recoverable fallback UI.
          console.warn(
            `[KnowledgeUniverse] Failed to initialize the 3D scene (${unavailableReason})`,
            reason,
          );
          if (engineRef.current === engine) engineRef.current = null;
          try {
            engine?.dispose();
          } catch (cleanupReason) {
            console.warn("[KnowledgeUniverse] Failed to dispose a partial 3D scene", cleanupReason);
          }
          host.replaceChildren();
          if (!cancelled) notifyUnavailable(unavailableReason);
        }
      })();
      return () => {
        cancelled = true;
        engineRef.current?.dispose();
        engineRef.current = null;
      };
    }, [notifyUnavailable]);

    React.useEffect(() => {
      engineRef.current?.setCallbacks({
        onNodeClick,
        onHover,
        onViewChange,
        onSourceLod,
        onSourceWheel,
        onSelectionClear,
        onBackRequest,
        onBackgroundClick,
        onViewDetails,
        onExploreMore,
        onAskNode,
        onUserInteraction: onUserInteraction ?? (() => undefined),
        onTimelineIntent,
        onTimelineSettled,
        onUnavailable: notifyUnavailable,
      });
    }, [
      notifyUnavailable,
      onAskNode,
      onBackRequest,
      onBackgroundClick,
      onViewDetails,
      onExploreMore,
      onHover,
      onNodeClick,
      onSelectionClear,
      onSourceLod,
      onSourceWheel,
      onTimelineIntent,
      onTimelineSettled,
      onUserInteraction,
      onViewChange,
    ]);

    React.useLayoutEffect(() => {
      engineRef.current?.setOptions({
        interactive,
        strategy,
        reducedMotion,
        darkTheme,
        viewPreferences,
        timelineJourney,
        text,
      });
    }, [
      darkTheme,
      interactive,
      strategy,
      reducedMotion,
      text,
      timelineJourney,
      viewPreferences,
    ]);

    React.useLayoutEffect(() => {
      if (!interactive) return;
      const engine = engineRef.current;
      if (!engine) return;
      engine.setData(data, policy, sourceHits);
      engine.setSelection(latestRef.current.selectedId);
      engine.resume();
    }, [data, interactive, policy, sourceHits, strategy]);

    React.useLayoutEffect(() => {
      if (!interactive) return;
      engineRef.current?.setSelection(selectedId);
    }, [interactive, selectedId]);

    React.useImperativeHandle(
      forwardedRef,
      () => ({
        prepareExplorationRestore: () => engineRef.current?.prepareExplorationRestore(),
        captureExplorationView: () => engineRef.current?.captureExplorationView() ?? null,
        restoreExplorationView: (view) => engineRef.current?.restoreExplorationView(view),
        focusOverview: () => engineRef.current?.focusOverview(),
        resetOverview: () => engineRef.current?.resetOverview(),
        focusResult: () => engineRef.current?.focusResult(),
        focusSource: (sourceId) => engineRef.current?.focusSource(sourceId),
        returnToSourceOrigin: (sourceId) => (
          engineRef.current?.returnToSourceOrigin(sourceId) ?? "already-at-origin"
        ),
        focusNode: (nodeId) => engineRef.current?.focusNode(nodeId),
        lockNode: (nodeId) => engineRef.current?.lockNode(nodeId),
        unlockNode: () => engineRef.current?.unlockNode(),
        clearSelection: () => engineRef.current?.clearSelection(),
        moveTimeline: (direction) => engineRef.current?.moveTimeline(direction),
        pause: () => engineRef.current?.pause(),
        resume: () => engineRef.current?.resume(),
      }),
      [],
    );

    return (
      <>
        <div
          ref={hostRef}
          className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          data-universe-scene="three"
          data-universe-engine="loading"
          data-universe-active={interactive}
          data-universe-strategy={strategy}
          data-universe-paused={!interactive}
          data-universe-node-count={data.nodes.length}
          data-universe-link-count={data.links.length}
          data-universe-keyboard-active="false"
          data-universe-keyboard-node-id=""
          role="group"
          tabIndex={interactive ? 0 : -1}
          aria-label={text.aria}
          aria-describedby={keyboardInstructionsId}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space Escape"
        />
        <span id={keyboardInstructionsId} className="sr-only">
          {text.keyboardInstructions}
        </span>
        <span
          ref={keyboardStatusRef}
          className="sr-only"
          data-universe-keyboard-status="true"
          aria-live="polite"
          aria-atomic="true"
        />
      </>
    );
  },
);
