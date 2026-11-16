// Starts the app on your Mac. Run it with: npm start

import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.js';
import { createCrewLoader } from './lib/crew.js';
import { createDocumentStore, createFolderStore } from './lib/documents.js';
import { findWordLinks } from './lib/onedrive.js';
import { DEFAULT_MODEL, createAiReader, createCheckedReader, createPracticeReader } from './lib/reader.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load your private settings, if you have made a .env file.
try {
  process.loadEnvFile(path.join(here, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const PORT = Number(process.env.PORT) || 4000;
// Where the Word files go, for example your OneDrive. Without it, documents stay inside the app.
const saveFolder = (process.env.SAVE_FOLDER || '').trim().replace(/^~(?=\/)/, os.homedir());
// Where the app keeps its own records (document list, guesses, backups). Only changed for testing.
const dataFolder = (process.env.DATA_FOLDER || '').trim() || path.join(here, 'documents');
const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
const passcode = (process.env.APP_PASSCODE || '').trim();
const model = (process.env.AI_MODEL || '').trim() || DEFAULT_MODEL;
// Optional: a stronger model that re-reads a photo when the first one is unsure. Off unless set.
const setting = (process.env.AI_CHECK_MODEL || '').trim();
const checkModel = !setting || setting.toLowerCase() === 'off' || setting === model ? null : setting;

// The AI only switches on with a passcode too, so nobody else can spend your credit.
const useAi = Boolean(apiKey && passcode);
const practiceReason = useAi ? null : apiKey ? 'no-passcode' : 'no-key';

// One line per AI read, so you can see which model read each photo and roughly what it cost.
function logRead(result) {
  if (result.failed) return console.log(`Second opinion failed (${result.failed}); kept the first reading.`);
  const u = result.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  console.log(`Read with ${result.model}: ${input} tokens in, ${u.output_tokens || 0} out.`);
}

function makeReader() {
  if (!useAi) return createPracticeReader();
  const first = createAiReader({ apiKey, model });
  if (!checkModel) return { read: async (input) => { const r = await first.read(input); logRead(r); return r; } };
  return createCheckedReader({ first, second: createAiReader({ apiKey, model: checkModel }), log: logRead });
}

// The OneDrive web address of the save folder, for "Open in Word" (found in OneDrive's own settings).
const wordLink = await findWordLinks(saveFolder);

// Opens a link on this Mac as if it were clicked here (used for "Open in the Word app").
// The link is passed as an argument, never pasted into the script.
const openOnMac =
  process.platform === 'darwin'
    ? (link) =>
        new Promise((resolve, reject) => {
          execFile('osascript', ['-e', 'on run argv', '-e', 'open location (item 1 of argv)', '-e', 'end run', link], { timeout: 15000 }, (error) =>
            error ? reject(error) : resolve(),
          );
        })
    : null;

const handleRequest = createApp({
  store: saveFolder
    ? createFolderStore({
        folder: saveFolder,
        indexFile: path.join(dataFolder, '.word-folder-index.json'),
        backupFolder: path.join(dataFolder, 'readings-backup'),
      })
    : createDocumentStore(dataFolder),
  reader: makeReader(),
  mode: useAi ? 'ai' : 'practice',
  practiceReason,
  passcode,
  loadCrew: createCrewLoader(here),
  publicFolder: path.join(here, 'public'),
  wordLink,
  openOnMac,
});

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log('DeScribe is running.');
  if (useAi) console.log(`Reading photos with: ${model}${checkModel ? `, second opinion from ${checkModel} when unsure` : ''}`);
  if (practiceReason === 'no-key') console.log('Practice mode: photos become sample text until you add an AI key.');
  if (practiceReason === 'no-passcode') console.log('Practice mode: add APP_PASSCODE to your .env file to switch the AI on.');
  console.log(saveFolder ? `Saving Word files in: ${saveFolder}` : 'Keeping documents inside the app (no SAVE_FOLDER set).');
  if (saveFolder) console.log(wordLink ? 'Open in Word: on (the folder is in OneDrive).' : 'Open in Word: off (the folder is not in a work OneDrive). Download still works.');
  console.log(`On this Mac, open:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) {
        console.log(`On your iPhone (same Wi-Fi), open:  http://${item.address}:${PORT}`);
      }
    }
  }
});
