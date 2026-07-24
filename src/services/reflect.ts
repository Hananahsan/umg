import type { UmgConfig } from "../config.js";
import type { MemoryStore } from "../store/interface.js";
import type { MemoryService } from "./memory.js";
import type { MemoryTier, ReflectCandidate, ReflectResult, RetainResult } from "../types.js";
import { computeImportance, autoTier } from "./scoring.js";
import { emitEvent } from "../observability/events.js";
import { log } from "../util/log.js";
import { jaccard, normalizeText, truncate, uniqueStrings } from "../util/text.js";

export class ReflectService {
  constructor(
    private store: MemoryStore,
    private cfg: UmgConfig,
    private memory: MemoryService,
  ) {}

  async reflect(input: {
    text: string;
    namespace?: string;
    mode?: "extract" | "summarize_session";
    auto_retain?: boolean;
    session_id?: string;
  }): Promise<ReflectResult> {
    const mode = input.mode ?? "extract";
    const autoRetain = input.auto_retain ?? this.cfg.reflect.auto_retain;
    const namespace = input.namespace ?? this.cfg.default_namespace;
    const text = input.text?.trim() ?? "";

    if (!text) {
      return { candidates: [], retained: [], mode };
    }

    let candidates: ReflectCandidate[] = [];

    if (this.cfg.reflect.llm.enabled) {
      try {
        candidates = await this.llmExtract(text);
      } catch (err) {
        log.warn("LLM reflect failed; using heuristics", { error: String(err) });
        candidates = heuristicExtract(text, this.cfg.reflect.max_extract);
      }
    } else {
      candidates = heuristicExtract(text, this.cfg.reflect.max_extract);
    }

    if (mode === "summarize_session") {
      const summary = summarizeSession(text);
      if (summary) {
        candidates.unshift({
          content: summary,
          tier: "episodic",
          importance: 0.55,
          tags: ["session-summary"],
          entities: [],
          reason: "session_summary",
        });
        candidates = candidates.slice(0, this.cfg.reflect.max_extract);
      }
    }

    const retained: RetainResult[] = [];
    if (autoRetain) {
      for (const c of candidates) {
        const r = await this.memory.retain({
          content: c.content,
          tier: c.tier,
          namespace,
          importance: c.importance,
          tags: c.tags,
          entities: c.entities,
          session_id: input.session_id,
          source: "reflect",
          metadata: { reflect_reason: c.reason },
        });
        retained.push(r);
      }
    }

    await emitEvent(this.store, this.cfg, "reflect", {
      mode,
      candidates: candidates.length,
      retained: retained.filter((r) => r.action !== "rejected").length,
      rejected: retained.filter((r) => r.action === "rejected").length,
      preview: truncate(text, 100),
    });

    return { candidates, retained, mode };
  }

  private async llmExtract(text: string): Promise<ReflectCandidate[]> {
    const apiKey = process.env[this.cfg.reflect.llm.api_key_env];
    if (!apiKey) {
      throw new Error(`Missing API key env ${this.cfg.reflect.llm.api_key_env}`);
    }
    const baseUrl =
      this.cfg.reflect.llm.base_url?.replace(/\/$/, "") ||
      "https://api.openai.com/v1";
    const model = this.cfg.reflect.llm.model;
    const max = this.cfg.reflect.max_extract;

    const system = `You extract durable agent memories from text.
Return JSON only: {"memories":[{"content":"...","tier":"semantic|episodic|working|procedural","importance":0.0-1.0,"tags":[],"entities":[],"reason":"..."}]}
Rules:
- Max ${max} items
- Prefer durable facts, preferences, decisions, corrections
- Skip greetings, chit-chat, one-off noise
- Keep content concise (1-2 sentences)
- tier must be one of working, episodic, semantic, procedural`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: text.slice(0, 12_000) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      memories?: Array<{
        content?: string;
        tier?: string;
        importance?: number;
        tags?: string[];
        entities?: string[];
        reason?: string;
      }>;
    };

