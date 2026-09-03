// OrbitalGraph3D.tsx — 3D 轨道图谱(阶段4a, 完整移植 Zleap orbital-graph-3d.tsx 1374 行)
// 参照: zleap/apps/web/components/features/orbital-graph-3d.tsx
// 设计对齐(不简化): 斐波那契轨道布局 + 松弛迭代 + 事件盘/实体球 + 脉冲边 + CSS2D 标签 + 轨道环 + 背景点
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Maximize2, Minimize2, Orbit, RotateCcw } from "lucide-react";

export type OrbitalGraphKind = "event" | "entity";

export interface OrbitalNodeInput {
  id: string;
  kind: OrbitalGraphKind;
  label: string;
  subtitle?: string;
  category?: string;
}

export interface OrbitalEdgeInput {
  id: string;
  fromId: string;
  toId: string;
}

interface OrbitalLayout {
  positions: Map<string, THREE.Vector3>;
  innerRadius: number;
  outerRadius: number;
}

export const INNER_RADIUS = 158;
export const OUTER_RADIUS = 424;
export const ENTITY_SIZE_RATIO = 0.6;
export const BASE_EDGE_OPACITY = 0.085;

export const EVENT_COLORS = ["#ff6b7f", "#ec82ad", "#f4a261", "#ff8f70", "#f3c86a"];
export const ENTITY_COLORS = ["#5577ff", "#6b9cff", "#8d76ff", "#58c5d8", "#d7def2"];
export const PLATE_COLORS = [
  "#f05d7b", "#f48c68", "#f2c45e", "#53c6a5",
  "#4eb3d3", "#6289e8", "#8d6ed4", "#d96fa5",
];

function hashValue(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nodeColor(kind: OrbitalGraphKind, key: string) {
  const colors = kind === "event" ? EVENT_COLORS : ENTITY_COLORS;
  return colors[hashValue(key) % colors.length];
}

function plateColor(key: string, index: number) {
  return PLATE_COLORS[(hashValue(key) + index * 3) % PLATE_COLORS.length];
}

function nodeId(kind: OrbitalGraphKind, id: string) {
  return `${kind}:${id}`;
}

function fibonacciDirection(index: number, count: number, phase = 0) {
  const safeCount = Math.max(1, count);
  const y = 1 - ((index + 0.5) / safeCount) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = (index + phase) * Math.PI * (3 - Math.sqrt(5));
  return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), -0.16)
    .normalize();
}

/** 布局: 事件在内球面(斐波那契), 实体在外球面(锚定+松弛迭代) — 对齐 buildOrbitalLayout */
function buildOrbitalLayout(nodes: OrbitalNodeInput[], edges: OrbitalEdgeInput[]): OrbitalLayout {
  const positions = new Map<string, THREE.Vector3>();
  const eventDirections = new Map<string, THREE.Vector3>();
  const events = nodes.filter((n) => n.kind === "event");
  const entities = nodes.filter((n) => n.kind === "entity");

  events.forEach((event, index) => {
    const direction = fibonacciDirection(index, events.length, 0.24);
    eventDirections.set(event.id, direction);
    positions.set(nodeId("event", event.id), direction.clone().multiplyScalar(INNER_RADIUS));
  });

  const linkedEvents = new Map<string, string[]>();
  edges.forEach((e) => {
    const values = linkedEvents.get(e.toId) ?? [];
    values.push(e.fromId);
    linkedEvents.set(e.toId, values);
  });

  const anchors = entities.map((entity, index) => {
    const spread = fibonacciDirection(index, entities.length, 0.71);
    const linked = linkedEvents.get(entity.id) ?? [];
    const relatedDirection = linked.reduce((sum, eventId) => {
      const direction = eventDirections.get(eventId);
      return direction ? sum.add(direction) : sum;
    }, new THREE.Vector3());
    if (relatedDirection.lengthSq() < 0.0001) return spread;
    return relatedDirection.normalize().multiplyScalar(0.7).addScaledVector(spread, 0.3).normalize();
  });

  let entityDirections = anchors.map((anchor, index) =>
    anchor
      .clone()
      .multiplyScalar(0.82)
      .addScaledVector(fibonacciDirection(index, anchors.length, 1.13), 0.18)
      .normalize(),
  );
  const minimumDistance = Math.max(0.26, Math.min(0.42, 2.45 / Math.sqrt(Math.max(1, anchors.length))));
  const relaxationIterations = anchors.length > 320 ? 0 : anchors.length > 180 ? 18 : 90;
  for (let iteration = 0; iteration < relaxationIterations; iteration += 1) {
    entityDirections = entityDirections.map((direction, index, values) => {
      const force = new THREE.Vector3();
      values.forEach((other, otherIndex) => {
        if (index === otherIndex) return;
        const delta = direction.clone().sub(other);
        const distance = delta.length();
        if (distance >= minimumDistance || distance < 0.00001) return;
        const tangent = delta.addScaledVector(direction, -delta.dot(direction));
        if (tangent.lengthSq() < 0.00001) return;
        force.addScaledVector(tangent.normalize(), (minimumDistance - distance) * 0.13);
      });
      const anchorTangent = anchors[index]
        .clone()
        .addScaledVector(direction, -anchors[index].dot(direction));
      force.addScaledVector(anchorTangent, 0.012);
      return direction.clone().add(force).normalize();
    });
  }

  entities.forEach((entity, index) => {
    positions.set(
      nodeId("entity", entity.id),
      entityDirections[index].clone().multiplyScalar(OUTER_RADIUS),
    );
  });
  return { positions, innerRadius: INNER_RADIUS, outerRadius: OUTER_RADIUS };
}

