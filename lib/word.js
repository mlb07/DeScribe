// Turns notes into a real Word file, adds notes to an existing one, and reads one back.
//
// A note looks like this:
//   { blocks: [ { kind: 'paragraph' | 'bullet' | 'numbered', level: 0, text: 'Some [[unsure]] words' } ] }
// [[Double brackets]] mark words the AI was unsure of. They are shown in yellow in the
// app only: the Word file always gets the plain words, with no highlighting.

import JSZip from 'jszip';
import { randomBytes } from 'node:crypto';
import { buildBody, describeParagraph, escapeXml, parseBody } from './docxbody.js';

const KINDS = new Set(['paragraph', 'bullet', 'numbered']);
const XML_START = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// Removes characters a Word file isn't allowed to contain.
function cleanText(value) {
  const safe = [...String(value ?? '').toWellFormed()]
    .map((char) => {
      const code = char.codePointAt(0);
      if (code === 9 || code === 10 || code === 13) return ' ';
      if (code < 32 || code === 0xfffe || code === 0xffff) return '';
      return char;
    })
    .join('');
  return safe.replace(/ {2,}/g, ' ').trim();
}

// Cleans one line of text typed on the phone the same way as text from the AI.
export const cleanLine = (value) => cleanText(value);

// "Some [[unsure]] words" becomes three pieces, with the middle one marked as a guess.
export function splitGuesses(text) {
  return String(text)
    .split(/\[\[(.*?)\]\]/s)
    .map((piece, index) => ({ text: piece.replace(/\[\[|\]\]/g, ''), guess: index % 2 === 1 }))
    .filter((piece) => piece.text !== '');
}

// Makes sure whatever came back from the AI is in exactly the expected shape.
export function tidyNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .map((note) => ({
      ...(cleanText(note?.heading) ? { heading: cleanText(note.heading).replace(/\[\[|\]\]/g, '') } : {}),
      blocks: (Array.isArray(note?.blocks) ? note.blocks : [])
        .map((block) => ({
          kind: KINDS.has(block?.kind) ? block.kind : 'paragraph',
          level: Math.min(2, Math.max(0, Math.trunc(Number(block?.level)) || 0)),
          text: cleanText(block?.text),
        }))
        .filter((block) => splitGuesses(block.text).some((piece) => piece.text.trim() !== '')),
    }))
    .filter((note) => note.blocks.length > 0);
}

// Each separate paper (sticky note, card, page) becomes bullet points:
//  - a paper of running words is one bullet ("paragraph" blocks before any list);
//  - if it starts with words and then lists things, the list becomes sub-bullets;
//  - a paper that is only a list (bullets, dashes, numbers) keeps every listed item as
//    its own bullet, with any indented sub-points kept as sub-bullets;
//  - in a printed section of a form, every line the person wrote is its own bullet
//    (each line on a form is a separate answer).
// Four sticky notes in a photo therefore give four bullets.
export function paperBullets(notes) {
  return tidyNotes(notes).map((note) => {
    const firstListItem = note.blocks.findIndex((block) => block.kind !== 'paragraph');
    const opening = firstListItem < 0 ? note.blocks : note.blocks.slice(0, firstListItem);
    const rest = firstListItem < 0 ? [] : note.blocks.slice(firstListItem);
    const words = opening.map((block) => block.text).join(' ');
    const heading = note.heading ? { heading: note.heading } : {};
    if (note.heading) {
      const top = Math.min(...note.blocks.map((block) => (block.kind === 'paragraph' ? 0 : block.level)));
      return {
        ...heading,
        blocks: note.blocks.map((block) => ({
          kind: block.kind === 'numbered' ? 'numbered' : 'bullet',
          level: block.kind === 'paragraph' ? 0 : Math.min(2, block.level - top),
          text: block.text,
        })),
      };
    }
    if (!words) {
      // Only a list: each item the writer listed is its own bullet (numbers stay numbers).
      const top = Math.min(...rest.map((block) => block.level));
      return {
        ...heading,
        blocks: rest.map((block) => ({
          kind: block.kind === 'numbered' ? 'numbered' : 'bullet',
          level: Math.min(2, block.level - top),
          text: block.text,
        })),
      };
    }
    const subBullets = rest.map((block) =>
      block.kind === 'paragraph'
        ? { kind: 'bullet', level: 1, text: block.text }
        : { kind: block.kind, level: Math.min(2, block.level + 1), text: block.text },
    );
    return { ...heading, blocks: [{ kind: 'bullet', level: 0, text: words }, ...subBullets] };
  });
}

