import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const sample = {
  category: 'ews', level: 'dashmottar', domicile: 'yes', study: 'up',
  recognised: 'yes', passed: 'yes', application_type: 'fresh', income: 150000,
};

let gateway;
let gatewayExit;
let directory;
let origin;

async function waitFor(check, description, timeout = 5000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    if (await check()) return;
    await delay(30);
  }
  assert.fail('Timed out waiting for ' + description);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grampath-test-'));

  const portFinder = createServer();
  portFinder.listen(0, '127.0.0.1');
  await once(portFinder, 'listening');
  const pythonPort = portFinder.address().port;
  await new Promise((resolve) => portFinder.close(resolve));

  gateway = fork(join(root, 'gateway.js'), {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '0',
      INTERNAL_PYTHON_PORT: String(pythonPort),
      ENABLE_ADMIN: 'false',
      CLOUDFLARE_TUNNEL: 'false',
      GRAMPATH_DB_PATH: join(directory, 'test.sqlite3'),
    },
    silent: true,
  });
  gatewayExit = once(gateway, 'exit');
  let logs = '';
  gateway.stdout.on('data', (chunk) => { logs += chunk; });
  gateway.stderr.on('data', (chunk) => { logs += chunk; });

  try {
    await waitFor(async () => {
      if (gateway.exitCode !== null) throw new Error('Gateway stopped during startup.');
      origin = logs.match(/Open: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (!origin) return false;
      try {
        const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) });
        return response.ok;
      } catch {
        return false;
      }
    }, 'the Node and Python servers', 15000);
  } catch (error) {
    throw new Error('Could not start GramPath for testing.\n' + logs, { cause: error });
  }
});

after(async () => {
  if (gateway?.connected) gateway.disconnect();
  if (gatewayExit) await gatewayExit;
  if (directory) await rm(directory, { recursive: true, force: true });
});

function eligibility(profile) {
  return fetch(origin + '/api/eligibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(profile),
  });
}

test('the two stored income boundaries give the expected screening results', async () => {
  const cases = [
    [200000, 'likely', 'pass'],
    [200001, 'review', 'unknown'],
    [250000, 'review', 'unknown'],
    [250001, 'unlikely', 'fail'],
  ];
  for (const [income, status, incomeStatus] of cases) {
    const response = await eligibility({ ...sample, income });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, status, 'Income ' + income);
    const incomeCheck = result.checks.find((check) => check.name === 'Annual family income');
    assert.equal(incomeCheck.status, incomeStatus);
  }
});

test('unknown answers and renewal dates are reported without changing the income result', async () => {
  const response = await eligibility({ ...sample, income: '', study: 'outside', application_type: 'renewal' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'review');
  const timing = result.checks.find((check) => check.name === 'Application timing');
  assert.match(timing.reason, /renewal deadline/);
  assert.match(timing.reason, new RegExp(result.scheme.renewal_deadline));
});

test('invalid income and an unsupported course get clear validation errors', async () => {
  for (const [input, message] of [
    [{ income: -1 }, /income as a whole number/],
    [{ income: 100.5 }, /income as a whole number/],
    [{ income: true }, /income as a whole number/],
    [{ income: 'abc' }, /income as a whole number/],
    [{ level: ['pre'] }, /valid option for course or class/],
    [{ application_type: 'other' }, /valid option for application type/],
  ]) {
    const response = await eligibility({ ...sample, ...input });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, message);
  }
});

test('the document API adjusts the checklist for the course and category', async () => {
  const base = await fetch(origin + '/api/documents?level=pre&category=general');
  const other = await fetch(origin + '/api/documents?level=dashmottar&category=obc');
  const standard = (await base.json()).documents.map((doc) => doc.id);
  const detailed = (await other.json()).documents.map((doc) => doc.id);
  assert.ok(standard.includes('income'));
  assert.ok(!standard.includes('category'));
  assert.ok(detailed.includes('category'));
  assert.ok(detailed.includes('fees'));
});

