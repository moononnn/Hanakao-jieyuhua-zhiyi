import { hana } from './sdk.js';

const PERMISSIONS = [
  { capability: 'app/tools.expose-to-model', title: '让伙伴调用知意工具', detail: '关键提问与推荐回复等工具是否可供伙伴使用。' },
  { capability: 'app/hooks.agent-before-start', title: '生成前加入知意引导', detail: '在伙伴开始回复前提醒其留意重要分岔。' },
  { capability: 'app/hooks.messages-post-assistant', title: '回复后附加速览', detail: '按设置在伙伴回复末尾附上长回复速览。' },
  { capability: 'app/hooks.provider-before-request', title: '发出前清理旧速览', detail: '旧版留下的速览卡会从发给模型的历史里去掉，避免伙伴跟着模仿。' },
  { capability: 'app/models.infer', title: '调用 Hana 已配置模型', detail: '用于 Ask 判断、推荐回复与长回复速览。' },
  { capability: 'app/sessions.read', title: '读取会话文字', detail: '推荐回复只读取发起对话最近的可见文字。' },
  { capability: 'app/agents.read', title: '读取伙伴名单', detail: '朗读前确定该叫哪个伙伴；未授权时会退回用会话名单冒充。' },
  { capability: 'app/session.start-turn', title: '在会话里发起对话回合', detail: '把传音樱上的答案送回来源对话并唤起伙伴回复；也用于明确点击的发送和续接。' },
  { capability: 'app/process.spawn', title: '运行桌面传音樱', detail: '还需要本机具备 Python 与 PyQt6。' },
  { capability: 'app/ui.open-external', title: '打开外部链接', detail: '反馈里的「去提 issue」和邮件按钮靠它；没开就点不动。' },
  { capability: 'app/ui.clipboard-write', title: '写剪贴板', detail: '把整理好的反馈正文复制给你；没开只能自己选中复制。' },
];

const STATUS_LABELS = new Map([
  ['always', ['始终允许', 'allowed']],
  ['session', ['会话范围授权', 'session']],
  ['denied', ['已拒绝', 'denied']],
  ['not_asked', ['尚未询问', 'not-asked']],
]);

export function permissionPresentation(status) {
  const presentation = STATUS_LABELS.get(status);
  return presentation ? [...presentation] : ['无法确认', 'unknown'];
}

function renderPermissions(list, rows) {
  const byCapability = new Map(rows.map((row) => [row?.capability, row]));
  list.replaceChildren();
  for (const permission of PERMISSIONS) {
    const row = byCapability.get(permission.capability);
    const [label, tone] = permissionPresentation(row?.status);
    const card = document.createElement('article');
    card.className = 'permission-card';
    const copy = document.createElement('div');
    copy.className = 'permission-card-copy';
    const title = document.createElement('h3');
    title.textContent = permission.title;
    const detail = document.createElement('p');
    detail.textContent = permission.detail;
    const status = document.createElement('span');
    status.className = 'permission-state';
    status.dataset.status = tone;
    status.textContent = label;
    copy.append(title, detail);
    card.append(copy, status);
    list.appendChild(card);
  }
}

export function initPermissionStatus() {
  const list = document.querySelector('#permission-status-list');
  if (!list) return;
  const button = document.querySelector('#permission-status-refresh');
  const message = document.querySelector('#permission-status-message');

  async function refresh() {
    if (button) {
      button.disabled = true;
      button.textContent = '正在读取…';
    }
    if (message) message.textContent = '正在读取 Hana 当前记录…';
    try {
      const response = await hana.api.fetch('/permission-status');
      let payload;
      try { payload = await response.json(); } catch { throw new Error('权限状态读取失败。'); }
      if (!response.ok || payload?.ok !== true || !Array.isArray(payload.capabilities)) {
        throw new Error(payload?.error || '权限状态读取失败。');
      }
      renderPermissions(list, payload.capabilities);
      if (message) message.textContent = '状态已更新。此页只读取授权记录，不会申请或更改权限。';
      if (button) button.textContent = '刷新状态';
    } catch {
      renderPermissions(list, []);
      if (message) message.textContent = '暂时读取不到授权记录；请到 Hana「设置 → 应用 → 应用权限 → 解语花·知意」查看。此页不会代你更改权限。';
      if (button) button.textContent = '重试读取';
    } finally {
      if (button) button.disabled = false;
    }
  }

  button?.addEventListener('click', () => { void refresh(); });
  void refresh();
}
