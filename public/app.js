// Everything that happens on the phone.

const $ = (id) => document.getElementById(id);

// --- Remembering things on this phone ----------------------------------------

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing: the app still works, it just won't remember.
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

// --- Talking to the Mac -------------------------------------------------------

let passcode = recall('passcode');
// A name for this screen, so it can tell its own changes from other screens' changes.
const clientId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

class CallProblem extends Error {
  constructor(message, { status = 0, retryable = false, code = '' } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

async function callMac(path, { method = 'GET', body, type, extraHeaders = {} } = {}) {
  const headers = { 'X-App': 'photo-to-word', 'X-Passcode': passcode, 'X-Client': clientId, ...extraHeaders };
  if (type) headers['Content-Type'] = type;
  let response;
  try {
    response = await fetch(path, { method, headers, body });
  } catch {
    throw new CallProblem('No connection to your Mac.', { retryable: true });
  }
  if (response.ok) return response;
  let details = {};
  try {
    details = (await response.json()).error || {};
  } catch {
    // Not a message from the app; fall through to the general wording.
  }
  throw new CallProblem(details.message || 'Something went wrong.', {
    status: response.status,
    retryable: Boolean(details.retryable),
    code: details.code || '',
  });
}

const callJson = async (path, options) => (await callMac(path, options)).json();

// --- Messages at the top of the screen -----------------------------------------

function showWaiting(message) {
  $('waiting-banner').textContent = message;
  $('waiting-banner').hidden = false;
}

const hideWaiting = () => {
  $('waiting-banner').hidden = true;
};

let noticeTimer = null;
function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    $('notice').hidden = true;
  }, 30000);
}

// Tapping the message closes it.
$('notice').addEventListener('click', () => {
  $('notice').hidden = true;
});

// --- Shrinking a photo so it sends quickly ------------------------------------

const MAX_EDGE = 2576;
const MAX_PIXELS = 3_686_400;

function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const address = URL.createObjectURL(file);
    const picture = new Image();
    const finish = (action, value) => {
      URL.revokeObjectURL(address);
      action(value);
    };
    picture.onerror = () => finish(reject, new Error('This photo could not be opened.'));
    picture.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = picture;
      const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#ffffff';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.drawImage(picture, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          canvas.width = canvas.height = 0; // free the memory; phones are strict about it
          if (blob) finish(resolve, blob);
          else finish(reject, new Error('This photo could not be prepared.'));
        },
        'image/jpeg',
        0.86,
      );
    };
    picture.src = address;
  });
}

// A random label for each photo, so it can never be added twice.
function newPhotoId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// --- Lines of text: words, with some marked as guesses -------------------------
// A line is a list of pieces: { text, guess }. On the Mac it is written as markup,
// with guesses in [[double brackets]]; on screen guesses are yellow <mark>s.

function piecesOf(markup) {
  return String(markup)
    .split(/\[\[(.*?)\]\]/s)
    .map((piece, index) => ({ text: piece.replace(/\[\[|\]\]/g, ''), guess: index % 2 === 1 }))
    .filter((piece) => piece.text !== '');
}

function joinPieces(pieces) {
  const joined = [];
  for (const piece of pieces) {
    if (!piece.text) continue;
    const last = joined.at(-1);
    if (last && last.guess === piece.guess) last.text += piece.text;
    else joined.push({ ...piece });
  }
  return joined;
}

const markupOf = (pieces) => pieces.map((p) => (p.guess ? `[[${p.text}]]` : p.text)).join('');
const plainOf = (pieces) => pieces.map((p) => p.text).join('');
const tidy = (text) => text.replace(/\s+/g, ' ').trim();

// What a line on screen says now. Anything the phone's keyboard added (line breaks,
// formatting) is read as plain words.
function readLine(line) {
  const pieces = [];
  const walk = (node, guess) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) pieces.push({ text: child.data.replace(/ /g, ' '), guess });
      else if (child.nodeName === 'MARK') walk(child, true);
      else if (child.nodeName !== 'BR') walk(child, guess);
    }
  };
  walk(line, false);
  return joinPieces(pieces);
}

function fillLine(line, pieces) {
  line.replaceChildren(
    ...joinPieces(pieces).map((piece) => {
      if (!piece.guess) return document.createTextNode(piece.text);
      const mark = document.createElement('mark');
      mark.textContent = piece.text;
      mark.dataset.original = piece.text;
      return mark;
    }),
  );
}

// Splits a line's pieces at a position in its words.
function cutPieces(pieces, at) {
  const left = [];
  const right = [];
  let seen = 0;
  for (const piece of pieces) {
    const end = seen + piece.text.length;
    if (end <= at) left.push(piece);
    else if (seen >= at) right.push(piece);
    else {
      left.push({ text: piece.text.slice(0, at - seen), guess: piece.guess });
      right.push({ text: piece.text.slice(at - seen), guess: piece.guess });
    }
    seen = end;
  }
  return [left, right];
}

// --- Where the typing cursor is ------------------------------------------------

function caretOffset(line) {
  const selection = getSelection();
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!line.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(line);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function placeCaret(line, offset) {
  if (document.activeElement !== line) line.focus({ preventScroll: true });
  const range = document.createRange();
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let left = offset;
  let placed = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (left <= node.data.length) {
      range.setStart(node, left);
      placed = true;
      break;
    }
    left -= node.data.length;
  }
  if (!placed) range.selectNodeContents(line);
  range.collapse(!placed);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Rebuilds a line from its pieces without moving the cursor.
function refillKeepingCaret(line, pieces) {
  const offset = caretOffset(line);
  fillLine(line, pieces);
  if (offset !== null) placeCaret(line, offset);
}

// --- Showing the document -----------------------------------------------------

let documents = [];
let current = null;
let needsRender = false;
const paper = $('paper');
const BULLETS = ['•', '–', '▪'];

// Keeps the newest copy of the document (answers from the Mac can arrive out of order).
function adopt(doc) {
  if (!current || doc.id !== current.id || (doc.version || 0) >= (current.version || 0)) current = doc;
}

function makeRow({ kind, level, para, expect, locked, heading }, pieces, editable) {
  const row = document.createElement('div');
  row.className = `row ${kind}${heading ? ' heading' : ''}`;
  row.dataset.kind = kind;
  row.dataset.level = String(level);
  row.style.marginLeft = kind === 'paragraph' ? '' : `${12 + level * 20}px`;
  const mark = document.createElement('span');
  mark.className = 'mark';
  if (editable && !locked) {
    mark.classList.add('toggle');
    mark.setAttribute('role', 'button');
    mark.tabIndex = -1;
  }
  row.append(mark);
  const line = document.createElement('div');
  line.className = 'line';
  if (para !== undefined && para !== null) {
    line.dataset.para = String(para);
    line.dataset.expect = expect;
  }
  if (editable && !locked) {
    line.contentEditable = 'true';
    line.setAttribute('role', 'textbox');
    line.setAttribute('aria-label', 'Line of text');
    line.spellcheck = true;
  } else if (locked) {
    line.classList.add('locked');
  }
  fillLine(line, pieces);
  row.append(line);
  return row;
}

// Numbers and bullet marks for the rows of one card.
function renumber(section) {
  let counts = [0, 0, 0];
  for (const row of section.querySelectorAll('.row')) {
    const kind = row.dataset.kind;
    const level = Number(row.dataset.level) || 0;
    const mark = row.querySelector('.mark');
    mark.setAttribute('aria-label', kind === 'paragraph' ? 'Add a bullet to this line' : 'Remove the bullet from this line');
    if (kind === 'paragraph') {
      counts = [0, 0, 0];
      mark.textContent = mark.classList.contains('toggle') ? '○' : ''; // a faint dot to tap to add a bullet
      continue;
    }
    if (kind === 'numbered') {
      counts[level] += 1;
      counts.fill(0, level + 1);
      mark.textContent = `${counts[level]}.`;
    } else {
      if (level === 0) counts = [0, 0, 0];
      mark.textContent = BULLETS[level];
    }
  }
}

function showDocument(force = false) {
  if (!force && !settled()) {
    needsRender = true;
    return;
  }
  needsRender = false;
  paper.replaceChildren();
  if (!current || current.notes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing here yet. Tap Snap to add your first photo.';
    paper.append(empty);
    return;
  }
  for (const note of current.notes) {
    const section = document.createElement('section');
    section.className = 'note';
    if (current.editable && !note.blocks.some((block) => block.locked)) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'delete-note';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', 'Delete this card from the document');
      section.append(remove);
    }
    for (const block of note.blocks) {
      const pieces = piecesOf(block.text);
      section.append(makeRow({ ...block, expect: plainOf(pieces) }, pieces, current.editable));
    }
    renumber(section);
    paper.append(section);
  }
  showPicked();
}

