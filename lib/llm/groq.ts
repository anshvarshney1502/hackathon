import "server-only";
import { z } from "zod";
import type { LlmProvider } from "./index";

const GroqResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

/** Groq exposes an OpenAI-compatible chat completions API. */
export const groqProvider: LlmProvider = {
  name: "groq",
  defaultModel: "llama-3.3-70b-versatile",
  async complete(req, model, apiKey) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: req.temperature,
        max_tokens: req.maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
    const content = GroqResponseSchema.parse(await res.json()).choices[0].message.content;
    if (!content) throw new Error("Groq returned no content");
    return content;
  },
};
