// wecom-service.test.ts — 企业微信加解密/签名/回调解析单元测试
// 验证: AES-256-CBC 信封(腾讯 32 字节块 PKCS7)加解密往返 / sha1 签名 / URL 验证解 echostr
import { describe, it, expect } from "vitest";
import {
  wecomDecrypt, wecomEncryptReply, wecomSignature, wecomVerifySignature,
  parseWeComCallback, extractXmlCdata, extractXmlText,
} from "../src/services/wecom-service.js";

// 测试用示例值(非真实凭据): AES_KEY 为 43 字符 base64(解码 32 字节)占位
const AES_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "test-token-placeholder";
const CORP_ID = "corp-id-placeholder-not-real";

// 构造与腾讯 URL 验证一致的已知报文做往返(用 encrypt 再解密, 验证信封结构正确)
describe("wecom crypto round-trip", () => {
  it("encrypt → decrypt 往返: 明文含 receiver_id 校验通过", () => {
    const nonce = "1234567890";
    const replyXml = "<xml><ToUserName><![CDATA[toUser]]></ToUserName><FromUserName><![CDATA[fromUser]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content></xml>";
    const envelope = wecomEncryptReply(AES_KEY, TOKEN, CORP_ID, replyXml, nonce);
    // 信封含 Encrypt/MsgSignature(CDATA)/TimeStamp(纯文本)/Nonce(CDATA)
    const encrypt = extractXmlCdata(envelope, "Encrypt");
    const sig = extractXmlCdata(envelope, "MsgSignature");
    expect(encrypt.length).toBeGreaterThan(0);
    expect(sig).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
    // 解密还原
    const decrypted = wecomDecrypt(AES_KEY, encrypt, CORP_ID);
    expect(decrypted).toBe(replyXml);
  });

  it("receiver_id 不匹配 → 解密报错(防串号)", () => {
    const nonce = "abc";
    const envelope = wecomEncryptReply(AES_KEY, TOKEN, CORP_ID, "<xml>hi</xml>", nonce);
    const encrypt = extractXmlCdata(envelope, "Encrypt");
    expect(() => wecomDecrypt(AES_KEY, encrypt, "WRONG_CORP_ID")).toThrow(/receiver/);
  });

  it("signature: 计算与校验一致; 篡改 → 校验失败", () => {
    const ts = "1409659813", nonce = "1372623149", encrypt = "abc123";
    const sig = wecomSignature(TOKEN, ts, nonce, encrypt);
    expect(sig).toMatch(/^[0-9a-f]{40}$/); // sha1 hex 40 位
    expect(wecomVerifySignature(TOKEN, ts, nonce, encrypt, sig)).toBe(true);
    expect(wecomVerifySignature(TOKEN, ts, nonce, encrypt, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(false);
    expect(wecomVerifySignature(TOKEN, ts, nonce, encrypt + "x", sig)).toBe(false);
  });

  it("parseWeComCallback: text 消息解析; 事件(非 text)返回 null", () => {
    const xml = "<xml><ToUserName><![CDATA[to]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[状态]]></Content><MsgId>123</MsgId></xml>";
    const msg = parseWeComCallback(xml);
    expect(msg).not.toBeNull();
    expect(msg!.platform).toBe("wecom");
    expect(msg!.text).toBe("状态");
    expect(msg!.from).toBe("zhangsan");
    // 事件消息 → null
    const evt = "<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>";
    expect(parseWeComCallback(evt)).toBeNull();
  });

  it("extractXmlCdata/Text 提取正确", () => {
    const xml = "<xml><Encrypt><![CDATA[AAA]]></Encrypt><TimeStamp>123</TimeStamp></xml>";
    expect(extractXmlCdata(xml, "Encrypt")).toBe("AAA");
    expect(extractXmlText(xml, "TimeStamp")).toBe("123");
  });
});
