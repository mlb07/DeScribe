// What the Mac does when the phone asks for something.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectImageType, ReadError } from './reader.js';
import { StoreError } from './documents.js';
import { qrSvg } from './qr.js';
import { paperBullets } from './word.js';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // the AI's limit for one photo
const MAX_FORM_BYTES = 10 * 1024;
const MAX_EDIT_BYTES = 512 * 1024;
const MAX_WRONG_TRIES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

const FILE_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    if (Number(request.headers['content-length']) > limit) {
      reject(new Problem(413, 'That is too large to send.'));
      return;
    }
    const pieces = [];
    let size = 0;
    request.on('data', (piece) => {
      size += piece.length;
      if (size > limit) reject(new Problem(413, 'That is too large to send.'));
      else pieces.push(piece);
    });
    request.on('end', () => resolve(Buffer.concat(pieces)));
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function fingerprint(text) {
  return createHash('sha256').update(String(text)).digest();
}

// The Mac's address on the Wi-Fi (for the QR code), skipping addresses that only exist
// when the Mac has no proper network ("169.254...").
export function wifiAddress() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) found.push({ name, address: item.address });
    }
  }
  found.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
  return found[0]?.address || null;
}

const PAIR_MS = 10 * 60 * 1000;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to mix up
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;

export function createApp({
  store,
  reader,
  mode,
  practiceReason = null,
  passcode = '',
  loadCrew,
  publicFolder,
  log = console,
  networkAddress = wifiAddress,
}) {
  const wrongTries = new Map();
  const wrongCodes = new Map();

  // --- Live updates -----------------------------------------------------------------
  // Every open DeScribe screen (phone or laptop) keeps one connection open here, and is
  // told the moment a list changes, so they all show the same thing.
  const listeners = new Set();
  function broadcast(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of listeners) response.write(line);
  }
  function openStream(request, response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    listeners.add(response);
    const heartbeat = setInterval(() => response.write(': still here\n\n'), 20000);
    const stop = () => {
      clearInterval(heartbeat);
      listeners.delete(response);
    };
    request.on('close', stop);
    response.on('close', stop);
  }
  // Which screen made a change, so it can ignore the news of its own change.
  const sourceOf = (request) => {
    const id = String(request.headers['x-client'] || '');
    return /^[a-z0-9-]{1,64}$/i.test(id) ? id : '';
  };

  // --- Pairing a phone by QR code ---------------------------------------------------
  // The laptop asks for a code; the QR code holds a link with it. Scanning it opens
  // DeScribe on the phone, already unlocked, on the same list. Codes last 10 minutes.
  const pairings = new Map();
  function phoneAddress(request) {
    const host = String(request.headers.host || '');
    const [, name = '', port = ''] = host.match(/^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/) || [];
    if (name && !/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(name)) return host;
    const wifi = networkAddress();
    return wifi ? `${wifi}${port ? `:${port}` : ''}` : host;
  }
  // "target" is { documentId } (opens that file) or { project } (opens the project's files).
  function newPairing(target) {
    for (const [code, pairing] of pairings) if (pairing.until < Date.now()) pairings.delete(code);
    const code = [...randomBytes(10)].map((byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join('');
    const until = Date.now() + PAIR_MS;
    pairings.set(code, { ...target, until });
    return { code, until };
  }
  function claimPairing(request, code) {
    const who = request.socket.remoteAddress || 'unknown';
    const record = wrongCodes.get(who);
    if (record && record.count >= MAX_WRONG_TRIES && Date.now() < record.until) {
      throw new Problem(429, 'Too many tries. Wait 15 minutes, then scan a new code.');
    }
    const pairing = CODE_PATTERN.test(code) ? pairings.get(code) : null;
    if (!pairing || pairing.until < Date.now()) {
      if (wrongCodes.size > 1000) wrongCodes.clear();
      const expired = !record || Date.now() >= record.until;
      wrongCodes.set(who, { count: expired ? 1 : record.count + 1, until: Date.now() + LOCKOUT_MS });
      throw new Problem(404, 'This QR code has expired. Show a new one on the laptop and scan it again.');
    }
    return pairing.project ? { passcode, project: pairing.project } : { passcode, documentId: pairing.documentId };
  }

  function checkPasscode(request) {
    if (!passcode) return;
    const who = request.socket.remoteAddress || 'unknown';
    const record = wrongTries.get(who);
    if (record && record.count >= MAX_WRONG_TRIES && Date.now() < record.until) {
      throw new Problem(429, 'Too many wrong passcodes. Try again in 15 minutes.');
    }
    if (timingSafeEqual(fingerprint(request.headers['x-passcode'] ?? ''), fingerprint(passcode))) {
      wrongTries.delete(who);
      return;
    }
    if (wrongTries.size > 1000) wrongTries.clear();
    const expired = !record || Date.now() >= record.until;
    wrongTries.set(who, { count: expired ? 1 : record.count + 1, until: Date.now() + LOCKOUT_MS });
    throw new Problem(401, 'That passcode is not right.');
  }

  const publicView = (doc) => ({
    id: doc.id,
    name: doc.name,
    project: doc.project || '',
    notes: doc.notes,
    version: doc.version || 0,
    editable: Boolean(doc.editable && store.applyEdits),
  });

  // Readings already paid for but not yet added (for example because the Word file was
  // open), so a retry of the same photo doesn't pay for it again.
  const readings = new Map();

  async function addPhoto(id, photoId, image, under = null) {
    return store.oneAtATime(id, async () => {
      const doc = await store.get(id);
      if (!doc) throw new Problem(404, 'That document no longer exists.');

      // If the phone lost signal and sent this photo again, don't add it twice.
      if (doc.photoIds.includes(photoId)) return { document: publicView(doc), added: 0, issue: '' };

      // Check the document can be changed before paying for the photo to be read.
      if (store.checkCanAdd) await store.checkCanAdd(doc);

      let reading = readings.get(photoId);
      if (!reading) {
        const crew = await loadCrew();
        reading = await reader.read({ image, ...crew });
        readings.set(photoId, reading);
        if (readings.size > 50) readings.delete(readings.keys().next().value);
      }
      const { notes, issue } = reading;
      const tidied = paperBullets(notes);
      if (tidied.length === 0) {
        return { document: publicView(doc), added: 0, issue: issue.trim() || 'No handwriting was found in this photo.' };
      }
      if (store.checkCanAdd) await store.checkCanAdd(doc); // it may have been opened while reading
      const updated = await store.addNotes(doc, tidied, photoId, notes, under);
      readings.delete(photoId);
      return { document: publicView(updated), added: tidied.length, issue: '', ...(updated.placement || {}) };
    });
  }

  async function readJson(request, limit) {
    try {
      return JSON.parse((await readBody(request, limit)).toString('utf8'));
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem(400, 'That could not be understood.');
    }
  }

  async function applyEdits(id, edits) {
    if (!store.applyEdits) throw new Problem(400, 'Editing on the phone needs SAVE_FOLDER set in the .env file.');
    return store.oneAtATime(id, async () => {
      const doc = await store.get(id);
      if (!doc) throw new Problem(404, 'That document no longer exists.');
      await store.checkCanAdd(doc, 'edits');
      const { document, indexMap, results } = await store.applyEdits(doc, edits);
      return { document: publicView(document), indexMap, results };
    });
  }

  async function handleApi(request, response, url) {
    const route = url.pathname;
    const method = request.method;

    // Web pages on other sites can't add this label, so they can't trigger changes here.
    if (method !== 'GET' && request.headers['x-app'] !== 'photo-to-word') {
      throw new Problem(403, 'Not allowed.');
    }

    if (route === '/api/status' && method === 'GET') {
      sendJson(response, 200, { mode, practiceReason, passcodeNeeded: Boolean(passcode) });
      return;
    }
    if (route === '/api/pair/claim' && method === 'POST') {
      const form = await readJson(request, MAX_FORM_BYTES);
      sendJson(response, 200, claimPairing(request, String(form?.code || '').toUpperCase()));
      return;
    }

    checkPasscode(request);

    if (route === '/api/events' && method === 'GET') {
      openStream(request, response);
      return;
    }
    if (route === '/api/pair' && method === 'POST') {
      const form = await readJson(request, MAX_FORM_BYTES);
      const documentId = String(form?.documentId || '');
      const project = String(form?.project || '');
      if (project) {
        if (!store.listProjects || !(await store.listProjects()).some((p) => p.name === project)) throw new Problem(404, 'That project no longer exists.');
      } else if (!/^[0-9a-f-]{36}$/.test(documentId) || !(await store.get(documentId))) {
        throw new Problem(404, 'That list no longer exists.');
      }
      const { code, until } = newPairing(project ? { project } : { documentId });
      const link = `http://${phoneAddress(request)}/p/${code}`;
      sendJson(response, 200, { url: link, svg: qrSvg(link), expiresAt: new Date(until).toISOString() });
      return;
    }

    if (route === '/api/documents' && method === 'GET') {
      sendJson(response, 200, { documents: await store.list() });
      return;
    }
    if (route === '/api/archive' && method === 'GET') {
      if (!store.listArchive) throw new Problem(400, 'The Archive needs SAVE_FOLDER set in the .env file.');
      sendJson(response, 200, { archived: await store.listArchive() });
      return;
    }
    const restoreMatch = route.match(/^\/api\/archive\/([0-9a-f-]{36})\/restore$/);
    if (restoreMatch && method === 'POST') {
      if (!store.restore) throw new Problem(400, 'The Archive needs SAVE_FOLDER set in the .env file.');
      const restored = await store.restore(restoreMatch[1]);
      sendJson(response, 200, restored.project ? { project: restored.project } : { document: publicView(restored.document) });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }
    // --- Projects (folders of files) ---
    const needsFolder = () => {
      if (!store.listProjects) throw new Problem(400, 'Projects need SAVE_FOLDER set in the .env file.');
    };
    if (route === '/api/projects' && method === 'GET') {
      needsFolder();
      sendJson(response, 200, { projects: await store.listProjects() });
      return;
    }
    if (route === '/api/projects' && method === 'POST') {
      needsFolder();
      const form = await readJson(request, MAX_FORM_BYTES);
      sendJson(response, 201, { project: await store.createProject(form?.name) });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }
    if (route === '/api/projects/rename' && method === 'POST') {
      needsFolder();
      const form = await readJson(request, MAX_FORM_BYTES);
      sendJson(response, 200, { project: await store.renameProject(String(form?.from || ''), form?.to) });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }
    if (route === '/api/projects/archive' && method === 'POST') {
      needsFolder();
      const form = await readJson(request, MAX_FORM_BYTES);
      const archived = await store.archiveProject(String(form?.name || ''));
      sendJson(response, 200, { archived, documents: await store.list() });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }

    if (route === '/api/documents' && method === 'POST') {
      const form = await readJson(request, MAX_FORM_BYTES);
      const project = String(form?.project || '');
      if (project) needsFolder();
      sendJson(response, 201, { document: publicView(project ? await store.create(form?.name, project) : await store.create(form?.name)) });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }

    const match = route.match(/^\/api\/documents\/([0-9a-f-]{36})(\/word|\/photos|\/edits|\/archive|\/move)?$/);
    if (!match) throw new Problem(404, 'Not found.');
    const [, id, action] = match;

    if (!action && method === 'GET') {
      const doc = await store.get(id);
      if (!doc) throw new Problem(404, 'That document no longer exists.');
      sendJson(response, 200, { document: publicView(doc) });
      return;
    }
    if (action === '/word' && method === 'GET') {
      const doc = await store.get(id);
      if (!doc) throw new Problem(404, 'That document no longer exists.');
      const file = await store.wordFile(doc);
      response.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}.docx`,
        'Cache-Control': 'no-store',
      });
      response.end(file);
      return;
    }
    if (action === '/move' && method === 'POST') {
      if (!store.moveDocument) throw new Problem(400, 'Projects need SAVE_FOLDER set in the .env file.');
      const form = await readJson(request, MAX_FORM_BYTES);
      const moved = await store.oneAtATime(id, async () => {
        const doc = await store.get(id);
        if (!doc) throw new Problem(404, 'That list no longer exists.');
        return store.moveDocument(doc, String(form?.project || ''));
      });
      sendJson(response, 200, { document: publicView(moved) });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }
    if (action === '/archive' && method === 'POST') {
      if (!store.archive) throw new Problem(400, 'Deleting lists needs SAVE_FOLDER set in the .env file.');
      const archived = await store.oneAtATime(id, async () => {
        const doc = await store.get(id);
        if (!doc) throw new Problem(404, 'That list no longer exists.');
        return store.archive(doc);
      });
      sendJson(response, 200, { archived, documents: await store.list() });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }
    if (action === '/edits' && method === 'POST') {
      const form = await readJson(request, MAX_EDIT_BYTES);
      const result = await applyEdits(id, form?.edits);
      sendJson(response, 200, result);
      broadcast({ type: 'document', id, version: result.document.version, indexMap: result.indexMap, source: sourceOf(request) });
      return;
    }
    if (action === '/photos' && method === 'POST') {
      const photoId = url.searchParams.get('photo') || '';
      if (!/^[0-9a-f]{16,64}$/.test(photoId)) throw new Problem(400, 'That photo had no label.');
      const image = await readBody(request, MAX_PHOTO_BYTES);
      if (!detectImageType(image)) throw new Problem(415, 'That file is not a photo this app can read.');
      // Optional: the line the photo's lines go directly under (its number and its words).
      // Sent as headers (X-Under-Para, X-Under-Text, URL-encoded) so no document text goes in the address.
      let under = null;
      if (request.headers['x-under-para'] !== undefined) {
        const para = Number(request.headers['x-under-para']);
        let expect = '';
        try {
          expect = decodeURIComponent(String(request.headers['x-under-text'] || ''));
        } catch {
          throw new Problem(400, 'That line could not be understood.');
        }
        if (!Number.isInteger(para) || para < 0 || para > 100000 || expect.length > 10000) throw new Problem(400, 'That line could not be understood.');
        under = { para, expect };
      }
      const result = await addPhoto(id, photoId, image, under);
      sendJson(response, 200, result);
      if (result.added) broadcast({ type: 'document', id, version: result.document.version, indexMap: result.indexMap || null, source: sourceOf(request) });
      return;
    }
    throw new Problem(404, 'Not found.');
  }

  async function serveFile(response, url) {
    const wanted = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(publicFolder, path.normalize(wanted));
    // Only ever hand out files from the public folder.
    if (!filePath.startsWith(publicFolder + path.sep)) throw new Problem(403, 'Not allowed.');
    let contents;
    try {
      contents = await readFile(filePath);
    } catch {
      throw new Problem(404, 'Not found.');
    }
    response.writeHead(200, {
      'Content-Type': FILE_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(contents);
  }

  return async function handleRequest(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(request.url, 'http://localhost');
      const pairLink = url.pathname.match(/^\/p\/([A-Za-z0-9]{10})$/);
      if (pairLink) {
        // The link in a QR code: open the app, which then claims the code.
        response.writeHead(302, { Location: `/?pair=${pairLink[1].toUpperCase()}`, 'Cache-Control': 'no-store' });
        response.end();
      } else if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
      else await serveFile(response, url);
    } catch (error) {
      const known = error instanceof Problem || error instanceof ReadError || error instanceof StoreError;
      if (!known) log.error(error);
      const status = known ? error.status : 500;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (status === 413) {
        // Let the rest of an oversized upload arrive (and throw it away) before answering,
        // so the phone gets the message instead of a broken connection. Absurdly large
        // uploads are cut off instead.
        response.setHeader('Connection', 'close');
        if (Number(request.headers['content-length']) > 50 * 1024 * 1024) {
          response.on('finish', () => request.destroy());
        } else if (!request.readableEnded) {
          await new Promise((resolve) => {
            request.on('end', resolve);
            request.on('error', resolve);
            request.on('close', resolve);
            request.resume();
          });
        }
      }
      sendJson(response, status, {
        error: {
          message: known ? error.message : 'Something went wrong on the Mac.',
          retryable: Boolean(error.retryable),
          ...(known && error.code ? { code: error.code } : {}),
        },
      });
    }
  };
}
