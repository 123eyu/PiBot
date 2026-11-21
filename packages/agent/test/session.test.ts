import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentError } from "../src/core/errors.ts";
import { type ChatSession, staticResourceLoader, wrapSession } from "../src/session/session.ts";

const assistant: AssistantMessage = {
  role: "assistant",
  provider: "test",
  model: "test",
  api: "openai-completions",
  content: [{ type: "text", text: "done" }],
  stopReason: "length",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: 0,
};
function fakeSession() {
  const unsubscribe = vi.fn();
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const session: ChatSession = {
    messages: [],
    subscribe: vi.fn((next) => {
      listener = next;
      return unsubscribe;
    }),
    prompt: vi.fn(async () => {
      session.messages.push(assistant);
    }),
    abort: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return { session, unsubscribe, emit: (event: AgentSessionEvent) => listener?.(event) };
}
describe("session wrapper lifecycle", () => {
  it("uses the final assistant message when no message_end is emitted", async () => {
    const { session, unsubscribe } = fakeSession();
    expect(
      await wrapSession(session, "session.jsonl", async () => true).prompt("hello", () => {}),
    ).toEqual({ stopReason: "length", usage: assistant.usage, finalText: "done", calledTools: [] });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("checks availability rather than an unknown placeholder model", async () => {
    const { session } = fakeSession();
    Object.assign(session, { model: { provider: "unknown", id: "unknown" } });
    await expect(
      wrapSession(session, "session.jsonl", async () => false).prompt("hello", () => {}),
    ).rejects.toEqual(new AgentError("no_model"));
    expect(session.prompt).not.toHaveBeenCalled();
  });
  it("unsubscribes after prompt throws and hides raw diagnostics", async () => {
    const { session, unsubscribe } = fakeSession();
    session.prompt = vi.fn(async () => {
      throw new Error("401 secret-header-value");
    });
    const wrapper = wrapSession(session, "session.jsonl", async () => true);
    await expect(wrapper.prompt("hello", () => {})).rejects.toEqual(
      new AgentError("auth_failed", 401),
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("rejects concurrent prompts and allows abort during credential lookup", async () => {
    const { session } = fakeSession();
    let ready: ((available: boolean) => void) | undefined;
    const availability = new Promise<boolean>((resolve) => {
      ready = resolve;
    });
    const wrapper = wrapSession(session, "session.jsonl", () => availability);
    const result = wrapper.prompt("hello", () => {});
    const rejected = expect(result).rejects.toEqual(new AgentError("aborted"));
    await expect(wrapper.prompt("second", () => {})).rejects.toEqual(new AgentError("internal"));
    await wrapper.abort();
    ready?.(true);
    await rejected;
    expect(session.prompt).not.toHaveBeenCalled();
  });
  it("disposes once and rejects later prompts", async () => {
    const { session } = fakeSession();
    const wrapper = wrapSession(session, "session.jsonl", async () => true);
    wrapper.dispose();
    wrapper.dispose();
    expect(session.dispose).toHaveBeenCalledOnce();
    await expect(wrapper.prompt("hello", () => {})).rejects.toEqual(new AgentError("internal"));
  });
  it("returns empty static resource lists without any discovery", async () => {
    // The loader never uses the extension runtime; a type-only fixture avoids importing pi.
    const loader = staticResourceLoader("Pi Bot", {} as Parameters<typeof staticResourceLoader>[1]);
    await loader.reload();
    loader.extendResources({});
    expect(loader.getSystemPrompt()).toBe("Pi Bot");
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
  });
});
