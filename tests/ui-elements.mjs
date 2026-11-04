import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../plugin/ui.html', import.meta.url), 'utf8');
export function createUIElements() {
  return Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', textContent: '', hidden: false, disabled: false, checked: false, dataset: {},
    focus() { this.focused = true; }, click() { this.onclick?.(); },
  }]));
}
