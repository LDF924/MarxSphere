// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * literature-browser-sources.ts — 文献源的"浏览器代抓"注册表
 *
 * ## 为什么要走浏览器
 *
 * 中文三大库(知网/万方/维普)**都没有对外开放的检索 API**。实测:
 *   · 万方 `s.wanfangdata.com.cn/paper?q=…` 返回的是 **SPA 空壳**(168KB, 里面连
 *     「参考文献」「摘要」「作者」三个词都搜不到) —— 不渲染就是个空页;
 *   · 维普同样是渲染后才出结果。
 * 所以唯一可行的路子是**驱动用户自己已登录的浏览器**去查。
 *
 * ## 为什么是"用户自己的浏览器"
 *
 * 2026-09-19 与用户确认的产品前提: **平台不保存知网/万方/维普的账号密码**。
 *   这三家的机构访问走的是用户浏览器里的登录态(知网的 `Ecp_LoginStuts` cookie、
 *   万方 CARSI 会话等)。所以本模块做的是"**借你已登录的身份去查**",
 *   不是"平台拿密码替你登"。这是安全与合规的硬边界。
 *
 * ## 登录态怎么来(实测路径)
 *
 * 用户所在机构的 CARSI/Shibboleth 联邦入口 `https://idp.nnnu.edu.cn/idp/` 列出了订阅资源,
 * 点进去各家的联邦入口即可(知网 `fsso.cnki.net` / 万方 `fsso.wanfangdata.com.cn` /
 * 维普 `qikan.cqvip.com`)。**登录由用户自己完成** —— 学校的统一认证页我们既不代填也不代持。
 *
 * ⚠ 该校 IdP 证书曾经过期(`CN=*.nnnu.edu.cn`, verify error num=10), 浏览器会直接拒绝加载;
 *   那不是我们这层的问题, 只提示用户。
 */

export type LitSourceId = "cnki" | "wanfang" | "cqvip";

export interface LitSourceDef {
  id: LitSourceId;
  name: string;
  /** 机构联邦入口(用户已登录时可直接进检索) */
  fssoEntry: string;
  /** 检索页 URL 模板; `{q}` 会被替换成 encodeURIComponent(query) */
  searchUrlTemplate: string;
  /** 在该源的页面里判断"当前是谁的登录态"用的表达式(返回字符串) */
  identityExpr: string;
  /** 结果卡容器选择器(实测得来, 不是猜的) */
  resultSelector: string;
}

export const LIT_BROWSER_SOURCES: readonly LitSourceDef[] = [
  {
    id: "cnki",
    name: "中国知网",
    fssoEntry: "https://fsso.cnki.net",
    searchUrlTemplate: "https://kns.cnki.net/kns8s/defaultresult/index?korder=SU&kw={q}",
    // 知网把登录态写在 Ecp_LoginStuts: {UserName, ShowName, UserType}, bk=机构包库
    identityExpr: `(() => { const m = document.cookie.match(/Ecp_LoginStuts=([^;]+)/); return m ? decodeURIComponent(m[1]) : ""; })()`,
    resultSelector: ".result-table-list tbody tr"
  },
  {
    id: "wanfang",
    name: "万方数据",
    fssoEntry: "https://fsso.wanfangdata.com.cn",
    searchUrlTemplate: "https://s.wanfangdata.com.cn/paper?q={q}",
    // 万方的登录态不在 cookie 里(实测 cookie 只有 behavior_session_id) ——
    //   机构身份体现在**页头文本**(「南宁师范大学」/「登录 / 注册」并存, 前者非空即机构态)
    identityExpr: `(() => {
      const t = document.body.innerText;
      const loggedOut = t.includes("登录 / 注册");
      const m = t.match(/切换个人版[\\s\\S]{0,40}?([\\u4e00-\\u9fa5]{2,20}(?:大学|学院|研究院|图书馆|医院|公司|集团))/);
      return JSON.stringify({ showName: m ? m[1] : "", loggedOut });
    })()`,
    resultSelector: ".normal-list"
  },
  {
    id: "cqvip",
    name: "维普期刊",
    fssoEntry: "http://qikan.cqvip.com/index.html",
    searchUrlTemplate: "https://qikan.cqvip.com/Qikan/Search/Index?key=K%3D{q}",
    identityExpr: `(() => {
      const t = document.body.innerText;
      const m = t.match(/欢迎\\s*([\\u4e00-\\u9fa5]{2,20}(?:大学|学院|研究院|图书馆|医院|公司|集团))/);
      return JSON.stringify({ showName: m ? m[1] : "", loggedOut: t.includes("登录") && !m });
    })()`,
    resultSelector: ".search-result-list"
  }
];

export function litSourceById(id: string): LitSourceDef | undefined {
  return LIT_BROWSER_SOURCES.find((s) => s.id === id);
}

/** 按源构造检索 URL */
export function litSearchUrl(id: LitSourceId, query: string): string {
  const def = litSourceById(id);
  if (!def) return "";
  // 模板串里 `{q}` 只在 query 位置出现, 用 replace 而不是 split/join 之外的路径
  return def.searchUrlTemplate.replace("{q}", encodeURIComponent(query));
}

/** 该源对应的 tab 匹配(用于在用户已开的标签里找准页面) */
export function litTabMatcher(id: LitSourceId): (t: { url: string; title: string }) => boolean {
  switch (id) {
    case "cnki":
      return (t) => /kns\.cnki\.net|cnki\.net/.test(t.url);
    case "wanfang":
      return (t) => /wanfangdata\.com\.cn/.test(t.url);
    case "cqvip":
      return (t) => /cqvip\.com/.test(t.url);
  }
}
