import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const names = pi.getAllTools().map((t: any) => t.name);
    writeFileSync(process.env.PROBE_OUT!, JSON.stringify({ fired: true, askUserCount: names.filter((n: string) => n === "ask_user").length, tools: names }));
  });
}
