const DEFAULT_SESSION_TITLE = "新对话";
const MAX_CHINESE_TITLE_LENGTH = 18;
const MAX_ENGLISH_TITLE_WORDS = 8;

export function defaultMcpSessionTitle(): string {
  return DEFAULT_SESSION_TITLE;
}

export function summarizeConversationTitle(content: string): string {
  const normalized = normalizeTitleInput(content);
  if (!normalized) {
    return DEFAULT_SESSION_TITLE;
  }

  if (isMostlyChinese(normalized)) {
    const compact = normalized
      .replace(/\s+/g, "")
      .replace(/[？?。.!！,，；;：:]+$/g, "");
    return compact.slice(0, MAX_CHINESE_TITLE_LENGTH) || DEFAULT_SESSION_TITLE;
  }

  const words = normalized
    .replace(/[?.!,;:]+$/g, "")
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, MAX_ENGLISH_TITLE_WORDS).join(" ") || DEFAULT_SESSION_TITLE;
}

function normalizeTitleInput(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#>*_\-[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(请问|请帮我|帮我|帮忙|我想知道|我想问|能不能|可以帮我|你能不能|麻烦你|请你|请)(一下|下)?[，,。:：\s]*/u, "")
    .replace(/^(please\s+)?(could you|can you|would you|help me|tell me)\s+/i, "")
    .replace(/^(please\s+)?(explain|summarize|analyze)\s+/i, "")
    .trim();
}

function isMostlyChinese(content: string): boolean {
  const chineseCount = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  if (chineseCount < 2) {
    return false;
  }
  return chineseCount / Math.max(content.length, 1) >= 0.25;
}