// The words without the [[guess]] brackets, exactly as they go into Word.
export const plainText = (text) => splitGuesses(text).map((piece) => piece.text).join('');

function runsXml(text) {
  return `<w:r><w:t xml:space="preserve">${escapeXml(plainText(text))}</w:t></w:r>`;
}

function listLevel(index, format, label) {
  const left = 720 * (index + 1);
  return (
    `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
    `<w:lvlText w:val="${label}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`
  );
}

// One list "recipe" that every bullet shares, and a separate recipe for each
// numbered list so that every list starts again from 1.
// When adding to an existing Word file, the numbers start after the ones it already uses.
function createLists({ firstRecipeId = 0, firstNumId = 1 } = {}) {
  const recipe = (id, levels) =>
    `<w:abstractNum w:abstractNumId="${id}"><w:nsid w:val="${randomBytes(4).toString('hex').toUpperCase()}"/>` +
    `<w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;

  const bulletLevels = ['•', '–', '▪'].map((mark, i) => listLevel(i, 'bullet', mark)).join('');
  const numberLevels = [0, 1, 2].map((i) => listLevel(i, 'decimal', `%${i + 1}.`)).join('');

  const recipes = [];
  const uses = [];
  const add = (levels) => {
    const recipeId = firstRecipeId + recipes.length;
    const numId = firstNumId + uses.length;
    recipes.push(recipe(recipeId, levels));
    uses.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${recipeId}"/></w:num>`);
    return numId;
  };
  let bulletId = null;

  return {
    get bulletId() {
      bulletId ??= add(bulletLevels);
      return bulletId;
    },
    newNumberedList: () => add(numberLevels),
    useBulletList(numId) {
      bulletId = numId; // keep adding to the bullet list the file already has
    },
    recipesXml: () => recipes.join(''),
    usesXml: () => uses.join(''),
    xml: () => `${XML_START}<w:numbering ${W}>${recipes.join('')}${uses.join('')}</w:numbering>`,
  };
}

function paragraphXml(text, listId, level) {
  const list =
    listId == null
      ? ''
      : `<w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${listId}"/></w:numPr></w:pPr>`;
  return `<w:p>${list}${runsXml(text)}</w:p>`;
}

const CONTENT_TYPES =
  `${XML_START}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
  '</Types>';

const ROOT_LINKS =
  `${XML_START}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOCUMENT_LINKS =
  `${XML_START}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
  '</Relationships>';

const STYLES =
  `${XML_START}<w:styles ${W}><w:docDefaults>` +
  '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos" w:cs="Aptos"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>';

// Stops Word from opening the file in "Compatibility Mode".
const SETTINGS =
  `${XML_START}<w:settings ${W}><w:compat>` +
  '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>' +
  '</w:compat></w:settings>';

// The Word paragraphs for a set of notes, one after another (no blank lines between).
function notesToParagraphs(notes, lists) {
  const body = [];
  tidyNotes(notes).forEach((note) => {
    let numberedId = null;
    for (const block of note.blocks) {
      if (block.kind === 'numbered') {
        numberedId ??= lists.newNumberedList();
        body.push(paragraphXml(block.text, numberedId, block.level));
      } else if (block.kind === 'bullet') {
        if (block.level === 0) numberedId = null;
        body.push(paragraphXml(block.text, lists.bulletId, block.level));
      } else {
        numberedId = null;
        body.push(paragraphXml(block.text, null, 0));
      }
    }
  });
  return body;
}

export async function buildWordFile(notes) {
  if (tidyNotes(notes).some((note) => note.heading)) return (await placeNotes(await buildWordFile([]), notes)).buffer;
  const lists = createLists();
  const body = notesToParagraphs(notes, lists);
  if (body.length === 0) body.push('<w:p/>');

  const page =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_LINKS);
  zip.file('word/document.xml', `${XML_START}<w:document ${W}><w:body>${body.join('')}${page}</w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', DOCUMENT_LINKS);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/numbering.xml', lists.xml());
  zip.file('word/settings.xml', SETTINGS);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// --- Adding to a Word file that already exists ---------------------------------
