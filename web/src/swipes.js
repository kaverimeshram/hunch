/* The visitor's swipes, kept per contract in localStorage so a reload resumes the stack. */

const KEY = 'hunch-swipes';

function readAll(storage) {
  try { return JSON.parse(storage?.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

/** kind: 'staked' | 'opinion' | 'skip'. side: 'Yes' | 'No' | null. */
export function recordSwipe(contract, swipe, storage = globalThis.localStorage) {
  const all = readAll(storage);
  all[contract] = { ...all[contract], [swipe.id]: { side: swipe.side ?? null, kind: swipe.kind, amount: swipe.amount ?? null, yocto: swipe.yocto ?? null, tx: swipe.tx ?? null, at: swipe.at ?? Date.now() } };
  storage?.setItem(KEY, JSON.stringify(all));
}

export const swipesFor = (contract, storage = globalThis.localStorage) => readAll(storage)[contract] || {};

export function resetSwipes(contract, storage = globalThis.localStorage) {
  const all = readAll(storage);
  delete all[contract];
  storage?.setItem(KEY, JSON.stringify(all));
}

/** Facts the visitor has not swiped yet, deck order kept. */
export const unseen = (facts, swipes) => facts.filter((fact) => !swipes[fact.id]);
