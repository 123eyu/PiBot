export const customPresets: Record<string, { name: string; urls: Record<string, string> }> = {
  ollama: { name: "Ollama", urls: { local: "http://127.0.0.1:11434/v1" } },
  lmstudio: { name: "LM Studio", urls: { local: "http://127.0.0.1:1234/v1" } },
  vllm: { name: "vLLM", urls: { local: "http://127.0.0.1:8000/v1" } },
  "zai-api": {
    name: "Z.ai API",
    urls: { global: "https://api.z.ai/api/paas/v4", china: "https://open.bigmodel.cn/api/paas/v4" },
  },
  "qwen-api": {
    name: "Qwen API",
    urls: {
      global: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      china: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
  },
};
