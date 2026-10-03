// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// word-extractor.d.ts — 本地类型声明(上游没有 @types/word-extractor)
//
// 只声明我们用到的部分: 默认导出是构造器, 实例的 extract(路径) 返回一个
// 带 getBody/getHeaders/getFootnotes/getAnnotations 的文档对象(各自返回字符串)。
// 上游 README 里那些 stream/回调形态我们没用到, 不在这里凭空补 —— 声明文件写宽了
// 会让"其实调错了"在编译期看不出来。
declare module "word-extractor" {
  class Document {
    getBody(): string;
    getFootnotes(): string;
    getHeaders(): string;
    getAnnotations(): string;
    getTextboxes(): string;
  }
  export default class WordExtractor {
    extract(source: string): Promise<Document>;
  }
}