test('normal pages keep the security headers and private files stay private', async () => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(origin + '/api/admin/schemes')).status, 403);
  assert.equal((await fetch(origin + '/grampath.sqlite3')).status, 404);

  const response = await fetch(origin + '/api/eligibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match((await response.json()).error, /could not be read/);
});

async function openPage(t, storedStatuses) {
  const [response, script] = await Promise.all([
    fetch(origin),
    readFile(join(root, 'assets/app.js'), 'utf8'),
  ]);
  const dom = new JSDOM(await response.text(), {
    url: origin, runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const window = dom.window;
  window.matchMedia = () => ({ matches: false });
  window.fetch = (path, options) => fetch(new URL(path, origin), options);
  if (storedStatuses !== undefined) {
    window.localStorage.setItem('gp_doc_states', storedStatuses);
  }
  window.eval(script);
  if (window.document.readyState !== 'loading') {
    window.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  const get = (id) => window.document.getElementById(id);
  await waitFor(() => get('docCount').textContent.includes('ready'), 'the document checklist');
  return { window, get };
}

test('the sample profile works and editing it clears the result and old scheme date', async (t) => {
  const { window, get } = await openPage(t);
  get('fillDemo').click();
  get('eligForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => get('eligResult').textContent.includes('Meets the checked basic conditions'), 'eligibility');
  assert.ok(get('planDeadline').value);
  get('income').value = '225000';
  get('income').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.ok(get('eligResult').classList.contains('hidden'));
  assert.equal(get('planDeadline').value, '');
});

test('an unavailable server gives a clear message and lets the student retry', async (t) => {
  const { window, get } = await openPage(t);
  window.fetch = async () => { throw new TypeError('Network error'); };
  get('fillDemo').click();
  get('eligForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => get('eligError').textContent.includes('Could not reach GramPath'), 'the error message');
  assert.equal(get('eligForm').querySelector('[type=submit]').disabled, false);
});

test('the checklist keeps focus and restores the saved status on reopening', async (t) => {
  const { window, get } = await openPage(t, '"invalid saved value"');
  const field = get('docList').querySelector('select[data-doc="income"]');
  field.focus();
  field.value = 'ready';
  field.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(get('docCount').textContent, /^1 \//);
  assert.equal(window.document.activeElement, field);
  const saved = window.localStorage.getItem('gp_doc_states');
  assert.equal(JSON.parse(saved).income, 'ready');

  const reopened = await openPage(t, saved);
  assert.equal(reopened.get('docList').querySelector('select[data-doc="income"]').value, 'ready');
});

test('the deadline demo shows a two-day shortfall, then updates when estimates change', async (t) => {
  const { window, get } = await openPage(t);
  get('fillDeadline').click();
  assert.equal(get('daysAvailable').textContent, '5');
  assert.equal(get('daysNeeded').textContent, '7');
  assert.match(get('riskMessage').textContent, /2 days longer/);

  const processing = get('processingDays');
  processing.value = '-1';
  processing.dispatchEvent(new window.Event('input'));
  assert.equal(get('daysNeeded').textContent, '—');
  assert.match(get('riskMessage').textContent, /valid number/);

  processing.value = '0';
  processing.dispatchEvent(new window.Event('input'));
  assert.equal(get('daysNeeded').textContent, '0');
  assert.match(get('riskMessage').textContent, /buffer of 5 days/);

  get('planDeadline').value = '2000-01-01';
  get('planDeadline').dispatchEvent(new window.Event('input'));
  assert.match(get('riskMessage').textContent, /deadline has passed/);
});

test('the eligibility API applies its request limit', async () => {
  for (let i = 0; i < 21; i++) {
    const response = await eligibility(sample);
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      return;
    }
    assert.equal(response.status, 200);
  }
  assert.fail('Expected the eligibility limiter to return 429');
});
