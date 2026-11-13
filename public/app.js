const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const readStored = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
const store = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};
const scroll = $('#reader-scroll');
const mobileLayout = matchMedia('(max-width:820px)');
const savedPositions = readStored('reader-positions', {});
const positions = savedPositions && typeof savedPositions === 'object' && !Array.isArray(savedPositions) ? savedPositions : {};
const collapsedFolders = new Set();
let notes = [], current = '', displayedPath = '', loading = false;
let noteSequence = 0, searchSequence = 0, refreshSequence = 0;
let noteController, searchController, refreshController, searchTimer, saveTimer, toastTimer;
let fontSize = Number(readStored('reader-font', 16)) || 16;
let width = readStored('reader-width', 'normal');
let returnFocus = null, activeModal = null;

async function api(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) {
    const error = new Error(response.status === 404
      ? '笔记不存在或无法访问，可能已被移动或删除。'
      : '内容读取失败，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return response.json();
}
const folderOf = (path) => path.split('/').slice(0, -1).join('/') || '笔记';
const noteURL = (note) => '?note=' + encodeURIComponent(note.path);
const noteFromURL = () => new URLSearchParams(location.search).get('note');
function setURL(path) {
  const url = new URL(location.href);
  if (path) url.searchParams.set('note', path);
  else url.searchParams.delete('note');
  url.hash = '';
  if (url.href !== location.href) history.pushState({}, '', url);
}
function announce(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2600);
}
function connectionError(message) {
  $('#connection-message').textContent = message;
  $('#connection-status').hidden = false;
}
function renderLibrary() {
  const oldScroll = $('#library').scrollTop;
  const groups = [...new Set(notes.map((note) => note.folder))];
  $('.note-count').textContent = `${notes.length} 篇`;
  $('#vault-summary').textContent = `仅供阅读 · ${notes.length} 篇笔记`;
  $('#library').innerHTML = groups.length ? groups.map((folder, index) => {
    const children = notes.filter((note) => note.folder === folder);
    const expanded = !collapsedFolders.has(folder);
    return `<section class="folder" data-od-id="folder-${index}"><button class="folder-toggle" data-folder="${esc(folder)}" aria-expanded="${expanded}" aria-controls="folder-${index}" data-od-id="folder-toggle-${index}">${icon('folder')}<span>${esc(folder)}</span><span class="count">${children.length}</span><svg class="chevron"><use href="#i-chevron"/></svg></button><div id="folder-${index}" ${expanded ? '' : 'hidden'}>${children.map((note) => `<a class="note-link${note.path === current ? ' active' : ''}" href="${noteURL(note)}" data-path="${esc(note.path)}" data-od-id="note-link-${note.id}" ${note.path === current ? 'aria-current="page"' : ''}>${icon('note')}<span>${esc(note.title)}</span></a>`).join('')}</div></section>`;
  }).join('') : '<p class="library-empty">还没有笔记。<br>在演示知识库中添加 Markdown 文件后，点击刷新。</p>';
  $('#library').scrollTop = oldScroll;
}
function savePosition() {
  if (!displayedPath || loading) return;
  positions[displayedPath] = scroll.scrollTop;
  store('reader-positions', positions);
}
function resetArticle(title, message, action = '') {
  displayedPath = '';
  $('#article').setAttribute('aria-busy', 'false');
  $('#note-title').textContent = title;
  $('#article').replaceChildren();
  const state = document.createElement('div');
  state.className = 'state-message';
  const text = document.createElement('p');
  text.textContent = message;
  state.append(text);
  if (action) {
    const button = document.createElement('button');
    button.textContent = '重新读取';
    button.dataset.action = action;
    button.dataset.odId = 'retry-note';
    state.append(button);
  }
  $('#article').append(state);
  $('#toc').replaceChildren();
  $('#pagination').replaceChildren();
  $('#word-count').textContent = '';
  $('#read-time').textContent = '';
  $('#progress-text').textContent = '—';
  $('#progress-fill').style.width = '0%';
  scroll.scrollTop = 0;
}
function decorateArticle() {
  // All HTML comes from the existing server-side Markdown and sanitization pipeline.
  const title = $('#article').querySelector('h1');
  if (title) title.remove();
  for (const table of $$('#article table')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  for (const item of $$('#article li')) {
    const container = item.firstElementChild?.tagName === 'P' ? item.firstElementChild : item;
    const text = container.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE || !/^\s*[☐☑]/.test(text.textContent)) continue;
    const checked = /^\s*☑/.test(text.textContent);
    text.textContent = text.textContent.replace(/^\s*[☐☑]\s*/, '');
    const box = document.createElement('span');
    box.className = 'task-box' + (checked ? ' checked' : '');
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', checked ? '已完成' : '未完成');
    if (checked) box.innerHTML = icon('check');
    const label = document.createElement('span');
    while (container.firstChild) label.append(container.firstChild);
    container.append(box, label);
    item.parentElement.classList.add('task-list');
  }
  for (const image of $$('#article img')) {
    image.addEventListener('load', updateProgress, { once: true });
    image.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'image-unavailable';
      fallback.textContent = '图片缺失或不可访问';
      image.replaceWith(fallback);
      updateProgress();
    }, { once: true });
  }
  const count = $('#article').textContent.replace(/\s/g, '').length;
  $('#word-count').textContent = `${count} 字`;
  $('#read-time').textContent = `约 ${Math.max(1, Math.ceil(count / 350))} 分钟`;
  const headings = $$('#article h2,#article h3');
  headings.forEach((heading, index) => {
    heading.id = 'section-' + index;
    heading.dataset.odId = 'article-section-' + index;
  });
  $('#toc').innerHTML = headings.map((heading, index) => `<a href="#${heading.id}" data-section="${heading.id}" data-od-id="outline-link-${index}" class="${heading.tagName === 'H3' ? 'sub' : ''}">${esc(heading.textContent)}</a>`).join('');
}
function renderPagination() {
  const index = notes.findIndex((note) => note.path === current);
  if (index < 0 || notes.length < 2) { $('#pagination').replaceChildren(); return; }
  const previous = notes[(index - 1 + notes.length) % notes.length];
  const next = notes[(index + 1) % notes.length];
  $('#pagination').innerHTML = `<a class="page-link" href="${noteURL(previous)}" data-path="${esc(previous.path)}" data-od-id="previous-note">${icon('arrow-left')}<div><small>上一篇</small><span>${esc(previous.title)}</span></div></a><a class="page-link next" href="${noteURL(next)}" data-path="${esc(next.path)}" data-od-id="next-note"><div><small>下一篇</small><span>${esc(next.title)}</span></div>${icon('arrow-right')}</a>`;
}
async function loadNote(path, { restore = false, changeURL = true, focus = false, keepDrawer = false } = {}) {
  if (!path) return;
  savePosition();
  const sequence = ++noteSequence;
  noteController?.abort();
  noteController = new AbortController();
  current = path;
  loading = true;
  if (changeURL) setURL(path);
  $('#category').textContent = folderOf(path);
  $('#crumb-folder').textContent = folderOf(path);
  $('#crumb-note').textContent = notes.find((note) => note.path === path)?.title || path.split('/').at(-1).replace(/\.md$/, '');
  resetArticle('正在打开笔记…', '正在读取正文，请稍候。');
  $('#article').setAttribute('aria-busy', 'true');
  renderLibrary();
  if (!keepDrawer) closeDrawer();
  hideSettings();
  try {
    const data = await api('/api/note?path=' + encodeURIComponent(path), noteController.signal);
    if (sequence !== noteSequence) return;
    $('#note-title').textContent = data.title;
    $('#crumb-note').textContent = data.title;
    $('#article').innerHTML = data.html;
    $('#connection-status').hidden = true;
    document.title = data.title + ' · 笔记随行';
    decorateArticle();
    renderPagination();
    displayedPath = path;
    store('reader-last-note', path);
    loading = false;
    scroll.scrollTop = restore ? Number(positions[path] || 0) : 0;
    updateProgress();
    if (focus) scroll.focus({ preventScroll: true });
  } catch (error) {
    if (sequence !== noteSequence || error.name === 'AbortError') return;
    resetArticle('暂时无法打开这篇笔记', error.status ? error.message : '无法连接读取器，请确认电脑与服务仍在运行。', 'retry-note');
    if (!error.status) connectionError('与读取器的连接已中断，请确认电脑和服务仍在运行。');
    document.title = '读取失败 · 笔记随行';
  } finally {
    if (sequence === noteSequence) {
      loading = false;
      $('#article').setAttribute('aria-busy', 'false');
    }
  }
}
function updateProgress() {
  if (!displayedPath) return;
  const maximum = scroll.scrollHeight - scroll.clientHeight;
  const percent = maximum > 0 ? Math.max(0, Math.min(100, Math.round(scroll.scrollTop / maximum * 100))) : 100;
  $('#progress-text').textContent = percent + '%';
  $('#progress-fill').style.width = percent + '%';
  const headings = $$('#article h2,#article h3');
  let active = headings[0]?.id;
  const top = scroll.getBoundingClientRect().top;
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top - top < 115) active = heading.id;
  }
  for (const link of $$('#toc a')) {
    link.classList.toggle('active', link.dataset.section === active);
    if (link.dataset.section === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
async function refresh({ initial = false } = {}) {
  const sequence = ++refreshSequence;
  const navigationAtStart = noteSequence;
  refreshController?.abort();
  refreshController = new AbortController();
  const buttons = $$('.refresh-button');
  buttons.forEach((button) => {
    button.classList.add('busy');
    button.disabled = true;
  });
  try {
    const [vault, library] = await Promise.all([
      api('/api/vault', refreshController.signal),
      api('/api/library', refreshController.signal),
    ]);
    if (sequence !== refreshSequence) return;
    notes = library.map((note, index) => ({ ...note, folder: folderOf(note.path), id: index }));
    $('#vault-path').textContent = vault.location;
    $('#connection-status').hidden = true;
    renderLibrary();
    if (!notes.length) {
      ++noteSequence;
      noteController?.abort();
      savePosition();
      current = '';
      loading = false;
      setURL('');
      $('#category').textContent = '演示知识库';
      $('#crumb-folder').textContent = '笔记';
      $('#crumb-note').textContent = '空知识库';
      resetArticle('知识库里还没有笔记', '添加 Markdown 文件后，点击“刷新”，即可在这里阅读。');
      renderLibrary();
    } else if (navigationAtStart === noteSequence) {
      const requested = initial ? noteFromURL() : current;
      const saved = readStored('reader-last-note', '');
      const target = requested || notes.find((note) => note.path === saved)?.path || notes.find((note) => note.title === '本地服务是什么')?.path || notes[0].path;
      await loadNote(target, { restore: true, changeURL: !initial || !requested, keepDrawer: true });
    }
    if (activeModal?.id === 'search-overlay') searchNotes();
    if (!initial) announce(`已重新扫描知识库 · ${notes.length} 篇笔记`);
  } catch (error) {
    if (sequence !== refreshSequence || error.name === 'AbortError') return;
    connectionError('无法连接读取器，请确认电脑和服务仍在运行。');
    if (document.body.classList.contains('drawer')) announce('刷新失败，请确认电脑和服务仍在运行。');
    if (!displayedPath && !loading) resetArticle('暂时无法连接知识库', '确认服务运行后，点击“重新连接”再试。');
  } finally {
    if (sequence === refreshSequence) {
      buttons.forEach((button) => {
        button.classList.remove('busy');
        button.disabled = false;
      });
    }
  }
}
function syncDrawerAccessibility() {
  const opened = mobileLayout.matches && document.body.classList.contains('drawer');
  $('#sidebar').inert = mobileLayout.matches && !opened;
  $('.workspace').inert = opened;
  $('.mobile-dock').inert = opened;
}
function closeDrawer() {
  document.body.classList.remove('drawer');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
  syncDrawerAccessibility();
}
function toggleDrawer() {
  if (document.body.classList.contains('drawer')) return closeDrawer();
  document.body.classList.add('drawer');
  $('#mobile-menu').setAttribute('aria-expanded', 'true');
  syncDrawerAccessibility();
  $('#close-drawer').focus();
}
function hideSettings() {
  $('#settings').hidden = true;
  $('#settings-top').setAttribute('aria-expanded', 'false');
  $('#mobile-settings').setAttribute('aria-expanded', 'false');
}
function toggleSettings() {
  const open = $('#settings').hidden;
  $('#settings').hidden = !open;
  $('#settings-top').setAttribute('aria-expanded', String(open));
  $('#mobile-settings').setAttribute('aria-expanded', String(open));
}
function toggleFocus() {
  const on = document.body.classList.toggle('focused');
  $('#focus-button').setAttribute('aria-pressed', String(on));
  $('#focus-button').setAttribute('aria-label', on ? '退出专注阅读' : '进入专注阅读');
  $('#focus-button').title = on ? '退出专注阅读' : '专注阅读';
  hideSettings();
  requestAnimationFrame(updateProgress);
  announce(on ? '已进入专注阅读 · 按 Esc 退出' : '已退出专注阅读');
}
function showModal(id) {
  returnFocus = document.activeElement;
  activeModal = $(id);
  activeModal.hidden = false;
  $('.app').inert = true;
  $('.mobile-dock').inert = true;
  hideSettings();
}
function closeModal() {
  if (!activeModal) return;
  if (activeModal.id === 'search-overlay') {
    ++searchSequence;
    clearTimeout(searchTimer);
    searchController?.abort();
  }
  activeModal.hidden = true;
  activeModal = null;
  $('.app').inert = false;
  syncDrawerAccessibility();
  returnFocus?.focus();
}
function highlight(text, query) {
  if (!query) return esc(text);
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return esc(text);
  return esc(text.slice(0, index)) + '<mark>' + esc(text.slice(index, index + query.length)) + '</mark>' + esc(text.slice(index + query.length));
}
async function searchNotes() {
  const query = $('#search-input').value.trim().slice(0, 200);
  const sequence = ++searchSequence;
  searchController?.abort();
  searchController = new AbortController();
  $('#search-summary').textContent = query ? '正在搜索标题与正文…' : '全部笔记 · 输入关键词搜索标题与正文';
  $('#search-results').replaceChildren();
  try {
    const results = query ? await api('/api/search?q=' + encodeURIComponent(query), searchController.signal) : notes;
    if (sequence !== searchSequence) return;
    $('#search-summary').textContent = query ? `找到 ${results.length} 篇相关笔记` : `全部 ${results.length} 篇笔记 · 搜索标题与正文`;
    $('#search-results').innerHTML = results.length ? results.map((note, index) => `<a href="${noteURL(note)}" class="search-result" data-path="${esc(note.path)}" data-od-id="search-result-${index}"><div class="result-title"><span>${highlight(note.title, query)}</span><small>${esc(folderOf(note.path))}</small></div>${note.excerpt ? `<p>${highlight(note.excerpt.replace(/\s+/g, ' ').slice(0, 130), query)}</p>` : ''}</a>`).join('') : `<div class="search-empty">${query ? '没有找到相关笔记<br><small>试试更短的关键词，或刷新知识库</small>' : '知识库里还没有笔记'}</div>`;
  } catch (error) {
    if (sequence !== searchSequence || error.name === 'AbortError') return;
    $('#search-summary').textContent = '搜索暂时不可用';
    $('#search-results').innerHTML = '<div class="search-empty">无法连接读取器，请确认服务仍在运行。<br><button class="settings-reset" data-action="retry-search">重试搜索</button></div>';
  }
}
function showSearch() {
  showModal('#search-overlay');
  $('#search-input').value = '';
  searchNotes();
  $('#search-input').focus();
}
function applySettings() {
  fontSize = Math.max(14, Math.min(22, fontSize));
  width = width === 'wide' ? 'wide' : 'normal';
  document.documentElement.style.setProperty('--article-size', fontSize + 'px');
  document.documentElement.style.setProperty('--article-width', width === 'wide' ? '800px' : '680px');
  $('#font-value').textContent = fontSize;
  $('#font-minus').disabled = fontSize <= 14;
  $('#font-plus').disabled = fontSize >= 22;
  $('#width-normal').setAttribute('aria-pressed', String(width === 'normal'));
  $('#width-wide').setAttribute('aria-pressed', String(width === 'wide'));
  store('reader-font', fontSize);
  store('reader-width', width);
  requestAnimationFrame(updateProgress);
}
$('#mobile-menu').onclick = toggleDrawer;
$('#close-drawer').onclick = () => { closeDrawer(); $('#mobile-menu').focus(); };
$('#scrim').onclick = closeDrawer;
$('#focus-button').onclick = toggleFocus;
$('#settings-top').onclick = toggleSettings;
$('#mobile-settings').onclick = toggleSettings;
$('#font-minus').onclick = () => { fontSize--; applySettings(); };
$('#font-plus').onclick = () => { fontSize++; applySettings(); };
$('#width-normal').onclick = () => { width = 'normal'; applySettings(); };
$('#width-wide').onclick = () => { width = 'wide'; applySettings(); };
$('#settings-reset').onclick = () => { fontSize = 16; width = 'normal'; applySettings(); announce('已恢复默认阅读设置'); };
$('#search-launch').onclick = showSearch;
$('#mobile-search').onclick = showSearch;
$('#search-close').onclick = closeModal;
$('#search-input').oninput = () => {
  ++searchSequence;
  searchController?.abort();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchNotes, 180);
};
$('#source-button').onclick = () => { showModal('#source-overlay'); $('#source-close').focus(); };
$('#source-close').onclick = closeModal;
$('#refresh-button').onclick = () => refresh();
$$('.overlay').forEach((overlay) => { overlay.onclick = (event) => { if (event.target === overlay) closeModal(); }; });
scroll.addEventListener('scroll', () => { updateProgress(); clearTimeout(saveTimer); saveTimer = setTimeout(savePosition, 180); }, { passive: true });
window.addEventListener('resize', updateProgress);
window.addEventListener('pagehide', savePosition);
mobileLayout.addEventListener('change', () => { closeDrawer(); updateProgress(); });
document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'refresh') { refresh(); return; }
  if (action === 'retry-note') { loadNote(current, { restore: true }); return; }
  if (action === 'retry-search') { searchNotes(); return; }
  const folder = event.target.closest('.folder-toggle');
  if (folder) {
    const expanded = folder.getAttribute('aria-expanded') === 'true';
    folder.setAttribute('aria-expanded', String(!expanded));
    document.getElementById(folder.getAttribute('aria-controls')).hidden = expanded;
    if (expanded) collapsedFolders.add(folder.dataset.folder);
    else collapsedFolders.delete(folder.dataset.folder);
    return;
  }
  const jump = event.target.closest('[data-section]');
  if (jump) {
    event.preventDefault();
    const heading = document.getElementById(jump.dataset.section);
    if (heading) scroll.scrollTo({ top: heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 28, behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'instant' : 'smooth' });
    return;
  }
  const anchor = event.target.closest('a');
  if (anchor && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && (!('button' in event) || event.button === 0)) {
    const url = new URL(anchor.href, location.href);
    if (url.origin === location.origin && url.searchParams.has('note')) {
      event.preventDefault();
      if (activeModal) closeModal();
      loadNote(url.searchParams.get('note'), { focus: true });
      return;
    }
    if (anchor.getAttribute('href') === '#') {
      event.preventDefault();
      announce(anchor.title || '无法打开此链接');
      return;
    }
  }
  if (!event.target.closest('#settings,#settings-top,#mobile-settings')) hideSettings();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (activeModal) closeModal();
    showSearch();
    return;
  }
  if (event.key === 'Escape') {
    if (activeModal) { closeModal(); return; }
    if (!$('#settings').hidden) { hideSettings(); return; }
    if (document.body.classList.contains('drawer')) { closeDrawer(); $('#mobile-menu').focus(); return; }
    if (document.body.classList.contains('focused')) toggleFocus();
    return;
  }
  const trap = activeModal || (mobileLayout.matches && document.body.classList.contains('drawer') ? $('#sidebar') : null);
  if (trap && event.key === 'Tab') {
    const items = [...trap.querySelectorAll('input,button,a[href]')].filter((element) => !element.disabled && !element.closest('[hidden]'));
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if (activeModal?.id === 'search-overlay') {
    const results = $$('#search-results a'), index = results.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); results[Math.min(index + 1, results.length - 1)].focus(); }
    if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); if (index > 0) results[index - 1].focus(); else $('#search-input').focus(); }
    if (event.key === 'Enter' && document.activeElement === $('#search-input') && results.length) { event.preventDefault(); results[0].click(); }
  }
});
window.addEventListener('popstate', () => {
  const path = noteFromURL();
  if (path) loadNote(path, { restore: true, changeURL: false });
  else if (notes.length) loadNote(notes[0].path, { restore: true, changeURL: false });
});
applySettings();
syncDrawerAccessibility();
refresh({ initial: true });
