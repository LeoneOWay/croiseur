/* tabengine.js — moteur de croisement du croiseur OW.
 *
 * compute(pack, spec)  : une passe sur les répondants → accumulateurs par cellule
 *   spec = { rows:[varId…], cols:[varId…], filters:[{varId, mods:[idx…]}] }
 *   Accumule TOUJOURS brut (n) ET redressé (Σw, Σw²) : le passage brut/redressé
 *   se fait au rendu, sans repasser sur les données.
 *
 * render(result, opts) : accumulateurs → modèle d'affichage (valeurs, signifs)
 *   opts = { weighted, display:'pcol'|'prow'|'count', sig:'none'|'total'|'pairs'|'comp',
 *            levels:[95,99], mask:60 }
 *
 * Conventions statistiques (identiques au moteur de tris OpinionWay) :
 *   - % redressés au poids ; base « Interrogés » = effectif brut ;
 *   - tests sur base effective de Kish n_eff = (Σw)²/Σw² (redressé) ou n (brut) ;
 *   - % : z-test de deux proportions (variance poolée) ; moyennes : t grand
 *     échantillon (variance pondérée) ; NPS : test dédié promoteurs−détracteurs ;
 *   - masquage si base brute < seuil.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TabEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Z = { 90: 1.644854, 95: 1.959964, 99: 2.575829 };

  function kish(sw, sw2) { return sw2 > 0 ? (sw * sw) / sw2 : 0; }
  function levelOf(z, levels) { let best = 0; const a = Math.abs(z); for (const L of levels) { if (a >= Z[L]) best = Math.max(best, L); } return best; }

  function propTest(p1, n1, p2, n2) {
    if (!(n1 > 0) || !(n2 > 0) || p1 !== p1 || p2 !== p2) return 0;
    const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    return se > 0 ? (p1 - p2) / se : 0;
  }
  function meanTest(m1, v1, n1, m2, v2, n2) {
    if (!(n1 > 1) || !(n2 > 1) || m1 !== m1 || m2 !== m2) return 0;
    const se = Math.sqrt(v1 / n1 + v2 / n2);
    return se > 0 ? (m1 - m2) / se : 0;
  }
  function npsTest(a1, d1, n1, a2, d2, n2) {
    if (!(n1 > 0) || !(n2 > 0) || a1 !== a1 || a2 !== a2) return 0;
    const v1 = (a1 + d1 - (a1 - d1) * (a1 - d1)) / n1;
    const v2 = (a2 + d2 - (a2 - d2) * (a2 - d2)) / n2;
    const se = Math.sqrt(v1 + v2);
    return se > 0 ? ((a1 - d1) - (a2 - d2)) / se : 0;
  }

  function varById(header, id) { return header.vars.find(v => v.id === id) || null; }
  function bp(bit) { return { byte: bit >> 3, mask: 1 << (bit & 7) }; }

  // lettre de colonne pour le mode « tout contre tout » (A…Z, AA…)
  function colLetter(i) { let s = ''; i++; while (i > 0) { i--; s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26); } return s; }

  // -------------------------------------------------------------------------
  function compute(pack, spec) {
    const h = pack.header, L = h.layout, BPR = L.bytesPerRow, NNUM = L.numCount || 0;
    const bits = pack.bits, W = pack.weights, X = pack.nums, n = h.n;

    // filtres : ET entre variables, OU entre modalités d'une même variable
    const fgroups = [];
    for (const f of (spec.filters || [])) {
      const v = varById(h, f.varId);
      if (!v || !f.mods || !f.mods.length) continue;
      // indices dédupliqués et bornés (liens de partage / packs régénérés) ;
      // « toutes modalités cochées » reste un vrai filtre (les variables ne sont
      // pas forcément exhaustives : multi-réponses, univers restreints…)
      const mset = [...new Set(f.mods)].filter(mi => Number.isInteger(mi) && mi >= 0 && mi < v.mods.length);
      if (!mset.length) continue;
      fgroups.push(mset.map(mi => bp(v.mods[mi].bit)));
    }

    // colonnes : Total + modalités de chaque variable de colonne
    const cols = [{ type: 'total', label: 'Total', group: '', gi: -1, letter: '' }];
    let letterIdx = 0;
    (spec.cols || []).forEach((cid, gi) => {
      const v = varById(h, cid);
      if (!v) return;
      v.mods.forEach((m, mi) => {
        const p = bp(m.bit);
        cols.push({ type: 'mod', varId: cid, gi, mi, label: m.label, group: v.code || v.label, byte: p.byte, mask: p.mask, letter: colLetter(letterIdx++) });
      });
    });
    const NC = cols.length;

    // blocs lignes
    const blocks = (spec.rows || []).map(rid => {
      const v = varById(h, rid);
      if (!v) return null;
      const B = { varId: rid, v, basePair: v.baseBit != null ? bp(v.baseBit) : null,
        baseN: new Float64Array(NC), baseW: new Float64Array(NC), baseW2: new Float64Array(NC), rows: [] };
      if (v.nps) B.rows.push({ kind: 'nps', label: v.nps.label || 'NPS', indent: v.nps.indent || 0 });
      for (const m of v.mods) {
        const p = bp(m.bit);
        B.rows.push({ kind: 'pct', key: m.key || null, label: m.label, indent: m.indent == null ? 1 : m.indent,
          byte: p.byte, mask: p.mask, cnt: new Float64Array(NC), sw: new Float64Array(NC) });
      }
      if (v.mean) B.rows.push({ kind: 'mean', num: v.mean.num, label: v.mean.label || 'Moyenne', indent: v.mean.indent == null ? 1 : v.mean.indent,
        sx: new Float64Array(NC), sxx: new Float64Array(NC), swx: new Float64Array(NC), swxx: new Float64Array(NC) });
      const npsRow = B.rows.find(r => r.kind === 'nps');
      if (npsRow) { // repérage par clé, sinon par bit (nps.promoBit/detBit)
        const byBit = bit => bit == null ? null : (B.rows.find(r => r.kind === 'pct' && r.byte === (bit >> 3) && r.mask === (1 << (bit & 7))) || null);
        npsRow.promoRow = B.rows.find(r => r.key === 'promo') || byBit(v.nps.promoBit);
        npsRow.detRow = B.rows.find(r => r.key === 'det') || byBit(v.nps.detBit);
      }
      return B;
    }).filter(Boolean);

    // passe unique
    const hits = new Int32Array(NC);
    let nFilter = 0, wFilter = 0;
    for (let r = 0; r < n; r++) {
      const off = r * BPR;
      let ok = true;
      for (let g = 0; g < fgroups.length; g++) {
        const grp = fgroups[g]; let any = false;
        for (let i = 0; i < grp.length; i++) { const p = grp[i]; if (bits[off + p.byte] & p.mask) { any = true; break; } }
        if (!any) { ok = false; break; }
      }
      if (!ok) continue;
      const w = W[r], ww = w * w;
      nFilter++; wFilter += w;
      let nh = 0; hits[nh++] = 0;
      for (let c = 1; c < NC; c++) { const d = cols[c]; if (bits[off + d.byte] & d.mask) hits[nh++] = c; }
      for (let b = 0; b < blocks.length; b++) {
        const B = blocks[b];
        if (B.basePair && !(bits[off + B.basePair.byte] & B.basePair.mask)) continue;
        for (let k = 0; k < nh; k++) { const c = hits[k]; B.baseN[c]++; B.baseW[c] += w; B.baseW2[c] += ww; }
        const rows = B.rows;
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          if (row.kind === 'pct') {
            if (bits[off + row.byte] & row.mask) { for (let k = 0; k < nh; k++) { const c = hits[k]; row.cnt[c]++; row.sw[c] += w; } }
          } else if (row.kind === 'mean') {
            const x = X[r * NNUM + row.num];
            if (x === x) { const wx = w * x; for (let k = 0; k < nh; k++) { const c = hits[k]; row.sx[c] += x; row.sxx[c] += x * x; row.swx[c] += wx; row.swxx[c] += wx * x; } }
          }
        }
      }
    }
    return { header: h, spec, cols, blocks, nFilter, wFilter };
  }

  // -------------------------------------------------------------------------
  // valeur d'une cellule : {kind:'p'|'mean'|'nps', v, varp?, a?, d?, neff, n, w, num}
  function cellValue(B, row, c, weighted) {
    const bn = B.baseN[c], bw = weighted ? B.baseW[c] : bn;
    const neff = weighted ? kish(B.baseW[c], B.baseW2[c]) : bn;
    if (row.kind === 'pct') {
      const num = weighted ? row.sw[c] : row.cnt[c];
      return { kind: 'p', v: bw > 0 ? num / bw : NaN, neff, n: bn, num };
    }
    if (row.kind === 'mean') {
      const s1 = weighted ? row.swx[c] : row.sx[c], s2 = weighted ? row.swxx[c] : row.sxx[c];
      const m = bw > 0 ? s1 / bw : NaN;
      const varp = bw > 0 ? Math.max(0, s2 / bw - m * m) : NaN;
      return { kind: 'mean', v: m, varp, neff, n: bn };
    }
    if (row.kind === 'nps') {
      const a = bw > 0 && row.promoRow ? (weighted ? row.promoRow.sw[c] : row.promoRow.cnt[c]) / bw : NaN;
      const d = bw > 0 && row.detRow ? (weighted ? row.detRow.sw[c] : row.detRow.cnt[c]) / bw : NaN;
      return { kind: 'nps', v: (a - d) * 100, a, d, neff, n: bn };
    }
    return { kind: '?', v: NaN, neff: 0, n: bn };
  }

  // cellule « complément » (Total − colonne c) pour le test vs complément
  function complementValue(B, row, c, weighted) {
    const bn = B.baseN[0] - B.baseN[c];
    const bw = weighted ? (B.baseW[0] - B.baseW[c]) : bn;
    const neff = weighted ? kish(B.baseW[0] - B.baseW[c], B.baseW2[0] - B.baseW2[c]) : bn;
    if (row.kind === 'pct') {
      const num = weighted ? (row.sw[0] - row.sw[c]) : (row.cnt[0] - row.cnt[c]);
      return { kind: 'p', v: bw > 0 ? num / bw : NaN, neff, n: bn };
    }
    if (row.kind === 'mean') {
      const s1 = weighted ? (row.swx[0] - row.swx[c]) : (row.sx[0] - row.sx[c]);
      const s2 = weighted ? (row.swxx[0] - row.swxx[c]) : (row.sxx[0] - row.sxx[c]);
      const m = bw > 0 ? s1 / bw : NaN;
      return { kind: 'mean', v: m, varp: bw > 0 ? Math.max(0, s2 / bw - m * m) : NaN, neff, n: bn };
    }
    if (row.kind === 'nps') {
      const a = bw > 0 && row.promoRow ? ((weighted ? row.promoRow.sw[0] - row.promoRow.sw[c] : row.promoRow.cnt[0] - row.promoRow.cnt[c]) / bw) : NaN;
      const d = bw > 0 && row.detRow ? ((weighted ? row.detRow.sw[0] - row.detRow.sw[c] : row.detRow.cnt[0] - row.detRow.cnt[c]) / bw) : NaN;
      return { kind: 'nps', v: (a - d) * 100, a, d, neff, n: bn };
    }
    return { kind: '?', v: NaN, neff: 0, n: bn };
  }

  function zBetween(cur, ref) {
    if (!cur || !ref) return 0;
    if (cur.kind === 'p') return propTest(cur.v, cur.neff, ref.v, ref.neff);
    if (cur.kind === 'mean') return meanTest(cur.v, cur.varp, cur.neff, ref.v, ref.varp, ref.neff);
    if (cur.kind === 'nps') return npsTest(cur.a, cur.d, cur.neff, ref.a, ref.d, ref.neff);
    return 0;
  }

  const fmtInt = x => Math.round(x).toLocaleString('fr-FR');
  const fmt1 = x => x.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function fmtValue(mv, display, rowTotalNum) {
    if (mv.v !== mv.v) return '';
    if (mv.kind === 'p') {
      if (display === 'count') return fmtInt(mv.num);
      if (display === 'prow') return rowTotalNum > 0 ? fmt1(100 * mv.num / rowTotalNum) + '%' : '';
      return fmt1(100 * mv.v) + '%';
    }
    return fmt1(mv.v); // moyenne, NPS
  }

  // -------------------------------------------------------------------------
  function render(result, opts) {
    const weighted = opts.weighted !== false;
    const display = opts.display || 'pcol';
    const sig = opts.sig || 'total';
    const levels = (opts.levels && opts.levels.length ? opts.levels : [95, 99]).slice().sort((a, b) => a - b);
    const maxLevel = levels[levels.length - 1];
    const mask = opts.mask == null ? 60 : opts.mask;
    const cols = result.cols, NC = cols.length;

    const out = { cols, blocks: [], weighted, display, sig, levels, mask, nFilter: result.nFilter, wFilter: result.wFilter };
    for (const B of result.blocks) {
      const blkOut = { varId: B.varId, v: B.v, label: B.v.display || B.v.label, longLabel: B.v.label, theme: B.v.theme, type: B.v.type, rows: [], bases: [] };
      // lignes de base
      blkOut.bases.push({ label: B.v.baseLabel || (B.v.kind === 'question' ? 'Interrogés' : 'Ensemble (interrogés)'), cells: Array.from({ length: NC }, (_, c) => B.baseN[c] > 0 ? fmtInt(B.baseN[c]) : '') });
      if (opts.showWBase) blkOut.bases.push({ label: 'Base redressée', cells: Array.from({ length: NC }, (_, c) => B.baseW[c] > 0 ? fmtInt(B.baseW[c]) : '') });
      if (opts.showEffBase) blkOut.bases.push({ label: 'Base effective (Kish)', cells: Array.from({ length: NC }, (_, c) => B.baseW2[c] > 0 ? fmtInt(kish(B.baseW[c], B.baseW2[c])) : '') });

      for (const row of B.rows) {
        const rowOut = { label: row.label, indent: row.indent || 0, kind: row.kind, cells: [] };
        const totalMV = cellValue(B, row, 0, weighted);
        const rowTotalNum = row.kind === 'pct' ? (weighted ? row.sw[0] : row.cnt[0]) : 0;
        for (let c = 0; c < NC; c++) {
          const masked = B.baseN[c] < mask;
          if (masked) { rowOut.cells.push({ text: '-', masked: true, tip: 'Base brute < ' + mask + ' (n=' + fmtInt(B.baseN[c]) + ')' }); continue; }
          const mv = c === 0 ? totalMV : cellValue(B, row, c, weighted);
          const cell = { text: fmtValue(mv, display, rowTotalNum), sign: 0, level: 0, letters: '' };
          if (mv.v === mv.v) { // valeur numérique + format pour l'export Excel
            if (mv.kind === 'p') {
              if (display === 'count') { cell.xv = Math.round(mv.num); cell.xfmt = '#,##0'; }
              else if (display === 'prow') { cell.xv = rowTotalNum > 0 ? mv.num / rowTotalNum : null; cell.xfmt = '0.0%'; }
              else { cell.xv = mv.v; cell.xfmt = '0.0%'; }
            } else { cell.xv = mv.v; cell.xfmt = '0.0'; }
          }
          const tips = ['n=' + fmtInt(mv.n), weighted ? 'base eff.=' + fmtInt(mv.neff) : 'base=' + fmtInt(mv.neff)];
          if (sig !== 'none' && c > 0 && mv.v === mv.v) {
            if (sig === 'total') {
              if (B.baseN[0] >= mask) {
                const z = zBetween(mv, totalMV);
                const lv = levelOf(z, levels);
                if (lv > 0) { cell.sign = z > 0 ? 1 : -1; cell.level = lv; }
                tips.push('vs Total : z=' + z.toFixed(2) + (lv ? ' (' + lv + '%)' : ' (ns)'));
              }
            } else if (sig === 'comp') {
              const comp = complementValue(B, row, c, weighted);
              if (comp.n >= mask) {
                const z = zBetween(mv, comp);
                const lv = levelOf(z, levels);
                if (lv > 0) { cell.sign = z > 0 ? 1 : -1; cell.level = lv; }
                tips.push('vs complément : z=' + z.toFixed(2) + (lv ? ' (' + lv + '%)' : ' (ns)'));
              }
            } else if (sig === 'pairs') {
              const letters = [];
              for (let c2 = 1; c2 < NC; c2++) {
                if (c2 === c || cols[c2].gi !== cols[c].gi) continue;
                if (B.baseN[c2] < mask) continue;
                const other = cellValue(B, row, c2, weighted);
                if (other.v !== other.v) continue;
                const z = zBetween(mv, other);
                const lv = levelOf(z, levels);
                if (lv > 0 && z > 0) letters.push(lv === maxLevel && levels.length > 1 ? cols[c2].letter : cols[c2].letter.toLowerCase());
              }
              if (letters.length) cell.letters = letters.join(' ');
              tips.push('supérieur à : ' + (cell.letters || '(aucune colonne)'));
            }
          }
          cell.tip = tips.join(' · ');
          rowOut.cells.push(cell);
        }
        blkOut.rows.push(rowOut);
      }
      out.blocks.push(blkOut);
    }
    return out;
  }

  return { compute, render, cellValue, complementValue, zBetween, kish, propTest, meanTest, npsTest, levelOf, varById, colLetter, Z, fmtInt, fmt1 };
});
