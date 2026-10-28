// Schema probe: records the ask_user owner actually configured at session_start
// (count + canonical SHA-256 of its parameters + a readable shape summary).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Canonical JSON: object keys sorted recursively, arrays keep order,
// symbol keys ignored, leaves serialized by JSON.stringify.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const owners = pi.getAllTools().filter((t: any) => t.name === "ask_user");
    const parameters = owners.length > 0 ? (owners[0] as any).parameters : undefined;
    const props = parameters?.properties ? Object.keys(parameters.properties).sort() : [];
    const required = Array.isArray(parameters?.required) ? [...parameters.required].sort() : [];
    writeFileSync(
      process.env.PROBE_SCHEMA_OUT!,
      JSON.stringify({
        count: owners.length,
        fingerprint: owners.length > 0 ? createHash("sha256").update(canonical(parameters)).digest("hex") : null,
        shape: { properties: props, required },
      }),
    );
  });
}