// --- Picking a line, so new photos go in under it -------------------------------
// Tapping a line picks it (it stays marked after Done). Photos snapped while a line is
// picked go directly under it, and each next photo goes right after the last one,
// until the pick is cleared with the ✕ on the bar.

let picked = null; // { para, expect }: shared with the photos snapped under it

const plainText = (markup) => tidy(plainOf(piecesOf(markup)));

function pickLine(line) {
  if (line.dataset.para === undefined) return; // a brand-new line isn't in Word yet
  picked = { key: newPhotoId(), para: Number(line.dataset.para), expect: line.dataset.expect };
  showPicked();
}

function clearPick() {
  picked = null;
  showPicked();
}

function showPicked() {
  for (const row of paper.querySelectorAll('.row.picked')) row.classList.remove('picked');
  if (!picked) {
    $('picked-bar').hidden = true;
    return;
  }
  const line = paper.querySelector(`.line[data-para="${picked.para}"]`);
  line?.closest('.row').classList.add('picked');
  const words = picked.expect.length > 60 ? `${picked.expect.slice(0, 57)}…` : picked.expect;
  $('picked-text').textContent = `New photos go under: “${words}”`;
  $('picked-bar').hidden = false;
}

// Line numbers move when lines are added or removed above; keep every pick pointing at its line.
function movePicks(indexMap) {
  const anchors = new Set([picked, ...photoLine.map((item) => item.under)].filter(Boolean));
  for (const anchor of anchors) {
    const moved = indexMap[anchor.para];
    if (moved === undefined) continue;
    if (moved < 0) {
      if (anchor === picked) picked = null; // the picked line was deleted
      anchor.para = -1;
    } else {
      anchor.para = moved;
    }
  }
  saveAnchors();
}

// After the Mac sends the latest document, re-read the words of each picked line.
function refreshPicks() {
  const blocks = current ? current.notes.flatMap((note) => note.blocks) : [];
  const anchors = new Set([picked, ...photoLine.map((item) => item.under)].filter(Boolean));
  for (const anchor of anchors) {
    const block = blocks.find((b) => b.para === anchor.para);
    if (block) anchor.expect = plainText(block.text);
  }
  saveAnchors();
  showPicked();
}

function showDocumentPicker() {
  const picker = $('document-picker');
  const option = ({ id, name }) => {
    const item = document.createElement('option');
    item.value = id;
    item.textContent = name;
    return item;
  };
  const groups = [...documents.filter((doc) => !doc.project).map(option)];
  const projectNames = [...new Set(documents.filter((doc) => doc.project).map((doc) => doc.project))].sort((a, b) => a.localeCompare(b));
  for (const project of projectNames) {
    const group = document.createElement('optgroup');
    group.label = `📁 ${project}`;
    group.append(...documents.filter((doc) => doc.project === project).map(option));
    groups.push(group);
  }
  picker.replaceChildren(...groups);
  if (current) picker.value = current.id;
}

async function openDocument(id) {
  if (current && current.id !== id && !(await saveAllEdits())) {
    showDocumentPicker();
    alert("Your last change hasn't been saved yet. Try again once it's saved.");
    return;
  }
  const { document: opened } = await callJson(`/api/documents/${id}`);
  const switching = !current || current.id !== opened.id;
  if (switching) {
    current = opened;
    resetEdits();
  } else {
    adopt(opened);
  }
  remember('document', opened.id);
  showDocumentPicker();
  showDocument(switching);
  if (switching) showPairPanel(true, '');
}

async function createDocument(name, project = '') {
  if (current && !(await saveAllEdits())) {
    alert("Your last change hasn't been saved yet. Try again once it's saved.");
    return;
  }
  const { document: created } = await callJson('/api/documents', {
    method: 'POST',
    type: 'application/json',
    body: JSON.stringify({ name, project }),
  });
  documents.unshift({ id: created.id, name: created.name, project: created.project || '' });
  current = created;
  resetEdits();
  remember('document', created.id);
  showDocumentPicker();
  showDocument(true);
  showPairPanel(true, '');
}

// --- Editing on the main screen -------------------------------------------------
// Each line saves itself into the Word file a moment after you stop typing, and
// straight away when you leave it. Lines are named by their number in the Word file
// ("para") and the words the phone last saw there ("expect"), so the Mac can refuse
// to overwrite a line that was changed in Word meanwhile.

const edits = { deletes: [], noteDeletes: [], inFlight: false, timer: null, pause: 3000 };

function resetEdits() {
  clearPick();
  clearTimeout(edits.timer);
  edits.deletes = [];
  edits.noteDeletes = [];
  edits.pause = 3000;
}

const lineBeingEdited = () => (document.activeElement?.classList?.contains('line') ? document.activeElement : null);
const hasUnsavedEdits = () =>
  Boolean(
    paper.querySelector('.line[data-dirty], .line[data-kind-dirty], .line:not([data-para])[contenteditable="true"]') ||
      edits.deletes.length ||
      edits.noteDeletes.length,
  );
const settled = () => !lineBeingEdited() && !edits.inFlight && !hasUnsavedEdits();

function markChanged(line) {
  line.dataset.dirty = '1';
  saveSoon();
}

function saveSoon(delay = 1500) {
  clearTimeout(edits.timer);
  edits.timer = setTimeout(saveEdits, delay);
}

// When a guess is changed it loses its yellow. Typing just before or after a yellow
// word only moves the new letters out of the yellow.
function clearChangedGuesses(line) {
  let changed = false;
  const pieces = [];
  for (const node of line.childNodes) {
    if (node.nodeName !== 'MARK') {
      pieces.push({ text: node.textContent.replace(/ /g, ' '), guess: false });
      continue;
    }
    const text = node.textContent.replace(/ /g, ' ');
    const original = node.dataset.original ?? text;
    if (text === original) {
      pieces.push({ text, guess: true });
    } else if (original && text.startsWith(original)) {
      pieces.push({ text: original, guess: true }, { text: text.slice(original.length), guess: false });
      changed = true;
    } else if (original && text.endsWith(original)) {
      pieces.push({ text: text.slice(0, -original.length), guess: false }, { text: original, guess: true });
      changed = true;
    } else {
      pieces.push({ text, guess: false });
      changed = true;
    }
  }
  const strayFormatting = [...line.children].some((child) => child.nodeName !== 'MARK');
  if (changed || strayFormatting) refillKeepingCaret(line, strayFormatting ? readLine(line) : pieces);
}

