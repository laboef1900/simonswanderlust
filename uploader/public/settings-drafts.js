// Track intent, never field values: credentials and selected files stay in their controls.
window.SettingsDrafts = (function () {
  const scopes = new Map();
  let installed = false;
  let leaving = false;
  function changed() { return [...scopes.values()].filter((scope) => scope.dirty); }
  function render() {
    const copy = EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
    const pending = changed();
    document.getElementById('settingsDraftBar').hidden = pending.length === 0;
    document.getElementById('settingsDraftStatus').textContent = pending.length
      ? copy.settingsUnsaved.replace('{sections}', [...new Set(pending.map((scope) => scope.label))].join(', ')) : '';
  }
  function watch(id, root, label) {
    if (!installed) {
      installed = true;
      const bar = document.getElementById('settingsDraftBar');
      if (window.ResizeObserver) {
        new ResizeObserver(() => {
          const height = bar.hidden ? 0 : bar.getBoundingClientRect().height;
          bar.parentElement.style.setProperty('--settings-draft-height', height + 'px');
        }).observe(bar);
      }
      window.addEventListener('beforeunload', (event) => {
        if (leaving || !changed().length) return;
        event.preventDefault();
        event.returnValue = '';
      });
      document.getElementById('settingsDiscard').addEventListener('click', async () => {
        if (!changed().length) return;
        const copy = EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
        if (!await AdminConfirm.ask({ title: copy.settingsDiscard, body: copy.settingsDiscardConfirm,
          confirmLabel: copy.settingsDiscard, danger: true })) return;
        leaving = true;
        window.location.reload();
      });
    }
    const scope = { label, dirty: false };
    scopes.set(id, scope);
    const mark = () => { if (!scope.dirty) { scope.dirty = true; render(); } };
    root.addEventListener('input', mark);
    root.addEventListener('change', mark);
    return {
      mark,
      clean() {
        scope.dirty = false;
        render();
      },
      isDirty: () => scope.dirty,
    };
  }
  return { watch };
})();
