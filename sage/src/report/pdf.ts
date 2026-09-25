import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, readFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { config } from '../config';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_SCRIPT = join(HERE, '..', '..', 'python', 'html_to_pdf.py');

/**
 * Render an HTML string to a PDF Buffer via the bundled Playwright/Chromium
 * script (same runtime the SERP fetcher uses). Writes the HTML to a temp file,
 * spawns Python to produce the PDF, reads it back, and cleans up.
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'sage-pdf-'));
  const htmlPath = join(dir, 'report.html');
  const pdfPath = join(dir, 'report.pdf');
  await writeFile(htmlPath, html, 'utf8');

  try {
    await runPython([htmlPath, pdfPath]);
    return await readFile(pdfPath);
  } finally {
    unlink(htmlPath).catch(() => {});
    unlink(pdfPath).catch(() => {});
  }
}

function runPython(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.serp.pythonBin, [PDF_SCRIPT, ...args], { env: { ...process.env } });
    let errOut = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PDF render timed out')); }, 120000);
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`cannot run python (${config.serp.pythonBin}): ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(errOut.trim().slice(0, 300) || `PDF render exited ${code}`));
    });
  });
}
