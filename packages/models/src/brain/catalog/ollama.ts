const baseUrl = "http://127.0.0.1:11434/v1";

export async function detectOllama() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Race the whole operation, including body parsing, even if a host fetch ignores abort.
    return await Promise.race([
      (async () => {
        const response = await fetch("http://127.0.0.1:11434/api/tags", {
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) throw new Error("Ollama unavailable");
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models))
          throw new Error("Invalid Ollama response");
        const models = body.models.map((model: unknown) => {
          if (
            !model ||
            typeof model !== "object" ||
            !("name" in model) ||
            typeof model.name !== "string" ||
            !model.name
          )
            throw new Error("Invalid Ollama model");
          return { id: model.name };
        });
        return { running: true, baseUrl, models };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Ollama timeout"));
        }, 1500);
      }),
    ]);
  } catch {
    return { running: false, baseUrl, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
