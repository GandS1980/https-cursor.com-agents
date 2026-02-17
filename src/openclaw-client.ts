import { OpenClawConfig, OpenClawMessage, OpenClawResponse } from "./types";

/**
 * Client for communicating with the OpenClaw agent API.
 * Handles prompt construction, API calls, and response parsing.
 */
export class OpenClawClient {
  private config: OpenClawConfig;

  constructor(config: OpenClawConfig) {
    this.config = config;
  }

  async chat(messages: OpenClawMessage[]): Promise<OpenClawResponse> {
    const url = `${this.config.baseUrl}/v1/chat/completions`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenClaw API error ${response.status}: ${body}`
      );
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: data.choices?.[0]?.message?.content ?? "",
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async prompt(systemPrompt: string, userMessage: string): Promise<string> {
    const resp = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);
    return resp.content;
  }
}
