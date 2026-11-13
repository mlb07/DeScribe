# DeScribe

Snap handwritten notes on your iPhone and they're added, typed up, to a Word document.

## Start it

In Terminal, from this folder:

```bash
npm start
```

It shows the address to open in Safari on your iPhone (same Wi-Fi as your Mac).

## Practice mode (free)

Until you add an AI key, everything works but photos turn into sample text.

## Switch on the real reading

1. Get a key at https://console.anthropic.com and add some credit (about 1-2 cents per photo).
2. Make a copy of `.env.example` named `.env`.
3. Paste your key after `ANTHROPIC_API_KEY=` and choose a passcode after `APP_PASSCODE=`.
4. Stop the app (Control-C) and run `npm start` again.

## Trying a different AI model

The app uses Claude Sonnet 5.5, which was the most accurate on the card test. To try another, change the
`AI_MODEL=` line in `.env` to `claude-haiku-5-5` (cheaper) or `claude-opus-5-5` (strongest), then restart the app.
The options are listed in `.env.example`.

Optional second opinion: set `AI_CHECK_MODEL=` to a stronger model and it re-reads any photo where `AI_MODEL`
marked a guess. It's off, because on the card test the cheap model was unsure on every photo, so it saved nothing.

## Saving into OneDrive

Set `SAVE_FOLDER=` in `.env` to a folder inside your OneDrive (for example
`~/Library/CloudStorage/OneDrive-YourCompany/DeScribe`) and restart. Then:

- Every document is a real Word file in that folder, and OneDrive syncs it everywhere.
- Each photo is added to the end of the Word file, so anything you fix in Word is kept.
- The phone's document list shows the Word files in that folder. Drop any Word file in
  there and you can add photos to it too.
- The main screen shows what's really in the file, including your Word edits.
- If the file is open in Word on this Mac, photos wait until you close it (Word would
  otherwise save over them). The phone shows "Waiting" and adds them once it's closed.
- Close the file in Word on your phone or other computers before snapping more photos.
  DeScribe can't see those, and Word could save over the new text.
- Every reading is also saved in `documents/readings-backup`, so nothing is ever lost.

## One bullet per paper

Each separate paper in a photo (a sticky note, a card, a page) becomes bullet points. A paper
of running words is one bullet. A paper that starts with words and then lists things gets the
list as sub-bullets underneath. A paper that is only a list (bullets, dashes or numbers) keeps
every item the writer listed as its own bullet.
Bullets sit together in one tight list in Word, with no blank lines between them.

On the phone, tap a line's bullet dot to remove the bullet, or tap the faint ○ on a plain line
to add one. Each top-level bullet is its own card, with a ✕ to delete it (and its sub-bullets).

## Projects

A project is a folder that holds several files, like DeScribe/Board Retreat/Day 1.docx in
OneDrive. In the ☰ DeScribe menu under "Projects & lists": "+ New project"; each project has QR,
Rename and Delete, and "+ New file here"; each file has Move (into a project, to another one, or
out) and Delete. Deleting a project moves the whole folder to the Archive, and Restore brings it
all back. A file deleted from a project goes back into that project when restored. A project's
QR code opens the project on the phone so each person picks a file; a file's QR code opens that
file. Any number of people can work on the same file at once and all see changes live. Files open
in Word on this Mac can't be moved, and their project can't be renamed or deleted, until closed.

## Lots of photos at once

There is no limit: pick 30, 40 or more from Photos. Each photo is saved on the phone the moment
you pick it, so if the phone locks or the app is closed, the ones still waiting are picked up
again when you reopen DeScribe ("Picking up 29 photos that were still waiting"). A bar shows
"Adding photos: 12 of 40". They always go in once each, in the order picked.

## On a laptop

Open the same address in the laptop's browser (same Wi-Fi). The list shows on the left and a QR
code on the right. Scan it with your phone's camera: DeScribe opens on the phone, already
unlocked, on the same list. Every change on either screen (photos, edits, bullets, deletes)
shows on the other one live. On the laptop you can edit lines the same way, add photos with the
Photos button, or drag photos from Finder or the Photos app onto the page. The Word button
downloads the file. A phone can show the code too: menu → "Connect another phone (QR code)".
QR codes last 10 minutes; a new one appears on its own.