    const out: ReflectCandidate[] = [];
    for (const m of parsed.memories ?? []) {
      if (!m.content?.trim()) continue;
      const tier = normalizeTier(m.tier) ?? autoTier(m.content);
      out.push({
        content: m.content.trim(),
        tier,
        importance: clamp01(m.importance ?? computeImportance(m.content, tier)),
        tags: uniqueStrings(m.tags ?? []),
        entities: uniqueStrings(m.entities ?? []),
        reason: m.reason ?? "llm",
      });
      if (out.length >= max) break;
    }
    return out;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function normalizeTier(t?: string): MemoryTier | null {
  if (!t) return null;
  const x = t.toLowerCase();
  if (
    x === "working" ||
    x === "episodic" ||
    x === "semantic" ||
    x === "procedural"
  ) {
    return x;
  }
  return null;
}

/** Offline-safe heuristic extraction. */
export function heuristicExtract(text: string, max: number): ReflectCandidate[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const candidates: ReflectCandidate[] = [];
  const seen = new Set<string>();

  const push = (content: string, reason: string, tierHint?: MemoryTier) => {
    const c = content.replace(/^[-*•\d.)\s]+/, "").trim();
    if (c.length < 12 || c.length > 500) return;
    const key = normalizeText(c);
    if (seen.has(key)) return;
    // Near-dup vs already extracted candidates (e.g. labeled line + same sentence)
    for (const existing of candidates) {
      if (jaccard(existing.content, c) >= 0.75) return;
    }
    seen.add(key);
    const tier = tierHint ?? autoTier(c);
    const importance = computeImportance(c, tier);
    if (importance < 0.3 && tier !== "working") return;
    candidates.push({
      content: c,
      tier,
      importance,
      tags: tagsForReason(reason),
      entities: extractEntities(c),
      reason,
    });
  };

  // Labeled lines
  for (const line of lines) {
    const labeled = line.match(
      /^(decision|preference|fact|remember|note|todo|lesson|skill)\s*[:\-]\s*(.+)$/i,
    );
    if (labeled) {
      const kind = labeled[1].toLowerCase();
      const tier: MemoryTier =
        kind === "skill" || kind === "lesson"
          ? "procedural"
          : kind === "todo"
            ? "working"
            : kind === "decision" || kind === "preference" || kind === "fact"
              ? "semantic"
              : "episodic";
      push(labeled[2], `labeled:${kind}`, tier);
    }
    // Bullet lines that look factual
    if (/^[-*•]/.test(line) && line.length > 20) {
      push(line, "bullet");
    }
  }

  // Sentence split for remaining signal
  if (candidates.length < max) {
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 400);

    for (const s of sentences) {
      if (
        /\b(prefer|always|never|remember|decision|we use|we chose|don't|do not|timezone|email|api key|stack is)\b/i.test(
          s,
        )
      ) {
        push(s, "sentence_signal");
      }
      if (candidates.length >= max) break;
    }
  }

  // Rank by importance and cap
  candidates.sort((a, b) => b.importance - a.importance);
  return candidates.slice(0, max);
}

function tagsForReason(reason: string): string[] {
  if (reason.startsWith("labeled:")) return [reason.slice(8)];
  if (reason === "session_summary") return ["session-summary"];
  return [];
}

function extractEntities(content: string): string[] {
  const entities: string[] = [];
  // Capitalized multi-word or tech tokens
  const caps = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
  if (caps) entities.push(...caps);
  const tech = content.match(
    /\b(?:PostgreSQL|Postgres|Supabase|Next\.js|TypeScript|Python|Retell|Stripe|Redis|SQLite|OpenAI|Anthropic)\b/gi,
  );
  if (tech) entities.push(...tech);
  const versions = content.match(/\bv?\d+\.\d+(?:\.\d+)?\b/g);
  if (versions) entities.push(...versions);
  return uniqueStrings(entities).slice(0, 8);
}

function summarizeSession(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length < 40) return null;
  const snippet = cleaned.slice(0, 280);
  return `Session notes: ${snippet}${cleaned.length > 280 ? "…" : ""}`;
}
