import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config';
import { api } from './routes';
import { llmInfo } from './llm';
import { requireAuth, handleLogin, handleLogout } from './auth';
import { emailConfigured } from './lib/email';
import { imapConfigured } from './sources/mailbox';
import { initFollowupScheduler } from './services/followup';
import { initReplyPoller } from './services/reply';
import { initClientCareScheduler } from './services/clientcare';

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

app.listen(config.port, () => {
  const l = llmInfo();
  console.log('');
  console.log('  ███  N.O.V.A — Business Development agent');
  console.log(`  ▸ http://localhost:${config.port}`);
  console.log(`  ▸ Agency: ${config.agency.name}`);
  console.log(`  ▸ LLM: ${l.provider} / ${l.model} ${l.configured ? '✓' : '✗ (set LLM_API_KEY in .env)'}`);
  console.log(`  ▸ Email(SMTP): ${emailConfigured() ? 'on' : 'off'}   Inbox(IMAP): ${imapConfigured() ? 'on' : 'off'}   Calendar: ${config.meeting.googleCalendarToken ? 'on' : 'off'}`);
  if (config.auth.enabled) {
    console.log(`  ▸ Auth: ON (user "${config.auth.username}")`);
    if (config.auth.password === 'admin' || config.auth.secret === 'nova-dev-secret-change-me') {
      console.log('    ⚠ Using default credentials/secret — set AUTH_USERNAME, AUTH_PASSWORD, AUTH_SECRET in .env');
    }
  } else {
    console.log('  ▸ Auth: OFF');
  }
  // Arm the background workers. All are no-ops unless their integrations are set.
  void initFollowupScheduler();  // daily follow-up queue check (node-cron)
  void initClientCareScheduler(); // daily birthday/anniversary/check-in (node-cron)
  initReplyPoller();              // IMAP inbox poll (only if IMAP configured)
  console.log('');
});