// ═══ 纹理生成(对齐 makeDiscTexture/makeRingTexture/makePulseTexture) ═══

function makeDiscTexture(fill: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);
  const center = 80;
  const radius = 52;
  context.clearRect(0, 0, 160, 160);
  context.save();
  context.shadowColor = `${fill}99`;
  context.shadowBlur = 18;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  context.restore();
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.lineWidth = 9;
  context.strokeStyle = "#101522";
  context.stroke();
  context.beginPath();
  context.arc(center, center, radius - 4.5, 0, Math.PI * 2);
  context.lineWidth = 2;
  context.strokeStyle = "rgba(255,255,255,0.72)";
  context.stroke();
  const highlight = context.createRadialGradient(59, 54, 2, 65, 60, 40);
  highlight.addColorStop(0, "rgba(255,255,255,0.42)");
  highlight.addColorStop(1, "rgba(255,255,255,0)");
  context.beginPath();
  context.arc(center, center, radius - 7, 0, Math.PI * 2);
  context.fillStyle = highlight;
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function makeRingTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);
  context.clearRect(0, 0, 160, 160);
  context.save();
  context.shadowColor = "rgba(255,255,255,0.9)";
  context.shadowBlur = 16;
  context.beginPath();
  context.arc(80, 80, 55, 0, Math.PI * 2);
  context.lineWidth = 4;
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.stroke();
  context.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makePulseTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);
  const glow = context.createRadialGradient(32, 32, 0, 32, 32, 28);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.22, "rgba(166,205,255,0.95)");
  glow.addColorStop(1, "rgba(83,119,255,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ═══ 场景构建(对齐 addOrbitRings/addBackgroundPoints/edgeCurve/disposeScene) ═══

function addOrbitRings(scene: THREE.Scene, radius: number, color: string, opacity: number) {
  const circle = (pointAt: (angle: number) => THREE.Vector3, ringOpacity = opacity) => {
    const points = Array.from({ length: 129 }, (_, index) => pointAt((index / 128) * Math.PI * 2));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color,
      transparent: true,
      opacity: ringOpacity,
      dashSize: radius > 200 ? 9 : 6,
      gapSize: radius > 200 ? 13 : 9,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 0;
    scene.add(line);
  };
  circle((angle) => new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0));
  circle((angle) => new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  circle((angle) => new THREE.Vector3(0, Math.cos(angle) * radius, Math.sin(angle) * radius));
  [-0.48, 0.48].forEach((latitude) => {
    const y = radius * latitude;
    const ringRadius = radius * Math.sqrt(1 - latitude * latitude);
    circle(
      (angle) => new THREE.Vector3(Math.cos(angle) * ringRadius, y, Math.sin(angle) * ringRadius),
      opacity * 0.62,
    );
  });
}

function addBackgroundPoints(scene: THREE.Scene) {
  let seed = 24681357;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const positions: number[] = [];
  for (let index = 0; index < 280; index += 1) {
    const direction = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();
    direction.multiplyScalar(620 + random() * 620);
    positions.push(direction.x, direction.y, direction.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xaab6d1,
    size: 1.65,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    sizeAttenuation: true,
  });
  scene.add(new THREE.Points(geometry, material));
}

function edgeCurve(start: THREE.Vector3, end: THREE.Vector3, key: string) {
  const bow = start.clone().normalize().cross(end.clone().normalize());
  if (bow.lengthSq() > 0.0001) {
    bow.normalize().multiplyScalar(hashValue(key) % 2 === 0 ? 16 : -16);
  }
  const firstControl = start.clone().multiplyScalar(1.42).add(bow);
  const secondControl = end.clone().multiplyScalar(0.78).addScaledVector(bow, 0.65);
  return new THREE.CubicBezierCurve3(start, firstControl, secondControl, end);
}

function disposeScene(scene: THREE.Scene, textures: Iterable<THREE.Texture>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (renderable.geometry) geometries.add(renderable.geometry);
    const values = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material
        ? [renderable.material]
        : [];
    values.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  for (const texture of textures) texture.dispose();
}

export { buildOrbitalLayout, nodeColor, plateColor, nodeId, edgeCurve, disposeScene, addOrbitRings, addBackgroundPoints, makeDiscTexture, makeRingTexture, makePulseTexture };
