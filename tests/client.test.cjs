const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

test('a new offline message survives reconnect and an earlier rejected draft', async () => {
  const calls = [];
  const context = client(async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({url, payload});
    if (payload.conversation_id === 'removed') {
      return Response.json({error:'Conversation was deleted.'}, {status:404});
    }
    return Response.json(url === '/api/conversations' ? {id:'restored'} : {status:'ok'});
  });
  const storage = new Map();
  context.localStorage = {getItem:k=>storage.get(k)||null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k)};
  const input = {value:'My offline message',style:{}};
  context.document.getElementById = id => id === 'taskInput' ? input : null;
  context.document.querySelector = () => null;
  context.navigator.onLine = false;
  vm.runInContext(`addOptimisticUserMessage = () => {}; updateProcessingStateUI = () => {}; renderImagePreviews = () => {};
    state.currentWorkspace = {path:'fixture-project'}; state.activeConversationId = null;
    saveToOfflineQueue({prompt:'older draft',conversation_id:'removed'});`, context);
  await vm.runInContext('executeSubmitTask()',context);
  const drafts = JSON.parse(storage.get('antigravity_offline_queue'));
  assert.equal(drafts.length,2);
  assert.equal(drafts[1].workspace_path,'fixture-project');
  assert.equal(input.value,'');
  assert.equal(calls.length,0);
  context.navigator.onLine = true;
  await vm.runInContext('flushOfflineQueue()',context);
  assert.deepEqual(calls.map(call=>call.url),['/api/tasks/submit','/api/conversations','/api/tasks/submit']);
  assert.equal(calls[1].payload.offline_draft_id,drafts[1].request_id);
  assert.equal(calls[2].payload.conversation_id,'restored');
  const kept = JSON.parse(storage.get('antigravity_offline_queue'));
  assert.equal(kept.length,1);
  assert.equal(kept[0].delivery_error,'Conversation was deleted.');
});

test('a slow conversation fetch cannot overwrite the tab opened after it', async () => {
  const pending = new Map();
  const context = client(url => new Promise(resolve => pending.set(url,resolve)));
  context.drawn = [];
  vm.runInContext('fetchModels = () => {}; ensureConvoTabOpen = () => {}; renderActiveConversation = value => drawn.push(value.id);',context);
  const first = vm.runInContext("loadConversation('first')",context);
  const second = vm.runInContext("loadConversation('second')",context);
  pending.get('/api/conversations/second')(Response.json({id:'second'}));
  await second;
  pending.get('/api/conversations/first')(Response.json({id:'first'}));
  await first;
  assert.deepEqual(context.drawn,['second']);
});

function client(fetch) {
  const context = vm.createContext({
    console, fetch, AbortController, AbortSignal, setTimeout, clearTimeout,
    crypto: require('node:crypto').webcrypto,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {},
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
  });
  vm.runInContext(readFileSync('static/app.js', 'utf8'), context);
  return context;
}

test('HTTP 200 with a failed action is not displayed as success', async () => {
  const context = client(async () => new Response(JSON.stringify({ status: 'error', message: 'Git failed' }), {
    headers: { 'content-type': 'application/json' },
  }));
  const result = await vm.runInContext('safeFetchJson("/api/changes/accept")', context);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Git failed');
});

test('retrying an unacknowledged task reuses the persisted request ID', async () => {
  const sent = [];
  const context = client(async (url, options) => { sent.push(JSON.parse(options.body)); throw new Error('lost connection'); });
  const storage = new Map();
  context.localStorage = { getItem:k=>storage.get(k)||null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k) };
  for (let i=0;i<2;i++) await vm.runInContext('safeFetchJson("/api/tasks/submit", {body:JSON.stringify({prompt:"one",conversation_id:"session-a"})})', context);
  assert.match(sent[0].request_id || '', /^[0-9a-f-]{36}$/);
  assert.equal(sent[0].request_id, sent[1].request_id);
});

test('API error field is preserved for authentication failures', async () => {
  const context = client(async () => new Response(JSON.stringify({ error: 'Not paired' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  }));
  assert.equal((await vm.runInContext('safeFetchJson("/api/status")', context)).error, 'Not paired');
});

test('markdown cannot create executable protocol links', () => {
  const context = client();
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'vbscript:msgbox']) {
    const html = vm.runInContext(`renderMarkdown(${JSON.stringify(`[open](${url})`)})`, context);
    assert.doesNotMatch(html, /href="(?:javascript|data|vbscript):/i);
  }
});

test('inline file actions escape HTML attributes and Windows backslashes', () => {
  const context = client();
  const result = vm.runInContext(`escapeQuotes(${JSON.stringify('C:\\files\\a" onmouseover="alert(1)')})`, context);
  assert.ok(!result.includes('"'));
  assert.ok(result.includes('C:\\\\files\\\\'));
});

test('JSON dispatch errors retain the server explanation', async () => {
  const context = client(async () => new Response(JSON.stringify({ detail: 'IDE executable missing' }), {
    status: 502, headers: { 'content-type': 'application/json' },
  }));
  assert.equal((await vm.runInContext('safeFetchJson("/api/tasks/submit")', context)).error, 'IDE executable missing');
});

test('unknown quota stays unknown instead of showing demo percentages', () => {
  const context = client();
  const elements = new Map(['geminiWeeklyPct', 'gemini5hPct', 'claudeWeeklyPct', 'claude5hPct'].map(id => [id, {}]));
  context.document.getElementById = id => elements.get(id) || null;
  vm.runInContext('updateTokenQuotaUI({})', context);
  for (const el of elements.values()) assert.equal(el.textContent, '--');
});

test('the model catalog follows runtime changes without a bundled model list', async () => {
  let models = [{id:'future-model-v99',name:'Future model',disabled:false}];
  const context = client(async () => new Response(JSON.stringify({connected:true,target:'cli',models}), {headers:{'content-type':'application/json'}}));
  await vm.runInContext('fetchModels()', context);
  assert.equal(vm.runInContext('state.availableModels[0].id', context), 'future-model-v99');
  models = [{id:'paid-next',name:'Paid next',disabled:false}];
  await vm.runInContext('fetchModels()', context);
  assert.equal(vm.runInContext('state.availableModels[0].id', context), 'paid-next');
});

test('model discovery failure clears selectable models and keeps an unavailable choice explicit', async () => {
  let connected = true;
  const context = client(async () => new Response(JSON.stringify({connected,target:'cli',models:connected ? [{id:'allowed',name:'Allowed',disabled:false}] : []}), {headers:{'content-type':'application/json'}}));
  context.localStorage.setItem = () => {};
  await vm.runInContext('fetchModels();', context);
  vm.runInContext('selectModel("allowed")', context);
  connected = false;
  await vm.runInContext('fetchModels()', context);
  assert.equal(vm.runInContext('state.availableModels.length', context), 0);
  assert.equal(vm.runInContext('state.modelCatalogConnected', context), false);
  assert.equal(vm.runInContext('state.selectedModel', context), 'allowed');
});

test('unknown and disabled models cannot be selected', () => {
  const context = client();
  vm.runInContext('state.availableModels = [{id:"locked",name:"Locked",disabled:true}]; selectModel("locked"); selectModel("invented");', context);
  assert.equal(vm.runInContext('state.selectedModel', context), null);
});

