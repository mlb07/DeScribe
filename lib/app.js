// What the Mac does when the phone asks for something.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectFileType, ReadError } from './reader.js';
import { checkPdfPage, MAX_PDF_PAGE_BYTES, pdfLibForBrowser } from './pdf.js';
import { StoreError } from './documents.js';
import { readTicket, signTicket } from './access.js';
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
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

class Problem extends Error {
  constructor(status, message, code = '', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
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

const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;

// Whether a request comes from this Mac itself (its own browser), not a phone or another computer.
export function fromThisMac(request) {
  const address = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (address === '127.0.0.1' || address === '::1') return true;
  return Object.values(os.networkInterfaces()).some((list) => (list || []).some((item) => item.address === address));
}

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
  wordLink = null,
  openOnMac = null, // opens a link (an "ms-word:" one) on this Mac, as if clicked here
  isThisMac = fromThisMac,
}) {
  const wrongTries = new Map();

  // --- Live updates -----------------------------------------------------------------
  // Every open DeScribe screen (phone or laptop) keeps one connection open here, and is
  // told the moment a list changes, so they all show the same thing.
  const listeners = new Set(); // { response, who }
  function broadcast(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const { response, who } of listeners) {
      if (!who.owner && event.type === 'document' && event.id !== who.id && event.projectId !== who.id) continue;
      response.write(line);
    }
  }
  function openStream(request, response, who) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    const listener = { response, who };
    listeners.add(listener);
    const heartbeat = setInterval(() => response.write(': still here\n\n'), 20000);
    const stop = () => {
      clearInterval(heartbeat);
      listeners.delete(listener);
    };
    request.on('close', stop);
    response.on('close', stop);
  }
  // Which screen made a change, so it can ignore the news of its own change.
  const sourceOf = (request) => {
    const id = String(request.headers['x-client'] || '');
    return /^[a-z0-9-]{1,64}$/i.test(id) ? id : '';
  };

  // --- Who is asking: the owner, or a guest -----------------------------------------
  // The owner sends the main passcode. A guest sends the signed ticket they got from a
  // list's or project's permanent link (its QR code), plus a ticket for each password
  // they have entered. Nothing a guest's phone holds can be edited to reach further.

  const wrongCodes = new Map();
  const wrongPasswords = new Map();

  // Counts wrong tries per address; after 10, waits 15 minutes.
  function limiter(map, request, message) {
    const who = request.socket.remoteAddress || 'unknown';
    const record = map.get(who);
    if (record && record.count >= MAX_WRONG_TRIES && Date.now() < record.until) throw new Problem(429, message);
    return {
      fail() {
        if (map.size > 1000) map.clear();
        const expired = !record || Date.now() >= record.until;
        map.set(who, { count: expired ? 1 : record.count + 1, until: Date.now() + LOCKOUT_MS });
      },
      pass() {
        map.delete(who);
      },
    };
  }

  async function identify(request) {
    const given = String(request.headers['x-passcode'] ?? '');
    const guestTicket = String(request.headers['x-guest'] ?? '');
    if (!passcode && !guestTicket) return { owner: true };
    if (passcode && given) {
      const tries = limiter(wrongTries, request, 'Too many wrong passcodes. Try again in 15 minutes.');
      if (timingSafeEqual(fingerprint(given), fingerprint(passcode))) {
        tries.pass();
        return { owner: true };
      }
      if (!guestTicket) {
        tries.fail();
        throw new Problem(401, 'That passcode is not right.');
      }
    }
    if (guestTicket && store.secret) {
      const secret = await store.secret();
      const ticket = readTicket(secret, guestTicket);
      let scope = null;
      if (ticket?.kind === 'list') scope = await store.accessInfo(ticket.id);
      if (ticket?.kind === 'project') scope = await store.projectInfo(ticket.id);
      if (!scope || ticket.v !== scope.linkVersion) {
        throw new Problem(401, 'This link no longer works. Ask the owner for the new QR code.', 'link');
      }
      const unlocks = String(request.headers['x-unlock'] || '')
        .split(',')
        .map((text) => readTicket(secret, text.trim()))
        .filter(Boolean);
      return { owner: false, kind: ticket.kind, id: ticket.id, name: scope.name, unlocks };
    }
    const tries = limiter(wrongTries, request, 'Too many wrong passcodes. Try again in 15 minutes.');
    tries.fail();
    throw new Problem(401, 'That passcode is not right.');
  }

  const ownerOnly = (who) => {
    if (!who.owner) throw new Problem(403, 'Only the owner can do that.', 'owner');
  };

  // Whether a guest's link covers a list (info from store.accessInfo).
  const covers = (who, info) => who.owner || (who.kind === 'list' ? info.id === who.id : info.projectId === who.id);

  // The first password a guest still has to enter for a list, if any.
  function missingPassword(who, info) {
    if (who.owner) return null;
    const needed = [];
    if (info.projectLocked) needed.push({ kind: 'project', id: info.projectId, v: info.projectLockVersion, name: info.project });
    if (info.locked) needed.push({ kind: 'list', id: info.id, v: info.lockVersion, name: info.name });
    return needed.find((need) => !who.unlocks.some((u) => u.kind === need.kind && u.id === need.id && u.v === need.v)) || null;
  }

  // Throws unless this person may open the list right now.
  async function requireList(who, id) {
    if (who.owner) return;
    const info = await store.accessInfo(id);
    if (!info) throw new Problem(404, 'That list no longer exists.');
    if (!covers(who, info)) throw new Problem(403, "You don't have access to that list.", 'owner');
    const missing = missingPassword(who, info);
    if (missing) {
      const what = missing.kind === 'project' ? `The project "${missing.name}"` : `"${missing.name}"`;
      throw new Problem(403, `${what} is password protected.`, 'locked', { lock: { kind: missing.kind, id: missing.id, name: missing.name } });
    }
  }

  // The lists this person can see, each marked "locked" if it still needs a password.
  async function listsFor(who) {
    const all = await store.list();
    if (who.owner) return all;
    const result = [];
    for (const doc of all) {
      const info = await store.accessInfo(doc.id);
      if (info && covers(who, info)) result.push({ ...doc, locked: Boolean(missingPassword(who, info)) });
    }
    return result;
  }

  // The permanent link (and QR code) for a list or a project.
  function phoneAddress(request) {
    const host = String(request.headers.host || '');
    const [, name = '', port = ''] = host.match(/^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/) || [];
    if (name && !/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(name)) return host;
    const wifi = networkAddress();
    return wifi ? `${wifi}${port ? `:${port}` : ''}` : host;
  }
  function linkReply(request, code) {
    const link = `http://${phoneAddress(request)}/p/${code}`;
    return { url: link, svg: qrSvg(link) };
  }
  // "Which list or project" from a request body: { documentId } or { project }.
  function linkTarget(form) {
    const project = String(form?.project || '');
    if (project) return ['project', project];
    const documentId = String(form?.documentId || '');
    if (!/^[0-9a-f-]{36}$/.test(documentId)) throw new Problem(404, 'That list no longer exists.');
    return ['list', documentId];
  }

  const publicView = (doc, who = { owner: true }) => ({
    id: doc.id,
    name: doc.name,
    project: doc.project || '',
    projectId: doc.projectId || null,
    locked: Boolean(doc.locked),
    wordUrl: who.owner && wordLink && doc.fileName ? wordLink(doc.fileName) : null,
    notes: doc.notes,
    version: doc.version || 0,
    editable: Boolean(doc.editable && store.applyEdits),
  });

  // Readings already paid for but not yet added (for example because the Word file was
  // open), so a retry of the same photo doesn't pay for it again.
  const readings = new Map();

  async function addPhoto(id, photoId, image, under = null, who = { owner: true }) {
    return store.oneAtATime(id, async () => {
      const doc = await store.get(id);
      if (!doc) throw new Problem(404, 'That document no longer exists.');

      // If the phone lost signal and sent this photo again, don't add it twice.
      if (doc.photoIds.includes(photoId)) return { document: publicView(doc, who), added: 0, issue: '' };

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
        const where = detectFileType(image) === 'application/pdf' ? 'on this page' : 'in this photo';
        return { document: publicView(doc, who), added: 0, issue: issue.trim() || `No handwriting was found ${where}.` };
      }
      if (store.checkCanAdd) await store.checkCanAdd(doc); // it may have been opened while reading
      const updated = await store.addNotes(doc, tidied, photoId, notes, under);
      readings.delete(photoId);
      return { document: publicView(updated, who), added: tidied.length, issue: '', ...(updated.placement || {}) };
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

  async function applyEdits(id, edits, who = { owner: true }) {
    if (!store.applyEdits) throw new Problem(400, 'Editing on the phone needs SAVE_FOLDER set in the .env file.');
    return store.oneAtATime(id, async () => {
      const doc = await store.get(id);
      if (!doc) throw new Problem(404, 'That document no longer exists.');
      await store.checkCanAdd(doc, 'edits');
      const { document, indexMap, results } = await store.applyEdits(doc, edits);
      return { document: publicView(document, who), indexMap, results };
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

    // Scanning a QR code: the code becomes a guest ticket for that list or project.
    if (route === '/api/pair/claim' && method === 'POST') {
      const form = await readJson(request, MAX_FORM_BYTES);
      const code = String(form?.code || '').toUpperCase();
      const tries = limiter(wrongCodes, request, 'Too many tries. Wait 15 minutes, then scan the code again.');
      const link = CODE_PATTERN.test(code) && store.findLink ? await store.findLink(code) : null;
      if (!link) {
        tries.fail();
        throw new Problem(404, 'This QR code no longer works. Ask the owner for the new one.');
      }
      tries.pass();
      const guest = signTicket(await store.secret(), { kind: link.kind, id: link.id, v: link.version });
      sendJson(response, 200, { guest, kind: link.kind, id: link.id, name: link.name });
      return;
    }

    const who = await identify(request);

    if (route === '/api/me' && method === 'GET') {
      // On this Mac itself, "Open in the Word app" is done by DeScribe directly (see below).
      const onThisMac = Boolean(who.owner && openOnMac && wordLink && isThisMac(request));
      sendJson(response, 200, who.owner ? { role: 'owner', onThisMac } : { role: 'guest', kind: who.kind, id: who.id, name: who.name });
      return;
    }
    if (route === '/api/events' && method === 'GET') {
      openStream(request, response, who);
      return;
    }

    // A guest enters a list's or project's password; they get a ticket for it.
    if (route === '/api/unlock' && method === 'POST') {
      const form = await readJson(request, MAX_FORM_BYTES);
      const kind = form?.kind === 'project' ? 'project' : 'list';
      const id = String(form?.id || '');
      if (!store.checkPassword) throw new Problem(400, 'Passwords need SAVE_FOLDER set in the .env file.');
      if (!who.owner) {
        let allowed = false;
        if (kind === 'project') {
          allowed = (who.kind === 'project' && who.id === id) || (who.kind === 'list' && (await store.accessInfo(who.id))?.projectId === id);
        } else {
          const info = await store.accessInfo(id);
          allowed = Boolean(info && covers(who, info));
        }
        if (!allowed) throw new Problem(403, "You don't have access to that.", 'owner');
      }
      const tries = limiter(wrongPasswords, request, 'Too many wrong passwords. Try again in 15 minutes.');
      const result = await store.checkPassword(kind, id, String(form?.password ?? ''));
      if (!result.ok) {
        tries.fail();
        throw new Problem(401, 'That password is not right.', 'password');
      }
      tries.pass();
      sendJson(response, 200, { unlock: signTicket(await store.secret(), { kind, id, v: result.version }) });
      return;
    }

    if (route === '/api/documents' && method === 'GET') {
      sendJson(response, 200, { documents: await listsFor(who) });
      return;
    }

    // --- Projects (folders of files) ---
    const needsFolder = () => {
      if (!store.listProjects) throw new Problem(400, 'Projects need SAVE_FOLDER set in the .env file.');
    };
    if (route === '/api/projects' && method === 'GET') {
      needsFolder();
      const projects = await store.listProjects();
      if (who.owner) {
        sendJson(response, 200, { projects });
        return;
      }
      // For a guest, "locked" means they still have to enter the project's password.
      const mine = [];
      for (const project of projects.filter((p) => who.kind === 'project' && p.id === who.id)) {
        const info = await store.projectInfo(project.id);
        const entered = who.unlocks.some((u) => u.kind === 'project' && u.id === project.id && u.v === info?.lockVersion);
        mine.push({ ...project, locked: Boolean(info?.locked) && !entered });
      }
      sendJson(response, 200, { projects: mine });
      return;
    }

    // Everything below changes lists, projects or access: the owner only.
    const ownerRoutes =
      route === '/api/archive' ||
      route.startsWith('/api/archive/') ||
      route.startsWith('/api/projects') ||
      route.startsWith('/api/pair') ||
      route.startsWith('/api/access') ||
      (route === '/api/documents' && method === 'POST');
    if (ownerRoutes) ownerOnly(who);

    if (route === '/api/pair' && method === 'POST') {
      if (!store.linkFor) throw new Problem(400, 'QR codes need SAVE_FOLDER set in the .env file.');
      const [kind, ref] = linkTarget(await readJson(request, MAX_FORM_BYTES));
      const link = await store.linkFor(kind, ref);
      sendJson(response, 200, linkReply(request, link.code));
      return;
    }
    if (route === '/api/pair/reset' && method === 'POST') {
      if (!store.resetLink) throw new Problem(400, 'QR codes need SAVE_FOLDER set in the .env file.');
      const [kind, ref] = linkTarget(await readJson(request, MAX_FORM_BYTES));
      const link = await store.resetLink(kind, ref);
      // Anyone who came in through the old link is shut out now, live connection included.
      const scopeId = kind === 'project' ? (await store.listProjects()).find((project) => project.name === ref)?.id : ref;
      for (const listener of [...listeners]) {
        if (!listener.who.owner && listener.who.id === scopeId) listener.response.end();
      }
      sendJson(response, 200, linkReply(request, link.code));
      return;
    }
    const passwordOf = (form) => (form?.password === undefined || form?.password === null || form?.password === '' ? null : String(form.password));
    if (route === '/api/access/password' && method === 'POST') {
      if (!store.setPassword) throw new Problem(400, 'Passwords need SAVE_FOLDER set in the .env file.');
      const form = await readJson(request, MAX_FORM_BYTES);
      const [kind, ref] = linkTarget(form);
      sendJson(response, 200, await store.setPassword(kind, ref, passwordOf(form)));
      broadcast({ type: 'lists', source: sourceOf(request) });
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
      sendJson(response, 200, restored.project ? { project: restored.project } : { document: publicView(restored.document, who) });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }
    if (route === '/api/projects' && method === 'POST') {
      needsFolder();
      const form = await readJson(request, MAX_FORM_BYTES);
      sendJson(response, 201, { project: await store.createProject(form?.name, passwordOf(form)) });
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
      const password = passwordOf(form);
      if (project || password !== null) needsFolder();
      const created = project || password !== null ? await store.create(form?.name, project, password) : await store.create(form?.name);
      sendJson(response, 201, { document: publicView(created, who) });
      broadcast({ type: 'lists', source: sourceOf(request) });
      return;
    }

    const match = route.match(/^\/api\/documents\/([0-9a-f-]{36})(\/word|\/photos|\/edits|\/archive|\/move|\/open-in-word)?$/);
    if (!match) throw new Problem(404, 'Not found.');
    const [, id, action] = match;
    if (action === '/archive' || action === '/move' || action === '/open-in-word') ownerOnly(who);
    else await requireList(who, id);

    if (!action && method === 'GET') {
      const doc = await store.get(id);
      if (!doc) throw new Problem(404, 'That document no longer exists.');
      sendJson(response, 200, { document: publicView(doc, who) });
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
    // Opens the file in the Word app on this Mac. Word on a Mac needs the file's address with
    // its name exactly as typed (tested: with codes such as %20 or %C3%A9 it can't find the
    // file), and a browser adds codes for accented letters, so DeScribe hands it over itself.
    if (action === '/open-in-word' && method === 'POST') {
      if (!openOnMac || !wordLink || !isThisMac(request)) throw new Problem(400, 'This only works on the Mac DeScribe runs on.');
      const doc = await store.get(id);
      if (!doc) throw new Problem(404, 'That list no longer exists.');
      try {
        await openOnMac(`ms-word:ofe|u|${decodeURIComponent(wordLink(doc.fileName))}`);
      } catch (error) {
        log.error(error);
        throw new Problem(502, "Word couldn't be opened on this Mac. Try Word on the web instead.");
      }
      sendJson(response, 200, { opened: true });
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
      sendJson(response, 200, { document: publicView(moved, who) });
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
      const result = await applyEdits(id, form?.edits, who);
      sendJson(response, 200, result);
      broadcast({ type: 'document', id, projectId: result.document.projectId, version: result.document.version, indexMap: result.indexMap, source: sourceOf(request) });
      return;
    }
    if (action === '/photos' && method === 'POST') {
      const photoId = url.searchParams.get('photo') || '';
      if (!/^[0-9a-f]{16,64}$/.test(photoId)) throw new Problem(400, 'That photo had no label.');
      // A photo, or one page of a PDF (the phone splits PDFs into pages before sending).
      const image = await readBody(request, MAX_PDF_PAGE_BYTES);
      const fileType = detectFileType(image);
      if (!fileType) throw new Problem(415, 'That file is not a photo or PDF this app can read.');
      if (fileType === 'application/pdf') await checkPdfPage(image);
      else if (image.length > MAX_PHOTO_BYTES) throw new Problem(413, 'That photo is too large to send.');
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
      const result = await addPhoto(id, photoId, image, under, who);
      sendJson(response, 200, result);
      if (result.added) {
        broadcast({ type: 'document', id, projectId: result.document.projectId, version: result.document.version, indexMap: result.indexMap || null, source: sourceOf(request) });
      }
      return;
    }
    throw new Problem(404, 'Not found.');
  }

  async function serveFile(response, url) {
    if (url.pathname === '/vendor/pdf-lib.esm.min.js') {
      // The PDF splitter, from the installed pdf-lib package (only loaded when a PDF is added).
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      response.end(await pdfLibForBrowser());
      return;
    }
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
          ...(known && error.lock ? { lock: error.lock } : {}),
        },
      });
    }
  };
}
