import { describe, expect, test } from "bun:test";
import { detectFlavor, explainModelError, fitsRole, readModels } from "../onebase/lib/modelServers";

describe("model servers", () => {
  test("the kind of server, from its address and model list", () => {
    expect(detectFlavor("https://openrouter.ai/api/v1", { data: [{ id: "x" }] })).toBe("openrouter");
    expect(detectFlavor("http://127.0.0.1:9931/v1", { data: [{ id: "a", owned_by: "llamacpp", status: { args: [] } }] })).toBe("llamacpp");
    expect(detectFlavor("http://127.0.0.1:8403/v1", { data: [{ id: "e" }], models: [{ name: "e", capabilities: ["completion"] }] })).toBe("llamacpp");
    expect(detectFlavor("http://localhost:11434/v1", { data: [{ id: "llama3" }] })).toBe("ollama");
    expect(detectFlavor("http://localhost:1234/v1", { data: [{ id: "qwen" }] })).toBe("lmstudio");
    expect(detectFlavor("http://10.0.0.5:8000/v1", { data: [{ id: "q", owned_by: "vllm" }] })).toBe("vllm");
    expect(detectFlavor("https://api.example.com/v1", { data: [{ id: "q" }] })).toBe("openai");
  });

  test("what each model can do: names first (a llama.cpp embedding model says it outputs text)", () => {
    const models = readModels({
      data: [
        { id: "unsloth/embeddinggemma-2-GGUF:BF16", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
        { id: "danbev/d1-Omni-2B-GGUF:BF16", architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] } },
        { id: "unsloth/Muse-Glimmer-30B-GGUF:Q4_K_XL", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
        { id: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0" },
        { id: "Serveurperso/Qwen3-TTS-GGUF:BF16" },
        { id: "lfm3-1.7b" },
      ],
    });
    const kinds = Object.fromEntries(models.map((m) => [m.id, m.kinds]));
    expect(kinds["unsloth/embeddinggemma-2-GGUF:BF16"]).toEqual(["embed"]);
    expect(kinds["danbev/d1-Omni-2B-GGUF:BF16"]).toEqual(["decide"]);
    expect(kinds["unsloth/Muse-Glimmer-30B-GGUF:Q4_K_XL"]).toEqual(["chat", "vision"]);
    expect(kinds["ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0"]).toEqual(["rerank"]);
    expect(kinds["Serveurperso/Qwen3-TTS-GGUF:BF16"]).toEqual(["audio"]);
    expect(kinds["lfm3-1.7b"]).toEqual(["chat"]);
    expect(fitsRole(["decide"], "decide")).toBe(true);
    expect(fitsRole(["decide"], "main")).toBe(false);
    expect(fitsRole(["chat"], "decide")).toBe(true);
    expect(fitsRole(["embed"], "fast")).toBe(false);
    expect(fitsRole(["embed"], "embed")).toBe(true);
    // Ollama-style capabilities and LM Studio types.
    expect(readModels({ models: [{ name: "nomic", capabilities: ["embedding"] }] })[0]!.kinds).toEqual(["embed"]);
    expect(readModels({ data: [{ id: "v", type: "vlm" }] })[0]!.kinds).toEqual(["chat", "vision"]);
  });

  test("errors are explained in Arabic, with the fix for that server", () => {
    const body = JSON.stringify({ error: { code: 501, message: "This server does not support embeddings. Start it with `--embeddings`", type: "not_supported_error" } });
    const llama = explainModelError({ role: "embed", flavor: "llamacpp", model: "e", status: 501, body });
    expect(llama).toContain("--embeddings");
    expect(llama).not.toContain("not_supported_error");
    expect(explainModelError({ role: "main", flavor: "llamacpp", model: "d1", status: 400, body: "decision model without text generation, use /v1/systemone" })).toContain("نموذج قرار");
    expect(explainModelError({ role: "main", flavor: "ollama", model: "qwen3", status: 404, body: '{"error":{"message":"model not found"}}' })).toContain("ollama pull qwen3");
    expect(explainModelError({ role: "main", flavor: "lmstudio", model: "q", status: 404, body: "" })).toContain("LM Studio");
    expect(explainModelError({ role: "main", flavor: "openrouter", model: "x", status: 402, body: "" })).toContain("OpenRouter");
    expect(explainModelError({ role: "main", flavor: "openai", model: "x", status: 401 })).toContain("المفتاح مرفوض");
    expect(explainModelError({ role: "vision", flavor: "llamacpp", model: "x", status: 500, body: "image input is not supported - hint: you may need to provide the mmproj" })).toContain("--mmproj");
    expect(explainModelError({ role: "fast", flavor: "llamacpp", model: "x", status: 0, timeout: true })).toContain("قيد التحميل");
    expect(explainModelError({ role: "fast", flavor: "openai", model: "x", status: 0 })).toContain("تعذّر الوصول");
  });
});
