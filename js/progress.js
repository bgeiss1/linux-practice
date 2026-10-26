// A student's progress as a backup file they can download and load again,
// in another browser or after the browser cleared its storage.

export const PROGRESS_FORMAT = 'linux-practice-progress';

export const emptyProgress = () => ({ done: {}, phrases: {}, lessons: {} });

export function progressFile(progress, saved = new Date()) {
  return JSON.stringify({ format: PROGRESS_FORMAT, version: 1, saved: saved.toISOString(), ...progress }, null, 2) + '\n';
}

// The progress in a backup file. Throws with a message for students when
// the file isn't one.
export function readProgressFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a Linux Practice progress file.");
  }
  if (data?.format !== PROGRESS_FORMAT) throw new Error("That file isn't a Linux Practice progress file.");
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  return { done: obj(data.done), phrases: obj(data.phrases), lessons: obj(data.lessons) };
}

// Adds a backup to the progress in this browser, losing nothing from either:
// the best result of each scenario, every finished lesson, and the
// passphrase already shown here for a track (the file's for the rest).
export function mergeProgress(mine, theirs) {
  const done = { ...mine.done };
  for (const [id, rec] of Object.entries(theirs.done)) {
    if (!done[id] || (rec?.stars ?? 0) > (done[id].stars ?? 0)) done[id] = rec;
  }
  return {
    done,
    lessons: { ...theirs.lessons, ...mine.lessons },
    phrases: { ...theirs.phrases, ...mine.phrases },
  };
}

// Counts for a short summary: scenarios and lessons finished.
export const progressCounts = (p) => ({ scenarios: Object.keys(p.done).length, lessons: Object.keys(p.lessons).length });
