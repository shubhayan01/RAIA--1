export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean; // request strict JSON output where supported
  // Reasoning models (e.g. Groq's gpt-oss-*) spend part of the completion budget
  // on hidden reasoning tokens. For structured extraction we want that spend LOW
  // so the token budget goes to the JSON, not the thinking. Passed through to
  // providers that support it; ignored by those that don't.
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface LLMProvider {
  name: string;
  model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

export class LLMError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'LLMError';
  }
}
