// Isolated visual study. All publishing states and dates are illustrative;
// this page never calls the CMS, saves content, or changes a live post.
const concepts = {
  library: ['Reference library', 'Closest to CompendiQ: quiet navigation, one rounded workspace, generous list rows.', 'Library'],
  desk: ['Editorial desk', 'A denser working table. Status and translation coverage are explicit columns.', 'Desk'],
  gallery: ['Photo library', 'Recognize a journey by its photograph. A contact sheet with calm metadata below.', 'Photos'],
  split: ['Split workspace', 'Keep your place in the list while inspecting a story and its two languages.', 'Split'],
};
const requestedView = new URLSearchParams(location.search).get('view');
const view = Object.hasOwn(concepts, requestedView) ? requestedView : 'library';
document.body.dataset.view = view;
document.title = `${concepts[view][0]} · Wanderlust Studio`;
document.querySelector('#concept-title').textContent = `${Object.keys(concepts).indexOf(view) + 1}. ${concepts[view][0]}`;
document.querySelector('#concept-description').textContent = concepts[view][1];
document.querySelectorAll('[data-concept]').forEach(link => {
  link.dataset.short = concepts[link.dataset.concept][2];
  if (link.dataset.concept === view) link.setAttribute('aria-current', 'page');
});
const paths = {
  book: '<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3zM21 4h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="var(--canvas)"/><circle cx="16" cy="12" r="2" fill="var(--canvas)"/><circle cx="8" cy="18" r="2" fill="var(--canvas)"/>',
  home: '<path d="m3 10 9-7 9 7v10H3zM9 20v-7h6v7"/>',
  file: '<path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6"/>',
  chat: '<path d="M4 4h16v13H9l-5 4zM8 9h8M8 13h5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}
document.querySelectorAll('[data-icon]').forEach(element => element.insertAdjacentHTML('afterbegin', icon(element.dataset.icon)));
const posts = [
  { id: 'galapagos', title: 'Galápagos – Inselabenteuer', en: 'Galápagos Islands Adventure', country: 'Ecuador', date: '17 Oct 2026', status: 'changes', missing: false, photo: 'galapagos', trip: 'October 2023', excerptDe: 'Zwischen schwarzem Lavagestein und türkisblauem Wasser: unterwegs auf den Galápagos-Inseln, von San Cristóbal bis Isabela.', excerptEn: 'Between black lava and turquoise water: exploring the Galápagos Islands, from San Cristóbal to Isabela.' },
  { id: 'amazon', title: 'Jungleabenteuer im Amazonas', en: 'Jungle Adventure in the Amazon', country: 'Ecuador', date: '16 Oct 2026', status: 'draft', missing: false, photo: 'amazon', trip: 'October 2023', excerptDe: 'Mit dem Kanu durch den Cuyabeno. Ein Reisetagebuch zwischen Wasserwegen, dichtem Regenwald und den Geräuschen des Amazonas.', excerptEn: 'By canoe through Cuyabeno. A travel journal of winding waterways, dense rainforest and the sounds of the Amazon.' },
  { id: 'bucharest', title: 'Reisebericht: 4 Tage Bukarest', en: 'Travel Report: 4 Days in Bucharest', country: 'Romania', date: '15 Oct 2026', status: 'published', missing: false, photo: 'bucharest', trip: 'October 2024', excerptDe: 'Vier Tage zu Fuß durch Bukarest: große Boulevards, ruhige Innenhöfe und die kleinen Entdeckungen zwischen den Sehenswürdigkeiten.', excerptEn: 'Four days walking through Bucharest: broad boulevards, quiet courtyards and small discoveries between the landmarks.' },
  { id: 'budapest', title: 'Ungarn: Sehenswürdigkeiten in Budapest', en: 'Hungary: Sightseeing in Budapest', country: 'Hungary', date: '14 Oct 2026', status: 'published', missing: false, photo: 'budapest', trip: 'September 2024', excerptDe: 'An beiden Ufern der Donau: Streifzüge durch Budapest, von der Altstadt bis zu den Brücken zwischen Buda und Pest.', excerptEn: 'On both banks of the Danube: exploring Budapest, from the old town to the bridges between Buda and Pest.' },
  { id: 'copenhagen', title: 'Kulturelle Erfahrung in Kopenhagen', en: 'Cultural Experience in Copenhagen', country: 'Denmark', date: '12 Oct 2026', status: 'draft', missing: true, photo: 'copenhagen', trip: 'May 2022', excerptDe: 'Ein Wochenende zwischen Hafen, Architektur und Alltagsleben. Kopenhagen entdecken, ohne die Stadt nur von Sehenswürdigkeit zu Sehenswürdigkeit zu durchqueren.', excerptEn: '' },
  { id: 'houseboat', title: 'Hausboot-Abenteuer', en: 'Houseboat Adventure', country: 'Netherlands', date: '10 Oct 2026', status: 'published', missing: false, photo: 'houseboat', trip: 'July 2022', excerptDe: 'Unterwegs auf dem Wasser. Ein Hausboot, kleine Häfen und ein paar Tage in einem anderen Tempo.', excerptEn: 'Travelling on the water. A houseboat, small harbours and a few days at a different pace.' },
  { id: 'central', title: 'Naturreise durch Mittelamerika', en: 'Nature Trip through Central America', country: 'Central America', date: '08 Oct 2026', status: 'changes', missing: false, photo: 'central', trip: 'September 2022', excerptDe: 'Notizen einer Reise durch Mittelamerika: Wälder, Küsten und Begegnungen entlang des Weges.', excerptEn: 'Notes from a journey through Central America: forests, coastlines and encounters along the way.' },
  { id: 'rhodes', title: 'Sonne und Abenteuer: Rhodos', en: 'Sun and Adventure: Rhodes', country: 'Greece', date: '06 Oct 2026', status: 'published', missing: false, photo: 'rhodes', trip: 'July 2021', excerptDe: 'Rhodos zwischen Altstadt und Küste. Sommertage, Spaziergänge und Abstecher ans Meer.', excerptEn: 'Rhodes between the old town and the coast. Summer days, walks and detours to the sea.' },
  { id: 'yucatan', title: 'Yucatán – Tauchen und Abenteuer', en: 'Yucatán – Diving and Adventure', country: 'Mexico', date: '04 Oct 2026', status: 'draft', missing: false, photo: 'yucatan', trip: 'February 2021', excerptDe: 'Über und unter Wasser auf Yucatán: unterwegs zwischen Küste, Cenoten und den Orten dazwischen.', excerptEn: 'Above and below the water in Yucatán: travelling between the coast, cenotes and the places in between.' },
];
const statusLabels = { published: 'Published', draft: 'Draft', changes: 'Unpublished changes' };
const selection = new Set();
let inspected = posts[0];
let locale = 'de';
const $ = selector => document.querySelector(selector);
// Only authored fixture strings enter these templates, never CMS or user HTML.
function badge(post) { return `<span class="status ${post.status}">${statusLabels[post.status]}</span>`; }
function visiblePosts() {
  const query = $('#search').value.trim().toLocaleLowerCase();
  const status = $('#status').value;
  const result = posts.filter(post => `${post.title} ${post.en} ${post.country}`.toLocaleLowerCase().includes(query) && (status === 'all' || (status === 'missing' ? post.missing : status === 'published' ? post.status !== 'draft' : post.status === status)));
  const sort = $('#sort').value;
  if (sort !== 'updated') result.sort((a, b) => a[sort].localeCompare(b[sort]));
  return result;
}
function renderSelection() {
  const visible = visiblePosts();
  $('#selected-count').textContent = `${selection.size} post${selection.size === 1 ? '' : 's'} selected`;
  $('.selection-bar').hidden = selection.size === 0;
  $('#select-all').checked = visible.length > 0 && visible.every(post => selection.has(post.id));
  $('#select-all').indeterminate = visible.some(post => selection.has(post.id)) && !$('#select-all').checked;
}
function render() {
  const visible = visiblePosts();
  $('#result-count').textContent = `${visible.length} post${visible.length === 1 ? '' : 's'}`;
  $('.list-hint').textContent = { updated: 'Updated most recently', title: 'Title A–Z', country: 'Country A–Z' }[$('#sort').value];
  $('#posts').innerHTML = visible.length ? visible.map(post => `<article class="post-row${inspected.id === post.id ? ' selected' : ''}" data-id="${post.id}">
    <label class="post-select"><input type="checkbox" data-select="${post.id}" aria-label="Select ${post.title}" ${selection.has(post.id) ? 'checked' : ''}></label>
    <img class="thumb" src="assets/${post.photo}.webp" alt="" width="640" height="427">
    <div class="post-info"><button class="post-title" data-inspect="${post.id}">${post.title}</button><div class="post-subtitle"><span>${post.country}</span><span class="inline-date">${post.date}</span>${post.missing ? '<span>EN missing</span>' : ''}</div></div>
    ${badge(post)}<div class="languages" aria-label="${post.missing ? 'German available; English missing' : 'German and English available'}"><span>DE</span><span class="${post.missing ? 'missing' : ''}">EN</span></div><span class="updated-cell">${post.date.replace(' 2026', '')}</span><button class="row-arrow" data-inspect="${post.id}" aria-label="Inspect ${post.title}">${icon('arrow')}</button>
  </article>`).join('') : '<div class="empty"><h2>No matching posts</h2><p>Try another title or country, or clear your filters.</p><button class="secondary" id="reset-filters">Clear filters</button></div>';
  document.querySelectorAll('[data-status]').forEach(button => {
    const active = button.dataset.status === $('#status').value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderSelection();
}
function renderInspector() {
  const post = inspected;
  $('#inspector').innerHTML = `<div class="inspector-top"><span>Story details</span>${badge(post)}</div><img class="inspect-image" src="assets/${post.photo}.webp" alt="Cover photograph for ${post.title}"><h2>${locale === 'de' ? post.title : post.en}</h2><p class="inspect-meta">${post.country} · ${post.trip}</p><div class="locale-tabs" aria-label="Preview language"><button data-locale="de" class="${locale === 'de' ? 'active' : ''}" aria-pressed="${locale === 'de'}">Deutsch</button><button data-locale="en" class="${locale === 'en' ? 'active' : ''}" aria-pressed="${locale === 'en'}">English${post.missing ? ' · Missing' : ''}</button></div><p class="excerpt">${locale === 'de' ? post.excerptDe : post.excerptEn || 'No English draft yet. The German story is kept in the same post pair.'}</p><dl class="detail-list"><dt>Publication</dt><dd>${post.status === 'draft' ? 'Not published' : 'Live on the blog'}</dd><dt>Languages</dt><dd>${post.missing ? 'DE only · EN missing' : 'DE + EN'}</dd><dt>Last modified</dt><dd>${post.date}</dd></dl><div class="inspect-actions"><button class="primary" data-demo="edit">Open editor ${icon('arrow')}</button><button class="secondary" data-preview="${post.id}">Preview</button></div><p class="inspect-note">${post.status === 'changes' ? 'Draft changes are separate from the published story.' : 'German and English are managed as one post pair.'}</p>`;
}
function showDialog(title, content) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = content;
  $('#preview').showModal();
}
function previewPost(post) {
  showDialog(post.title, `<img class="dialog-photo" src="assets/${post.photo}.webp" alt="Cover photograph for ${post.title}"><p>${post.excerptDe}</p><p>${post.excerptEn || 'English draft not yet written.'}</p><div class="dialog-status">Illustrative copy · Visual preview only · No live content loaded</div>`);
}
$('#search').addEventListener('input', render);
$('#status').addEventListener('change', render);
$('#sort').addEventListener('change', render);
$('#select-all').addEventListener('change', event => {
  for (const post of visiblePosts()) event.target.checked ? selection.add(post.id) : selection.delete(post.id);
  render();
});
$('#clear-selection').addEventListener('click', () => { selection.clear(); render(); });
$('#close-dialog').addEventListener('click', () => $('#preview').close());
document.addEventListener('change', event => {
  if (!event.target.matches('[data-select]')) return;
  event.target.checked ? selection.add(event.target.dataset.select) : selection.delete(event.target.dataset.select);
  renderSelection();
});
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.status) { $('#status').value = button.dataset.status; render(); }
  if (button.dataset.inspect) {
    inspected = posts.find(post => post.id === button.dataset.inspect);
    locale = 'de';
    if (view === 'split') {
      renderInspector();
      document.querySelectorAll('.post-row').forEach(row => row.classList.toggle('selected', row.dataset.id === inspected.id));
      if (matchMedia('(max-width:620px)').matches) $('#inspector').scrollIntoView({ block: 'start' });
    } else previewPost(inspected);
  }
  if (button.dataset.preview) previewPost(posts.find(post => post.id === button.dataset.preview));
  if (button.dataset.locale) {
    locale = button.dataset.locale;
    renderInspector();
    $(`[data-locale="${locale}"]`).focus();
  }
  if (button.id === 'reset-filters') { $('#search').value = ''; $('#status').value = 'all'; render(); $('#search').focus(); }
  if (button.dataset.demo) {
    const copy = {
      new: ['New post', 'This study shows where post creation belongs. The existing bilingual editor is not changed or connected here.'],
      export: ['Export all posts', 'In the live CMS this action writes MDX backups to the server. This visual study does not export files or contact the server.'],
      edit: ['Open story editor', 'This is the proposed entry point to the existing DE/EN editor. No production routes or editing behavior have changed.'],
      bulk: ['Selected posts', [...selection].map(id => posts.find(post => post.id === id).title).join(' · ')],
    };
    const [title, text] = copy[button.dataset.demo];
    showDialog(title, '');
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    $('#dialog-body').append(paragraph);
  }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !$('#preview').open && !event.target.matches('input,textarea,select')) {
    event.preventDefault(); $('#search').focus();
  }
});
render();
renderInspector();
