// OrbitalGraph3DView.tsx — 3D 轨道图谱主组件(阶段4a, 完整移植 Zleap orbital-graph-3d.tsx 514-1374 行)
// 场景组装 + 射线拾取 + 悬停聚焦 + 选择 + 动画循环 + 全屏, 工具函数从 OrbitalGraph3D.tsx 导入
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Maximize2, Minimize2, Orbit, RotateCcw } from "lucide-react";

import {
  addBackgroundPoints,
  addOrbitRings,
  BASE_EDGE_OPACITY,
  buildOrbitalLayout,
  disposeScene,
  edgeCurve,
  ENTITY_SIZE_RATIO,
  EVENT_COLORS,
  makeDiscTexture,
  makePulseTexture,
  makeRingTexture,
  nodeColor,
  nodeId,
  PLATE_COLORS,
  plateColor,
  type OrbitalEdgeInput,
  type OrbitalGraphKind,
  type OrbitalNodeInput,
} from "./OrbitalGraph3D";

interface OrbitalSceneNode {
  id: string;
  kind: OrbitalGraphKind;
  object: THREE.Group;
  position: THREE.Vector3;
  visual: THREE.Sprite | THREE.Mesh;
  visualMaterial: THREE.SpriteMaterial | THREE.MeshStandardMaterial;
  visualKind: "disc" | "plate";
  baseColor: THREE.Color;
  ring: THREE.Sprite;
  ringMaterial: THREE.SpriteMaterial;
  label: HTMLDivElement;
  size: number;
}

interface OrbitalSceneEdge {
  eventId: string;
  entityId: string;
  curve: THREE.CubicBezierCurve3;
  material: THREE.LineBasicMaterial;
  pulse: THREE.Sprite;
  offset: number;
}

function makeLabel(text: string, kind: OrbitalGraphKind) {
  const element = document.createElement("div");
  element.className = "sag-orbital-label";
  element.dataset.kind = kind;
  element.dataset.visible = "false";
  element.textContent = text;
  element.title = text;
  return element;
}

type SurfacePoint = [number, number, number];

function surfacePointKey([x, y, z]: SurfacePoint) {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
}

function surfaceEdgeKey(first: SurfacePoint, second: SurfacePoint) {
  const firstKey = surfacePointKey(first);
  const secondKey = surfacePointKey(second);
  return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
}

/** 事件盘表面(对齐 buildEventPlateSurface): 球面三角剖分按事件方向归属 */
function buildEventPlateSurface(
  nodes: OrbitalNodeInput[],
  layout: { innerRadius: number; positions: Map<string, THREE.Vector3> },
) {
  const sourceGeometry = new THREE.IcosahedronGeometry(layout.innerRadius, 4);
  const surfaceGeometry = sourceGeometry.index
    ? sourceGeometry.toNonIndexed()
    : sourceGeometry.clone();
  sourceGeometry.dispose();
  const positions = surfaceGeometry.getAttribute("position");
  const events = nodes.filter((n) => n.kind === "event");
  const sites = events.map((event) => {
    const id = nodeId("event", event.id);
    const position = layout.positions.get(id) ?? new THREE.Vector3(0, 1, 0);
    return { id, position, direction: position.clone().normalize() };
  });
  if (sites.length === 0) {
    surfaceGeometry.dispose();
    return { geometries: new Map<string, THREE.BufferGeometry>(), boundaryGeometry: new THREE.BufferGeometry() };
  }
  const plateVertices = sites.map(() => [] as number[]);
  const edgeOwners = new Map<string, { owner: number; first: SurfacePoint; second: SurfacePoint }>();
  const boundaryVertices: number[] = [];
  const center = new THREE.Vector3();
  for (let vertexIndex = 0; vertexIndex < positions.count; vertexIndex += 3) {
    const triangle: [SurfacePoint, SurfacePoint, SurfacePoint] = [
      [positions.getX(vertexIndex), positions.getY(vertexIndex), positions.getZ(vertexIndex)],
      [positions.getX(vertexIndex + 1), positions.getY(vertexIndex + 1), positions.getZ(vertexIndex + 1)],
      [positions.getX(vertexIndex + 2), positions.getY(vertexIndex + 2), positions.getZ(vertexIndex + 2)],
    ];
    center
      .set(triangle[0][0] + triangle[1][0] + triangle[2][0], triangle[0][1] + triangle[1][1] + triangle[2][1], triangle[0][2] + triangle[1][2] + triangle[2][2])
      .normalize();
    let owner = 0;
    let bestMatch = -Infinity;
    sites.forEach((site, siteIndex) => {
      const match = center.dot(site.direction);
      if (match > bestMatch) { bestMatch = match; owner = siteIndex; }
    });
    const anchor = sites[owner].position;
    triangle.forEach(([x, y, z]) => plateVertices[owner].push(x - anchor.x, y - anchor.y, z - anchor.z));
    const edges: Array<[SurfacePoint, SurfacePoint]> = [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ];
    edges.forEach(([first, second]) => {
      const key = surfaceEdgeKey(first, second);
      const existing = edgeOwners.get(key);
      if (!existing) { edgeOwners.set(key, { owner, first, second }); return; }
      if (existing.owner === owner) return;
      [existing.first, existing.second].forEach(([x, y, z]) => {
        const scale = (layout.innerRadius + 1.15) / Math.hypot(x, y, z);
        boundaryVertices.push(x * scale, y * scale, z * scale);
      });
    });
  }
  surfaceGeometry.dispose();
  const geometries = new Map<string, THREE.BufferGeometry>();
  sites.forEach((site, index) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(plateVertices[index], 3));
    geometry.computeVertexNormals();
    geometries.set(site.id, geometry);
  });
  const boundaryGeometry = new THREE.BufferGeometry();
  boundaryGeometry.setAttribute("position", new THREE.Float32BufferAttribute(boundaryVertices, 3));
  return { geometries, boundaryGeometry };
}

