import type { UmgConfig } from "../config.js";
import { log } from "./log.js";

/** Cosine similarity for equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-12) return 0;
  return Math.max(-1, Math.min(1, dot / denom));
}

/**
 * Optional OpenAI-compatible embedding. Never throws to callers — returns null on failure.
 * Offline default: embeddings.enabled = false.
 */
export async function embedText(
  text: string,
  cfg: UmgConfig,
): Promise<number[] | null> {
  if (!cfg.embeddings.enabled) return null;
  const apiKey = process.env[cfg.embeddings.api_key_env];
  if (!apiKey) {
    log.warn("embeddings enabled but API key missing", {
      env: cfg.embeddings.api_key_env,
    });
    return null;
  }
  const baseUrl =
    cfg.embeddings.base_url?.replace(/\/$/, "") || "https://api.openai.com/v1";
  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.embeddings.model,
        input: text.slice(0, 8000),
      }),
    });
    if (!res.ok) {
      log.warn("embedding HTTP failed", { status: res.status });
      return null;
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const emb = data.data?.[0]?.embedding;
    return Array.isArray(emb) ? emb : null;
  } catch (err) {
    log.warn("embedding request failed", { error: String(err) });
    return null;
  }
}
