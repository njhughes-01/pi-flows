/**
 * Unit tests for WHEN ask_user is registered (deferred to session_start) and
 * WHO owns the name.
 *
 * See change: fix-ask-user-fallback (F1-F7). Today registerAskUserTool registers
 * at factory time; the planned fix defers registration to a session_start
 * callback guarded by a getAllTools() ownership check — so F1-F6 fail against
 * the unpatched code by design, and F7 pins the definition itself.
 */
import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "../extensions/flow-engine/tools/ask-user.js";

interface FakeTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute?: (...args: any[]) => Promise<unknown>;
  [key: string]: unknown;
}

interface FakePi {
  api: ExtensionAPI;
  /** Tools the runtime has configured (what getAllTools() reports). */
  configured: FakeTool[];
  /** Every registerTool() call Flows made, in order. */
  registeredCalls: FakeTool[];
  /** Mark the registry readable — true once the session is up. */
  bind: () => void;
  /** Registry reads so far (must be 0 at factory time). */
  registryReads: () => number;
  /** Recorded handlers for an event. */
  handlers: (event: string) => Array<(payload: any) => unknown>;
  fireSessionStart: () => Promise<void>;
  activeNames: () => string[];
  getActiveTools: ReturnType<typeof vi.fn>;
  setActiveTools: ReturnType<typeof vi.fn>;
}

/**
 * Minimal ExtensionAPI stand-in. getAllTools() throws until bind(), standing in
 * for "the tool registry is not readable at extension-factory time".
 */
function makeFakePi(options: { configured?: FakeTool[]; active?: string[] } = {}): FakePi {
  const configured = [...(options.configured ?? [])];
  const registeredCalls: FakeTool[] = [];
  const handlers: Record<string, Array<(payload: any) => unknown>> = {};
  const active = [...(options.active ?? configured.map((t) => t.name))];
  let bound = false;
  let reads = 0;

  const getActiveTools = vi.fn(() => [...active]);
  const setActiveTools = vi.fn((names: string[]) => {
    active.length = 0;
    active.push(...names);
  });

  const api = {
    on: (event: string, handler: (payload: any) => unknown) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: (def: FakeTool) => {
      registeredCalls.push(def);
      configured.push(def);
    },
    getAllTools: () => {
      if (!bound) throw new Error("tool registry is not readable at extension factory time");
      reads += 1;
      return configured;
    },
    getActiveTools,
    setActiveTools,
  } as unknown as ExtensionAPI;

  return {
    api,
    configured,
    registeredCalls,
    bind: () => {
      bound = true;
    },
    registryReads: () => reads,
    handlers: (event) => handlers[event] ?? [],
    fireSessionStart: async () => {
      for (const handler of handlers.session_start ?? []) await handler({});
    },
    activeNames: () => [...active],
    getActiveTools,
    setActiveTools,
  };
}

