// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// UniverseBackground.tsx — 动态宇宙背景（2026-08-07）
// Canvas 星场：~140 颗星（大小/亮度/漂移速度随机）+ 3 团星云光斑 + 鼠标视差
// 性能：rAF 循环 + DPR 适配 + reduced-motion 静态帧 + 不可见时暂停
// 层级：cosmos-bg 渐变之上、graph-watermark 之下
import { useEffect, useRef, type FC } from "react";

const STAR_COUNT = 260;
const NEBULA_COUNT = 3;

interface Star {
  x: number; y: number; r: number;
  alpha: number; twinkleSpeed: number; twinklePhase: number;
  driftX: number; driftY: number;
}

interface Nebula {
  x: number; y: number; radius: number;
  hue: number; alpha: number;
}

export const UniverseBackground: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const RM = typeof matchMedia !== "undefined"
      && matchMedia("(prefers-reduced-motion: reduce)").matches;

    let stars: Star[] = [];
    let nebulas: Nebula[] = [];
    let raf = 0;
    let width = 0;
    let height = 0;
    let running = true;
    let mouseX = 0.5;
    let mouseY = 0.5;
    let t0 = performance.now();

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      spawnStars();
      spawnNebulas();
    };

    const spawnStars = () => {
      stars = [];
      for (let i = 0; i < STAR_COUNT; i++) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: 0.6 + Math.random() * 2.2,
          alpha: 0.6 + Math.random() * 0.4,
          twinkleSpeed: 0.4 + Math.random() * 1.6,
          twinklePhase: Math.random() * Math.PI * 2,
          driftX: (Math.random() - 0.5) * 0.02,
          driftY: (Math.random() - 0.5) * 0.02,
        });
      }
    };

    const spawnNebulas = () => {
      nebulas = [
        { x: width * 0.15, y: height * 0.2, radius: Math.max(width, height) * 0.32, hue: 214, alpha: 0.035 },
        { x: width * 0.85, y: height * 0.8, radius: Math.max(width, height) * 0.28, hue: 255, alpha: 0.03 },
        { x: width * 0.6, y: height * 0.35, radius: Math.max(width, height) * 0.22, hue: 200, alpha: 0.025 },
      ];
    };

    const draw = (now: number) => {
      const elapsed = (now - t0) / 1000;
      ctx.clearRect(0, 0, width, height);

      // 星云光斑（径向渐变，慢速呼吸）
      for (const neb of nebulas) {
        const breath = 1 + Math.sin(elapsed * 0.15 + neb.hue) * 0.12;
        const grd = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.radius * breath);
        grd.addColorStop(0, `hsla(${neb.hue} 60% 40% / ${neb.alpha})`);
        grd.addColorStop(1, "hsla(222 47% 5% / 0)");
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, width, height);
      }

      // 星星（漂移 + 闪烁 + 鼠标视差；核心实心 + 外圈淡光晕，保证可见度）
      const parX = (mouseX - 0.5) * 14;
      const parY = (mouseY - 0.5) * 14;
      for (const s of stars) {
        const x = s.x + elapsed * s.driftX * 8 + parX * (s.r / 1.8);
        const y = s.y + elapsed * s.driftY * 8 + parY * (s.r / 1.8);
        const tw = 0.75 + 0.25 * Math.sin(elapsed * s.twinkleSpeed + s.twinklePhase);
        const a = s.alpha * tw;
        // 外圈光晕（更明显）
        ctx.globalAlpha = a * 0.35;
        ctx.fillStyle = "hsl(210 50% 92%)";
        ctx.beginPath();
        ctx.arc(x, y, s.r * 3.2, 0, Math.PI * 2);
        ctx.fill();
        // 中圈
        ctx.globalAlpha = a * 0.8;
        ctx.fillStyle = "hsl(210 40% 97%)";
        ctx.beginPath();
        ctx.arc(x, y, s.r * 1.6, 0, Math.PI * 2);
        ctx.fill();
        // 核心（纯白）
        ctx.globalAlpha = a;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 偶发流星（概率低）
      if (Math.random() < 0.003 && !RM) {
        const mx = Math.random() * width;
        const my = Math.random() * height * 0.4;
        const len = 80 + Math.random() * 60;
        ctx.strokeStyle = "hsla(43 96% 80% / 0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(mx - len, my + len * 0.35);
        ctx.stroke();
      }
    };

    const loop = (now: number) => {
      if (!running) return;
      draw(now);
      raf = requestAnimationFrame(loop);
    };

    const onMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX / window.innerWidth;
      mouseY = e.clientY / window.innerHeight;
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!RM) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    };

    resize();
    if (RM) {
      draw(performance.now()); // 静态帧
    } else {
      raf = requestAnimationFrame(loop);
    }
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="universe-canvas"
    />
  );
};
