import { hana } from './sdk.js';
import { followHostTheme } from './theme-report.js';

// 深浅跟着宿主走，顺手报给 App（它再转给传音樱）。
followHostTheme();

const $ = (id) => document.getElementById(id);
const optionsBox = $('ask-options');
const noteInput = $('ask-note');
const status = $('ask-status');
let binding = null;

function syncTheme() {
  const theme = hana.theme?.getSnapshot?.();
  if (theme?.appearance === 'light' || theme?.appearance === 'dark') {
    document.documentElement.dataset.appearance = theme.appearance;
  }
}

function showOptional(element, text) {
  element.textContent = text;
  element.hidden = !text;
}

function render(context) {
  if (!context) return;
  const samePanel = binding?.panelId === context.panelId;
  const previousChoice = samePanel ? optionsBox.querySelector('input:checked')?.value : '';
  const previousNote = samePanel ? noteInput.value : '';
  const needsRender = !binding || binding.panelId !== context.panelId || binding.revision !== context.revision;
  binding = { panelId: context.panelId, revision: context.revision };
  if (needsRender) {
    const data = context.data && typeof context.data === 'object' ? context.data : {};
    const allowed = context.requestedSchema?.properties?.choice?.enum;
    const choices = Array.isArray(allowed) ? allowed : [];
    $('ask-heading').textContent = context.title || '请你拍板';
    $('ask-question').textContent = typeof data.question === 'string' ? data.question : context.message || '';
    showOptional($('ask-background'), typeof data.background === 'string' && data.background.trim() ? `背景 · ${data.background}` : '');
    const recommendation = typeof data.recommendation === 'string' ? data.recommendation.trim() : '';
    $('ask-recommend').hidden = !recommendation;
    $('ask-recommend-text').textContent = recommendation;
    showOptional($('ask-reason'), typeof data.reason === 'string' && data.reason.trim() ? `理由 · ${data.reason}` : '');
    optionsBox.replaceChildren();
    for (const [index, choice] of choices.entries()) {
      if (typeof choice !== 'string') continue;
      const detail = Array.isArray(data.options)
        ? data.options.find((option) => option?.label === choice)?.detail
        : '';
      const label = document.createElement('label');
      label.className = 'option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'choice';
      input.value = choice;
      input.checked = previousChoice ? previousChoice === choice : false;
      input.id = `option-${index}`;
      const copy = document.createElement('span');
      copy.className = 'option-copy';
      const name = document.createElement('span');
      name.className = 'option-name';
      name.textContent = choice;
      copy.append(name);
      if (typeof detail === 'string' && detail) {
        const description = document.createElement('span');
        description.className = 'option-detail';
        description.textContent = detail;
        copy.append(description);
      }
      label.append(input, copy);
      if (recommendation && recommendation === choice) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '推荐';
        label.append(badge);
      }
      optionsBox.append(label);
    }
    noteInput.value = previousNote;
  }
  const pending = context.status === 'pending';
  for (const input of optionsBox.querySelectorAll('input')) input.disabled = !pending;
  noteInput.disabled = !pending;
  status.textContent = pending ? '' : '这道问题已结束。';
}

optionsBox.addEventListener('change', () => { status.textContent = ''; });
hana.inputPanel.onContextChanged(render);
hana.inputPanel.onSubmit((context) => {
  if (!binding || context.panelId !== binding.panelId || context.revision !== binding.revision || context.status !== 'pending') {
    throw new Error('问题已变化，请重新查看后再确认。');
  }
  const choice = optionsBox.querySelector('input:checked')?.value;
  if (!choice || !context.requestedSchema?.properties?.choice?.enum?.includes(choice)) {
    status.textContent = '先选一个方向，再点确认。';
    throw new Error('请先选择一个方向。');
  }
  return { choice, note: noteInput.value.trim() };
});
hana.theme?.subscribe?.(syncTheme);
await hana.ready();
syncTheme();
render(hana.inputPanel.getContext());
