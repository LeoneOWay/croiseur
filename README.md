# Croiseur OW

Croiseur d'enquêtes **100 % statique et local** (type Harmonie / Askia Vista) :
une page web qui charge une base d'enquête compacte (fichier `.owx`) et permet
de croiser n'importe quelles variables, sans serveur — **tout le calcul se fait
dans le navigateur, aucune donnée n'est transmise sur Internet**.

➡️ Application : ouvrez `index.html` (ou la version hébergée sur GitHub Pages),
puis glissez votre fichier `.owx`, ou cliquez sur « Essayer la démo ».

## Fonctionnalités

- **Lignes / Colonnes / Filtres** : n'importe quelle variable de la base, dans
  n'importe quel rôle ; plusieurs variables empilées en lignes, plusieurs
  bannières côte à côte en colonnes ; filtres multi-modalités (OU au sein d'une
  variable, ET entre variables) ; sélection de la période (mois).
- **Chiffres redressés ou bruts** : bascule instantanée (les deux jeux
  d'agrégats sont accumulés en une seule passe).
- **Affichage** : % colonne, % ligne ou effectifs ; bases affichables
  (interrogés, base redressée, base effective de Kish).
- **Significativités au choix** :
  - **vs Total** (vert = supérieur, rouge = inférieur),
  - **tout contre tout** (lettres : chaque colonne est comparée à toutes les
    colonnes de la même variable),
  - **vs complément** (chaque colonne comparée au reste de l'univers).
  Seuils 90 / 95 / 99 % (simples ou doubles : gras = seuil haut). Tests z sur
  proportions (variance poolée), t grands échantillons sur moyennes, test dédié
  NPS — sur **base effective de Kish** `(Σw)²/Σw²` en redressé, sur l'effectif
  brut en non-pondéré. Masquage sous un seuil de base paramétrable.
- **Types de variables** : catégorielles (avec sous-totaux « ST » imbriqués),
  multi-réponses, moyennes, NPS (promoteurs / neutres / détracteurs).
- **Exports** : Excel (mise en forme et couleurs), CSV, copier-coller vers
  Excel, **lien de partage** qui restitue le tableau (la personne qui ouvre le
  lien doit disposer de la même base).
- **Cache local** : la dernière base chargée est mémorisée dans le navigateur
  (IndexedDB) et rechargée automatiquement à la prochaine visite (la démo,
  elle, n'est jamais mise en cache).

À l'ouverture d'une base, le **premier preset de période** du pack est
sélectionné par défaut (l'effectif de l'univers est affiché sous les options) ;
choisissez « Toute la période » pour l'ensemble de la base.

## Confidentialité

Ce dépôt ne contient **aucune donnée d'enquête** (seule une démo synthétique
est fournie). Les fichiers `.owx` restent chez vous : l'application les lit
localement (`FileReader`), ne fait aucune requête réseau avec vos données, et
le cache est propre à votre navigateur. Ne committez jamais un `.owx` réel
dans un dépôt public (le `.gitignore` les exclut par défaut).

## Format `.owx`

`gzip( "OWXPACK1" + uint32LE(taille du header) + header JSON + sections binaires )`

| Section | Contenu |
|---|---|
| poids | `Float64 × n` (poids de redressement, 1 par répondant) |
| bits | `Uint8 × n × bytesPerRow` — 1 bit par modalité et par base de bloc |
| numériques | `Float32 × n × numCount` — valeurs des mesures « moyenne » (NaN = hors base) |

Le header JSON décrit les variables :

```jsonc
{
  "format": "owx1", "title": "…", "subtitle": "…", "n": 123456,
  "months": ["2025-01", "…"], "monthsVarId": "L_MOIS",   // facultatif (période)
  "layout": { "nbits": 584, "bytesPerRow": 73, "numCount": 2 },
  "themes": ["…"],
  "vars": [{
    "id": "Q1", "code": "Q1. …", "label": "libellé long", "theme": "…",
    "display": "Q1. SAT GLOBALE",    // facultatif : libellé court affiché en tête de bloc
    "kind": "question|lecture", "type": "single|multi|numeric|nps",
    "baseBit": 17,                    // bit « dans la base » (null = tout le monde)
    "baseLabel": "Interrogés",        // facultatif : libellé de la ligne de base
    "mods": [{ "label": "…", "bit": 18, "indent": 1, "key": null }],
    "nps":  { "label": "NPS", "promoBit": 19, "neuBit": 20, "detBit": 21 },  // facultatif
    "mean": { "num": 0, "label": "Moyenne", "indent": 1 }                    // facultatif
  }],
  "counts": [/* effectif brut par bit (facultatif, informatif) */],
  "presets": [{ "label": "Année 2025", "months": ["2025-01", "…"] }],
  "defaults": { "maskThreshold": 60, "levels": [95, 99] }
}
```

Conventions :
- un bit de modalité n'est posé que si le répondant est dans la base du bloc
  (`baseBit`) ; les modalités peuvent se recouvrir (sous-totaux « ST ») ;
- les « % colonne » valent `Σw(modalité ∩ colonne) / Σw(base ∩ colonne)` ;
- **NPS** : la ligne NPS retrouve les promoteurs / détracteurs via les mods
  portant `key: "promo"` / `key: "det"` (à défaut, via `nps.promoBit` /
  `nps.detBit`) — posez au moins l'un des deux ;
- **période** : la variable `monthsVarId` doit avoir **exactement une modalité
  par élément de `months`, dans le même ordre** (pas de sous-total ni de
  modalité supplémentaire) — le filtre de période repose sur ces indices ;
- sections en **little-endian** ; tout est décompressé en mémoire (compter
  ~2× la taille décompressée au chargement — dimensionnez le pack en
  conséquence, quelques centaines de Mo décompressés maximum).

Pour générer un pack depuis vos données, écrivez un script qui pose ces bits et
appelle `OWX.buildSync(header, {weights, bits, nums})` (voir
[tools/gen_demo.js](tools/gen_demo.js) pour un exemple complet et minimal).

## Architecture

| Fichier | Rôle |
|---|---|
| `index.html` + `style.css` | interface (vanilla, sans dépendance réseau) |
| `js/owx.js` | lecture / écriture du format `.owx` (navigateur + Node) |
| `js/tabengine.js` | moteur : une passe d'accumulation, rendu, tests statistiques |
| `js/app.js` | UI : variables, chips, période, options, exports, cache |
| `vendor/exceljs.min.js` | export Excel (chargé à la demande) |
| `tools/gen_demo.js` | générateur du jeu de démonstration synthétique |

`js/owx.js` et `js/tabengine.js` s'utilisent aussi sous Node (tests, exports
batch) : `const OWX = require('./js/owx.js')`.

## Développement

Aucune étape de build. Pour servir en local : `npx serve .` (ou n'importe quel
serveur statique — nécessaire pour la démo, `fetch` étant bloqué en `file://`).
Régénérer la démo : `node tools/gen_demo.js`.
