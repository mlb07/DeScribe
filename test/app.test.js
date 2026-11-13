// Automated checks. Run them with: npm test
// They use a stand-in for the AI, so they are free.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import JSZip from 'jszip';
import { createApp } from '../lib/app.js';
import { createDocumentStore, createFolderStore, isFileOpenOnMac } from '../lib/documents.js';
import { createAiReader, createCheckedReader, needsSecondOpinion, ReadError } from '../lib/reader.js';
import { appendToWordFile, buildWordFile, paperBullets, readWordFile, splitGuesses, tidyNotes } from '../lib/word.js';
import { parseBody } from '../lib/docxbody.js';

const publicFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const cleanups = [];
after(() => Promise.all(cleanups.map((job) => job())));

async function tempFolder() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'photo-to-word-'));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

async function startApp({ reader, passcode = '', store, networkAddress = () => '192.168.1.50' }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'photo-to-word-'));
  const handler = createApp({
    store: store || createDocumentStore(folder),
    reader,
    mode: 'ai',
    passcode,
    networkAddress,
    loadCrew: async () => ({ crewInfo: '', crewWords: [] }),
    publicFolder,
    log: { error() {} },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, options = {}) =>
    fetch(base + route, {
      ...options,
      headers: { 'X-App': 'photo-to-word', 'X-Passcode': passcode, ...options.headers },
    });
  return { call, base };
}

const noteSaying = (text) => ({ notes: [{ blocks: [{ kind: 'paragraph', level: 0, text }] }], issue: '' });

async function newDocument(call, name = 'Test') {
  const response = await call('/api/documents', { method: 'POST', body: JSON.stringify({ name }) });
  return (await response.json()).document.id;
}

const sendPhoto = (call, id, photo, body = JPEG) =>
  call(`/api/documents/${id}/photos?photo=${photo}`, { method: 'POST', body });

const LABEL = (n) => String(n).padStart(32, 'a');

async function wordXml(buffer, part = 'word/document.xml') {
  return (await JSZip.loadAsync(buffer)).file(part).async('string');
}

test('square brackets become highlighted pieces', () => {
  assert.deepEqual(splitGuesses('more [[time]] here'), [
    { text: 'more ', guess: false },
    { text: 'time', guess: true },
    { text: ' here', guess: false },
  ]);
  assert.deepEqual(splitGuesses('stray [[ bracket'), [{ text: 'stray  bracket', guess: false }]);
});

test('odd answers from the AI are tidied or dropped', () => {
  assert.deepEqual(
    tidyNotes([
      { blocks: [{ kind: 'heading', level: 9, text: '  hello\nthere ' }, { kind: 'bullet', level: 0, text: '   ' }] },
      { blocks: [{ kind: 'bullet', level: 0, text: '[[ ]]' }] },
      { nonsense: true },
    ]),
    [{ blocks: [{ kind: 'paragraph', level: 2, text: 'hello there' }] }],
  );
  assert.deepEqual(tidyNotes('nope'), []);
});

test('Word file has no highlighting, safe text, and lists that restart at 1', async () => {
  const buffer = await buildWordFile([
    { blocks: [{ kind: 'paragraph', level: 0, text: 'Tom & <Jerry> [[maybe]]' }] },
    { blocks: [{ kind: 'numbered', level: 0, text: 'one' }, { kind: 'bullet', level: 1, text: 'sub' }, { kind: 'numbered', level: 0, text: 'two' }] },
    { blocks: [{ kind: 'numbered', level: 0, text: 'again' }] },
  ]);
  const xml = await wordXml(buffer);
  assert.match(xml, /Tom &amp; &lt;Jerry&gt; /);
  assert.match(xml, /Tom &amp; &lt;Jerry&gt; maybe</);
  assert.doesNotMatch(xml, /highlight|\[\[/);
  assert.deepEqual([...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]), ['1', '2', '1', '3']);
  const numbering = await wordXml(buffer, 'word/numbering.xml');
  assert.equal(numbering.match(/<w:abstractNum /g).length, 3);
  assert.ok(numbering.lastIndexOf('<w:abstractNum ') < numbering.indexOf('<w:num '));
});

test('an empty document is still a valid Word file', async () => {
  assert.match(await wordXml(await buildWordFile([])), /<w:body><w:p\/><w:sectPr>/);
});

test('photos are added in the order sent, even if reading takes different times', async () => {
  let count = 0;
  const reader = {
    async read() {
      const number = ++count;
      await new Promise((resolve) => setTimeout(resolve, number === 1 ? 60 : 1));
      return noteSaying(`photo ${number}`);
    },
  };
  const { call } = await startApp({ reader });
  const id = await newDocument(call);
  await Promise.all([1, 2, 3].map((n) => sendPhoto(call, id, LABEL(n))));
  const { document } = await (await call(`/api/documents/${id}`)).json();
  assert.deepEqual(document.notes.map((note) => note.blocks[0].text), ['photo 1', 'photo 2', 'photo 3']);
});

test('the same photo sent twice is only added and paid for once', async () => {
  let reads = 0;
  const { call } = await startApp({ reader: { read: async () => (reads++, noteSaying('once')) } });
  const id = await newDocument(call);
  await sendPhoto(call, id, LABEL(1));
  const second = await (await sendPhoto(call, id, LABEL(1))).json();
  assert.equal(second.added, 0);
  assert.equal(second.document.notes.length, 1);
  assert.equal(reads, 1);
});

test('a photo with no handwriting adds nothing and says why', async () => {
  const reader = { read: async () => ({ notes: [], issue: 'The photo is too blurry to read.' }) };
  const { call } = await startApp({ reader });
  const id = await newDocument(call);
  const result = await (await sendPhoto(call, id, LABEL(1))).json();
  assert.equal(result.issue, 'The photo is too blurry to read.');
  assert.equal(result.document.notes.length, 0);
});

test('a failed read says whether to retry, and adds nothing', async () => {
  const reader = {
    read: async () => {
      throw new ReadError('Busy.', { status: 503, retryable: true });
    },
  };
  const { call } = await startApp({ reader });
  const id = await newDocument(call);
  const response = await sendPhoto(call, id, LABEL(1));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { message: 'Busy.', retryable: true } });
});

test('files that are not photos, and oversized photos, are refused', async () => {
  let reads = 0;
  const { call } = await startApp({ reader: { read: async () => (reads++, noteSaying('x')) } });
  const id = await newDocument(call);
  assert.equal((await sendPhoto(call, id, LABEL(1), Buffer.from('this is not a photo at all'))).status, 415);
  assert.equal((await sendPhoto(call, id, LABEL(2), Buffer.alloc(6 * 1024 * 1024, 1))).status, 413);
  assert.equal(reads, 0);
});

test('the passcode protects documents and locks out repeated guesses', async () => {
  const { base, call } = await startApp({ reader: { read: async () => noteSaying('x') }, passcode: 'rig2026' });
  assert.equal((await call('/api/documents')).status, 200);
  const guess = () => fetch(`${base}/api/documents`, { headers: { 'X-Passcode': 'wrong' } });
  for (let i = 0; i < 10; i += 1) assert.equal((await guess()).status, 401);
  assert.equal((await guess()).status, 429);
  assert.equal((await call('/api/documents')).status, 429);
});

