import "server-only";
import { z } from "zod";

/**
 * Server-only environment. Never import this from client code: it holds the
 * CometChat REST API key, the LLM keys and the session secret.
 */
const ServerEnvSchema = z.object({
  NEXT_PUBLIC_COMETCHAT_APP_ID: z.string().min(1),
  NEXT_PUBLIC_COMETCHAT_REGION: z.enum(["us", "eu", "in"]),
  COMETCHAT_REST_API_KEY: z.string().min(1),
  COMETCHAT_AUTH_KEY: z.string().optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  LLM_PROVIDER: z.enum(["gemini", "groq"]).default("gemini"),
  LLM_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export class MissingEnvError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Server is missing configuration: ${missing.join(", ")}`);
    this.name = "MissingEnvError";
  }
}

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = ServerEnvSchema.safeParse({
    NEXT_PUBLIC_COMETCHAT_APP_ID: process.env.NEXT_PUBLIC_COMETCHAT_APP_ID,
    NEXT_PUBLIC_COMETCHAT_REGION: process.env.NEXT_PUBLIC_COMETCHAT_REGION,
    COMETCHAT_REST_API_KEY: process.env.COMETCHAT_REST_API_KEY,
    COMETCHAT_AUTH_KEY: process.env.COMETCHAT_AUTH_KEY || undefined,
    SESSION_SECRET: process.env.SESSION_SECRET,
    LLM_PROVIDER: process.env.LLM_PROVIDER || undefined,
    LLM_MODEL: process.env.LLM_MODEL || undefined,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
    GROQ_API_KEY: process.env.GROQ_API_KEY || undefined,
  });
  if (!parsed.success) {
    throw new MissingEnvError(parsed.error.issues.map((i) => i.path.join(".") || i.message));
  }
  cached = parsed.data;
  return cached;
}
