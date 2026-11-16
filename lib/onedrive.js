// Finds the web address of the OneDrive folder the Word files are saved in, so the app
// can offer "Open in Word" (the Word app or Word on the web) without downloading a copy.
//
// The address is read from the OneDrive app's own settings on this Mac each time the
// app starts. Nothing about the account is written into the code.

import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const squash = (name) => name.replace(/\s+/g, '').toLowerCase();

// "Folder/Sub/File.docx" -> "Folder/Sub/File.docx" with each part made safe for a web address.
const encodePath = (relative) => relative.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join('/');

/**
 * Returns a function that turns a Word file's name (relative to saveFolder) into its
 * OneDrive web address, or null when the save folder is not in a work OneDrive.
 */
export async function findWordLinks(saveFolder, {
  settingsFolder = path.join(os.homedir(), 'Library/Application Support/OneDrive/settings'),
  cloudStorage = path.join(os.homedir(), 'Library/CloudStorage'),
} = {}) {
  if (!saveFolder) return null;
  const relative = path.relative(cloudStorage, path.resolve(saveFolder));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const [rootName, ...inside] = relative.split(path.sep);
  if (!/^OneDrive-/i.test(rootName)) return null;

  let accounts = [];
  try {
    accounts = (await readdir(settingsFolder)).filter((name) => /^Business\d+$/.test(name));
  } catch {
    return null;
  }

  for (const account of accounts) {
    const folder = path.join(settingsFolder, account);
    let files = [];
    try {
      files = (await readdir(folder)).filter((name) => name.endsWith('.ini'));
    } catch {
      continue;
    }
    // The account's own OneDrive ("MySite") line names its folder on the Mac and its address.
    let siteAddress = null;
    for (const file of files) {
      const text = await readFile(path.join(folder, file), 'utf8').catch(() => '');
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('libraryScope') || !line.includes('"MySite"')) continue;
        const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        const address = quoted.find((value) => /^https:\/\//.test(value));
        const mount = quoted.find((value) => value.includes('OneDrive'));
        if (address && mount && squash(path.basename(mount)) === squash(rootName)) siteAddress = address;
      }
    }
    if (!siteAddress) continue;
    const policy = await readFile(path.join(folder, 'ClientPolicy.ini'), 'utf8').catch(() => '');
    let base = policy.match(/^DavUrlNamespace\s*=\s*(https:\/\/\S+)/m)?.[1] || `${siteAddress.replace(/\/+$/, '')}/Documents/`;
    if (!base.endsWith('/')) base += '/';
    if (!base.startsWith(siteAddress.replace(/\/+$/, ''))) continue;
    const prefix = inside.join('/');
    return (fileName) => `${base}${encodePath(prefix ? `${prefix}/${fileName}` : fileName)}`;
  }
  return null;
}
