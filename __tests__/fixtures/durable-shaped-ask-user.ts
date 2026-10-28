// Durable-shaped ask_user owner fixture: registers at factory time, like the
// released Durable bridge coordination tool. Zero dependencies.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "ask_user",
    description: "Durable-shaped accounting-aware human question owner (fixture).",
    // Exactly Durable 0.4.4 askUserParameters as TypeBox emits it (canonical SHA-256 49fe5adc…, evidence-checks OWNER_SCHEMAS).
    parameters: {
      type: "object",
      properties: { question: { type: "string", minLength: 1 } },
      required: ["question"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId: string, params: any) {
      return { content: [{ type: "text", text: `fixture-answer:${params.question}` }], details: {} };
    },
  });
}
