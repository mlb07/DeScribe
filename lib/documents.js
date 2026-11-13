// Two ways of keeping documents:
//  - createDocumentStore: small files in the app's own "documents" folder; the Word
//    file is made fresh from them whenever you download it.
//  - createFolderStore: real Word files in a folder (your OneDrive). Each photo is
//    added to the end of the Word file, so edits you make in Word are kept.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeParagraph, paragraphLike, replaceParagraphText, setParagraphList } from './docxbody.js';
import { copyNumbers, createGuessMemory, toPlainAndMarks } from './guesses.js';
import { buildWordFile, bulletListId, linesToNotes, openWordFile, placeNotes, readParagraphs, saveWordFile } from './word.js';

// A problem with a document, with the status to send to the phone.
export class StoreError extends Error {
  constructor(message, { status = 500, retryable = false, code = '' } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

// Runs jobs on one document strictly one at a time, in the order they arrive.
function createQueue() {
  const waiting = new Map();
  return (id, job) => {
    const before = waiting.get(id) || Promise.resolve();
    const result = before.then(job);
    const after = result.catch(() => {});
    waiting.set(id, after);
    after.then(() => {
      if (waiting.get(id) === after) waiting.delete(id);
    });
    return result;
  };
}

// Writes to a hidden temporary file first, so a power cut (or OneDrive syncing at the
// wrong moment) can never see a half-written file.
async function writeSafely(file, contents) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

const ID_PATTERN = /^[0-9a-f-]{36}$/;
const MAX_REMEMBERED_PHOTOS = 2000;

// A project name: like a file name, and "Archive" is kept for deleted things.
export function cleanProjectName(name) {
  const cleaned = cleanDocumentName(String(name ?? '').trim() ? name : 'New project');
  if (cleaned.toLowerCase() === 'archive') throw new StoreError('"Archive" is kept for deleted lists. Pick another project name.', { status: 400 });
  return cleaned;
}

export function cleanDocumentName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'My notes';
}

export function createDocumentStore(folder) {
  const fileFor = (id) => path.join(folder, `${id}.json`);

  async function save(doc) {
    doc.updatedAt = new Date().toISOString();
    doc.photoIds = doc.photoIds.slice(-MAX_REMEMBERED_PHOTOS);
    await mkdir(folder, { recursive: true });
    await writeSafely(fileFor(doc.id), JSON.stringify(doc));
    return doc;
  }

  async function get(id) {
    if (!ID_PATTERN.test(id)) return null;
    try {
      return JSON.parse(await readFile(fileFor(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    get,

    async addNotes(doc, notes, photoId) {
      doc.notes.push(...notes);
      doc.photoIds.push(photoId);
      return save(doc);
    },

    wordFile: (doc) => buildWordFile(doc.notes),

    create(name) {
      return save({ id: randomUUID(), name: cleanDocumentName(name), notes: [], photoIds: [] });
    },

    async list() {
      let files;
      try {
        files = await readdir(folder);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const docs = await Promise.all(
        files.filter((file) => file.endsWith('.json')).map((file) => get(file.slice(0, -'.json'.length))),
      );
      return docs
        .filter(Boolean)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }));
    },

    oneAtATime: createQueue(),
  };
}

// Word's "this file is open" marker: "~$" plus the name, with the first two letters
// dropped for longer names ("Rig notes.docx" -> "~$g notes.docx").
function isOpenMarkerFor(marker, fileName) {
  if (!marker.startsWith('~$')) return false;
  const rest = marker.slice(2);
  return rest.length >= fileName.length - 2 && fileName.endsWith(rest);
}

// Asks the Mac whether any app (Word, for example) has this file open right now.
// Word doesn't leave its usual "~$" marker for OneDrive files, so this is the reliable check.
export function isFileOpenOnMac(file) {
  return new Promise((resolve) => {
    execFile('lsof', ['-F', 'p', '--', file], { timeout: 5000 }, (error, stdout) => {
      if (error && error.code !== 1) return resolve(false); // lsof missing or failed: don't block photos
      const others = String(stdout || '')
        .split('\n')
        .filter((line) => line.startsWith('p') && line.slice(1) !== String(process.pid));
      resolve(others.length > 0);
    });
  });
}

const isWordFile = (name) => name.toLowerCase().endsWith('.docx') && !name.startsWith('~$') && !name.startsWith('.');

const MAX_EDITS = 500;
const MAX_LINE = 10000;

// Checks the changes sent by the phone are well formed before anything is touched.
function checkEdits(edits) {
  const bad = new StoreError('Those changes could not be understood.', { status: 400 });
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) throw bad;
  const isPara = (value) => Number.isInteger(value) && value >= 0 && value < 100000;
  const isText = (value) => typeof value === 'string' && value.length <= MAX_LINE;
  return edits.map((edit) => {
    if (!edit || typeof edit !== 'object') throw bad;
    if (edit.op === 'deleteNote') {
      const { paras, expects } = edit;
      if (!Array.isArray(paras) || !Array.isArray(expects) || paras.length === 0 || paras.length !== expects.length) throw bad;
      if (!paras.every(isPara) || !expects.every(isText)) throw bad;
      return { op: 'deleteNote', paras, expects };
    }
    if (!['set', 'insertAfter', 'delete', 'setKind'].includes(edit.op) || !isPara(edit.para) || !isText(edit.expect)) throw bad;
    if (edit.op === 'delete') return { op: 'delete', para: edit.para, expect: edit.expect };
    if (edit.op === 'setKind') {
      if (!['bullet', 'paragraph'].includes(edit.kind)) throw bad;
      const level = edit.level ?? 0;
      if (!Number.isInteger(level) || level < 0 || level > 2) throw bad;
      return { op: 'setKind', para: edit.para, expect: edit.expect, kind: edit.kind, level: edit.kind === 'paragraph' ? 0 : level };
    }
    if (!isText(edit.text)) throw bad;
    return { op: edit.op, para: edit.para, expect: edit.expect, text: cleanEditText(edit.text) };
  });
}

// A line typed on the phone: no line breaks or control characters, tidy spaces.
function cleanEditText(text) {
  return [...String(text).toWellFormed()]
    .map((char) => {
      const code = char.codePointAt(0);
      if (code === 9 || code === 10 || code === 13 || code === 0xa0) return ' ';
      if (code < 32 || code === 0xfffe || code === 0xffff) return '';
      return char;
    })
    .join('');
}

export function createFolderStore({ folder, indexFile, backupFolder, isFileOpen = isFileOpenOnMac }) {
  // Remembers an id for each Word file, and which photos are already in it.
  let index = null;
  let indexLoading = null;
  let indexWrites = Promise.resolve();

  // Loads the records once. Requests arriving together share the same load, so none of
  // them can replace the records another one is already using.
  function loadIndex() {
    indexLoading ??= (async () => {
      try {
        index = JSON.parse(await readFile(indexFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          indexLoading = null;
          throw error;
        }
        index = { files: {} };
      }
      index.files ??= {};
      return index;
    })();
    return indexLoading;
  }

  function saveIndex() {
    const snapshot = JSON.stringify(index);
    indexWrites = indexWrites.then(async () => {
      await mkdir(path.dirname(indexFile), { recursive: true });
      await writeSafely(indexFile, snapshot);
    });
    return indexWrites;
  }

  const archiveFolder = path.join(folder, 'Archive');

  async function archivedEntries() {
    const loaded = await loadIndex();
    loaded.archived ??= {};
    return loaded.archived;
  }

  async function archivedProjectEntries() {
    const loaded = await loadIndex();
    loaded.archivedProjects ??= {};
    return loaded.archivedProjects;
  }

  // A free name in the Archive: "Name", or "Name (archived 2026-11-13)", "... 2" and so on.
  async function freeArchiveName(base, extension) {
    let taken;
    try {
      taken = new Set((await readdir(archiveFolder)).map((n) => n.toLowerCase()));
    } catch {
      taken = new Set();
    }
    const day = new Date().toISOString().slice(0, 10);
    let name = `${base}${extension}`;
    for (let n = 1; taken.has(name.toLowerCase()); n += 1) name = `${base} (archived ${day}${n > 1 ? ` ${n}` : ''})${extension}`;
    return name;
  }

  // Refuses when any file of a project is open in Word on this Mac.
  async function nothingOpenIn(project, action) {
    for (const file of (await wordFileNames()).filter((f) => projectOf(f) === project)) {
      if (await openInWord(file)) {
        throw new StoreError(`"${shortName(file)}" in this project is open in Word on this Mac. Close it there first, then ${action}.`, {
          status: 409,
          code: 'open',
        });
      }
    }
  }

  // Puts an archived project folder back ("Name 2" if a project has that name again).
  async function restoreProject(archivedFolder) {
    const projects = await archivedProjectEntries();
    const archived = await archivedEntries();
    const base = projects[archivedFolder].originalName || archivedFolder;
    const taken = new Set((await projectNames()).map((n) => n.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
    try {
      await rename(path.join(archiveFolder, archivedFolder), path.join(folder, name));
    } catch (error) {
      if (error.code === 'ENOENT') {
        delete projects[archivedFolder];
        await saveIndex();
        throw new StoreError('That is not in the Archive any more.', { status: 404 });
      }
      throw new StoreError('That project could not be restored. Check OneDrive is running.', { status: 503, retryable: true });
    }
    const { files } = await loadIndex();
    for (const key of Object.keys(archived)) {
      if (key.startsWith(`${archivedFolder}/`)) {
        files[`${name}/${key.slice(archivedFolder.length + 1)}`] = archived[key];
        delete archived[key];
      }
    }
    delete projects[archivedFolder];
    await saveIndex();
    return { name };
  }

  // Projects are folders inside the DeScribe folder (except the Archive and hidden ones).
  // A file in a project is known by "Project/File.docx"; others just by "File.docx".
  const isProjectFolder = (entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name.toLowerCase() !== 'archive';

  async function projectNames() {
    await mkdir(folder, { recursive: true });
    return (await readdir(folder, { withFileTypes: true })).filter(isProjectFolder).map((entry) => entry.name);
  }

  async function wordFileNames() {
    await mkdir(folder, { recursive: true });
    const names = (await readdir(folder)).filter(isWordFile);
    for (const project of await projectNames()) {
      try {
        for (const name of (await readdir(path.join(folder, project))).filter(isWordFile)) names.push(`${project}/${name}`);
      } catch {
        // A project folder that vanished meanwhile has no files.
      }
    }
    return names;
  }

  const projectOf = (fileName) => (fileName.includes('/') ? fileName.slice(0, fileName.indexOf('/')) : '');
  const shortName = (fileName) => path.basename(fileName).replace(/\.docx$/i, '');

  // A free file name in a folder: "Name.docx", or "Name 2.docx" if that's taken.
  async function freeName(directory, base) {
    let taken;
    try {
      taken = new Set((await readdir(path.join(folder, directory))).map((n) => n.toLowerCase()));
    } catch {
      taken = new Set();
    }
    let name = `${base}.docx`;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}.docx`;
    return directory ? `${directory}/${name}` : name;
  }

  // Whether Word (on this Mac) has a file open: its "~$" marker, or the file held open.
  async function openInWord(fileName) {
    const full = path.join(folder, fileName);
    let names = [];
    try {
      names = await readdir(path.dirname(full));
    } catch {
      return false;
    }
    return names.some((name) => isOpenMarkerFor(name, path.basename(fileName))) || isFileOpen(full);
  }

  // Moves the memory (id, guesses, photos) of every file under an old name to a new one.
  function renameEntries(map, from, to) {
    for (const key of Object.keys(map)) {
      if (key === from || key.startsWith(`${from}/`)) {
        map[to + key.slice(from.length)] = map[key];
        delete map[key];
      }
    }
  }

  async function entryFor(fileName) {
    const { files } = await loadIndex();
    if (!files[fileName]) {
      files[fileName] = { id: randomUUID(), photoIds: [] };
      await saveIndex();
    }
    return files[fileName];
  }

  async function fileNameFor(id) {
    const { files } = await loadIndex();
    return Object.keys(files).find((name) => files[name].id === id) || null;
  }

  async function readWord(fileName) {
    try {
      return await readFile(path.join(folder, fileName));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new StoreError('That Word file could not be opened from OneDrive. Check OneDrive is running.', {
        status: 503,
        retryable: true,
      });
    }
  }

  async function view(id, fileName, buffer) {
    let lines;
    try {
      lines = await readParagraphs(buffer);
    } catch {
      throw new StoreError('That file could not be read as a Word document.', { status: 422 });
    }
    const entry = await entryFor(fileName);
    const guesses = createGuessMemory(entry.guesses);
    const copies = copyNumbers(lines.map((line) => line.words));
    lines.forEach((line, i) => {
      if (!line.blank && !line.locked) line.text = guesses.show(line.text, copies[i]);
    });
    return {
      id,
      name: shortName(fileName),
      project: projectOf(fileName),
      fileName,
      notes: linesToNotes(lines),
      photoIds: entry.photoIds,
      version: entry.version || 0,
      editable: true,
    };
  }

  async function backup(doc, record) {
    if (!backupFolder) return;
    // A plain record of every reading and edit, so nothing is lost even if the Word file is overwritten.
    await mkdir(backupFolder, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), file: doc.fileName, ...record });
    await writeFile(path.join(backupFolder, `${doc.id}.jsonl`), `${line}\n`, { flag: 'a' });
  }

  async function currentFile(doc) {
    const buffer = await readWord(doc.fileName);
    if (!buffer) throw new StoreError('That document no longer exists.', { status: 404 });
    return buffer;
  }

  return {
    async get(id) {
      const fileName = await fileNameFor(id);
      if (!fileName) return null;
      const buffer = await readWord(fileName);
      return buffer ? view(id, fileName, buffer) : null;
    },

    async list() {
      const names = await wordFileNames();
      const docs = await Promise.all(
        names.map(async (fileName) => {
          const { id } = await entryFor(fileName);
          const { mtime } = await stat(path.join(folder, fileName));
          return { id, name: shortName(fileName), project: projectOf(fileName), updatedAt: mtime.toISOString() };
        }),
      );
      return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async create(name, project = '') {
      const base = cleanDocumentName(name);
      if (project && !(await projectNames()).includes(project)) throw new StoreError('That project no longer exists.', { status: 404 });
      await mkdir(path.join(folder, project), { recursive: true });
      const fileName = await freeName(project, base);
      const buffer = await buildWordFile([]);
      await writeSafely(path.join(folder, fileName), buffer);
      const { id } = await entryFor(fileName);
      return view(id, fileName, buffer);
    },

    // Call before reading a photo or saving an edit, so nothing is paid for or lost
    // if the file can't be changed right now.
    async checkCanAdd(doc, what = 'photo') {
      if (await openInWord(doc.fileName)) {
        if (what === 'archive' || what === 'move') {
          const action = what === 'move' ? 'move it' : 'delete it';
          throw new StoreError(`"${doc.name}" is open in Word on this Mac. Close it there first, then ${action}.`, { status: 409, code: 'open' });
        }
        const waiting = what === 'edits' ? 'your changes will be saved' : 'your photo will be added';
        throw new StoreError(`"${doc.name}" is open in Word on this Mac. Close it there and ${waiting}.`, {
          status: 409,
          retryable: true,
          code: 'open',
        });
      }
    },

    // "original" is the AI's reading before it was turned into bullets (kept in the backup).
    // "under" is { para, expect }: the line the new lines go directly under. Without it, or
    // if that line can't be found any more (changed in Word), they go at the end.
    async addNotes(doc, notes, photoId, original = notes, under = null) {
      const current = await currentFile(doc);
      let updated;
      let added;
      let placement;
      try {
        let after = null;
        let placedAtEnd = false;
        if (under) {
          const { body } = await openWordFile(current);
          const texts = body.items.map((item) => (item.name === 'w:p' ? describeParagraph(item.xml).text : null));
          const fits = (i) => under.expect !== '' && texts[i] === under.expect;
          const matches = texts.map((_, i) => i).filter(fits);
          if (fits(under.para)) after = under.para;
          else if (matches.length === 1) after = matches[0];
          else placedAtEnd = true;
        }
        const result = await placeNotes(current, notes, after);
        updated = result.buffer;
        // Which copy of its words each new line is (for remembering its guesses).
        const lines = await readParagraphs(updated);
        const copies = copyNumbers(lines.map((line) => line.words));
        const copyAt = new Map(lines.map((line, i) => [line.para, copies[i]]));
        added = result.newLines.map(({ para, markup }) => ({ markup, copy: copyAt.get(para) ?? 0 }));
        placement = { lastPara: result.lastPara, indexMap: result.indexMap, placedAtEnd };
      } catch {
        throw new StoreError('That file could not be added to. Is it a normal Word document?', { status: 422 });
      }
      await writeSafely(path.join(folder, doc.fileName), updated);
      await backup(doc, { photoId, notes, original });
      const entry = await entryFor(doc.fileName);
      const guesses = createGuessMemory(entry.guesses);
      for (const { markup, copy } of added) guesses.insert(markup, copy);
      entry.guesses = guesses.entries();
      entry.photoIds = [...entry.photoIds, photoId].slice(-MAX_REMEMBERED_PHOTOS);
      entry.version = (entry.version || 0) + 1;
      await saveIndex();
      return { ...(await view(doc.id, doc.fileName, updated)), placement };
    },

    // Changes made on the phone's main screen. Each change names a line by its number
    // ("para") and by the words the phone saw there ("expect"), so a line that was
    // changed in Word meanwhile is never overwritten. All changes apply, or none do.
    //   { op: 'set', para, expect, text }          new words for a line ([[guesses]] allowed)
    //   { op: 'insertAfter', para, expect, text }  a new line after it, in the same list
    //   { op: 'delete', para, expect }             remove a line
    //   { op: 'deleteNote', paras, expects }       remove a card's lines and the blank line around them
    //   { op: 'setKind', para, expect, kind, level } make a line a bullet, or a plain line
    async applyEdits(doc, edits) {
      const changes = checkEdits(edits);
      const current = await currentFile(doc);
      let zip;
      let body;
      try {
        ({ zip, body } = await openWordFile(current));
      } catch {
        throw new StoreError('That file could not be read as a Word document.', { status: 422 });
      }
      const lines = body.items.map((item) => (item.name === 'w:p' ? describeParagraph(item.xml) : null));
      const entry = await entryFor(doc.fileName);
      const guesses = createGuessMemory(entry.guesses);

      // Find each line the phone means. If Word added or removed lines above it, the
      // same words can still be found, as long as they appear exactly once.
      const changed = new StoreError(
        'Part of this document was changed in Word since your phone last showed it, so your last change was not saved. The latest version is shown now.',
        { status: 409, code: 'changed' },
      );
      const find = (para, expect) => {
        const fits = (i) => lines[i] && lines[i].text === expect && !(expect === '' && lines[i].hasObjects);
        if (fits(para)) return para;
        const matches = lines.map((_, i) => i).filter(fits);
        if (expect !== '' && matches.length === 1) return matches[0];
        throw changed;
      };
      const locked = (i) => {
        if (lines[i].hasObjects || lines[i].hasSectionBreak) {
          throw new StoreError('That line has a picture or page break in it, so it can only be changed in Word.', {
            status: 409,
            code: 'locked',
          });
        }
      };

      const setTo = new Map(); // line -> new markup
      const removed = new Set();
      const insertsAfter = new Map(); // line -> [{ markup, change }]
      const kindTo = new Map(); // line -> { kind, level }
      const twice = () => new StoreError('Two changes were sent for the same line.', { status: 400 });
      const claim = (i) => {
        if (setTo.has(i) || removed.has(i) || kindTo.has(i)) throw twice();
      };
      for (const change of changes) {
        if (change.op === 'setKind') {
          const i = find(change.para, change.expect);
          locked(i);
          if (removed.has(i) || kindTo.has(i)) throw twice();
          kindTo.set(i, { kind: change.kind, level: change.level });
        } else if (change.op === 'set') {
          const i = find(change.para, change.expect);
          locked(i);
          if (setTo.has(i) || removed.has(i)) throw twice();
          if (toPlainAndMarks(change.text).text) setTo.set(i, change.text);
          else removed.add(i); // emptied: the line goes
        } else if (change.op === 'delete') {
          const i = find(change.para, change.expect);
          locked(i);
          claim(i);
          removed.add(i);
        } else if (change.op === 'insertAfter') {
          const i = find(change.para, change.expect);
          if (!toPlainAndMarks(change.text).text) continue; // an empty new line is not saved
          if (!insertsAfter.has(i)) insertsAfter.set(i, []);
          insertsAfter.get(i).push({ markup: change.text, change });
        } else {
          const found = change.paras.map((para, k) => find(para, change.expects[k]));
          found.forEach((i) => {
            locked(i);
            claim(i);
            removed.add(i);
          });
          // Also remove one empty line next to the card, so no double gap is left behind.
          const isGap = (i) => lines[i] && !lines[i].text && !lines[i].hasObjects && !lines[i].hasSectionBreak && !removed.has(i) && !setTo.has(i);
          const before = Math.min(...found) - 1;
          const after = Math.max(...found) + 1;
          if (isGap(before)) removed.add(before);
          else if (isGap(after)) removed.add(after);
        }
      }

      // A line made into a bullet joins the file's bullet list.
      const bulletList = [...kindTo.values()].some((k) => k.kind === 'bullet') ? await bulletListId(zip) : null;
      const withKind = (i, item) => {
        const change = kindTo.get(i);
        if (!change) return item;
        const xml = setParagraphList(item.xml, change.kind === 'bullet' ? bulletList : null, change.level);
        if (xml !== item.xml) wordChanged = true;
        return { name: 'w:p', xml };
      };

      // Build the new list of lines, and work out where each old line ended up.
      const items = [];
      const indexMap = body.items.map(() => -1);
      const results = changes.map(() => null);
      let wordChanged = false;
      body.items.forEach((item, i) => {
        if (removed.has(i)) {
          wordChanged = true;
        } else if (setTo.has(i)) {
          const { text } = toPlainAndMarks(setTo.get(i));
          indexMap[i] = items.length;
          if (text === lines[i].text) {
            items.push(withKind(i, item)); // same words (only a yellow mark was cleared): leave Word's line untouched
          } else {
            items.push(withKind(i, { name: 'w:p', xml: replaceParagraphText(item.xml, text) }));
            wordChanged = true;
          }
        } else {
          indexMap[i] = items.length;
          items.push(withKind(i, item));
        }
        for (const insert of insertsAfter.get(i) || []) {
          results[changes.indexOf(insert.change)] = items.length;
          items.push({ name: 'w:p', xml: paragraphLike(item.xml, toPlainAndMarks(insert.markup).text) });
          wordChanged = true;
        }
      });

      // Update the memory of guesses. Changed and removed lines are taken out first
      // (last copy first, so the copy numbers stay right), then changed and new lines
      // are put back in at their copy number in the finished document.
      const before = copyNumbers(lines.map((line) => line?.text ?? null));
      const outgoing = [...setTo.keys(), ...removed].filter((i) => lines[i]?.text);
      outgoing.sort((a, b) => before[b] - before[a]).forEach((i) => guesses.remove(lines[i].text, before[i]));
      const finalTexts = items.map((item) => (item.name === 'w:p' ? describeParagraph(item.xml).text : null));
      const after = copyNumbers(finalTexts);
      const incoming = [];
      for (const [i, markup] of setTo) incoming.push({ at: indexMap[i], markup });
      for (const list of insertsAfter.values()) for (const insert of list) incoming.push({ at: results[changes.indexOf(insert.change)], markup: insert.markup });
      incoming.sort((a, b) => after[a.at] - after[b.at]).forEach(({ at, markup }) => guesses.insert(markup, after[at]));

      let buffer = current;
      if (wordChanged) {
        body.items = items;
        buffer = await saveWordFile(zip, body);
        await writeSafely(path.join(folder, doc.fileName), buffer);
      }
      await backup(doc, { edits: changes });
      entry.guesses = guesses.entries();
      entry.version = (entry.version || 0) + 1;
      await saveIndex();
      return { document: await view(doc.id, doc.fileName, buffer), indexMap, results };
    },

    async wordFile(doc) {
      return currentFile(doc);
    },

    // --- Archive: deleted lists and projects are moved (never destroyed) to DeScribe/Archive --

    // What's in the Archive, newest first: single files, and whole projects (folders).
    // Word files or folders dropped in there by hand show too.
    async listArchive() {
      const archived = await archivedEntries();
      const projects = await archivedProjectEntries();
      let entries;
      try {
        entries = await readdir(archiveFolder, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const items = [];
      for (const entry of entries) {
        const full = path.join(archiveFolder, entry.name);
        if (entry.isFile() && isWordFile(entry.name)) {
          if (!archived[entry.name]) {
            archived[entry.name] = { id: randomUUID(), photoIds: [], archivedAt: (await stat(full)).mtime.toISOString() };
            await saveIndex();
          }
          const { id, archivedAt, originalName } = archived[entry.name];
          items.push({ type: 'file', id, name: shortName(entry.name), from: originalName ? projectOf(originalName) : '', archivedAt });
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          if (!projects[entry.name]) {
            projects[entry.name] = { id: randomUUID(), archivedAt: (await stat(full)).mtime.toISOString() };
            await saveIndex();
          }
          const files = (await readdir(full)).filter(isWordFile).length;
          const { id, archivedAt } = projects[entry.name];
          items.push({ type: 'project', id, name: entry.name, files, archivedAt });
        }
      }
      return items.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
    },

    // Moves a list's Word file into the Archive folder, keeping its memory (guesses, photos).
    async archive(doc) {
      await this.checkCanAdd(doc, 'archive');
      const archived = await archivedEntries();
      await mkdir(archiveFolder, { recursive: true });
      const target = await freeArchiveName(shortName(doc.fileName), '.docx');
      try {
        await rename(path.join(folder, doc.fileName), path.join(archiveFolder, target));
      } catch (error) {
        if (error.code === 'ENOENT') throw new StoreError('That list no longer exists.', { status: 404 });
        throw new StoreError('That list could not be moved to the Archive. Check OneDrive is running.', { status: 503, retryable: true });
      }
      const { files } = await loadIndex();
      archived[target] = { ...files[doc.fileName], archivedAt: new Date().toISOString(), originalName: doc.fileName };
      delete files[doc.fileName];
      await saveIndex();
      return { id: archived[target].id, name: shortName(target) };
    },

    // Puts an archived file (back into its project, if it had one) or a whole project back.
    async restore(id) {
      const archived = await archivedEntries();
      const projects = await archivedProjectEntries();
      const projectFolder = Object.keys(projects).find((name) => projects[name].id === id);
      if (projectFolder) return { project: await restoreProject(projectFolder) };

      const fileName = Object.keys(archived).find((name) => !name.includes('/') && archived[name].id === id);
      if (!fileName) throw new StoreError('That is not in the Archive any more.', { status: 404 });
      const { originalName, archivedAt, ...entry } = archived[fileName];
      void archivedAt;
      const project = originalName ? projectOf(originalName) : '';
      await mkdir(path.join(folder, project), { recursive: true }); // its project, made again if it was removed
      const target = await freeName(project, shortName(originalName || fileName));
      try {
        await rename(path.join(archiveFolder, fileName), path.join(folder, target));
      } catch (error) {
        if (error.code === 'ENOENT') {
          delete archived[fileName];
          await saveIndex();
          throw new StoreError('That is not in the Archive any more.', { status: 404 });
        }
        throw new StoreError('That could not be restored. Check OneDrive is running.', { status: 503, retryable: true });
      }
      const { files } = await loadIndex();
      files[target] = entry;
      delete archived[fileName];
      await saveIndex();
      return { document: await view(entry.id, target, await readFile(path.join(folder, target))) };
    },

    // --- Projects: folders that hold several files -----------------------------------------

    async listProjects() {
      const names = await projectNames();
      const all = await wordFileNames();
      return names
        .map((name) => ({ name, files: all.filter((file) => projectOf(file) === name).length }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    },

    async createProject(name) {
      const base = cleanProjectName(name);
      const taken = new Set((await projectNames()).map((n) => n.toLowerCase()));
      let project = base;
      for (let n = 2; taken.has(project.toLowerCase()); n += 1) project = `${base} ${n}`;
      await mkdir(path.join(folder, project), { recursive: true });
      return { name: project };
    },

    async renameProject(from, to) {
      if (!(await projectNames()).includes(from)) throw new StoreError('That project no longer exists.', { status: 404 });
      const name = cleanProjectName(to);
      if (name === from) return { name };
      const taken = (await projectNames()).filter((n) => n !== from).map((n) => n.toLowerCase());
      if (taken.includes(name.toLowerCase())) throw new StoreError(`There is already a project called "${name}".`, { status: 409 });
      await nothingOpenIn(from, 'rename the project');
      try {
        await rename(path.join(folder, from), path.join(folder, name));
      } catch {
        throw new StoreError('That project could not be renamed. Check OneDrive is running.', { status: 503, retryable: true });
      }
      const { files } = await loadIndex();
      renameEntries(files, from, name);
      await saveIndex();
      return { name };
    },

    // Moves a file into a project ('' = not in a project). Its id stays the same, so anyone
    // who has it open carries on without noticing.
    async moveDocument(doc, project) {
      if (project && !(await projectNames()).includes(project)) throw new StoreError('That project no longer exists.', { status: 404 });
      if (projectOf(doc.fileName) === project) return doc;
      await this.checkCanAdd(doc, 'move');
      const target = await freeName(project, shortName(doc.fileName));
      try {
        await rename(path.join(folder, doc.fileName), path.join(folder, target));
      } catch (error) {
        if (error.code === 'ENOENT') throw new StoreError('That list no longer exists.', { status: 404 });
        throw new StoreError('That list could not be moved. Check OneDrive is running.', { status: 503, retryable: true });
      }
      const { files } = await loadIndex();
      files[target] = files[doc.fileName];
      delete files[doc.fileName];
      await saveIndex();
      return view(doc.id, target, await readFile(path.join(folder, target)));
    },

    // Moves a whole project (folder and files) to the Archive.
    async archiveProject(name) {
      if (!(await projectNames()).includes(name)) throw new StoreError('That project no longer exists.', { status: 404 });
      await nothingOpenIn(name, 'delete the project');
      const projects = await archivedProjectEntries();
      const archived = await archivedEntries();
      await mkdir(archiveFolder, { recursive: true });
      const target = await freeArchiveName(name, '');
      try {
        await rename(path.join(folder, name), path.join(archiveFolder, target));
      } catch {
        throw new StoreError('That project could not be moved to the Archive. Check OneDrive is running.', { status: 503, retryable: true });
      }
      const { files } = await loadIndex();
      for (const key of Object.keys(files)) {
        if (key.startsWith(`${name}/`)) {
          archived[`${target}/${key.slice(name.length + 1)}`] = files[key];
          delete files[key];
        }
      }
      projects[target] = { id: randomUUID(), archivedAt: new Date().toISOString(), originalName: name };
      await saveIndex();
      return { id: projects[target].id, name: target };
    },

    oneAtATime: createQueue(),
  };
}
