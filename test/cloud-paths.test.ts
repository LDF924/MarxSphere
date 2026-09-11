// cloud-paths.test.ts — 上云审计(2026-09-11)新模块的回归测试
//
// 覆盖: 对象存储抽象(key 归一化 / SigV4 签名 / 配置不全不静默退回)、
//      知识库与 P2O 路径解析(未配置时回退数据根, 而不是硬编码盘符)、
//      自我请求基址(未配置时跟监听地址走, 而不是写死环回口)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signS3Request, normalizeKey, buildBlobDriver, resetBlobDriver } from "../src/services/blob-store.js";
import { vaultRoot, literatureDir, policyDir, ovImportDir, neo4jBoltUrl, neo4jHost } from "../src/services/kb-paths.js";
import { selfBaseUrl, configuredSelfBase } from "../src/services/base-urls.js";
import { edgePath, edgePathHint } from "../src/services/browser-path.js";
import { config } from "../src/config/env.js";

/** 保存/恢复一组环境变量, 避免测试间互相污染 */
function envScope(keys: string[]) {
  const saved = new Map<string, string | undefined>();
  return {
    snapshot() { for (const k of keys) saved.set(k, process.env[k]); },
    restore() {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    },
  };
}

describe("blob-store: key 归一化", () => {
  it("历史 data/ 前缀与无前缀解析为同一对象", () => {
    expect(normalizeKey("data/viz-files/u1/x.png")).toBe("viz-files/u1/x.png");
    expect(normalizeKey("viz-files/u1/x.png")).toBe("viz-files/u1/x.png");
    expect(normalizeKey("/viz-files/u1/x.png")).toBe("viz-files/u1/x.png");
    expect(normalizeKey("data\\viz-files\\u1\\x.png")).toBe("viz-files/u1/x.png");
  });

  it("拒绝路径上跳", () => {
    expect(() => normalizeKey("../../etc/passwd")).toThrow(/非法对象 key/);
    expect(() => normalizeKey("viz-files/../../secret")).toThrow(/非法对象 key/);
  });

  it("空 key 得到空串(调用方按未找到处理)", () => {
    expect(normalizeKey("")).toBe("");
    expect(normalizeKey(undefined as unknown as string)).toBe("");
  });
});