function splitLine(line) {
  const selection = getSelection();
  if (selection.rangeCount && !selection.getRangeAt(0).collapsed) selection.getRangeAt(0).deleteContents();
  const at = caretOffset(line);
  if (at === null || at === 0) return; // nothing to split off at the very start
  const [left, right] = cutPieces(readLine(line), at);
  if (right.length) right[0] = { ...right[0], text: right[0].text.replace(/^\s+/, '') };
  fillLine(line, left);
  markChanged(line);
  const row = line.closest('.row');
  const newRow = makeRow({ kind: row.dataset.kind, level: Number(row.dataset.level) }, right, true);
  newRow.querySelector('.line').dataset.kindDirty = '1';
  row.after(newRow);
  renumber(row.closest('.note'));
  placeCaret(newRow.querySelector('.line'), 0);
  saveSoon();
}

function joinWithLineAbove(line) {
  const row = line.closest('.row');
  const above = row.previousElementSibling?.classList.contains('row') ? row.previousElementSibling.querySelector('.line[contenteditable="true"]') : null;
  if (!above) return false;
  const abovePieces = readLine(above);
  const pieces = readLine(line);
  // Two lines of words joined back together keep a space between them.
  const aboveText = plainOf(abovePieces);
  const gap = aboveText && plainOf(pieces) && !/\s$/.test(aboveText) && !/^\s/.test(plainOf(pieces)) ? [{ text: ' ', guess: false }] : [];
  const caret = aboveText.length + gap.length;
  fillLine(above, [...abovePieces, ...gap, ...pieces]);
  if (line.dataset.para !== undefined) edits.deletes.push({ para: Number(line.dataset.para), expect: line.dataset.expect });
  const section = row.closest('.note');
  row.remove();
  renumber(section);
  markChanged(above);
  placeCaret(above, caret);
  return true;
}

// Leaving a line you emptied deletes it (and the whole card, if it was the last line).
function leaveLine(line) {
  if (!line.isConnected || line.contentEditable !== 'true') return;
  if (tidy(plainOf(readLine(line)))) {
    if (line.dataset.dirty || line.dataset.kindDirty || line.dataset.para === undefined) saveSoon(0);
    return;
  }
  const row = line.closest('.row');
  const section = row.closest('.note');
  const lastLine = section.querySelectorAll('.row').length === 1;
  if (line.dataset.para !== undefined) {
    const para = Number(line.dataset.para);
    if (lastLine) edits.noteDeletes.push({ paras: [para], expects: [line.dataset.expect] });
    else edits.deletes.push({ para, expect: line.dataset.expect });
  }
  row.remove();
  if (lastLine) section.remove();
  else renumber(section);
  saveSoon(0);
}

function deleteCard(section) {
  if (!confirm('Delete this card? It will also be removed from the Word file.')) return;
  const lines = [...section.querySelectorAll('.line[data-para]')];
  if (lines.length) {
    edits.noteDeletes.push({ paras: lines.map((l) => Number(l.dataset.para)), expects: lines.map((l) => l.dataset.expect) });
  }
  section.remove();
  saveSoon(0);
}

// Moves the line numbers the phone knows about after the Mac changed the file.
function renumberAfterSave(indexMap) {
  movePicks(indexMap);
  const moved = (para) => indexMap[para] ?? para;
  for (const line of paper.querySelectorAll('.line[data-para]')) line.dataset.para = String(moved(Number(line.dataset.para)));
  edits.deletes = edits.deletes.map((d) => ({ ...d, para: moved(d.para) })).filter((d) => d.para >= 0);
  edits.noteDeletes = edits.noteDeletes.map((n) => ({ ...n, paras: n.paras.map(moved) })).filter((n) => n.paras.every((p) => p >= 0));
}

async function saveEdits() {
  clearTimeout(edits.timer);
  if (edits.inFlight || !current?.editable) return;
  const docId = current.id;
  const changes = [];
  const sent = { lines: [], newLines: [], kinds: [], deletes: edits.deletes.splice(0), noteDeletes: edits.noteDeletes.splice(0) };
  for (const n of sent.noteDeletes) changes.push({ op: 'deleteNote', paras: n.paras, expects: n.expects });
  for (const d of sent.deletes) changes.push({ op: 'delete', para: d.para, expect: d.expect });
  for (const section of paper.querySelectorAll('.note')) {
    let above = null; // the nearest saved line above, which new lines are added after
    let waiting = false; // a new line above is still empty, so the ones below wait to keep the order
    for (const line of section.querySelectorAll('.line[contenteditable="true"]')) {
      const pieces = readLine(line);
      const markup = markupOf(pieces);
      const words = tidy(plainOf(pieces));
      if (line.dataset.para !== undefined) {
        above = line;
        waiting = false;
        if (line.dataset.dirty && words) {
          changes.push({ op: 'set', para: Number(line.dataset.para), expect: line.dataset.expect, text: markup });
          sent.lines.push({ line, markup });
        }
        if (line.dataset.kindDirty && words) {
          const row = line.closest('.row');
          const kind = row.dataset.kind === 'paragraph' ? 'paragraph' : 'bullet';
          changes.push({ op: 'setKind', para: Number(line.dataset.para), expect: line.dataset.expect, kind, level: Number(row.dataset.level) || 0 });
          sent.kinds.push({ line, kind: row.dataset.kind });
        }
      } else if (words && above && !waiting) {
        sent.newLines.push({ line, markup, change: changes.length });
        changes.push({ op: 'insertAfter', para: Number(above.dataset.para), expect: above.dataset.expect, text: markup });
      } else {
        waiting = true;
      }
    }
  }
  if (changes.length === 0) {
    if (settled() && needsRender) showDocument(true);
    return;
  }

  edits.inFlight = true;
  let retryIn = 0;
  try {
    const result = await callJson(`/api/documents/${docId}/edits`, {
      method: 'POST',
      type: 'application/json',
      body: JSON.stringify({ edits: changes }),
    });
    hideWaiting();
    edits.pause = 3000;
    if (current?.id === docId) {
      renumberAfterSave(result.indexMap);
      for (const { line, markup } of sent.lines) {
        line.dataset.expect = tidy(plainOf(piecesOf(markup)));
        if (markupOf(readLine(line)) === markup) delete line.dataset.dirty;
      }
      for (const { line, kind } of sent.kinds) {
        if (line.closest('.row')?.dataset.kind === kind) delete line.dataset.kindDirty;
      }
      for (const { line, markup, change } of sent.newLines) {
        const para = result.results[change];
        if (para === null || para === undefined) continue;
        line.dataset.para = String(para);
        line.dataset.expect = tidy(plainOf(piecesOf(markup)));
        if (markupOf(readLine(line)) !== markup) line.dataset.dirty = '1';
      }
      adopt(result.document);
      refreshPicks();
      needsRender = true;
    }
  } catch (problem) {
    if (problem.retryable || problem.status === 401) {
      // Nothing was saved: keep everything to send again.
      edits.deletes.unshift(...sent.deletes);
      edits.noteDeletes.unshift(...sent.noteDeletes);
      if (problem.status === 401) {
        showLock('Please enter your passcode.');
      } else {
        showWaiting(problem.code === 'open' ? `${problem.message} Keep this page open meanwhile.` : `${problem.message} Keep this page open and your changes will be saved.`);
        retryIn = edits.pause;
        edits.pause = Math.min(edits.pause * 2, 30000);
      }
    } else {
      // The Mac can't take these changes (for example the line was changed in Word):
      // drop them and show the latest version of the document.
      hideWaiting();
      const lost = [...sent.lines, ...sent.newLines].map(({ markup }) => `"${plainOf(piecesOf(markup))}"`);
      showNotice(lost.length ? `${problem.message} What you typed: ${lost.join(', ')}` : problem.message);
      resetEdits();
      lineBeingEdited()?.blur();
      edits.inFlight = false;
      if (current?.id === docId) {
        try {
          const { document: latest } = await callJson(`/api/documents/${docId}`);
          current = latest;
        } catch {
          // Shown from the last copy; the next photo or edit will refresh it.
        }
        showDocument(true);
      }
      return;
    }
  } finally {
    edits.inFlight = false;
  }
  if (retryIn) saveSoon(retryIn);
  else if (hasUnsavedEdits() && !lineBeingEdited()) saveSoon(0);
  else if (settled() && needsRender) showDocument(true);
}

