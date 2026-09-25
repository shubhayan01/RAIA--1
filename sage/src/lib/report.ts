/**
 * Normalized report format returned by every capability.
 * The frontend renders these blocks generically, so any service can add
 * output without touching the UI.
 */
export type Block =
  | { type: 'p'; text: string }
  | { type: 'kv'; items: { k: string; v: string }[] }
  | { type: 'list'; items: string[] }
  | { type: 'table'; head: string[]; rows: (string | number)[][] }
  | { type: 'chips'; items: string[] }
  | { type: 'tasks'; items: { title: string; priority: 'critical' | 'high' | 'medium' | 'low'; detail?: string; count?: number }[] }
  | { type: 'note'; text: string };

export interface Report {
  tag: string;          // short label, e.g. "SEO Audit"
  title: string;        // headline for the response bubble
  blocks: Block[];
  data?: unknown;       // raw structured payload (for export / API consumers)
  warnings?: string[];
}

export const b = {
  p: (text: string): Block => ({ type: 'p', text }),
  kv: (items: { k: string; v: string }[]): Block => ({ type: 'kv', items }),
  list: (items: string[]): Block => ({ type: 'list', items }),
  table: (head: string[], rows: (string | number)[][]): Block => ({ type: 'table', head, rows }),
  chips: (items: string[]): Block => ({ type: 'chips', items }),
  tasks: (items: Extract<Block, { type: 'tasks' }>['items']): Block => ({ type: 'tasks', items }),
  note: (text: string): Block => ({ type: 'note', text }),
};
