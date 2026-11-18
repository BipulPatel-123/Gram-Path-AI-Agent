'use strict';

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ],
  );
const fmt = (date) =>
  date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : 'Check official notice';
const DAY = 86400000;
const money = (amount) => '₹' + Number(amount).toLocaleString('en-IN');

let schemes = [];
let allRecords = [];
let ruleRecords = [];
let articles = [];
let sources = [];
let documents = [];
let adminKey = '';
let checklistRequest = 0;
let currentScheme = null;
let profileVersion = 0;
let usingSchemeDeadline = false;
let docStatuses = {};

try {
  const stored = JSON.parse(localStorage.getItem('gp_doc_states'));
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    docStatuses = stored;
  }
} catch {
  // The checklist still works if browser storage is unavailable.
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (path.startsWith('/api/admin/') && adminKey)
    headers['X-GramPath-Admin'] = adminKey;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error('Could not reach GramPath. Check that npm start is still running and try again.');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(
      'Open the address shown by npm start in your VS Code terminal.',
    );
  }
  const data = await response.json().catch(() => {
    throw new Error('GramPath received an incomplete response. Try again in a moment.');
  });
  if (!response.ok) {
    throw new Error(data.error || 'Request failed (' + response.status + ').');
  }
  return data;
}

function notify(id, message, isError = false) {
  const element = $(id);
  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function initialize() {
  bindEvents();
  try {
    const [health, schemeData, guide, sourceData] = await Promise.all([
      api('/api/health'),
      api('/api/schemes'),
      api('/api/articles'),
      api('/api/sources'),
    ]);
    if (health.admin_enabled) {
      $('data').classList.remove('hidden');
      const link = document.createElement('a');
      link.href = '#data';
      link.textContent = 'Database editor';
      document.querySelector('.footer-row').append(link);
    }
    schemes = schemeData.schemes;
    articles = guide.articles;
    sources = sourceData.sources;
    renderSchemes();
    renderSources();
    await loadDocs();
  } catch (error) {
    $('connectionMessage').textContent = error.message;
    $('connectionMessage').classList.remove('hidden');
    $('docCount').textContent = 'Checklist unavailable';
  }
}

function renderSchemes() {
  const words = $('schemeSearch').value.trim().toLowerCase().split(/\s+/);
  const matching = schemes.filter((scheme) => {
    const searchText = (
      scheme.title +
      ' ' +
      scheme.description +
      ' UP scholarship'
    ).toLowerCase();
    return words.every((word) => searchText.includes(word));
  });
  $('schemeCount').textContent =
    `${matching.length} records · Stored in SQLite`;
  $('schemeCards').innerHTML = matching.length
    ? matching
        .map(
          (s) =>
            `<article class="scheme-card"><span class="tiny-flag">${esc({ dashmottar: 'HIGHER EDUCATION', inter: 'CLASS 11–12', pre: 'CLASS 9–10' }[s.level] || s.level)}</span><h3>${esc(s.title)}</h3><p>${esc(s.description)}</p><div class="row"><span>Fresh deadline on file · ${esc(fmt(s.fresh_deadline))}</span><a href="${safeUrl(s.source_url)}" target="_blank" rel="noopener">Scheme source ↗</a></div></article>`,
        )
        .join('')
    : '<div class="panel">No matching database records. Try another search.</div>';
}
function safeUrl(url) {
  try {
    const u = new URL(url);
    return ['https:', 'http:'].includes(u.protocol) ? esc(u.href) : '#';
  } catch {
    return '#';
  }
}
function renderSources() {
  $('sourceList').innerHTML = sources
    .map(
      (s) =>
        `<div class="source-item"><span class="source-badge ${s.kind === 'secondary' ? 'secondary' : ''}">${s.kind === 'official' ? 'OFFICIAL WEBSITE' : 'DATED NEWS REPORT'}</span><b>${esc(s.name)}</b><p>${esc(s.notes)}</p><a target="_blank" rel="noopener" href="${safeUrl(s.url)}">Open source ↗</a></div>`,
    )
    .join('');
}
function getEligibilityInput() {
  return {
    category: $('category').value,
    level: $('level').value,
    domicile: $('domicile').value,
    study: $('study').value,
    recognised: $('recognised').value,
    passed: $('passed').value,
    application_type: $('applicationType').value,
    income: $('income').value,
  };
}
function renderEligibility(result) {
  const symbols = { pass: '✓', fail: '×', unknown: '!' };
  const labels = {
    pass: 'Meets condition',
    fail: 'Potential issue',
    unknown: 'Needs confirmation',
  };
  const incomeSource = safeUrl(result.income_rule?.source_url);
  const incomeLink = incomeSource === '#'
    ? ''
    : '<a href="' + incomeSource + '" target="_blank" rel="noopener">Income rule source ↗</a>';

  let deadlineNote = 'Check the official notice for the deadline';
  if (result.days_to_deadline !== null) {
    deadlineNote = result.days_to_deadline < 0
      ? 'The deadline on file has passed. Check the official notice for updates.'
      : result.days_to_deadline + ' day(s) until the deadline on file';
  }

  const checks = result.checks.map(({ name, status, reason }) => `
    <div class="check-item">
      <div class="symbol ${esc(status)}" aria-hidden="true">${symbols[status]}</div>
      <div><b>${esc(name)}</b><p>${esc(labels[status])}. ${esc(reason)}</p></div>
    </div>
  `).join('');
  const actions = result.actions.map((action) => `<li>${esc(action)}</li>`).join('');

  $('eligResult').innerHTML = `
    <div class="outcome ${esc(result.status)}">
      <div class="outcome-label">Preliminary result</div>
      <h3>${esc(result.heading)}</h3>
      <p>${esc(result.scheme?.title || 'UP scholarship pathway')}</p>
      <p class="source-pill">${esc(deadlineNote)}</p>
    </div>
    <h3 class="subheading">Why this result?</h3>
    <div class="check-list">${checks}</div>
    <h3 class="subheading">Your next actions</h3>
    <ol class="actions-list">${actions}</ol>
    <div class="disclaimer">
      Confirm your final eligibility and deadline on the UP Scholarship portal. ${incomeLink}
    </div>
    <a class="button secondary" href="https://scholarship.up.gov.in/" target="_blank" rel="noopener">Open official UP portal ↗</a>
  `;
  $('eligEmpty').classList.add('hidden');
  $('eligResult').classList.remove('hidden');
}

function clearEligibilityResult() {
  profileVersion++;
  $('eligResult').classList.add('hidden');
  $('eligEmpty').classList.remove('hidden');
  $('eligError').textContent = '';
  currentScheme = null;

  // A date typed by the student or entered for the demo belongs to the planner.
  if (usingSchemeDeadline) {
    $('planDeadline').value = '';
    usingSchemeDeadline = false;
    calcRisk();
  }
}

async function checkElig(event) {
  event.preventDefault();
  const input = getEligibilityInput();
  const version = profileVersion;
  const button = $('eligForm').querySelector('[type=submit]');
  $('eligError').textContent = '';
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const result = await api('/api/eligibility', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (version !== profileVersion) return;
    renderEligibility(result);
    $('eligResult').focus({ preventScroll: true });
    if (matchMedia('(max-width: 760px)').matches)
      $('eligResult').scrollIntoView({ block: 'start' });
    currentScheme = result.scheme;
    $('planType').value = input.application_type;
    if (!$('planDeadline').value || usingSchemeDeadline) setStoredDeadline();
    await loadDocs();
  } catch (error) {
    if (version === profileVersion) $('eligError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Check eligibility';
  }
}

async function loadDocs() {
  const request = ++checklistRequest;
  const params = new URLSearchParams({
    level: $('level').value || 'dashmottar',
    category: $('category').value || 'general',
  });
  try {
    const data = await api('/api/documents?' + params);
    if (request !== checklistRequest) return;
    documents = data.documents;
    renderDocs();
  } catch (error) {
    if (request !== checklistRequest) return;
    documents = [];
    $('docCount').textContent = 'Checklist unavailable';
    $('docList').textContent = error.message;
    $('docBar').value = 0;
    $('exportChecklist').disabled = true;
  }
}

function setStoredDeadline() {
  if (!currentScheme) return;
  const field =
    $('planType').value === 'renewal' ? 'renewal_deadline' : 'fresh_deadline';
  $('planDeadline').value = currentScheme[field] || '';
  usingSchemeDeadline = Boolean($('planDeadline').value);
  calcRisk();
}

// Comparing date strings counts calendar days across local time changes.
function localISODate(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}

function compareDeadline(deadline, today, processingDays, bufferDays) {
  const remaining = (Date.parse(deadline) - Date.parse(today)) / DAY;
  const needed = processingDays + bufferDays;
  const available = Math.max(remaining, 0);
  const difference = remaining - needed;

  if (remaining < 0) {
    return { available, needed, difference, status: 'passed' };
  }
  if (difference < 0) {
    return { available, needed, difference, status: 'shortfall' };
  }
  return { available, needed, difference, status: difference <= 3 ? 'narrow' : 'ready' };
}

function calcRisk() {
  const message = $('riskMessage');
  const deadline = $('planDeadline').value;
  const processing = $('processingDays');
  const buffer = $('bufferDays');
  message.className = 'risk-message';

  if (!deadline || !processing.validity.valid || !buffer.validity.valid) {
    $('daysAvailable').textContent = '—';
    $('daysNeeded').textContent = '—';
    $('availableBar').value = 0;
    $('neededBar').value = 0;
    message.textContent = deadline
      ? 'Enter a valid number of days for preparation and corrections.'
      : 'Enter a deadline to compare.';
    return;
  }

  const result = compareDeadline(deadline, localISODate(new Date()), processing.valueAsNumber, buffer.valueAsNumber);
  const { available, needed, difference, status } = result;
  const scale = Math.max(available, needed, 1);
  $('daysAvailable').textContent = available;
  $('daysNeeded').textContent = needed;
  $('availableBar').value = available / scale;
  $('neededBar').value = needed / scale;

  const messages = {
    passed: 'The entered deadline has passed. Check the official notice for an extension.',
    shortfall: 'You may run out of time. Your estimate is ' + (-difference) + ' days longer than the time you have left.',
    narrow: 'You have a narrow buffer of ' + difference + ' days.',
    ready: 'You have an estimated buffer of ' + difference + ' days.',
  };
  message.textContent = messages[status];
  if (status === 'passed' || status === 'shortfall') message.classList.add('bad');
  if (status === 'narrow') message.classList.add('warn');
}

function fillDeadlineExample() {
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 5);
  $('planDeadline').value = localISODate(deadline);
  usingSchemeDeadline = false;
  $('processingDays').value = 7;
  $('bufferDays').value = 0;
  calcRisk();
}

function updateDocProgress() {
  const ready = documents.filter((d) => docStatuses[d.id] === 'ready').length;
  const n = documents.length;
  const pct = n ? Math.round((100 * ready) / n) : 0;
  $('docCount').textContent = `${ready} / ${n} ready`;
  $('docBar').value = pct;
}

function renderDocs() {
  updateDocProgress();
  $('exportChecklist').disabled = !documents.length;
  $('docList').innerHTML = documents
    .map(
      (d) =>
        `<div class="doc-row"><div><b>${esc(d.title)}</b><p>${esc(d.instructions)}</p><a href="${safeUrl(d.source_url)}" target="_blank" rel="noopener">Official guidance ↗</a></div><select data-doc="${esc(d.id)}" aria-label="Status for ${esc(d.title)}"><option value="not-started" ${!docStatuses[d.id] || docStatuses[d.id] === 'not-started' ? 'selected' : ''}>Not started</option><option value="in-progress" ${docStatuses[d.id] === 'in-progress' ? 'selected' : ''}>In progress</option><option value="ready" ${docStatuses[d.id] === 'ready' ? 'selected' : ''}>Ready</option><option value="needs-fix" ${docStatuses[d.id] === 'needs-fix' ? 'selected' : ''}>Needs fix</option></select></div>`,
    )
    .join('');
}

function saveDocStatus(event) {
  const field = event.target;
  if (!field.matches('select[data-doc]')) return;
  docStatuses[field.dataset.doc] = field.value;
  try {
    localStorage.setItem('gp_doc_states', JSON.stringify(docStatuses));
  } catch {
    // Progress is still available for this visit.
  }
  updateDocProgress();
}

function exportChecklist() {
  const text = [
    'GramPath - Document checklist',
    'Not official evidence of verification',
    'Generated: ' + new Date().toLocaleString(),
    '',
    ...documents.map(
      (d) =>
        `${d.title} : ${docStatuses[d.id] || 'not-started'}\nHow: ${d.instructions}\nSource: ${d.source_url}\n`,
    ),
  ].join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'grampath-document-checklist.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}
async function scanImage(file) {
  const out = $('scanResult');
  if (!file) return;
  out.innerHTML = '<h3>Checking image locally…</h3>';
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    out.textContent =
      'Choose JPG, PNG or WebP image. PDF analysis is not available in this demo.';
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    const factor = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * factor));
    canvas.height = Math.max(1, Math.round(bitmap.height * factor));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0,
      sum2 = 0,
      n = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const x = 0.21 * bytes[i] + 0.72 * bytes[i + 1] + 0.07 * bytes[i + 2];
      sum += x;
      sum2 += x * x;
      n++;
    }
    const contrast = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
    const warnings = [];
    if (bitmap.width < 900 || bitmap.height < 600)
      warnings.push('Low resolution: text may be unreadable after upload.');
    if (contrast < 28)
      warnings.push('Low contrast: improve lighting or rescan.');
    if (file.size > 5 * 1024 * 1024)
      warnings.push('File is over 5 MB; check the official upload limit.');
    const objectUrl = URL.createObjectURL(file);
    out.innerHTML = `<img alt="Local preview of selected file" class="scan-preview" src="${objectUrl}"><h3>${warnings.length ? 'Image needs review' : 'Basic image quality looks acceptable'}</h3><div class="scan-details"><div><strong>Resolution:</strong> ${bitmap.width} × ${bitmap.height}</div><div><strong>File:</strong> ${(file.size / 1024).toFixed(0)} KB</div><div><strong>Contrast indicator:</strong> ${contrast.toFixed(0)} (heuristic only)</div><div>${warnings.length ? warnings.map((w) => '⚠ ' + esc(w)).join('<br>') : '✓ No obvious resolution/contrast issue identified.'}</div><div><strong>Not checked:</strong> document authenticity, identity, OCR fields, government acceptance.</div></div>`;
    setTimeout(() => URL.revokeObjectURL(objectUrl), 20000);
    bitmap.close?.();
  } catch (e) {
    out.textContent = 'Could not analyse this image: ' + e.message;
  }
}
function findAnswer() {
  const q = $('askInput').value.toLowerCase().trim();
  const el = $('askAnswer');
  if (!q) {
    el.textContent = 'Type a question first.';
    return;
  }
  const vocab = {
    income: ['income', 'आय', 'certificate'],
    rejected: ['reject', 'error', 'wrong', 'upload', 'blur'],
    verify: ['verify', 'valid', 'authentic', 'सत्यापन'],
    payment: ['payment', 'dbt', 'bank', 'unpaid', 'scholarship money', 'पैसा'],
    deadline: ['deadline', 'late', 'date', 'last'],
    help: ['help', 'office', 'csc', 'centre', 'center'],
  };
  const scored = articles
    .map((a) => {
      let hits = 0;
      for (const w of vocab[a.tag] || []) if (q.includes(w)) hits += 2;
      for (const w of q.split(/\W+/).filter((x) => x.length > 3))
        if ((a.title + ' ' + a.body).toLowerCase().includes(w)) hits++;
      return { a, hits };
    })
    .sort((x, y) => y.hits - x.hits);
  if (!scored.length || scored[0].hits < 1) {
    el.innerHTML =
      'No reliable answer found in the stored guide. Please use <a href="https://scholarship.up.gov.in/" target="_blank" rel="noopener">the official UP scholarship portal</a> or ask your college scholarship desk.';
    return;
  }
  const a = scored[0].a;
  el.innerHTML = `<b>${esc(a.title)}</b><br>${esc(a.body)}<br><a target="_blank" rel="noopener" href="${safeUrl(a.source_url)}">Open official source ↗</a><br>`;
}
function paymentSteps() {
  const key = $('paymentIssue').value;
  const common = [
    'Check current application status on the UP Scholarship portal.',
    'Confirm the institute or department verification stage and whether correction is required.',
    'For relevant payments, check the official PFMS status service.',
  ];
  const more = {
    pending: [
      'Do not assume a missing payment means approval was denied; payment schedules vary.',
    ],
    approved: [
      'Ask the institution scholarship cell whether sanction and DBT stages are complete.',
    ],
    dbt: [
      'Contact your bank to confirm Aadhaar/NPCI mapping for DBT, if required by your specific scholarship.',
    ],
    rejected: [
      'Read the official payment failure or rejection reason and follow the stated correction instructions.',
    ],
    unknown: [
      'Ask the institute/department to explain the exact status message before changing any information.',
    ],
  };
  const items = [...common, ...(more[key] || [])];
  $('paymentResult').innerHTML =
    `<span class="pill">Payment guidance</span><h3>Your recommended next steps</h3><ol>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ol><a href="https://scholarship.up.gov.in/" target="_blank" rel="noopener">UP Scholarship portal ↗</a><a href="https://pfms.nic.in/" target="_blank" rel="noopener">PFMS official website ↗</a>`;
}
async function refreshAdmin() {
  const response = await api('/api/admin/schemes');
  allRecords = response.schemes;
  $('adminRecords').innerHTML = allRecords
    .map(
      (r) =>
        `<div class="admin-item"><div><strong>${esc(r.title)}</strong><small>${esc(r.id)} · Fresh date on file: ${esc(fmt(r.fresh_deadline))}</small></div><button type="button" data-record="${esc(r.id)}">Edit</button></div>`,
    )
    .join('');
  document
    .querySelectorAll('[data-record]')
    .forEach((el) =>
      el.addEventListener('click', () => editRecord(el.dataset.record)),
    );
}
function editRecord(id) {
  const r = allRecords.find((x) => x.id === id);
  if (!r) return;
  $('dataId').value = r.id;
  $('dataLevel').value = r.level;
  $('dataTitle').value = r.title;
  $('dataDesc').value = r.description;
  $('dataFresh').value = r.fresh_deadline || '';
  $('dataRenew').value = r.renewal_deadline || '';
  $('dataUrl').value = r.source_url || '';
  $('dataNotes').value = r.notes || '';
  $('dataForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  notify('saveMessage', 'Editing ' + r.id + ' — Save to update the database.');
}
async function saveRecord(ev) {
  ev.preventDefault();
  const input = {
    id: $('dataId').value.trim(),
    level: $('dataLevel').value,
    title: $('dataTitle').value.trim(),
    description: $('dataDesc').value.trim(),
    fresh_deadline: $('dataFresh').value,
    renewal_deadline: $('dataRenew').value,
    source_url: $('dataUrl').value.trim(),
    notes: $('dataNotes').value.trim(),
  };
  try {
    await api('/api/admin/schemes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    notify('saveMessage', 'Saved to SQLite! Scheme explorer is refreshed.');
    const r = await api('/api/schemes');
    schemes = r.schemes;
    renderSchemes();
    await refreshAdmin();
  } catch (e) {
    notify('saveMessage', e.message, true);
  }
}

async function refreshRules() {
  const data = await api('/api/admin/rules');
  ruleRecords = data.rules;
  $('ruleTable').innerHTML = ruleRecords
    .map(
      (r) =>
        `<div class="rule-item"><b>${esc(r.category.toUpperCase())}</b><small>Baseline: ${money(r.confirmed_base_cap)}<br>Announced upper: ${money(r.announced_cap)}</small><button data-rule="${esc(r.category)}" type="button">Edit income rule →</button></div>`,
    )
    .join('');
  document
    .querySelectorAll('[data-rule]')
    .forEach((el) =>
      el.addEventListener('click', () => editRule(el.dataset.rule)),
    );
}
function editRule(cat) {
  const r = ruleRecords.find((x) => x.category === cat);
  if (!r) return;
  $('ruleCat').value = r.category;
  $('ruleBase').value = r.confirmed_base_cap;
  $('ruleUpper').value = r.announced_cap;
  $('ruleUrl').value = r.source_url || '';
  $('ruleNotes').value = r.notes || '';
  $('ruleForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function saveRule(ev) {
  ev.preventDefault();
  const data = {
    category: $('ruleCat').value,
    confirmed_base_cap: +$('ruleBase').value,
    announced_cap: +$('ruleUpper').value,
    source_url: $('ruleUrl').value,
    notes: $('ruleNotes').value,
  };
  try {
    await api('/api/admin/rules', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    await refreshRules();
    notify(
      'ruleMessage',
      'Rule saved. Run the eligibility checker again to see the updated result.',
    );
  } catch (e) {
    notify('ruleMessage', e.message, true);
  }
}

async function unlockAdmin() {
  const v = $('adminKey').value.trim();
  if (!v) {
    notify('adminStatus', 'Enter the admin key printed in the terminal.', true);
    return;
  }
  adminKey = v;
  try {
    await Promise.all([refreshAdmin(), refreshRules()]);
    $('adminWorkspace').classList.remove('hidden');
    $('adminKey').value = '';
    notify(
      'adminStatus',
      'Editor unlocked for this page session. Changes will update SQLite.',
    );
  } catch (e) {
    adminKey = '';
    $('adminWorkspace').classList.add('hidden');
    notify('adminStatus', 'Access denied: ' + e.message, true);
  }
}
function lockAdmin() {
  adminKey = '';
  $('adminKey').value = '';
  $('adminWorkspace').classList.add('hidden');
  notify('adminStatus', 'Editor locked.');
}

function bindEvents() {
  $('unlockAdmin').addEventListener('click', unlockAdmin);
  $('lockAdmin').addEventListener('click', lockAdmin);
  $('eligForm').addEventListener('submit', checkElig);
  $('eligForm').addEventListener('input', clearEligibilityResult);

  $('fillDemo').addEventListener('click', () => {
    clearEligibilityResult();
    $('domicile').value = 'yes';
    $('category').value = 'ews';
    $('level').value = 'dashmottar';
    $('applicationType').value = 'fresh';
    $('income').value = '150000';
    $('study').value = 'up';
    $('recognised').value = 'yes';
    $('passed').value = 'yes';
    loadDocs();
  });
  $('schemeSearch').addEventListener('input', renderSchemes);
  $('exportChecklist').addEventListener('click', exportChecklist);
  $('docList').addEventListener('change', saveDocStatus);
  $('planDeadline').addEventListener('input', () => {
    usingSchemeDeadline = false;
    calcRisk();
  });
  $('processingDays').addEventListener('input', calcRisk);
  $('bufferDays').addEventListener('input', calcRisk);
  $('deadlineForm').addEventListener('submit', (event) => {
    event.preventDefault();
    calcRisk();
  });
  $('planType').addEventListener('change', setStoredDeadline);
  $('fillDeadline').addEventListener('click', fillDeadlineExample);
  $('fileCheck').addEventListener('change', (ev) =>
    scanImage(ev.target.files[0]),
  );
  $('askButton').addEventListener('click', findAnswer);
  $('askInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      findAnswer();
    }
  });
  document.querySelectorAll('[data-question]').forEach((btn) =>
    btn.addEventListener('click', () => {
      $('askInput').value = btn.dataset.question;
      findAnswer();
    }),
  );
  $('findCentre').addEventListener('click', () => {
    const district = $('district').value.trim();
    const q =
      (district ? district + ' ' : '') +
      'official common service centre CSC eDistrict Uttar Pradesh';
    window.open(
      'https://www.google.com/search?q=' + encodeURIComponent(q),
      '_blank',
      'noopener',
    );
  });
  $('paymentAction').addEventListener('click', paymentSteps);
  $('dataForm').addEventListener('submit', saveRecord);
  $('ruleForm').addEventListener('submit', saveRule);
  $('ruleCat').addEventListener('change', () => editRule($('ruleCat').value));
  $('level').addEventListener('change', loadDocs);
  $('category').addEventListener('change', loadDocs);
}
window.addEventListener('DOMContentLoaded', initialize);