// Saves everything before switching documents. True when nothing is left unsaved.
async function saveAllEdits() {
  lineBeingEdited()?.blur();
  for (let attempt = 0; attempt < 5 && (hasUnsavedEdits() || edits.inFlight); attempt += 1) {
    if (edits.inFlight) await new Promise((resolve) => setTimeout(resolve, 300));
    else await saveEdits();
  }
  return !hasUnsavedEdits() && !edits.inFlight;
}

paper.addEventListener('keydown', (event) => {
  const line = event.target.closest?.('.line[contenteditable="true"]');
  if (!line || event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    splitLine(line);
  } else if (event.key === 'Backspace' && getSelection().isCollapsed && caretOffset(line) === 0) {
    if (joinWithLineAbove(line)) event.preventDefault();
  }
});

// The phone's keyboard reports the same actions here (more reliably than keydown).
paper.addEventListener('beforeinput', (event) => {
  const line = event.target.closest?.('.line[contenteditable="true"]');
  if (!line) return;
  const type = event.inputType;
  if (type === 'insertParagraph' || type === 'insertLineBreak') {
    event.preventDefault();
    splitLine(line);
  } else if (type === 'deleteContentBackward' && getSelection().isCollapsed && caretOffset(line) === 0) {
    event.preventDefault();
    joinWithLineAbove(line);
  } else if (type.startsWith('format') || type.startsWith('history') || type === 'insertFromDrop') {
    event.preventDefault(); // no bold/italic, undo or drag-and-drop: lines stay plain words
  }
});

