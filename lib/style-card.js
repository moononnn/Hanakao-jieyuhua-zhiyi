// 推荐方向的「对话式修订」建议卡。
//
// 形态按知识卡片 kc-design-对话式修订建议应用：卡长在对话流末尾，
// 每条给「现在 / 改完以后」对照 + 一个「这条不要」，卡底一个「确认修改」。
// 单条丢弃在卡上就地生效（不改任何真实配置），只有「确认修改」才写盘——修改权在用户手里。

import { diffStyles } from "./style-refine.js";

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildStyleRefineCardDocument(draft, currentConfig) {
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const diff = diffStyles(currentConfig, items.map((item) => ({ name: item.name, intent: item.intent })));
  const data = safeJson({
    reply: String(draft?.reply || "").slice(0, 200),
    planId: String(draft?.planId || ""),
    items: diff.map((item) => ({
      key: item.key,
      name: item.name,
      intent: item.intent,
      action: item.action,
      before: item.before ? { name: item.before.name, intent: item.before.intent } : null,
    })),
  });
  const manifest = safeJson({
    spec: "1.0",
    display: { styleProfile: "custom", preferredWidthPx: 460 },
    toolBindings: {
      apply: { tool: "jiegehua_zhiyi_apply_recommendation_styles", input: {}, slots: ["planId", "droppedKeys"] },
    },
  });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>知意 · 改推荐方向</title>
<style>
:root{--paper:#f8f5ed;--surface:#fffdfa;--ink:#35493e;--muted:#718077;--mint:#e7f1e9;--deep:#477a66;--line:#e6e4da;font-family:'LXGW WenKai','Microsoft YaHei','Noto Sans SC',sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}main{max-width:460px;margin:0 auto;padding:44px 18px 16px}.eyebrow{margin:0 0 5px;text-align:center;color:var(--deep);font-size:11px;letter-spacing:.07em}h1{margin:0 0 6px;text-align:center;font-size:18px;font-weight:600;line-height:1.5}.lead{margin:0 0 14px;text-align:center;color:var(--muted);font-size:13px;line-height:1.7}.list{display:grid;gap:8px}.item{display:grid;gap:6px;padding:11px 12px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.item[data-changed="true"]{border-color:#e89bb0}.tag{align-self:start;padding:2px 7px;border-radius:99px;background:var(--mint);color:var(--deep);font-size:11px}.tag[data-kind="add"]{background:#faedf0;color:#b76e80}.name{margin:0;font-size:14px;font-weight:600}.intent{margin:2px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.before{margin:0;font-size:12px;color:var(--muted);line-height:1.6;text-decoration:line-through}.drop{align-self:start;padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.drop:hover{border-color:var(--deep);color:var(--deep)}.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}.confirm{padding:9px 14px;border:0;border-radius:10px;background:var(--deep);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer}.confirm:disabled{cursor:not-allowed;opacity:.5}.confirm:focus-visible{outline:2px solid #e89bb0;outline-offset:2px}.status{min-height:18px;margin:10px 2px 0;color:var(--muted);font-size:11px;line-height:1.6;text-align:center}*{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}*::-webkit-scrollbar{width:8px;height:8px}*::-webkit-scrollbar-track{background:transparent}*::-webkit-scrollbar-thumb{border:2px solid var(--paper);border-radius:99px;background:#c9dfd3}
</style>
</head>
<body>
<main>
<p class="eyebrow">解语花 · 知意</p>
<h1>推荐方向要不要这样</h1>
<p class="lead" id="lead"></p>
<div class="list" id="list"></div>
<div class="actions"><button type="button" class="confirm" id="confirm">确认修改</button></div>
<p class="status" id="status" role="status" aria-live="polite"></p>
</main>
<script type="application/json" data-card-manifest>${manifest}</script>
<script type="application/json" id="style-data">${data}</script>
<script>
(function(){
  var data;try{data=JSON.parse(document.getElementById('style-data').textContent)}catch{data={items:[],planId:'',reply:''}}
  var list=document.getElementById('list'),status=document.getElementById('status'),confirm=document.getElementById('confirm');
  document.getElementById('lead').textContent=data.reply||'下面是改完的方向，你点「确认修改」才会生效。';
  var dropped=[];
  var labelOf=function(action){return action==='add'?'新增':action==='update'?'改过':'保留'};
  (data.items||[]).forEach(function(item){
    var row=document.createElement('section');
    row.className='item';
    row.setAttribute('data-changed',String(item.action!=='keep'));
    var tag=document.createElement('span');tag.className='tag';tag.dataset.kind=item.action;tag.textContent=labelOf(item.action);
    var name=document.createElement('p');name.className='name';name.textContent=item.name;
    var intent=document.createElement('p');intent.className='intent';intent.textContent=item.intent;
    row.append(tag,name,intent);
    if(item.before){
      var before=document.createElement('p');before.className='before';
      before.textContent='现在：'+item.before.name+'｜'+item.before.intent;
      row.insertBefore(before,intent);
    }
    var drop=document.createElement('button');drop.type='button';drop.className='drop';drop.textContent='这条不要';
    drop.addEventListener('click',function(){
      row.remove();dropped.push(item.key);confirm.disabled=false;
      status.textContent='这条先剔掉了，还没改你的设置；想找回就再聊一句。';
    });
    row.appendChild(drop);
    list.appendChild(row);
  });
  confirm.addEventListener('click',async function(){
    confirm.disabled=true;status.textContent='正在保存…';
    try{
      var result=await window.card.invoke('apply',{planId:data.planId,droppedKeys:dropped.join(',')});
      if(result&&result.isError===true){
        confirm.disabled=false;status.textContent=(result&&result.message)||'没保存上，卡还开着，你可以直接再点一次。';
        return;
      }
      if(result&&result.ok===true){
        confirm.textContent='已用上 ✓';
        status.textContent='方向已经换好了。设置页的「推荐方向」里能看到，随时可以再聊。';
        return;
      }
      confirm.disabled=false;status.textContent='没保存上，卡还开着，你可以直接再点一次。';
    }catch(error){
      confirm.disabled=false;status.textContent='没保存上，卡还开着，你可以直接再点一次。';
    }
  });
})();
</script>
</body>
</html>`;
}

export function buildShowStyleCardInput(fileId) {
  return { title: "知意改推荐方向", file: { type: "session_file", fileId: String(fileId) } };
}

export function buildShowStyleCardInstruction(input) {
  return [
    "已经生成一份推荐方向的修改建议。下一步必须立即调用内置 show_card 工具，把下面参数原样传入，并让 show_card 作为最后一步；不要把卡片内容复述给用户：",
    JSON.stringify(input),
  ].join("");
}
