import { Block, Report } from './report';

/**
 * Render a Report to a self-contained, email-safe HTML document.
 * Everything is INLINE-styled (no <style> block, no external CSS) so it survives
 * Gmail / Outlook / Apple Mail stripping. Mirrors the block types the web UI
 * renders, but flattened for email clients.
 */

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const C = {
  ink: '#111827',
  sub: '#4b5563',
  line: '#e5e7eb',
  bg: '#f9fafb',
  accent: '#4f46e5',
  chipBg: '#eef2ff',
};

const SEV: Record<string, string> = {
  critical: '#b91c1c',
  high: '#c2410c',
  medium: '#a16207',
  low: '#4b5563',
};

function block(blk: Block): string {
  switch (blk.type) {
    case 'p':
      return `<p style="margin:0 0 14px;color:${C.ink};font-size:15px;line-height:1.55">${esc(blk.text)}</p>`;
    case 'note':
      return `<div style="margin:0 0 14px;padding:10px 12px;background:${C.bg};border-left:3px solid ${C.accent};color:${C.sub};font-size:13px;line-height:1.5">${esc(blk.text)}</div>`;
    case 'list':
      return `<ul style="margin:0 0 14px;padding-left:20px;color:${C.ink};font-size:14px;line-height:1.6">${(blk.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'chips':
      return `<div style="margin:0 0 14px">${(blk.items || []).map((i) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;background:${C.chipBg};color:${C.accent};border-radius:999px;font-size:12px">${esc(i)}</span>`).join('')}</div>`;
    case 'kv':
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 14px;border-collapse:collapse">${(blk.items || [])
        .map((r) => `<tr><td style="padding:6px 0;border-bottom:1px solid ${C.line};color:${C.sub};font-size:13px;width:45%">${esc(r.k)}</td><td style="padding:6px 0;border-bottom:1px solid ${C.line};color:${C.ink};font-size:13px;font-weight:600;text-align:right">${esc(r.v)}</td></tr>`)
        .join('')}</table>`;
    case 'table': {
      const head = (blk.head || []).map((h) => `<th style="text-align:left;padding:8px 10px;background:${C.bg};border-bottom:2px solid ${C.line};color:${C.sub};font-size:12px;text-transform:uppercase;letter-spacing:.03em">${esc(h)}</th>`).join('');
      const rows = (blk.rows || [])
        .map((row) => `<tr>${row.map((cell) => `<td style="padding:8px 10px;border-bottom:1px solid ${C.line};color:${C.ink};font-size:13px">${esc(cell)}</td>`).join('')}</tr>`)
        .join('');
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border-collapse:collapse">${head ? `<thead><tr>${head}</tr></thead>` : ''}<tbody>${rows}</tbody></table>`;
    }
    case 'tasks':
      return `<div style="margin:0 0 16px">${(blk.items || [])
        .map((t) => {
          const sev = (t.priority || 'medium').toLowerCase();
          const color = SEV[sev] || SEV.medium;
          return `<div style="margin:0 0 10px;padding:12px 14px;border:1px solid ${C.line};border-radius:8px">` +
            `<span style="display:inline-block;margin:0 0 6px;padding:2px 8px;background:${color};color:#fff;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:.04em">${esc(sev.toUpperCase())}</span>` +
            `<div style="color:${C.ink};font-size:14px;font-weight:600">${esc(t.title)}</div>` +
            (t.detail ? `<div style="color:${C.sub};font-size:13px;line-height:1.5;margin-top:4px">${esc(t.detail)}</div>` : '') +
            `</div>`;
        })
        .join('')}</div>`;
    default:
      return '';
  }
}

/** Full HTML document for a report, suitable to pass straight to nodemailer `html`. */
export function reportToEmailHtml(report: Report, opts: { brand?: string; footer?: string } = {}): string {
  const brand = opts.brand || 'S.A.G.E';
  const body = (report.blocks || []).map(block).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:${C.bg}">` +
    `<div style="max-width:680px;margin:0 auto;padding:24px 16px">` +
    `<div style="background:#ffffff;border:1px solid ${C.line};border-radius:12px;padding:28px">` +
    `<div style="margin:0 0 4px;color:${C.accent};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${esc(report.tag || brand)}</div>` +
    (report.title ? `<h1 style="margin:0 0 20px;color:${C.ink};font-size:22px;line-height:1.3">${esc(report.title)}</h1>` : '') +
    body +
    `</div>` +
    `<div style="text-align:center;color:${C.sub};font-size:12px;padding:16px 0">${esc(opts.footer || `${brand} — automated report`)}</div>` +
    `</div></body></html>`;
}
