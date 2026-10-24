import { ui } from '../../site/src/i18n/ui.js';

const PREFIX = 'gpx.';
const copy = Object.fromEntries(
  Object.entries(ui.en)
    .filter(([key]) => key.startsWith(PREFIX))
    .map(([key, value]) => [key.slice(PREFIX.length), value]),
);

export function renderGpxCopy(): string {
  return `window.GpxCopy = ${JSON.stringify({ en: copy })};`;
}
