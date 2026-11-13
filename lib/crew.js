// Reads the two plain text files you can edit in TextEdit at any time:
//   crew-words.txt  one word, name or abbreviation per line
//   crew-info.txt   a sentence or two about your team

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_WORDS = 300;

async function readIfThere(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export function createCrewLoader(folder) {
  return async function loadCrew() {
    const [words, info] = await Promise.all([
      readIfThere(path.join(folder, 'crew-words.txt')),
      readIfThere(path.join(folder, 'crew-info.txt')),
    ]);
    return {
      crewInfo: info.trim().slice(0, 2000),
      crewWords: [...new Set(words.split('\n').map((line) => line.trim()).filter(Boolean))].slice(0, MAX_WORDS),
    };
  };
}
