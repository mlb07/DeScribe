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
// A guest (let in by a list's or project's QR code) has a ticket instead of the passcode,
// plus a ticket for each password they've entered.
let guest = recall('guest');
let unlocks = (() => {
  try {
    const saved = JSON.parse(recall('unlocks') || '[]');
    return Array.isArray(saved) ? saved.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
})();
let role = 'owner';
let onThisMac = false; // this browser is on the Mac DeScribe runs on
// Set when the owner reset the link this guest came in with (kept, so a reload still says why).
let linkProblem = recall('linkProblem');
function linkGone(message) {
  linkProblem = message || 'This link no longer works. Ask the owner for the new QR code.';
  remember('linkProblem', linkProblem);
  guest = '';
  remember('guest', '');
}
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

function authHeaders() {
  const headers = { 'X-Passcode': passcode, 'X-Client': clientId };
  if (guest) headers['X-Guest'] = guest;
  if (guest && unlocks.length) headers['X-Unlock'] = unlocks.join(',');
  return headers;
}

async function callMac(path, { method = 'GET', body, type, extraHeaders = {}, tries = 0 } = {}) {
  const headers = { 'X-App': 'photo-to-word', ...authHeaders(), ...extraHeaders };
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
  // A password-protected list or project: ask for its password, then try again.
  if (response.status === 403 && details.code === 'locked' && details.lock && tries < 3) {
    await askToUnlock(details.lock);
    return callMac(path, { method, body, type, extraHeaders, tries: tries + 1 });
  }
  if (response.status === 401 && details.code === 'link') linkGone(details.message);
  throw new CallProblem(details.message || 'Something went wrong.', {
    status: response.status,
    retryable: Boolean(details.retryable),
    code: details.code || '',
  });
}

const callJson = async (path, options) => (await callMac(path, options)).json();
const postJson = (path, body) => callJson(path, { method: 'POST', type: 'application/json', body: JSON.stringify(body) });

// --- The small box for names and passwords ------------------------------------------
// ask({ title, about, name, password, ok, extra, cancelable, check }) shows the box and
// resolves with what check() returned, or null if cancelled. If check() throws, its
// message shows in the box and the box stays open.

function ask({ title, about = '', name = null, password = null, ok = 'OK', extra = null, cancelable = true, check }) {
  const dialog = $('ask');
  $('ask-title').textContent = title;
  $('ask-about').textContent = about;
  $('ask-about').hidden = !about;
  for (const [field, settings] of [['name', name], ['password', password]]) {
    $(`ask-${field}`).hidden = !settings;
    $(`ask-${field}-label`).hidden = !settings;
    $(`ask-${field}`).value = settings?.value || '';
    if (settings) $(`ask-${field}-label`).textContent = settings.label;
  }
  if (password) $('ask-password').autocomplete = password.current ? 'current-password' : 'new-password';
  $('ask-hint').textContent = password?.hint || name?.hint || '';
  $('ask-hint').hidden = !$('ask-hint').textContent;
  $('ask-message').textContent = '';
  $('ask-ok').textContent = ok;
  // A box that closed after a successful save left its buttons greyed out: start fresh.
  $('ask-ok').disabled = false;
  $('ask-extra').disabled = false;
  $('ask-extra').hidden = !extra;
  $('ask-extra').textContent = extra?.label || '';
  $('ask-cancel').hidden = !cancelable;

  return new Promise((resolve) => {
    let busy = false;
    const values = () => ({ name: $('ask-name').value, password: $('ask-password').value });
    const run = async (job) => {
      if (busy) return;
      busy = true;
      $('ask-ok').disabled = true;
      $('ask-extra').disabled = true;
      $('ask-message').textContent = '';
      try {
        finish(await job());
      } catch (problem) {
        $('ask-message').textContent = problem.message;
        busy = false;
        $('ask-ok').disabled = false;
        $('ask-extra').disabled = false;
        const field = !$('ask-password').hidden ? $('ask-password') : $('ask-name');
        field.focus();
        field.select();
      }
      busy = false;
    };
    const onSubmit = (event) => {
      event.preventDefault();
      run(async () => (check ? check(values()) : values()));
    };
    const onExtra = () => run(() => extra.run(values()));
    const onCancel = (event) => {
      event.preventDefault();
      if (cancelable && !busy) finish(null);
    };
    const cleanup = () => {
      $('ask-form').removeEventListener('submit', onSubmit);
      $('ask-extra').removeEventListener('click', onExtra);
      $('ask-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
    };
    function finish(result) {
      cleanup();
      $('ask-ok').disabled = false;
      $('ask-extra').disabled = false;
      dialog.close();
      resolve(result ?? null);
    }
    $('ask-form').addEventListener('submit', onSubmit);
    $('ask-extra').addEventListener('click', onExtra);
    $('ask-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel); // the Escape key
    dialog.showModal();
    (name ? $('ask-name') : password ? $('ask-password') : $('ask-ok')).focus();
  });
}

const checkNewPassword = (password) => {
  if (password && password.length < 4) throw new Error('A password needs at least 4 characters.');
};

// What a ticket is for ({ kind, id }); the Mac checks the rest.
function ticketFor(ticket) {
  try {
    return JSON.parse(atob(ticket.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

// A guest opened something with a password: ask for it once (several calls can wait on it).
const unlocking = new Map();
function askToUnlock(lock) {
  const key = `${lock.kind}:${lock.id}`;
  if (!unlocking.has(key)) unlocking.set(key, unlockFlow(lock).finally(() => unlocking.delete(key)));
  return unlocking.get(key);
}

async function unlockFlow(lock) {
  const what = lock.kind === 'project' ? `The project "${lock.name}"` : `"${lock.name}"`;
  // Nothing of a locked list stays on screen while the password is asked for.
  const showing = current && (current.id === lock.id || current.projectId === lock.id);
  if (showing) document.body.classList.add('asking-password');
  const opened = await ask({
    title: `🔒 ${lock.name}`,
    about: `${what} is password protected. Enter its password to see and edit it.`,
    password: { label: 'Password', current: true },
    ok: 'Open',
    check: async ({ password }) => {
      const { unlock } = await postJson('/api/unlock', { kind: lock.kind, id: lock.id, password });
      unlocks = [...unlocks.filter((t) => ticketFor(t).id !== lock.id), unlock].slice(-50);
      remember('unlocks', JSON.stringify(unlocks));
      return true;
    },
  });
  document.body.classList.remove('asking-password');
  if (!opened) {
    if (showing && current && (current.id === lock.id || current.projectId === lock.id)) {
      current = null;
      resetEdits();
      showDocument(true);
      showDocumentPicker();
    }
    throw new CallProblem('That needs its password.', { status: 403, code: 'cancelled' });
  }
}

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
// A line being moved (see "Moving lines" below).
const drag = { timer: null, x: 0, y: 0, row: null, active: false, block: [], ghost: null, marker: null, target: undefined, offset: 0, scroll: 0, frame: 0, pickedBefore: null, swallowClick: false };
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
  // Never redraw under a line being dragged; it catches up when the drag ends.
  if (drag.active) {
    needsRender = true;
    return;
  }
  if (!force && !settled()) {
    needsRender = true;
    return;
  }
  needsRender = false;
  paper.replaceChildren();
  if (!current || current.notes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = current ? 'Nothing here yet. Tap Snap to add your first photo.' : 'Open a list from the ☰ DeScribe menu.';
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
  const option = ({ id, name, locked }) => {
    const item = document.createElement('option');
    item.value = id;
    item.textContent = locked ? `${name} 🔒` : name;
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
  if (!current) {
    // Nothing open (for example a guest who cancelled a password): picking any list opens it.
    const choose = option({ id: '', name: 'Pick a list…' });
    choose.disabled = true;
    groups.unshift(choose);
  }
  picker.replaceChildren(...groups);
  picker.value = current ? current.id : '';
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

async function createDocument(name, project = '', password = '') {
  if (current && !(await saveAllEdits())) {
    throw new Error("Your last change hasn't been saved yet. Try again once it's saved.");
  }
  const { document: created } = await postJson('/api/documents', password ? { name, project, password } : { name, project });
  documents.unshift({ id: created.id, name: created.name, project: created.project || '', locked: created.locked });
  current = created;
  resetEdits();
  remember('document', created.id);
  showDocumentPicker();
  showDocument(true);
  showPairPanel(true, '');
}

const PASSWORD_HINT = 'Optional. Leave it empty and anyone with the QR code can see and edit. With a password, they have to enter it first. You never need it.';

// "New list" (or "New file here" in a project): a name, and a password if you want one.
function askNewList(project = '') {
  return ask({
    title: project ? `New file in "${project}"` : 'New list',
    name: { label: 'Name' },
    password: { label: 'Password (optional)', hint: PASSWORD_HINT },
    ok: 'Create',
    check: async ({ name, password }) => {
      checkNewPassword(password);
      await createDocument(name, project, password);
      return true;
    },
  });
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

// --- Moving lines: hold a line, then drag it somewhere else ---------------------------
// Hold a line still for a moment (finger or mouse) and it lifts; a blue bar shows where
// it will land. A bullet takes its sub-bullets with it. While you're typing in a line,
// holding selects text as usual instead. The move is saved into Word like any edit.

const HOLD_MS = 400;

const rowsInOrder = () => [...paper.querySelectorAll('.row')];
const lineOf = (row) => row.querySelector('.line');
const isBulletRow = (row) => row.dataset.kind !== 'paragraph';

// The rows that move together: the line, and (for a bullet) the deeper bullets under it.
function blockFor(row) {
  const block = [row];
  if (!isBulletRow(row)) return block;
  const level = Number(row.dataset.level) || 0;
  for (let next = row.nextElementSibling; next?.classList.contains('row') && isBulletRow(next) && Number(next.dataset.level) > level; next = next.nextElementSibling) block.push(next);
  return block;
}

function canHold(row) {
  if (!current?.editable || !row) return false;
  const line = lineOf(row);
  return Boolean(line && line.dataset.para !== undefined && line.isContentEditable && line !== lineBeingEdited());
}

function holdStart(event, x, y) {
  holdCancel();
  if (drag.active) return;
  const row = event.target.closest?.('.row');
  if (!row || event.target.closest('.mark.toggle, .delete-note') || !canHold(row)) return;
  drag.row = row;
  drag.x = x;
  drag.y = y;
  drag.pickedBefore = picked;
  drag.timer = setTimeout(() => startDrag(x, y), HOLD_MS);
}

function holdCancel() {
  clearTimeout(drag.timer);
  drag.timer = null;
}

function startDrag(x, y) {
  drag.timer = null;
  const row = drag.row;
  if (!row?.isConnected) return;
  // Holding put the cursor in the line and picked it: undo both, this is a move.
  lineOf(row).blur();
  getSelection()?.removeAllRanges();
  picked = drag.pickedBefore;
  showPicked();
  drag.active = true;
  drag.block = blockFor(row);
  drag.target = undefined;
  navigator.vibrate?.(15);
  document.body.classList.add('dragging');
  drag.block.forEach((r) => r.classList.add('drag-source'));

  // A floating copy follows the finger; the bar marks where it will land.
  const box = row.getBoundingClientRect();
  drag.offset = y - box.top;
  drag.ghost = document.createElement('div');
  drag.ghost.className = 'drag-ghost';
  drag.ghost.style.width = `${paper.getBoundingClientRect().width - 24}px`;
  drag.ghost.style.left = `${paper.getBoundingClientRect().left + 12}px`;
  for (const r of drag.block) {
    const copy = r.cloneNode(true);
    copy.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
    drag.ghost.append(copy);
  }
  document.body.append(drag.ghost);
  drag.marker = document.createElement('div');
  drag.marker.className = 'drop-marker';
  paper.append(drag.marker);
  moveDrag(x, y);
  drag.frame = requestAnimationFrame(autoScroll);
}

// Where the block would land for a finger at height y: after a row, or at the top (null).
function dropTargetAt(y) {
  const rows = rowsInOrder().filter((r) => !drag.block.includes(r) && lineOf(r)?.dataset.para !== undefined);
  let target = null;
  for (const r of rows) {
    const box = r.getBoundingClientRect();
    if (y > box.top + box.height / 2) target = r;
    else break;
  }
  return target;
}

function moveDrag(x, y) {
  drag.x = x;
  drag.y = y;
  drag.ghost.style.top = `${y - drag.offset}px`;
  drag.target = dropTargetAt(y);
  // The bar goes just under the target row (or above the first row).
  const paperBox = paper.getBoundingClientRect();
  let barY;
  let barX = 20;
  if (drag.target) {
    const box = drag.target.getBoundingClientRect();
    barY = box.bottom + 2;
    barX = box.left - paperBox.left;
  } else {
    const first = rowsInOrder().find((r) => !drag.block.includes(r)) || drag.block[0];
    barY = first.getBoundingClientRect().top - 4;
  }
  drag.marker.style.top = `${barY - paperBox.top}px`;
  drag.marker.style.left = `${Math.max(12, barX)}px`;
  // Near the top or bottom of the screen, scroll.
  const edge = 70;
  drag.scroll = y < edge ? -Math.ceil((edge - y) / 5) : y > innerHeight - edge ? Math.ceil((y - (innerHeight - edge)) / 5) : 0;
}

function autoScroll() {
  if (!drag.active) return;
  if (drag.scroll) {
    scrollBy(0, drag.scroll);
    moveDrag(drag.x, drag.y);
  }
  drag.frame = requestAnimationFrame(autoScroll);
}

function endDrag(drop) {
  holdCancel();
  if (!drag.active) return;
  drag.active = false;
  cancelAnimationFrame(drag.frame);
  drag.swallowClick = true;
  setTimeout(() => {
    drag.swallowClick = false;
  }, 400);
  drag.ghost?.remove();
  drag.marker?.remove();
  document.body.classList.remove('dragging');
  drag.block.forEach((r) => r.classList.remove('drag-source'));
  const { block, target } = drag;
  drag.block = [];
  if (drop && target !== undefined) moveLines(block, target);
  else if (needsRender && settled()) showDocument(true);
}

// Saves the move into Word. The block's first line may step out a level so it fits where
// it lands: under a plain line or at the top it becomes a main bullet, and it is never
// more than one level deeper than the bullet above it.
async function moveLines(block, target) {
  const rows = rowsInOrder();
  const before = rows[rows.indexOf(block[0]) - 1] || null;
  const firstLevel = Number(block[0].dataset.level) || 0;
  let newLevel = firstLevel;
  if (isBulletRow(block[0])) {
    if (!target || !isBulletRow(target)) newLevel = 0;
    else newLevel = Math.min(firstLevel, (Number(target.dataset.level) || 0) + 1);
  }
  const levelShift = newLevel - firstLevel;
  const catchUp = () => {
    if (needsRender && settled()) showDocument(true);
  };
  if (target === before && levelShift === 0) return catchUp(); // dropped where it was
  if (!(await saveAllEdits())) {
    alert("Your last change hasn't been saved yet. Try again once it's saved.");
    return catchUp();
  }
  if (!block.every((r) => r.isConnected) || (target && !target.isConnected)) {
    showNotice('The list changed while you were moving that line. Try again.');
    return catchUp();
  }
  const lines = block.map(lineOf);
  const move = {
    op: 'move',
    paras: lines.map((l) => Number(l.dataset.para)),
    expects: lines.map((l) => l.dataset.expect),
    after: target ? Number(lineOf(target).dataset.para) : -1,
    afterExpect: target ? lineOf(target).dataset.expect : '',
    levelShift,
  };
  // Show it moved straight away; the Mac's answer then redraws it exactly.
  if (target) target.after(...block);
  else rowsInOrder()[0]?.before(...block);
  edits.inFlight = true;
  try {
    const result = await callJson(`/api/documents/${current.id}/edits`, { method: 'POST', type: 'application/json', body: JSON.stringify({ edits: [move] }) });
    if (result.indexMap) movePicks(result.indexMap);
    adopt(result.document);
    refreshPicks();
  } catch (problem) {
    showNotice(problem.message);
    try {
      adopt((await callJson(`/api/documents/${current.id}`)).document);
    } catch {
      // The next change or photo brings it up to date.
    }
  } finally {
    edits.inFlight = false;
    showDocument(true);
  }
}

// Mouse (laptop): press and hold without moving. Moving first selects text as usual.
paper.addEventListener('mousedown', (event) => {
  if (event.button === 0) holdStart(event, event.clientX, event.clientY);
});
document.addEventListener('mousemove', (event) => {
  if (drag.active) {
    event.preventDefault();
    moveDrag(event.clientX, event.clientY);
  } else if (drag.timer && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) {
    holdCancel();
  }
});
document.addEventListener('mouseup', () => endDrag(true));

// Touch (phone): hold still; moving first scrolls the page as usual.
paper.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1) return holdCancel();
  holdStart(event, event.touches[0].clientX, event.touches[0].clientY);
}, { passive: true });
document.addEventListener('touchmove', (event) => {
  const touch = event.touches[0];
  if (drag.active) {
    event.preventDefault(); // the page doesn't scroll while a line is being dragged
    moveDrag(touch.clientX, touch.clientY);
  } else if (drag.timer && Math.hypot(touch.clientX - drag.x, touch.clientY - drag.y) > 10) {
    holdCancel();
  }
}, { passive: false });
document.addEventListener('touchend', (event) => {
  if (drag.active) event.preventDefault(); // no tap after a drop
  endDrag(true);
}, { passive: false });
document.addEventListener('touchcancel', () => endDrag(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drag.active) endDrag(false);
});
// The click that follows letting go is not a tap on the line.
paper.addEventListener('click', (event) => {
  if (drag.swallowClick) {
    event.stopPropagation();
    event.preventDefault();
  }
}, true);
paper.addEventListener('contextmenu', (event) => {
  if (drag.active || drag.timer) event.preventDefault();
});

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
    label: item.label || '',
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
    if (item.state === 'failed' && item.kind === 'pdf') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => dropItem(item));
      row.append(remove);
    } else if (item.state === 'failed') {
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
    const what = photoLine.some((item) => item.kind === 'page' || item.kind === 'pdf') ? 'Adding' : 'Adding photos';
    $('progress-text').textContent = `${what}: ${Math.min(batch.finished + 1, batch.total)} of ${batch.total}`;
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
  if (item.preview?.startsWith('blob:')) URL.revokeObjectURL(item.preview);
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

// --- PDFs ----------------------------------------------------------------------------
// A PDF is split here into single pages, and each page then goes through exactly like a
// photo (in order, saved on this device, never added twice). The whole PDF is saved first,
// so nothing is lost if the phone locks mid-way. Each page's label comes from the PDF's own
// label and the page number, so splitting the same PDF again gives the same labels and the
// Mac skips any page it already added.

const MAX_PDF_PAGES = 100;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PAGE_BYTES = 20 * 1024 * 1024; // the most the Mac takes for one page
const PAGE_ORDER_STEP = 1000; // room after each file's place in line for its pages

const isPdfFile = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
const pageId = (pdfId, index) => pdfId.slice(0, 24) + index.toString(16).padStart(8, '0');

// A small picture for a PDF page in the list of what's being added.
function pagePreview(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><rect x="8" y="4" width="28" height="36" rx="3" fill="#fff" stroke="#9aa3b2"/><text x="22" y="20" font-family="sans-serif" font-size="8" font-weight="700" text-anchor="middle" fill="#b3261e">PDF</text><text x="22" y="32" font-family="sans-serif" font-size="9" text-anchor="middle" fill="#1d2433">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

let pdfLib = null;
const loadPdfLib = () => (pdfLib ??= import('/vendor/pdf-lib.esm.min.js'));

// Splits a saved PDF into page items that take its place in line.
async function splitPdf(item) {
  if (item.data.byteLength > MAX_PDF_BYTES) throw new Error('This PDF is over 100 MB. Split it into smaller PDFs first.');
  let lib;
  try {
    lib = await loadPdfLib();
  } catch {
    throw new Error("PDFs can't be opened right now. Check the connection to your Mac and try again.");
  }
  let source;
  try {
    source = await lib.PDFDocument.load(item.data, { updateMetadata: false });
  } catch (error) {
    // pdf-lib's own error type doesn't survive its build, so the message is checked too.
    if (error instanceof lib.EncryptedPDFError || /is encrypted/i.test(String(error?.message))) {
      throw new Error('This PDF is locked with a password. Save a copy without the password, then add that.');
    }
    throw new Error("This PDF is damaged and can't be read.");
  }
  let count;
  try {
    count = source.getPageCount(); // some broken files only fail here
  } catch {
    throw new Error("This PDF is damaged and can't be read.");
  }
  if (count === 0) throw new Error('This PDF has no pages.');
  if (count > MAX_PDF_PAGES) throw new Error(`This PDF has ${count} pages. Up to ${MAX_PDF_PAGES} can be added at once; split it into smaller PDFs.`);
  const pages = [];
  for (let index = 0; index < count; index += 1) {
    const one = await lib.PDFDocument.create();
    const [page] = await one.copyPages(source, [index]);
    one.addPage(page);
    const bytes = await one.save();
    const label = `${index + 1}/${count}`;
    const page_ = {
      id: pageId(item.id, index),
      order: item.order + index,
      documentId: item.documentId,
      under: item.under,
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      type: 'application/pdf',
      raw: false,
      kind: 'page',
      label: `Page ${index + 1} of ${count}`,
      preview: pagePreview(label),
      state: 'waiting',
      message: `Page ${index + 1} of ${count}: waiting…`,
    };
    if (bytes.byteLength > MAX_PAGE_BYTES) {
      page_.state = 'failed';
      page_.message = `Page ${index + 1} is over 20 MB, too large to send. Scan it at a lower quality.`;
    }
    pages.push(page_);
  }
  return pages;
}

function addPhotos(files) {
  const items = [...files].map((file) => {
    nextOrder += PAGE_ORDER_STEP;
    const pdf = isPdfFile(file);
    return {
      id: newPhotoId(),
      order: nextOrder,
      documentId: current.id,
      under: picked, // goes under the picked line (and the next one after it), or at the end
      file,
      kind: pdf ? 'pdf' : 'photo',
      preview: pdf ? pagePreview('…') : null,
      state: 'preparing',
      message: pdf ? 'Opening the PDF…' : 'Preparing…',
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
          item.type = item.kind === 'pdf' ? 'application/pdf' : item.file.type || 'image/jpeg';
          item.raw = true;
          await savePhoto({ ...item, state: 'waiting' });
        } catch {
          // Not saved early; it is still shrunk and saved below.
        }
      }
    }
    for (const item of items) {
      if (!photoLine.includes(item)) continue;
      if (item.kind === 'pdf') {
        try {
          if (!item.data) {
            item.data = await item.file.arrayBuffer();
            item.type = 'application/pdf';
            item.raw = true;
          }
          const pages = await splitPdf(item);
          // Pages are saved before the whole PDF is let go of, so a lock can't lose any.
          for (const page of pages) await savePhoto(page);
          const at = photoLine.indexOf(item);
          if (at >= 0) photoLine.splice(at, 1, ...pages);
          phoneStorage.remove('photos', item.id);
          batch.total += pages.length - 1;
          batch.finished += pages.filter((page) => page.state === 'failed').length;
          item.file = null;
          showTray();
        } catch (problem) {
          item.file = null;
          setItem(item, 'failed', problem.message);
          savePhoto(item);
          batch.finished += 1;
        }
        runLine();
        continue;
      }
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
    const isPdfRecord = record.type === 'application/pdf';
    const kind = isPdfRecord ? (record.raw ? 'pdf' : 'page') : 'photo';
    const item = {
      id: record.id,
      order: record.order,
      documentId: record.documentId,
      under,
      data: record.data,
      type: record.type,
      raw: Boolean(record.raw),
      kind,
      label: record.label || '',
      file: unshrunk ? new File([blob], kind === 'pdf' ? 'file.pdf' : 'photo', { type: record.type || 'image/jpeg' }) : null,
      preview: isPdfRecord ? pagePreview(kind === 'pdf' ? '…' : (record.label || '').replace(/^Page (\d+) of (\d+)$/, '$1/$2')) : unshrunk ? null : URL.createObjectURL(blob),
      state: record.state === 'failed' ? 'failed' : unshrunk ? 'preparing' : 'waiting',
      message:
        record.state === 'failed'
          ? record.message
          : unshrunk
            ? kind === 'pdf' ? 'Opening the PDF…' : 'Preparing…'
            : record.label ? `${record.label}: waiting…` : 'Waiting…',
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
  setItem(item, 'working', item.label ? `${item.label}: reading the handwriting…` : 'Reading the handwriting…');
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

// --- Word: open it, or download a copy -------------------------------------------
// You (the owner) can open the file straight from OneDrive, in the Word app or in Word
// on the web. Guests get a downloaded copy, since the file lives in your OneDrive.

function closeWordMenu() {
  $('word-menu').hidden = true;
  $('word').setAttribute('aria-expanded', 'false');
}

// The link that opens the file in the Word app. Word on a Mac (tested) wants the file's
// address with its name exactly as typed ("A&B 50%.docx"); with codes such as %20 it says it
// can't find the file. Word on iPhone and iPad is built the same way. Word on Windows gets
// Microsoft's standard form, with codes, which is what SharePoint's own links use.
const applePlatform = /Macintosh|iPhone|iPad|iPod/.test(navigator.userAgent);
function wordAppLink(webAddress) {
  let address = webAddress;
  if (applePlatform) {
    try {
      address = decodeURIComponent(webAddress);
    } catch {
      // Not a well-formed address: send it as it is.
    }
  }
  return `ms-word:ofe|u|${address}`;
}

async function openInWord(where) {
  closeWordMenu();
  if (!current?.wordUrl) return;
  if (where === 'app' && onThisMac) {
    // On the Mac DeScribe runs on, DeScribe opens Word itself: no browser prompt, any file name.
    try {
      if (!(await saveAllEdits())) throw new Error("Your last change hasn't been saved yet. Try again once it's saved.");
      await callJson(`/api/documents/${current.id}/open-in-word`, { method: 'POST' });
      showNotice(`Opening "${current.name}" in Word. New photos wait until you close it there.`);
    } catch (problem) {
      alert(problem.message);
    }
    return;
  }
  const address = where === 'web' ? `${current.wordUrl}?web=1` : wordAppLink(current.wordUrl);
  if (settled()) {
    // Nothing waiting to save: open straight away (browsers only allow this right after a tap).
    if (where === 'web') window.open(address, '_blank', 'noopener');
    else location.href = address;
    return;
  }
  const tab = where === 'web' ? window.open('', '_blank') : null;
  if (!(await saveAllEdits())) {
    tab?.close();
    alert("Your last change hasn't been saved yet. Try again once it's saved.");
    return;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = address;
  } else if (where === 'web') {
    window.open(address, '_blank', 'noopener');
  } else {
    location.href = address;
  }
}

async function downloadWord() {
  closeWordMenu();
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
  $('lock-message').textContent = linkProblem || message;
  $('passcode').value = '';
  showOnly('lock');
}

const PRACTICE_WORDING = {
  'no-key': 'Practice mode: photos become sample text until you add an AI key.',
  'no-passcode': 'Practice mode: add a passcode to your .env file to switch the AI on.',
};

// Opened from a QR code: the link carries the list's or project's permanent code. The
// Mac swaps it for a guest ticket that opens only that list or project.
let openProjectOnStart = '';

async function claimPairCode() {
  const code = new URLSearchParams(location.search).get('pair');
  if (!code) return;
  history.replaceState(null, '', '/');
  try {
    const paired = await postJson('/api/pair/claim', { code });
    // The owner scanning their own code stays the owner.
    let owner = false;
    if (passcode) {
      try {
        owner = (await callJson('/api/me')).role === 'owner';
      } catch {
        owner = false;
      }
    }
    if (!owner) {
      guest = paired.guest;
      remember('guest', guest);
      passcode = '';
      remember('passcode', '');
    }
    linkProblem = '';
    remember('linkProblem', '');
    if (paired.kind === 'project') {
      openProjectOnStart = paired.name;
      showNotice(`Connected to the project "${paired.name}". Pick a file to work on; everyone sees changes live.`);
    } else {
      remember('document', paired.id);
      showNotice('Connected. Everyone on this list sees every change live.');
    }
  } catch (problem) {
    showNotice(problem.message);
    // Not let in by anything else: the lock screen is what they'll see, so say it there.
    if (!guest && !passcode) linkProblem = problem.message;
  }
}

async function loadProjects() {
  try {
    ({ projects } = await callJson('/api/projects'));
  } catch {
    projects = []; // documents kept inside the app have no projects
  }
}

async function start() {
  try {
    await claimPairCode();
    const status = await callJson('/api/status');
    $('practice-banner').textContent = PRACTICE_WORDING[status.practiceReason] || '';
    $('practice-banner').hidden = status.mode !== 'practice';
    ({ role, onThisMac = false } = await callJson('/api/me'));
    document.body.classList.toggle('guest', role === 'guest');
    await loadProjects();

    ({ documents } = await callJson('/api/documents'));
    if (documents.length === 0) {
      if (role === 'owner') await createDocument('My notes');
      else showNotice('Nothing is in this project yet. Lists the owner adds will show up here.');
    } else {
      const inProject = openProjectOnStart && documents.find((doc) => doc.project === openProjectOnStart);
      const remembered = current?.id || recall('document');
      const id = inProject ? inProject.id : documents.some((doc) => doc.id === remembered) ? remembered : documents[0].id;
      try {
        await openDocument(id);
      } catch (problem) {
        if (problem.code !== 'cancelled') throw problem; // didn't enter the password: stay on the menu
      }
    }
    showOnly('main');
    if (!current) showDocument(true);
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
      showLock(passcode || guest || linkProblem ? problem.message : '');
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
  linkProblem = '';
  remember('linkProblem', '');
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
      headers: authHeaders(),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (response.status === 401) {
      // The passcode changed, or the owner reset this guest's link.
      live.controller = null;
      try {
        const details = (await response.json()).error || {};
        if (details.code === 'link') linkGone(details.message);
      } catch {
        // No details: the lock screen explains.
      }
      start();
      return;
    }
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
    // This list was deleted on another screen (or, for a guest, is no longer shared).
    const gone = current.name;
    current = null;
    resetEdits();
    try {
      if (documents.length) await openDocument(documents[0].id);
      else if (role === 'owner') await createDocument('My notes');
      else showDocument(true);
    } catch (problem) {
      if (problem.code !== 'cancelled') throw problem;
      showDocument(true);
    }
    showNotice(role === 'owner' ? `"${gone}" was deleted on another screen. It's in the Archive if you need it.` : `"${gone}" was deleted, or is no longer shared with you.`);
  } else if (role === 'guest' && current && documents.find((doc) => doc.id === current.id)?.locked) {
    // The owner just put a password on the list you have open.
    openDocument(current.id).catch(() => {});
  }
  if (role === 'owner') await loadProjects();
  showDocumentPicker();
  if (!$('menu').hidden) await refreshMenu();
}

// --- Laptop: QR code to connect a phone, and drag-and-drop photos ---------------------

const wideScreen = window.matchMedia('(min-width: 900px)');
let projects = [];
const pair = { shown: '', project: '' };

function pairStatus() {
  const locked = pair.project ? projects.find((p) => p.name === pair.project)?.locked : current?.locked;
  const who = locked ? 'Anyone with it also needs the password.' : 'Anyone with it can see and edit, no password needed.';
  return `This code never changes, so you can print it or send it. ${who} "Reset link" makes a new code and stops the old one working.`;
}

function showPairCode({ svg, url }) {
  $('pair-code').innerHTML = svg; // made by the Mac from a link it built itself
  $('pair-link').textContent = url;
  $('pair-status').textContent = pairStatus();
}

// The QR code is for the open file, or (when asked from a project) for the whole project.
// Each list and project keeps the same code until you reset it.
async function showPairPanel(force = false, project = undefined) {
  if (role !== 'owner') return;
  if (project !== undefined) pair.project = project || '';
  const wanted = force || wideScreen.matches || $('pair-panel').classList.contains('show');
  if (!wanted || !current) return;
  const key = pair.project ? `project:${pair.project}` : `list:${current.id}`;
  if (!force && pair.shown === key) return;
  pair.shown = key;
  $('pair-title').textContent = pair.project ? `Share: ${pair.project}` : `Share: ${current.name}`;
  $('pair-about').textContent = pair.project
    ? `Scan this to open the project "${pair.project}" and pick a file. Everyone sees every change live.`
    : "Scan this with a phone's camera to open this list. Everyone sees every change live.";
  try {
    showPairCode(await postJson('/api/pair', pair.project ? { project: pair.project } : { documentId: current.id }));
  } catch (problem) {
    $('pair-code').textContent = '';
    $('pair-status').textContent = problem.message;
  }
}

$('pair-reset').addEventListener('click', async () => {
  if (!current) return;
  const what = pair.project ? `the project "${pair.project}"` : `"${current.name}"`;
  if (!confirm(`Make a new QR code for ${what}?\n\nThe old code and link stop working straight away, and anyone using it is shut out until they scan the new one.`)) return;
  try {
    showPairCode(await postJson('/api/pair/reset', pair.project ? { project: pair.project } : { documentId: current.id }));
    showNotice('New QR code made. The old one no longer works.');
  } catch (problem) {
    $('pair-status').textContent = problem.message;
  }
});
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
  const photos = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/') || isPdfFile(file) || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name));
  if (!photos.length) {
    showNotice('Only photos and PDFs can be added here.');
    return;
  }
  if (current && !$('main').hidden) addPhotos(photos);
});

$('snap').addEventListener('click', () => $('camera').click());
$('choose').addEventListener('click', () => $('library').click());
$('word').addEventListener('click', (event) => {
  event.stopPropagation();
  if (!current) return;
  if (!current.wordUrl) {
    downloadWord(); // guests, and documents kept inside the app
    return;
  }
  const show = $('word-menu').hidden;
  $('word-menu').hidden = !show;
  $('word').setAttribute('aria-expanded', String(show));
});
$('word-app').addEventListener('click', () => openInWord('app'));
$('word-web').addEventListener('click', () => openInWord('web'));
$('word-download').addEventListener('click', downloadWord);
document.addEventListener('click', (event) => {
  if (!$('word-menu').hidden && !$('word-menu').contains(event.target)) closeWordMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeWordMenu();
});

for (const id of ['camera', 'library']) {
  $(id).addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = ''; // lets the same button be used again straight away
    if (files.length && current) addPhotos(files);
  });
}

$('document-picker').addEventListener('change', (event) => {
  openDocument(event.target.value).catch((problem) => {
    if (problem.code !== 'cancelled') alert(problem.message);
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


async function refreshMenu() {
  try {
    ({ documents } = await callJson('/api/documents'));
    await loadProjects();
    showDocumentPicker();
    showMenuLists();
  } catch (problem) {
    menuMessage(problem.message, true);
  }
  if (role !== 'owner') return; // guests have no Archive
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
  const open = menuButton(doc.locked ? `${doc.name} 🔒` : doc.name, async () => {
    closeMenu();
    try {
      await openDocument(doc.id);
    } catch (problem) {
      if (problem.code !== 'cancelled') alert(problem.message);
    }
  }, 'open-list');
  if (current?.id === doc.id) open.setAttribute('aria-current', 'true');
  if (role !== 'owner') {
    row.append(open);
    return row;
  }

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

  const key = passwordButton({ kind: 'list', ref: doc.id, name: doc.name, locked: doc.locked });
  const remove = menuButton('Delete', () => deleteList(doc), 'delete-list');
  remove.setAttribute('aria-label', `Delete ${doc.name}`);
  const actions = document.createElement('span');
  actions.className = 'file-actions';
  actions.append(move, key, remove);
  row.append(open, actions);
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
    title.textContent = `📁 ${project.name}${project.locked ? ' 🔒' : ''}`;
    const count = document.createElement('small');
    count.textContent = `${project.files} file${project.files === 1 ? '' : 's'}`;
    title.append(count);
    const actions = document.createElement('span');
    actions.className = 'project-actions';
    if (role === 'owner') actions.append(
      menuButton('QR', () => {
        closeMenu();
        $('pair-panel').classList.add('show');
        showPairPanel(true, project.name);
        $('pair-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }),
      menuButton('Rename', () => renameProject(project.name)),
      passwordButton({ kind: 'project', ref: project.name, name: project.name, locked: project.locked }),
      menuButton('Delete', () => deleteProject(project), 'delete-list'),
    );
    head.append(title, actions);
    rows.push(head);
    const files = documents.filter((doc) => doc.project === project.name);
    for (const doc of files) rows.push(fileRow(doc, true));
    if (role === 'owner') {
      const add = document.createElement('li');
      add.className = 'menu-file in-project';
      add.append(
        menuButton('+ New file here', async () => {
          if (await askNewList(project.name)) closeMenu();
        }, 'add-file'),
      );
      rows.push(add);
    }
  }
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-note';
    empty.textContent = 'No lists yet.';
    rows.push(empty);
  }
  $('menu-lists').replaceChildren(...rows);
}

// The 🔑 button: set, change or remove the password of a list or project (owner only).
function passwordButton(target) {
  const button = menuButton('🔑', () => changePassword(target), 'lock-button');
  button.setAttribute('aria-label', `Password for ${target.name}: ${target.locked ? 'on' : 'off'}`);
  button.title = target.locked ? 'Has a password. Tap to change or remove it.' : 'No password. Tap to add one.';
  return button;
}

async function changePassword({ kind, ref, name, locked }) {
  const where = kind === 'project' ? { project: ref } : { documentId: ref };
  const save = (password) => postJson('/api/access/password', { ...where, password });
  const about = locked
    ? `"${name}" has a password. Type a new one to change it (guests will need the new one), or remove it.`
    : kind === 'project'
      ? `Guests who open "${name}", or any file in it, will need this password. You never need it.`
      : `Guests with the QR code for "${name}" will need this password to see or edit it. You never need it.`;
  const done = await ask({
    title: `🔑 Password: ${name}`,
    about,
    password: { label: locked ? 'New password' : 'Password', hint: 'At least 4 characters.' },
    ok: 'Save',
    extra: locked
      ? {
          label: 'Remove password',
          run: async () => {
            await save(null);
            return 'removed';
          },
        }
      : null,
    check: async ({ password }) => {
      if (!password) throw new Error('Type a password, or press Cancel.');
      checkNewPassword(password);
      await save(password);
      return 'set';
    },
  });
  if (!done) return;
  await refreshMenu();
  if (kind === 'list' && current?.id === ref) current = { ...current, locked: done === 'set' };
  showPairPanel(true);
  menuMessage(done === 'removed' ? `"${name}" has no password now: anyone with its QR code can get in.` : `"${name}" now needs its password.`);
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
  const project = await ask({
    title: 'New project',
    name: { label: 'Name' },
    password: { label: 'Password (optional)', hint: `${PASSWORD_HINT} It covers every file in the project.` },
    ok: 'Create',
    check: async ({ name, password }) => {
      checkNewPassword(password);
      return (await postJson('/api/projects', password ? { name, password } : { name })).project;
    },
  });
  if (!project) return;
  await refreshMenu();
  menuMessage(`Project "${project.name}" made${project.locked ? ', with a password' : ''}. Add files with "+ New file here", or move files in with "Move".`);
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
$('menu-new').addEventListener('click', async () => {
  if (await askNewList()) closeMenu();
});

$('new-document').addEventListener('click', () => askNewList());

start();
