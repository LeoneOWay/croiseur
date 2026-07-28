/* app.js — interface du croiseur OW (vanilla JS, aucune dépendance réseau).
 * Toutes les données restent dans le navigateur (calcul local, cache IndexedDB). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  let pack = null;          // { header, weights, bits, nums }
  let packBytes = null;     // ArrayBuffer compressé (pour le cache)
  let packName = '';
  let lastResult = null;    // accumulateurs (compute)
  let lastRender = null;    // modèle d'affichage (render)
  let excelJsReady = null;  // promesse de chargement paresseux d'ExcelJS

  const state = {
    rows: [], cols: [], filters: [], months: null,
    opts: { weighted: true, display: 'pcol', sig: 'total', levels: [95, 99], mask: 60, showWBase: false, showEffBase: false },
  };

  // ------------------------------------------------------------ utilitaires
  const MONTHS_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const monthLabel = ym => { const [y, m] = ym.split('-'); return MONTHS_FR[+m - 1] + ' ' + y; };
  const fmtInt = x => Math.round(x).toLocaleString('fr-FR');
  const V = id => TabEngine.varById(pack.header, id);
  const varTitle = v => (v.code && v.code !== v.label ? v.code + ' — ' : '') + v.label;

  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), 2600); }

  // ------------------------------------------------------------ cache IndexedDB
  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('ow-croiseur', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('packs');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  }
  async function cacheSave(name, bytes) {
    try {
      const db = await idb();
      await new Promise((res, rej) => { const tx = db.transaction('packs', 'readwrite'); tx.objectStore('packs').put({ name, bytes, savedAt: Date.now() }, 'last'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { /* cache facultatif */ }
  }
  async function cacheLoad() {
    try {
      const db = await idb();
      return await new Promise((res, rej) => { const rq = db.transaction('packs').objectStore('packs').get('last'); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => rej(rq.error); });
    } catch (e) { return null; }
  }
  async function cacheClear() {
    try { const db = await idb(); await new Promise(res => { const tx = db.transaction('packs', 'readwrite'); tx.objectStore('packs').delete('last'); tx.oncomplete = res; }); } catch (e) { }
  }

  // ------------------------------------------------------------ chargement de base
  async function loadPackFromBytes(bytes, name, fromCache) {
    const t0 = performance.now();
    pack = await OWX.load(bytes);
    packBytes = bytes; packName = name || 'base.owx';
    const h = pack.header;
    $('packTitle').textContent = h.title || packName;
    $('packSub').textContent = (h.subtitle || '') + (h.createdAt ? ' — pack généré le ' + new Date(h.createdAt).toLocaleDateString('fr-FR') : '');
    document.title = 'Croiseur OW — ' + (h.title || packName);
    if (h.defaults) { if (h.defaults.maskThreshold != null) state.opts.mask = h.defaults.maskThreshold; if (h.defaults.levels) state.opts.levels = h.defaults.levels.slice(); }
    $('inpMask').value = state.opts.mask;
    state.rows = []; state.cols = []; state.filters = []; state.months = null;
    const preset = (h.presets || [])[0];
    if (preset) state.months = preset.months.slice();
    // état par défaut : premier bloc question en ligne
    const q = h.vars.find(v => v.kind === 'question');
    if (q) state.rows = [q.id];
    applyHashState();
    buildPeriodSelect(); buildTree(); syncOptionButtons();
    $('dropzone').hidden = true; $('config').hidden = false; $('options').hidden = false; $('status').hidden = false; $('tablewrap').hidden = false;
    $('sidebar').classList.remove('hidden');
    for (const b of ['btnExportXlsx', 'btnExportCsv', 'btnCopy', 'btnShare']) $(b).disabled = false;
    if (!fromCache) { cacheSave(packName, packBytes); $('cacheBanner').hidden = true; }
    toast('Base chargée : ' + fmtInt(h.n) + ' répondants (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s)');
    recompute();
  }

  async function loadFile(file) {
    try {
      const buf = await file.arrayBuffer();
      await loadPackFromBytes(buf, file.name, false);
    } catch (e) { console.error(e); alert('Impossible de lire ce fichier : ' + e.message); }
  }

  async function tryCache() {
    const c = await cacheLoad();
    if (!c) return false;
    try {
      await loadPackFromBytes(c.bytes, c.name, true);
      $('cacheMsg').textContent = 'Base « ' + (pack.header.title || c.name) + ' » restaurée depuis le cache local du navigateur (enregistrée le ' + new Date(c.savedAt).toLocaleDateString('fr-FR') + ').';
      $('cacheBanner').hidden = false;
      return true;
    } catch (e) { console.error(e); await cacheClear(); return false; }
  }

  // ------------------------------------------------------------ lien de partage (hash)
  function hashState() {
    const o = state.opts;
    const j = { r: state.rows, c: state.cols, f: state.filters.map(f => ({ v: f.varId, m: f.mods })), mo: state.months, o: { w: o.weighted ? 1 : 0, d: o.display, s: o.sig, l: o.levels, k: o.mask, wb: o.showWBase ? 1 : 0, eb: o.showEffBase ? 1 : 0 } };
    return '#s=' + btoa(unescape(encodeURIComponent(JSON.stringify(j))));
  }
  function applyHashState() {
    const m = location.hash.match(/^#s=(.+)$/);
    if (!m) return;
    try {
      const j = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      const ok = id => !!V(id);
      state.rows = (j.r || []).filter(ok);
      state.cols = (j.c || []).filter(ok);
      state.filters = (j.f || []).filter(f => ok(f.v)).map(f => ({ varId: f.v, mods: f.m }));
      state.months = j.mo || null;
      if (j.o) {
        state.opts.weighted = !!j.o.w; state.opts.display = j.o.d || 'pcol'; state.opts.sig = j.o.s || 'total';
        state.opts.levels = j.o.l || [95, 99]; state.opts.mask = j.o.k != null ? j.o.k : 60;
        state.opts.showWBase = !!j.o.wb; state.opts.showEffBase = !!j.o.eb;
      }
      $('inpMask').value = state.opts.mask;
      const lv = state.opts.levels.join(',');
      if ([...$('selLevels').options].some(op => op.value === lv)) $('selLevels').value = lv;
      $('chkWBase').checked = state.opts.showWBase; $('chkEffBase').checked = state.opts.showEffBase;
    } catch (e) { console.warn('Lien invalide', e); }
  }

  // ------------------------------------------------------------ panneau variables
  function buildTree() {
    const tree = $('varTree'); tree.textContent = '';
    const h = pack.header;
    const themes = h.themes || [...new Set(h.vars.map(v => v.theme))];
    for (const th of themes) {
      const vars = h.vars.filter(v => v.theme === th);
      if (!vars.length) continue;
      const det = el('details'); if (th === themes[0]) det.open = true;
      det.appendChild(el('summary', null, th));
      for (const v of vars) {
        const item = el('div', 'varitem');
        item.dataset.search = (v.code + ' ' + v.label + ' ' + th).toLowerCase();
        const bL = el('button', 'vbtn', 'L'); bL.title = 'Ajouter / retirer des lignes';
        const bC = el('button', 'vbtn', 'C'); bC.title = 'Ajouter / retirer des colonnes';
        const bF = el('button', 'vbtn', 'F'); bF.title = 'Filtrer sur cette variable';
        bL.onclick = () => { togg(state.rows, v.id); refresh(); };
        bC.onclick = () => { togg(state.cols, v.id); refresh(); };
        bF.onclick = () => openFilterModal(v.id);
        const lab = el('span', 'vlabel', varTitle(v)); lab.title = varTitle(v) + '\n' + v.mods.length + ' modalité(s)' + (v.baseBit != null && h.counts ? ' — base ' + fmtInt(h.counts[v.baseBit]) : '');
        const nn = el('span', 'vn', v.mods.length + (v.mean ? '+x̄' : '') + (v.nps ? '+NPS' : ''));
        item.append(bL, bC, bF, lab, nn);
        item.dataset.varid = v.id;
        det.appendChild(item);
      }
      tree.appendChild(det);
    }
    markTreeButtons();
  }
  function togg(arr, id) { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); else arr.push(id); }
  function markTreeButtons() {
    document.querySelectorAll('.varitem').forEach(item => {
      const id = item.dataset.varid;
      const [bL, bC, bF] = item.querySelectorAll('.vbtn');
      bL.classList.toggle('on', state.rows.includes(id));
      bC.classList.toggle('on', state.cols.includes(id));
      bF.classList.toggle('on', state.filters.some(f => f.varId === id));
    });
  }
  $('varSearch').addEventListener('input', () => {
    const q = $('varSearch').value.trim().toLowerCase();
    document.querySelectorAll('#varTree details').forEach(det => {
      let any = false;
      det.querySelectorAll('.varitem').forEach(item => {
        const show = !q || item.dataset.search.includes(q);
        item.style.display = show ? '' : 'none'; if (show) any = true;
      });
      det.style.display = any ? '' : 'none';
      if (q && any) det.open = true;
    });
  });

  // ------------------------------------------------------------ chips
  function chip(label, title, onRemove, onClick, extras) {
    const c = el('span', 'chip');
    if (onClick) { c.classList.add('clickable'); c.onclick = e => { if (e.target.tagName !== 'BUTTON') onClick(); }; }
    const lab = el('span', 'clabel', label); lab.title = title || label; c.appendChild(lab);
    (extras || []).forEach(x => c.appendChild(x));
    const bx = el('button', null, '✕'); bx.title = 'Retirer'; bx.onclick = onRemove; c.appendChild(bx);
    return c;
  }
  function moveBtn(arr, i, d) {
    const b = el('button', null, d < 0 ? '‹' : '›'); b.title = d < 0 ? 'Avancer' : 'Reculer';
    b.onclick = () => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; refresh(); };
    return b;
  }
  function renderChips() {
    const cr = $('chipsRows'); cr.textContent = '';
    state.rows.forEach((id, i) => { const v = V(id); cr.appendChild(chip(v.code || v.label, varTitle(v), () => { state.rows.splice(i, 1); refresh(); }, null, [moveBtn(state.rows, i, -1), moveBtn(state.rows, i, +1)])); });
    if (!state.rows.length) cr.appendChild(el('span', 'clabel', 'Ajoutez des variables avec le bouton « L »'));
    const cc = $('chipsCols'); cc.textContent = '';
    state.cols.forEach((id, i) => { const v = V(id); cc.appendChild(chip(v.code || v.label, varTitle(v), () => { state.cols.splice(i, 1); refresh(); }, null, [moveBtn(state.cols, i, -1), moveBtn(state.cols, i, +1)])); });
    if (!state.cols.length) cc.appendChild(el('span', 'clabel', 'Total seul — ajoutez avec « C »'));
    const cf = $('chipsFilters'); cf.textContent = '';
    state.filters.forEach((f, i) => {
      const v = V(f.varId);
      const modsTxt = f.mods.map(mi => v.mods[mi].label).join(' OU ');
      cf.appendChild(chip((v.code || v.label) + ' : ' + (f.mods.length === 1 ? v.mods[f.mods[0]].label : f.mods.length + ' modalités'),
        (v.code || v.label) + ' = ' + modsTxt, () => { state.filters.splice(i, 1); refresh(); }, () => openFilterModal(f.varId)));
    });
    if (!state.filters.length) cf.appendChild(el('span', 'clabel', 'Aucun filtre (ensemble de la base)'));
  }

  // ------------------------------------------------------------ période
  function buildPeriodSelect() {
    const sel = $('periodSel'); sel.textContent = '';
    const h = pack.header;
    if (!h.months || !h.months.length || !h.monthsVarId || !V(h.monthsVarId)) { $('zonePeriod').style.display = 'none'; state.months = null; return; }
    $('zonePeriod').style.display = '';
    const addOpt = (v, txt) => { const o = el('option', null, txt); o.value = v; sel.appendChild(o); };
    addOpt('all', 'Toute la période (' + monthLabel(h.months[0]) + ' → ' + monthLabel(h.months[h.months.length - 1]) + ')');
    (h.presets || []).forEach((p, i) => addOpt('p' + i, p.label));
    addOpt('custom', 'Personnalisé…');
    // sélectionne l'option correspondant à state.months
    const cur = state.months ? state.months.join(',') : null;
    let matched = 'custom';
    if (!cur) matched = 'all';
    else { (h.presets || []).forEach((p, i) => { if (p.months.join(',') === cur) matched = 'p' + i; }); }
    if (matched === 'custom' && cur) { addCustomOption(); }
    sel.value = matched;
    sel.onchange = () => {
      if (sel.value === 'all') { state.months = null; refresh(); }
      else if (sel.value.startsWith('p')) { state.months = h.presets[+sel.value.slice(1)].months.slice(); refresh(); }
      else openMonthsModal();
    };
  }
  function addCustomOption() {
    const sel = $('periodSel');
    let o = [...sel.options].find(x => x.value === 'customsel');
    if (!o) { o = el('option', null, ''); o.value = 'customsel'; sel.insertBefore(o, sel.lastElementChild); }
    o.textContent = 'Personnalisé (' + state.months.length + ' mois)';
    sel.value = 'customsel';
  }
  function openMonthsModal() {
    const h = pack.header;
    openModal('Mois inclus dans l\'analyse',
      h.months.map(ym => ({ label: monthLabel(ym), checked: !state.months || state.months.includes(ym), indent: 0 })),
      sels => {
        if (sels.length === 0 || sels.length === h.months.length) state.months = null;
        else state.months = sels.map(i => h.months[i]);
        if (state.months) addCustomOption(); else $('periodSel').value = 'all';
        refresh();
      }, () => buildPeriodSelect());
  }

  // ------------------------------------------------------------ modal générique
  let modalOk = null, modalCancel = null;
  function openModal(title, items, onOk, onCancel) {
    $('modalTitle').textContent = title;
    const list = $('modalList'); list.textContent = '';
    items.forEach((it, i) => {
      const lab = el('label', it.indent ? 'ind' + Math.min(2, it.indent) : null);
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!it.checked; cb.dataset.idx = i;
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + it.label));
      list.appendChild(lab);
    });
    modalOk = () => { const sels = [...list.querySelectorAll('input')].map((cb, i) => cb.checked ? i : -1).filter(i => i >= 0); closeModal(); onOk(sels); };
    modalCancel = () => { closeModal(); if (onCancel) onCancel(); };
    $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; }
  $('modalOk').onclick = () => modalOk && modalOk();
  $('modalCancel').onclick = () => modalCancel && modalCancel();
  $('modalAll').onclick = () => $('modalList').querySelectorAll('input').forEach(cb => cb.checked = true);
  $('modalNone').onclick = () => $('modalList').querySelectorAll('input').forEach(cb => cb.checked = false);
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) modalCancel && modalCancel(); });

  function openFilterModal(varId) {
    const v = V(varId);
    const cur = state.filters.find(f => f.varId === varId);
    openModal('Filtrer : ' + varTitle(v),
      v.mods.map((m, i) => ({ label: m.label, checked: cur ? cur.mods.includes(i) : false, indent: m.indent })),
      sels => {
        const i = state.filters.findIndex(f => f.varId === varId);
        if (!sels.length || sels.length === v.mods.length) { if (i >= 0) state.filters.splice(i, 1); }
        else if (i >= 0) state.filters[i].mods = sels;
        else state.filters.push({ varId, mods: sels });
        refresh();
      });
  }

  // ------------------------------------------------------------ options
  function segInit(id, get, set) {
    $(id).querySelectorAll('button').forEach(b => b.onclick = () => { set(b.dataset.v); syncOptionButtons(); rerender(); });
  }
  function syncOptionButtons() {
    const o = state.opts;
    $('segWeight').querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.v === 'w') === o.weighted));
    $('segDisplay').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === o.display));
    $('segSig').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === o.sig));
  }
  segInit('segWeight', () => { }, v => state.opts.weighted = (v === 'w'));
  segInit('segDisplay', () => { }, v => state.opts.display = v);
  segInit('segSig', () => { }, v => state.opts.sig = v);
  $('selLevels').onchange = () => { state.opts.levels = $('selLevels').value.split(',').map(Number); rerender(); };
  $('inpMask').onchange = () => { state.opts.mask = Math.max(0, +$('inpMask').value || 0); rerender(); };
  $('chkWBase').onchange = () => { state.opts.showWBase = $('chkWBase').checked; rerender(); };
  $('chkEffBase').onchange = () => { state.opts.showEffBase = $('chkEffBase').checked; rerender(); };

  // ------------------------------------------------------------ calcul + rendu
  function currentSpec() {
    const filters = state.filters.map(f => ({ varId: f.varId, mods: f.mods }));
    const h = pack.header;
    if (state.months && h.monthsVarId && V(h.monthsVarId)) {
      const mods = state.months.map(ym => h.months.indexOf(ym)).filter(i => i >= 0);
      if (mods.length && mods.length < h.months.length) filters.push({ varId: h.monthsVarId, mods });
    }
    return { rows: state.rows, cols: state.cols, filters };
  }

  function refresh() { renderChips(); markTreeButtons(); if (pack) recompute(); }

  function recompute() {
    if (!pack) return;
    renderChips(); markTreeButtons();
    const st = $('status');
    if (!state.rows.length) { st.innerHTML = 'Ajoutez au moins une variable en <strong>Lignes</strong> (bouton « L » dans le panneau des variables).'; $('table').textContent = ''; return; }
    const t0 = performance.now();
    lastResult = TabEngine.compute(pack, currentSpec());
    const dt = performance.now() - t0;
    rerender(dt);
    history.replaceState(null, '', hashState());
  }

  function rerender(computeMs) {
    if (!lastResult) return;
    lastRender = TabEngine.render(lastResult, state.opts);
    drawTable(lastRender);
    const st = $('status');
    const o = state.opts;
    const notes = [];
    notes.push(fmtInt(lastResult.nFilter) + ' répondants dans l\'univers (Σ poids ' + fmtInt(lastResult.wFilter) + ')');
    if (o.sig === 'total') notes.push('vert / rouge = significativement supérieur / inférieur au Total (' + o.levels.join(' % et ') + ' %' + (o.levels.length > 1 ? ', gras = ' + o.levels[o.levels.length - 1] + ' %' : '') + ')');
    if (o.sig === 'comp') notes.push('vert / rouge = significativement supérieur / inférieur au complément (reste de l\'univers)');
    if (o.sig === 'pairs') notes.push('lettres = colonnes (de la même variable) auxquelles la cellule est significativement supérieure' + (o.levels.length > 1 ? ' (MAJUSCULE = ' + o.levels[o.levels.length - 1] + ' %, minuscule = ' + o.levels[0] + ' %)' : ''));
    if (o.display === 'prow') notes.push('<span class="warn">% ligne : les tests restent calculés sur les % colonne</span>');
    if (o.mask > 0) notes.push('« - » = base brute < ' + o.mask);
    notes.push('chiffres ' + (o.weighted ? 'redressés (poids)' : 'bruts (non pondérés)'));
    if (computeMs != null) notes.push('calcul ' + (computeMs / 1000).toFixed(2) + ' s');
    st.innerHTML = notes.join(' · ');
  }

  function drawTable(R) {
    const tbl = $('table'); tbl.textContent = '';
    const NC = R.cols.length;
    const thead = el('thead');
    // ligne 1 : groupes de colonnes
    const tr1 = el('tr');
    const corner = el('th', 'rowhead', ''); corner.rowSpan = R.sig === 'pairs' ? 3 : 2; tr1.appendChild(corner);
    let c = 0;
    while (c < NC) {
      let e = c;
      while (e + 1 < NC && R.cols[e + 1].gi === R.cols[c].gi) e++;
      const th = el('th', null, R.cols[c].type === 'total' ? '' : R.cols[c].group);
      th.colSpan = e - c + 1;
      tr1.appendChild(th);
      c = e + 1;
    }
    thead.appendChild(tr1);
    // ligne 2 : libellés de colonnes
    const tr2 = el('tr');
    R.cols.forEach(col => { const th = el('th', null, col.label); th.title = (col.group ? col.group + ' — ' : '') + col.label; tr2.appendChild(th); });
    thead.appendChild(tr2);
    // ligne 3 : lettres (mode tout contre tout)
    if (R.sig === 'pairs') {
      const tr3 = el('tr');
      R.cols.forEach(col => tr3.appendChild(el('th', null, col.letter || '')));
      thead.appendChild(tr3);
    }
    tbl.appendChild(thead);

    const tbody = el('tbody');
    for (const B of R.blocks) {
      const trh = el('tr', 'blockhead');
      const th = el('th', 'rlabel', B.label); th.title = B.longLabel + (B.theme ? '\nThème : ' + B.theme : '');
      trh.appendChild(th);
      const tdTheme = el('td', null, B.theme || ''); tdTheme.colSpan = NC; tdTheme.style.textAlign = 'left'; tdTheme.style.fontWeight = '400'; tdTheme.style.fontSize = '10.5px';
      trh.appendChild(tdTheme);
      tbody.appendChild(trh);
      for (const base of B.bases) {
        const tr = el('tr', 'baserow');
        tr.appendChild(el('th', 'rlabel', base.label));
        base.cells.forEach(t => tr.appendChild(el('td', null, t)));
        tbody.appendChild(tr);
      }
      for (const row of B.rows) {
        const tr = el('tr');
        const th = el('th', 'rlabel', ''); th.style.paddingLeft = (8 + 14 * (row.indent || 0)) + 'px'; th.textContent = row.label; th.title = row.label;
        tr.appendChild(th);
        row.cells.forEach(cell => {
          const td = el('td', null, cell.text);
          if (cell.masked) td.className = 'masked';
          else {
            if (cell.sign > 0) td.classList.add('up');
            if (cell.sign < 0) td.classList.add('dn');
            if (cell.level === R.levels[R.levels.length - 1] && R.levels.length > 1 && cell.sign !== 0) td.classList.add('lvmax');
            if (R.levels.length === 1 && cell.sign !== 0) td.classList.add('lvmax');
            if (cell.letters) { const s = el('sup', 'letters', cell.letters); td.appendChild(s); }
          }
          if (cell.tip) td.title = cell.tip;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
    }
    tbl.appendChild(tbody);
  }

  // ------------------------------------------------------------ exports
  function exportName(ext) {
    const d = new Date().toISOString().slice(0, 10);
    return 'croiseur_' + d + '.' + ext;
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function tableToMatrix() { // pour CSV / presse-papiers (textes affichés)
    const R = lastRender; if (!R) return [];
    const out = [];
    out.push([''].concat(R.cols.map(c => c.type === 'total' ? '' : c.group)));
    out.push([''].concat(R.cols.map(c => c.label)));
    if (R.sig === 'pairs') out.push([''].concat(R.cols.map(c => c.letter)));
    for (const B of R.blocks) {
      out.push([B.label].concat(Array(R.cols.length).fill('')));
      for (const base of B.bases) out.push([base.label].concat(base.cells));
      for (const row of B.rows) out.push(['  '.repeat(row.indent || 0) + row.label].concat(row.cells.map(c => c.text + (c.letters ? ' ' + c.letters : ''))));
    }
    return out;
  }

  $('btnExportCsv').onclick = () => {
    const rows = tableToMatrix();
    const csv = '﻿' + rows.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(';')).join('\r\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), exportName('csv'));
  };
  $('btnCopy').onclick = async () => {
    const rows = tableToMatrix();
    const tsv = rows.map(r => r.map(x => String(x).replace(/\t/g, ' ')).join('\t')).join('\r\n');
    try { await navigator.clipboard.writeText(tsv); toast('Tableau copié — collez-le dans Excel'); }
    catch (e) { alert('Copie impossible : ' + e.message); }
  };
  $('btnShare').onclick = async () => {
    const url = location.origin + location.pathname + hashState();
    try { await navigator.clipboard.writeText(url); toast('Lien copié — il restitue ce tableau (même base requise)'); }
    catch (e) { prompt('Copiez ce lien :', url); }
  };

  function loadExcelJs() {
    if (excelJsReady) return excelJsReady;
    excelJsReady = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/exceljs.min.js';
      s.onload = () => res(); s.onerror = () => rej(new Error('vendor/exceljs.min.js introuvable'));
      document.head.appendChild(s);
    });
    return excelJsReady;
  }

  $('btnExportXlsx').onclick = async () => {
    if (!lastRender) return;
    try {
      await loadExcelJs();
      const R = lastRender, o = state.opts;
      const GREEN = 'FF00B050', RED = 'FFC00000', HDR = 'FF1F3864', SUB = 'FFD9E1F2', BLK = 'FFF2F2F2';
      const wb = new ExcelJS.Workbook(); wb.creator = 'Croiseur OW';
      const ws = wb.addWorksheet('Croiseur');
      const NC = R.cols.length;
      ws.getColumn(1).width = 48;
      for (let i = 0; i < NC; i++) ws.getColumn(2 + i).width = 12;
      // titres
      ws.getCell(1, 1).value = pack.header.title || 'Croiseur OW';
      ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: HDR } };
      const notes = [$('status').textContent];
      ws.getCell(2, 1).value = notes.join(' ');
      ws.getCell(2, 1).font = { italic: true, size: 9 };
      // en-têtes
      const HR = 4;
      let ccol = 2;
      let ci = 0;
      while (ci < NC) {
        let e = ci; while (e + 1 < NC && R.cols[e + 1].gi === R.cols[ci].gi) e++;
        if (R.cols[ci].type !== 'total') {
          ws.mergeCells(HR, 2 + ci, HR, 2 + e);
          const gc = ws.getCell(HR, 2 + ci); gc.value = R.cols[ci].group;
          gc.font = { bold: true, size: 9 }; gc.alignment = { horizontal: 'center' };
          gc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUB } };
        }
        ci = e + 1;
      }
      R.cols.forEach((col, i) => {
        const c = ws.getCell(HR + 1, 2 + i);
        c.value = col.label + (R.sig === 'pairs' && col.letter ? ' (' + col.letter + ')' : '');
        c.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HDR } };
        c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      });
      let r = HR + 2;
      for (const B of R.blocks) {
        const hc = ws.getCell(r, 1); hc.value = B.label; hc.font = { bold: true, size: 9 };
        hc.note = B.longLabel + (B.theme ? '\nThème : ' + B.theme : '');
        for (let i = 0; i <= NC; i++) ws.getCell(r, 1 + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLK } };
        r++;
        for (const base of B.bases) {
          ws.getCell(r, 1).value = base.label; ws.getCell(r, 1).font = { italic: true, size: 9 };
          base.cells.forEach((t, i) => { const c = ws.getCell(r, 2 + i); if (t !== '') { c.value = Math.round(+t.replace(/[\s  ]/g, '')); c.numFmt = '#,##0'; } c.font = { size: 9, bold: true }; c.alignment = { horizontal: 'center' }; });
          r++;
        }
        for (const row of B.rows) {
          ws.getCell(r, 1).value = '  '.repeat(row.indent || 0) + row.label;
          ws.getCell(r, 1).font = { size: 9 };
          row.cells.forEach((cell, i) => {
            const c = ws.getCell(r, 2 + i);
            c.alignment = { horizontal: 'center' };
            if (cell.masked) { c.value = '-'; c.font = { size: 9, color: { argb: 'FFBFBFBF' } }; return; }
            if (cell.letters) { c.value = (cell.text || '') + '  ' + cell.letters; }
            else if (cell.xv != null) { c.value = cell.xv; if (cell.xfmt) c.numFmt = cell.xfmt; }
            else c.value = cell.text;
            let color = 'FF000000', bold = false;
            if (cell.sign > 0) color = GREEN; else if (cell.sign < 0) color = RED;
            if (cell.sign !== 0 && (R.levels.length === 1 || cell.level === R.levels[R.levels.length - 1])) bold = true;
            c.font = { size: 9, color: { argb: color }, bold };
          });
          r++;
        }
      }
      ws.views = [{ state: 'frozen', xSplit: 1, ySplit: HR + 1 }];
      const buf = await wb.xlsx.writeBuffer();
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), exportName('xlsx'));
    } catch (e) { console.error(e); alert('Export Excel impossible : ' + e.message); }
  };

  // ------------------------------------------------------------ chargement / drag&drop / démarrage
  $('btnLoad').onclick = () => $('fileInput').click();
  $('btnLoad2').onclick = () => $('fileInput').click();
  $('fileInput').onchange = () => { if ($('fileInput').files[0]) loadFile($('fileInput').files[0]); $('fileInput').value = ''; };
  $('btnDemo').onclick = async () => {
    try {
      const rsp = await fetch('demo/demo.owx');
      if (!rsp.ok) throw new Error('demo introuvable');
      await loadPackFromBytes(await rsp.arrayBuffer(), 'demo.owx', true); // pas de mise en cache de la démo
    } catch (e) { alert('Démo indisponible : ' + e.message); }
  };
  $('btnSidebar').onclick = () => $('sidebar').classList.toggle('hidden');
  $('btnCacheClear').onclick = async () => { await cacheClear(); $('cacheBanner').hidden = true; toast('Cache vidé — la base restera chargée jusqu\'à fermeture de l\'onglet'); };

  window.addEventListener('dragover', e => { e.preventDefault(); $('dropInner') && $('dropInner').classList.add('drag'); });
  window.addEventListener('dragleave', () => { $('dropInner') && $('dropInner').classList.remove('drag'); });
  window.addEventListener('drop', e => {
    e.preventDefault(); $('dropInner') && $('dropInner').classList.remove('drag');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  tryCache();
})();
