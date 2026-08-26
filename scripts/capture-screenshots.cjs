// capture-screenshots.cjs — 用 Electron 截取 MarxSphere 主要界面
// 用法: electron capture-screenshots.cjs <输出目录>
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT_DIR = process.argv[2] || "screenshots";
const BASE = "http://localhost:4173";
const VIEWS = [
  { file: "sag-home.png", hash: "", wait: 6000, width: 1600, height: 1000 },
  { file: "sag-chat.png", hash: "#chat", wait: 4000, width: 1600, height: 1000 },
  { file: "sag-reason.png", hash: "#reason", wait: 4000, width: 1600, height: 1000 },
  { file: "sag-ask.png", hash: "#ask", wait: 4000, width: 1600, height: 1000 },
  { file: "sag-literature.png", hash: "#literature", wait: 4000, width: 1600, height: 1000 },
  { file: "sag-graph.png", hash: "#graph", wait: 4000, width: 1600, height: 1000 },
  { file: "sag-scenarios.png", hash: "#scenarios", wait: 4000, width: 1600, height: 1000 },
  { file: "sag-agent.png", hash: "#agent-console", wait: 4000, width: 1600, height: 1000 },
  { file: "sag-eval.png", hash: "#eval", wait: 4000, width: 1600, height: 1000 },
  { file: "sag-empirical.png", hash: "#empirical-research", wait: 4000, width: 1600, height: 1000 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

app.whenReady().then(async () => {
  for (const v of VIEWS) {
    const win = new BrowserWindow({
      width: v.width,
      height: v.height,
      show: false,
      webPreferences: { offscreen: true },
    });
    try {
      // 串行加载: 每个窗口单独等 did-finish-load, 失败重试一次
      let loaded = false;
      for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
        try {
          await win.loadURL(BASE, {});
          await new Promise((r) => win.webContents.once("did-finish-load", r));
          loaded = true;
        } catch { /* 重试 */ }
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (v.hash) {
        await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(v.hash)}`);
        await new Promise((r) => setTimeout(r, v.wait));
      } else {
        await new Promise((r) => setTimeout(r, v.wait));
      }
      const img = await win.webContents.capturePage();
      const p = path.join(OUT_DIR, v.file);
      fs.writeFileSync(p, img.toPNG());
      console.log("✓", v.file, img.getSize());
    } catch (e) {
      console.log("✗", v.file, e.message);
    }
    win.destroy();
  }
  app.quit();
});