export function OrbitalGraph3DView({ nodes, edges, height }: {
  nodes: OrbitalNodeInput[];
  edges: OrbitalEdgeInput[];
  height?: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [eventSurfaceMode, setEventSurfaceMode] = useState<"nodes" | "plates">("plates");
  const [expanded, setExpanded] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);

  // 数据内容签名: 父组件每次渲染传新数组引用, 用签名判断是否真变(防场景重建闪白)
  const layoutSignature = useMemo(() => {
    const nodeIds = nodes.map(n => `${n.kind}:${n.id}`).sort().join("|");
    const edgeIds = edges.map(e => `${e.fromId}>${e.toId}`).sort().join("|");
    return `${nodes.length}:${edges.length}:${nodeIds.length > 200 ? nodeIds.slice(0, 200) : nodeIds}:${edgeIds.length > 300 ? edgeIds.slice(0, 300) : edgeIds}`;
  }, [nodes, edges]);
  // layout 只在内容签名变化时重算(防父组件重渲染触发场景重建)
  const layout = useMemo(
    () => buildOrbitalLayout(nodes, edges),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutSignature],
  );
  const empty = nodes.length === 0;

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || empty) return;
    // 容器先设深色底, 防止 canvas 挂载前页面白底透出(闪白根源之一)
    mount.style.backgroundColor = "#070a12";
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      setRenderError("WebGL 不支持");
      return;
    }
    setRenderError("");
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070a12);
    scene.fog = new THREE.Fog(0x070a12, 1400, 4200);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.domElement.className = "absolute inset-0 size-full touch-none outline-none";
    renderer.domElement.tabIndex = 0;
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = "pointer-events-none absolute inset-0 z-[1] overflow-hidden";
    mount.replaceChildren(renderer.domElement, labelRenderer.domElement);
    const camera = new THREE.PerspectiveCamera(42, 1, 1, 2200);
    const baseHomePosition = new THREE.Vector3(0, 54, 1250);
    const homePosition = baseHomePosition.clone();
    camera.position.copy(homePosition);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.058;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.72;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.zoomSpeed = 0.72;
    controls.minDistance = 650;
    controls.maxDistance = 2800;
    // 自定义滚轮: Ctrl+滚轮缩放图谱, 普通滚轮让给页面滚动
    // OrbitControls 默认 wheel 会 preventDefault, 需要绕过
    const controlsDom = controls.domElement;
    if (controlsDom) {
      controlsDom.removeEventListener("wheel", (controls as unknown as {
        _onMouseWheel: (e: WheelEvent) => void;
      })._onMouseWheel as EventListener);
    }
    const onCtrlWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return; // 非 Ctrl 放行页面滚动
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY > 0 ? 1 : -1;
      const zoomFactor = Math.pow(0.95, Math.abs(delta));
      if (delta > 0) controls.dollyOut(zoomFactor);
      else controls.dollyIn(zoomFactor);
      controls.update();
    };
    renderer.domElement.addEventListener("wheel", onCtrlWheel, { passive: false });
    controls.target.set(0, 0, 0);
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 0.32;
    controls.update();

    addBackgroundPoints(scene);
    if (eventSurfaceMode === "nodes") addOrbitRings(scene, layout.innerRadius, "#ef8b9f", 0.18);
    addOrbitRings(scene, layout.outerRadius, "#6f8dff", 0.12);

    const degreeMap = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    edges.forEach((e) => {
      const ev = nodeId("event", e.fromId);
      const ent = nodeId("entity", e.toId);
      degreeMap.set(ev, (degreeMap.get(ev) ?? 0) + 1);
      degreeMap.set(ent, (degreeMap.get(ent) ?? 0) + 1);
      adjacency.set(ev, [...(adjacency.get(ev) ?? []), ent]);
      adjacency.set(ent, [...(adjacency.get(ent) ?? []), ev]);
    });

    const sceneNodes = new Map<string, OrbitalSceneNode>();
    const pickables: THREE.Object3D[] = [];
    const textures = new Map<string, THREE.Texture>();
    const ringTexture = makeRingTexture();
    const pulseTexture = makePulseTexture();
    textures.set("ring", ringTexture);
    textures.set("pulse", pulseTexture);
    const textureFor = (color: string) => {
      const existing = textures.get(color);
      if (existing) return existing;
      const texture = makeDiscTexture(color);
      textures.set(color, texture);
      return texture;
    };
    const eventColors = new Map(
      nodes.filter((n) => n.kind === "event").map((event, index) => [
        event.id,
        eventSurfaceMode === "plates" ? plateColor(event.id, index) : nodeColor("event", event.category || event.id),
      ]),
    );

    const registerDiscNode = ({ id, kind, labelText, color, size }: {
      id: string; kind: OrbitalGraphKind; labelText: string; color: string; size: number;
    }) => {
      const position = layout.positions.get(id);
      if (!position) return;
      const object = new THREE.Group();
      object.position.copy(position);
      const visualMaterial = new THREE.SpriteMaterial({
        map: textureFor(color), transparent: true, opacity: 1, alphaTest: 0.015, depthWrite: false,
      });
      const visual = new THREE.Sprite(visualMaterial);
      visual.scale.set(size, size, 1);
      visual.userData.nodeId = id;
      visual.renderOrder = 3;
      object.add(visual);
      pickables.push(visual);
      const ringMaterial = new THREE.SpriteMaterial({
        map: ringTexture, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Sprite(ringMaterial);
      ring.scale.set(size * 1.34, size * 1.34, 1);
      ring.renderOrder = 4;
      object.add(ring);
      const label = makeLabel(labelText, kind);
      const labelObject = new CSS2DObject(label);
      labelObject.position.set(0, size * 0.52, 0);
      object.add(labelObject);
      sceneNodes.set(id, {
        id, kind, object, position: position.clone(), visual, visualMaterial,
        visualKind: "disc", baseColor: new THREE.Color(color), ring, ringMaterial, label, size,
      });
      scene.add(object);
    };

    const registerPlateNode = ({ id, labelText, color, geometry }: {
      id: string; labelText: string; color: string; geometry: THREE.BufferGeometry;
    }) => {
      const position = layout.positions.get(id);
      if (!position) return;
      const object = new THREE.Group();
      object.position.copy(position);
      const baseColor = new THREE.Color(color);
      const visualMaterial = new THREE.MeshStandardMaterial({
        color: baseColor, emissive: baseColor.clone().multiplyScalar(0.22), emissiveIntensity: 0.55,
        flatShading: true, metalness: 0.08, roughness: 0.68,
      });
      const visual = new THREE.Mesh(geometry, visualMaterial);
      visual.userData.nodeId = id;
      visual.renderOrder = 2;
      object.add(visual);
      pickables.push(visual);
      const normal = position.clone().normalize();
      const size = 34;
      const ringMaterial = new THREE.SpriteMaterial({
        map: ringTexture, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Sprite(ringMaterial);
      ring.position.copy(normal.clone().multiplyScalar(5.5));
      ring.scale.set(size, size, 1);
      ring.renderOrder = 5;
      object.add(ring);
      const label = makeLabel(labelText, "event");
      const labelObject = new CSS2DObject(label);
      labelObject.position.copy(normal.multiplyScalar(13));
      object.add(labelObject);
      sceneNodes.set(id, {
        id, kind: "event", object, position: position.clone(), visual, visualMaterial,
        visualKind: "plate", baseColor, ring, ringMaterial, label, size,
      });
      scene.add(object);
    };

    if (eventSurfaceMode === "plates") {
      const hemisphereLight = new THREE.HemisphereLight(0xdde7ff, 0x160d24, 1.75);
      const keyLight = new THREE.DirectionalLight(0xffe7d6, 3.1);
      keyLight.position.set(-230, 280, 360);
      scene.add(hemisphereLight, keyLight);
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(layout.innerRadius - 2.4, 64, 40),
        new THREE.MeshStandardMaterial({ color: 0x15162a, emissive: 0x0d1023, emissiveIntensity: 0.8, metalness: 0.12, roughness: 0.78 }),
      );
      core.renderOrder = 1;
      scene.add(core);
      const atmosphere = new THREE.Mesh(
        new THREE.SphereGeometry(layout.innerRadius + 4.5, 48, 32),
        new THREE.MeshBasicMaterial({ color: 0xff8ba8, transparent: true, opacity: 0.045, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending }),
      );
      atmosphere.renderOrder = 3;
      scene.add(atmosphere);
      const plateSurface = buildEventPlateSurface(nodes, layout);
      nodes.filter((n) => n.kind === "event").forEach((event) => {
        const id = nodeId("event", event.id);
        const geometry = plateSurface.geometries.get(id);
        if (!geometry) return;
        registerPlateNode({ id, labelText: event.label, color: eventColors.get(event.id) ?? PLATE_COLORS[0], geometry });
      });
      const boundaries = new THREE.LineSegments(
        plateSurface.boundaryGeometry,
        new THREE.LineBasicMaterial({ color: 0x17111f, transparent: true, opacity: 0.92, depthWrite: false }),
      );
      boundaries.renderOrder = 4;
      scene.add(boundaries);
    } else {
      nodes.filter((n) => n.kind === "event").forEach((event) => {
        const id = nodeId("event", event.id);
        const degree = degreeMap.get(id) ?? 1;
        registerDiscNode({
          id, kind: "event", labelText: event.label,
          color: eventColors.get(event.id) ?? EVENT_COLORS[0],
          size: 42 + Math.min(21, Math.log2(degree + 1) * 6.5),
        });
      });
    }
    nodes.filter((n) => n.kind === "entity").forEach((entity) => {
      const id = nodeId("entity", entity.id);
      const degree = degreeMap.get(id) ?? 1;
      registerDiscNode({
        id, kind: "entity", labelText: entity.label,
        color: nodeColor("entity", entity.subtitle || entity.id),
        size: (42 + Math.min(21, Math.log2(degree + 1) * 6.5)) * ENTITY_SIZE_RATIO,
      });
    });

    const sharedPulseMaterial = new THREE.SpriteMaterial({
      map: pulseTexture, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sceneEdges: OrbitalSceneEdge[] = [];
    edges.forEach((relation, index) => {
      const eventId = nodeId("event", relation.fromId);
      const entityId = nodeId("entity", relation.toId);
      const start = layout.positions.get(eventId);
      const end = layout.positions.get(entityId);
      if (!start || !end) return;
      const curve = edgeCurve(start, end, relation.id);
      const points = curve.getPoints(edges.length > 1000 ? 10 : 26);
      const startColor = new THREE.Color(eventColors.get(relation.fromId) ?? nodeColor("event", relation.fromId));
      const endColor = new THREE.Color(nodeColor("entity", relation.toId));
      const colors = points.flatMap((_, pointIndex) => {
        const color = startColor.clone().lerp(endColor, pointIndex / Math.max(1, points.length - 1));
        return [color.r, color.g, color.b];
      });
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const material = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: BASE_EDGE_OPACITY, depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.renderOrder = 1;
      scene.add(line);
      const pulse = new THREE.Sprite(sharedPulseMaterial);
      pulse.scale.set(10, 10, 1);
      pulse.visible = false;
      pulse.renderOrder = 5;
      scene.add(pulse);
      sceneEdges.push({ eventId, entityId, curve, material, pulse, offset: (index * 0.61803398875) % 1 });
    });

    let hoveredId: string | null = null;
    let selectedId: string | null = null;
    let labelLimit = 10;
    const updateFocus = () => {
      const focusId = selectedId ?? hoveredId;
      const selectedNodes = new Set(selectedId ? [selectedId, ...(adjacency.get(selectedId) ?? [])] : []);
      const visibleLabels = new Set(
        focusId ? [focusId, ...(adjacency.get(focusId) ?? [])].slice(0, labelLimit) : [],
      );
      sceneNodes.forEach((node) => {
        const selectedNeighborhood = !selectedId || selectedNodes.has(node.id);
        const active = node.id === focusId;
        if (node.visualKind === "plate") {
          const material = node.visualMaterial as THREE.MeshStandardMaterial;
          const displayColor = node.baseColor.clone();
          if (!selectedNeighborhood) displayColor.multiplyScalar(0.18);
          if (active) displayColor.offsetHSL(0, 0, 0.08);
          material.color.copy(displayColor);
          material.emissive.copy(node.baseColor).multiplyScalar(active ? 0.38 : 0.2);
          material.emissiveIntensity = active ? 1.15 : selectedNeighborhood ? 0.55 : 0.08;
        } else {
          node.visualMaterial.opacity = selectedNeighborhood ? 1 : 0.13;
        }
        node.ringMaterial.opacity = active ? 0.98 : 0;
        const scale = active ? 1.18 : 1;
        if (node.visualKind === "disc") node.visual.scale.set(node.size * scale, node.size * scale, 1);
        const ringBaseScale = node.visualKind === "disc" ? node.size * 1.34 : node.size;
        node.ring.scale.set(ringBaseScale * scale, ringBaseScale * scale, 1);
        node.label.dataset.visible = visibleLabels.has(node.id) ? "true" : "false";
        node.label.dataset.active = active ? "true" : "false";
      });
      sceneEdges.forEach((edge) => {
        const connectedToFocus = Boolean(focusId) && (edge.eventId === focusId || edge.entityId === focusId);
        const connectedToSelection = Boolean(selectedId) && (edge.eventId === selectedId || edge.entityId === selectedId);
        if (selectedId) edge.material.opacity = connectedToSelection ? 0.78 : 0.012;
        else if (hoveredId) edge.material.opacity = connectedToFocus ? 0.68 : BASE_EDGE_OPACITY;
        else edge.material.opacity = BASE_EDGE_OPACITY;
        edge.pulse.visible = connectedToFocus;
      });
    };
    updateFocus();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const raycastNode = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickables, false)[0];
      return hit?.object.userData.nodeId as string | undefined;
    };
    const onPointerMove = (event: PointerEvent) => {
      const next = raycastNode(event) ?? null;
      if (next === hoveredId) return;
      hoveredId = next;
      renderer.domElement.style.cursor = next ? "pointer" : "grab";
      updateFocus();
    };
    const onPointerLeave = () => {
      hoveredId = null;
      renderer.domElement.style.cursor = "grab";
      updateFocus();
    };
    let pointerDown: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!pointerDown || Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) {
        pointerDown = null;
        return;
      }
      pointerDown = null;
      const id = raycastNode(event);
      if (!id) {
        selectedId = null;
        setSelectedLabel(null);
        updateFocus();
        return;
      }
      const node = sceneNodes.get(id);
      selectedId = id;
      setSelectedLabel(node?.label.textContent ?? id);
      updateFocus();
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      setRenderError("WebGL 上下文丢失");
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      const aspect = width / height;
      labelLimit = width < 700 ? 6 : 10;
      updateFocus();
      const previousHome = homePosition.clone();
      const portraitScale = aspect < 1 ? Math.min(2.2, 1 / aspect) : 1;
      homePosition.copy(baseHomePosition).multiplyScalar(portraitScale);
      if (camera.position.distanceTo(previousHome) < 2) camera.position.copy(homePosition);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      labelRenderer.setSize(width, height);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let frame = 0;
    let inViewport = true;
    let pageVisible = document.visibilityState !== "hidden";
    const render = (time: number) => {
      frame = 0;
      if (!inViewport || !pageVisible) return;
      sceneEdges.forEach((edge) => {
        if (!edge.pulse.visible) return;
        const progress = (time * 0.00023 + edge.offset) % 1;
        edge.pulse.position.copy(edge.curve.getPoint(progress));
      });
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
      frame = window.requestAnimationFrame(render);
    };
    const startRendering = () => {
      if (!frame && inViewport && pageVisible) frame = window.requestAnimationFrame(render);
    };
    const stopRendering = () => {
      if (!frame) return;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibilityChange = () => {
      pageVisible = document.visibilityState !== "hidden";
      if (pageVisible) startRendering();
      else stopRendering();
    };
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inViewport = entry?.isIntersecting ?? true;
      if (inViewport) startRendering();
      else stopRendering();
    });
    intersectionObserver.observe(mount);
    document.addEventListener("visibilitychange", onVisibilityChange);
    startRendering();

    return () => {
      if (mountRef.current) mountRef.current.style.backgroundColor = "";
      stopRendering();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("wheel", onCtrlWheel);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      controls.dispose();
      disposeScene(scene, textures.values());
      renderer.dispose();
      renderer.forceContextLoss();
      mount.replaceChildren();
    };
  }, [empty, eventSurfaceMode, layout, layoutSignature, autoRotate]);

  return (
    <div
      className={"sag-orbital-graph overflow-hidden rounded-md border border-white/10 bg-[#070a12] " + (expanded ? "fixed z-50 shadow-2xl" : height !== undefined ? "relative" : "relative h-full")}
      style={expanded
        ? { left: 16, right: 16, top: 70, bottom: 16, width: "calc(100vw - 32px)", height: "calc(100vh - 100px)" }
        : height !== undefined ? { height } : undefined}
    >
      <style>{`
        .sag-orbital-label {
          max-width: 190px; overflow: hidden; border: 1px solid rgba(255,255,255,0.22);
          border-radius: 6px; background: rgba(9,13,24,0.9); padding: 2px 6px;
          font-size: 10px; color: #d7def2; white-space: nowrap; text-overflow: ellipsis;
          pointer-events: none; transform: translate(-50%, -50%);
        }
        .sag-orbital-label[data-visible="false"] { display: none; }
        .sag-orbital-label[data-active="true"] { border-color: rgba(255,255,255,0.6); color: #fff; }
        .sag-orbital-label[data-kind="event"] { border-left: 2px solid #ff6b7f; }
        .sag-orbital-label[data-kind="entity"] { border-left: 2px solid #5577ff; }
      `}</style>

      <div className="absolute right-3 top-3 z-20 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setEventSurfaceMode(eventSurfaceMode === "plates" ? "nodes" : "plates")}
          className="grid h-8 w-8 place-items-center rounded-md border border-white/15 bg-[#0b1020]/90 text-white/65 shadow-lg backdrop-blur-md transition-colors hover:bg-white/10 hover:text-white"
          title={eventSurfaceMode === "plates" ? "节点模式" : "盘面模式"}
        >
          <Orbit className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setAutoRotate((v) => !v)}
          className={
            "grid h-8 w-8 place-items-center rounded-md border shadow-lg backdrop-blur-md transition-colors " +
            (autoRotate
              ? "border-blue-400/50 bg-blue-500/20 text-blue-300"
              : "border-white/15 bg-[#0b1020]/90 text-white/65 hover:bg-white/10 hover:text-white")
          }
          title="自动旋转"
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="grid h-8 w-8 place-items-center rounded-md border border-white/15 bg-[#0b1020]/90 text-white/65 shadow-lg backdrop-blur-md transition-colors hover:bg-white/10 hover:text-white"
          title={expanded ? "退出全屏" : "全屏"}
        >
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
      </div>

      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-white/10 bg-[#0b1020]/80 px-2.5 py-1.5 text-[10px] text-white/60 shadow-lg backdrop-blur-md">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: "#ff6b7f" }} /> 事件 {nodes.filter((n) => n.kind === "event").length}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: "#5577ff" }} /> 实体 {nodes.filter((n) => n.kind === "entity").length}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded" style={{ background: "rgba(139,119,255,0.6)" }} /> 关系 {edges.length}
          </span>
        </div>
      </div>

      {selectedLabel && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-white/10 bg-[#0b1020]/80 px-2 py-1 text-[10px] text-white/70 shadow-lg backdrop-blur-md">
          已选: {selectedLabel}
        </div>
      )}

      {renderError ? (
        <div className="absolute inset-0 grid place-items-center text-xs text-red-400">{renderError}</div>
      ) : empty ? (
        <div className="absolute inset-0 grid place-items-center text-xs text-white/40">无图谱数据</div>
      ) : null}

      <div ref={mountRef} className="absolute inset-0" />
    </div>
  );
}