// The file may have been edited in Word since DeScribe last touched it, so only the
// end of the document is changed and everything already in it is left exactly as it is.

const NUMBERING_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
const NUMBERING_LINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';

const highestId = (xml, pattern) => Math.max(0, ...[...xml.matchAll(pattern)].map((m) => Number(m[1])));

// A paragraph with no words and nothing else in it: an empty line.
const isEmptyLine = (item) => {
  if (item.name !== 'w:p') return false;
  const info = describeParagraph(item.xml);
  return !info.text && !info.hasObjects && !info.hasSectionBreak;
};

// Makes sure the file can hold DeScribe's lists, and returns the list maker to use.
async function prepareLists(zip) {
  const numberingPart = zip.file('word/numbering.xml');
  const numberingXml = numberingPart ? await numberingPart.async('string') : null;
  const lists = createLists({
    firstRecipeId: numberingXml ? highestId(numberingXml, /w:abstractNumId="(\d+)"/g) + 1 : 0,
    firstNumId: numberingXml ? highestId(numberingXml, /<w:num w:numId="(\d+)"/g) + 1 : 1,
  });
  lists.save = async () => {
    if (!lists.usesXml()) return;
    if (numberingXml) {
      // Word wants every list recipe before the lists that use them.
      let xml = numberingXml;
      const firstUse = xml.search(/<w:num[ >]/);
      const recipesAt = firstUse >= 0 ? firstUse : xml.lastIndexOf('</w:numbering>');
      xml = xml.slice(0, recipesAt) + lists.recipesXml() + xml.slice(recipesAt);
      const cleanup = xml.indexOf('<w:numIdMacAtCleanup');
      const usesAt = cleanup >= 0 ? cleanup : xml.lastIndexOf('</w:numbering>');
      xml = xml.slice(0, usesAt) + lists.usesXml() + xml.slice(usesAt);
      zip.file('word/numbering.xml', xml);
      return;
    }
    zip.file('word/numbering.xml', lists.xml());
    const types = await zip.file('[Content_Types].xml').async('string');
    if (!types.includes('/word/numbering.xml')) {
      zip.file(
        '[Content_Types].xml',
        types.replace('</Types>', `<Override PartName="/word/numbering.xml" ContentType="${NUMBERING_TYPE}"/></Types>`),
      );
    }
    const linksPart = zip.file('word/_rels/document.xml.rels');
    const links = linksPart
      ? await linksPart.async('string')
      : `${XML_START}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    if (!links.includes(NUMBERING_LINK)) {
      zip.file(
        'word/_rels/document.xml.rels',
        links.replace('</Relationships>', `<Relationship Id="rIdDeScribeLists" Type="${NUMBERING_LINK}" Target="numbering.xml"/></Relationships>`),
      );
    }
  };
  return lists;
}

// The bullet list a line joins when you add a bullet to it on the phone: the file's
// own bullet list if it has one, otherwise a new one.
export async function bulletListId(zip) {
  const part = zip.file('word/numbering.xml');
  if (part) {
    const kinds = listKinds(await part.async('string'));
    for (const [numId, formats] of [...kinds].reverse()) if (formats['0'] === 'bullet') return numId;
  }
  const lists = await prepareLists(zip);
  const numId = lists.bulletId;
  await lists.save();
  return String(numId);
}

// The list maker for adding to a file, reusing the bullet list the file already has.
async function listsFor(zip) {
  const lists = await prepareLists(zip);
  const numberingPart = zip.file('word/numbering.xml');
  if (numberingPart) {
    const kinds = listKinds(await numberingPart.async('string'));
    const existing = [...kinds].reverse().find(([, formats]) => formats['0'] === 'bullet');
    if (existing) lists.useBulletList(existing[0]);
  }
  return lists;
}

// --- Printed sections: notes go under their heading -------------------------------

// "OUR STRATEGY", "Our strategy:" and "our  strategy" all count as the same heading.
const headingKey = (text) => plainText(String(text)).replace(/[\s:：.-]+$/u, '').replace(/\s+/g, ' ').trim().toLowerCase();

const isListItem = (item) => {
  if (item.name !== 'w:p') return false;
  const info = describeParagraph(item.xml);
  return Boolean((info.numId && info.numId !== '0') || /list|bullet/i.test(info.style));
};

// A heading line in the document: a plain line (no bullet) with these words.
const isHeadingLine = (item, key) => item.name === 'w:p' && !isListItem(item) && headingKey(describeParagraph(item.xml).text) === key;

const headingXml = (text) => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(plainText(text))}</w:t></w:r></w:p>`;

// Adds notes to a Word file. Notes with a "heading" go at the end of that heading's
// section (the heading line and the bullets under it); if the document has no such
// heading yet, the heading is added as a bold line with the notes under it. Everything
// else (and new headings) goes right under line number "after", or at the end.
// Returns the new file, where each old line moved to ("indexMap"), the new lines and
// their words ("newLines"), and the last line added under "after" ("lastPara").
export async function placeNotes(buffer, notes, after = null) {
  const { zip, body } = await openWordFile(buffer);
  const lists = await listsFor(zip);
  let items = body.items.map((item, orig) => ({ ...item, orig }));
  const pickedLine = after !== null && after !== undefined ? items[after] : undefined;
  if (items.every(isEmptyLine)) items = []; // only empty lines so far: start at the top
  let pointer = pickedLine && items.includes(pickedLine) ? pickedLine : null;
  let lastAtPointer = null;

  // Consecutive notes with the same heading are placed together, in reading order.
  const groups = [];
  for (const note of tidyNotes(notes)) {
    const key = note.heading ? headingKey(note.heading) : '';
    const last = groups.at(-1);
    if (last && last.key === key) last.notes.push(note);
    else groups.push({ key, heading: note.heading || '', notes: [note] });
  }

  for (const group of groups) {
    const blocks = group.notes.flatMap((note) => note.blocks);
    const entries = notesToParagraphs(group.notes, lists).map((xml, k) => ({ name: 'w:p', xml, markup: blocks[k].text, isNew: true }));
    if (group.key) {
      const at = items.findIndex((item) => isHeadingLine(item, group.key));
      if (at >= 0) {
        let end = at + 1;
        while (end < items.length && isListItem(items[end])) end += 1;
        items.splice(end, 0, ...entries);
        continue;
      }
      entries.unshift({ name: 'w:p', xml: headingXml(group.heading), markup: plainText(group.heading), isNew: true });
    }
    const at = pointer ? items.indexOf(pointer) + 1 : items.length;
    items.splice(at, 0, ...entries);
    if (pointer) {
      pointer = entries.at(-1);
      lastAtPointer = pointer;
    }
  }

  const indexMap = body.items.map((_, orig) => items.findIndex((item) => item.orig === orig));
  const newLines = items.flatMap((item, para) => (item.isNew ? [{ para, markup: item.markup }] : []));
  body.items = items.map(({ name, xml }) => ({ name, xml }));
  if (newLines.length) await lists.save();
  const updated = newLines.length ? await saveWordFile(zip, body) : buffer;
  return { buffer: updated, indexMap, newLines, lastPara: lastAtPointer ? items.indexOf(lastAtPointer) : null };
}

export async function openWordFile(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentPart = zip.file('word/document.xml');
  if (!documentPart) throw new Error('This is not a Word document.');
  return { zip, body: parseBody(await documentPart.async('string')) };
}

export async function saveWordFile(zip, body) {
  if (!body.items.some((item) => item.name === 'w:p')) body.items.push({ name: 'w:p', xml: '<w:p/>' }); // Word needs one line
  zip.file('word/document.xml', buildBody(body));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function appendToWordFile(buffer, notes) {
  return (await addToWordFile(buffer, notes)).buffer;
}

// Adds notes at the end of a Word file, or right under line number "after".
// Also says where they went ("start", "count") and where every old line moved to
// ("indexMap": old line number -> new line number, -1 for removed empty lines).
export async function addToWordFile(buffer, notes, after = null) {
  const { zip, body } = await openWordFile(buffer);
  const lists = await listsFor(zip);
  const paragraphs = notesToParagraphs(notes, lists).map((xml) => ({ name: 'w:p', xml }));
  const unchanged = body.items.map((_, i) => i);
  if (paragraphs.length === 0) return { buffer, start: null, count: 0, indexMap: unchanged };

  let start;
  let indexMap;
  if (after !== null && after !== undefined && after >= 0 && after < body.items.length) {
    start = after + 1;
    body.items.splice(start, 0, ...paragraphs);
    indexMap = unchanged.map((i) => (i < start ? i : i + paragraphs.length));
  } else if (body.items.every(isEmptyLine)) {
    indexMap = unchanged.map(() => -1); // only empty lines so far: start at the top
    body.items = [...paragraphs];
    start = 0;
  } else {
    indexMap = unchanged;
    start = body.items.length;
    body.items.push(...paragraphs);
  }
  await lists.save();
  return { buffer: await saveWordFile(zip, body), start, count: paragraphs.length, indexMap };
}

// --- Reading a Word file back, for the screen on the phone ------------------------

function listKinds(numberingXml) {
  const recipeFormats = new Map();
  for (const [, id, inner] of numberingXml.matchAll(/<w:abstractNum [^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const formats = {};
    for (const [, level, format] of inner.matchAll(/<w:lvl [^>]*w:ilvl="(\d+)"[^>]*>[\s\S]*?<w:numFmt w:val="([^"]+)"/g)) formats[level] = format;
    recipeFormats.set(id, formats);
  }
  const kinds = new Map();
  for (const [, numId, recipeId] of numberingXml.matchAll(/<w:num [^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"/g)) {
    kinds.set(numId, recipeFormats.get(recipeId) || {});
  }
  return kinds;
}

// A plain line that is all bold (or uses a Word heading style) is shown as a heading.
function isBoldLine(paragraphXml, style) {
  if (/heading|title/i.test(style)) return true;
  const runs = [...paragraphXml.matchAll(/<w:r[\s>][\s\S]*?<\/w:r>/g)].map((m) => m[0]).filter((run) => /<w:t[\s>]/.test(run));
  return runs.length > 0 && runs.every((run) => /<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(run));
}

// Every top-level line of the document, numbered by its place in the body ("para").
// Tables are skipped (they are left alone). Lines holding a picture, or a section
// break, are "locked": shown on the phone but never changed by DeScribe.
export async function readParagraphs(buffer) {
  const { zip, body } = await openWordFile(buffer);
  const numberingPart = zip.file('word/numbering.xml');
  const kinds = numberingPart ? listKinds(await numberingPart.async('string')) : new Map();
  const lines = [];
  body.items.forEach((item, para) => {
    if (item.name !== 'w:p') return;
    const info = describeParagraph(item.xml);
    let kind = 'paragraph';
    if (info.numId && info.numId !== '0') kind = (kinds.get(info.numId)?.[info.level] || 'bullet') === 'bullet' ? 'bullet' : 'numbered';
    else if (/bullet/i.test(info.style)) kind = 'bullet';
    else if (/list\s*number/i.test(info.style)) kind = 'numbered';
    const blank = !info.text && !info.hasObjects;
    lines.push({
      para,
      words: info.text, // exactly what Word holds ("" for a picture)
      ...(kind === 'paragraph' && info.text && isBoldLine(item.xml, info.style) ? { heading: true } : {}),
      kind,
      level: kind === 'paragraph' ? 0 : info.level,
      text: info.text || (info.hasObjects ? '(picture)' : ''),
      blank,
      locked: info.hasObjects || info.hasSectionBreak,
    });
  });
  return lines;
}

// Groups lines into cards: every top-level line (a paper's bullet, or a plain line)
// starts a new card, and its sub-bullets belong to it. An empty line also ends a card.
export function linesToNotes(lines) {
  const notes = [];
  let current = null;
  for (const line of lines) {
    if (line.blank) {
      current = null;
      continue;
    }
    if (!current || line.level === 0) {
      current = { blocks: [] };
      notes.push(current);
    }
    const { blank, words, ...block } = line;
    current.blocks.push(block);
  }
  return notes;
}

// The notes in a Word file, as plain text (no line numbers).
export async function readWordFile(buffer) {
  return linesToNotes(await readParagraphs(buffer)).map((note) => ({
    blocks: note.blocks.map(({ kind, level, text }) => ({ kind, level, text })),
  }));
}
