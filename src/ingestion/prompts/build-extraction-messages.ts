// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// build-extraction-messages.ts — 文档事件抽取的 messages 组装
// 从 llm-client.ts 原 buildBenchmarkExtractionMessages 逐字迁移(行为不变)
import { extractDocumentContract, renderExtractionSystemPrompt } from "./extract-document.js";

export interface ExtractionRequestInput {
  title: string;
  heading?: string;
  content: string;
  references: string[];
}

export interface ExtractionChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildExtractionMessages(input: ExtractionRequestInput): ExtractionChatMessage[] {
  const userInput = {
    type: "request",
    data: {
      items: [{
        id: 1,
        content: [
          input.heading ? `# ${input.heading}` : "",
          input.content
        ].filter(Boolean).join("\n\n")
      }],
      meta: {
        source_type: "article",
        source_title: input.title,
        source_summary: "",
        previous_context: "",
        related_events: [],
        entity_types: extractDocumentContract.entityTypes,
        output_language: "Use the same main language as the input text. Chinese input must produce Chinese fields; English input must produce English fields."
      }
    },
    output_schema: extractDocumentContract.outputSchema
  };
  return [
    { role: "system", content: renderExtractionSystemPrompt() },
    { role: "user", content: JSON.stringify(extractDocumentContract.exampleInput) },
    { role: "assistant", content: JSON.stringify(extractDocumentContract.exampleOutput) },
    { role: "user", content: JSON.stringify(userInput) }
  ];
}
