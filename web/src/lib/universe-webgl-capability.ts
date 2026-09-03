// universe-webgl-capability.ts — WebGL2 能力探测与上下文失败分类(对齐 Zleap universe-webgl-capability.ts)
// 语义: 探测不做 canvas.getContext()(探测上下文会消耗浏览器 GPU 上下文池,
// 把临时压力误报为"不支持");失败分类区分禁用显卡与临时创建压力。
// 来源: Zleap-AI/SAG apps/web/lib/universe-webgl-capability.ts(完整移植)。
export type UniverseWebGLCapability = "available" | "api-unavailable";
export type UniverseWebGLContextFailure =
  | "context-disabled"
  | "context-creation";

interface UniverseWebGLScope {
  WebGL2RenderingContext?: unknown;
}

/**
 * Three r185 requires WebGL2. This check deliberately does not call
 * canvas.getContext(): a probe context consumes the same small browser GPU
 * context pool as the real scene and can turn temporary pressure into a false
 * "unsupported" result.
 */
export function detectUniverseWebGLCapability(
  scope: UniverseWebGLScope | null | undefined,
): UniverseWebGLCapability {
  return typeof scope?.WebGL2RenderingContext === "function"
    ? "available"
    : "api-unavailable";
}

function universeErrorMessages(reason: unknown) {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = reason;

  for (let depth = 0; depth < 4 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }
    if (typeof current === "string") messages.push(current);
    break;
  }

  return messages.join("\n").toLowerCase();
}

/**
 * Distinguishes a browser-level WebGL failure from scene code errors and keeps
 * an explicitly disabled GPU separate from temporary context pressure.
 */
export function classifyUniverseWebGLContextFailure(
  reason: unknown,
): UniverseWebGLContextFailure | null {
  const message = universeErrorMessages(reason);
  if (!message.includes("webgl") || !message.includes("context")) return null;
  const isContextFailure = (
    message.includes("webglcontextcreationerror")
    || /(?:creat|allocat|initializ|obtain).{0,100}webgl(?:2)?\s+context/.test(message)
    || /webgl(?:2)?\s+context.{0,100}(?:creat|allocat|initializ|unavailable|fail)/.test(message)
  );
  if (!isContextFailure) return null;
  if (
    message.includes("gl_vendor = disabled")
    || message.includes("gl_renderer = disabled")
    || message.includes("webgl is disabled")
    || message.includes("--disable-webgl")
  ) return "context-disabled";
  return "context-creation";
}

/** Backwards-compatible predicate for callers that only need a boolean. */
export function isUniverseWebGLContextCreationError(reason: unknown) {
  return classifyUniverseWebGLContextFailure(reason) !== null;
}