test('reasoning variants appear once per model family', () => {
  const context = client();
  const groups = vm.runInContext(`getModelFamilies([
    {id:'argon-low',name:'Gemini 4 Argon (Low)',disabled:false},
    {id:'argon-medium',name:'Gemini 4 Argon (Medium)',disabled:false},
    {id:'argon-high',name:'Gemini 4 Argon (High)',disabled:false},
    {id:'future',name:'Future model',disabled:false}
  ])`, context);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, 'Gemini 4 Argon');
  assert.equal(groups[0].variants.length, 3);
});

test('different native IDs with identical names remain independently selectable', () => {
  const context = client();
  const groups = vm.runInContext(`getModelFamilies([
    {id:'provider-a-high',name:'Shared name (High)',disabled:false},
    {id:'provider-a-low',name:'Shared name (Low)',disabled:false},
    {id:'provider-b-high',name:'Shared name (High)',disabled:false},
    {id:'native-one',name:'Same name',disabled:false},
    {id:'native-two',name:'Same name',disabled:false}
  ])`, context);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].variants.length, 2);
});

test('ambiguous duplicate native IDs are not accepted as a catalog', async () => {
  const context = client(async () => new Response(JSON.stringify({connected:true,target:'cli',models:[
    {id:'duplicate',name:'Allowed',disabled:false},
    {id:'duplicate',name:'Locked',disabled:true}
  ]}), {headers:{'content-type':'application/json'}}));
  await vm.runInContext('fetchModels()', context);
  assert.equal(vm.runInContext('state.modelCatalogConnected', context), false);
  assert.equal(vm.runInContext('state.availableModels.length', context), 0);
});

test('target changes invalidate old choices immediately and ignore late responses', async () => {
  const pending = [];
  const context = client(url => new Promise(resolve => pending.push({url,resolve})));
  const first = vm.runInContext('fetchModels()', context);
  pending[0].resolve(new Response(JSON.stringify({connected:true,target:'cli',models:[{id:'old',name:'Old',disabled:false}]}), {headers:{'content-type':'application/json'}}));
  await first;
  const staleRefresh = vm.runInContext('fetchModels(true)', context);
  vm.runInContext('selectExecutionTarget("ide"); selectModel("old")', context);
  assert.equal(vm.runInContext('state.selectedModel', context), null);
  assert.equal(vm.runInContext('state.availableModels.length', context), 0);
  assert.equal(pending.length, 3);
  pending[2].resolve(new Response(JSON.stringify({connected:true,target:'ide',models:[{id:'new',name:'New',disabled:false}]}), {headers:{'content-type':'application/json'}}));
  await vm.runInContext('fetchModels()', context);
  pending[1].resolve(new Response(JSON.stringify({connected:true,target:'cli',models:[{id:'stale',name:'Stale',disabled:false}]}), {headers:{'content-type':'application/json'}}));
  await staleRefresh;
  assert.equal(vm.runInContext('state.availableModels[0].id', context), 'new');
});

test('manual refresh remains fresh when a background catalog request is already running', async () => {
  let finishBackground;
  const urls = [];
  const response = () => new Response(JSON.stringify({connected:true,target:'cli',models:[{id:'live',name:'Live',disabled:false}]}), {headers:{'content-type':'application/json'}});
  const context = client(url => {
    urls.push(url);
    return urls.length === 1 ? new Promise(resolve => { finishBackground = () => resolve(response()); }) : Promise.resolve(response());
  });
  const background = vm.runInContext('fetchModels()', context);
  const refresh = vm.runInContext('fetchModels(true)', context);
  finishBackground();
  await background;
  await refresh;
  assert.equal(urls.length, 2);
  assert.match(urls[1], /refresh=true$/);
});

test('an explicit Auto choice is submitted to the connection that supplied its ID', async () => {
  const context = client(async () => new Response(JSON.stringify({connected:true,target:'cli',models:[{id:'live',name:'Live',disabled:false}]}), {headers:{'content-type':'application/json'}}));
  await vm.runInContext('fetchModels()', context);
  vm.runInContext('selectModel("live")', context);
  const options = vm.runInContext('taskModelOptions()', context);
  assert.equal(options.execution_target, 'cli');
  assert.equal(options.model, 'live');
  vm.runInContext('state.connectedTarget = "ide"', context);
  assert.throws(() => vm.runInContext('taskModelOptions()', context), /Select a model again/);
});

test('a bound conversation shows its actual target and rejects target switches', async () => {
  const buttons = ['auto','ide','cli'].map(target => ({dataset:{target},classList:{toggle() {}},setAttribute() {}}));
  const context = client(async () => new Response(JSON.stringify({connected:true,target:'ide',session_bound:true,models:[{id:'live',name:'Live',disabled:false}]}), {headers:{'content-type':'application/json'}}));
  context.document.querySelectorAll = () => buttons;
  await vm.runInContext('state.activeConversationId = "bound"; fetchModels()', context);
  vm.runInContext('selectExecutionTarget("cli")', context);
  assert.equal(vm.runInContext('state.executionTarget', context), 'auto');
  assert.equal(buttons.find(b => b.dataset.target === 'cli').disabled, true);
  assert.equal(vm.runInContext('taskModelOptions().execution_target', context), 'ide');
});

test('disconnected and all-locked catalogs cannot silently submit a default model', async () => {
  let connected = false;
  const context = client(async () => new Response(JSON.stringify({connected,target:'cli',models:connected?[{id:'locked',name:'Locked',disabled:true}]:[]}), {headers:{'content-type':'application/json'}}));
  await vm.runInContext('fetchModels()', context);
  assert.throws(() => vm.runInContext('taskModelOptions()', context), /Models unavailable/);
  connected = true;
  await vm.runInContext('fetchModels()', context);
  assert.throws(() => vm.runInContext('taskModelOptions()', context), /No models are available/);
});

test('task submission pins the primary model source and keeps the secondary session default', async () => {
  const sent = [];
  const context = client(async (url, options) => {
    if (url.startsWith('/api/models')) return new Response(JSON.stringify({connected:true,target:'cli',models:[{id:'native-high',name:'Native (High)',disabled:false}]}), {headers:{'content-type':'application/json'}});
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({error:'stop after capturing payload'}), {status:409,headers:{'content-type':'application/json'}});
  });
  const input = {value:'Run this',style:{}};
  context.document.getElementById = id => ['taskInput','secondaryTaskInput'].includes(id) ? input : null;
  context.navigator.onLine = true;
  vm.runInContext('state.activeConversationId="primary"; state.secondaryConversationId="secondary"; state.wsConnected=true; showToast=()=>{}; updateProcessingStateUI=()=>{}; addOptimisticUserMessage=()=>{};', context);
  await vm.runInContext('fetchModels()', context);
  vm.runInContext('selectModel("native-high")', context);
  await vm.runInContext('executeSubmitTask()', context);
  await vm.runInContext('submitSecondaryTask()', context);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].conversation_id, 'primary');
  assert.equal(sent[0].model, 'native-high');
  assert.equal(sent[0].performance, 'High');
  assert.equal(sent[0].execution_target, 'cli');
  assert.equal(sent[0].auto_open_ide, false);
  assert.equal(sent[1].conversation_id, 'secondary');
  assert.equal(sent[1].model, null);
  assert.equal(sent[1].performance, 'Default');
  assert.equal(sent[1].execution_target, 'auto');
});

