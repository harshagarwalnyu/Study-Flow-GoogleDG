import { GoogleGenAI } from "@google/genai";
import { env } from "../env";
import { logger } from "../logger";

const MODEL_ALIASES = {
  primary: env.geminiModel,
  fast: env.geminiFastModel,
  embedding: env.geminiEmbeddingModel,
} as const;

/** Conservative per-request cap for batched embeddings (the API does not publish one for gemini-embedding-2). */
export const EMBED_BATCH_SIZE = 100;

type ModelAlias = keyof typeof MODEL_ALIASES;

function resolveModelName(model: ModelAlias | string): string {
  return MODEL_ALIASES[model as ModelAlias] ?? model ?? MODEL_ALIASES.primary;
}

/** Rate limits (429) and transient overload (503) are worth retrying; everything else fails fast. */
export function isRetryableGeminiError(error: any): boolean {
  const status = error?.status;
  const code = error?.code;
  const message = String(error?.message ?? "");
  return (
    status === 429 || status === 503 ||
    status === "RESOURCE_EXHAUSTED" || status === "UNAVAILABLE" ||
    code === 429 || code === 503 ||
    /\b(429|503)\b|quota|RESOURCE_EXHAUSTED|UNAVAILABLE/.test(message)
  );
}

export function parseJsonResponse(text: string): any {
  const cleaned = text.replace(/```json\n?|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Gemini returned invalid JSON: ${message} | responseLength: ${cleaned.length}`,
      { cause: error }
    );
  }
}

export function createGeminiProvider() {
  const genAI = new GoogleGenAI({ apiKey: env.geminiApiKey });

  return {
    name: "gemini",
    client: genAI,
    resolveModelName,

    async generateJson({ model = "primary", prompt, temperature = 0.4 }: { model?: ModelAlias | string, prompt: any, temperature?: number }) {
      const modelName = resolveModelName(model);

      let lastError: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await genAI.models.generateContent({
            model: modelName,
            contents: Array.isArray(prompt) ? prompt : [{ role: "user", parts: [{ text: prompt }] }],
            config: {
              temperature,
              responseMimeType: "application/json",
            },
          });
          return parseJsonResponse(response.text || "");
        } catch (error: any) {
          lastError = error;
          if (!isRetryableGeminiError(error) || attempt === 3) break;
          const delay = Math.pow(2, attempt) * 1000;
          logger.warn({ attempt, delay, model: modelName }, "Gemini rate limited, retrying...");
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastError;
    },

    async streamText({ model = "primary", prompt, temperature = 0.4 }: { model?: ModelAlias | string, prompt: any, temperature?: number }) {
      const modelName = resolveModelName(model);

      let lastError: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const stream = await genAI.models.generateContentStream({
            model: modelName,
            contents: Array.isArray(prompt) ? prompt : [{ role: "user", parts: [{ text: prompt }] }],
            config: { temperature },
          });
          return stream;
        } catch (error: any) {
          lastError = error;
          if (!isRetryableGeminiError(error) || attempt === 3) break;
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastError;
    },

    /**
     * Embed one or many texts. Always returns exactly one vector per input, in order —
     * callers pair results with inputs by index, so a short or empty response is an error.
     */
    async embedContent({ contents, outputDimensionality = 768, model = "embedding" }: { contents: string | string[], outputDimensionality?: number, model?: ModelAlias | string }): Promise<number[][]> {
      const texts = Array.isArray(contents) ? contents : [contents];
      const modelName = resolveModelName(model);
      const vectors: number[][] = [];

      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const slice = texts.slice(i, i + EMBED_BATCH_SIZE);
        const result = await genAI.models.embedContent({
          model: modelName,
          contents: slice.map((text) => ({ parts: [{ text }] })),
          config: { outputDimensionality },
        });
        const values = (result.embeddings || []).map((e) => e.values);
        if (values.length !== slice.length || values.some((v) => !v || v.length === 0)) {
          throw new Error(
            `Embedding response mismatch from ${modelName}: expected ${slice.length} vectors, got ${values.filter((v) => v?.length).length}`,
          );
        }
        vectors.push(...(values as number[][]));
      }
      return vectors;
    },

    async uploadFile({ filePath, displayName, mimeType }: { filePath: string, displayName?: string, mimeType?: string }) {
      return genAI.files.upload({ file: filePath, config: { displayName, mimeType } });
    },
  };
}

export const geminiProvider = createGeminiProvider();
export type GeminiProvider = ReturnType<typeof createGeminiProvider>;
