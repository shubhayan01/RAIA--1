import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config';
import { api } from './routes';
import { llmInfo } from './llm';
import { requireAuth, handleLogin, handleLogout } from './auth';
import { initScheduler } from './services/scheduler';
import { initAlerts } from './services/alerts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// 8mb: the execution-layer routes (meta push, brief push) round-trip full audit /
// brief `data` objects from the browser, which can embed large third-party payloads.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));

const publicDir = join(__dirname, '..', 'public');

// ---- Auth (public endpoints) ----
app.get('/login', (_req, res) => res.sendFile(join(publicDir, 'login.html')));
app.post('/api/login', handleLogin);
app.get('/api/logout', handleLogout);
app.post('/api/logout', handleLogout);

// Gate the shell explicitly so it can't be fetched straight from static.
app.get(['/', '/index.html'], requireAuth, (_req, res) => res.sendFile(join(publicDir, 'index.html')));

// Static assets (css/js/images) — not sensitive; index disabled so '/' stays gated.
app.use(express.static(publicDir, { index: false }));

// ---- API (gated) ----
app.use('/api', requireAuth, api);

// ---- App shell (gated) ----
app.get('*', requireAuth, (_req, res) => res.sendFile(join(publicDir, 'index.html')));

app.listen(config.port, () => {
  const l = llmInfo();
  console.log('');
  console.log('  ███  S.A.G.E — SEO agent');
  console.log(`  ▸ http://localhost:${config.port}`);
  console.log(`  ▸ LLM: ${l.provider} / ${l.model} ${l.configured ? '✓' : '✗ (set LLM_API_KEY in .env)'}`);
  console.log(`  ▸ SERP: ${config.serp.provider}   Keywords: ${config.keywords.provider}`);
  if (config.auth.enabled) {
    console.log(`  ▸ Auth: ON (user "${config.auth.username}")`);
    if (config.auth.password === 'admin' || config.auth.secret === 'sage-dev-secret-change-me') {
      console.log('    ⚠ Using default credentials/secret — set AUTH_USERNAME, AUTH_PASSWORD, AUTH_SECRET in .env');
    }
  } else {
    console.log('  ▸ Auth: OFF');
  }
  // Execution layer: arm the monthly report scheduler + re-arm ranking alerts.
  // Both are no-ops unless SCHEDULER_ENABLED / ALERTS_ENABLED are set.
  void initScheduler();
  void initAlerts();
  console.log('');
});
