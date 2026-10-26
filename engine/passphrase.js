// Each finished track gives the student a passphrase: the track's keyword
// (the same for every student, set in the dashboard) plus three random words,
// in random order, e.g. "comet-otter-maple-ribbon". The keyword shows the track
// was finished; the random words differ per student, so two students handing in
// the same words means one copied the other. No student ID is involved.
//
// This is a speed bump, not security: the code and keywords are public, as agreed.

const WORD_LIST = `
alanine amide amino anchor angstrom apex arginine aspartate assay atom
backbone barrel basin beacon beta binder biotin blossom bond bridge
buffer bundle cadence calcium canyon capsid carbon cascade catalyst cation
cedar chain chaperone charge chiral cipher citrate clamp cleft clover
cobalt codon cofactor coil comet compass contact copper coral cortex
crest crystal current cysteine cytosol delta density dimer dipole docking
domain dune dynamo eclipse ember enzyme epitope equator ester falcon
feather fiber flagella flare flux fold folium forest fragment galaxy
gamma garnet gene glacier glider glucose glutamine glycine gradient granite
groove harbor helix heme hinge histidine horizon hydrogen indigo insulin
interface ion iris isoleucine jasper kelvin kinase lantern lattice leucine
ligand lumen lysine magnet maple matrix meadow membrane meridian methionine
micelle mineral mirror mitosis molecule monomer motif nebula neon nickel
nitrogen nucleus oasis ocean octave omega orbit oxygen palette peptide
pepsin phase photon pivot plasma pleat pocket polar polymer prism
proline protein proton pulse quartz quasar radius ramp reactor receptor
redwood relay residue resin ribbon ribosome ridge rotor saddle salt
sapphire scaffold sensor sequence serine sheet shell signal silicon solvent
spark spectrum sphere spiral spindle stable strand summit surface switch
tandem tensor terrace tether thermal threonine thylakoid tide titan torsion
trace tracer trimer tryptophan tunnel turn tyrosine valence valine vapor
vector velvet vertex vessel violet vortex wave willow zenith zinc
`
  .trim()
  .split(/\s+/);

export const WORDS = [...new Set(WORD_LIST)];
const WORD_SET = new Set(WORDS);

export const FILLERS = 3;

// Starting keywords, and spares the dashboard suggests when rotating them.
export const SUGGESTED_KEYWORDS = {
  session: 'heron', navigate: 'otter', find: 'badger', read: 'owl', manage: 'beaver', bash: 'lynx',
  slurm: 'walrus', transfer: 'pelican', colabfold: 'octopus', chai: 'panda', mpnn: 'gecko', gromacs: 'narwhal',
};
export const SPARE_KEYWORDS = `
alpaca antelope armadillo bison bobcat buffalo camel caribou cheetah chipmunk cougar coyote crane
dingo dolphin donkey eagle egret ferret flamingo fox gazelle gerbil gibbon giraffe gopher gorilla
hamster hedgehog hippo hyena ibis iguana impala jackal jaguar kangaroo koala lemur leopard llama
lobster magpie manatee marmot meerkat mink mongoose moose mule newt ocelot opossum ostrich panther
parrot penguin platypus porcupine puffin puma quail rabbit raccoon raven reindeer rhino salmon
seal sloth squirrel stork swan tapir tiger toad toucan turkey turtle vulture weasel whale wolf
wombat yak zebra
`.trim().split(/\s+/);

export const words = (text) => String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);

// What's wrong with a keyword, or '' if it's fine. others: the other tracks' keywords.
export function keywordProblem(keyword, others = []) {
  if (!/^[a-z]{3,20}$/.test(keyword)) return 'Use one word, 3 to 20 lowercase letters.';
  if (WORD_SET.has(keyword)) return `"${keyword}" is also one of the random words, so it can't mark a track.`;
  if (others.includes(keyword)) return `"${keyword}" is already another track's keyword.`;
  return '';
}

// A new passphrase for a finished track. random() returns a float in [0, 1).
export function makePassphrase(keyword, random = cryptoRandom) {
  const picked = new Set();
  while (picked.size < FILLERS) picked.add(WORDS[Math.floor(random() * WORDS.length)]);
  const all = [keyword, ...picked];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.join('-');
}

function cryptoRandom() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

// Splits what a student pasted into passphrases and says which track each one
// proves. keywords: { trackId: keyword }. Students may paste several
// passphrases into one answer, separated by spaces, commas or new lines; a
// passphrase whose words were typed with spaces is split at its keywords.
// Returns [{ track, keyword, fillers, odd }], where odd lists words that aren't
// from the site's word list (typos or made-up words).
export function readSubmission(text, keywords) {
  const byWord = Object.fromEntries(Object.entries(keywords).map(([t, k]) => [k.toLowerCase(), t]));
  const chunks = String(text ?? '').toLowerCase().split(/[^a-z-]+/).filter((c) => /[a-z]/.test(c));
  // Hyphenated chunks are whole passphrases; loose words are regrouped below.
  const groups = [];
  let loose = [];
  for (const c of chunks) {
    if (c.includes('-')) groups.push(words(c));
    else loose.push(c);
  }
  // Loose words: start a new group whenever a group already holds a keyword
  // and FILLERS other words, or a second keyword shows up.
  let cur = [];
  for (const w of loose) {
    const kws = cur.filter((x) => byWord[x]).length;
    if ((byWord[w] && kws) || (kws && cur.length > FILLERS)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  const out = [];
  for (const g of groups) {
    const kws = g.filter((w) => byWord[w]);
    if (!kws.length) {
      out.push({ track: null, keyword: null, fillers: g, odd: g.filter((w) => !WORD_SET.has(w)) });
      continue;
    }
    for (const k of new Set(kws)) {
      const fillers = kws.length === 1 ? g.filter((w) => w !== k) : [];
      out.push({ track: byWord[k], keyword: k, fillers, odd: fillers.filter((w) => !WORD_SET.has(w)) });
    }
  }
  return out;
}

// The random words of a passphrase as one comparable string.
export const fillerKey = (fillers) => [...fillers].sort().join('-');
