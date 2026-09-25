export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean; // request strict JSON output where supported
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
