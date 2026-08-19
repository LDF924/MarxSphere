// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// force-layout.ts — d3-force 力导向布局驱动（供 ForceGraphPanel 使用）
// 参数可调（charge / linkDistance / centerStrength），localStorage 持久化
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

export interface ForceParams {
  charge: number;
  linkDistance: number;
  centerStrength: number;
}

export const DEFAULT_FORCE_PARAMS: ForceParams = {
  charge: -400,
  linkDistance: 80,
  centerStrength: 0.1
};

const STORAGE_KEY = "sag:graph-force-params:v1";

export function loadForceParams(): ForceParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FORCE_PARAMS };
    const parsed = JSON.parse(raw) as Partial<ForceParams>;
    return {
      charge: typeof parsed.charge === "number" ? parsed.charge : DEFAULT_FORCE_PARAMS.charge,
      linkDistance: typeof parsed.linkDistance === "number" ? parsed.linkDistance : DEFAULT_FORCE_PARAMS.linkDistance,
      centerStrength: typeof parsed.centerStrength === "number" ? parsed.centerStrength : DEFAULT_FORCE_PARAMS.centerStrength
    };
  } catch {
    return { ...DEFAULT_FORCE_PARAMS };
  }
}

export function saveForceParams(params: ForceParams) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {
    // localStorage 不可用则忽略
  }
}

export interface ForceNodeDatum extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  fx?: number | null;
  fy?: number | null;
}

export interface ForceLinkDatum extends SimulationLinkDatum<ForceNodeDatum> {
  source: string | ForceNodeDatum;
  target: string | ForceNodeDatum;
}

/**
 * 运行力导向仿真。每 tick 回调（20ms 节流）携带最新节点坐标。
 * 返回 { stop, restart }：stop 立即停仿真；restart 用新参数重跑。
 */
export function runForceSimulation(input: {
  nodes: ForceNodeDatum[];
  links: ForceLinkDatum[];
  params: ForceParams;
  width: number;
  height: number;
  onTick: (nodes: ForceNodeDatum[]) => void;
}): { stop: () => void; restart: (params: ForceParams) => void } {
  const { nodes, links, params, width, height, onTick } = input;

  const simulation = forceSimulation<ForceNodeDatum>(nodes)
    .force("charge", forceManyBody<ForceNodeDatum>().strength(params.charge))
    .force("link", forceLink<ForceNodeDatum, ForceLinkDatum>(links).id((d) => d.id).distance(params.linkDistance))
    .force("x", forceX<ForceNodeDatum>(width / 2).strength(params.centerStrength))
    .force("y", forceY<ForceNodeDatum>(height / 2).strength(params.centerStrength))
    .force("center", forceCenter(width / 2, height / 2))
    .force("collide", forceCollide<ForceNodeDatum>().radius(28))
    .alphaDecay(0.02);

  let lastTick = 0;
  const tickHandler = () => {
    // 收敛后自动停（alpha < 0.02 布局基本稳定，避免无限 setNodes）
    if (simulation.alpha() < 0.02) {
      simulation.stop();
      return;
    }
    const now = Date.now();
    if (now - lastTick >= 20) {
      lastTick = now;
      onTick(nodes);
    }
  };
  simulation.on("tick", tickHandler);

  // 首次立即回调
  onTick(nodes);

  return {
    stop: () => {
      simulation.stop();
    },
    restart: (newParams: ForceParams) => {
      simulation
        .force("charge", forceManyBody<ForceNodeDatum>().strength(newParams.charge))
        .force("link", forceLink<ForceNodeDatum, ForceLinkDatum>(links).id((d) => d.id).distance(newParams.linkDistance))
        .force("x", forceX<ForceNodeDatum>(width / 2).strength(newParams.centerStrength))
        .force("y", forceY<ForceNodeDatum>(height / 2).strength(newParams.centerStrength))
        .alpha(0.6)
        .restart();
    }
  };
}
