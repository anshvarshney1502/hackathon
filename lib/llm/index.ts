import "server-only";
import type { z } from "zod";
import { serverEnv } from "@/lib/server/env";
import { geminiProvider } from "./gemini";
import { groqProvider } from "./groq";

export interface LlmRequest {
  system: string;
  user: string;
  temperature: number;
  maxOutputTokens: number;
}

/** A provider returns raw model text (expected to be JSON) or throws. */
export interface LlmProvider {
  name: "gemini" | "groq";
  defaultModel: string;
  complete(req: LlmRequest, model: string, apiKey: string): Promise<string>;
}

export class LlmUnavailableError extends Error {}

function provider(): { p: LlmProvider; model: string; key: string } {
  const env = serverEnv();
  const p = env.LLM_PROVIDER === "groq" ? groqProvider : geminiProvider;
  const key = env.LLM_PROVIDER === "groq" ? env.GROQ_API_KEY : env.GEMINI_API_KEY;
  if (!key) throw new LlmUnavailableError(`${env.LLM_PROVIDER.toUpperCase()}_API_KEY is not set`);
  return { p, model: env.LLM_MODEL || p.defaultModel, key };
}

/** Pull the first JSON object out of model text (tolerates ```json fences). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in model output");
  return JSON.parse(trimmed.slice(start, end + 1));
}

export type StructuredResult<T> = { ok: true; data: T; attempts: number } | { ok: false; reason: string; attempts: number };

/**
 * Ask for JSON, validate with Zod, retry once on any failure, then give up safely.
 * Never throws: malformed model output must not break the game.
 */
export async function generateStructured<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<StructuredResult<T>> {
  let lastReason = "unknown";
  let resolved: ReturnType<typeof provider>;
  try {
    resolved = provider();
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "LLM not configured", attempts: 0 };
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await resolved.p.complete(req, resolved.model, resolved.key);
      const parsed = schema.safeParse(extractJson(raw));
      if (parsed.success) return { ok: true, data: parsed.data, attempts: attempt };
      lastReason = `schema: ${parsed.error.issues[0]?.message ?? "invalid"}`;
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, reason: lastReason, attempts: 2 };
}