## Deleting lists, and the Archive

Tap "☰ DeScribe" at the top to open the side menu. Under Lists, tap a list to open it, or
Delete to remove it (it asks first). Deleting never destroys anything: the Word file moves to
the DeScribe/Archive folder in OneDrive, so it can still be opened in Word. Under Archive, tap
Restore to put a list back. A list open in Word on this Mac can't be deleted until it's closed.
Same names never overwrite: an archived copy gets the date added, and a restored one becomes
"Name 2" if the name is taken.

## Printed forms with section headings

When a photo is of a printed form divided into sections (for example "INDUSTRY FUTURE STATE",
"OUR STRATEGY"), the handwriting in each section goes under that heading in Word. Every line
written in a section is its own bullet. If the document already has the heading (any capitals,
with or without a colon), new notes go at the end of that section, so a second sheet fills the
same sections; otherwise the heading is added as a plain bold line. Handwriting outside the
sections (a margin, beside the title) goes under the picked line, or at the end. The printed
questions and directions themselves are never typed in.

## Adding a photo in the middle

Tap a line on the main screen (then Done). It stays marked, and a bar says "New photos go
under: …". Photos you snap now go directly under that line, as normal bullets, and each next
photo goes right after the previous one. Tap ✕ on the bar to go back to adding at the end.
If the picked line was changed in Word meanwhile, the photo is added at the end and the app
says so.

## Editing on the phone

Every line on the main screen can be edited, and each change is saved into the Word file a
moment after you stop typing (and straight away when you leave the line or tap Done).

- Unsure words show in yellow in the app only. The Word file never gets any highlighting.
  Tap a yellow word once it's right, or change it, and the yellow goes.
- Return splits a line in two (same list). Backspace at the start of a line joins it to the
  line above. Emptying a line deletes it. Each card has a Delete button (it asks first).
- Edits made in Word show up too. If a line was changed in Word since the phone last showed
  it, the phone's change is not saved; it shows the latest version and what you had typed.
- Lines with pictures or page breaks, and tables, are left for Word: they can't be edited here.
- A line you retype here becomes plain text in Word (bold or colours on that line go);
  bullets and numbering always stay.

## Files you can edit in TextEdit

- `crew-words.txt`: your crew's words and abbreviations, one per line.
- `crew-info.txt`: a sentence or two about your team.

To start, copy `crew-words.example.txt` to `crew-words.txt` and `crew-info.example.txt` to
`crew-info.txt`, then put in your own. Your copies stay on your Mac (they aren't uploaded to
GitHub). Without them the app still works; the AI just has less to go on.

Changes apply to the next photo, with no restart.

## What's where

- `public/`: what you see on the phone.
- `lib/word.js`: makes the Word file.
- `lib/reader.js` and `lib/prompt.js`: read the handwriting.
- `lib/documents.js`: stores your documents in a `documents` folder.
- `lib/app.js`: handles what the phone asks for.
- `test/`: automated checks. Run them with `npm test`.
- `scribe/`: the earlier app, kept only for reference.

## Runs on its own

DeScribe starts by itself when you log in to the Mac, restarts itself if it ever crashes,
and keeps the Mac from falling asleep while it runs (closing the lid still sleeps it).
The setting lives in `~/Library/LaunchAgents/com.yourname.describe.plist`, and what it
prints goes to `logs/describe.log`.

- Restart it (after changing `.env`): `launchctl kickstart -k gui/$(id -u)/com.yourname.describe`
- Turn it off: `launchctl bootout gui/$(id -u)/com.yourname.describe`
- Turn it back on: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yourname.describe.plist`

Phone address that doesn't change: `http://YOUR-MAC-NAME.local:4000 (your Mac's name is in System Settings → General → Sharing)`