test('switching conversations while Send waits for discovery does not redirect the message', async () => {
  const pending = [];
  const sent = [];
  const context = client((url, options) => {
    if (url.startsWith('/api/models')) return new Promise(resolve => pending.push(resolve));
    sent.push(JSON.parse(options.body));
    return Promise.resolve(new Response('{}', {headers:{'content-type':'application/json'}}));
  });
  const input = {value:'Keep this in the original chat',style:{}};
  context.document.getElementById = id => id === 'taskInput' ? input : null;
  context.navigator.onLine = true;
  vm.runInContext('state.activeConversationId="original"; state.wsConnected=true; showToast=()=>{}; updateProcessingStateUI=()=>{};', context);
  const submission = vm.runInContext('executeSubmitTask()', context);
  vm.runInContext('state.activeConversationId="other"', context);
  pending[0](new Response(JSON.stringify({connected:true,target:'cli',models:[{id:'live',name:'Live',disabled:false}]}), {headers:{'content-type':'application/json'}}));
  await submission;
  assert.equal(sent.length, 0);
  assert.equal(input.value, 'Keep this in the original chat');
  pending[1](new Response(JSON.stringify({connected:true,target:'cli',models:[{id:'live',name:'Live',disabled:false}]}), {headers:{'content-type':'application/json'}}));
  await vm.runInContext('fetchModels()', context);
});

test('a revoked performance choice stays unavailable until the user chooses again', async () => {
  let locked = false;
  const context = client(async () => new Response(JSON.stringify({connected:true,target:'cli',models:[
    {id:'native-high',name:'Native (High)',disabled:locked},
    {id:'native-low',name:'Native (Low)',disabled:false}
  ]}), {headers:{'content-type':'application/json'}}));
  const options = {contains:()=>false,querySelectorAll:()=>[]};
  context.document.getElementById = id => id === 'modelOptions' ? options : null;
  await vm.runInContext('fetchModels()', context);
  vm.runInContext('selectModel("native-high")', context);
  locked = true;
  await vm.runInContext('fetchModels(true)', context);
  assert.throws(() => vm.runInContext('taskModelOptions()', context), /Select a model again/);
  assert.doesNotMatch(options.innerHTML, /aria-pressed="true"/);
  vm.runInContext('selectPerformance("Low")', context);
  assert.equal(vm.runInContext('taskModelOptions().model', context), 'native-low');
});

test('offline default drafts retain native selection for validation when reconnected', () => {
  const context = client();
  const options = vm.runInContext('taskModelOptions(true)', context);
  assert.equal(options.model, null);
  assert.equal(options.performance, 'Default');
  assert.equal(options.execution_target, 'auto');
});

test('XHigh and Max group by exact native suffix while Orchestrator and ambiguous names stay intact', () => {
  const context = client();
  const groups = vm.runInContext(`getModelFamilies([
    {id:'hydrogen-high',name:'Hydrogen (High)'},
    {id:'hydrogen-xhigh',name:'Hydrogen (XHigh)'},
    {id:'future-max',name:'Future (Max)'},
    {id:'orchestrator-argon',name:'Orchestrator (Argon)'},
    {id:'ambiguous',name:'Unknown (High)'}
  ])`, context);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].variants[1].performance, 'XHigh');
  assert.equal(groups[1].variants[0].performance, 'Max');
  assert.equal(groups[2].name, 'Orchestrator (Argon)');
  assert.equal(groups[3].name, 'Unknown (High)');
});

test('quota rendering includes future groups and windows and escapes runtime text', () => {
  const context = client();
  const container = {};
  context.document.getElementById = id => id === 'quotaGroups' ? container : null;
  vm.runInContext(`renderQuotaGroups({is_live:true,quota_groups:[{title:'Future <model>',buckets:[
    {window:'monthly',remaining_pct:0}, {window:'hourly',remaining_pct:100,disabled:true}
  ]}]})`, context);
  assert.match(container.innerHTML, /Future &lt;model&gt;/);
  assert.match(container.innerHTML, /Monthly limit remaining/);
  assert.match(container.innerHTML, />0%/);
  assert.match(container.innerHTML, />N\/A/);
  assert.doesNotMatch(container.innerHTML, />100%/);
  vm.runInContext('renderQuotaGroups({is_live:false})', context);
  assert.match(container.innerHTML, /Quota unavailable/);
});

test('performance selects an exact available native variant and rejects unavailable levels', () => {
  const context = client();
  context.localStorage.setItem = () => {};
  context.document.querySelectorAll = () => [];
  vm.runInContext(`state.modelCatalogConnected = true; state.modelCatalogKey = modelCatalogKey(); state.connectedTarget = 'cli'; state.availableModels = [
    {id:'argon-low',name:'Gemini 4 Argon (Low)',disabled:false},
    {id:'argon-high',name:'Gemini 4 Argon (High)',disabled:false},
    {id:'argon-medium',name:'Gemini 4 Argon (Medium)',disabled:true}
  ]; selectModel('argon-low'); selectPerformance('High');`, context);
  assert.equal(vm.runInContext('state.selectedModel', context), 'argon-high');
  vm.runInContext("selectPerformance('Medium')", context);
  assert.equal(vm.runInContext('state.selectedModel', context), 'argon-high');
});

test('inapplicable quota is not displayed as fully available', () => {
  const context = client();
  const elements = new Map([['claude5hPct', {}]]);
  context.document.getElementById = id => elements.get(id) || null;
  vm.runInContext('updateTokenQuotaUI({models_quota:{claude_gpt_models:{five_hour:{disabled:true,remaining_pct:100}}}})', context);
  assert.equal(elements.get('claude5hPct').textContent, 'N/A');
});

test('dictation uses the device language, an explicit override, or a safe fallback', () => {
  const context = client();
  context.navigator.languages = ['ja-JP', 'en-US'];
  assert.equal(vm.runInContext('getDictationLanguage()', context), 'ja-JP');
  context.localStorage.getItem = () => 'id-ID';
  assert.equal(vm.runInContext('getDictationLanguage()', context), 'id-ID');
  context.localStorage.getItem = () => 'invalid locale';
  assert.equal(vm.runInContext('getDictationLanguage()', context), 'en-US');
});

test('dictation starts with the detected language and clears its listening state on stop', () => {
  const context = client();
  let recognition;
  context.navigator.language = 'fr-FR';
  context.window.SpeechRecognition = class {
    constructor() { recognition = this; }
    start() { this.onstart(); }
    stop() { this.onend(); }
  };
  const classes = new Set();
  const attrs = new Map();
  const button = { classList: { add:v=>classes.add(v), remove:v=>classes.delete(v) }, setAttribute:(k,v)=>attrs.set(k,v) };
  context.document.getElementById = id => id === 'btnVoiceDictation' ? button : null;
  vm.runInContext('toggleVoiceDictation()', context);
  assert.equal(recognition.lang, 'fr-FR');
  assert.equal(classes.has('listening'), true);
  assert.equal(attrs.get('aria-pressed'), 'true');
  vm.runInContext('toggleVoiceDictation()', context);
  assert.equal(classes.has('listening'), false);
  assert.equal(attrs.get('aria-pressed'), 'false');
});

