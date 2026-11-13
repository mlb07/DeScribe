// Reads and changes the lines (paragraphs) of a Word document, one by one, while
// leaving everything else in the file exactly as Word wrote it.
//
// A Word document's text lives in word/document.xml, inside <w:body>. The body is a
// list of top-level pieces: paragraphs (<w:p>), tables (<w:tbl>), and a few others,
// ending with the page settings (<w:sectPr>). Each top-level piece gets a number
// ("para"), which is how the phone says which line it changed.

// Matches one XML tag. Attribute values may contain ">" inside quotes.
const TAG = /<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

// Splits a run of XML into its top-level elements. Text between elements (only
// whitespace in a real Word file) is dropped.
function topLevelElements(xml, from = 0, to = xml.length) {
  const elements = [];
  let depth = 0;
  let start = 0;
  let name = '';
  TAG.lastIndex = from;
  for (let match = TAG.exec(xml); match && match.index < to; match = TAG.exec(xml)) {
    const [whole, closing, tagName, , selfClosing] = match;
    if (depth === 0) {
      if (closing) throw new Error('The Word file is damaged (an unexpected closing tag).');
      if (selfClosing) {
        elements.push({ name: tagName, xml: whole });
      } else {
        depth = 1;
        start = match.index;
        name = tagName;
      }
    } else if (closing) {
      depth -= 1;
      if (depth === 0) elements.push({ name, xml: xml.slice(start, match.index + whole.length) });
    } else if (!selfClosing) {
      depth += 1;
    }
  }
  if (depth !== 0) throw new Error('The Word file is damaged (an element is not closed).');
  return elements;
}

export function parseBody(documentXml) {
  const open = documentXml.search(/<w:body[\s>]/);
  const close = documentXml.lastIndexOf('</w:body>');
  if (open < 0 || close < 0) throw new Error('This Word file has no body.');
  const bodyStart = documentXml.indexOf('>', open) + 1;
  const items = topLevelElements(documentXml, bodyStart, close);
  // The page settings at the very end belong to the whole document, not to a line.
  const sectPr = items.length && items.at(-1).name === 'w:sectPr' ? items.pop().xml : '';
  return { head: documentXml.slice(0, bodyStart), items, sectPr, tail: documentXml.slice(close) };
}

export function buildBody({ head, items, sectPr, tail }) {
  return head + items.map((item) => item.xml).join('') + sectPr + tail;
}

// --- One paragraph ---------------------------------------------------------------

export function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// The opening tag and the children of a paragraph.
function splitParagraph(paragraphXml) {
  const openEnd = paragraphXml.indexOf('>') + 1;
  const openTag = paragraphXml.slice(0, openEnd);
  if (openTag.endsWith('/>')) return { openTag: `${openTag.slice(0, -2).trimEnd()}>`, children: [] };
  const closeStart = paragraphXml.lastIndexOf('</w:p>');
  return { openTag, children: topLevelElements(paragraphXml, openEnd, closeStart) };
}

// Pictures, charts, shapes, embedded objects and text boxes.
const OBJECTS = /<(w:drawing|w:pict|w:object|mc:AlternateContent)[\s>]/;

// Drops pictures and text boxes, whose own paragraphs are not part of this line.
function withoutObjects(xml) {
  return xml
    .replace(/<mc:AlternateContent[\s>][\s\S]*?<\/mc:AlternateContent>/g, '')
    .replace(/<w:drawing[\s>][\s\S]*?<\/w:drawing>/g, '')
    .replace(/<w:pict[\s>][\s\S]*?<\/w:pict>/g, '')
    .replace(/<w:object[\s>][\s\S]*?<\/w:object>/g, '')
    .replace(/<w:txbxContent[\s>][\s\S]*?<\/w:txbxContent>/g, '');
}

// The words of a paragraph, as one line of plain text. Deleted text (tracked changes)
// is left out, because Word keeps it in <w:delText>, not <w:t>.
export function paragraphText(paragraphXml) {
  const xml = withoutObjects(paragraphXml).replace(/<w:pPr[\s>][\s\S]*?<\/w:pPr>/, '');
  let text = '';
  for (const [, tag, inner] of xml.matchAll(/<w:(t|tab|br|cr|noBreakHyphen|softHyphen)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:t>)/g)) {
    if (tag === 't') text += unescapeXml(inner ?? '');
    else if (tag === 'noBreakHyphen') text += '-';
    else if (tag !== 'softHyphen') text += ' ';
  }
  return text.replace(/\s+/g, ' ').trim();
}

const paragraphProperties = (paragraphXml) => splitParagraph(paragraphXml).children.find((c) => c.name === 'w:pPr')?.xml || '';

export function describeParagraph(paragraphXml) {
  const properties = paragraphProperties(paragraphXml);
  return {
    text: paragraphText(paragraphXml),
    hasObjects: OBJECTS.test(paragraphXml),
    // A section break (for example a switch to landscape pages) lives inside a paragraph.
    hasSectionBreak: /<w:sectPr[\s>/]/.test(properties),
    numId: properties.match(/<w:numId w:val="(\d+)"/)?.[1] || null,
    level: Math.min(2, Number(properties.match(/<w:ilvl w:val="(\d+)"/)?.[1] || 0)),
    style: properties.match(/<w:pStyle w:val="([^"]+)"/)?.[1] || '',
  };
}

