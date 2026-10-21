'use strict';
/* NEXUS // AI WebUI */
const MOD = '/data/adb/modules/nexus_ai';
const CLI = `sh ${MOD}/nexus.sh`;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HAS_KSU = typeof window.ksu !== 'undefined' && typeof window.ksu.exec === 'function';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- shell bridge ---------- */
let cbn = 0;
function exec(cmd) {
  return new Promise(resolve => {
    if (!HAS_KSU) return resolve(mock(cmd));
    const name = `__nexus_cb_${Date.now()}_${cbn++}`;
    window[name] = (errno, stdout, stderr) => { delete window[name]; resolve({ errno, stdout: stdout || '', stderr: stderr || '' }); };
    try { window.ksu.exec(cmd, '{}', name); } catch (e) { delete window[name]; resolve({ errno: 1, stdout: '', stderr: String(e) }); }
  });
}
const cli = a => exec(`${CLI} ${a}`);
async function cliJSON(a, fb) {
  const r = await cli(a);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  try { return JSON.parse(lines[lines.length - 1]); } catch (e) { return fb; }
}
const q = s => `'${String(s).replace(/'/g, '')}'`;
const qBody = s => { const b64 = btoa(unescape(encodeURIComponent(s))); return b64; };

/* ---------- presets ---------- */
const PRESETS = {
  openai:     { name: 'OpenAI',      base: 'https://api.openai.com/v1',           models: '/models',                           chat: '/chat/completions', type: 'openai' },
  anthropic:  { name: 'Anthropic',   base: 'https://api.anthropic.com/v1',        models: null,                                chat: '/messages',         type: 'anthropic' },
  gemini:     { name: 'Gemini',      base: 'https://generativelanguage.googleapis.com/v1beta', models: '/models', chat: null, type: 'gemini' },
  deepseek:   { name: 'DeepSeek',    base: 'https://api.deepseek.com/v1',         models: '/models',                           chat: '/chat/completions', type: 'openai' },
  mistral:    { name: 'Mistral',     base: 'https://api.mistral.ai/v1',           models: '/models',                           chat: '/chat/completions', type: 'openai' },
  xai:        { name: 'xAI (Grok)',  base: 'https://api.x.ai/v1',                models: '/models',                           chat: '/chat/completions', type: 'openai' },
  groq:       { name: 'Groq',        base: 'https://api.groq.com/openai/v1',     models: '/models',                           chat: '/chat/completions', type: 'openai' },
  openrouter: { name: 'OpenRouter',  base: 'https://openrouter.ai/api/v1',       models: '/models',                           chat: '/chat/completions', type: 'openai' },
  custom:     { name: 'Custom',      base: '',                                    models: '/models',                           chat: '/chat/completions', type: 'openai' }
};

/* ---------- state ---------- */
const S = {
  providers: [], models: new Map(), activeProvider: '', activeModel: '',
  messages: [], chatId: '', streaming: false, systemPrompt: '',
  tools: {}, tab: 'chat', ghToken: '', ghRepos: []
};

/* ---------- ui helpers ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800); }
function openSheet(html, bind) { $('#sheet').innerHTML = html; $('#sheetBg').classList.add('on'); $('#sheet').scrollTop = 0; if (bind) bind($('#sheet')); }
function closeSheet() { $('#sheetBg').classList.remove('on'); }
$('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });

/* ---------- loading ---------- */
async function loadProviders() {
  S.providers = await cliJSON('keys', []);
}
async function loadAll() {
  S.tools = await cliJSON('tools', {});
  await loadProviders();
  S.systemPrompt = localStorage.getItem('nexus.system') || '';
  S.ghToken = localStorage.getItem('nexus.ghtoken') || '';
  if (S.ghToken) $('#ghToken').value = '••••••••';
  const last = localStorage.getItem('nexus.active');
  if (last) { const [p, m] = last.split('::'); S.activeProvider = p; S.activeModel = m || ''; }
  renderAll();
  if (S.activeProvider) fetchModelsFor(S.activeProvider);
}