test('changes need the app label, and private files stay private', async () => {
  const { base, call } = await startApp({ reader: { read: async () => noteSaying('x') } });
  assert.equal((await fetch(`${base}/api/documents`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2f..%2fserver.js`)).status, 404);
  assert.equal((await call('/api/documents/not-a-real-id')).status, 404);
});

test('the Word download comes back named after the document', async () => {
  const { call } = await startApp({ reader: { read: async () => noteSaying('hello [[there]]') } });
  const id = await newDocument(call, 'Rig notes/November');
  await sendPhoto(call, id, LABEL(1));
  const response = await call(`/api/documents/${id}/word`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /Rig%20notes%20November\.docx/);
  assert.match(await wordXml(Buffer.from(await response.arrayBuffer())), /there/);
});

function fakeAi(behaviour) {
  const calls = [];
  return {
    calls,
    client: { beta: { messages: { parse: async (request) => (calls.push(request), behaviour()) } } },
  };
}

const readerInput = { image: JPEG, crewInfo: 'A drilling crew.', crewWords: ['Pump 3'] };

test('the AI is sent the photo and the crew words, and its answer comes back', async () => {
  const fake = fakeAi(() => ({ stop_reason: 'end_turn', parsed_output: noteSaying('read it') }));
  const result = await createAiReader({ client: fake.client }).read(readerInput);
  assert.equal(result.notes[0].blocks[0].text, 'read it');
  const request = fake.calls[0];
  assert.equal(request.model, 'claude-sonnet-5-5');
  const [image, words] = request.messages[0].content;
  assert.equal(image.source.media_type, 'image/jpeg');
  assert.equal(image.source.data, JPEG.toString('base64'));
  assert.match(words.text, /A drilling crew\./);
  assert.match(words.text, /- Pump 3/);
});

test('a different model can be chosen', async () => {
  const fake = fakeAi(() => ({ stop_reason: 'end_turn', parsed_output: noteSaying('ok') }));
  await createAiReader({ client: fake.client, model: 'claude-sonnet-5-5' }).read(readerInput);
  assert.equal(fake.calls[0].model, 'claude-sonnet-5-5');
});

test('AI problems turn into plain messages', async () => {
  const headers = new Headers();
  const cases = [
    [new Anthropic.RateLimitError(429, {}, 'slow down', headers), 503, true],
    [new Anthropic.AuthenticationError(401, {}, 'bad key', headers), 500, false],
    [new Anthropic.BadRequestError(400, {}, 'Your credit balance is too low', headers), 422, false],
    [new Anthropic.InternalServerError(529, {}, 'overloaded', headers), 503, true],
    [new Anthropic.NotFoundError(404, {}, 'model: claude-typo', headers), 500, false],
  ];
  for (const [problem, status, retryable] of cases) {
    const fake = fakeAi(() => {
      throw problem;
    });
    await assert.rejects(createAiReader({ client: fake.client }).read(readerInput), (error) => {
      assert.ok(error instanceof ReadError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
});

test('a refused or cut-off AI answer is explained', async () => {
  for (const stop_reason of ['refusal', 'max_tokens']) {
    const fake = fakeAi(() => ({ stop_reason, parsed_output: null }));
    await assert.rejects(createAiReader({ client: fake.client }).read(readerInput), (error) => error.status === 422);
  }
});

test('the AI is asked to think before answering', async () => {
  const fake = fakeAi(() => ({ stop_reason: 'end_turn', parsed_output: noteSaying('ok') }));
  await createAiReader({ client: fake.client }).read(readerInput);
  assert.deepEqual(fake.calls[0].thinking, { type: 'adaptive' });
});

const reads = (text, model) => ({ notes: text === null ? [] : [{ blocks: [{ kind: 'paragraph', level: 0, text }] }], issue: '', model });

test('a second opinion is only asked for when the first reading has guesses', async () => {
  assert.equal(needsSecondOpinion(reads('all clear', 'cheap')), false);
  assert.equal(needsSecondOpinion(reads('one [[guess]] here', 'cheap')), true);
  assert.equal(needsSecondOpinion(reads(null, 'cheap')), true);
  let secondCalls = 0;
  const second = { read: async () => (secondCalls++, reads('checked', 'strong')) };
  const sure = createCheckedReader({ first: { read: async () => reads('all clear', 'cheap') }, second });
  assert.equal((await sure.read({})).notes[0].blocks[0].text, 'all clear');
  assert.equal(secondCalls, 0);
  const unsure = createCheckedReader({ first: { read: async () => reads('a [[guess]]', 'cheap') }, second });
  assert.equal((await unsure.read({})).notes[0].blocks[0].text, 'checked');
  assert.equal(secondCalls, 1);
});

test('if the second opinion fails, the first reading is kept', async () => {
  const reader = createCheckedReader({
    first: { read: async () => reads('a [[guess]]', 'cheap') },
    second: { read: async () => { throw new ReadError('Busy.', { status: 503, retryable: true }); } },
  });
  assert.equal((await reader.read({})).notes[0].blocks[0].text, 'a [[guess]]');
});

test('if the first reading fails, nothing is guessed and the error is passed on', async () => {
  let secondCalls = 0;
  const reader = createCheckedReader({
    first: { read: async () => { throw new ReadError('Busy.', { status: 503, retryable: true }); } },
    second: { read: async () => (secondCalls++, reads('x', 'strong')) },
  });
  await assert.rejects(reader.read({}), (error) => error.retryable === true);
  assert.equal(secondCalls, 0);
});

// --- Word files that already exist (OneDrive) -------------------------------------

const bullets = (...texts) => ({ blocks: texts.map((text) => ({ kind: 'bullet', level: 0, text })) });
const numbered = (...texts) => ({ blocks: texts.map((text) => ({ kind: 'numbered', level: 0, text })) });
const para = (text) => ({ blocks: [{ kind: 'paragraph', level: 0, text }] });
const allLines = (notes) => notes.flatMap((note) => note.blocks);

test('a Word file reads back the same: lists and numbers (guesses as plain words), each top line its own card', async () => {
  const notes = [para('Hello [[maybe]] there'), bullets('one', 'two'), numbered('first', 'second')];
  const read = await readWordFile(await buildWordFile(notes));
  assert.deepEqual(allLines(read), allLines([para('Hello maybe there'), bullets('one', 'two'), numbered('first', 'second')]));
  assert.equal(read.length, 5);
});

test('adding to a new, empty Word file starts at the top', async () => {
  const added = await appendToWordFile(await buildWordFile([]), [para('first note')]);
  assert.deepEqual(await readWordFile(added), [para('first note')]);
  assert.doesNotMatch(await wordXml(added), /<w:body><w:p\/>/);
});

test('adding keeps what is already there, adds no blank lines, and lists still work', async () => {
  let file = await buildWordFile([numbered('a', 'b'), bullets('x')]);
  file = await appendToWordFile(file, [numbered('c'), bullets('y [[z]]')]);
  assert.deepEqual(allLines(await readWordFile(file)), allLines([numbered('a', 'b'), bullets('x'), numbered('c'), bullets('y z')]));
  assert.doesNotMatch(await wordXml(file), /<w:p\/>/);
  const numbering = await wordXml(file, 'word/numbering.xml');
  const recipeIds = [...numbering.matchAll(/w:abstractNumId="(\d+)"/g)].map((m) => m[1]);
  const listIds = [...numbering.matchAll(/<w:num w:numId="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(listIds).size, listIds.length, 'no list number is used twice');
  assert.ok(numbering.lastIndexOf('<w:abstractNum ') < numbering.indexOf('<w:num '));
  assert.ok(recipeIds.length >= 3); // the new bullets reuse the existing bullet list
  // The new numbered list starts at 1 again: it has its own list number.
  const used = [...(await wordXml(file)).matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
  assert.notEqual(used[0], used[3]);
});

test('adding works on a Word file that never had lists, and on one edited in Word', async () => {
  // A bare-bones file like other programs make: no list settings at all.
  const zip = await JSZip.loadAsync(await buildWordFile([para('typed by hand')]));
  zip.remove('word/numbering.xml');
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace(/<Override PartName="\/word\/numbering.xml"[^>]*\/>/, ''));
  zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace(/<Relationship Id="rId2"[^>]*\/>/, ''));
  // Word-style extras: attributes, a trailing empty line, page settings inside the last paragraph.
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replace('<w:p><w:r>', '<w:p w14:paraId="1A2B"><w:r w:rsidR="00AB">').replace('<w:sectPr>', '<w:p><w:pPr><w:sectPr w:rsidR="1">').replace('</w:sectPr></w:body>', '</w:sectPr></w:pPr></w:p></w:body>');
  zip.file('word/document.xml', xml);
  const plain = await zip.generateAsync({ type: 'nodebuffer' });

  const added = await appendToWordFile(plain, [bullets('new [[item]]')]);
  assert.deepEqual(await readWordFile(added), [para('typed by hand'), bullets('new item')]);
  const types = await (await JSZip.loadAsync(added)).file('[Content_Types].xml').async('string');
  assert.match(types, /\/word\/numbering.xml/);
  assert.match(await wordXml(added, 'word/_rels/document.xml.rels'), /numbering\.xml/);
  assert.match(await wordXml(added), /<w:sectPr w:rsidR="1">/, 'page settings kept');
});

test('edits made in Word show in the preview, even when Word splits the text into pieces', async () => {
  const zip = await JSZip.loadAsync(await buildWordFile([para('the pump is down')]));
  let xml = await zip.file('word/document.xml').async('string');
  // Someone changed a word in Word; Word stored the line as several differently formatted pieces.
  xml = xml.replace('<w:r><w:t xml:space="preserve">the pump is down</w:t></w:r>', '<w:r><w:t xml:space="preserve">the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>pu</w:t></w:r><w:r><w:t xml:space="preserve">mp &amp; motor is down</w:t></w:r>');
  zip.file('word/document.xml', xml);
  assert.deepEqual(await readWordFile(await zip.generateAsync({ type: 'nodebuffer' })), [para('the pump & motor is down')]);
});

async function folderApp(reader, { isFileOpen = async () => false, passcode = '' } = {}) {
  const folder = await tempFolder();
  const store = createFolderStore({
    folder: path.join(folder, 'OneDrive', 'DeScribe'),
    indexFile: path.join(folder, 'index.json'),
    backupFolder: path.join(folder, 'backup'),
    isFileOpen,
  });
  return { ...(await startApp({ reader, store, passcode })), store, wordFolder: path.join(folder, 'OneDrive', 'DeScribe'), backup: path.join(folder, 'backup') };
}

test('OneDrive folder: new documents are Word files, and photos are added to them', async () => {
  let count = 0;
  const { call, wordFolder } = await folderApp({ read: async () => noteSaying(`photo ${++count}`) });
  const id = await newDocument(call, 'Rig notes');
  const second = await newDocument(call, 'Rig notes');
  assert.notEqual(id, second);
  assert.deepEqual((await readdir(wordFolder)).filter((n) => !n.startsWith('.')).sort(), ['Rig notes 2.docx', 'Rig notes.docx']);

  await sendPhoto(call, id, LABEL(1));
  const result = await (await sendPhoto(call, id, LABEL(2))).json();
  assert.deepEqual(result.document.notes.map((n) => n.blocks[0].text), ['photo 1', 'photo 2']);
  assert.deepEqual((await readWordFile(await readFile(path.join(wordFolder, 'Rig notes.docx')))).length, 2);

  const listed = (await (await call('/api/documents')).json()).documents.map((d) => d.name).sort();
  assert.deepEqual(listed, ['Rig notes', 'Rig notes 2']);
  const download = await call(`/api/documents/${id}/word`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), await readFile(path.join(wordFolder, 'Rig notes.docx')));
});

test('OneDrive folder: edits made in Word are kept when more photos come in', async () => {
  const { call, wordFolder } = await folderApp({ read: async () => noteSaying('from the photo') });
  const id = await newDocument(call, 'Edited');
  await sendPhoto(call, id, LABEL(1));
  const file = path.join(wordFolder, 'Edited.docx');
  // Simulate fixing a word in Word.
  const zip = await JSZip.loadAsync(await readFile(file));
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('from the photo', 'fixed in Word'));
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));

  const result = await (await sendPhoto(call, id, LABEL(2))).json();
  assert.deepEqual(result.document.notes.map((n) => n.blocks[0].text), ['fixed in Word', 'from the photo']);
});

test('OneDrive folder: a Word file you drop in can be picked, and a resent photo is not added twice', async () => {
  let reads = 0;
  const { call, wordFolder } = await folderApp({ read: async () => (reads++, noteSaying('added')) });
  await call('/api/documents'); // makes the folder
  await writeFile(path.join(wordFolder, 'My own.docx'), await buildWordFile([para('my own text')]));
  await writeFile(path.join(wordFolder, '~$My own.docx'), 'lock'); // Word's marker files are not documents
  const { documents } = await (await call('/api/documents')).json();
  assert.deepEqual(documents.map((d) => d.name), ['My own']);
  const id = documents[0].id;
  await rm(path.join(wordFolder, '~$My own.docx'));
  await sendPhoto(call, id, LABEL(1));
  const again = await (await sendPhoto(call, id, LABEL(1))).json();
  assert.equal(again.added, 0);
  assert.equal(reads, 1);
  assert.deepEqual(again.document.notes.map((n) => n.blocks[0].text), ['my own text', 'added']);
});

test('OneDrive folder: while the file is open in Word, the photo waits and is not paid for twice', async () => {
  let reads = 0;
  const { call, wordFolder } = await folderApp({ read: async () => (reads++, noteSaying('waited')) });
  const id = await newDocument(call, 'Open in Word');
  const marker = path.join(wordFolder, '~$en in Word.docx');
  await writeFile(marker, 'lock');
  const blocked = await sendPhoto(call, id, LABEL(1));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.retryable, true);
  assert.equal(reads, 0, 'not read while the file is open');
  await rm(marker);
  const done = await (await sendPhoto(call, id, LABEL(1))).json();
  assert.equal(done.added, 1);
  assert.equal(reads, 1);
});

test('OneDrive folder: a photo read just as the file is opened is not paid for again', async () => {
  let reads = 0;
  let marker;
  const { call, wordFolder } = await folderApp({
    read: async () => {
      reads++;
      await writeFile(marker, 'lock'); // someone opens it in Word while the photo is being read
      return noteSaying('read once');
    },
  });
  const id = await newDocument(call, 'Racing');
  marker = path.join(wordFolder, '~$cing.docx');
  assert.equal((await sendPhoto(call, id, LABEL(1))).status, 409);
  await rm(marker);
  const done = await (await sendPhoto(call, id, LABEL(1))).json();
  assert.equal(done.added, 1);
  assert.equal(reads, 1);
});

test('blank lines saved by Word (with extra labels) still split notes, and adding after them works', async () => {
  const zip = await JSZip.loadAsync(await buildWordFile([para('first'), para('second')]));
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replace('<w:p/>', '<w:p w14:paraId="0A1B2C3D" w14:textId="77777777" w:rsidR="00C1"/>');
  zip.file('word/document.xml', xml);
  const saved = await zip.generateAsync({ type: 'nodebuffer' });
  assert.deepEqual(await readWordFile(saved), [para('first'), para('second')]);
  assert.deepEqual(await readWordFile(await appendToWordFile(saved, [para('third')])), [para('first'), para('second'), para('third')]);
});

test('OneDrive folder: while Word has the file open (no marker file), photos wait', async () => {
  let open = true;
  let reads = 0;
  const { call } = await folderApp({ read: async () => (reads++, noteSaying('later')) }, { isFileOpen: async () => open });
  const id = await newDocument(call, 'Held open');
  const blocked = await sendPhoto(call, id, LABEL(1));
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error.message, /open in Word/);
  assert.equal(reads, 0);
  open = false;
  assert.equal((await (await sendPhoto(call, id, LABEL(1))).json()).added, 1);
});

test('OneDrive folder: every reading is also kept as a backup', async () => {
  const { call, backup } = await folderApp({ read: async () => noteSaying('keep me') });
  const id = await newDocument(call, 'Backed up');
  await sendPhoto(call, id, LABEL(1));
  const lines = (await readFile(path.join(backup, `${id}.jsonl`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].notes[0].blocks[0].text, 'keep me');
});

test('the Mac can tell when a file is held open by another program', async () => {
  const folder = await tempFolder();
  const file = path.join(folder, 'held.docx');
  await writeFile(file, 'x');
  assert.equal(await isFileOpenOnMac(file), false);
  const { spawn } = await import('node:child_process');
  const holder = spawn('sh', ['-c', `exec 3<"${file}"; sleep 5`]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    assert.equal(await isFileOpenOnMac(file), true);
  } finally {
    holder.kill();
  }
});

// --- One bullet per paper ------------------------------------------------------------

const P = (text) => ({ kind: 'paragraph', level: 0, text });
const B = (text, level = 0) => ({ kind: 'bullet', level, text });
const N = (text, level = 0) => ({ kind: 'numbered', level, text });
const card = (...blocks) => ({ blocks });
const shape = (notes) => notes.map((n) => n.blocks.map((b) => `${b.kind[0]}${b.level}:${b.text}`));

test('each paper becomes one bullet: its opening words, with anything listed as sub-bullets', () => {
  assert.deepEqual(shape(paperBullets([card(P('call [[Dave]]')), card(P('order seals')), card(P('check pump')), card(P('lunch 12'))])), [
    ['b0:call [[Dave]]'], ['b0:order seals'], ['b0:check pump'], ['b0:lunch 12'],
  ]);
  assert.deepEqual(shape(paperBullets([card(P('Pump system.'), P('Much quicker.'))])), [['b0:Pump system. Much quicker.']]);
  assert.deepEqual(shape(paperBullets([card(P('Pump issues:'), B('seal'), B('pressure', 1), N('first'), P('after the list'))])), [
    ['b0:Pump issues:', 'b1:seal', 'b2:pressure', 'n1:first', 'b1:after the list'],
  ]);
  // A paper that is only a list: every bullet, dash or number the writer drew is its own bullet.
  assert.deepEqual(shape(paperBullets([card(B('Learn'), B('Act'), B('Educate'))])), [['b0:Learn', 'b0:Act', 'b0:Educate']]);
  assert.deepEqual(shape(paperBullets([card(B('Differentiated position'), B('Trusted first call'), B('Donor value', 1), B('Distinctiveness', 1), B('Capacity'))])), [
    ['b0:Differentiated position', 'b0:Trusted first call', 'b1:Donor value', 'b1:Distinctiveness', 'b0:Capacity'],
  ]);
  assert.deepEqual(shape(paperBullets([card(N('first', 1), N('second', 1), B('aside', 2))])), [['n0:first', 'n0:second', 'b1:aside']]);
  assert.deepEqual(paperBullets([card(P('   ')), { nonsense: true }]), []);
});

test('a list-only card keeps each item as its own bullet, numbered lists keep counting, and backups keep the AI reading', async () => {
  const reading = { notes: [card(B('one'), B('two'), B('[[three]]')), card(N('a'), N('b'), N('c'))], issue: '' };
  const app = await folderApp({ read: async () => reading });
  const id = await newDocument(app.call, 'List card');
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  assert.deepEqual(shape(document.notes), [['b0:one'], ['b0:two'], ['b0:[[three]]'], ['n0:a'], ['n0:b'], ['n0:c']]);
  const xml = await wordXml(await readFile(path.join(app.wordFolder, 'List card.docx')));
  const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids.slice(3)).size, 1, 'a, b, c stay one numbered list (1, 2, 3), not 1, 1, 1');
  const saved = JSON.parse((await readFile(path.join(app.backup, `${id}.jsonl`), 'utf8')).trim());
  assert.deepEqual(saved.original, reading.notes, 'the AI reading is kept as it came');
});

test('a photo of four sticky notes gives four bullets in one tight list in Word', async () => {
  const answers = [{ notes: [card(P('one')), card(P('two')), card(P('three'), B('3a'))], issue: '' }, { notes: [card(P('four'))], issue: '' }];
  const app = await folderApp({ read: async () => answers.shift() });
  const id = await newDocument(app.call, 'Stickies');
  await sendPhoto(app.call, id, LABEL(1));
  const { document } = await (await sendPhoto(app.call, id, LABEL(2))).json();
  assert.deepEqual(shape(document.notes), [['b0:one'], ['b0:two'], ['b0:three', 'b1:3a'], ['b0:four']]);
  const xml = await wordXml(await readFile(path.join(app.wordFolder, 'Stickies.docx')));
  assert.doesNotMatch(xml, /<w:p\/>/, 'no blank lines');
  const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, 1, 'one bullet list throughout, across photos');
});

// --- Editing on the phone's main screen ---------------------------------------------

const editDoc = (call, id, edits) => call(`/api/documents/${id}/edits`, { method: 'POST', body: JSON.stringify({ edits }) });
const lineTexts = (doc) => doc.notes.map((n) => n.blocks.map((b) => b.text));
const findLine = (doc, text) => doc.notes.flatMap((n) => n.blocks).find((b) => b.text === text);
const wordOf = async (wordFolder, name) => shape(await readWordFile(await readFile(path.join(wordFolder, `${name}.docx`))));
const plainOfMarkup = (text) => text.replace(/\[\[|\]\]/g, '');

// A document with three papers: a sentence with a guess, a numbered checklist, and a bullet list.
async function editableDoc(name = 'Edit me') {
  const answers = [{
    notes: [card(P('the [[pump]] is down')), card(P('Checks:'), N('check oil'), N('check [[gauge]]')), card(P('Letters'), B('alpha'), B('beta'))],
    issue: '',
  }];
  const app = await folderApp({ read: async () => answers.shift() || noteSaying('later photo') });
  const id = await newDocument(app.call, name);
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  return { ...app, id, document };
}
const START = [['b0:the [[pump]] is down'], ['b0:Checks:', 'n1:check oil', 'n1:check [[gauge]]'], ['b0:Letters', 'b1:alpha', 'b1:beta']];
const IN_WORD = [['b0:the pump is down'], ['b0:Checks:', 'n1:check oil', 'n1:check gauge'], ['b0:Letters', 'b1:alpha', 'b1:beta']];

test('editing: the Word file never gets yellow, but the phone still shows the guesses', async () => {
  const { document, wordFolder } = await editableDoc();
  assert.deepEqual(shape(document.notes), START);
  assert.equal(document.editable, true);
  assert.ok(document.notes.every((n) => n.blocks.every((b) => Number.isInteger(b.para))));
  assert.deepEqual(await wordOf(wordFolder, 'Edit me'), IN_WORD);
  const xml = await wordXml(await readFile(path.join(wordFolder, 'Edit me.docx')));
  assert.doesNotMatch(xml, /highlight|\[\[/);
});

test('editing: changing a word changes it in Word, keeps the list, and clears that yellow', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const gauge = findLine(document, 'check [[gauge]]');
  const response = await editDoc(call, id, [{ op: 'set', para: gauge.para, expect: 'check gauge', text: 'check gauges & <valves>' }]);
  assert.equal(response.status, 200);
  const { document: after } = await response.json();
  assert.deepEqual(shape(after.notes)[1], ['b0:Checks:', 'n1:check oil', 'n1:check gauges & <valves>']);
  assert.deepEqual((await wordOf(wordFolder, 'Edit me'))[1], ['b0:Checks:', 'n1:check oil', 'n1:check gauges & <valves>']);
  assert.ok(after.version > document.version);
});

test('editing: an edit can keep a guess yellow, and tapping a yellow word clears it without touching Word', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const pump = findLine(document, 'the [[pump]] is down');
  let r = await (await editDoc(call, id, [{ op: 'set', para: pump.para, expect: 'the pump is down', text: 'the [[pump]] is broken' }])).json();
  assert.deepEqual(lineTexts(r.document)[0], ['the [[pump]] is broken']);
  const before = await readFile(path.join(wordFolder, 'Edit me.docx'));
  r = await (await editDoc(call, id, [{ op: 'set', para: pump.para, expect: 'the pump is broken', text: 'the pump is broken' }])).json();
  assert.deepEqual(lineTexts(r.document)[0], ['the pump is broken']);
  assert.deepEqual(await readFile(path.join(wordFolder, 'Edit me.docx')), before, 'Word file not rewritten for a yellow-only change');
});

test('editing: return splits a line in two, in the same list, and the phone learns the new line numbers', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const oil = findLine(document, 'check oil');
  const beta = findLine(document, 'beta');
  const { document: after, indexMap, results } = await (await editDoc(call, id, [
    { op: 'set', para: oil.para, expect: 'check oil', text: 'check' },
    { op: 'insertAfter', para: oil.para, expect: 'check oil', text: 'oil [[level]]' },
  ])).json();
  assert.deepEqual(shape(after.notes)[1], ['b0:Checks:', 'n1:check', 'n1:oil [[level]]', 'n1:check [[gauge]]']);
  assert.equal(results[0], null);
  assert.equal(results[1], oil.para + 1);
  assert.equal(findLine(after, 'oil [[level]]').para, results[1]);
  assert.equal(indexMap[oil.para], oil.para);
  assert.equal(indexMap[beta.para], beta.para + 1, 'lines below moved down by one');
  assert.deepEqual((await wordOf(wordFolder, 'Edit me'))[1], ['b0:Checks:', 'n1:check', 'n1:oil level', 'n1:check gauge']);
  // Still one numbered list, so Word numbers it 1, 2, 3.
  const xml = await wordXml(await readFile(path.join(wordFolder, 'Edit me.docx')));
  const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids.slice(2, 5)).size, 1);
});

test('editing: backspace joins two lines, and an emptied line is removed', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const alpha = findLine(document, 'alpha');
  const beta = findLine(document, 'beta');
  let r = await (await editDoc(call, id, [
    { op: 'set', para: alpha.para, expect: 'alpha', text: 'alpha beta' },
    { op: 'delete', para: beta.para, expect: 'beta' },
  ])).json();
  assert.deepEqual(shape(r.document.notes)[2], ['b0:Letters', 'b1:alpha beta']);
  assert.equal(r.indexMap[beta.para], -1);
  const oil = findLine(r.document, 'check oil');
  r = await (await editDoc(call, id, [{ op: 'set', para: oil.para, expect: 'check oil', text: '   ' }])).json();
  assert.deepEqual(shape(r.document.notes), [['b0:the [[pump]] is down'], ['b0:Checks:', 'n1:check [[gauge]]'], ['b0:Letters', 'b1:alpha beta']]);
  assert.deepEqual(await wordOf(wordFolder, 'Edit me'), [['b0:the pump is down'], ['b0:Checks:', 'n1:check gauge'], ['b0:Letters', 'b1:alpha beta']]);
});

test('editing: deleting a card removes its bullet and sub-bullets, wherever the card is', async () => {
  for (const which of [0, 1, 2]) {
    const { call, id, document, wordFolder } = await editableDoc(`Card ${which}`);
    const blocks = document.notes[which].blocks;
    const r = await (await editDoc(call, id, [{ op: 'deleteNote', paras: blocks.map((b) => b.para), expects: blocks.map((b) => plainOfMarkup(b.text)) }])).json();
    const expected = START.filter((_, k) => k !== which);
    assert.deepEqual(shape(r.document.notes), expected, `card ${which}`);
    assert.deepEqual(await wordOf(wordFolder, `Card ${which}`), IN_WORD.filter((_, k) => k !== which));
    assert.doesNotMatch(await wordXml(await readFile(path.join(wordFolder, `Card ${which}.docx`))), /<w:p\/>/, 'no gaps left');
  }
});

test('editing: deleting a card in an older document also removes the blank line beside it', async () => {
  // Documents made before bullets have blank lines between cards.
  const app = await folderApp({ read: async () => noteSaying('x') });
  await app.call('/api/documents');
  await writeFile(path.join(app.wordFolder, 'Old.docx'), await appendToWordFile(await buildWordFile([]), []));
  const zip = await JSZip.loadAsync(await readFile(path.join(app.wordFolder, 'Old.docx')));
  const line = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace(/<w:body>.*?<w:sectPr>/s, `<w:body>${line('one')}<w:p/>${line('two')}<w:p/>${line('three')}<w:sectPr>`));
  await writeFile(path.join(app.wordFolder, 'Old.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const id = (await (await app.call('/api/documents')).json()).documents[0].id;
  const { document } = await (await app.call(`/api/documents/${id}`)).json();
  const two = findLine(document, 'two');
  const r = await (await editDoc(app.call, id, [{ op: 'deleteNote', paras: [two.para], expects: ['two'] }])).json();
  assert.deepEqual(lineTexts(r.document), [['one'], ['three']]);
  assert.doesNotMatch(await wordXml(await readFile(path.join(app.wordFolder, 'Old.docx'))), /<w:p\/><w:p\/>/);
});

test('editing: deleting everything still leaves a Word file that opens', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const edits = document.notes.map((n) => ({ op: 'deleteNote', paras: n.blocks.map((b) => b.para), expects: n.blocks.map((b) => plainOfMarkup(b.text)) }));
  const r = await (await editDoc(call, id, edits)).json();
  assert.deepEqual(r.document.notes, []);
  assert.match(await wordXml(await readFile(path.join(wordFolder, 'Edit me.docx'))), /<w:body><w:p\/><w:sectPr/);
  // And a new photo goes in at the top.
  const next = await (await sendPhoto(call, id, LABEL(2))).json();
  assert.deepEqual(shape(next.document.notes), [['b0:later photo']]);
});

test('editing: tapping a bullet removes it, and tapping a plain line adds one', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const pump = findLine(document, 'the [[pump]] is down');
  const alpha = findLine(document, 'alpha');
  let r = await editDoc(call, id, [
    { op: 'setKind', para: pump.para, expect: 'the pump is down', kind: 'paragraph' },
    { op: 'setKind', para: alpha.para, expect: 'alpha', kind: 'paragraph' },
  ]);
  assert.equal(r.status, 200);
  let after = (await r.json()).document;
  // "beta" is a sub-bullet, so it stays with the line above it.
  assert.deepEqual(shape(after.notes), [['p0:the [[pump]] is down'], ['b0:Checks:', 'n1:check oil', 'n1:check [[gauge]]'], ['b0:Letters'], ['p0:alpha', 'b1:beta']]);
  let xml = await wordXml(await readFile(path.join(wordFolder, 'Edit me.docx')));
  const plainLine = xml.match(/<w:p>(?:(?!<w:p>).)*?the pump is down.*?<\/w:p>/s)[0];
  assert.doesNotMatch(plainLine, /numPr/);

  // Add the bullet back (to the same bullet list), and change words at the same time.
  r = await editDoc(call, id, [
    { op: 'setKind', para: pump.para, expect: 'the pump is down', kind: 'bullet' },
    { op: 'set', para: pump.para, expect: 'the pump is down', text: 'the pump is fixed' },
  ]);
  after = (await r.json()).document;
  assert.deepEqual(shape(after.notes)[0], ['b0:the pump is fixed']);
  xml = await wordXml(await readFile(path.join(wordFolder, 'Edit me.docx')));
  const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
  const lettersId = xml.match(/<w:numId w:val="(\d+)"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">Letters/)[1];
  assert.equal(ids[0], lettersId, 'joined the same bullet list as the other bullets');
  assert.doesNotThrow(() => parseBody(xml), 'every tag still opens and closes properly');
});

test('editing: adding a bullet to a line in a file with no lists creates the list; Word styles are tidied', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') });
  await app.call('/api/documents');
  const zip = await JSZip.loadAsync(await buildWordFile([]));
  zip.remove('word/numbering.xml');
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace(/<Override PartName="\/word\/numbering.xml"[^>]*\/>/, ''));
  zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace(/<Relationship Id="rId2"[^>]*\/>/, ''));
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('<w:body><w:p/>',
    '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:t>Typed title</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:ind w:left="720"/></w:pPr><w:r><w:t>Word bullet</w:t></w:r></w:p>'));
  await writeFile(path.join(app.wordFolder, 'Plain.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const id = (await (await app.call('/api/documents')).json()).documents[0].id;
  const { document } = await (await app.call(`/api/documents/${id}`)).json();
  assert.deepEqual(shape(document.notes), [['p0:Typed title'], ['b0:Word bullet']]);
  const r = await (await editDoc(app.call, id, [
    { op: 'setKind', para: 0, expect: 'Typed title', kind: 'bullet' },
    { op: 'setKind', para: 1, expect: 'Word bullet', kind: 'paragraph' },
  ])).json();
  assert.deepEqual(shape(r.document.notes), [['b0:Typed title'], ['p0:Word bullet']]);
  const saved = await JSZip.loadAsync(await readFile(path.join(app.wordFolder, 'Plain.docx')));
  const xml = await saved.file('word/document.xml').async('string');
  assert.match(xml, /<w:pPr><w:pStyle w:val="Heading1"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr><w:jc w:val="center"\/><\/w:pPr>/, 'list setting in the right place, heading kept');
  assert.doesNotMatch(xml, /ListBullet|w:ind/, 'Word list style and indent removed from the plain line');
  assert.ok(saved.file('word/numbering.xml'));
  assert.match(await saved.file('[Content_Types].xml').async('string'), /numbering/);
});

test('editing: a line changed in Word is never overwritten from the phone', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const file = path.join(wordFolder, 'Edit me.docx');
  const zip = await JSZip.loadAsync(await readFile(file));
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('check oil', 'check oil daily'));
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const before = await readFile(file);
  const oil = findLine(document, 'check oil');
  const alpha = findLine(document, 'alpha');
  const response = await editDoc(call, id, [
    { op: 'set', para: alpha.para, expect: 'alpha', text: 'ALPHA' },
    { op: 'set', para: oil.para, expect: 'check oil', text: 'check fuel' },
  ]);
  assert.equal(response.status, 409);
  const { error } = await response.json();
  assert.equal(error.code, 'changed');
  assert.equal(error.retryable, false);
  assert.deepEqual(await readFile(file), before, 'nothing applied, not even the other line');
});

test('editing: if Word added a line above, the phone edit still lands on the right line', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const file = path.join(wordFolder, 'Edit me.docx');
  const zip = await JSZip.loadAsync(await readFile(file));
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('<w:body>', '<w:body><w:p><w:r><w:t>Title typed in Word</w:t></w:r></w:p>'));
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const beta = findLine(document, 'beta');
  const r = await (await editDoc(call, id, [{ op: 'set', para: beta.para, expect: 'beta', text: 'gamma' }])).json();
  assert.deepEqual(shape(r.document.notes), [['p0:Title typed in Word'], ...START.slice(0, 2), ['b0:Letters', 'b1:alpha', 'b1:gamma']]);
});

test('editing: pictures, tables and page breaks made in Word are left alone', async () => {
  const { call, id, wordFolder } = await editableDoc();
  const file = path.join(wordFolder, 'Edit me.docx');
  const zip = await JSZip.loadAsync(await readFile(file));
  let xml = await zip.file('word/document.xml').async('string');
  const picture = '<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><a:graphic xmlns:a="y"/></wp:inline></w:drawing></w:r></w:p>';
  const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>in a table</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const pageBreak = '<w:p><w:pPr><w:sectPr><w:pgSz w:w="15840" w:h="12240"/></w:sectPr></w:pPr><w:r><w:t>landscape after this</w:t></w:r></w:p>';
  xml = xml.replace('<w:sectPr>', `${picture}${table}${pageBreak}<w:sectPr>`);
  zip.file('word/document.xml', xml);
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));

  const { document } = await (await call(`/api/documents/${id}`)).json();
  const last = document.notes.slice(-2).map((n) => n.blocks[0]);
  assert.deepEqual(last.map((b) => [b.text, b.locked]), [['(picture)', true], ['landscape after this', true]], 'table not shown');
  for (const block of last) {
    const expect = block.text === '(picture)' ? '' : block.text;
    assert.equal((await editDoc(call, id, [{ op: 'set', para: block.para, expect, text: 'x' }])).status, 409);
    assert.equal((await editDoc(call, id, [{ op: 'setKind', para: block.para, expect, kind: 'bullet' }])).status, 409);
  }
  // Other lines can still be edited, and the picture, table and page break survive.
  const alpha = findLine(document, 'alpha');
  assert.equal((await editDoc(call, id, [{ op: 'set', para: alpha.para, expect: 'alpha', text: 'alpha 2' }])).status, 200);
  const saved = await wordXml(await readFile(file));
  for (const piece of [picture, table, pageBreak]) assert.ok(saved.includes(piece));
});

test('editing: retyping a line keeps its font and bold, bookmarks and comment links', async () => {
  const { call, id, document, wordFolder } = await editableDoc();
  const file = path.join(wordFolder, 'Edit me.docx');
  const zip = await JSZip.loadAsync(await readFile(file));
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replace(
    '<w:r><w:t xml:space="preserve">alpha</w:t></w:r>',
    '<w:bookmarkStart w:id="7" w:name="here"/><w:proofErr w:type="spellStart"/><w:r w:rsidR="00A1"><w:rPr><w:b/><w:highlight w:val="cyan"/><w:sz w:val="28"/></w:rPr><w:t>al</w:t></w:r><w:r><w:t>pha</w:t></w:r><w:bookmarkEnd w:id="7"/><w:r><w:commentReference w:id="3"/></w:r>',
  );
  zip.file('word/document.xml', xml);
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const alpha = findLine(document, 'alpha');
  assert.equal((await editDoc(call, id, [{ op: 'set', para: alpha.para, expect: 'alpha', text: 'omega' }])).status, 200);
  const saved = await wordXml(await readFile(file));
  const line = saved.match(/<w:p>(?:(?!<w:p>)[\s\S])*?omega[\s\S]*?<\/w:p>/)[0];
  assert.match(line, /<w:bookmarkStart w:id="7" w:name="here"\/>.*<w:rPr><w:b\/><w:sz w:val="28"\/><\/w:rPr><w:t xml:space="preserve">omega<\/w:t>.*<w:commentReference w:id="3"\/>.*<w:bookmarkEnd w:id="7"\/>/);
  assert.doesNotMatch(line, /highlight/);
});

test('editing: waits while the file is open in Word, and refuses nonsense', async () => {
  let open = false;
  const answers = [{ notes: [para('one line')], issue: '' }];
  const app = await folderApp({ read: async () => answers.shift() }, { isFileOpen: async () => open });
  const id = await newDocument(app.call, 'Busy');
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  const line = document.notes[0].blocks[0];
  open = true;
  const blocked = await editDoc(app.call, id, [{ op: 'set', para: line.para, expect: 'one line', text: 'two' }]);
  assert.equal(blocked.status, 409);
  const { error } = await blocked.json();
  assert.equal(error.retryable, true);
  assert.match(error.message, /your changes will be saved/);
  open = false;
  for (const edits of [
    [], 'x', [{ op: 'explode', para: 0, expect: '' }], [{ op: 'set', para: -1, expect: '', text: '' }],
    [{ op: 'set', para: line.para, expect: 'one line' }],
    [{ op: 'setKind', para: line.para, expect: 'one line', kind: 'heading' }],
    [{ op: 'setKind', para: line.para, expect: 'one line', kind: 'bullet', level: 5 }],
  ]) {
    assert.equal((await editDoc(app.call, id, edits)).status, 400, JSON.stringify(edits));
  }
  for (const pair of [
    [{ op: 'set', para: line.para, expect: 'one line', text: 'a' }, { op: 'delete', para: line.para, expect: 'one line' }],
    [{ op: 'setKind', para: line.para, expect: 'one line', kind: 'paragraph' }, { op: 'delete', para: line.para, expect: 'one line' }],
    [{ op: 'setKind', para: line.para, expect: 'one line', kind: 'paragraph' }, { op: 'setKind', para: line.para, expect: 'one line', kind: 'bullet' }],
  ]) {
    assert.equal((await editDoc(app.call, id, pair)).status, 400, 'two clashing changes to one line');
  }
});

test('editing: documents kept inside the app (no OneDrive) say editing needs the folder', async () => {
  const { call } = await startApp({ reader: { read: async () => noteSaying('x') } });
  const id = await newDocument(call);
  const { document } = await (await call(`/api/documents/${id}`)).json();
  assert.equal(document.editable, false);
  assert.equal((await editDoc(call, id, [{ op: 'delete', para: 0, expect: 'x' }])).status, 400);
});

test('editing: two cards with the same words keep their own yellow', async () => {
  const same = { notes: [para('learn [[act]] educate')], issue: '' };
  const answers = [same, same, same];
  const app = await folderApp({ read: async () => answers.shift() });
  const id = await newDocument(app.call, 'Twins');
  for (const n of [1, 2, 3]) await sendPhoto(app.call, id, LABEL(n));
  const { document } = await (await app.call(`/api/documents/${id}`)).json();
  assert.deepEqual(lineTexts(document), [['learn [[act]] educate'], ['learn [[act]] educate'], ['learn [[act]] educate']]);
  const [first, second] = document.notes.map((n) => n.blocks[0]);

  // Tap the yellow on the middle copy only.
  let r = await (await editDoc(app.call, id, [{ op: 'set', para: second.para, expect: 'learn act educate', text: 'learn act educate' }])).json();
  assert.deepEqual(lineTexts(r.document), [['learn [[act]] educate'], ['learn act educate'], ['learn [[act]] educate']]);

  // Delete the first copy: the others keep their own state.
  r = await (await editDoc(app.call, id, [{ op: 'deleteNote', paras: [first.para], expects: ['learn act educate'] }])).json();
  assert.deepEqual(lineTexts(r.document), [['learn act educate'], ['learn [[act]] educate']]);

  // Change the (now) first copy into new words with a guess, and split the last one.
  const [a, b] = r.document.notes.map((n) => n.blocks[0]);
  r = await (await editDoc(app.call, id, [
    { op: 'set', para: a.para, expect: 'learn act educate', text: 'learn [[fast]]' },
    { op: 'set', para: b.para, expect: 'learn act educate', text: 'learn [[act]]' },
    { op: 'insertAfter', para: b.para, expect: 'learn act educate', text: 'educate' },
  ])).json();
  assert.deepEqual(lineTexts(r.document), [['learn [[fast]]'], ['learn [[act]]'], ['educate']]);
});

test('guess memory: copies are tracked in order, and old saved data still loads', async () => {
  const { createGuessMemory, copyNumbers } = await import('../lib/guesses.js');
  assert.deepEqual(copyNumbers(['a', 'b', 'a', 'a', 'b']), [0, 0, 1, 2, 1]);
  const memory = createGuessMemory([{ text: 'x y', marks: [[0, 1]] }]);
  assert.equal(memory.show('x y', 0), '[[x]] y');
  memory.insert('x y', 0); // a plain copy added above
  assert.equal(memory.show('x y', 0), 'x y');
  assert.equal(memory.show('x y', 1), '[[x]] y');
  memory.remove('x y', 1);
  assert.deepEqual(memory.entries(), []);
});

// --- Snapping a photo into the middle of a document ----------------------------------

const sendPhotoUnder = (call, id, photo, line) =>
  call(`/api/documents/${id}/photos?photo=${photo}`, {
    method: 'POST',
    body: JPEG,
    headers: { 'X-Under-Para': String(line.para), 'X-Under-Text': encodeURIComponent(line.expect) },
  });

test('middle: a photo goes directly under the picked line, as normal bullets, and the next one stacks after it', async () => {
  const answers = [
    { notes: [card(P('first')), card(P('Pump check:'), B('pressure'), B('oil')), card(P('last [[one]]'))], issue: '' },
    { notes: [card(P('new A')), card(P('new [[B]]'))], issue: '' },
    { notes: [card(P('new C'))], issue: '' },
  ];
  const app = await folderApp({ read: async () => answers.shift() });
  const id = await newDocument(app.call, 'Middle');
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  const pump = findLine(document, 'Pump check:');
  const oil = findLine(document, 'oil');

  // Directly under "Pump check:", even though it has sub-bullets (as chosen).
  const r1 = await (await sendPhotoUnder(app.call, id, LABEL(2), { para: pump.para, expect: 'Pump check:' })).json();
  assert.deepEqual(shape(r1.document.notes).flat(), ['b0:first', 'b0:Pump check:', 'b0:new A', 'b0:new [[B]]', 'b1:pressure', 'b1:oil', 'b0:last [[one]]']);
  assert.equal(r1.lastPara, pump.para + 2);
  assert.equal(r1.placedAtEnd, false);
  assert.equal(r1.indexMap[pump.para], pump.para);
  assert.equal(r1.indexMap[oil.para], oil.para + 2, 'lines below moved down by two');

  // The next photo goes right after the last one added.
  const lastAdded = findLine(r1.document, 'new [[B]]');
  assert.equal(lastAdded.para, r1.lastPara);
  const r2 = await (await sendPhotoUnder(app.call, id, LABEL(3), { para: lastAdded.para, expect: 'new B' })).json();
  assert.deepEqual(shape(r2.document.notes).flat(), ['b0:first', 'b0:Pump check:', 'b0:new A', 'b0:new [[B]]', 'b0:new C', 'b1:pressure', 'b1:oil', 'b0:last [[one]]']);
  assert.deepEqual(await wordOf(app.wordFolder, 'Middle'), [['b0:first'], ['b0:Pump check:'], ['b0:new A'], ['b0:new B'], ['b0:new C', 'b1:pressure', 'b1:oil'], ['b0:last one']]);
  const xml = await wordXml(await readFile(path.join(app.wordFolder, 'Middle.docx')));
  assert.doesNotMatch(xml, /<w:p\/>|highlight/);
});

test('middle: if the picked line was changed in Word, the photo still goes in, at the end, and says so', async () => {
  const answers = [{ notes: [card(P('alpha')), card(P('beta'))], issue: '' }, { notes: [card(P('gamma'))], issue: '' }];
  const app = await folderApp({ read: async () => answers.shift() });
  const id = await newDocument(app.call, 'Moved');
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  const alpha = findLine(document, 'alpha');
  const r = await (await sendPhotoUnder(app.call, id, LABEL(2), { para: alpha.para, expect: 'alpha changed in Word' })).json();
  assert.equal(r.placedAtEnd, true);
  assert.deepEqual(shape(r.document.notes).flat(), ['b0:alpha', 'b0:beta', 'b0:gamma']);
});

test('middle: if Word added lines above, the photo still finds the picked line by its words', async () => {
  const answers = [{ notes: [card(P('alpha')), card(P('beta'))], issue: '' }, { notes: [card(P('gamma'))], issue: '' }];
  const app = await folderApp({ read: async () => answers.shift() });
  const id = await newDocument(app.call, 'Shifted');
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  const alpha = findLine(document, 'alpha');
  const file = path.join(app.wordFolder, 'Shifted.docx');
  const zip = await JSZip.loadAsync(await readFile(file));
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('<w:body>', '<w:body><w:p><w:r><w:t>Title typed in Word</w:t></w:r></w:p>'));
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const r = await (await sendPhotoUnder(app.call, id, LABEL(2), { para: alpha.para, expect: 'alpha' })).json();
  assert.equal(r.placedAtEnd, false);
  assert.deepEqual(shape(r.document.notes).flat(), ['p0:Title typed in Word', 'b0:alpha', 'b0:gamma', 'b0:beta']);
});

test('middle: odd picked-line details are refused before anything is read', async () => {
  let reads = 0;
  const app = await folderApp({ read: async () => (reads++, noteSaying('x')) });
  const id = await newDocument(app.call, 'Odd');
  for (const headers of [{ 'X-Under-Para': '-1', 'X-Under-Text': 'a' }, { 'X-Under-Para': 'two', 'X-Under-Text': 'a' }, { 'X-Under-Para': '0', 'X-Under-Text': '%E0%A4%A' }]) {
    const r = await app.call(`/api/documents/${id}/photos?photo=${LABEL(9)}`, { method: 'POST', body: JPEG, headers });
    assert.equal(r.status, 400, JSON.stringify(headers));
  }
  assert.equal(reads, 0);
});

// --- Printed section headings ----------------------------------------------------------

const H = (heading, ...blocks) => ({ heading, blocks });
const withHeadings = (doc) => doc.notes.flatMap((n) => n.blocks.map((b) => (b.heading ? `H:${b.text}` : `${b.kind[0]}${b.level}:${b.text}`)));

test('headings: a sheet with printed sections puts each section\'s writing under a bold heading', async () => {
  const sheet = {
    notes: [
      H('', P('AI-tool'), P('Human preference')),
      H('INDUSTRY FUTURE STATE', P('Legislative change / [[DAF]] - asset management')),
      H('INDUSTRY FUTURE STATE', B('Relational / headcount comes down'), B('AI')),
      H('CUSTOMERS FUTURE STATE', P('Wealth transfer → next generation of donors.'), P('Deepened relationships - trust')),
      H('OUR STRATEGY', P('Peer to peer')),
    ],
    issue: '',
  };
  const app = await folderApp({ read: async () => sheet });
  const id = await newDocument(app.call, 'Future state');
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  assert.deepEqual(withHeadings(document), [
    'b0:AI-tool Human preference',
    'H:INDUSTRY FUTURE STATE', 'b0:Legislative change / [[DAF]] - asset management', 'b0:Relational / headcount comes down', 'b0:AI',
    'H:CUSTOMERS FUTURE STATE', 'b0:Wealth transfer → next generation of donors.', 'b0:Deepened relationships - trust',
    'H:OUR STRATEGY', 'b0:Peer to peer',
  ]);
  const xml = await wordXml(await readFile(path.join(app.wordFolder, 'Future state.docx')));
  assert.match(xml, /<w:p><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">INDUSTRY FUTURE STATE<\/w:t><\/w:r><\/w:p>/, 'heading is a plain bold line');
  assert.doesNotMatch(xml, /highlight|\[\[|<w:p\/>/);
});

test('headings: a second sheet adds to the same sections (any capitals or colon), and new headings go at the end', async () => {
  const sheets = [
    { notes: [H('OUR STRATEGY', P('first strategy')), H('CUSTOMERS', P('first customer'))], issue: '' },
    { notes: [H('Our Strategy:', P('second strategy')), H('EMPLOYEES', P('first employee')), H('customers', P('second customer'))], issue: '' },
  ];
  const app = await folderApp({ read: async () => sheets.shift() });
  const id = await newDocument(app.call, 'Two sheets');
  await sendPhoto(app.call, id, LABEL(1));
  const { document } = await (await sendPhoto(app.call, id, LABEL(2))).json();
  assert.deepEqual(withHeadings(document), [
    'H:OUR STRATEGY', 'b0:first strategy', 'b0:second strategy',
    'H:CUSTOMERS', 'b0:first customer', 'b0:second customer',
    'H:EMPLOYEES', 'b0:first employee',
  ]);
});

test('headings: a heading typed in Word (plain or Heading style) is found too, and its sub-bullets stay together', async () => {
  const app = await folderApp({ read: async () => ({ notes: [H('Risks', P('new risk'))], issue: '' }) });
  await app.call('/api/documents');
  const zip = await JSZip.loadAsync(await buildWordFile([card(P('Risks'), B('old risk'), B('detail', 1)), card(P('Next topic'))]));
  let xml = await zip.file('word/document.xml').async('string');
  // Give "Risks" Word's Heading 2 style, as if typed in Word.
  const before = xml;
  xml = xml.replace('<w:p><w:r><w:t xml:space="preserve">Risks', '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Risks');
  assert.notEqual(xml, before, 'the test file really has a Heading 2 line');
  zip.file('word/document.xml', xml);
  await writeFile(path.join(app.wordFolder, 'Typed.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const id = (await (await app.call('/api/documents')).json()).documents[0].id;
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  assert.deepEqual(withHeadings(document), ['H:Risks', 'b0:old risk', 'b1:detail', 'b0:new risk', 'p0:Next topic']);
});

test('headings: notes with no section follow the picked line; sections still go to their headings', async () => {
  const answers = [
    { notes: [H('TOPIC A', P('a1')), H('TOPIC B', P('b1'))], issue: '' },
    { notes: [H('', P('loose note')), H('TOPIC A', P('a2')), H('NEW TOPIC', P('n1'))], issue: '' },
  ];
  const app = await folderApp({ read: async () => answers.shift() });
  const id = await newDocument(app.call, 'Picked');
  const { document } = await (await sendPhoto(app.call, id, LABEL(1))).json();
  const b1 = findLine(document, 'b1');
  const r = await (await sendPhotoUnder(app.call, id, LABEL(2), { para: b1.para, expect: 'b1' })).json();
  assert.deepEqual(withHeadings(r.document), ['H:TOPIC A', 'b0:a1', 'b0:a2', 'H:TOPIC B', 'b0:b1', 'b0:loose note', 'H:NEW TOPIC', 'b0:n1']);
  assert.equal(r.lastPara, findLine(r.document, 'n1').para, 'the next photo stacks after what went under the pick');
  assert.equal(r.indexMap[b1.para], b1.para + 1, 'b1 moved down by one (a2 went in above it)');
});

test('headings: the AI is asked for each note\'s printed heading, and odd headings are tidied', async () => {
  const fake = fakeAi(() => ({ stop_reason: 'end_turn', parsed_output: { notes: [], issue: 'blank' } }));
  await createAiReader({ client: fake.client }).read(readerInput);
  const schema = JSON.stringify(fake.calls[0].output_config.format);
  assert.match(schema, /heading/);
  assert.deepEqual(tidyNotes([{ heading: '  OUR\nSTRATEGY [[x]] ', blocks: [P('a')] }, { heading: '   ', blocks: [P('b')] }]), [
    { heading: 'OUR STRATEGY x', blocks: [P('a')] },
    { blocks: [P('b')] },
  ]);
  // Documents kept inside the app also get their headings.
  assert.deepEqual(allLines(await readWordFile(await buildWordFile([H('Top', P('under it'))]))), [P('Top'), P('under it')]);
});

// --- Deleting lists into the Archive, and restoring them -------------------------------

const archiveDoc = (call, id) => call(`/api/documents/${id}/archive`, { method: 'POST' });
const restoreDoc = (call, id) => call(`/api/archive/${id}/restore`, { method: 'POST' });
const archiveList = async (call) => (await (await call('/api/archive')).json()).archived;

test('archive: deleting a list moves its Word file to DeScribe/Archive, and restoring brings it back with its yellow', async () => {
  const app = await folderApp({ read: async () => ({ notes: [card(P('keep [[this]] safe'))], issue: '' }) });
  const id = await newDocument(app.call, 'Old list');
  await newDocument(app.call, 'Other list');
  await sendPhoto(app.call, id, LABEL(1));

  const r = await archiveDoc(app.call, id);
  assert.equal(r.status, 200);
  const { archived, documents } = await r.json();
  assert.deepEqual(documents.map((d) => d.name), ['Other list']);
  assert.equal(archived.name, 'Old list');
  assert.deepEqual((await readdir(app.wordFolder)).filter((n) => n.endsWith('.docx')), ['Other list.docx']);
  assert.deepEqual(await readdir(path.join(app.wordFolder, 'Archive')), ['Old list.docx']);
  assert.equal((await app.call(`/api/documents/${id}`)).status, 404, 'no longer a list');
  const inArchive = await archiveList(app.call);
  assert.deepEqual(inArchive.map((a) => a.name), ['Old list']);

  const restored = await (await restoreDoc(app.call, inArchive[0].id)).json();
  assert.equal(restored.document.name, 'Old list');
  assert.deepEqual(lineTexts(restored.document), [['keep [[this]] safe']], 'guesses kept');
  assert.deepEqual(await readdir(path.join(app.wordFolder, 'Archive')), []);
  assert.deepEqual((await archiveList(app.call)), []);
  // It works as a list again: photos go in and the old photo is still known.
  const again = await (await sendPhoto(app.call, restored.document.id, LABEL(1))).json();
  assert.equal(again.added, 0, 'the same photo is still not added twice');
});

test('archive: same names never overwrite anything, on the way in or out', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') });
  const first = await newDocument(app.call, 'Notes');
  await (await archiveDoc(app.call, first)).json();
  const second = await newDocument(app.call, 'Notes');
  await (await archiveDoc(app.call, second)).json();
  const third = await newDocument(app.call, 'Notes');
  await (await archiveDoc(app.call, third)).json();
  const names = (await readdir(path.join(app.wordFolder, 'Archive'))).sort();
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(names, [`Notes (archived ${day} 2).docx`, `Notes (archived ${day}).docx`, 'Notes.docx']);

  await newDocument(app.call, 'Notes'); // a new list with the same name exists now
  const archived = await archiveList(app.call);
  const restored = await (await restoreDoc(app.call, archived.find((a) => a.name === 'Notes').id)).json();
  assert.equal(restored.document.name, 'Notes 2');
  const restored2 = await (await restoreDoc(app.call, archived.find((a) => a.name === `Notes (archived ${day})`).id)).json();
  assert.equal(restored2.document.name, 'Notes 3', 'goes back under its original name, numbered');
});

test('archive: a list open in Word is not moved; odd requests are refused', async () => {
  let open = true;
  const app = await folderApp({ read: async () => noteSaying('x') }, { isFileOpen: async () => open });
  const id = await newDocument(app.call, 'Busy');
  const blocked = await archiveDoc(app.call, id);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error.message, /open in Word.*Close it there first/);
  assert.ok((await readdir(app.wordFolder)).includes('Busy.docx'));
  open = false;
  assert.equal((await archiveDoc(app.call, id)).status, 200);
  assert.equal((await archiveDoc(app.call, id)).status, 404, 'already archived');
  assert.equal((await restoreDoc(app.call, '00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal((await fetch(new URL(`/api/documents/${id}/archive`, (await app.call('/api/status')).url), { method: 'POST' })).status, 403, 'needs the app label');
});

test('archive: a Word file put in the Archive folder by hand shows up and can be restored; a vanished one is tidied', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') });
  await app.call('/api/documents');
  await mkdir(path.join(app.wordFolder, 'Archive'), { recursive: true });
  await writeFile(path.join(app.wordFolder, 'Archive', 'Dropped in.docx'), await buildWordFile([card(P('by hand'))]));
  let archived = await archiveList(app.call);
  assert.deepEqual(archived.map((a) => a.name), ['Dropped in']);
  // Someone removes it from OneDrive before restoring.
  await rm(path.join(app.wordFolder, 'Archive', 'Dropped in.docx'));
  assert.equal((await restoreDoc(app.call, archived[0].id)).status, 404);
  assert.deepEqual(await archiveList(app.call), []);
});

test('archive: documents kept inside the app say the Archive needs the OneDrive folder', async () => {
  const { call } = await startApp({ reader: { read: async () => noteSaying('x') } });
  const id = await newDocument(call);
  assert.equal((await call('/api/archive')).status, 400);
  assert.equal((await archiveDoc(call, id)).status, 400);
});

test('records: lists seen for the first time by several requests at once keep one id each', async () => {
  const folder = await tempFolder();
  const wordFolder = path.join(folder, 'word');
  await mkdir(wordFolder, { recursive: true });
  for (const name of ['A', 'B', 'C', 'D']) await writeFile(path.join(wordFolder, `${name}.docx`), await buildWordFile([card(P(name))]));
  const store = createFolderStore({ folder: wordFolder, indexFile: path.join(folder, 'index.json'), isFileOpen: async () => false });
  const [first, second] = await Promise.all([store.list(), store.list()]);
  const ids = (list) => Object.fromEntries(list.map((d) => [d.name, d.id]));
  assert.deepEqual(ids(first), ids(second));
  for (const doc of first) assert.ok(await store.get(doc.id), `${doc.name} opens with the id it was listed with`);
  // And a fresh start reads the same ids back from disk.
  const again = createFolderStore({ folder: wordFolder, indexFile: path.join(folder, 'index.json'), isFileOpen: async () => false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(ids(await again.list()), ids(first));
});

// --- Live updates, QR pairing -----------------------------------------------------------

// Opens the live connection and collects the news it brings.
async function listen(call, client = 'listener') {
  const controller = new AbortController();
  const response = await call('/api/events', { headers: { 'X-Client': client }, signal: controller.signal });
  const news = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const data = buffer.slice(0, end).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
          buffer = buffer.slice(end + 2);
          if (data) news.push(JSON.parse(data));
        }
      }
    } catch {
      // closed
    }
  })();
  const waitFor = async (count) => {
    for (let i = 0; i < 100 && news.length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
    return news;
  };
  return { status: response.status, news, waitFor, stop: () => controller.abort() };
}

test('live: every screen hears about photos, edits, new lists, deletes and restores, tagged with who did it', async () => {
  const app = await folderApp({ read: async () => ({ notes: [card(P('one'))], issue: '' }) });
  const ear = await listen(app.call);
  assert.equal(ear.status, 200);
  const id = await newDocument(app.call, 'Live');
  const phone = (route, options = {}) => app.call(route, { ...options, headers: { 'X-Client': 'phone1', ...options.headers } });
  const photo = await (await phone(`/api/documents/${id}/photos?photo=${LABEL(1)}`, { method: 'POST', body: JPEG })).json();
  const line = photo.document.notes[0].blocks[0];
  await editDoc(phone, id, [{ op: 'set', para: line.para, expect: 'one', text: 'two' }]);
  await phone(`/api/documents/${id}/archive`, { method: 'POST' });
  const archived = await archiveList(app.call);
  await phone(`/api/archive/${archived[0].id}/restore`, { method: 'POST' });
  const news = await ear.waitFor(5);
  ear.stop();
  assert.deepEqual(news.map((n) => n.type), ['lists', 'document', 'document', 'lists', 'lists']);
  assert.equal(news[1].id, id);
  assert.equal(news[1].source, 'phone1');
  assert.equal(news[1].version, photo.document.version);
  assert.ok(Array.isArray(news[2].indexMap), 'edits say where lines moved');
  assert.ok(news[2].version > news[1].version);
});

test('live: the connection needs the passcode; a photo that adds nothing sends no news', async () => {
  const answers = [{ notes: [], issue: 'Blank.' }];
  const app = await folderApp({ read: async () => answers.shift() }, { passcode: 'rig2026' });
  const stranger = await fetch(new URL('/api/events', (await app.call('/api/status')).url));
  assert.equal(stranger.status, 401);
  const ear = await listen(app.call);
  const id = await newDocument(app.call, 'Quiet');
  await sendPhoto(app.call, id, LABEL(1));
  const news = await ear.waitFor(2);
  ear.stop();
  assert.deepEqual(news.map((n) => n.type), ['lists']);
});

test('pairing: the laptop gets a QR code with a link to the Mac; the phone claims it once scanned', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') }, { passcode: 'rig2026' });
  const id = await newDocument(app.call, 'Paired');
  const r = await app.call('/api/pair', { method: 'POST', body: JSON.stringify({ documentId: id }) });
  assert.equal(r.status, 200);
  const { url, svg, expiresAt } = await r.json();
  // Opened on the Mac itself (localhost), so the link uses the Mac's Wi-Fi address.
  assert.match(url, /^http:\/\/192\.168\.1\.50:\d+\/p\/[A-HJ-NP-Z2-9]{10}$/);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.ok(new Date(expiresAt) - Date.now() > 9 * 60 * 1000);
  const code = url.split('/p/')[1];

  // Scanning opens the link, which sends the phone into the app with the code.
  const base = new URL((await app.call('/api/status')).url).origin;
  const opened = await fetch(`${base}/p/${code}`, { redirect: 'manual' });
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), `/?pair=${code}`);

  // The phone (no passcode yet) claims the code and gets in, on the same list.
  const claim = (c) => fetch(`${base}/api/pair/claim`, { method: 'POST', headers: { 'X-App': 'photo-to-word' }, body: JSON.stringify({ code: c }) });
  const claimed = await (await claim(code.toLowerCase())).json();
  assert.deepEqual(claimed, { passcode: 'rig2026', documentId: id });
  assert.equal((await claim(code)).status, 200, 'several phones can scan the same code while it lasts');
});

test('pairing: wrong or made-up codes are refused and repeated guessing is locked out; codes need the passcode to make', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') }, { passcode: 'rig2026' });
  const id = await newDocument(app.call, 'Locked');
  const base = new URL((await app.call('/api/status')).url).origin;
  assert.equal((await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'X-App': 'photo-to-word' }, body: JSON.stringify({ documentId: id }) })).status, 401);
  assert.equal((await app.call('/api/pair', { method: 'POST', body: JSON.stringify({ documentId: '00000000-0000-0000-0000-000000000000' }) })).status, 404);
  const claim = (c) => fetch(`${base}/api/pair/claim`, { method: 'POST', headers: { 'X-App': 'photo-to-word' }, body: JSON.stringify({ code: c }) });
  for (let i = 0; i < 10; i += 1) assert.equal((await claim('ABCDEFGHJK')).status, 404);
  assert.equal((await claim('ABCDEFGHJK')).status, 429);
  assert.equal((await fetch(`${base}/p/short`, { redirect: 'manual' })).status, 404);
});

test('pairing: opened from another device, the link keeps the address it was opened with', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') });
  const id = await newDocument(app.call, 'Host');
  // fetch() can't set the Host header, so send this one the plain way.
  const port = new URL((await app.call('/api/status')).url).port;
  const r = await new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: '/api/pair', method: 'POST', headers: { Host: 'my-mac.local:4000', 'X-App': 'photo-to-word', 'X-Passcode': '' } },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve(JSON.parse(body)));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ documentId: id }));
  });
  assert.match(r.url, /^http:\/\/my-mac\.local:4000\/p\//);
});

test('qr: codes are the right size, have the three corner squares, and fit a long link', async () => {
  const { qrMatrix, qrSvg } = await import('../lib/qr.js');
  const m = qrMatrix('http://192.168.1.20:4000/p/K7M2Q9XA');
  assert.equal(m.length, 29, 'version 3');
  for (const [x, y] of [[0, 0], [22, 0], [0, 22]]) {
    for (let i = 0; i < 7; i += 1) {
      assert.equal(m[y][x + i], true, 'corner square top edge');
      assert.equal(m[y + 6][x + i], true, 'corner square bottom edge');
    }
    assert.equal(m[y + 3][x + 3], true, 'corner square centre');
    assert.equal(m[y + 1][x + 1], false, 'corner square ring');
  }
  assert.equal(qrMatrix('x'.repeat(200)).length, 57, 'version 10 for 200 characters');
  assert.throws(() => qrMatrix('x'.repeat(400)), /too long/);
  assert.match(qrSvg('hi'), /<rect width="29" height="29" fill="#fff"\/><path d="M4 4h1v1h-1z/);
});

// --- Projects: folders that hold several files ----------------------------------------

const post = (call, route, body) => call(route, { method: 'POST', body: JSON.stringify(body) });
const json = async (response) => {
  const body = await response.json();
  return { status: response.status, ...body };
};

test('projects: a project is a folder in OneDrive; files are made in it, listed with it, and work as usual', async () => {
  const app = await folderApp({ read: async () => ({ notes: [card(P('in a [[project]]'))], issue: '' }) });
  const { project } = await json(await post(app.call, '/api/projects', { name: 'Board Retreat' }));
  assert.equal(project.name, 'Board Retreat');
  const day1 = (await json(await post(app.call, '/api/documents', { name: 'Day 1', project: 'Board Retreat' }))).document;
  assert.equal(day1.project, 'Board Retreat');
  const loose = await newDocument(app.call, 'Loose notes');
  assert.ok((await readdir(path.join(app.wordFolder, 'Board Retreat'))).includes('Day 1.docx'));

  const { documents } = await (await app.call('/api/documents')).json();
  assert.deepEqual(documents.map((d) => [d.name, d.project]).sort(), [['Day 1', 'Board Retreat'], ['Loose notes', '']]);
  const { projects } = await (await app.call('/api/projects')).json();
  assert.deepEqual(projects, [{ name: 'Board Retreat', files: 1 }]);

  // Photos, edits and Word download all work for a file in a project.
  const added = await (await sendPhoto(app.call, day1.id, LABEL(1))).json();
  assert.deepEqual(lineTexts(added.document), [['in a [[project]]']]);
  const line = added.document.notes[0].blocks[0];
  assert.equal((await editDoc(app.call, day1.id, [{ op: 'set', para: line.para, expect: 'in a project', text: 'in the project' }])).status, 200);
  assert.equal((await app.call(`/api/documents/${day1.id}/word`)).status, 200);
  void loose;
});

test('projects: names never clash, "Archive" is kept back, and an empty project still shows', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') });
  assert.equal((await json(await post(app.call, '/api/projects', { name: 'Q4' }))).project.name, 'Q4');
  assert.equal((await json(await post(app.call, '/api/projects', { name: 'q4' }))).project.name, 'q4 2');
  assert.equal((await post(app.call, '/api/projects', { name: 'archive' })).status, 400);
  assert.equal((await json(await post(app.call, '/api/projects', { name: 'a/b:c' }))).project.name, 'a b c', 'no folder tricks');
  const a = (await json(await post(app.call, '/api/documents', { name: 'Same', project: 'Q4' }))).document;
  const b = (await json(await post(app.call, '/api/documents', { name: 'Same', project: 'Q4' }))).document;
  assert.deepEqual([a.name, b.name], ['Same', 'Same 2']);
  assert.equal((await post(app.call, '/api/documents', { name: 'x', project: 'Nope' })).status, 404);
  const { projects } = await (await app.call('/api/projects')).json();
  assert.deepEqual(projects.map((p) => p.name), ['a b c', 'Q4', 'q4 2']);
});

test('projects: moving a file in and out keeps its id, its yellow and its photos; Word-open files stay put', async () => {
  let open = false;
  const app = await folderApp({ read: async () => ({ notes: [card(P('keep [[me]]'))], issue: '' }) }, { isFileOpen: async () => open });
  await post(app.call, '/api/projects', { name: 'Site' });
  const id = await newDocument(app.call, 'Visit');
  await sendPhoto(app.call, id, LABEL(1));
  let r = await json(await post(app.call, `/api/documents/${id}/move`, { project: 'Site' }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.document.id, r.document.name, r.document.project], [id, 'Visit', 'Site']);
  assert.deepEqual(lineTexts(r.document), [['keep [[me]]']]);
  assert.equal((await (await sendPhoto(app.call, id, LABEL(1))).json()).added, 0, 'the same photo is still known');
  // Moving onto a name that's taken there becomes "Visit 2".
  await newDocument(app.call, 'Visit');
  r = await json(await post(app.call, `/api/documents/${id}/move`, { project: '' }));
  assert.deepEqual([r.document.name, r.document.project], ['Visit 2', '']);
  open = true;
  const blocked = await json(await post(app.call, `/api/documents/${id}/move`, { project: 'Site' }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.error.message, /open in Word.*move it/);
  assert.equal((await post(app.call, `/api/documents/${id}/move`, { project: 'Gone' })).status, 404);
});

test('projects: renaming keeps every file and its memory; a taken name or an open file is refused', async () => {
  let open = false;
  const app = await folderApp({ read: async () => ({ notes: [card(P('a [[guess]]'))], issue: '' }) }, { isFileOpen: async () => open });
  await post(app.call, '/api/projects', { name: 'Old name' });
  await post(app.call, '/api/projects', { name: 'Other' });
  const doc = (await json(await post(app.call, '/api/documents', { name: 'Notes', project: 'Old name' }))).document;
  await sendPhoto(app.call, doc.id, LABEL(1));
  assert.equal((await post(app.call, '/api/projects/rename', { from: 'Old name', to: 'other' })).status, 409);
  open = true;
  assert.equal((await post(app.call, '/api/projects/rename', { from: 'Old name', to: 'New name' })).status, 409);
  open = false;
  const r = await json(await post(app.call, '/api/projects/rename', { from: 'Old name', to: 'New name' }));
  assert.equal(r.project.name, 'New name');
  const { document } = await (await app.call(`/api/documents/${doc.id}`)).json();
  assert.deepEqual([document.project, lineTexts(document)], ['New name', [['a [[guess]]']]]);
  assert.equal((await post(app.call, '/api/projects/rename', { from: 'Missing', to: 'x' })).status, 404);
});

test('projects: deleting a project moves the whole folder to the Archive; restoring brings it all back', async () => {
  const app = await folderApp({ read: async () => ({ notes: [card(P('day [[one]]'))], issue: '' }) });
  await post(app.call, '/api/projects', { name: 'Retreat' });
  const d1 = (await json(await post(app.call, '/api/documents', { name: 'Day 1', project: 'Retreat' }))).document;
  const d2 = (await json(await post(app.call, '/api/documents', { name: 'Day 2', project: 'Retreat' }))).document;
  await sendPhoto(app.call, d1.id, LABEL(1));
  const r = await json(await post(app.call, '/api/projects/archive', { name: 'Retreat' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.documents, []);
  assert.deepEqual((await readdir(path.join(app.wordFolder, 'Archive', 'Retreat'))).sort(), ['Day 1.docx', 'Day 2.docx']);
  assert.equal((await app.call(`/api/documents/${d1.id}`)).status, 404);
  const archived = await archiveList(app.call);
  assert.deepEqual(archived.map((a) => [a.type, a.name, a.files]), [['project', 'Retreat', 2]]);

  const restored = await json(await restoreDoc(app.call, archived[0].id));
  assert.deepEqual(restored.project, { name: 'Retreat' });
  const { document } = await (await app.call(`/api/documents/${d1.id}`)).json();
  assert.deepEqual([document.project, lineTexts(document)], ['Retreat', [['day [[one]]']]], 'same ids, yellow kept');
  assert.ok(await (await app.call(`/api/documents/${d2.id}`)).json());
  assert.deepEqual(await archiveList(app.call), []);
});

test('projects: a file deleted from a project goes back into that project, even if the project was removed meanwhile', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') });
  await post(app.call, '/api/projects', { name: 'Trip' });
  const doc = (await json(await post(app.call, '/api/documents', { name: 'Notes', project: 'Trip' }))).document;
  await archiveDoc(app.call, doc.id);
  const [item] = await archiveList(app.call);
  assert.deepEqual([item.type, item.name, item.from], ['file', 'Notes', 'Trip']);
  await rm(path.join(app.wordFolder, 'Trip'), { recursive: true });
  const restored = await json(await restoreDoc(app.call, item.id));
  assert.deepEqual([restored.document.name, restored.document.project], ['Notes', 'Trip']);
  assert.ok((await readdir(path.join(app.wordFolder, 'Trip'))).includes('Notes.docx'));
});

test('projects: two archived projects with the same name, and restoring next to a new one, never clash', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') });
  for (let i = 0; i < 2; i += 1) {
    await post(app.call, '/api/projects', { name: 'Weekly' });
    await post(app.call, '/api/documents', { name: `Week ${i}`, project: 'Weekly' });
    await post(app.call, '/api/projects/archive', { name: 'Weekly' });
  }
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual((await readdir(path.join(app.wordFolder, 'Archive'))).sort(), ['Weekly', `Weekly (archived ${day})`]);
  await post(app.call, '/api/projects', { name: 'Weekly' });
  const archived = await archiveList(app.call);
  const back = await json(await restoreDoc(app.call, archived.find((a) => a.name === 'Weekly').id));
  assert.equal(back.project.name, 'Weekly 2');
  const back2 = await json(await restoreDoc(app.call, archived.find((a) => a.name !== 'Weekly').id));
  assert.equal(back2.project.name, 'Weekly 3', 'goes back under its original name, numbered');
});

test('projects: a project QR code opens the project for whoever scans it; changes reach every screen', async () => {
  const app = await folderApp({ read: async () => noteSaying('x') }, { passcode: 'rig2026' });
  await post(app.call, '/api/projects', { name: 'Shared' });
  const ear = await listen(app.call);
  const r = await json(await post(app.call, '/api/pair', { project: 'Shared' }));
  assert.equal(r.status, 200);
  const base = new URL((await app.call('/api/status')).url).origin;
  const claimed = await (await fetch(`${base}/api/pair/claim`, { method: 'POST', headers: { 'X-App': 'photo-to-word' }, body: JSON.stringify({ code: r.url.split('/p/')[1] }) })).json();
  assert.deepEqual(claimed, { passcode: 'rig2026', project: 'Shared' });
  assert.equal((await post(app.call, '/api/pair', { project: 'Nope' })).status, 404);
  const doc = (await json(await post(app.call, '/api/documents', { name: 'A', project: 'Shared' }))).document;
  await post(app.call, `/api/documents/${doc.id}/move`, { project: '' });
  await post(app.call, '/api/projects/rename', { from: 'Shared', to: 'Shared 2026' });
  const news = await ear.waitFor(3);
  ear.stop();
  assert.deepEqual(news.map((n) => n.type), ['lists', 'lists', 'lists']);
});

test('projects: documents kept inside the app say projects need the OneDrive folder', async () => {
  const { call } = await startApp({ reader: { read: async () => noteSaying('x') } });
  assert.equal((await call('/api/projects')).status, 400);
  assert.equal((await post(call, '/api/projects', { name: 'x' })).status, 400);
});
