import "dotenv/config";
import { parseServerEnvironment } from "@study-flow/shared";

export function parseBoolean(input: unknown, fallback: boolean): boolean {
  if (input == null) return fallback;
  const normalized = String(input).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function parsePositiveInt(input: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(input ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePositiveFloat(input: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(input ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Express "trust proxy": hop count (e.g. 1 behind Cloud Run / one load balancer), true, or false.
 * Too permissive lets clients spoof X-Forwarded-For and dodge per-IP limits; too strict makes
 * every request look like it came from the proxy, so all users share one rate-limit bucket.
 */
export function parseTrustProxy(input: unknown): boolean | number {
  if (input == null || String(input).trim() === "") return false;
  const hops = Number.parseInt(String(input), 10);
  if (Number.isFinite(hops) && hops >= 0) return hops;
  return parseBoolean(input, false);
}

export function parseRateLimitStore(input: unknown): "memory" | "firestore" {
  return String(input ?? "").trim().toLowerCase() === "firestore" ? "firestore" : "memory";
}

const sharedEnv = parseServerEnvironment(process.env);

export const env = {
  port: sharedEnv.PORT,
  nodeEnv: sharedEnv.NODE_ENV,
  geminiApiKey: sharedEnv.GEMINI_API_KEY,
  geminiModel: sharedEnv.GEMINI_MODEL,
  geminiFastModel: sharedEnv.GEMINI_FAST_MODEL,
  geminiEmbeddingModel: sharedEnv.GEMINI_EMBEDDING_MODEL,
  // Cosine distance cutoff for RAG (distance = 1 - similarity). Tune with `bun run --cwd server eval`.
  ragMaxCosineDistance: parsePositiveFloat(process.env.RAG_MAX_COSINE_DISTANCE, 0.6),
  // Concept labels closer than this (cosine distance) are merged into one SMG node.
  conceptMatchMaxDistance: parsePositiveFloat(process.env.CONCEPT_MATCH_MAX_DISTANCE, 0.15),
  graphifyEnabled: parseBoolean(process.env.GRAPHIFY_ENABLED, true),
  graphifyQuestionTokens: parsePositiveInt(process.env.GRAPHIFY_QUESTION_MAX_TOKENS, 220),
  graphifyContextTokens: parsePositiveInt(process.env.GRAPHIFY_CONTEXT_MAX_TOKENS, 1200),
  graphifyAnswerTokens: parsePositiveInt(process.env.GRAPHIFY_ANSWER_MAX_TOKENS, 450),
  graphifyMaterialTokens: parsePositiveInt(process.env.GRAPHIFY_MATERIAL_MAX_TOKENS, 1400),
  firebaseProjectId: sharedEnv.FIREBASE_PROJECT_ID,
  googleApplicationCredentials: sharedEnv.GOOGLE_APPLICATION_CREDENTIALS,
  // Comma-separated allowed origins for CORS; defaults to permissive in dev
  allowedOrigins: sharedEnv.ALLOWED_ORIGINS,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // "firestore" shares the AI rate limit across instances; "memory" (default) is per process.
  rateLimitStore: parseRateLimitStore(process.env.RATE_LIMIT_STORE),
  rateLimitIpPerMinute: parsePositiveInt(process.env.RATE_LIMIT_IP_PER_MINUTE, 120),
  rateLimitAiPerMinute: parsePositiveInt(process.env.RATE_LIMIT_AI_PER_MINUTE, 20),
};