// Pasted text goes in as plain words on one line.
paper.addEventListener('paste', (event) => {
  const line = event.target.closest?.('.line[contenteditable="true"]');
  if (!line) return;
  event.preventDefault();
  const text = (event.clipboardData?.getData('text/plain') || '').replace(/\s+/g, ' ');
  const selection = getSelection();
  if (!text || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  clearChangedGuesses(line);
  markChanged(line);
});

paper.addEventListener('input', (event) => {
  const line = event.target.closest?.('.line[contenteditable="true"]');
  if (!line) return;
  clearChangedGuesses(line);
  markChanged(line);
});

// Tapping a yellow word says it's right: the yellow goes.
// Tapping a line's dot adds or removes its bullet.
function toggleBullet(row) {
  const line = row.querySelector('.line');
  const kind = row.dataset.kind === 'paragraph' ? 'bullet' : 'paragraph';
  row.dataset.kind = kind;
  row.dataset.level = '0';
  row.className = `row ${kind}`;
  row.style.marginLeft = kind === 'paragraph' ? '' : '12px';
  line.dataset.kindDirty = '1';
  renumber(row.closest('.note'));
  saveSoon(lineBeingEdited() ? 1500 : 0);
}

paper.addEventListener('click', (event) => {
  const deleteButton = event.target.closest('.delete-note');
  if (deleteButton) {
    deleteCard(deleteButton.closest('.note'));
    return;
  }
  const dot = event.target.closest('.mark.toggle');
  if (dot) {
    toggleBullet(dot.closest('.row'));
    return;
  }
  const mark = event.target.closest('.line[contenteditable="true"] mark');
  if (!mark) return;
  const line = mark.closest('.line');
  const pieces = [];
  for (const node of line.childNodes) pieces.push({ text: node.textContent, guess: node.nodeName === 'MARK' && node !== mark });
  refillKeepingCaret(line, pieces);
  markChanged(line);
});

paper.addEventListener('focusin', (event) => {
  const line = event.target.closest?.('.line');
  if (!line) return;
  document.body.classList.add('editing');
  pickLine(line);
});

$('clear-picked').addEventListener('click', clearPick);

paper.addEventListener('focusout', (event) => {
  const line = event.target.closest?.('.line[contenteditable="true"]');
  if (!line) return;
  // Wait a moment: focus may be moving to another line.
  setTimeout(() => {
    if (!lineBeingEdited()) document.body.classList.remove('editing');
    leaveLine(line);
    if (settled() && needsRender) showDocument(true); // catch up on photos added while typing
  }, 0);
});

$('done-editing').addEventListener('click', () => lineBeingEdited()?.blur());

// --- The line of photos waiting to be added, strictly in the order snapped ----
// There is no limit on how many photos you add at once. Each one is shrunk and saved on
// this phone (in the browser's own storage) as soon as you pick it, so if the phone locks
// or the app is closed, the photos still waiting are picked up again when you come back.

const photoLine = [];
let working = false;
let preparing = Promise.resolve();
const batch = { total: 0, finished: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The browser's storage on this phone. If it can't be used (some private modes), photos
// still go in; they just aren't kept if the app is closed.
const phoneStorage = (() => {
  let opening = null;
  const open = () => {
    opening ??= new Promise((resolve) => {
      try {
        const request = indexedDB.open('describe', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('photos', { keyPath: 'id' });
          request.result.createObjectStore('anchors', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return opening;
  };
  const run = async (name, mode, action) => {
    const db = await open();
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(name, mode);
        const request = action(transaction.objectStore(name));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => resolve(undefined);
        transaction.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  };
  return {
    works: async () => Boolean(await open()),
    put: (name, value) => run(name, 'readwrite', (store) => store.put(value)),
    remove: (name, key) => run(name, 'readwrite', (store) => store.delete(key)),
    all: async (name) => (await run(name, 'readonly', (store) => store.getAll())) || [],
  };
})();

let nextOrder = Date.now() * 1000;

// What is kept for each photo: the picture (the original until it has been shrunk, so
// nothing is lost even mid-way) and where it goes.
function savePhoto(item) {
  if (!item.data) return Promise.resolve();
  return phoneStorage.put('photos', {
    id: item.id,
    order: item.order,
    documentId: item.documentId,
    anchorKey: item.under?.key || null,
    data: item.data,
    type: item.type,
    raw: Boolean(item.raw),
    state: item.state === 'failed' ? 'failed' : 'waiting',
    message: item.state === 'failed' ? item.message : '',
  });
}

function saveAnchors() {
  const anchors = new Set([picked, ...photoLine.map((item) => item.under)].filter(Boolean));
  for (const anchor of anchors) phoneStorage.put('anchors', { key: anchor.key, para: anchor.para, expect: anchor.expect });
}

function showTray() {
  const active = photoLine.filter((item) => item.state !== 'done');
  const waiting = photoLine.filter((item) => item.state === 'waiting' || item.state === 'preparing');
  // Show what is happening now, anything that needs you, and a few of what's next.
  const shown = [];
  for (const item of photoLine) {
    if (item.state === 'failed' || item.state === 'working' || item.state === 'done') shown.push(item);
  }
  for (const item of waiting.slice(0, 3)) shown.push(item);
  shown.sort((a, b) => a.order - b.order);
  const rows = shown.map((item) => {
    const row = document.createElement('li');
    const picture = document.createElement('img');
    if (item.preview) picture.src = item.preview;
    picture.alt = '';
    const status = document.createElement('span');
    status.className = `status ${item.state}`;
    status.textContent = item.message;
    row.append(picture, status);
    if (item.state === 'failed') {
      const again = document.createElement('button');
      again.type = 'button';
      again.textContent = 'Try again';
      again.addEventListener('click', () => {
        setItem(item, 'waiting', 'Waiting…');
        savePhoto(item);
        batch.total += 1;
        runLine();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => dropItem(item));
      row.append(again, remove);
    }
    return row;
  });
  const more = waiting.length - waiting.slice(0, 3).length;
  if (more > 0) {
    const row = document.createElement('li');
    row.className = 'more';
    row.textContent = `…and ${more} more waiting`;
    rows.push(row);
  }
  $('tray').replaceChildren(...rows);

  // "Adding photos: 12 of 40"
  if (batch.total > 1 && active.some((item) => item.state !== 'failed')) {
    $('progress').hidden = false;
    $('progress-text').textContent = `Adding photos: ${Math.min(batch.finished + 1, batch.total)} of ${batch.total}`;
    $('progress-bar').style.width = `${Math.round((batch.finished / batch.total) * 100)}%`;
  } else {
    $('progress').hidden = true;
  }
  if (!active.some((item) => item.state !== 'failed')) {
    batch.total = 0;
    batch.finished = 0;
  }
}

function setItem(item, state, message) {
  item.state = state;
  item.message = message;
  showTray();
}

function dropItem(item) {
  const index = photoLine.indexOf(item);
  if (index >= 0) photoLine.splice(index, 1);
  if (item.preview) URL.revokeObjectURL(item.preview);
  phoneStorage.remove('photos', item.id);
  showTray();
}

// Shrinks a photo so it sends quickly. A photo this browser can't open (for example an
// iPhone "HEIC" photo in Chrome on a laptop) is sent as it is if the Mac can read it.
async function preparePhoto(file) {
  try {
    return await shrinkPhoto(file);
  } catch {
    if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size <= 5 * 1024 * 1024) return file;
    throw new Error('This photo could not be opened here. If it is an iPhone (HEIC) photo, try Safari, or save it as a JPEG.');
  }
}

function addPhotos(files) {
  const items = [...files].map((file) => {
    nextOrder += 1;
    return {
      id: newPhotoId(),
      order: nextOrder,
      documentId: current.id,
      under: picked, // goes under the picked line (and the next one after it), or at the end
      file,
      preview: null,
      state: 'preparing',
      message: 'Preparing…',
    };
  });
  photoLine.push(...items);
  batch.total += items.length;
  saveAnchors();
  showTray();
  prepareItems(items, true);
}

// First every photo is saved as it is (quick), so a locked phone can't lose any. Then
// one at a time (phones are strict about memory), in order, each is shrunk for sending.
function prepareItems(items, saveOriginalsFirst) {
  preparing = preparing.then(async () => {
    if (saveOriginalsFirst) {
      for (const item of items) {
        try {
          item.data = await item.file.arrayBuffer();
          item.type = item.file.type || 'image/jpeg';
          item.raw = true;
          await savePhoto({ ...item, state: 'waiting' });
        } catch {
          // Not saved early; it is still shrunk and saved below.
        }
      }
    }
    for (const item of items) {
      if (!photoLine.includes(item)) continue;
      try {
        const prepared = await preparePhoto(item.file);
        item.type = prepared.type || 'image/jpeg';
        item.data = await prepared.arrayBuffer();
        item.raw = false;
        item.preview = URL.createObjectURL(prepared);
        item.file = null;
        await savePhoto({ ...item, state: 'waiting' });
        setItem(item, 'waiting', 'Waiting…');
      } catch (problem) {
        item.file = null;
        setItem(item, 'failed', problem.message);
        savePhoto(item);
        batch.finished += 1;
      }
      runLine();
    }
  });
}

// Photos still waiting from last time (the phone locked, or the app was closed).
async function pickUpSavedPhotos() {
  const saved = (await phoneStorage.all('photos')).sort((a, b) => a.order - b.order);
  const known = new Set(photoLine.map((item) => item.id));
  const anchors = new Map((await phoneStorage.all('anchors')).map((a) => [a.key, a]));
  const shared = new Map();
  const toPrepare = [];
  let picked_up = 0;
  for (const record of saved) {
    if (known.has(record.id)) continue;
    let under = null;
    if (record.anchorKey && anchors.has(record.anchorKey)) {
      if (!shared.has(record.anchorKey)) shared.set(record.anchorKey, { ...anchors.get(record.anchorKey) });
      under = shared.get(record.anchorKey);
    }
    const blob = new Blob([record.data], { type: record.type || 'image/jpeg' });
    nextOrder = Math.max(nextOrder, record.order);
    const unshrunk = record.raw && record.state !== 'failed';
    const item = {
      id: record.id,
      order: record.order,
      documentId: record.documentId,
      under,
      data: record.data,
      type: record.type,
      raw: Boolean(record.raw),
      file: unshrunk ? new File([blob], 'photo', { type: record.type || 'image/jpeg' }) : null,
      preview: unshrunk ? null : URL.createObjectURL(blob),
      state: record.state === 'failed' ? 'failed' : unshrunk ? 'preparing' : 'waiting',
      message: record.state === 'failed' ? record.message : unshrunk ? 'Preparing…' : 'Waiting…',
    };
    photoLine.push(item);
    if (unshrunk) toPrepare.push(item);
    if (record.state !== 'failed') picked_up += 1;
  }
  if (toPrepare.length) prepareItems(toPrepare, false);
  // Forget places that no waiting photo uses any more.
  const used = new Set(photoLine.map((item) => item.under?.key).filter(Boolean));
  for (const key of anchors.keys()) if (!used.has(key) && key !== picked?.key) phoneStorage.remove('anchors', key);
  if (picked_up) {
    batch.total += picked_up;
    showNotice(`Picking up ${picked_up} photo${picked_up === 1 ? '' : 's'} that ${picked_up === 1 ? 'was' : 'were'} still waiting.`);
  }
  showTray();
}

async function sendPhoto(item) {
  setItem(item, 'working', 'Reading the handwriting…');
  if (item.under) {
    // Let a save of your typing finish first, so the picked line's words are up to date.
    for (let waited = 0; edits.inFlight && waited < 15000; waited += 200) await sleep(200);
    refreshPicks();
  }
  const under = item.under && item.under.para >= 0 ? item.under : null;
  return callJson(`/api/documents/${item.documentId}/photos?photo=${item.id}`, {
    method: 'POST',
    type: item.type || 'image/jpeg',
    body: item.data,
    extraHeaders: under ? { 'X-Under-Para': String(under.para), 'X-Under-Text': encodeURIComponent(under.expect) } : {},
  });
}

async function processPhoto(item) {
  let pause = 3000;
  for (;;) {
    try {
      const result = await sendPhoto(item);
      hideWaiting();
      phoneStorage.remove('photos', item.id); // safely in Word now
      if (current && result.document.id === current.id) {
        if (result.indexMap) renumberAfterSave(result.indexMap); // lines below the new ones moved down
        if (item.under && Number.isInteger(result.lastPara)) {
          item.under.para = result.lastPara; // the next photo goes right after this one
          if (result.placedAtEnd) showNotice('The line you picked was changed in Word, so this photo went at the end.');
        }
        adopt(result.document);
        refreshPicks();
        showDocument();
      }
      saveAnchors();
      batch.finished += 1;
      if (result.issue) {
        setItem(item, 'failed', result.issue);
        savePhoto(item);
      } else {
        item.data = null;
        setItem(item, 'done', 'Added ✓');
        setTimeout(() => dropItem(item), 3000);
      }
      return;
    } catch (problem) {
      if (problem.status === 401) {
        setItem(item, 'waiting', 'Waiting…');
        showLock('Please enter your passcode.');
        return;
      }
      if (problem.retryable) {
        // Keep this photo first in line so the order never changes.
        showWaiting(problem.code === 'open' ? `${problem.message} Keep this page open meanwhile.` : `${problem.message} Your photos are saved on this phone and will be added.`);
        setItem(item, 'waiting', 'Waiting to try again…');
        await sleep(pause);
        pause = Math.min(pause * 2, 30000);
      } else {
        hideWaiting();
        batch.finished += 1;
        setItem(item, 'failed', problem.message);
        savePhoto(item);
        return;
      }
    }
  }
}

async function runLine() {
  if (working) return;
  working = true;
  try {
    for (;;) {
      if (!$('lock').hidden) break;
      // Strictly in order: stop at a photo that is still being prepared.
      const next = photoLine.find((item) => item.state === 'waiting' || item.state === 'preparing');
      if (!next || next.state === 'preparing') break;
      await processPhoto(next);
    }
  } finally {
    working = false;
  }
}

// --- Word download ------------------------------------------------------------

async function downloadWord() {
  if (!current) return;
  const button = $('word');
  button.disabled = true;
  try {
    if (!(await saveAllEdits())) throw new Error("Your last change hasn't been saved yet. Try again once it's saved.");
    const file = await (await callMac(`/api/documents/${current.id}/word`)).blob();
    const address = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = address;
    link.download = `${current.name}.docx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(address), 60000);
  } catch (problem) {
    alert(problem.message);
  } finally {
    button.disabled = false;
  }
}

// --- Starting up --------------------------------------------------------------

function showOnly(section) {
  for (const id of ['lock', 'offline', 'main']) $(id).hidden = id !== section;
}

function showLock(message = '') {
  $('lock-message').textContent = message;
  $('passcode').value = '';
  showOnly('lock');
}

const PRACTICE_WORDING = {
  'no-key': 'Practice mode: photos become sample text until you add an AI key.',
  'no-passcode': 'Practice mode: add a passcode to your .env file to switch the AI on.',
};

// Opened from a QR code on a laptop: the link carries a short-lived code that unlocks
// the app and opens the same list, so there's no passcode to type.
let openProjectOnStart = '';

async function claimPairCode() {
  const code = new URLSearchParams(location.search).get('pair');
  if (!code) return;
  history.replaceState(null, '', '/');
  try {
    const paired = await callJson('/api/pair/claim', { method: 'POST', type: 'application/json', body: JSON.stringify({ code }) });
    passcode = paired.passcode;
    remember('passcode', passcode);
    if (paired.project) {
      openProjectOnStart = paired.project;
      showNotice(`Connected to the project "${paired.project}". Pick a file to work on; everyone sees changes live.`);
    } else {
      remember('document', paired.documentId);
      showNotice('Connected. This phone and the laptop now show the same list, live.');
    }
  } catch (problem) {
    showNotice(problem.message);
  }
}

async function start() {
  try {
    await claimPairCode();
    const status = await callJson('/api/status');
    $('practice-banner').textContent = PRACTICE_WORDING[status.practiceReason] || '';
    $('practice-banner').hidden = status.mode !== 'practice';

    ({ documents } = await callJson('/api/documents'));
    if (documents.length === 0) {
      await createDocument('My notes');
    } else {
      const inProject = openProjectOnStart && documents.find((doc) => doc.project === openProjectOnStart);
      const remembered = current?.id || recall('document');
      const id = inProject ? inProject.id : documents.some((doc) => doc.id === remembered) ? remembered : documents[0].id;
      await openDocument(id);
    }
    showOnly('main');
    if (openProjectOnStart) {
      // Scanned a project's code: show its files so you can pick one.
      const project = openProjectOnStart;
      openProjectOnStart = '';
      await openMenu();
      document.querySelector(`[data-project-head="${CSS.escape(project)}"]`)?.scrollIntoView({ block: 'start' });
    }
    connectLive();
    showPairPanel();
    await pickUpSavedPhotos();
    runLine();
    if (hasUnsavedEdits()) saveSoon(0);
  } catch (problem) {
    if (problem.status === 401) {
      showLock(passcode ? problem.message : '');
    } else if (problem.status === 429) {
      showLock(problem.message);
    } else {
      showOnly('offline');
    }
  }
}

$('lock').addEventListener('submit', (event) => {
  event.preventDefault();
  passcode = $('passcode').value;
  remember('passcode', passcode);
  start();
});

$('try-again').addEventListener('click', start);

// Leaving the app saves straight away; coming back shows the latest version
// (for example after editing in Word).
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    if (hasUnsavedEdits()) saveEdits();
    return;
  }
  if (!current || $('main').hidden) return;
  connectLive();
  if (!settled()) return;
  try {
    ({ documents } = await callJson('/api/documents'));
    await openDocument(current.id);
  } catch {
    // Not important: the next photo will refresh it anyway.
  }
});

// --- Live updates from the Mac --------------------------------------------------------
// One connection stays open; the Mac says when any screen changed a list. This screen
// then fetches the latest version (or catches up as soon as you finish typing).

const live = { controller: null, retry: 1000 };

async function connectLive() {
  if (live.controller || $('main').hidden) return;
  const controller = new AbortController();
  live.controller = controller;
  let connected = false;
  try {
    const response = await fetch('/api/events', {
      headers: { 'X-Passcode': passcode, 'X-Client': clientId },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) throw new Error('No live connection.');
    connected = true;
    live.retry = 1000;
    catchUp(); // anything missed while not connected
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = message
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        if (!data) continue;
        try {
          await onLiveNews(JSON.parse(data));
        } catch {
          // A bad message is skipped; the next one or a refresh brings things up to date.
        }
      }
    }
  } catch {
    // Dropped (sleep, Wi-Fi change, Mac restarted): try again shortly.
  }
  live.controller = null;
  if (controller.signal.aborted) return;
  setTimeout(connectLive, connected ? 1000 : live.retry);
  if (!connected) live.retry = Math.min(live.retry * 2, 30000);
}

async function catchUp() {
  await refreshListsFromMac();
  if (!current || !settled()) return;
  try {
    const { document: latest } = await callJson(`/api/documents/${current.id}`);
    if (latest.id === current?.id && (latest.version || 0) > (current.version || 0)) {
      adopt(latest);
      refreshPicks();
      showDocument();
    }
  } catch {
    // The next news or photo will bring it up to date.
  }
}

async function onLiveNews(news) {
  if (news.source && news.source === clientId) return; // this screen made the change
  if (news.type === 'lists') {
    await refreshListsFromMac();
    return;
  }
  if (news.type !== 'document' || !current || news.id !== current.id) return;
  if ((news.version || 0) <= (current.version || 0)) return;
  // Lines may have moved (added or removed above); keep this screen's lines pointing right.
  if (news.indexMap) renumberAfterSave(news.indexMap);
  const { document: latest } = await callJson(`/api/documents/${current.id}`);
  if (latest.id !== current?.id) return;
  adopt(latest);
  refreshPicks();
  showDocument(); // waits until you finish typing, if you are
}

async function refreshListsFromMac() {
  let latest;
  try {
    ({ documents: latest } = await callJson('/api/documents'));
  } catch {
    return;
  }
  documents = latest;
  if (current && !documents.some((doc) => doc.id === current.id)) {
    // This list was deleted on another screen.
    const gone = current.name;
    current = null;
    resetEdits();
    if (documents.length) await openDocument(documents[0].id);
    else await createDocument('My notes');
    showNotice(`"${gone}" was deleted on another screen. It's in the Archive if you need it.`);
  }
  showDocumentPicker();
  if (!$('menu').hidden) await refreshMenu();
}

// --- Laptop: QR code to connect a phone, and drag-and-drop photos ---------------------

const wideScreen = window.matchMedia('(min-width: 900px)');
const pair = { timer: null, forDocument: null, project: '' };

// The QR code is for the open file, or (when asked from a project) for the whole project.
async function showPairPanel(force = false, project = undefined) {
  if (project !== undefined) pair.project = project || '';
  const wanted = force || wideScreen.matches || $('pair-panel').classList.contains('show');
  if (!wanted || !current) return;
  if (!force && !pair.project && pair.forDocument === current.id && pair.timer) return;
  clearTimeout(pair.timer);
  pair.forDocument = current.id;
  $('pair-title').textContent = pair.project ? `Use your phone: ${pair.project}` : 'Use your phone';
  $('pair-about').textContent = pair.project
    ? `Scan this to open the project "${pair.project}" on your phone and pick a file. Everyone sees every change live.`
    : "Scan this with your phone's camera. It opens this list on your phone, and both screens show every change live.";
  try {
    const { svg, url, expiresAt } = await callJson('/api/pair', {
      method: 'POST',
      type: 'application/json',
      body: JSON.stringify(pair.project ? { project: pair.project } : { documentId: current.id }),
    });
    $('pair-code').innerHTML = svg; // made by the Mac from a link it built itself
    $('pair-link').textContent = url;
    const minutes = Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 60000));
    $('pair-expires').textContent = `This code works for ${minutes} minutes, then a new one appears.`;
    // A fresh code shortly before this one runs out.
    pair.timer = setTimeout(() => showPairPanel(true), Math.max(30000, new Date(expiresAt) - Date.now() - 60000));
  } catch (problem) {
    $('pair-code').textContent = '';
    $('pair-expires').textContent = problem.message;
  }
}

$('pair-new').addEventListener('click', () => showPairPanel(true));
$('menu-pair').addEventListener('click', () => {
  closeMenu();
  $('pair-panel').classList.add('show');
  showPairPanel(true, '');
  $('pair-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('pair-close').addEventListener('click', () => $('pair-panel').classList.remove('show'));
wideScreen.addEventListener('change', () => showPairPanel(true));

// Drop photos anywhere on the page (from Finder or the Photos app) to add them.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (event) => {
  if (!hasFiles(event) || $('main').hidden) return;
  dragDepth += 1;
  $('drop-zone').hidden = false;
});
document.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('drop-zone').hidden = true;
});
document.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $('drop-zone').hidden = true;
  const photos = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name));
  if (!photos.length) {
    showNotice('Only photos can be added here.');
    return;
  }
  if (current && !$('main').hidden) addPhotos(photos);
});

