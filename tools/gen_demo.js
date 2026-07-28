'use strict';
/* gen_demo.js — génère demo/demo.owx : un jeu de données SYNTHÉTIQUE (aucune
 * donnée réelle) pour découvrir le croiseur. Usage : node tools/gen_demo.js */
const fs = require('fs');
const path = require('path');
const OWX = require('../js/owx.js');

// générateur pseudo-aléatoire déterministe (pack de démo stable)
let seed = 42;
function rnd() { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(probs) { let r = rnd(), acc = 0; for (let i = 0; i < probs.length; i++) { acc += probs[i]; if (r < acc) return i; } return probs.length - 1; }

const N = 4000;
const months = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];

// --- déclaration des variables (bits) ---
let bit = 0;
const B = () => bit++;
const REGION = { id: 'L_REGION', code: 'Région', label: 'Région', theme: 'Signalétique', kind: 'lecture', type: 'single', baseBit: null,
  mods: ['Nord', 'Sud', 'Est', 'Ouest'].map(l => ({ label: l, bit: B(), indent: 1 })) };
const SEXE = { id: 'L_SEXE', code: 'Sexe', label: 'Sexe', theme: 'Signalétique', kind: 'lecture', type: 'single', baseBit: null,
  mods: ['Homme', 'Femme'].map(l => ({ label: l, bit: B(), indent: 1 })) };
const AGE = { id: 'L_AGE', code: 'Âge', label: 'Âge', theme: 'Signalétique', kind: 'lecture', type: 'single', baseBit: null,
  mods: ['18-24 ans', '25-39 ans', '40-59 ans', '60 ans et +'].map(l => ({ label: l, bit: B(), indent: 1 })) };
const MOIS = { id: 'L_MOIS', code: 'Mois', label: 'Mois d\'interrogation', theme: 'Signalétique', kind: 'lecture', type: 'single', baseBit: null,
  mods: months.map(ym => ({ label: 'Mois ' + ym, bit: B(), indent: 1 })) };
const Q1 = { id: 'Q1', code: 'Q1. Satisfaction globale', label: 'Q1. Globalement, êtes-vous satisfait du service ?', theme: 'Satisfaction', kind: 'question', type: 'single',
  baseBit: B(), baseLabel: 'Interrogés',
  mods: [{ label: 'ST Satisfait', bit: B(), indent: 1 }, { label: 'Très satisfait', bit: B(), indent: 2 }, { label: 'Assez satisfait', bit: B(), indent: 2 },
         { label: 'Peu satisfait', bit: B(), indent: 1 }, { label: 'Pas du tout satisfait', bit: B(), indent: 1 }] };
const Q2 = { id: 'Q2', code: 'Q2. Recommandation (NPS)', label: 'Q2. Recommanderiez-vous ce service ? (note 0-10)', theme: 'Satisfaction', kind: 'question', type: 'nps',
  baseBit: B(), baseLabel: 'Interrogés',
  mods: [{ label: 'dont Promoteurs (9-10)', bit: B(), indent: 1, key: 'promo' }, { label: 'dont Neutres (7-8)', bit: B(), indent: 1, key: 'neu' }, { label: 'dont Détracteurs (0-6)', bit: B(), indent: 1, key: 'det' }] };
Q2.nps = { label: 'NPS', indent: 0, promoBit: Q2.mods[0].bit, neuBit: Q2.mods[1].bit, detBit: Q2.mods[2].bit };
const Q3 = { id: 'Q3', code: 'Q3. Services utilisés', label: 'Q3. Quels services avez-vous utilisés ? (plusieurs réponses possibles)', theme: 'Usages', kind: 'question', type: 'multi',
  baseBit: B(), baseLabel: 'Interrogés',
  mods: ['Application mobile', 'Site internet', 'Guichet', 'Téléphone'].map(l => ({ label: l, bit: B(), indent: 1 })) };
