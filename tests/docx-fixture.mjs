// Builds a tiny .docx (a zip holding only word/document.xml) in the paragraph / line-break shapes of the real SMP.
// Shared by library.test.mjs and run.mjs. Nothing here touches the disk.
import { deflateRawSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(files, deflate) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
export const P = (...runs) => `<w:p><w:r>${runs.map((r) => (r === '\n' ? '<w:br/>' : `<w:t xml:space="preserve">${r.replace(/&/g, '&amp;')}</w:t>`)).join('')}</w:r></w:p>`;
export const docXml = (paras) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:tbl><w:tr><w:tc>${paras.join('')}</w:tc></w:tr></w:tbl></w:body></w:document>`;

// Same quirks as the real document: glued text, a name and its SKU in separate paragraphs, two products in one
// paragraph, a price on the next paragraph, a repeated product in a second section, and a wrong declared count.
export const SMP_PARAS = [
  P('Spring \u{1F338} SMP - 2026'),
  P('Please look at both lists'),
  P('VIP Launching: May 3-8, 2026'), P('Offer: 40% off sitewide'), P('Code: VIP40'),
  P('Highlighted Products (Spring Theme)'),
  P('Acme Black Seed OilSKU:  ACM100101Original Price -$19.97 Discount  Price - $11.99 ', '\n'),
  P('Acme Charcoal SKU: ACM200101 Original Price -$15.97 Discount Price - $9.59'),
  P('Best Sellers (Spring Theme)'),
  P('Acme Black Seed OilSKU: ACM100101 Original Price - $19.97 Discount Price - $11.99'),
  P('Product CTA (3 Products)(Spring Theme)'),
  P('Acme Ursolic Acid SKU: ACM300101 Original Price - $19.97 Discount Price - $11.99', 'Acme ZMA Capsules SKU: ACM400101 Original Price - $27.97 Discount Price - $16.79'),
  P('Acme Pre-X Workout Powder'),
  P('SKU: ACM500107Original Price - $41.97Discount Price - $25.19'),
  P('Acme Testosterone SKU: ACM600101Original Price - $16.97'),
  P('Discount Price -$10.19'),
  P('Creative'), P('Creative Brief', 'Trello Request'),
];

