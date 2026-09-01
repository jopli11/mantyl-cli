// TODO: persistence — notes are lost on restart. Deferred before handover.
// (SEEDED QUIRK: incomplete work that Mantyl must list.)
const notes: string[] = [];

export function listNotes(): readonly string[] {
  return notes;
}

export function addNote(note: string): void {
  notes.push(note);
}