// The look of the first piece of text in the paragraph (font, bold, size...), without
// any highlighting, so retyped text looks like what was there.
function firstRunLook(children) {
  for (const child of children) {
    const runs = child.name === 'w:r' ? [child.xml] : [...child.xml.matchAll(/<w:r[\s>][\s\S]*?<\/w:r>/g)].map((m) => m[0]);
    for (const run of runs) {
      if (!/<w:t[\s>]/.test(run)) continue;
      const look = run.match(/^<w:r[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>|<w:rPr\/>)/)?.[1] || '';
      return look.replace(/<w:highlight [^>]*\/>/g, '').replace(/<w:shd [^>]*\/>/g, '').replace(/<w:rPr>\s*<\/w:rPr>/, '');
    }
  }
  return '';
}

const textRun = (look, text) => `<w:r>${look}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;

// Zero-width markers that must stay in pairs (bookmarks, comment ranges, permissions).
const isRangeStart = (name) => /^w:(bookmarkStart|commentRangeStart|permStart|moveFromRangeStart|moveToRangeStart)$/.test(name);
const isRangeEnd = (name) => /^w:(bookmarkEnd|commentRangeEnd|permEnd|moveFromRangeEnd|moveToRangeEnd)$/.test(name);

// Runs that point at something stored elsewhere in the file (a comment, a footnote).
// Removing them would leave that thing orphaned, so they are kept after the new text.
function referenceRuns(children) {
  const kept = [];
  for (const child of children) {
    for (const [run] of child.xml.matchAll(/<w:r[\s>][\s\S]*?<\/w:r>/g)) {
      if (/<w:(commentReference|footnoteReference|endnoteReference)[\s/]/.test(run)) {
        kept.push(run.replace(/<w:t[\s>][\s\S]*?<\/w:t>/g, ''));
      }
    }
  }
  return kept;
}

// The same paragraph (same list position, same style, same look) with new words.
export function replaceParagraphText(paragraphXml, text) {
  const { openTag, children } = splitParagraph(paragraphXml);
  const properties = children.filter((c) => c.name === 'w:pPr').map((c) => c.xml);
  const starts = children.filter((c) => isRangeStart(c.name)).map((c) => c.xml);
  const ends = children.filter((c) => isRangeEnd(c.name)).map((c) => c.xml);
  const run = text ? textRun(firstRunLook(children), text) : '';
  return `${openTag}${properties.join('')}${starts.join('')}${run}${referenceRuns(children).join('')}${ends.join('')}</w:p>`;
}

// A new paragraph formatted like an existing one (same list, level and look), for
// when a line is split in two. It must not copy a section break or Word's paragraph ids.
export function paragraphLike(paragraphXml, text) {
  const { children } = splitParagraph(paragraphXml);
  const properties = (children.find((c) => c.name === 'w:pPr')?.xml || '')
    .replace(/<w:sectPr[\s>][\s\S]*?<\/w:sectPr>/g, '')
    .replace(/<w:sectPr\/>/g, '')
    .replace(/<w:pPrChange[\s>][\s\S]*?<\/w:pPrChange>/g, '');
  const run = text ? textRun(firstRunLook(children), text) : '';
  return `<w:p>${properties}${run}</w:p>`;
}

// Children of <w:pPr> that Word expects before the list setting (<w:numPr>).
const BEFORE_LIST_SETTING = new Set(['w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl']);

// Makes a paragraph a bullet (numId = the bullet list to join, at a level 0-2), or a
// plain line (numId = null). Everything else about the paragraph stays the same.
export function setParagraphList(paragraphXml, numId, level = 0) {
  const { openTag, children } = splitParagraph(paragraphXml);
  const properties = children.find((c) => c.name === 'w:pPr')?.xml || '';
  const selfClosing = !properties || properties.endsWith('/>');
  const propertiesOpen = selfClosing ? '<w:pPr>' : properties.slice(0, properties.indexOf('>') + 1);
  let parts = selfClosing ? [] : topLevelElements(properties, properties.indexOf('>') + 1, properties.lastIndexOf('</w:pPr>'));

  // The old list setting, and an indent that only made sense with it, go.
  parts = parts.filter((part) => part.name !== 'w:numPr' && part.name !== 'w:ind');
  if (numId === null) {
    parts = parts.filter((part) => !(part.name === 'w:pStyle' && /list|bullet/i.test(part.xml)));
  } else {
    let at = 0;
    parts.forEach((part, i) => {
      if (BEFORE_LIST_SETTING.has(part.name)) at = i + 1;
    });
    parts.splice(at, 0, { name: 'w:numPr', xml: `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>` });
  }
  const newProperties = parts.length ? `${propertiesOpen}${parts.map((part) => part.xml).join('')}</w:pPr>` : '';
  const rest = children.filter((c) => c.name !== 'w:pPr').map((c) => c.xml).join('');
  return `${openTag}${newProperties}${rest}</w:p>`;
}