const Q4 = { id: 'Q4', code: 'Q4. Note moyenne', label: 'Q4. Note de satisfaction détaillée (0 à 10) — posée à une personne sur deux', theme: 'Satisfaction', kind: 'question', type: 'numeric',
  baseBit: B(), baseLabel: 'Interrogés', mods: [], mean: { num: 0, label: 'Moyenne (0-10)', indent: 1 } };
const vars = [REGION, SEXE, AGE, MOIS, Q1, Q2, Q3, Q4];

const NBITS = bit, BPR = Math.ceil(NBITS / 8), NNUM = 1;
const bits = new Uint8Array(N * BPR);
const weights = new Float64Array(N);
const nums = new Float32Array(N * NNUM);
const counts = new Uint32Array(NBITS);
const set = (r, b) => { bits[r * BPR + (b >> 3)] |= 1 << (b & 7); counts[b]++; };

for (let r = 0; r < N; r++) {
  weights[r] = 0.4 + rnd() * 2.1;
  const reg = pick([0.30, 0.28, 0.20, 0.22]); set(r, REGION.mods[reg].bit);
  const sexe = pick([0.48, 0.52]); set(r, SEXE.mods[sexe].bit);
  const age = pick([0.14, 0.30, 0.34, 0.22]); set(r, AGE.mods[age].bit);
  set(r, MOIS.mods[pick([0.18, 0.17, 0.17, 0.16, 0.16, 0.16])].bit);
  // satisfaction corrélée à la région et à l'âge (pour des signifs visibles)
  const bonus = (reg === 1 ? 0.10 : reg === 2 ? -0.08 : 0) + (age === 3 ? 0.07 : 0);
  set(r, Q1.baseBit);
  const q1 = pick([0.22 + bonus, 0.46, 0.22 - bonus, 0.10]); // TS / AS / Peu / Pas du tout
  if (q1 <= 1) set(r, Q1.mods[0].bit);            // ST Satisfait
  set(r, Q1.mods[q1 + 1].bit);
  set(r, Q2.baseBit);
  const q2 = pick([0.24 + bonus, 0.38, 0.38 - bonus]); // promo / neutre / détracteur
  set(r, Q2.mods[q2].bit);
  set(r, Q3.baseBit);
  let anyQ3 = false;
  [[0.55, 0], [0.40, 1], [0.18, 2], [0.12, 3]].forEach(([p, i]) => { if (rnd() < p + (i === 0 && age <= 1 ? 0.2 : 0)) { set(r, Q3.mods[i].bit); anyQ3 = true; } });
  if (!anyQ3) set(r, Q3.mods[2].bit);
  // Q4 posée à 1 répondant sur 2 (illustre les univers restreints)
  if (rnd() < 0.5) { set(r, Q4.baseBit); nums[r] = Math.max(0, Math.min(10, Math.round(6.6 + bonus * 8 + (rnd() + rnd() + rnd() - 1.5) * 2.2))); }
  else nums[r] = NaN;
}

const header = {
  format: 'owx1',
  title: 'Enquête de démonstration (données fictives)',
  subtitle: N.toLocaleString('fr-FR') + ' répondants simulés — jeu d\'essai du croiseur, aucune donnée réelle',
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  n: N, months, monthsVarId: 'L_MOIS',
  layout: { nbits: NBITS, bytesPerRow: BPR, numCount: NNUM },
  themes: ['Signalétique', 'Satisfaction', 'Usages'],
  vars, counts: Array.from(counts),
  presets: [{ label: '1er trimestre 2025', months: months.slice(0, 3) }, { label: '2e trimestre 2025', months: months.slice(3) }],
  defaults: { maskThreshold: 30, levels: [95, 99] },
};

const out = OWX.buildSync(header, { weights, bits, nums });
const dest = path.join(__dirname, '..', 'demo', 'demo.owx');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log('Écrit ' + dest + ' (' + (out.length / 1024).toFixed(0) + ' Ko, ' + N + ' répondants, ' + NBITS + ' bits)');
