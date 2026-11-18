const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

(async () => {
  const evidenceDir = process.argv[3] || 'docs/review';
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-ui-'));
  const chrome = spawn(process.env.BRIDGE_CHROME_EXE || path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1105/chrome-win/chrome.exe'),
    ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  let socket;
  try {
    let endpoint;
    for (let i = 0; i < 100; i++) {
      try { endpoint = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!endpoint) throw Error('Chrome did not start');
    socket = new WebSocket(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    const errors = [];
    socket.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
      if (pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        data.error ? reject(Error(data.error.message)) : resolve(data.result);
      }
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const command = (method, params) => send(method, params, sessionId);
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await command('Runtime.enable');
    await command('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true });
    await command('Page.navigate', { url: process.argv[2] || 'http://127.0.0.1:8000/' });
    for (let i=0;i<100;i++) {
      if (await evaluate('typeof state !== "undefined"')) break;
      await new Promise(r=>setTimeout(r,100));
    }
    await evaluate(`(async()=>{const result=await safeFetchJson('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Browser verification'})});if(!result.data?.id)throw Error('Draft creation failed');await loadConversation(result.data.id);})()`);
    let ready = false;
    for (let i=0;i<400;i++) {
      ready = await evaluate('typeof state !== "undefined" && state.modelCatalogConnected');
      if (ready) break;
      await new Promise(r=>setTimeout(r,200));
    }
    if (!ready) throw Error('The browser model catalog did not connect');
    const models = await evaluate('({count:state.availableModels.length,families:getModelFamilies(state.availableModels).map(f=>({name:f.name,levels:f.variants.map(v=>v.performance)})),source:state.modelCatalogMessage})');
    await evaluate('openModelSheet()');
    await new Promise(r=>setTimeout(r,400));
    const picker = await command('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(evidenceDir,'model-picker.png'), Buffer.from(picker.data,'base64'));
    // Choose from the account's actual catalog, without requiring a paid model or
    // a fixed count of models/families.
    await evaluate(`(() => {const families = getModelFamilies(state.availableModels);
      const family = families.find(f=>f.variants.some(v=>!v.disabled && v.performance==='XHigh')) || families.find(f=>f.variants.filter(v=>!v.disabled).length>1);
      const selected = family?.variants.find(v=>!v.disabled && v.performance==='XHigh') || family?.variants.find(v=>!v.disabled) || state.availableModels.find(v=>!v.disabled);
      if (!selected) throw Error('No enabled account model'); selectModel(selected.id);
      document.querySelector('details.composer-options').open=true; document.getElementById('mainPerformanceSelector').scrollIntoView({block:'center'});})()`);
    await new Promise(r=>setTimeout(r,300));
    const performance = await evaluate('({levels:[...document.querySelectorAll("#mainPerformanceSelector [data-perf]")].map(b=>({text:b.textContent,selected:b.getAttribute("aria-pressed")})),model:state.selectedModel,horizontalOverflow:document.documentElement.scrollWidth>innerWidth})');
    const controls = await command('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(evidenceDir,'performance.png'), Buffer.from(controls.data,'base64'));
    const submission = await evaluate('taskModelOptions()');
    await evaluate(`(() => {
      if (document.querySelectorAll('#mainPerformanceSelector [data-perf]').length < 4) {
        fetchModels = async () => {};
        state.modelCatalogRequest = null;
        state.availableModels = ['Low','Medium','High','XHigh'].map(level => ({ id: 'fixture-' + level.toLowerCase(), name: 'Fixture (' + level + ')', disabled: false }));
        state.modelCatalogConnected = true;
        state.connectedTarget = 'cli';
        state.modelCatalogKey = modelCatalogKey();
        selectModel('fixture-xhigh');
      }
      document.querySelector('details.composer-options').open = true;
    })()`);
    const layouts = [];
    for (const [width, height] of [[320,568],[390,844],[390,450],[768,844],[820,844],[821,844],[1280,844]]) {
      await command('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:width<=820});
      await evaluate(`(() => {
        document.querySelector('details.composer-options').open = true;
        document.getElementById('btnSubmitTask').scrollIntoView({block:'center'});
      })()`);
      await new Promise(r=>setTimeout(r,150));
      layouts.push(await evaluate(`(() => {
        const send = document.getElementById('btnSubmitTask');
        const r = send.getBoundingClientRect();
        const navEl = document.querySelector('.apple-view-tabs');
        const n = navEl ? navEl.getBoundingClientRect() : { top: innerHeight, bottom: innerHeight };
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        const perfButtons = [...document.querySelectorAll('#mainPerformanceSelector [data-perf]')];
        return {
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          send: { top: r.top, bottom: r.bottom },
          nav: { top: n.top, bottom: n.bottom },
          sendHit: hit === send || send.contains(hit),
          performanceCount: perfButtons.length,
          performanceRows: [...new Set(perfButtons.map(b => Math.round(b.getBoundingClientRect().top)))],
        };
      })()`));
    }
    const evidence = {models,performance,submission,layouts,errors};
    await fs.writeFile(path.join(evidenceDir,'model-browser.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence,null,2));
    if (
      errors.length ||
      !models.families.length ||
      !performance.levels.some(v=>v.selected==='true') ||
      submission.model !== performance.model ||
      layouts.some(v =>
        v.scrollWidth > v.width ||
        v.performanceCount < 4 ||
        v.performanceRows.length !== 1 ||
        !v.sendHit ||
        (v.width <= 820 && v.send.bottom > v.nav.top)
      )
    ) throw Error('Browser acceptance check failed');
    await send('Browser.close');
  } finally {
    socket?.close();
    chrome.kill();
    if (chrome.exitCode === null) await new Promise(resolve => { chrome.once('exit', resolve); setTimeout(resolve, 5000); });
    if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('agy-ui-')) throw Error('Unexpected browser profile path');
    await fs.rm(profile, {recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
