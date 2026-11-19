// Run explicitly: node tests/helpers/quick-notes-browser.mjs
// Fake host only. No real messages, clipboard writes, or production note storage.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'dist', 'quick-notes-a');
await mkdir(dist, { recursive: true });
const source = await readFile(path.join(root, 'ui/suggest-panel.html'), 'utf8');
const markup = source.slice(source.indexOf('<div id="notes-view"')).split('</section>')[0];
const panelSource = await readFile(path.join(root, 'ui/assets/suggest-panel.js'), 'utf8');
const measureSource = panelSource.slice(panelSource.indexOf('function measureToolsPageHeight()'), panelSource.indexOf('\nasync function showToolsView'));
const harness = `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/suggest-panel.css"><link rel="stylesheet" href="/assets/quick-notes.css"><script src="/assets/theme-follow.js"></script></head><body><main class="panel">${markup}</main><script>window.ready=new Promise(r=>window.readyResolve=r)</script><script type="module">
import {initQuickNotes} from '/assets/quick-notes.js';
let item={id:'note-1',revision:1,text:'茶话会生成的图片，先做一次内部审查。\\n确认没什么大问题，再发出来。',group:'茶话会',done:false,pinned:false,createdAt:1,updatedAt:1,delivery:{state:'none'}};
window.calls=[];window.copied=[];window.failUpdate=false;window.currentSession='probe-one';
window.ui=initQuickNotes({hana:{clipboard:{writeText:async({text})=>window.copied.push(text)},api:{fetch:async(route,init)=>{
 const body=init.body?JSON.parse(init.body):{};window.calls.push({route,body});let result;
 if(route==='/quick-notes')result={ok:true,items:[item]};
 else if(route.endsWith('/update')){if(window.waitUpdate)await new Promise(resolve=>window.releaseUpdate=resolve);if(window.failUpdate)result={ok:false,error:'测试保存失败'};else {item={...item,text:body.text,group:body.group,revision:item.revision+1};result={ok:true,item}}}
 else if(route.endsWith('/pin')){item={...item,pinned:body.pinned,revision:item.revision+1};result={ok:true,item}}
 else if(route.endsWith('/done')){item={...item,done:body.done,revision:item.revision+1};result={ok:true,item}}
 else if(route.endsWith('/send')){item={...item,done:true,delivery:{state:'sent'},revision:item.revision+1};result={ok:true,archived:true,sent:true,item}}
 else result={ok:false,error:'unexpected route'};
 return {ok:true,json:async()=>structuredClone(result)};
}}},getSessionId:()=>window.currentSession});
const toolsPage=document.getElementById('notes-view'),toolsGrid=toolsPage,TOOLS_PANEL_HEIGHT=300,MAX_PANEL_HEIGHT=640,toolsSubView='notes';window.measurePanelHeight=${measureSource};
ui.show();await ui.controller.load();window.readyResolve();
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/probe') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(harness); return; }
    const file = path.resolve(root, 'ui', '.' + url.pathname);
    if (!file.startsWith(path.join(root, 'ui') + path.sep)) { res.writeHead(403).end(); return; }
    const ext = path.extname(file);
    res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');await once(server, 'listening');
const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(dist, `profile-${Date.now()}`);
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const timeout = setTimeout(() => { console.error('Browser verification timed out'); child.kill(); process.exitCode = 1; server.close(); socket?.close(); }, 60000);
try {
  const wsUrl = await new Promise((resolve, reject) => {
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output); if (m) resolve(m[1]); });
    child.on('error', reject); child.on('exit', code => reject(new Error(`Edge exited ${code}`)));
  });
  socket = new WebSocket(wsUrl);await once(socket, 'open');
  let seq = 0;const pending = new Map();const waiters = new Map();const errors = [];
  socket.addEventListener('message', ({data}) => {
    const message = JSON.parse(data);
    if (message.id) { const job = pending.get(message.id);pending.delete(message.id);message.error ? job?.reject(new Error(JSON.stringify(message.error))) : job?.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method && waiters.has(message.method)) { const done = waiters.get(message.method);waiters.delete(message.method);done(message.params); }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq;pending.set(id, {resolve, reject});socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})); });
  const {targetId} = await send('Target.createTarget', {url:'about:blank'});
  const {sessionId} = await send('Target.attachToTarget', {targetId, flatten:true});
  const cdp = (method, params) => send(method, params, sessionId);
  await cdp('Page.enable');await cdp('Runtime.enable');
  const loaded = new Promise(resolve => waiters.set('Page.loadEventFired', resolve));
  await cdp('Page.navigate', {url:`http://127.0.0.1:${server.address().port}/probe?hana-theme-appearance=light`});await loaded;
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await evaluate('window.ready');
  const run = async code => evaluate(`(async()=>{${code}})()`);
  await run(`document.querySelector('.notes-item-open').click();`);
  assert.equal(await evaluate("!!document.querySelector('.notes-body') && !document.querySelector('.notes-edit-text')"), true, 'reader first');
  let checks = 1;
  for (const width of [320, 420, 760]) {
    await cdp('Emulation.setDeviceMetricsOverride', {width,height:700,deviceScaleFactor:1,mobile:false});
    for (const appearance of ['light','dark']) {
      const colors = await run(`window.postMessage({type:'hana.theme.changed',payload:{appearance:'${appearance}'}},'*');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const v=document.querySelector('.notes-view'),p=document.querySelector('.is-detail'),b=document.querySelector('.notes-body');return {mode:document.documentElement.dataset.appearance,ground:getComputedStyle(v).backgroundColor,paper:getComputedStyle(p).backgroundColor,body:getComputedStyle(b).backgroundColor,ink:getComputedStyle(b).color,scheme:getComputedStyle(v).colorScheme,overflow:document.documentElement.scrollWidth>innerWidth};`);
      assert.equal(colors.mode, appearance);assert.equal(colors.scheme, appearance);assert.equal(colors.overflow, false, `horizontal overflow ${width}/${appearance}`);
      assert.equal(colors.ground, appearance === 'dark' ? 'rgb(34, 39, 31)' : 'rgb(222, 223, 210)');
      assert.equal(colors.paper, appearance === 'dark' ? 'rgb(43, 49, 42)' : 'rgb(234, 232, 220)');
      assert.equal(colors.body, 'rgba(0, 0, 0, 0)');
      const needed = await evaluate('window.measurePanelHeight()');
      await cdp('Emulation.setDeviceMetricsOverride', {width,height:needed,deviceScaleFactor:1,mobile:false});
      const fit = await run(`const view=document.querySelector('.notes-view'),a=document.querySelector('.notes-detail-actions').getBoundingClientRect();return {height:view.getBoundingClientRect().height,pageOverflow:document.documentElement.scrollHeight>innerHeight+1,buttonsVisible:a.bottom<=innerHeight};`);
      assert.ok(fit.height <= 360, `note exceeds compact height budget: ${JSON.stringify({width, ...fit})}`);
      console.log('compact-height', JSON.stringify({width, appearance, measured:needed, ...fit}));
      assert.equal(fit.pageOverflow,false, 'host-reported height must fit without scrolling the whole panel');
      assert.equal(fit.buttonsVisible,true);
      if (width === 420) { const shot = await cdp('Page.captureScreenshot', {format:'png'});await writeFile(path.join(dist, `detail-${appearance}.png`), Buffer.from(shot.data, 'base64')); }
      await run(`document.querySelector('.notes-edit-trigger').click();`);
      const editHeight = await evaluate('window.measurePanelHeight()');
      await cdp('Emulation.setDeviceMetricsOverride', {width,height:editHeight,deviceScaleFactor:1,mobile:false});
      const editFit = await run(`const view=document.querySelector('.notes-view').getBoundingClientRect(),footer=document.querySelector('.notes-item-note').getBoundingClientRect();return {pageOverflow:document.documentElement.scrollHeight>innerHeight+1,footerBottom:footer.bottom,limit:view.bottom};`);
      assert.equal(editFit.pageOverflow,false, 'editing must fit the host-reported height');
      assert.ok(editFit.footerBottom<=editFit.limit, `editing footer clipped: ${JSON.stringify({width,...editFit})}`);
      await run(`document.querySelectorAll('.notes-edit-actions button')[1].click();`);
      checks++;
    }
  }
  const singleHeight = await run(`const item=ui.controller.state.items[0];ui.controller.mergeItem({...item,text:'给茶话会生图加一道内部审查，确认后再发。'});ui.controller.notify();return document.querySelector('.notes-view').getBoundingClientRect().height;`);
  assert.ok(singleHeight<280, `single-line note must stay compact: ${singleHeight}`);checks++;
  await run(`document.querySelector('.notes-edit-trigger').click();const t=document.querySelector('.notes-edit-text');t.value='改稿\\n第二行  两空格';t.dispatchEvent(new Event('input'));ui.setSession('probe-one');`);
  assert.equal(await evaluate("document.querySelector('.notes-edit-text').value"), '改稿\n第二行  两空格', 'same-session notifications preserve editor');
  await run(`document.querySelectorAll('.notes-detail-actions button')[1].click();await Promise.resolve();`);
  assert.equal(await evaluate('window.copied.at(-1)'), '改稿\n第二行  两空格');
  assert.equal(await evaluate("document.querySelector('.notes-detail-actions button').disabled"), true, 'dirty send blocked');
  await run(`window.failUpdate=true;document.querySelector('.notes-edit-actions button').click();await new Promise(r=>setTimeout(r,30));`);
  assert.equal(await evaluate("document.querySelector('.notes-edit-text').value"), '改稿\n第二行  两空格');checks++;
  await run(`ui.hide();ui.show();await new Promise(r=>setTimeout(r,30));`);
  assert.equal(await evaluate("document.querySelector('.notes-edit-text').value"), '改稿\n第二行  两空格', 'reopen restores editing draft');checks++;
  await run(`window.failUpdate=false;document.querySelector('.notes-edit-actions button').click();await new Promise(r=>setTimeout(r,30));`);
  assert.equal(await evaluate("document.querySelector('.notes-body').textContent"), '改稿\n第二行  两空格');
  assert.equal(await evaluate("!!document.querySelector('.notes-edit-text')"), false);checks++;
  await run(`document.querySelector('.notes-edit-trigger').click();document.querySelectorAll('.notes-edit-actions button')[1].click();`);
  assert.equal(await evaluate("!!document.querySelector('.notes-body')"), true, 'clean editing can be cancelled');checks++;
  const darkFields = await run(`document.querySelector('.notes-edit-trigger').click();return [...document.querySelectorAll('.notes-edit-text,.notes-edit-group')].map(x=>({bg:getComputedStyle(x).backgroundColor,color:getComputedStyle(x).color}));`);
  assert.ok(darkFields.every(x=>x.bg==='rgb(43, 49, 42)'&&x.color==='rgb(232, 229, 218)'));checks++;
  await run(`const t=document.querySelector('.notes-edit-text');t.value='慢请求';t.dispatchEvent(new Event('input'));window.waitUpdate=true;document.querySelector('.notes-edit-actions button').click();window.currentSession='probe-two';ui.setSession('probe-two');const other={...ui.controller.state.items[0],id:'note-2'};ui.controller.mergeItem(other);ui.controller.setExpanded('note-2');document.querySelector('.notes-edit-trigger').click();const next=document.querySelector('.notes-edit-text');next.value='新会话编辑稿';next.dispatchEvent(new Event('input'));window.releaseUpdate();await new Promise(r=>setTimeout(r,30));`);
  assert.equal(await evaluate("document.querySelector('.notes-edit-text').value"), '新会话编辑稿', 'old save response must not close a new session editor');checks++;
  await run(`window.waitUpdate=false;window.currentSession='probe-one';ui.setSession('probe-one');ui.controller.discardEdit('note-1');ui.controller.setExpanded('note-1');`);
  await run(`const item=ui.controller.state.items.find(x=>x.id==='note-1');ui.controller.mergeItem({...item,text:'长正文与空格  换行\\n'.repeat(1000)});ui.controller.notify();`);
  const longHeight = await evaluate('window.measurePanelHeight()');
  await cdp('Emulation.setDeviceMetricsOverride', {width:760,height:longHeight,deviceScaleFactor:1,mobile:false});
  const positions = await run(`const a=document.querySelector('.notes-detail-actions').getBoundingClientRect();const b=document.querySelector('.notes-body');const v=document.querySelector('.notes-view').getBoundingClientRect();return {bottom:a.bottom,limit:v.bottom,scroll:b.scrollHeight>b.clientHeight,pageOverflow:document.documentElement.scrollHeight>innerHeight+1};`);
  assert.equal(positions.pageOverflow,false, 'long note must not scroll the entire panel');
  assert.equal(positions.scroll, true);assert.ok(positions.bottom < positions.limit, 'long text cannot push actions out of view');checks++;
  await run(`document.querySelector('.notes-detail-actions button').click();await new Promise(r=>setTimeout(r,30));`);
  assert.equal(await evaluate("ui.controller.state.items.find(x=>x.id==='note-1').done"), true);
  assert.equal(await evaluate("window.calls.filter(x=>x.route==='/quick-notes/send').length"), 1);checks++;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed:checks, widths:[320,420,760], modes:['light','dark'], screenshots:dist, fakeHost:true},null,2));
  await send('Browser.close');
} finally {
  clearTimeout(timeout);socket?.close();child.kill();server.close();
}