/** A preconfigured owner shaped like the released Durable ask_user. */
function durableShapedOwner(): FakeTool {
  return {
    name: "ask_user",
    label: "ask_user",
    description: "Durable-shaped accounting-aware human question owner (fixture).",
    parameters: {
      type: "object",
      properties: { question: { type: "string", minLength: 1 } },
      required: ["question"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: any) => ({
      content: [{ type: "text", text: `fixture-answer:${params.question}` }],
      details: {},
    }),
  };
}

const askUsers = (tools: FakeTool[]) => tools.filter((t) => t.name === "ask_user");

/** Startup with an external owner present — before or after the Flows factory. */
async function startWithExternalOwner(ownerBeforeFactory: boolean) {
  const owner = durableShapedOwner();
  const pi = makeFakePi({ configured: ownerBeforeFactory ? [owner] : [] });
  registerAskUserTool(pi.api);
  if (!ownerBeforeFactory) pi.configured.push(owner);
  pi.bind();
  await pi.fireSessionStart();
  return { pi, owner };
}

/** Startup on a runtime with no ask_user owner at all. */
async function startStandalone() {
  const pi = makeFakePi();
  registerAskUserTool(pi.api);
  pi.bind();
  await pi.fireSessionStart();
  return pi;
}

describe("registerAskUserTool — registration timing", () => {
  it("F1: the factory call only installs one synchronous session_start callback", async () => {
    const pi = makeFakePi();
    registerAskUserTool(pi.api);

    const sessionStart = pi.handlers("session_start");
    expect(sessionStart).toHaveLength(1);
    expect(pi.registryReads()).toBe(0);
    expect(pi.registeredCalls).toHaveLength(0);

    // The callback itself is not async — it decides synchronously.
    pi.bind();
    expect(await sessionStart[0]({})).toBeUndefined();
  });

  it("F2: standalone startup registers exactly one fallback ask_user", async () => {
    const pi = await startStandalone();
    expect(askUsers(pi.registeredCalls)).toHaveLength(1);
    expect(askUsers(pi.configured)).toHaveLength(1);
    // The ownership check reads the registry — proof the decision is made at
    // session_start rather than at factory time.
    expect(pi.registryReads()).toBeGreaterThan(0);
  });

  it("F3: a preconfigured ask_user owner keeps the name (owner added before and after the Flows factory)", async () => {
    for (const ownerBeforeFactory of [true, false]) {
      const { pi, owner } = await startWithExternalOwner(ownerBeforeFactory);
      expect(pi.registeredCalls).toHaveLength(0);
      expect(askUsers(pi.configured)).toEqual([owner]);
      expect(askUsers(pi.configured)[0]).toBe(owner);
    }
  });

  it("F4: an owner outside the active tool names still counts as owned; active tools untouched", async () => {
    const owner = durableShapedOwner();
    const pi = makeFakePi({ configured: [owner], active: ["read", "bash"] });
    registerAskUserTool(pi.api);
    pi.bind();
    await pi.fireSessionStart();

    expect(pi.registeredCalls).toHaveLength(0);
    expect(pi.activeNames()).toEqual(["read", "bash"]);
    expect(pi.getActiveTools).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("F5: a second session_start adds nothing and replaces nothing", async () => {
    const standalone = await startStandalone();
    await standalone.fireSessionStart();
    expect(askUsers(standalone.registeredCalls)).toHaveLength(1);
    expect(askUsers(standalone.configured)).toHaveLength(1);
    expect(askUsers(standalone.configured)[0]).toBe(askUsers(standalone.registeredCalls)[0]);

    const owned = await startWithExternalOwner(true);
    await owned.pi.fireSessionStart();
    expect(owned.pi.registeredCalls).toHaveLength(0);
    expect(askUsers(owned.pi.configured)).toEqual([owned.owner]);
  });

  it("F6: every fresh runtime decides again — no module-level cache crosses runtimes", async () => {
    const first = await startWithExternalOwner(true); // owned → no fallback
    expect(first.pi.registeredCalls).toHaveLength(0);

    const second = await startStandalone(); // fresh runtime, empty registry
    expect(askUsers(second.registeredCalls)).toHaveLength(1);
    expect(askUsers(second.configured)).toHaveLength(1);

    const third = await startWithExternalOwner(true); // owner retained again
    expect(third.pi.registeredCalls).toHaveLength(0);
    expect(askUsers(third.pi.configured)).toEqual([third.owner]);
  });
});

describe("registerAskUserTool — the ask_user definition (F7)", () => {
  const def = ownerDefinition();

  it("confirm answers with ui.confirm(question, \"\") and returns {answer:true}", async () => {
    const ui = fakeUi({ confirm: true });
    expect(await runTool(def, { question: "Ship it?", type: "confirm" }, ui)).toEqual({ answer: true });
    expect(ui.confirm).toHaveBeenCalledWith("Ship it?", "");
  });

  it("input passes defaultValue through", async () => {
    const ui = fakeUi({ input: "branch" });
    expect(
      await runTool(def, { question: "Branch?", type: "input", defaultValue: "develop" }, ui),
    ).toEqual({ answer: "branch" });
    expect(ui.input).toHaveBeenCalledWith("Branch?", "develop");
  });

  it("select passes options and returns the chosen option", async () => {
    const ui = fakeUi({ select: "rebase" });
    expect(
      await runTool(def, { question: "How?", type: "select", options: ["merge", "rebase"] }, ui),
    ).toEqual({ answer: "rebase" });
    expect(ui.select).toHaveBeenCalledWith("How?", ["merge", "rebase"]);
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("allowCustom adds 'Other (describe)' and a chosen custom answer asks ui.input(\"Describe:\", \"\")", async () => {
    const ui = fakeUi({ select: "Other (describe)", input: "squash and tag" });
    expect(
      await runTool(def, { question: "How?", type: "select", options: ["merge"], allowCustom: true }, ui),
    ).toEqual({ answer: "squash and tag" });
    expect(ui.select).toHaveBeenCalledWith("How?", ["merge", "Other (describe)"]);
    expect(ui.input).toHaveBeenCalledWith("Describe:", "");
  });

  it("multiSelect keeps per-option confirms and returns a JSON array", async () => {
    const ui = fakeUi({});
    ui.confirm
      .mockImplementationOnce(async () => true)
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => true);
    expect(
      await runTool(
        def,
        { question: "Which?", type: "select", options: ["a", "b", "c"], multiSelect: true },
        ui,
      ),
    ).toEqual({ answer: ["a", "c"] });
    expect(ui.confirm).toHaveBeenCalledTimes(3);
    expect(ui.confirm.mock.calls[0]).toEqual(['Which?\n  Include "a"?', ""]);
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("schema still requires question/type (select|confirm|input) and keeps the optional keys", () => {
    const params = def.parameters as any;
    expect(Object.keys(params.properties).sort()).toEqual([
      "allowCustom",
      "defaultValue",
      "multiSelect",
      "options",
      "question",
      "type",
    ]);
    expect(params.required).toEqual(["question", "type"]);
    expect(typeLiterals(params.properties.type).sort()).toEqual(["confirm", "input", "select"]);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * The ask_user definition however it lands: today at factory time, after the fix
 * from the session_start callback (whose body is synchronous).
 */
function ownerDefinition(): any {
  const pi = makeFakePi();
  registerAskUserTool(pi.api);
  pi.bind();
  if (pi.handlers("session_start").length > 0) {
    for (const handler of pi.handlers("session_start")) handler({});
  }
  const def = askUsers(pi.registeredCalls)[0];
  if (!def) throw new Error("no ask_user definition registered");
  return def;
}

function typeLiterals(schema: any): string[] {
  if (typeof schema.const === "string") return [schema.const];
  if (Array.isArray(schema.enum)) return [...schema.enum];
  if (Array.isArray(schema.anyOf)) return schema.anyOf.flatMap(typeLiterals);
  return [];
}

function fakeUi(answers: { confirm?: unknown; select?: unknown; input?: unknown }) {
  return {
    confirm: vi.fn(async () => answers.confirm ?? false),
    select: vi.fn(async () => answers.select ?? undefined),
    input: vi.fn(async () => answers.input ?? ""),
  };
}

async function runTool(def: any, params: any, ui: ReturnType<typeof fakeUi>) {
  const result: any = await def.execute("tool-call-1", params, undefined, undefined, { ui });
  expect(result.details).toEqual({});
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  return JSON.parse(result.content[0].text);
}