describe("blob-store: SigV4 签名", () => {
  it("与 AWS 官方测试向量一致", () => {
    // AWS 文档 "Signature Version 4 完整签名过程示例": GET /test.txt + Range 头
    const emptyHash = createHash("sha256").update("").digest("hex");
    const signed = signS3Request({
      method: "GET",
      canonicalUri: "/test.txt",
      canonicalQuery: "",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: emptyHash,
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(signed.authorization).toContain(
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
    // 头部必须按字典序参与签名(range 在 x-amz-* 之前)
    expect(signed.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
  });
});

describe("blob-store: 驱动选择", () => {
  const scope = envScope(["BLOB_DRIVER", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DATA_DIR"]);
  beforeEach(() => { scope.snapshot(); resetBlobDriver(); });
  afterEach(() => { scope.restore(); resetBlobDriver(); });

  it("默认 local 驱动, 且在数据根下落盘", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blob-test-"));
    delete process.env.BLOB_DRIVER;
    process.env.DATA_DIR = tmp;
    resetBlobDriver();
    const d = buildBlobDriver();
    expect(d.name).toBe("local");
    await d.put("user-files/u1/a.bin", Buffer.from("内容"));
    expect(fs.existsSync(path.join(tmp, "user-files", "u1", "a.bin"))).toBe(true);
    expect((await d.get("data/user-files/u1/a.bin"))?.toString("utf-8")).toBe("内容");
    expect(await d.get("不存在")).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("s3 配置不全必须抛错, 不静默退回本地盘", () => {
    process.env.BLOB_DRIVER = "s3";
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    expect(() => buildBlobDriver()).toThrow(/缺少配置/);
  });

  it("未知驱动名报错", () => {
    process.env.BLOB_DRIVER = "oss";
    expect(() => buildBlobDriver()).toThrow(/未知的 BLOB_DRIVER/);
  });
});

describe("kb-paths: 知识库与 P2O 路径", () => {
  const scope = envScope(["VAULT_ROOT", "LITERATURE_DIR", "POLICY_DIR", "P2O_VAULT_PATH", "DATA_DIR"]);
  beforeEach(() => scope.snapshot());
  afterEach(() => scope.restore());

  it("未配置时回退到数据根(不再是 ~/1.Obsidian Vault 与 D:/Desktop)", () => {
    delete process.env.VAULT_ROOT;
    delete process.env.LITERATURE_DIR;
    delete process.env.POLICY_DIR;
    delete process.env.P2O_VAULT_PATH;
    process.env.DATA_DIR = path.join("X:", "shared-data");
    expect(vaultRoot()).toBe(path.join("X:", "shared-data", "kb", "vault"));
    expect(literatureDir()).toBe(path.join("X:", "shared-data", "kb", "journal"));
    expect(policyDir()).toBe(path.join("X:", "shared-data", "kb", "policy"));
    expect(ovImportDir()).toBe(path.join("X:", "shared-data", "kb", "ov_import"));
  });

  it("显式配置优先", () => {
    process.env.VAULT_ROOT = "/mnt/kb/vault";
    process.env.LITERATURE_DIR = "/mnt/kb/lit";
    process.env.POLICY_DIR = "/mnt/kb/pol";
    process.env.P2O_VAULT_PATH = "/mnt/kb/ov";
    expect(vaultRoot()).toBe("/mnt/kb/vault");
    expect(literatureDir()).toBe("/mnt/kb/lit");
    expect(policyDir()).toBe("/mnt/kb/pol");
    expect(ovImportDir()).toBe("/mnt/kb/ov");
  });

  it("每次调用时解析(改环境变量立即生效, 便于测试隔离)", () => {
    process.env.DATA_DIR = path.join("X:", "a");
    process.env.VAULT_ROOT = "/one";
    expect(vaultRoot()).toBe("/one");
    process.env.VAULT_ROOT = "/two";
    expect(vaultRoot()).toBe("/two");
  });
});

describe("kb-paths: Neo4j 主机", () => {
  const scope = envScope(["NEO4J_HOST"]);
  beforeEach(() => scope.snapshot());
  afterEach(() => scope.restore());

  it("默认本机, 可用 NEO4J_HOST 指向独立图库服务", () => {
    delete process.env.NEO4J_HOST;
    expect(neo4jHost()).toBe("127.0.0.1");
    expect(neo4jBoltUrl(11001)).toBe("bolt://127.0.0.1:11001");
    process.env.NEO4J_HOST = "graphiti.internal";
    expect(neo4jBoltUrl(11001)).toBe("bolt://graphiti.internal:11001");
    expect(neo4jBoltUrl(11003)).toBe("bolt://graphiti.internal:11003");
  });
});

describe("base-urls: 自我请求基址", () => {
  const scope = envScope(["AGENT_API_BASE", "SAG_INTERNAL_URL", "SELF_BASE"]);
  // 监听地址从 config 读(与 Fastify 实际绑定的同一个对象) —— 测试改 config, 不是 process.env。
  // 这正是不分叉的保证: 自我请求打哪, 由"服务实际监听在哪"决定。
  const savedHost = config.HTTP_HOST;
  const savedPort = config.HTTP_PORT;
  beforeEach(() => { scope.snapshot(); });
  afterEach(() => {
    scope.restore();
    config.HTTP_HOST = savedHost;
    config.HTTP_PORT = savedPort;
  });

  it("未配置时跟监听地址走(0.0.0.0 视为环回), 而不是写死环回口", () => {
    delete process.env.AGENT_API_BASE;
    delete process.env.SAG_INTERNAL_URL;
    delete process.env.SELF_BASE;
    expect(configuredSelfBase()).toBeNull();
    config.HTTP_HOST = "0.0.0.0";
    config.HTTP_PORT = 4173;
    expect(selfBaseUrl()).toBe("http://127.0.0.1:4173");
    config.HTTP_HOST = "10.0.0.12";
    expect(selfBaseUrl()).toBe("http://10.0.0.12:4173");
  });

  it("IPv6 字面量加方括号", () => {
    delete process.env.AGENT_API_BASE;
    delete process.env.SAG_INTERNAL_URL;
    delete process.env.SELF_BASE;
    config.HTTP_HOST = "::1";
    config.HTTP_PORT = 4173;
    expect(selfBaseUrl()).toBe("http://[::1]:4173");
  });

  it("显式配置优先, 三个既有变量名都认(兼容现存 .env)", () => {
    config.HTTP_HOST = "0.0.0.0";
    config.HTTP_PORT = 4173;
    process.env.SELF_BASE = "http://sag-api:4173/";
    expect(selfBaseUrl()).toBe("http://sag-api:4173");
    process.env.SAG_INTERNAL_URL = "http://svc:9000";
    expect(selfBaseUrl()).toBe("http://svc:9000");
    process.env.AGENT_API_BASE = "http://edge:7000";
    expect(selfBaseUrl()).toBe("http://edge:7000");
  });
});

describe("browser-path: 无头浏览器定位", () => {
  const scope = envScope(["AGENT_EDGE_PATH"]);
  beforeEach(() => scope.snapshot());
  afterEach(() => scope.restore());

  it("显式配置指向存在的文件时采用", () => {
    // 拿一个必然存在的可执行文件当靶子(Windows 下用 node 自身路径也行, 这里用当前进程的可执行)
    process.env.AGENT_EDGE_PATH = process.execPath;
    expect(edgePath()).toBe(process.execPath);
  });

  it("显式配置指向不存在的文件返回 null(而不是把坏路径交给 execFile)", () => {
    process.env.AGENT_EDGE_PATH = process.platform === "win32"
      ? "C:/definitely/not/here/msedge.exe"
      : "/definitely/not/here/chromium";
    expect(edgePath()).toBeNull();
  });

  it("未配置时按平台探测; 找不到返回 null 并给出可读提示", () => {
    delete process.env.AGENT_EDGE_PATH;
    const p = edgePath();
    // 本机装了浏览器就返回路径, 没装返回 null —— 两种都合法, 但不能抛错
    if (p !== null) expect(typeof p).toBe("string");
    expect(edgePathHint()).toContain("AGENT_EDGE_PATH");
    expect(edgePathHint()).toContain(process.platform);
  });

  it("候选里不再出现写死的 Windows 用户目录", () => {
    delete process.env.AGENT_EDGE_PATH;
    expect(edgePathHint()).not.toMatch(/C:\/Users\//);
  });
});