/* ---------- model selector ---------- */
function updateModelSel() {
  const sel = $('#modelSel');
  const allModels = [];
  for (const [pid, list] of S.models) {
    const prov = S.providers.find(p => p.id === pid);
    const pname = prov ? prov.name : pid;
    for (const m of list) allModels.push({ pid, model: m, label: `${pname}: ${m}` });
  }
  if (!allModels.length) { sel.innerHTML = '<option>No models loaded</option>'; return; }
  sel.innerHTML = allModels.map(m => `<option value="${esc(m.pid + '::' + m.model)}" ${m.pid === S.activeProvider && m.model === S.activeModel ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  if (!S.activeModel && allModels.length) {
    S.activeProvider = allModels[0].pid; S.activeModel = allModels[0].model;
    sel.value = allModels[0].pid + '::' + allModels[0].model;
  }
}
$('#modelSel').onchange = e => {
  const [p, m] = e.target.value.split('::');
  S.activeProvider = p; S.activeModel = m;
  localStorage.setItem('nexus.active', e.target.value);
  renderHeader();
};

/* ---------- fetch models ---------- */
async function fetchModelsFor(pid) {
  const prov = S.providers.find(p => p.id === pid);
  if (!prov) return;
  const preset = Object.values(PRESETS).find(p => p.base === prov.base) || PRESETS.custom;
  const type = prov.type || preset.type;
  let models = [];
  try {
    if (type === 'anthropic') {
      models = ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-5-20241022', 'claude-3-5-sonnet-20241022'];
    } else if (type === 'gemini') {
      const r = await proxyReq(pid, 'GET', 'models');
      const j = typeof r === 'string' ? JSON.parse(r) : r;
      models = (j.models || []).filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')).map(m => m.name.replace('models/', ''));
    } else {
      const r = await proxyReq(pid, 'GET', 'models');
      const j = typeof r === 'string' ? JSON.parse(r) : r;
      models = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean).sort();
    }
  } catch (e) { toast('Could not fetch models: ' + e.message); }
  if (models.length) {
    S.models.set(pid, models);
    if (!S.activeModel || S.activeProvider === pid) {
      S.activeProvider = pid;
      S.activeModel = models.includes(S.activeModel) ? S.activeModel : models[0];
    }
    updateModelSel();
    renderProviders();
  }
  return models;
}

/* ---------- proxy requests ---------- */
async function proxyReq(pid, method, path, body) {
  // Try direct fetch first (works when no CORS)
  const prov = S.providers.find(p => p.id === pid);
  if (!prov) throw new Error('provider not found');
  try {
    const r = await cli(`proxy ${q(pid)} ${q(method)} ${q(path)} ${body ? q(body) : "''"}`);
    if (r.stdout.trim()) return r.stdout.trim();
  } catch (e) { /* fall through */ }
  throw new Error('request failed');
}

/* ---------- chat ---------- */
function renderMessages() {
  const box = $('#messages');
  if (!S.messages.length) {
    box.innerHTML = `<div class="empty" style="padding-top:30vh">
      <div style="font-size:32px;margin-bottom:12px">🧠</div>
      <div style="color:var(--ac);font-weight:700;margin-bottom:6px">NEXUS // AI</div>
      <div>Pick a model from the top bar, then start chatting.</div>
    </div>`;
    return;
  }
  box.innerHTML = S.messages.map((m, i) => {
    if (m.role === 'system') return `<div class="msg system">${esc(m.content.slice(0, 100))}...</div>`;
    const cls = m.role === 'user' ? 'user' : 'ai';
    const tag = m.role === 'assistant' && m.model ? `<div class="model-tag">${esc(m.model)}</div>` : '';
    return `<div class="msg ${cls}" data-i="${i}">${tag}${formatMsg(m.content)}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function formatMsg(text) {
  // Simple code block and inline code formatting
  let s = esc(text);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return s;
}

async function sendMessage() {
  const input = $('#msgInput');
  const text = input.value.trim();
  if (!text || S.streaming) return;
  if (!S.activeProvider || !S.activeModel) return toast('Pick a model first');

  input.value = ''; input.style.height = 'auto';
  S.messages.push({ role: 'user', content: text });
  renderMessages();

  const prov = S.providers.find(p => p.id === S.activeProvider);
  if (!prov) return toast('Provider not found');
  const type = prov.type || 'openai';

  S.streaming = true;
  $('#sendBtn').disabled = true;
  S.messages.push({ role: 'assistant', content: '', model: `${prov.name} / ${S.activeModel}` });
  renderMessages();

  try {
    let body, path;
    const msgs = [];
    if (S.systemPrompt) msgs.push({ role: 'system', content: S.systemPrompt });
    for (const m of S.messages) {
      if (m.role === 'user' || (m.role === 'assistant' && m.content)) msgs.push({ role: m.role, content: m.content });
    }
    // Remove the last empty assistant message from the request
    if (msgs.length && msgs[msgs.length - 1].role === 'assistant' && !msgs[msgs.length - 1].content) msgs.pop();

    if (type === 'anthropic') {
      const sysMsg = S.systemPrompt || undefined;
      const userMsgs = msgs.filter(m => m.role !== 'system');
      body = JSON.stringify({ model: S.activeModel, max_tokens: 4096, system: sysMsg, messages: userMsgs });
      path = 'messages';
    } else if (type === 'gemini') {
      const contents = msgs.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const si = S.systemPrompt ? { systemInstruction: { parts: [{ text: S.systemPrompt }] } } : {};
      body = JSON.stringify({ contents, ...si, generationConfig: { maxOutputTokens: 4096 } });
      path = `models/${S.activeModel}:generateContent`;
    } else {
      body = JSON.stringify({ model: S.activeModel, messages: msgs, max_tokens: 4096 });
      path = 'chat/completions';
    }

    const raw = await proxyReq(S.activeProvider, 'POST', path, body);
    let reply = '';
    try {
      const j = JSON.parse(raw);
      if (j.error) { reply = `Error: ${j.error.message || JSON.stringify(j.error)}`; }
      else if (type === 'anthropic') { reply = (j.content || []).map(c => c.text).join(''); }
      else if (type === 'gemini') { reply = ((j.candidates || [])[0] || {}).content ? j.candidates[0].content.parts.map(p => p.text).join('') : 'No response'; }
      else { reply = (j.choices || [])[0] ? (j.choices[0].message || {}).content || '' : 'No response'; }
    } catch (e) { reply = raw.slice(0, 2000); }

    S.messages[S.messages.length - 1].content = reply;
  } catch (e) {
    S.messages[S.messages.length - 1].content = `Error: ${e.message}`;
  }

  S.streaming = false;
  $('#sendBtn').disabled = false;
  renderMessages();
  autoSaveChat();
}

$('#sendBtn').onclick = sendMessage;
$('#msgInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
$('#msgInput').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; });

/* ---------- chat persistence ---------- */
function autoSaveChat() {
  if (!S.chatId) S.chatId = 'c' + Date.now();
  const data = JSON.stringify({ id: S.chatId, model: `${S.activeProvider}::${S.activeModel}`, messages: S.messages, ts: Date.now() });
  cli(`save ${q(S.chatId)} ${q(data)}`);
}
function newChat() {
  S.chatId = ''; S.messages = [];
  renderMessages();
}
async function loadChat(id) {
  const raw = await cli(`load ${q(id)}`);
  try {
    const j = JSON.parse(raw.stdout.trim());
    S.chatId = j.id || id;
    S.messages = j.messages || [];
    if (j.model) {
      const [p, m] = j.model.split('::');
      if (p && m) { S.activeProvider = p; S.activeModel = m; updateModelSel(); }
    }
    renderMessages();
    gotoTab('chat');
  } catch (e) { toast('Could not load that conversation'); }
}

/* ---------- providers ---------- */
function renderProviders() {
  const box = $('#provList');
  if (!S.providers.length) { box.innerHTML = '<div class="empty">No providers yet. Add one below.</div>'; return; }
  box.innerHTML = S.providers.map(p => {
    const models = S.models.get(p.id) || [];
    return `<div class="prov" data-pid="${esc(p.id)}">
      <div class="ph"><span class="pname">${esc(p.name)}</span><span class="ptype">${esc(p.type)}</span></div>
      <div class="pbase">${esc(p.base)}</div>
      <div class="pbase">${p.hasKey ? '🔑 Key saved' : '⚠️ No key'}</div>
      ${models.length ? `<div class="models-list">${models.slice(0, 30).map(m => `<span class="chip ${S.activeProvider === p.id && S.activeModel === m ? 'on' : ''}" data-selm="${esc(p.id + '::' + m)}">${esc(m)}</span>`).join('')}${models.length > 30 ? `<span class="chip">+${models.length - 30}</span>` : ''}</div>` : ''}
      <div class="pacts">
        <button class="ghost" data-fetch="${esc(p.id)}">Fetch models</button>
        <button class="ghost danger" data-delprov="${esc(p.id)}">Remove</button>
      </div>
    </div>`;
  }).join('');
}
$('#provList').addEventListener('click', async e => {
  const fb = e.target.closest('[data-fetch]');
  if (fb) { fb.disabled = true; fb.textContent = 'Fetching...'; const m = await fetchModelsFor(fb.dataset.fetch); fb.disabled = false; fb.textContent = 'Fetch models'; toast(m && m.length ? `${m.length} models loaded` : 'No models found'); return; }
  const db = e.target.closest('[data-delprov]');
  if (db) { await cli(`delkey ${q(db.dataset.delprov)}`); S.models.delete(db.dataset.delprov); await loadProviders(); renderProviders(); updateModelSel(); toast('Removed'); return; }
  const sm = e.target.closest('[data-selm]');
  if (sm) { const [p, m] = sm.dataset.selm.split('::'); S.activeProvider = p; S.activeModel = m; localStorage.setItem('nexus.active', sm.dataset.selm); updateModelSel(); renderProviders(); renderHeader(); toast(`${m}`); }
});

/* ---------- add provider ---------- */
$('#newType').onchange = () => {
  const t = $('#newType').value;
  const p = PRESETS[t];
  if (p) { $('#newBase').value = p.base; if (!$('#newName').value) $('#newName').value = p.name; }
};
$('#addProv').onclick = async () => {
  const type = $('#newType').value;
  const preset = PRESETS[type] || PRESETS.custom;
  const name = $('#newName').value.trim() || preset.name;
  const base = $('#newBase').value.trim() || preset.base;
  const key = $('#newKey').value.trim();
  if (!base) return toast('Enter a base URL');
  if (!key) return toast('Enter an API key');
  const id = type + '_' + Date.now().toString(36);
  const ptype = preset.type === 'openai' && type !== 'openai' ? type : preset.type;
  await cli(`setkey ${q(id)} ${q(name)} ${q(base)} ${q(key)} ${q(ptype)}`);
  $('#newName').value = ''; $('#newKey').value = '';
  await loadProviders();
  renderProviders();
  toast(`${name} saved`);
  fetchModelsFor(id);
};
$('#newType').dispatchEvent(new Event('change'));

/* ---------- history ---------- */
async function renderHistory() {
  const list = await cliJSON('chats', []);
  $('#histList').innerHTML = list.length ? list.reverse().map(c => {
    return `<div class="box" style="margin-bottom:6px;cursor:pointer" data-loadchat="${esc(c.id)}">
      <div class="toolbar"><span style="flex:1;font-weight:700">${esc(c.id)}</span><span class="hint" style="margin:0">${(c.size / 1024).toFixed(1)} KB</span><button class="ghost danger" data-delchat="${esc(c.id)}" style="padding:4px 10px">Delete</button></div>
    </div>`;
  }).join('') + `<button class="primary" id="newChatBtn" style="width:100%;margin-top:8px">New conversation</button>`
  : '<div class="empty">No saved conversations.</div><button class="primary" id="newChatBtn" style="width:100%;margin-top:8px">New conversation</button>';
  const nc = $('#newChatBtn'); if (nc) nc.onclick = () => { newChat(); gotoTab('chat'); };
}
$('#histList').addEventListener('click', e => {
  const dc = e.target.closest('[data-delchat]');
  if (dc) { e.stopPropagation(); cli(`delchat ${q(dc.dataset.delchat)}`); renderHistory(); toast('Deleted'); return; }
  const lc = e.target.closest('[data-loadchat]');
  if (lc) loadChat(lc.dataset.loadchat);
});

/* ---------- github ---------- */
$('#ghSave').onclick = () => {
  const t = $('#ghToken').value.trim();
  if (t && !t.startsWith('••')) { S.ghToken = t; localStorage.setItem('nexus.ghtoken', t); $('#ghToken').value = '••••••••'; toast('Token saved'); loadGH(); }
  else if (!t) { S.ghToken = ''; localStorage.removeItem('nexus.ghtoken'); toast('Token removed'); $('#ghContent').innerHTML = ''; }
};
async function loadGH() {
  if (!S.ghToken) { $('#ghContent').innerHTML = ''; return; }
  $('#ghContent').innerHTML = '<div class="empty"><span class="spin"></span> Loading repos</div>';
  const r = await cli(`ghproxy ${q(S.ghToken)} GET user/repos?sort=updated&per_page=30`);
  try {
    const repos = JSON.parse(r.stdout.trim());
    if (repos.message) { $('#ghContent').innerHTML = `<div class="err">${esc(repos.message)}</div>`; return; }
    S.ghRepos = repos;
    $('#ghContent').innerHTML = repos.map(r => `<div class="gh-card" data-repo="${esc(r.full_name)}">
      <h4>${esc(r.full_name)}</h4>
      <p>${esc(r.description || 'No description')} ${r.stargazers_count ? '★ ' + r.stargazers_count : ''}</p>
      <div class="row" style="margin-top:6px"><button class="ghost" data-ghissues="${esc(r.full_name)}">Issues</button><button class="ghost" data-ghask="${esc(r.full_name)}">Ask AI about this repo</button></div>
    </div>`).join('');
  } catch (e) { $('#ghContent').innerHTML = '<div class="err">Could not parse the response.</div>'; }
}
$('#ghContent').addEventListener('click', async e => {
  const ib = e.target.closest('[data-ghissues]');
  if (ib) {
    const repo = ib.dataset.ghissues;
    ib.disabled = true; ib.textContent = 'Loading...';
    const r = await cli(`ghproxy ${q(S.ghToken)} GET repos/${repo}/issues?state=open&per_page=20`);
    ib.disabled = false; ib.textContent = 'Issues';
    try {
      const issues = JSON.parse(r.stdout.trim());
      openSheet(`<h2>Open issues: ${esc(repo)}</h2>${issues.length ? issues.map(i => `<div class="gh-card"><h4>#${i.number} ${esc(i.title)}</h4><p>${esc((i.body || '').slice(0, 200))}</p><button class="ghost" data-askissue="${esc(repo + '#' + i.number + ': ' + i.title + '\n' + (i.body || '').slice(0, 500))}">Ask AI</button></div>`).join('') : '<div class="empty">No open issues</div>'}`);
    } catch (e) { toast('Could not load issues'); }
    return;
  }
  const ab = e.target.closest('[data-ghask]');
  if (ab) {
    const repo = ab.dataset.ghask;
    const r = S.ghRepos.find(x => x.full_name === repo);
    const ctx = r ? `Repository: ${r.full_name}\nDescription: ${r.description || 'none'}\nLanguage: ${r.language || 'unknown'}\nStars: ${r.stargazers_count}\nOpen issues: ${r.open_issues_count}` : repo;
    S.messages.push({ role: 'user', content: `Review this GitHub repository:\n\n${ctx}\n\nGive me your assessment: what it does, code quality impressions, and anything I should watch out for.` });
    gotoTab('chat');
    renderMessages();
    sendMessage(); // auto-send
    return;
  }
});
document.addEventListener('click', e => {
  const ai = e.target.closest('[data-askissue]');
  if (ai) { closeSheet(); S.messages.push({ role: 'user', content: `Review this GitHub issue and suggest how to handle it:\n\n${ai.dataset.askissue}` }); gotoTab('chat'); renderMessages(); sendMessage(); }
});

/* ---------- settings ---------- */
function renderSettings() {
  const t = S.tools, yn = v => v ? '<span style="color:var(--ac2)">yes</span>' : '<span style="color:var(--bad)">no</span>';
  $('#settingsBox').innerHTML = `
  <div class="box"><h3>System prompt</h3><p class="hint">Sent at the start of every conversation as context for the AI.</p>
    <textarea class="f" id="sysPrompt" rows="4" placeholder="You are a helpful assistant...">${esc(S.systemPrompt)}</textarea>
    <button class="ghost" id="sysSave" style="width:100%;margin-top:8px">Save</button></div>
  <div class="box"><h3>Diagnostics</h3><div class="kv">
    <span>curl</span><span>${yn(t.curl)}</span><span>busybox wget</span><span>${yn(t.wget)}</span>
    <span>Providers</span><span>${S.providers.length}</span><span>Models loaded</span><span>${[...S.models.values()].reduce((a, b) => a + b.length, 0)}</span>
    <span>Android API</span><span>${esc(t.sdk || '-')}</span><span>Device</span><span>${esc(t.device || '-')}</span></div></div>
  <div class="box"><h3>Data</h3>
    <button class="ghost" id="clearChats" style="width:100%">Delete all conversations</button>
    <p class="hint">API keys are in /data/adb/nexus/keys.conf (root-only). Conversations are in /data/adb/nexus/history/.</p></div>
  <div class="box"><h3>About</h3><div class="kv"><span>Version</span><span>v1.0.0</span><span>Author</span><span>kreza6173-pixel</span></div></div>`;
  $('#sysSave').onclick = () => { S.systemPrompt = $('#sysPrompt').value; localStorage.setItem('nexus.system', S.systemPrompt); toast('Saved'); };
  $('#clearChats').onclick = async () => {
    const list = await cliJSON('chats', []);
    for (const c of list) await cli(`delchat ${q(c.id)}`);
    S.messages = []; S.chatId = ''; renderMessages(); toast('All conversations deleted');
  };
}

/* ---------- nav ---------- */
function gotoTab(t) {
  S.tab = t;
  $$('nav.bottom button').forEach(x => x.classList.toggle('on', x.dataset.tab === t));
  $$('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + t));
  window.scrollTo(0, 0);
  if (t === 'providers') renderProviders();
  if (t === 'history') renderHistory();
  if (t === 'github') { if (S.ghToken) loadGH(); }
  if (t === 'settings') renderSettings();
}
$$('nav.bottom button').forEach(b => b.onclick = () => gotoTab(b.dataset.tab));
function renderHeader() {
  const prov = S.providers.find(p => p.id === S.activeProvider);
  $('#subline').textContent = prov ? `${prov.name} / ${S.activeModel || 'no model'}` : `${S.providers.length} provider${S.providers.length !== 1 ? 's' : ''}`;
}
function renderAll() { renderHeader(); updateModelSel(); renderMessages(); }

/* ---------- mock ---------- */
function mock(cmd) {
  const a = cmd.replace(CLI + ' ', '').split(' ')[0];
  const out = {
    keys: '[{"id":"demo","name":"Demo Provider","base":"https://api.example.com/v1","type":"openai","hasKey":true}]',
    tools: '{"curl":1,"wget":0,"sdk":"36","device":"tanzanite"}',
    chats: '[]'
  }[a];
  return { errno: 0, stdout: out || '{}', stderr: '' };
}

loadAll();