$('snap').addEventListener('click', () => $('camera').click());
$('choose').addEventListener('click', () => $('library').click());
$('word').addEventListener('click', downloadWord);

for (const id of ['camera', 'library']) {
  $(id).addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = ''; // lets the same button be used again straight away
    if (files.length && current) addPhotos(files);
  });
}

$('document-picker').addEventListener('change', (event) => {
  openDocument(event.target.value).catch((problem) => {
    alert(problem.message);
    showDocumentPicker();
  });
});

// --- The side menu: lists and the Archive -------------------------------------------
// Tap "☰ DeScribe" to open it. Deleting a list moves its Word file to DeScribe/Archive in
// OneDrive (nothing is destroyed); the Archive section can put it back.

function menuMessage(text, problem = false) {
  $('menu-message').textContent = text;
  $('menu-message').classList.toggle('problem', problem);
}

async function openMenu() {
  lineBeingEdited()?.blur();
  menuMessage('');
  $('menu').hidden = false;
  $('menu-backdrop').hidden = false;
  document.body.classList.add('menu-open');
  $('menu-button').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => $('menu').classList.add('open'));
  $('close-menu').focus({ preventScroll: true });
  await refreshMenu();
}

function closeMenu() {
  $('menu').classList.remove('open');
  $('menu-backdrop').hidden = true;
  document.body.classList.remove('menu-open');
  $('menu-button').setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (!$('menu').classList.contains('open')) $('menu').hidden = true;
  }, 250);
}

