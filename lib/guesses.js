// DeScribe's memory of which words were guesses. The Word file never holds this (it
// stays clean); the app keeps it and shows those words in yellow on the phone.
//
// A line is remembered as its plain text plus where the guesses are in it:
//   "more [[time]] here"  <->  { text: "more time here", marks: [[5, 9]] }

// Splits "[[...]]" markup into plain text and guess positions, tidying spaces the same
// way Word text is tidied (runs of spaces become one, no spaces at either end).
export function toPlainAndMarks(markup) {
  const chars = [];
  String(markup ?? '')
    .split(/\[\[(.*?)\]\]/s)
    .forEach((piece, index) => {
      for (const char of piece.replace(/\[\[|\]\]/g, '')) chars.push({ char, guess: index % 2 === 1 });
    });

  const tidy = [];
  for (const item of chars) {
    const space = /\s/.test(item.char);
    if (space && (tidy.length === 0 || tidy.at(-1).char === ' ')) continue;
    tidy.push({ char: space ? ' ' : item.char, guess: item.guess });
  }
  while (tidy.length && tidy.at(-1).char === ' ') tidy.pop();

  const text = tidy.map((item) => item.char).join('');
  const marks = [];
  tidy.forEach((item, i) => {
    if (!item.guess) return;
    const last = marks.at(-1);
    if (last && last[1] === i) last[1] = i + 1;
    else marks.push([i, i + 1]);
  });
  // A guess never starts or ends with a space ("[[pump motor]]" keeps its inner space).
  for (const mark of marks) {
    while (mark[0] < mark[1] && text[mark[0]] === ' ') mark[0] += 1;
    while (mark[1] > mark[0] && text[mark[1] - 1] === ' ') mark[1] -= 1;
  }
  return { text, marks: marks.filter(([start, end]) => end > start) };
}

// The opposite: plain text plus guess positions back into "[[...]]" markup.
export function applyMarks(text, marks) {
  let result = '';
  let at = 0;
  for (const [start, end] of [...marks].sort((a, b) => a[0] - b[0])) {
    if (start < at || end > text.length || start >= end) continue; // ignore anything that no longer fits
    result += `${text.slice(at, start)}[[${text.slice(start, end)}]]`;
    at = end;
  }
  return result + text.slice(at);
}

const MAX_REMEMBERED = 3000;

// The guesses remembered for one Word file. The same words can appear on several
// lines (two cards both saying "Learn"), so each line is remembered by its words plus
// which copy of them it is, counting from the top of the document: for every set of
// words there is a list with one place per copy, holding that copy's guesses (or null).
export function createGuessMemory(saved = []) {
  const byText = new Map();
  for (const entry of Array.isArray(saved) ? saved : []) {
    if (!entry || typeof entry.text !== 'string') continue;
    if (Array.isArray(entry.slots)) byText.set(entry.text, entry.slots.map((m) => (Array.isArray(m) && m.length ? m : null)));
    else if (Array.isArray(entry.marks) && entry.marks.length) {
      if (!byText.has(entry.text)) byText.set(entry.text, []);
      byText.get(entry.text).push(entry.marks); // older format: one line per entry
    }
  }

  return {
    // For saving: only words that still have a guess somewhere.
    entries() {
      const list = [];
      for (const [text, slots] of byText) if (slots.some(Boolean)) list.push({ text, slots });
      return list.slice(-MAX_REMEMBERED);
    },

    // The copy number "copy" of these words, as markup with its guesses in [[brackets]].
    show(text, copy) {
      const marks = byText.get(text)?.[copy];
      return marks ? applyMarks(text, marks) : text;
    },

    // A line was added (or changed into these words) as copy number "copy".
    insert(markup, copy) {
      const { text, marks } = toPlainAndMarks(markup);
      if (!text) return;
      const slots = byText.get(text) || [];
      while (slots.length < copy) slots.push(null);
      slots.splice(copy, 0, marks.length ? marks : null);
      byText.set(text, slots);
    },

    // Copy number "copy" of these words was removed (or changed into other words).
    remove(text, copy) {
      const slots = byText.get(text);
      if (!slots || copy >= slots.length) return;
      slots.splice(copy, 1);
      if (!slots.some(Boolean)) byText.delete(text);
    },
  };
}

// For each line, which copy of its words it is (0 for the first one in the document).
export function copyNumbers(texts) {
  const seen = new Map();
  return texts.map((text) => {
    const copy = seen.get(text) || 0;
    seen.set(text, copy + 1);
    return copy;
  });
}
