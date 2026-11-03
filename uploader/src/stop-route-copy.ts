import { ui } from '../../site/src/i18n/ui.js';

const PREFIX = 'editor.stopRoute.';

/** `/admin/stop-route-copy.js` (#513): editor + Settings copy from the bilingual dictionary. No secrets. */
export function renderStopRouteCopy(): string {
  const copy = Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
    locale, Object.fromEntries(Object.entries(strings)
      .filter(([key]) => key.startsWith(PREFIX))
      .map(([key, value]) => [key.slice(PREFIX.length), value])),
  ]));
  return `window.StopRouteCopy = ${JSON.stringify(copy)};`;
}