let projects = [];

async function refreshMenu() {
  try {
    ({ documents } = await callJson('/api/documents'));
    try {
      ({ projects } = await callJson('/api/projects'));
    } catch {
      projects = []; // documents kept inside the app have no projects
    }
    showDocumentPicker();
    showMenuLists();
  } catch (problem) {
    menuMessage(problem.message, true);
  }
  try {
    const { archived } = await callJson('/api/archive');
    showArchive(archived);
  } catch (problem) {
    showArchive([], problem.message);
  }
}

function menuButton(label, onClick, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', onClick);
  return button;
}

// One file in the menu: open it, move it to a project, or delete it.
function fileRow(doc, inProject) {
  const row = document.createElement('li');
  row.className = `menu-file${inProject ? ' in-project' : ''}`;
  const open = menuButton(doc.name, async () => {
    closeMenu();
    try {
      await openDocument(doc.id);
    } catch (problem) {
      alert(problem.message);
    }
  }, 'open-list');
  if (current?.id === doc.id) open.setAttribute('aria-current', 'true');

  const move = document.createElement('select');
  move.className = 'move-to';
  move.setAttribute('aria-label', `Move ${doc.name} to a project`);
  const choice = (value, label, disabled = false) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.disabled = disabled;
    return option;
  };
  move.append(choice('', 'Move', true));
  if (doc.project) move.append(choice('<none>', 'Out of the project'));
  for (const project of projects) if (project.name !== doc.project) move.append(choice(project.name, `To ${project.name}`));
  move.append(choice('<new>', 'To a new project…'));
  move.value = '';
  move.addEventListener('change', () => moveFile(doc, move.value, move));

  const remove = menuButton('Delete', () => deleteList(doc), 'delete-list');
  remove.setAttribute('aria-label', `Delete ${doc.name}`);
  row.append(open, move, remove);
  return row;
}

