// Registers a NON-ask_user tool name that Flows also registers (flow_results),
// at factory time. The conflict must stay fatal: it is unrelated to ask_user.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "flow_results",
    label: "flow_results",
    description: "Unrelated duplicate owner (fixture).",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId: string, params: any) {
      return { content: [{ type: "text", text: `fixture:${params.query}` }], details: {} };
    },
  });
}
