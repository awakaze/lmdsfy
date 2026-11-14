import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({ window: {}, structuredClone });
vm.runInContext(fs.readFileSync(new URL('../public/history.js', import.meta.url), 'utf8'), context);
const history = context.window.ChatHistory;
const fixture = () => ({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'original', server_tool_calls: [{ signature: 'signed-page' }] }, { role: 'user', content: 'follow up' }, { role: 'assistant', content: 'follow up answer' }] });
test('regeneration keeps previous replies and their follow-up branches after reload', () => {
  let c = fixture();
  const pending = history.prepareRegeneration(c, 1);
  assert.equal(c.messages[1].content, 'original');
  history.commitRegeneration(c, pending, { role: 'assistant', content: 'new answer' });
  assert.equal(c.messages[1].variantIndex, 1);
  c = JSON.parse(JSON.stringify(c));
  history.selectVersion(c, 1, 0);
  assert.equal(c.messages[1].content, 'original');
  assert.equal(c.messages[3].content, 'follow up answer');
  assert.equal(c.messages[1].server_tool_calls[0].signature, 'signed-page');
  history.selectVersion(c, 1, 1);
  assert.equal(c.messages[1].content, 'new answer');
  assert.equal(c.messages.length, 2);
});
test('failed regeneration never deletes the current answer or later history', () => {
  const c = fixture(); const before = JSON.stringify(c);
  history.prepareRegeneration(c, 1); // No commit on request failure.
  assert.equal(JSON.stringify(c), before);
});
test('repeated generation preserves every version and follows the selected branch', () => {
  const c = fixture();
  history.commitRegeneration(c, history.prepareRegeneration(c, 1), { role: 'assistant', content: 'second' });
  c.messages.push({ role: 'user', content: 'second branch' });
  history.selectVersion(c, 1, 0);
  history.commitRegeneration(c, history.prepareRegeneration(c, 1), { role: 'assistant', content: 'third' });
  assert.equal(c.messages[1].variants.length, 3);
  history.selectVersion(c, 1, 1);
  assert.equal(c.messages[2].content, 'second branch');
});

test('the actual regenerate button sends a version request without erasing history', () => {
  const c = fixture(); const before = JSON.stringify(c); const elements = []; let request;
  const document = { createElement() { const e = { children: [], textContent: '', setAttribute() {}, append(...nodes) { this.children.push(...nodes); } }; elements.push(e); return e; } };
  const scope = vm.createContext({ document, structuredClone, ChatHistory: history, busy: false, navigator: {}, media: {}, conv: c,
    openConv() {}, sendQuestion(...args) { request = args; }, body: { append() {} },
  });
  const html = fs.readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
  const functions = html.slice(html.indexOf('  function actionButton('), html.indexOf('  function buildAssistantBlock('));
  vm.runInContext(functions + ';addAnswerActions({querySelector:s=>s===".body"?body:null},"original",conv,1);', scope);
  const buttons = elements.filter(e => e.innerHTML?.startsWith('<svg'));
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every(e => !e.textContent));
  buttons[2].onclick();
  assert.equal(JSON.stringify(c), before);
  assert.equal(request[0], 'q'); assert.equal(request[2].prefix.length, 1);
  assert.equal(request[2].variants[0].following[1].content, 'follow up answer');
});
