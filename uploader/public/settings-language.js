window.SettingsLanguage = (function () {
  'use strict';
  function init() {
    const $ = (id) => document.getElementById(id);
    let loaded = null;
    let busy = false;
    const status = (text) => { $('languageStatus').textContent = text; };
    function candidate() {
      const [primary, locales] = $('languageMode').value.split(':');
      return { primary, locales: locales.split(',') };
    }
    function scope() {
      if (!loaded) return '';
      const next = candidate();
      const added = next.locales.find((locale) => !loaded.locales.includes(locale));
      if (next.primary === loaded.primary && added) {
        return SiteLanguage.text('ScopeAdd', { locale: added });
      }
      if (next.primary !== loaded.primary) return SiteLanguage.text('ScopePrimary');
      if (next.locales.length < loaded.locales.length) return SiteLanguage.text('ScopeDisable');
      return SiteLanguage.text('ScopeSame');
    }
    function paint(value) {
      loaded = SiteLanguage.accept(value);
      $('languageMode').value = loaded.primary + ':' + loaded.locales.join(',');
      for (const option of $('languageMode').querySelectorAll('option')) {
        const [primary, locales] = option.value.split(':');
        const primaryLocked = loaded.lockedAt && primary !== loaded.primary;
        const localeLocked = loaded.lockedAt && locales.split(',').length < loaded.locales.length;
        option.disabled = Boolean(primaryLocked || localeLocked);
        option.title = primaryLocked ? SiteLanguage.error({ code: 'language_primary_locked' })
          : localeLocked ? SiteLanguage.error({ code: 'language_locale_published' }) : '';
      }
      $('languageLock').textContent = loaded.lockedAt
        ? SiteLanguage.text('Locked', { date: new Date(loaded.lockedAt).toLocaleString() })
        : SiteLanguage.text('Unlocked');
      const secondary = loaded.primary === 'de' ? 'en' : 'de';
      const prepare = $('prepareLanguage');
      prepare.hidden = loaded.locales.includes(secondary);
      prepare.href = '/admin/about.html?prepareLocale=' + secondary;
      prepare.textContent = SiteLanguage.text('Prepare', { locale: secondary.toUpperCase() });
      $('languageScope').textContent = scope();
      $('languageFields').disabled = false;
    }
    async function load() {
      if (busy) return;
      busy = true;
      $('languageFields').disabled = true;
      $('languageReload').disabled = true;
      status(SiteLanguage.text('Loading'));
      try { paint(await SiteLanguage.get(true)); status(''); }
      catch (error) { status(error.message); }
      finally { busy = false; $('languageReload').disabled = false; }
    }
    $('languageMode').addEventListener('change', () => { $('languageScope').textContent = scope(); });
    $('languageReload').addEventListener('click', load);
    $('languageForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy || !loaded) return;
      const next = candidate();
      busy = true;
      $('languageFields').disabled = true;
      $('languageReload').disabled = true;
      try {
        if (!(await AdminConfirm.ask({ title: SiteLanguage.text('ChangeTitle'), body: scope(), confirmLabel: SiteLanguage.text('Save') }))) return;
        status(SiteLanguage.text('Saving'));
        $('languageBlockers').replaceChildren();
        const response = await fetch('/language', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) });
        if (response.status === 401) { location.href = '/login'; return; }
        const body = await response.json();
        if (!response.ok) {
          status(response.status >= 500 ? BuildReporting.text('unknown') : (SiteLanguage.error(body) || SiteLanguage.text('SaveFailed')));
          for (const blocker of body.blockers || []) {
            const li = document.createElement('li');
            li.textContent = (SiteLanguage.names[blocker.locale] || blocker.locale) + ' / ' + blocker.key + ' / ' + blocker.field + ': ' + blocker.reason;
            $('languageBlockers').appendChild(li);
          }
          $('languageStatus').focus();
          return;
        }
        paint(body);
        BuildReporting.renderOutcome($('languageStatus'), 'language', body);
        await BuildReporting.loadStatus($('buildStatus'));
      } catch (error) {
        status(BuildReporting.text('unknown'));
      } finally {
        busy = false;
        $('languageFields').disabled = false;
        $('languageReload').disabled = false;
      }
    });
    return load();
  }
  return { init };
})();
