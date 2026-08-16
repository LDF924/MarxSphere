// print-pdf.cjs — 用 Electron 将 HTML 打印为 PDF
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const HTML_PATH = process.argv[2];
const PDF_PATH = process.argv[3];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 1200 });
  await win.loadFile(HTML_PATH);
  // 等渲染完成
  await new Promise((r) => setTimeout(r, 500));
  const pdf = await win.webContents.printToPDF({
    pageSize: "A4",
    printBackground: true,
    margin: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
  });
  fs.writeFileSync(PDF_PATH, pdf);
  console.log("PDF 已生成:", PDF_PATH, pdf.length, "bytes");
  app.quit();
});
