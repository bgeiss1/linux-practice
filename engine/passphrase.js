// Each finished track earns one word. A student's words depend on their
// CSU ID, the track, and the course salt, so classmates get different words.
// The instructor dashboard uses the same functions to check submissions.
//
// This is a speed bump, not security: the code is public, as agreed.

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

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(text)) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function normalizeId(id) {
  return String(id ?? '').trim().toLowerCase();
}

// Words for every track, in track order, with no word used twice.
export function wordsFor(studentId, trackIds, salt) {
  const id = normalizeId(studentId);
  const used = new Set();
  const out = {};
  for (const track of trackIds) {
    let n = 0;
    let word;
    do {
      word = WORDS[fnv1a(`${salt}|${id}|${track}|${n++}`) % WORDS.length];
    } while (used.has(word));
    used.add(word);
    out[track] = word;
  }
  return out;
}

// The passphrase a student submits: the words of the tracks they finished,
// in track order, joined with hyphens.
export function passphrase(studentId, trackIds, salt, finishedTracks) {
  const words = wordsFor(studentId, trackIds, salt);
  return trackIds.filter((t) => finishedTracks.includes(t)).map((t) => words[t]).join('-');
}

// Which tracks a submitted passphrase proves. Order and case don't matter,
// so a student who types the words with spaces still gets credit.
export function verify(studentId, trackIds, salt, submitted) {
  const words = wordsFor(studentId, trackIds, salt);
  const given = new Set(String(submitted ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const tracks = trackIds.filter((t) => given.has(words[t]));
  const unknown = [...given].filter((w) => !Object.values(words).includes(w));
  return { tracks, unknown };
}
