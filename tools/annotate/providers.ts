/**
 * Pluggable LLM providers for the schema annotator.
 *
 * Each provider implements the same `chat()` interface — input is a system
 * prompt and a user prompt, output is the raw text returned by the model.
 *
 * Selection happens via the --provider CLI flag or the LLM_PROVIDER env var:
 *   - "ollama"    (default; local, no API key needed)
 *   - "openai"    (OpenAI-compatible; works with OpenAI, Groq, Together, vLLM, …)
 *   - "anthropic" (Claude API)
 */

export interface LlmProvider {
  readonly name: string;
  chat(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ── Ollama ──────────────────────────────────────────────────

export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        options: { temperature: 0.1, num_predict: 4096 },
        format: "json",
      }),
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message: { content: string } };
    return data.message.content;
  }
}

// ── OpenAI-compatible ───────────────────────────────────────

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai";
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0]?.message.content ?? "";
  }
}

// ── Anthropic ───────────────────────────────────────────────

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      content: { type: string; text: string }[];
    };
    return data.content.find((c) => c.type === "text")?.text ?? "";
  }
}

// ── Factory ─────────────────────────────────────────────────

export interface ProviderOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export function createProvider(opts: ProviderOptions): LlmProvider {
  const name = (opts.provider ?? process.env.LLM_PROVIDER ?? "ollama").toLowerCase();

  switch (name) {
    case "ollama":
      return new OllamaProvider(
        opts.baseUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434",
        opts.model ?? process.env.LLM_MODEL ?? "llama3.1",
      );
    case "openai": {
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set");
      return new OpenAIProvider(
        opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey,
        opts.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini",
      );
    }
    case "anthropic": {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
      return new AnthropicProvider(
        apiKey,
        opts.model ?? process.env.LLM_MODEL ?? "claude-3-5-sonnet-latest",
      );
    }
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}
