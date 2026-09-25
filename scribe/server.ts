import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config';
import { api } from './routes';
import { llmInfo } from './llm';
import { serpEnabled } from './sources/serp';
import { requireAuth, handleLogin, handleLogout } from './auth';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));

const publicDir = join(__dirname, 'public');

// ---- Auth (public endpoints) ----
app.get('/login', (_req, res) => res.sendFile(join(publicDir, 'login.html')));
app.post('/api/login', handleLogin);
app.get('/api/logout', handleLogout);
app.post('/api/logout', handleLogout);

// Gate the shell explicitly so it can't be fetched straight from static.
app.get(['/', '/index.html'], requireAuth, (_req, res) => res.sendFile(join(publicDir, 'index.html')));

// Static assets (css/js) — index disabled so '/' stays gated.
app.use(express.static(publicDir, { index: false }));

// ---- API (gated) ----
app.use('/api', requireAuth, api);

// ---- App shell (gated) ----
app.get('*', requireAuth, (_req, res) => res.sendFile(join(publicDir, 'index.html')));

const server = app.listen(config.port, () => {
  const l = llmInfo();
  console.log('');
  console.log('  ███  S.C.R.I.B.E — Content Automation agent');
  console.log(`  ▸ http://localhost:${config.port}`);
  console.log(`  ▸ Brand: ${config.brand.name}`);
  console.log(`  ▸ LLM: ${l.provider} / ${l.model} ${l.configured ? '✓' : '✗ (set LLM_API_KEY in .env)'}`);
  console.log(`  ▸ Search(SERP): ${serpEnabled() ? `on · ${config.serp.provider}` : 'off'}${config.serp.provider === 'tavily' && !config.serp.tavilyKey ? '  ⚠ set TAVILY_API_KEY' : ''}`);
  if (config.auth.enabled) {
    console.log(`  ▸ Auth: ON (user "${config.auth.username}")`);
    if (config.auth.password === 'admin' || config.auth.secret === 'scribe-dev-secret-change-me') {
      console.log('    ⚠ Using default credentials/secret — set AUTH_USERNAME, AUTH_PASSWORD, AUTH_SECRET in .env');
    }
  } else {
    console.log('  ▸ Auth: OFF');
  }
  console.log('');
});

// A single tool request runs the whole pipeline (research → evidence → write →
// gate) synchronously and can take several minutes on a slow or rate-limited LLM
// tier. Node 18+ defaults requestTimeout to 5 min, which would abort a long run
// mid-flight — the browser then shows "Failed to fetch". Disable the built-in
// timeouts so a legitimate long run completes; this is a local, single-user tool.
server.requestTimeout = 0;   // no cap on receiving/holding the request
server.headersTimeout = 0;   // no cap on header receipt
server.setTimeout(0);        // no socket inactivity timeout
server.keepAliveTimeout = 75_000;