function showMenuLists() {
  const rows = [];
  const loose = documents.filter((doc) => !doc.project);
  if (loose.length && projects.length) {
    const label = document.createElement('li');
    label.className = 'group-label';
    label.textContent = 'Not in a project';
    rows.push(label);
  }
  for (const doc of loose) rows.push(fileRow(doc, false));
  for (const project of projects) {
    const head = document.createElement('li');
    head.className = 'project-head';
    head.dataset.projectHead = project.name;
    const title = document.createElement('span');
    title.className = 'project-name';
    title.textContent = `📁 ${project.name}`;
    const count = document.createElement('small');
    count.textContent = `${project.files} file${project.files === 1 ? '' : 's'}`;
    title.append(count);
    const actions = document.createElement('span');
    actions.className = 'project-actions';
    actions.append(
      menuButton('QR', () => {
        closeMenu();
        $('pair-panel').classList.add('show');
        showPairPanel(true, project.name);
        $('pair-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }),
      menuButton('Rename', () => renameProject(project.name)),
      menuButton('Delete', () => deleteProject(project), 'delete-list'),
    );
    head.append(title, actions);
    rows.push(head);
    const files = documents.filter((doc) => doc.project === project.name);
    for (const doc of files) rows.push(fileRow(doc, true));
    const add = document.createElement('li');
    add.className = 'menu-file in-project';
    add.append(
      menuButton('+ New file here', () => {
        const name = prompt(`Name for the new file in "${project.name}":`);
        if (name === null) return;
        closeMenu();
        createDocument(name, project.name).catch((problem) => alert(problem.message));
      }, 'add-file'),
    );
    rows.push(add);
  }
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-note';
    empty.textContent = 'No lists yet.';
    rows.push(empty);
  }
  $('menu-lists').replaceChildren(...rows);
}

async function moveFile(doc, choice, select) {
  let project = choice === '<none>' ? '' : choice;
  try {
    if (choice === '<new>') {
      const name = prompt('Name for the new project:');
      if (name === null) {
        select.value = '';
        return;
      }
      ({ project: { name: project } } = await callJson('/api/projects', { method: 'POST', type: 'application/json', body: JSON.stringify({ name }) }));
    }
    const { document: moved } = await callJson(`/api/documents/${doc.id}/move`, {
      method: 'POST',
      type: 'application/json',
      body: JSON.stringify({ project }),
    });
    if (current?.id === moved.id) {
      current = { ...current, name: moved.name, project: moved.project };
    }
    await refreshMenu();
    menuMessage(moved.project ? `"${moved.name}" moved to "${moved.project}".` : `"${moved.name}" is no longer in a project.`);
  } catch (problem) {
    select.value = '';
    menuMessage(problem.message, true);
  }
}

async function newProject() {
  const name = prompt('Name for the new project:');
  if (name === null) return;
  try {
    const { project } = await callJson('/api/projects', { method: 'POST', type: 'application/json', body: JSON.stringify({ name }) });
    await refreshMenu();
    menuMessage(`Project "${project.name}" made. Add files with "+ New file here", or move files in with "Move".`);
  } catch (problem) {
    menuMessage(problem.message, true);
  }
}

async function renameProject(from) {
  const to = prompt('New name for the project:', from);
  if (to === null || to.trim() === from) return;
  try {
    const { project } = await callJson('/api/projects/rename', { method: 'POST', type: 'application/json', body: JSON.stringify({ from, to }) });
    if (current?.project === from) current = { ...current, project: project.name };
    if (pair.project === from) pair.project = project.name;
    await refreshMenu();
    menuMessage(`Renamed to "${project.name}".`);
  } catch (problem) {
    menuMessage(problem.message, true);
  }
}

async function deleteProject(project) {
  const files = documents.filter((doc) => doc.project === project.name);
  if (photoLine.some((item) => files.some((doc) => doc.id === item.documentId) && item.state !== 'done')) {
    menuMessage(`Photos are still being added to a file in "${project.name}". Wait for them to finish, then delete it.`, true);
    return;
  }
  const question = `Delete the project "${project.name}" and its ${files.length} file${files.length === 1 ? '' : 's'}?\n\nThey all move to the Archive (the DeScribe/Archive folder in your OneDrive). You can restore the whole project from there.`;
  if (!confirm(question)) return;
  const inIt = current && current.project === project.name;
  if (inIt && !(await saveAllEdits())) {
    menuMessage("Your last change hasn't been saved yet. Try again once it's saved.", true);
    return;
  }
  try {
    const result = await callJson('/api/projects/archive', { method: 'POST', type: 'application/json', body: JSON.stringify({ name: project.name }) });
    documents = result.documents;
    if (inIt) {
      current = null;
      resetEdits();
      if (documents.length) await openDocument(documents[0].id);
      else await createDocument('My notes');
    }
    if (pair.project === project.name) showPairPanel(true, '');
    await refreshMenu();
    menuMessage(`"${project.name}" moved to the Archive.`);
  } catch (problem) {
    menuMessage(problem.message, true);
  }
}

function showArchive(items, problem = '') {
  if (!items.length) {
    const row = document.createElement('li');
    row.className = 'empty-note';
    row.textContent = problem || 'Nothing in the Archive.';
    $('menu-archive').replaceChildren(row);
    return;
  }
  $('menu-archive').replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'archived';
      label.textContent = item.type === 'project' ? `📁 ${item.name}` : item.name;
      const when = document.createElement('small');
      const date = new Date(item.archivedAt);
      const details = [];
      if (item.type === 'project') details.push(`${item.files} file${item.files === 1 ? '' : 's'}`);
      if (item.from) details.push(`from ${item.from}`);
      if (!Number.isNaN(date.getTime())) details.push(`deleted ${date.toLocaleDateString()}`);
      when.textContent = details.join(' · ');
      label.append(when);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = 'Restore';
      restore.setAttribute('aria-label', `Restore ${item.name}`);
      restore.addEventListener('click', () => restoreList(item, restore));
      row.append(label, restore);
      return row;
    }),
  );
}

async function deleteList(doc) {
  if (photoLine.some((item) => item.documentId === doc.id && item.state !== 'done')) {
    menuMessage(`Photos are still being added to "${doc.name}". Wait for them to finish, then delete it.`, true);
    return;
  }
  const question = `Delete "${doc.name}"?\n\nIt moves to the Archive (the DeScribe/Archive folder in your OneDrive). You can restore it from there.`;
  if (!confirm(question)) return;
  if (current?.id === doc.id && !(await saveAllEdits())) {
    menuMessage("Your last change to this list hasn't been saved yet. Try again once it's saved.", true);
    return;
  }
  try {
    const result = await callJson(`/api/documents/${doc.id}/archive`, { method: 'POST' });
    documents = result.documents;
    if (current?.id === doc.id) {
      current = null;
      resetEdits();
      if (documents.length) await openDocument(documents[0].id);
      else await createDocument('My notes');
    }
    showDocumentPicker();
    await refreshMenu();
    menuMessage(`"${doc.name}" moved to the Archive.`);
  } catch (problem) {
    menuMessage(problem.message, true);
  }
}

async function restoreList(item, button) {
  button.disabled = true;
  try {
    const restored = await callJson(`/api/archive/${item.id}/restore`, { method: 'POST' });
    await refreshMenu();
    if (restored.project) menuMessage(`The project "${restored.project.name}" is back, with its files.`);
    else menuMessage(`"${restored.document.name}" is back${restored.document.project ? ` in "${restored.document.project}"` : ' in your lists'}.`);
  } catch (problem) {
    button.disabled = false;
    menuMessage(problem.message, true);
  }
}

$('menu-button').addEventListener('click', openMenu);
$('menu-new-project').addEventListener('click', newProject);
$('close-menu').addEventListener('click', closeMenu);
$('menu-backdrop').addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('menu').hidden) closeMenu();
});
$('menu-new').addEventListener('click', () => {
  const name = prompt('Name for the new list:');
  if (name === null) return;
  closeMenu();
  createDocument(name).catch((problem) => alert(problem.message));
});

$('new-document').addEventListener('click', () => {
  const name = prompt('Name for the new document:');
  if (name === null) return;
  createDocument(name).catch((problem) => alert(problem.message));
});

start();