test('failed offline storage does not report that the draft was saved', () => {
  const context = client();
  context.console = { ...console, error() {} };
  context.localStorage.setItem = () => { throw new Error('Storage full'); };
  assert.equal(vm.runInContext('saveToOfflineQueue({ prompt: "Keep my draft" })', context), false);
});

test('flushing the offline queue preserves tasks added during delivery', async () => {
  let complete;
  const response = new Promise(resolve => { complete = resolve; });
  const context = client(() => response);
  const storage = new Map([['antigravity_offline_queue', JSON.stringify([{ prompt: 'first', conversation_id:'original', queued_at: 'before' }])]]);
  context.localStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const flushing = vm.runInContext('flushOfflineQueue()', context);
  vm.runInContext('saveToOfflineQueue({ prompt: "second" })', context);
  complete(new Response(JSON.stringify({ status: 'ok' }), { headers: { 'content-type': 'application/json' } }));
  await flushing;
  assert.deepEqual(JSON.parse(storage.get('antigravity_offline_queue')).map(item => item.prompt), ['second']);
});

test('openFolderBrowser renders shortcuts, breadcrumbs, subfolders, and error states', async () => {
  const shortcutsList = { innerHTML: '' };
  const classes = new Set(['hidden']);
  const modal = {
    classList: { remove: v => classes.delete(v), add: v => classes.add(v) },
    querySelector: sel => (sel === '.modal-shortcuts-list' ? shortcutsList : null),
  };
  const elements = {
    browseModal: modal,
    browseBreadcrumbs: { innerHTML: '' },
    subfolderCountText: { textContent: '' },
    browseFoldersList: {
      children: [],
      innerHTML: '',
      appendChild(node) { this.children.push(node); },
    },
    btnBrowseParent: { style: {} },
    btnSelectThisFolder: {},
  };
  let fail = false;
  const context = client(async () => fail
    ? new Response(JSON.stringify({ status: 'error', message: 'Folder is outside the allowed project directories.' }), { headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({
      status: 'ok',
      current_path: 'C:\\Users\\dev\\Projects\\app',
      parent_path: 'C:\\Users\\dev\\Projects',
      shortcuts: [
        { name: 'Projects', path: 'C:\\Users\\dev\\Projects' },
        { name: 'Desktop', path: 'C:\\Users\\dev\\Desktop' },
      ],
      breadcrumbs: [
        { name: 'Projects', path: 'C:\\Users\\dev\\Projects' },
        { name: 'app', path: 'C:\\Users\\dev\\Projects\\app' },
      ],
      subfolders: [
        { name: 'api', path: 'C:\\Users\\dev\\Projects\\app\\api', is_git: true, subfolder_count: 1, has_children: true },
        { name: 'empty', path: 'C:\\Users\\dev\\Projects\\app\\empty', is_git: false, subfolder_count: 0, has_children: false },
      ],
    }), { headers: { 'content-type': 'application/json' } })
  );
  const toasts = [];
  context.document.getElementById = id => elements[id] || null;
  context.document.createElement = () => ({ className: '', innerHTML: '' });
  vm.runInContext('showToast = (m, t) => globalThis.__toasts.push({ m, t });', context);
  context.__toasts = toasts;

  await vm.runInContext('openFolderBrowser("C:\\\\Users\\\\dev\\\\Projects\\\\app")', context);
  assert.equal(classes.has('hidden'), false);
  assert.match(shortcutsList.innerHTML, />Projects</);
  assert.match(shortcutsList.innerHTML, />Desktop</);
  assert.match(elements.browseBreadcrumbs.innerHTML, />Projects</);
  assert.match(elements.browseBreadcrumbs.innerHTML, />app</);
  assert.equal(elements.subfolderCountText.textContent, '2 subfolders');
  assert.equal(elements.browseFoldersList.children.length, 2);
  assert.match(elements.browseFoldersList.children[0].innerHTML, /1 folder/);
  assert.match(elements.browseFoldersList.children[0].innerHTML, /btn-folder-chevron/);
  assert.match(elements.browseFoldersList.children[0].innerHTML, /Select/);
  assert.match(elements.browseFoldersList.children[1].innerHTML, /Empty/);
  assert.doesNotMatch(elements.browseFoldersList.children[1].innerHTML, /btn-folder-chevron/);
  assert.equal(elements.btnBrowseParent.disabled, false);

  fail = true;
  await vm.runInContext('openFolderBrowser("C:\\\\Forbidden")', context);
  assert.match(elements.browseFoldersList.innerHTML, /outside the allowed project directories/);
  assert.equal(toasts.at(-1).t, 'error');
});

test('git accept and reject actions update state.changes directly from response payload', async () => {
  const calls = [];
  const nextChanges = { revision: 'review-v2', is_git: true, workspace: 'C:\\repo', total_changed: 0, total_insertions: 0, total_deletions: 0, files: [] };
  const context = client(async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (url === '/api/changes/reject') {
      return new Response(JSON.stringify({ status: 'ok', message: 'Changes to temp.txt were reverted.', changes: nextChanges }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ status: 'error', message: 'Git failed' }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  context.window.confirm = () => true;
  const toasts = [];
  context.__toasts = toasts;
  vm.runInContext('showToast = (m, t) => globalThis.__toasts.push({ m, t }); addLogEvent = () => {}; state.changes = { revision: "review-v1", workspace: "C:/repo", files: [{ path: "temp.txt" }] };', context);

  await vm.runInContext('rejectFileChange("temp.txt")', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/changes/reject');
  assert.equal(calls[0].body.file_path, 'temp.txt');
  assert.equal(calls[0].body.scope, 'file');
  assert.deepEqual(vm.runInContext('state.changes', context), nextChanges);
  assert.equal(toasts.at(-1).m, 'Changes to temp.txt were reverted.');

  await vm.runInContext('confirmAcceptAllChanges()', context);
  assert.equal(calls[1].url, '/api/changes/accept');
  assert.equal(calls[1].body.scope, 'all');
  assert.equal(calls[0].body.revision, 'review-v1');
  assert.equal(calls[1].body.revision, 'review-v2');
  assert.equal('file_path' in calls[1].body, false);
  assert.deepEqual(vm.runInContext('state.changes', context), nextChanges);
  assert.equal(toasts.at(-1).t, 'error');
  assert.equal(toasts.at(-1).m, 'Git failed');
});

test('Git actions bind to the reviewed workspace instead of the newly selected conversation', async () => {
  const bodies = [];
  const confirmations = [];
  const context = client(async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ status: 'error', message: 'Fixture stops before Git execution' }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  context.window.confirm = message => { confirmations.push(message); return true; };
  vm.runInContext(`showToast = () => {}; addLogEvent = () => {};
    state.currentWorkspace = { path: 'C:/repo-b' };
    state.activeConversationId = 'conversation-b';
    state.conversations = [{ id: 'conversation-b', workspace_path: 'C:/repo-b' }];
    state.changes = { revision: "review-v1", workspace: 'C:/repo-a', files: [{ path: 'shared.txt', status: 'modified' }] };`, context);
  for (const action of ['acceptFileChange("shared.txt")', 'rejectFileChange("shared.txt")',
    'confirmAcceptAllChanges()', 'confirmRejectAllChanges()']) {
    await vm.runInContext(action, context);
  }
  assert.equal(bodies.length, 4);
  assert.ok(bodies.every(body => body.workspace_path === 'C:/repo-a'));
  assert.ok(confirmations.every(message => message.includes('C:/repo-a')));
});

test('Git websocket updates keep the displayed snapshot and rename confirmation in sync', async () => {
  const confirmations = [];
  const context = client(async () => new Response(JSON.stringify({ status: 'error', message: 'Fixture only' }), {
    headers: { 'content-type': 'application/json' },
  }));
  context.window.confirm = message => { confirmations.push(message); return true; };
  vm.runInContext(`showToast = () => {}; addLogEvent = () => {};
    state.changes = { revision: "review-v1", workspace: 'C:/repo-a', files: [{ path: 'new.txt', status: 'modified' }] };
    handleSocketMessage({ type: 'CHANGES_UPDATED', changes: {
      revision: 'review-v2', workspace: 'C:/repo-a', files: [{ path: 'new.txt', original_path: 'old.txt', status: 'renamed' }]
    }});`, context);
  assert.equal(vm.runInContext('state.changes.files[0].status', context), 'renamed');
  await vm.runInContext('rejectFileChange("new.txt", "renamed")', context);
  assert.match(confirmations[0], /old\.txt → new\.txt/);
});

test('Git action responses cannot replace a newer project review', async () => {
  let finish;
  const context = client(() => new Promise(resolve => { finish = resolve; }));
  context.window.confirm = () => true;
  vm.runInContext(`showToast = () => {}; addLogEvent = () => {};
    state.changes = { revision: "review-v1", workspace: 'C:/repo-a', files: [{ path: 'shared.txt', status: 'modified' }] };`, context);
  const action = vm.runInContext('rejectFileChange("shared.txt")', context);
  vm.runInContext(`renderChangesUI({ workspace: 'C:/repo-b', files: [{ path: 'other.txt', status: 'untracked' }] });`, context);
  finish(new Response(JSON.stringify({ status: 'ok', changes: { workspace: 'C:/repo-a', files: [] } }), {
    headers: { 'content-type': 'application/json' },
  }));
  await action;
  assert.equal(vm.runInContext('state.changes.workspace', context), 'C:/repo-b');
  assert.equal(vm.runInContext('state.changes.files[0].path', context), 'other.txt');
});

test('Git refresh follows the local conversation and ignores delayed responses from the prior project', async () => {
  const requests = [];
  const context = client(url => new Promise(resolve => { requests.push({ url, resolve }); }));
  vm.runInContext(`state.currentWorkspace = { path: 'C:/unrelated' };
    state.conversations = [{ id: 'a', workspace_path: 'C:/repo-a' }, { id: 'b', workspace_path: 'C:/repo-b' }];
    state.activeConversationId = 'a';`, context);
  const first = vm.runInContext('fetchChanges()', context);
  vm.runInContext("state.activeConversationId = 'b'", context);
  const second = vm.runInContext('fetchChanges()', context);
  const response = workspace => new Response(JSON.stringify({ workspace, files: [] }), {
    headers: { 'content-type': 'application/json' },
  });
  requests[1].resolve(response('C:/repo-b'));
  await second;
  requests[0].resolve(response('C:/repo-a'));
  await first;
  assert.equal(requests[0].url, '/api/changes?workspace_path=C%3A%2Frepo-a');
  assert.equal(requests[1].url, '/api/changes?workspace_path=C%3A%2Frepo-b');
  assert.equal(vm.runInContext('state.changes.workspace', context), 'C:/repo-b');
});

test('Git actions require a reviewed workspace and honor cancelled confirmation', async () => {
  let requests = 0;
  const context = client(async () => {
    requests++;
    return new Response(JSON.stringify({ status: 'error', message: 'Fixture only' }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  context.window.confirm = () => true;
  vm.runInContext('showToast = () => {}; state.changes = { files: [] };', context);
  await vm.runInContext('confirmRejectAllChanges()', context);
  assert.equal(requests, 0);
  vm.runInContext("state.changes = { revision: 'review-v1', workspace: 'C:/repo-a', files: [] };", context);
  context.window.confirm = () => false;
  await vm.runInContext('confirmAcceptAllChanges()', context);
  assert.equal(requests, 0);
});

test('a late Git action leaves the next project refresh in flight', async () => {
  const requests = [];
  const context = client(url => new Promise(resolve => requests.push({url, resolve})));
  const finish = (index, data) => requests[index].resolve(new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  }));
  context.window.confirm = () => true;
  vm.runInContext(`showToast = () => {}; addLogEvent = () => {};
    state.currentWorkspace = {path:'A'}; renderChangesUI({workspace:'A',revision:'v1',files:[]});`, context);
  const action = vm.runInContext('confirmAcceptAllChanges()', context);
  const refresh = vm.runInContext('state.currentWorkspace = {path:"B"}; fetchChanges()', context);
  finish(0, {status:'ok',changes:{workspace:'A',files:[]}});
  await action;
  finish(1, {workspace:'B',files:[]});
  await refresh;
  assert.equal(vm.runInContext('state.changes.workspace', context), 'B');
});

test('Git broadcasts from another conversation project do not replace the current review', () => {
  const workspaceLabel = { textContent: '' };
  const context = client();
  context.document.getElementById = id => id === 'changesSummaryWorkspace' ? workspaceLabel : null;
  vm.runInContext(`state.activeConversationId = 'a';
    state.conversations = [{ id: 'a', workspace_path: 'C:/repo-a' }];
    renderChangesUI({ workspace: 'C:/repo-a', files: [] });
    handleSocketMessage({ type: 'CHANGES_UPDATED', changes: { workspace: 'C:/repo-b', files: [] } });`, context);
  assert.equal(workspaceLabel.textContent, 'repo-a');
  assert.equal(vm.runInContext('state.changes.workspace', context), 'C:/repo-a');
});

test('Git refresh cannot overwrite a newer websocket snapshot', async () => {
  let finish;
  const context = client(() => new Promise(resolve => { finish = resolve; }));
  vm.runInContext("state.currentWorkspace = { path: 'C:/repo-a' };", context);
  const refresh = vm.runInContext('fetchChanges()', context);
  vm.runInContext(`handleSocketMessage({ type: 'CHANGES_UPDATED', changes: {
    workspace: 'C:/repo-a', files: [{ path: 'newer.txt', status: 'untracked' }]
  }});`, context);
  finish(new Response(JSON.stringify({ workspace: 'C:/repo-a', files: [] }), {
    headers: { 'content-type': 'application/json' },
  }));
  await refresh;
  assert.equal(vm.runInContext('state.changes.files[0].path', context), 'newer.txt');
});

test('Git revert warns that staged new files are removed from the working tree', async () => {
  const confirmations = [];
  const context = client();
  context.window.confirm = message => { confirmations.push(message); return false; };
  vm.runInContext("state.changes = { revision: 'review-v1', workspace: 'C:/repo-a', files: [] };", context);
  await vm.runInContext('rejectFileChange("added.txt", "added")', context);
  await vm.runInContext('rejectFileChange("copy.txt", "copied")', context);
  await vm.runInContext('confirmRejectAllChanges()', context);
  assert.match(confirmations[0], /removed from the working tree and staging area/);
  assert.match(confirmations[1], /removed from the working tree and staging area/);
  assert.match(confirmations[2], /Newly staged files.*removed/);
});

test('terminal command execution and WS COMMAND_RESULT handle errors and missing optional fields', async () => {
  const codeEl = { textContent: '' };
  const inputEl = { value: 'echo ok' };
  let mode = 'forbidden';
  const context = client(async () => {
    if (mode === 'forbidden') {
      return new Response(JSON.stringify({ detail: 'Remote terminal is disabled.' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    if (mode === 'nonzero') {
      return new Response(JSON.stringify({
        status: 'error',
        command: 'badcmd',
        returncode: 1,
        duration_seconds: 0.04,
        stdout: '',
        stderr: 'not found',
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      status: 'ok',
      command: 'echo ok',
      returncode: 0,
      duration_seconds: 0.12,
      stdout: 'ok\n',
      stderr: '',
    }), { headers: { 'content-type': 'application/json' } });
  });
  context.document.getElementById = id => {
    if (id === 'terminalCmdInput') return inputEl;
    if (id === 'terminalOutput') return { querySelector: sel => (sel === 'code' ? codeEl : null) };
    return null;
  };
  const toasts = [];
  context.__toasts = toasts;
  vm.runInContext('showToast = (m, t) => globalThis.__toasts.push({ m, t });', context);

  await vm.runInContext('executeTerminalCommand()', context);
  assert.equal(codeEl.textContent, '[ERROR] Remote terminal is disabled.');
  assert.equal(inputEl.value, 'echo ok');
  assert.equal(toasts.at(-1).t, 'error');

  mode = 'nonzero';
  inputEl.value = 'badcmd';
  await vm.runInContext('executeTerminalCommand()', context);
  assert.equal(codeEl.textContent, '> Command: badcmd (Exit: 1, 0.04s)\n\nnot found');
  assert.equal(inputEl.value, '');

  mode = 'ok';
  inputEl.value = 'echo ok';
  await vm.runInContext('executeTerminalCommand()', context);
  assert.equal(codeEl.textContent, '> Command: echo ok (Exit: 0, 0.12s)\n\nok\n');
  assert.equal(inputEl.value, '');

  vm.runInContext('handleSocketMessage({ type: "COMMAND_RESULT", command: "git status", result: { returncode: 0, stdout: "clean" } })', context);
  assert.equal(codeEl.textContent, '> Command: git status (Exit: 0)\n\nclean');
});

test('queue and task approval errors surface via toast without clearing pending state', async () => {
  const context = client(async url => {
    if (url.startsWith('/api/queue/')) {
      return new Response(JSON.stringify({ detail: 'Queue busy' }), { status: 409, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ detail: 'Task approvals are not implemented in the Rust engine.' }), {
      status: 501, headers: { 'content-type': 'application/json' },
    });
  });
  const toasts = [];
  context.__toasts = toasts;
  vm.runInContext('showToast = (m, t) => globalThis.__toasts.push({ m, t }); state.currentPendingTask = { task_id: "t-1" };', context);

  await vm.runInContext('cancelQueuedTask("q-1")', context);
  assert.equal(toasts.at(-1).m, 'Queue busy');
  await vm.runInContext('clearTaskQueue()', context);
  assert.equal(toasts.at(-1).m, 'Queue busy');
  await vm.runInContext('approveCurrentTask()', context);
  assert.equal(toasts.at(-1).m, 'Task approvals are not implemented in the Rust engine.');
  assert.equal(vm.runInContext('state.currentPendingTask.task_id', context), 't-1');
});

test('native tool decisions bind the offered option to the original request and conversation', async () => {
  const posts = [];
  const request = { request_id: 'ticket-a', conversation_id: 'chat-a', title: 'Read fixture',
    options: [{kind:'allow_once',optionId:'native-read',name:'Read once'}] };
  const context = client(async (url, options) => {
    if (options.method === 'POST') posts.push([url, JSON.parse(options.body)]);
    return new Response(JSON.stringify({status:'ok',tasks:[]}), { headers:{'content-type':'application/json'} });
  });
  context.fixtureRequest = request;
  vm.runInContext('showToast=()=>{}; state.activeConversationId="other-chat"; renderToolPermissions([fixtureRequest])', context);
  await vm.runInContext('decideToolPermission(fixtureRequest, fixtureRequest.options[0])', context);
  await vm.runInContext('decideToolPermission(fixtureRequest, fixtureRequest.options[0])', context);
  assert.deepEqual(posts, [['/api/tasks/approve',{conversation_id:'chat-a',request_id:'ticket-a',option_id:'native-read'}]]);
});

test('renderCommandResult displays both stdout and stderr when both are non-empty', () => {
  const codeEl = { textContent: '' };
  const context = client();
  context.document.getElementById = id => (id === 'terminalOutput' ? { querySelector: sel => (sel === 'code' ? codeEl : null) } : null);
  vm.runInContext('renderCommandResult({ command: "build", returncode: 1, duration_seconds: 0.25, stdout: "Processing file...\\n", stderr: "FATAL: permission denied\\n" })', context);
  assert.equal(codeEl.textContent, '> Command: build (Exit: 1, 0.25s)\n\nProcessing file...\n\n[stderr]\nFATAL: permission denied\n');
});

test('folder browse honors its timeout with a caller signal', async () => {
  for (const any of [AbortSignal.any, undefined]) {
    const context = client((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    context.AbortSignal = { timeout: () => AbortSignal.timeout(5), any };
    vm.runInContext('setOfflineState = () => {}; globalThis.controller = new AbortController();', context);
    const request = vm.runInContext('fetchJsonResponse("/api/workspaces/browse", { signal: controller.signal })', context);
    const watchdog = setTimeout(() => vm.runInContext('controller.abort()', context), 100);
    try {
      const result = await request;
      assert.equal(result.ok, false);
      assert.equal(result.aborted, undefined);
      assert.match(result.error, /timed out/i);
    } finally {
      clearTimeout(watchdog);
    }
  }
});

test('a timeout while reading the response body does not report the bridge as offline', async () => {
  for (const any of [AbortSignal.any, undefined]) {
    const offlineUpdates = [];
    const context = client(async (_url, { signal }) => ({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise((_resolve, reject) => {
        // Fetch body consumption can report AbortError despite a TimeoutError signal.
        signal.addEventListener('abort', () => reject(new DOMException('Body aborted', 'AbortError')), { once: true });
      }),
    }));
    context.AbortSignal = { timeout: () => AbortSignal.timeout(5), any };
    context.__offlineUpdates = offlineUpdates;
    vm.runInContext('setOfflineState = offline => __offlineUpdates.push(offline); globalThis.controller = new AbortController();', context);
    const request = vm.runInContext('fetchJsonResponse("/api/workspaces/browse", { signal: controller.signal })', context);
    const watchdog = setTimeout(() => vm.runInContext('controller.abort()', context), 100);
    try {
      const result = await request;
      assert.match(result.error, /timed out/i);
      assert.equal(result.aborted, undefined);
      assert.deepEqual(offlineUpdates, []);
    } finally {
      clearTimeout(watchdog);
    }
  }
});

test('Escape cancels folder navigation and ignores a late result after closing', async () => {
  let finish;
  const classes = new Set(['hidden']);
  const dialogEvents = new Map();
  const dialog = {
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (name, handler) => dialogEvents.set(name, handler),
  };
  const modal = {
    id: 'browseModal', firstElementChild: dialog, querySelector: () => null,
    classList: { add:name=>classes.add(name), remove:name=>classes.delete(name), contains:name=>classes.has(name) },
  };
  const elements = {
    browseModal: modal, btnBrowseParent: { style: {} }, btnSelectThisFolder: {},
    browseBreadcrumbs: {}, subfolderCountText: {}, browseFoldersList: { innerHTML: '' },
  };
  const context = client(() => new Promise(resolve => { finish = resolve; }));
  context.document.getElementById = id => elements[id] || null;
  context.document.querySelectorAll = () => [modal];
  context.MutationObserver = class { observe() {} };
  vm.runInContext('initDialogAccessibility()', context);
  const request = vm.runInContext('openFolderBrowser("C:/Project")', context);
  const controller = vm.runInContext('state.browseAbortController', context);
  dialogEvents.get('keydown')({ key:'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(classes.has('hidden'), true);
  assert.equal(controller.signal.aborted, true);
  finish(new Response(JSON.stringify({ current_path:'C:/Project', subfolders:[] }), {headers:{'content-type':'application/json'}}));
  await request;
  assert.equal(vm.runInContext('state.browseCurrentPath', context), '');
  assert.equal(elements.btnSelectThisFolder.disabled, true);
});

test('openFolderBrowser ignores out-of-order responses and disables selection after failure', async () => {
  const pending = new Map();
  const elements = {
    browseModal: { classList: { remove() {}, add() {} }, querySelector: () => null },
    browseBreadcrumbs: { innerHTML: '' },
    subfolderCountText: { textContent: '' },
    browseFoldersList: {
      children: [], html: '',
      set innerHTML(value) { this.html = value; this.children = []; },
      get innerHTML() { return this.html; },
      appendChild(node) { this.children.push(node); },
    },
    btnBrowseParent: { style: {}, disabled: false },
    btnSelectThisFolder: { disabled: false },
  };
  const context = client((url) => new Promise((resolve) => {
    const target = decodeURIComponent(url.split('target_dir=')[1] || '');
    pending.set(target, resolve);
  }));
  const selected = [];
  context.document.getElementById = id => elements[id] || null;
  context.document.createElement = () => ({ className: '', innerHTML: '' });
  context.__selected = selected;
  vm.runInContext('showToast = () => {}; selectWorkspaceByPath = p => globalThis.__selected.push(p);', context);

  const reqA = vm.runInContext('openFolderBrowser("C:\\\\A")', context);
  const reqB = vm.runInContext('openFolderBrowser("C:\\\\B")', context);
  assert.equal(elements.btnSelectThisFolder.disabled, true);

  pending.get('C:\\B')(new Response(JSON.stringify({
    status: 'ok', current_path: 'C:\\B', parent_path: 'C:\\', breadcrumbs: [{ name: 'B', path: 'C:\\B' }], subfolders: [{ name: 'child', path: 'C:\\B\\child' }], shortcuts: [],
  }), { headers: { 'content-type': 'application/json' } }));
  await reqB;
  assert.equal(vm.runInContext('state.browseCurrentPath', context), 'C:\\B');
  assert.equal(elements.btnSelectThisFolder.disabled, false);

  pending.get('C:\\A')(new Response(JSON.stringify({
    status: 'ok', current_path: 'C:\\A', parent_path: 'C:\\', breadcrumbs: [{ name: 'A', path: 'C:\\A' }], subfolders: [], shortcuts: [],
  }), { headers: { 'content-type': 'application/json' } }));
  await reqA;
  assert.equal(vm.runInContext('state.browseCurrentPath', context), 'C:\\B');
  assert.match(elements.browseBreadcrumbs.innerHTML, />B</);

  const reqFail = vm.runInContext('openFolderBrowser("C:\\\\Missing")', context);
  assert.equal(elements.browseFoldersList.children.length, 0);
  assert.match(elements.browseFoldersList.innerHTML, /Loading folders/);
  pending.get('C:\\Missing')(new Response(JSON.stringify({ status: 'error', message: 'Directory not found' }), {
    headers: { 'content-type': 'application/json' },
  }));
  await reqFail;
  assert.equal(vm.runInContext('state.browseCurrentPath', context), '');
  assert.equal(elements.btnSelectThisFolder.disabled, true);
  assert.equal(elements.subfolderCountText.textContent, 'Unavailable');
  assert.equal(elements.browseBreadcrumbs.innerHTML, '');
  elements.btnSelectThisFolder.onclick();
  assert.deepEqual(selected, []);
});

test('reject actions clarify tracked-only bulk scope and permanent deletion of untracked files', async () => {
  const confirms = [];
  const bodies = [];
  const toasts = [];
  const context = client(async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ status: 'ok', changes: { workspace: 'C:/repo', revision: 'review-v1', files: [] } }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  context.window.confirm = msg => { confirms.push(msg); return true; };
  context.__toasts = toasts;
  vm.runInContext('showToast = (m, t) => globalThis.__toasts.push({ m, t }); addLogEvent = () => {}; state.changes = { revision: "review-v1", workspace: "C:/repo", files: [{ path: "new.txt", status: "untracked" }, { path: "tracked.txt", status: "modified" }] };', context);

  await vm.runInContext('rejectFileChange("new.txt")', context);
  assert.deepEqual(bodies[0], { file_path: 'new.txt', scope: 'file', workspace_path: 'C:/repo', revision: 'review-v1' });
  assert.match(confirms[0], /Delete untracked file:/);
  assert.match(confirms[0], /permanently removed from disk/);

  await vm.runInContext('rejectFileChange("new-explicit.txt", "untracked")', context);
  assert.deepEqual(bodies[1], { file_path: 'new-explicit.txt', scope: 'file', workspace_path: 'C:/repo', revision: 'review-v1' });
  assert.match(confirms[1], /Delete untracked file:/);

  await vm.runInContext('rejectFileChange("tracked.txt", "modified")', context);
  assert.deepEqual(bodies[2], { file_path: 'tracked.txt', scope: 'file', workspace_path: 'C:/repo', revision: 'review-v1' });
  assert.match(confirms[2], /restored to HEAD/);

  await vm.runInContext('confirmRejectAllChanges()', context);
  assert.deepEqual(bodies[3], { scope: 'all', workspace_path: 'C:/repo', revision: 'review-v1' });
  assert.match(confirms[3], /Revert all tracked changes/i);
  assert.match(confirms[3], /Untracked new files are preserved/i);
  assert.match(toasts.at(-1).m, /Tracked project changes reverted/);
});

test('stale Git actions refresh once and require a new confirmation', async () => {
  const calls = [];
  const context = client(async (url, opts) => {
    calls.push([url, opts.method || 'GET']);
    const reject = opts.method === 'POST';
    return new Response(JSON.stringify(reject
      ? {code:'stale_review', message:'Review the updated files.'}
      : {workspace:'A', revision:'new', files:[{path:'note', status:'untracked'}]}),
      {status:reject ? 409 : 200, headers:{'content-type':'application/json'}});
  });
  context.window.confirm = () => true;
  vm.runInContext("state.currentWorkspace={path:'A'};state.changes={workspace:'A',revision:'old'};showToast=()=>{};", context);
  await vm.runInContext('rejectFileChange("note","modified")', context);
  assert.deepEqual(calls, [['/api/changes/reject','POST'], ['/api/changes?workspace_path=A','GET']]);
  assert.equal(vm.runInContext('state.changes.revision', context), 'new');
});

test('both Changes views distinguish failed status, non-Git, clean and truncated previews', () => {
  const context = client();
  const ids = ['changesFilesList','changesModalFilesList','changesSummaryFiles','changesSummaryInsertions','btnAcceptAllChanges'];
  const elements = Object.fromEntries(ids.map(id => [id,{classList:{toggle(_name, hidden){this.hidden=hidden;}}}]));
  context.document.getElementById = id => elements[id];
  const renders = value => {
    context.snapshot = value;
    vm.runInContext('renderChangesUI(snapshot)', context);
    return [elements.changesFilesList.innerHTML,elements.changesModalFilesList.innerHTML];
  };
  for (const html of renders({availability:'unavailable',message:'Git <offline>'})) {
    assert.match(html, /Git &lt;offline&gt;/);
    assert.match(html,/Retry/);
    assert.doesNotMatch(html,/No changed files|btn-accept-file/);
  }
  assert.equal(elements.changesSummaryInsertions.textContent,'');
  assert.equal(elements.btnAcceptAllChanges.classList.hidden,true);
  for (const html of renders({is_git:false,files:[]})) assert.match(html,/Choose a Git project/);
  for (const html of renders({availability:'ready',is_git:true,files:[]})) assert.match(html,/No changed files/);
  for (const html of renders({files:[{path:'note',diff:'+sample',insertions:250,diff_truncated:true}]})) {
    assert.match(html,/Preview truncated/);
    assert.match(html,/\+250/);
  }
});

test('selecting a workspace keeps a bound chat target and updates the target of an unbound chat', async () => {
  const context = client(async () => new Response(JSON.stringify({workspace:{name:'B',path:'C:/B'}}),
    {headers:{'content-type':'application/json'}}));
  const header = {}, picker = {};
  context.document.getElementById = id => ({activeConvWorkspace:header, currentWorkspaceName:picker})[id];
  vm.runInContext("state.conversations=[{id:'chat',workspace_path:'C:/A'}];state.activeConversationId='chat';showToast=()=>{};addLogEvent=()=>{};fetchWorkspaces=()=>{};",context);
  await vm.runInContext('selectWorkspaceByPath("C:/B")',context);
  assert.match(header.textContent,/target: A$/);
  assert.equal(header.title,'C:/A');
  assert.equal(picker.textContent,'B');
  vm.runInContext('state.activeConversationId=null;updateWorkspaceUI(state.currentWorkspace)',context);
  assert.match(header.textContent,/target: B$/);
});

test('Connect clears the previous QR and disables copying when the selected address disappears', async () => {
  const qr = {src:'',classList:{add(){},remove(){}},removeAttribute(k){delete this[k];}};
  const elements = {cxQr:qr,cxUrl:{},cxIntro:{}};
  let ready, available = true, copied = 0;
  const ctx = vm.createContext({
    AbortSignal, location:{hash:''}, setTimeout(){},
    navigator:{clipboard:{async writeText(){copied++;}}},
    document:{getElementById:id=>elements[id],querySelectorAll:()=>[]},
    window:{location:{href:'http://localhost/'},addEventListener:(_name,fn)=>{ready=fn;}},
    fetch:async url => ({ok:true,json:async()=>url === '/api/settings' ? {} : {
      settings:{remote_mode:'tunnel'},owner:true,primary_url:available?'https://example.invalid':null,
      qr_data_url:available?'data:image/svg+xml,test':null,unavailable_reason:'Configure the public link.'
    }})
  });
  vm.runInContext(readFileSync('static/connect.js','utf8'),ctx);
  ready();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(qr.src);
  available=false;
  await ctx.window.cxSetMode('tunnel');
  assert.equal(qr.src, undefined);
  assert.equal(elements.cxUrl.disabled,true);
  assert.match(elements.cxIntro.textContent,/Configure the public link/);
  await ctx.window.cxCopy();
  assert.equal(copied,0);
});

test('Connect shows a recoverable error on the first failed request and clears stale owner controls', async () => {
  const classList = () => {
    const classes = new Set();
    return {toggle:(key,on)=>on ? classes.add(key) : classes.delete(key),contains:key=>classes.has(key)};
  };
  const ids = ['cxHeading','cxIntro','cxUrl','cxRetry','cxPin','cxPinRow','cxQrSurface','cxMode','cxOwnerOnly'];
  const elements = Object.fromEntries(ids.map(id=>[id,{classList:classList()}]));
  let ready, failing = true;
  const ctx = vm.createContext({
    AbortSignal, location:{hash:''}, setTimeout(){},
    document:{getElementById:id=>elements[id],querySelectorAll:()=>[]},
    window:{addEventListener:(_name,fn)=>{ready=fn;}},
    fetch:async()=>{ if (failing) throw Error('Offline'); return {ok:true,json:async()=>({
      owner:true,settings:{remote_mode:'lan'},primary_url:'http://fixture.invalid/',pin:'123456'
    })}; }
  });
  vm.runInContext(readFileSync('static/connect.js','utf8'),ctx);
  ready();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(elements.cxHeading.textContent,/unavailable/i);
  assert.equal(elements.cxRetry.classList.contains('hidden'),false);
  assert.equal(elements.cxUrl.disabled,true);
  failing=false;
  await ctx.window.cxRefresh();
  assert.equal(elements.cxHeading.textContent,'Connect your phone');
  assert.equal(elements.cxRetry.classList.contains('hidden'),true);
  failing=true;
  await ctx.window.cxRefresh();
  assert.equal(elements.cxPinRow.classList.contains('hidden'),true);
  assert.equal(elements.cxQrSurface.classList.contains('hidden'),true);
});

test('initial project labels and the message field identify their purpose without live data', () => {
  const html = readFileSync('static/index.html','utf8');
  for (const id of ['activeConvWorkspace','changesSummaryWorkspace','currentWorkspaceName']) {
    assert.doesNotMatch(html.match(new RegExp('id="'+id+'"[^>]*>([^<]*)'))[1],/Autonomous AI/);
  }
  assert.match(html,/<textarea[^>]*id="taskInput"[^>]*aria-label="Message"/);
});
test('offline drafts preserve the saved model for backend validation and markdown links stay single', () => {
  const ctx = client();
  vm.runInContext('state.selectedModel="saved-id";state.selectedModelTarget="cli";state.modelCatalogConnected=false',ctx);
  assert.equal(vm.runInContext('taskModelOptions(true).model',ctx),'saved-id');
  assert.equal(vm.runInContext('renderMarkdown("[https://example.com](https://example.com)")',ctx).match(/<a /g).length,1);
});
