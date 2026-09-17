// Reading a .docx without a library.
//
// A .docx is a zip holding word/document.xml. Browsers can inflate raw deflate
// streams through DecompressionStream, so the whole job is walking the zip's
// central directory by hand and stripping the XML. That keeps the single-file
// build dependency-free and working offline, which pulling in a parser would
// not.
//
// Handles the two storage methods Word actually writes: deflate and stored.
// Anything else — encrypted, zip64, .doc, .pages — reports itself rather than
// returning nonsense.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(view) {
  // The record is at the end, after a comment of up to 65535 bytes.
  const earliest = Math.max(0, view.byteLength - 65557);
  for (let i = view.byteLength - 22; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** Locates one file in the zip and returns its raw bytes plus how it is stored. */
function locateEntry(buffer, wantedName) {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw fail('That file is not a zip archive, so it is not a .docx either.');

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));

    if (name === wantedName) {
      if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
        throw fail('That .docx looks damaged: its internal index does not line up.');
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      return { bytes: new Uint8Array(buffer, dataStart, compressedSize), method };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw fail('This browser cannot unzip files. Copy the text out of the guide and paste it instead.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const XML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

/** Turns WordprocessingML into plain text, keeping paragraph and list breaks. */
export function documentXmlToText(xml) {
  let out = xml
    // Drop anything that is not body text: tracked deletions, field
    // instructions, footnote and comment bodies.
    .replace(/<w:delText[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
    // Structure worth keeping.
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t');

  // Only the runs of literal text survive.
  const pieces = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|\n|\t/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    pieces.push(m[1] !== undefined ? m[1] : m[0]);
  }

  return pieces
    .join('')
    .replace(/&#(\d+);/g, (whole, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (whole, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity])
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts the text of a .docx.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
export async function extractDocxText(buffer) {
  const entry = locateEntry(buffer, 'word/document.xml');
  if (!entry) {
    throw fail('No document text found inside that file. If it is a .doc or .pages file, save it as .docx first.');
  }

  let xmlBytes;
  if (entry.method === 0) {
    xmlBytes = entry.bytes;            // stored, no compression
  } else if (entry.method === 8) {
    xmlBytes = await inflateRaw(entry.bytes); // deflate, what Word writes
  } else {
    throw fail(`That .docx uses an unsupported compression method (${entry.method}).`);
  }

  const text = documentXmlToText(new TextDecoder().decode(xmlBytes));
  if (!text) throw fail('That .docx appears to contain no text.');
  return text;
}

function fail(message) {
  const error = new Error(message);
  error.code = 'DOCX';
  return error;
}
