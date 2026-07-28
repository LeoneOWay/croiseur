/* owx.js — lecture/écriture du format de pack « .owx » (croiseur OW).
 *
 * Un pack .owx = gzip( "OWXPACK1" + uint32LE(lenHeader) + headerJSON + sections ) :
 *   - section 1 : poids        Float64 × n
 *   - section 2 : matrice bits Uint8   × n × layout.bytesPerRow (1 bit / modalité)
 *   - section 3 : numériques   Float32 × n × layout.numCount    (mesures « moyenne »)
 * Le header JSON décrit les variables : { vars:[{id,code,label,theme,kind,type,
 * baseBit,mods:[{label,bit,indent,key}],nps:{promoBit,neuBit,detBit},mean:{num}}],
 * months, counts, presets, defaults, n, layout }.
 *
 * Fonctionne dans le navigateur (DecompressionStream) et sous Node (zlib).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OWX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAGIC = 'OWXPACK1';
  const IS_NODE = typeof process !== 'undefined' && process.versions && process.versions.node;

  function isGzip(u8) { return u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b; }

  async function gunzip(u8) {
    if (IS_NODE) {
      const zlib = require('zlib');
      return new Uint8Array(zlib.gunzipSync(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)));
    }
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function parseBuffer(u8) {
    // copie indépendante et alignée d'une section (les .slice de Buffer Node
    // sont des VUES partagées : il faut recopier pour garantir offset 0)
    const copy = (start, end) => { const s = u8.subarray(start, end); const out = new Uint8Array(s.length); out.set(s); return out; };
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('Plateforme big-endian non supportée (format .owx little-endian)');
    if (u8.length < 12) throw new Error('Fichier .owx invalide (trop court)');
    let magic = '';
    for (let i = 0; i < 8; i++) magic += String.fromCharCode(u8[i]);
    if (magic !== MAGIC) throw new Error('Fichier .owx invalide (signature absente)');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const hlen = dv.getUint32(8, true);
    if (12 + hlen > u8.length) throw new Error('Fichier .owx tronqué (en-tête incomplet)');
    let header;
    try { header = JSON.parse(new TextDecoder('utf-8').decode(u8.subarray(12, 12 + hlen))); }
    catch (e) { throw new Error('En-tête .owx illisible : ' + e.message); }
    if (header.format !== 'owx1' || !Number.isInteger(header.n) || header.n < 0 || !header.layout || !(header.layout.bytesPerRow >= 1) || !Array.isArray(header.vars)) {
      throw new Error('En-tête .owx incomplet (format/n/layout/vars)');
    }
    const n = header.n, L = header.layout;
    let off = 12 + hlen;
    const need = n * 8 + n * L.bytesPerRow + n * 4 * (L.numCount || 0);
    if (u8.length - off < need) throw new Error('Fichier .owx tronqué (' + (u8.length - off) + ' octets de données, ' + need + ' attendus)');
    const wBytes = copy(off, off + n * 8); off += n * 8;
    const bits = copy(off, off + n * L.bytesPerRow); off += n * L.bytesPerRow;
    let nums = new Float32Array(0);
    if (L.numCount) { const xb = copy(off, off + n * 4 * L.numCount); nums = new Float32Array(xb.buffer, 0, n * L.numCount); }
    return { header, weights: new Float64Array(wBytes.buffer, 0, n), bits, nums };
  }

  /** Charge un pack depuis un ArrayBuffer / Uint8Array (gzippé ou non). */
  async function load(data) {
    let u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (isGzip(u8)) u8 = await gunzip(u8);
    return parseBuffer(u8);
  }

  /** (Node uniquement) Assemble un pack gzippé depuis header + sections. */
  function buildSync(headerObj, sections) {
    if (!IS_NODE) throw new Error('buildSync : Node uniquement');
    const zlib = require('zlib');
    const headerBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
    const pre = Buffer.alloc(12);
    pre.write(MAGIC, 0, 'ascii');
    pre.writeUInt32LE(headerBuf.length, 8);
    const parts = [pre, headerBuf,
      Buffer.from(sections.weights.buffer, sections.weights.byteOffset, sections.weights.byteLength),
      Buffer.from(sections.bits.buffer, sections.bits.byteOffset, sections.bits.byteLength)];
    if (sections.nums && sections.nums.length) parts.push(Buffer.from(sections.nums.buffer, sections.nums.byteOffset, sections.nums.byteLength));
    return zlib.gzipSync(Buffer.concat(parts), { level: 6 });
  }

  return { load, parseBuffer, buildSync, MAGIC };
});
