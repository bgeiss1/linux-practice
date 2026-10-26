// gmx (GROMACS 2024.4, from `module load gromacs`), following the classic
// lysozyme-in-water tutorial: pdb2gmx, editconf, solvate, grompp, genion,
// mdrun, energy. The files carry what later steps need the same way real ones
// do: a .gro file's second line is its atom count, and topol.top lists every
// molecule under [ molecules ]. Binary outputs (.tpr, .edr, .cpt, .trr, .xtc)
// remember the system they describe.

import { joinPath, basename, dirname } from '../vfs.js';
import { ONE } from '../library.js';
import { pick, readDashArgs, write, useResources, hasGpu } from './common.js';
import { chainsOf } from './mpnn.js';

const VERSION = '2024.4';
const PREFIX = `/opt/modules/gromacs/${VERSION}`;

const FORCE_FIELDS = [
  ['amber03', 'AMBER03 protein, nucleic AMBER94 (Duan et al., J. Comp. Chem. 24, 1999-2012, 2003)'],
  ['amber94', 'AMBER94 force field (Cornell et al., JACS 117, 5179-5197, 1995)'],
  ['amber96', 'AMBER96 protein, nucleic AMBER94 (Kollman et al., Acc. Chem. Res. 29, 461-469, 1996)'],
  ['amber99', 'AMBER99 protein, nucleic AMBER94 (Wang et al., J. Comp. Chem. 21, 1049-1074, 2000)'],
  ['amber99sb', 'AMBER99SB protein, nucleic AMBER94 (Hornak et al., Proteins 65, 712-725, 2006)'],
  ['amber99sb-ildn', 'AMBER99SB-ILDN protein, nucleic AMBER94 (Lindorff-Larsen et al., Proteins 78, 1950-58, 2010)'],
  ['amberGS', 'AMBERGS force field (Garcia & Sanbonmatsu, PNAS 99, 2782-2787, 2002)'],
  ['charmm27', 'CHARMM27 all-atom force field (CHARM22 plus CMAP for proteins)'],
  ['gromos43a1', 'GROMOS96 43a1 force field'],
  ['gromos43a2', 'GROMOS96 43a2 force field (improved alkane dihedrals)'],
  ['gromos45a3', 'GROMOS96 45a3 force field (Schuler JCC 2001 22 1205)'],
  ['gromos53a5', 'GROMOS96 53a5 force field (Oostenbrink et al. JCC 2004 25 1656)'],
  ['gromos53a6', 'GROMOS96 53a6 force field (Oostenbrink et al. JCC 2004 25 1656)'],
  ['gromos54a7', 'GROMOS96 54a7 force field (Eur. Biophys. J. (2011), 40,, 843-856, DOI: 10.1007/s00249-011-0700-9)'],
  ['oplsaa', 'OPLS-AA/L all-atom force field (2001 aminoacid dihedrals)'],
];
const WATERS = [['tip3p', 'TIP3P     TIP 3-point, recommended'], ['tip4p', 'TIP4P     TIP 4-point'], ['tip4pew', 'TIP4P-Ew  TIP 4-point optimized with Ewald'], ['tip5p', 'TIP5P     TIP 5-point'], ['spc', 'SPC       simple point charge'], ['spce', 'SPC/E     extended simple point charge'], ['none', 'None']];
const WATER_ATOMS = { tip3p: 3, spc: 3, spce: 3, tip4p: 4, tip4pew: 4, tip5p: 5 };

// Atoms per residue with hydrogens, close to what pdb2gmx builds.
const RES_ATOMS = { A: 10, R: 24, N: 14, D: 12, C: 10, Q: 17, E: 15, G: 7, H: 17, I: 19, L: 19, K: 22, M: 17, F: 20, P: 14, S: 11, T: 14, W: 24, Y: 21, V: 16, X: 10 };
const CHARGE = { K: 1, R: 1, D: -1, E: -1 };
const THREE_OF = Object.fromEntries(Object.entries(ONE).map(([three, one]) => [one, three]));

const QUOTES = [
  ['Everything\'s formed from particles', 'Van der Graaf Generator'],
  ['It Doesn\'t Seem Right, No Computers in Sight', 'Faun Fables'],
  ['A computer would deserve to be called intelligent if it could deceive a human into believing that it was human.', 'Alan Turing'],
  ['Science is a way of thinking much more than it is a body of knowledge.', 'Carl Sagan'],
  ['If at first you don\'t succeed, try two more times so that your failure is statistically significant.', 'Dallas Warren'],
];

// ---------- the system, as read from the files ----------

// Protein atoms and charge, as pdb2gmx would build them.
export function proteinFromSeq(seq) {
  let atoms = 2;
  let charge = 0;
  for (const aa of seq) {
    atoms += RES_ATOMS[aa] ?? 10;
    charge += CHARGE[aa] ?? 0;
  }
  return { atoms, charge };
}

// The box size editconf makes: the protein's diameter plus twice -d.
export function proteinDiameter(atoms) {
  return Number((0.4 * Math.cbrt(atoms)).toFixed(3));
}

export function solventFor(volume, proteinAtoms) {
  return Math.round((volume - proteinAtoms * 0.0106) * 33.4);
}

function parseGro(text) {
  const lines = text.split('\n').filter((l, i, a) => i < a.length - 1 || l.trim());
  const count = Number(lines[1]?.trim());
  const box = (lines.at(-1) ?? '').trim().split(/\s+/).map(Number);
  if (!Number.isInteger(count) || box.length < 3 || box.some(Number.isNaN)) return null;
  return { title: lines[0], count, box: box.slice(0, 3) };
}

function groText(title, count, box, { sol = 0, ions = [] } = {}) {
  const atom = (res, rname, aname, n, x, y, z) => `${String(res).padStart(5)}${rname.padEnd(5)}${aname.padStart(5)}${String(n % 100000).padStart(5)}${[x, y, z].map((v) => v.toFixed(3).padStart(8)).join('')}`;
  const lines = [atom(1, 'LYS', 'N', 1, 3.536, 2.234, 1.981), atom(1, 'LYS', 'H1', 2, 3.612, 2.296, 1.958), atom(1, 'LYS', 'H2', 3, 3.497, 2.257, 2.071)];
  if (sol) lines.push(atom(130, 'SOL', 'OW', count - sol * 3 - ions.length + 1, 0.569, 1.275, 1.165), atom(130, 'SOL', 'HW1', count - sol * 3 - ions.length + 2, 0.476, 1.268, 1.128));
  for (const [i, ion] of ions.entries()) lines.push(atom(9000 + i, ion, ion, count - ions.length + i + 1, 2.1 + i * 0.4, 4.4, 3.1));
  return `${title}\n${String(count).padStart(5)}\n${lines.join('\n')}\n${box.map((b) => b.toFixed(5).padStart(10)).join('')}\n`;
}

// Molecules listed in a topology, and how many atoms each has.
function readTopology(ctx, abs) {
  const text = ctx.sh.vfs.get(abs)?.content ?? '';
  const files = [text];
  for (const m of text.matchAll(/^#include\s+"([^"/]+\.itp)"/gm)) {
    const inc = ctx.sh.vfs.get(joinPath(dirname(abs), m[1]));
    if (inc?.type === 'file') files.push(inc.content);
  }
  const sizes = { SOL: 3, NA: 1, CL: 1, K: 1 };
  const charges = { SOL: 0, NA: 1, CL: -1, K: 1 };
  const water = text.match(/\.ff\/(\w+)\.itp"/g)?.map((s) => s.match(/\/(\w+)\.itp/)[1]).find((w) => WATER_ATOMS[w]);
  if (water) sizes.SOL = WATER_ATOMS[water];
  for (const body of files) {
    for (const block of body.split(/\[\s*moleculetype\s*\]/).slice(1)) {
      const name = block.split('\n').find((l) => l.trim() && !l.trim().startsWith(';'))?.trim().split(/\s+/)[0];
      const atoms = block.split(/\[\s*bonds\s*\]/)[0].split(/\[\s*atoms\s*\]/)[1] ?? '';
      const rows = atoms.split('\n').filter((l) => /^\s*\d+\s/.test(l));
      if (!name || !rows.length) continue;
      sizes[name] = Math.max(...rows.map((l) => Number(l.trim().split(/\s+/)[0])));
      const q = [...atoms.matchAll(/qtot\s+(-?[\d.]+)/g)].at(-1);
      charges[name] = q ? Number(q[1]) : 0;
    }
  }
  const molecules = [];
  const section = text.split(/\[\s*molecules\s*\]/)[1] ?? '';
  for (const line of section.split('\n')) {
    const t = line.replace(/;.*/, '').trim();
    if (!t) continue;
    const [name, n] = t.split(/\s+/);
    molecules.push({ name, count: Number(n) });
  }
  const total = molecules.reduce((s, m) => s + (sizes[m.name] ?? 0) * m.count, 0);
  const charge = molecules.reduce((s, m) => s + (charges[m.name] ?? 0) * m.count, 0);
  const unknown = molecules.find((m) => sizes[m.name] === undefined);
  return { text, molecules, total, charge, unknown, sizes };
}

function topologyText({ source, ff, water, atoms, charge, chain = 'A', seq, molecules }) {
  return `;
;	File 'topol.top' was generated
;	By user: student (5012)
;	On host: geiss-01
;	At date: Sat Oct 24 15:00:00 2026
;
;	This is a standalone topology file
;
;	Created by:
;	          :-) GROMACS - gmx pdb2gmx, ${VERSION} (-:
;
;	Command line:
;	  gmx pdb2gmx -f ${source} -water ${water} -ff ${ff}
;	Force field was read from the standard GROMACS share directory.
;

; Include forcefield parameters
#include "${ff}.ff/forcefield.itp"

[ moleculetype ]
; Name            nrexcl
Protein_chain_${chain}     3

[ atoms ]
;   nr       type  resnr residue  atom   cgnr     charge       mass  typeB    chargeB      massB
; residue   1 LYS rtp NLYS q +2.0
     1         N3      1    LYS      N      1     0.0966      14.01
     2          H      1    LYS     H1      2     0.2165      1.008
     3          H      1    LYS     H2      3     0.2165      1.008   ; qtot 0.5296
; (practice copy: atoms 4 to ${atoms - 1} are left out of this listing)
  ${String(atoms).padStart(4)}         O2    ${String(seq.length).padStart(3)}    ${THREE_OF[seq.at(-1)] ?? 'GLY'}    OC2   ${atoms}    -0.8188         16   ; qtot ${charge}

[ bonds ]
;  ai    aj funct            c0            c1            c2            c3
    1     2     1

; Include Position restraint file
#ifdef POSRES
#include "posre.itp"
#endif

; Include water topology
#include "${ff}.ff/${water}.itp"

#ifdef POSRES_WATER
; Position restraint for each water oxygen
[ position_restraints ]
;  i funct       fcx        fcy        fcz
   1    1       1000       1000       1000
#endif

; Include topology for ions
#include "${ff}.ff/ions.itp"

[ system ]
; Name
${source.replace(/\.pdb$/, '').toUpperCase()}

[ molecules ]
; Compound        #mols
${molecules}`;
}

// GROMACS prints numbers like -5.8603181e+05: always two exponent digits.
const sci = (x, digits = 7) => x.toExponential(digits).replace(/e([+-])(\d)$/, 'e$10$2');

const moleculeLine = (name, n) => `${name.padEnd(18)}${n}\n`;

// The energies steepest descent reaches for a system. Scenarios use this to
// know ahead of time what `gmx energy` will print.
export function emEnergies({ proteinAtoms, sol, ions = 0 }) {
  const final = -Math.round(sol * 50.2 + proteinAtoms * 13.1 + ions * 410 + pick(`em${sol}`, 0, 900, 0));
  const average = Math.round(final * 0.957);
  const steps = 300 + (hashSteps(sol) % 600);
  return { final, average, steps };
}
const hashSteps = (n) => Math.round(pick(`steps${n}`, 0, 600, 0));

// ---------- output helpers ----------

function header(ctx, sub) {
  ctx.out(`                  :-) GROMACS - gmx ${sub}, ${VERSION} (-:\n\nExecutable:   ${PREFIX}/bin/gmx\nData prefix:  ${PREFIX}\nWorking dir:  ${ctx.sh.cwd}\nCommand line:\n  gmx ${ctx.args.join(' ')}\n\n`, 'dim');
}

function goodbye(ctx) {
  const [q, who] = QUOTES[ctx.sh.cluster.step % QUOTES.length];
  ctx.out(`\nGROMACS reminds you: "${q}" (${who})\n\n`, 'dim');
}

function fatal(ctx, message, source = 'src/gromacs/fileio/futil.cpp, line 754') {
  ctx.err(`\n-------------------------------------------------------\nProgram:     gmx ${ctx.sub}, version ${VERSION}\nSource file: ${source}\n\n${message}\n\nFor more information and tips for troubleshooting, please check the GROMACS\nwebsite at https://manual.gromacs.org/current/user-guide/run-time-errors.html\n-------------------------------------------------------\n`);
  return 1;
}

function missingFile(ctx, path) {
  ctx.coach('gmx-file', `There's no \`${path}\` here. \`ls\` shows the files you have; check the name after each option.`);
  return fatal(ctx, `File input/output error:\nFile '${path}' does not exist or is not accessible.\nThe file could not be opened.\n  Reason: No such file or directory\n  (call to fopen() returned error code 2)`);
}

// GROMACS never overwrites: it renames the old file to #name.1# first.
function backUp(ctx, abs) {
  const { vfs } = ctx.sh;
  const node = vfs.get(abs);
  if (!node) return;
  let n = 1;
  while (vfs.get(joinPath(dirname(abs), `#${basename(abs)}.${n}#`))) n++;
  const backup = joinPath(dirname(abs), `#${basename(abs)}.${n}#`);
  vfs.put(backup, node);
  vfs.remove(abs);
  ctx.out(`\nBack Off! I just backed up ${basename(abs)} to ./${basename(backup)}\n`);
}

function out(ctx, path, content, options) {
  const abs = ctx.sh.resolve(path);
  backUp(ctx, abs);
  return write(ctx, abs, content, options);
}

// An input file by option; GROMACS uses a default name when one isn't given.
function input(ctx, opts, key, fallback) {
  const path = opts[key] ?? fallback;
  const abs = ctx.sh.resolve(path);
  const node = ctx.sh.vfs.get(abs);
  if (!node || node.type !== 'file') {
    missingFile(ctx, path);
    return null;
  }
  return { path, abs, node };
}

// Interactive menus: GROMACS reads the answer from the keyboard. Here the
// answer has to come in on a pipe, like `echo SOL | gmx genion ...`.
function answers(ctx) {
  return ctx.stdin === null ? null : ctx.stdin.split(/\s+/).filter(Boolean);
}

function noAnswer(ctx, example) {
  const how = example.includes('|') ? 'Pipe the answer in instead' : 'Give the answer as an option instead';
  ctx.out(`\n(practice site: this terminal can't type answers into a running program. ${how}: ${example})\n`, 'dim');
  ctx.coach('gmx-pipe', `GROMACS is asking a question. ${how}, for example \`${example}\`.`);
  return 1;
}

// ---------- subcommands ----------

function pdb2gmx(ctx, args) {
  const { opts } = readDashArgs(args, ['f', 'o', 'p', 'i', 'water', 'ff', 'n', 'q']);
  const src = input(ctx, opts, 'f', 'protein.pdb');
  if (!src) return 1;
  const pdbText = src.node.content;
  const strange = pdbText.split('\n').find((l) => l.startsWith('HETATM') && !/HOH|WAT/.test(l.slice(17, 20)));
  const chains = chainsOf(pdbText);
  const unknownRes = pdbText.split('\n').find((l) => l.startsWith('ATOM') && !ONE[l.slice(17, 20)]);
  let ff = opts.ff;
  let water = opts.water;
  const given = answers(ctx);
  if (!ff || ff === 'select') {
    ctx.out(`\nSelect the Force Field:\n\nFrom '${PREFIX}/share/gromacs/top':\n\n${FORCE_FIELDS.map(([, d], i) => `${String(i + 1).padStart(2)}: ${d}`).join('\n')}\n`);
    const choice = given?.shift();
    if (!choice) return noAnswer(ctx, `gmx pdb2gmx -f ${src.path} -o ${opts.o ?? 'conf.gro'} -water ${water && water !== 'select' ? water : 'spce'} -ff amber99sb-ildn`);
    ff = FORCE_FIELDS[Number(choice) - 1]?.[0];
    if (!ff) return fatal(ctx, `Invalid force field selection: ${choice}`);
  }
  const ffName = FORCE_FIELDS.find(([n]) => n === ff);
  if (!ffName) return fatal(ctx, `Could not find force field '${ff}' in current directory, install tree or GMXLIB path.`, 'src/gromacs/gmxpreprocess/fflibutil.cpp, line 81');
  if (!water || water === 'select') {
    ctx.out(`\nSelect the Water Model:\n${WATERS.map(([, d], i) => `${String(i + 1).padStart(2)}: ${d}`).join('\n')}\n`);
    const choice = given?.shift();
    if (!choice) return noAnswer(ctx, `gmx pdb2gmx -f ${src.path} -o ${opts.o ?? 'conf.gro'} -water spce -ff ${ff}`);
    water = WATERS[Number(choice) - 1]?.[0];
    if (!water) return fatal(ctx, `Invalid water model selection: ${choice}`);
  }
  if (!WATER_ATOMS[water] && water !== 'none') return fatal(ctx, `Invalid enum '${water}' for option -water`, 'src/gromacs/commandline/cmdlineparser.cpp');
  header(ctx, 'pdb2gmx');
  if (!Object.keys(chains).length) return fatal(ctx, `No atoms found in pdb file ${src.path}`, 'src/gromacs/gmxpreprocess/pdb2gmx.cpp, line 2034');
  const bad = strange ?? unknownRes;
  if (bad) {
    ctx.coach('gmx-residue', `${src.path} has a molecule that isn't protein or water (${bad.slice(17, 20).trim()}). The force field can't describe it, so take those lines out: \`grep -v ${bad.slice(17, 20).trim()} ${src.path} > clean.pdb\`.`);
    return fatal(ctx, `Residue '${bad.slice(17, 20).trim()}' not found in residue topology database`, 'src/gromacs/gmxpreprocess/resall.cpp, line 645');
  }
  if (Object.keys(chains).length > 1) return fatal(ctx, 'The practice copy of pdb2gmx handles one protein chain at a time.');
  const seq = Object.values(chains)[0];
  const { atoms, charge } = proteinFromSeq(seq);
  const crystalWaters = pdbText.split('\n').filter((l) => l.startsWith('HETATM') && /HOH|WAT/.test(l.slice(17, 20))).length;
  ctx.out(`Using the ${ffName[0][0].toUpperCase() + ffName[0].slice(1)} force field in directory ${ff}.ff\n\nReading ${src.path}...\nRead '${(pdbText.match(/^TITLE\s+(.*)$/m)?.[1] ?? '').trim()}', ${pdbText.split('\n').filter((l) => /^(ATOM|HETATM)/.test(l)).length} atoms\n\nAnalyzing pdb file\nSplitting chemical chains based on TER records or chain id changing.\nThere are 1 chains and 0 blocks of water and ${seq.length} residues with ${pdbText.split('\n').filter((l) => l.startsWith('ATOM')).length} atoms\n\n  chain  #res #atoms\n  1 '${Object.keys(chains)[0]}'   ${seq.length}    ${pdbText.split('\n').filter((l) => l.startsWith('ATOM')).length}\n\nTotal mass ${(seq.length * 110.4).toFixed(3)} a.m.u.\nTotal charge ${charge.toFixed(3)} e\nNow there are ${atoms} atoms\n`);
  const gro = opts.o ?? 'conf.gro';
  const top = opts.p ?? 'topol.top';
  const box = [proteinDiameter(atoms), proteinDiameter(atoms) * 0.98, proteinDiameter(atoms) * 1.01].map((v) => Number(v.toFixed(5)));
  const molecules = moleculeLine(`Protein_chain_${Object.keys(chains)[0]}`, 1) + (crystalWaters ? moleculeLine('SOL', crystalWaters) : '');
  out(ctx, gro, groText(`${(pdbText.match(/^TITLE\s+(.*)$/m)?.[1] ?? 'Protein').trim()}`, atoms + crystalWaters * (WATER_ATOMS[water] ?? 3), box, { sol: crystalWaters }));
  out(ctx, top, topologyText({ source: basename(src.path), ff, water, atoms, charge, chain: Object.keys(chains)[0], seq, molecules }));
  out(ctx, opts.i ?? 'posre.itp', `; In this topology include file, you will find position restraint\n; entries for all the heavy atoms in your original pdb file.\n; This means that all the protons which were added by pdb2gmx are\n; not restrained.\n\n[ position_restraints ]\n; atom  type      fx      fy      fz\n     1     1  1000  1000  1000\n     5     1  1000  1000  1000\n`);
  ctx.out(`\n\t\t--------- PLEASE NOTE ------------\nYou have successfully generated a topology from: ${src.path}.\nThe ${ffName[0][0].toUpperCase() + ffName[0].slice(1)} force field and the ${water} water model are used.\n\t\t--------- ETON ESAELP ------------\n`);
  goodbye(ctx);
  return 0;
}

function editconf(ctx, args) {
  const { opts } = readDashArgs(args, ['f', 'o', 'd', 'bt', 'box']);
  const src = input(ctx, opts, 'f', 'conf.gro');
  if (!src) return 1;
  header(ctx, 'editconf');
  const gro = parseGro(src.node.content);
  if (!gro) return fatal(ctx, `Invalid line in ${src.path} for atom 1:\nIs this a .gro file?`, 'src/gromacs/fileio/groio.cpp, line 158');
  const proteinAtoms = gro.count;
  const diameter = proteinDiameter(proteinAtoms);
  const bt = opts.bt ?? 'triclinic';
  if (!['cubic', 'triclinic', 'dodecahedron', 'octahedron'].includes(bt)) return fatal(ctx, `Invalid enum '${bt}' for option -bt`, 'src/gromacs/commandline/cmdlineparser.cpp');
  let box = gro.box;
  if (opts.d !== undefined) {
    const edge = Number((diameter + 2 * Number(opts.d)).toFixed(5));
    box = [edge, edge, edge];
  } else if (opts.box !== undefined) {
    box = [Number(opts.box), Number(opts.box), Number(opts.box)];
  }
  const shape = { cubic: 1, triclinic: 1, dodecahedron: 0.7071, octahedron: 0.7698 }[bt];
  const volume = box[0] * box[1] * box[2] * shape;
  ctx.out(`Read ${gro.count} atoms\nVolume: ${(gro.box[0] * gro.box[1] * gro.box[2]).toFixed(4)} nm^3, corresponds to roughly ${Math.round(gro.box[0] * gro.box[1] * gro.box[2] * 33.4 / 3)} electrons\nNo velocities found\n    system size :  ${diameter.toFixed(3)}  ${(diameter * 0.98).toFixed(3)}  ${(diameter * 1.01).toFixed(3)} (nm)\n    diameter    :  ${diameter.toFixed(3)}               (nm)\n${opts.c ? `    center      :  ${(diameter / 2).toFixed(3)}  ${(diameter / 2).toFixed(3)}  ${(diameter / 2).toFixed(3)} (nm)\n` : ''}    box vectors :  ${gro.box.map((b) => b.toFixed(3)).join('  ')} (nm)\n    box angles  :  90.00  90.00  90.00 (degrees)\n    box volume  :  ${(gro.box[0] * gro.box[1] * gro.box[2]).toFixed(2)}               (nm^3)\n${opts.c ? `    shift       :  ${(box[0] / 2 - diameter / 2).toFixed(3)}  ${(box[1] / 2 - diameter / 2).toFixed(3)}  ${(box[2] / 2 - diameter / 2).toFixed(3)} (nm)\nnew center      :  ${(box[0] / 2).toFixed(3)}  ${(box[1] / 2).toFixed(3)}  ${(box[2] / 2).toFixed(3)} (nm)\n` : ''}new box vectors :  ${box.map((b) => b.toFixed(3)).join('  ')} (nm)\nnew box angles  :  90.00  90.00  90.00 (degrees)\nnew box volume  :  ${volume.toFixed(2)}               (nm^3)\n`);
  if (!opts.c && opts.d !== undefined) ctx.coach('gmx-center', 'Without `-c` the protein stays where it was, so it may poke out of the new box. Add `-c` to center it.');
  out(ctx, opts.o ?? 'out.gro', groText(gro.title, gro.count, box), { meta: { bt, centered: !!opts.c } });
  goodbye(ctx);
  return 0;
}

function solvate(ctx, args) {
  const { opts } = readDashArgs(args, ['cp', 'cs', 'o', 'p', 'box']);
  if (!opts.cp) {
    ctx.coach('gmx-solvate', 'Give solvate your boxed protein with `-cp`, like `gmx solvate -cp newbox.gro -cs spc216.gro -o solv.gro -p topol.top`.');
    return fatal(ctx, 'Option -cp (the solute) is required here.\nWithout it, solvate would fill an empty box with water only.', 'src/gromacs/gmxpreprocess/solvate.cpp, line 956');
  }
  const src = input(ctx, opts, 'cp', 'protein.gro');
  if (!src) return 1;
  const cs = opts.cs ?? 'spc216.gro';
  if (!['spc216.gro', 'tip4p.gro', 'tip5p.gro'].includes(basename(cs)) && !ctx.sh.vfs.get(ctx.sh.resolve(cs))) return missingFile(ctx, cs);
  header(ctx, 'solvate');
  const gro = parseGro(src.node.content);
  if (!gro) return fatal(ctx, `Invalid line in ${src.path} for atom 1:\nIs this a .gro file?`, 'src/gromacs/fileio/groio.cpp, line 158');
  const volume = gro.box[0] * gro.box[1] * gro.box[2] * (src.node.meta?.bt === 'dodecahedron' ? 0.7071 : 1);
  const sol = solventFor(volume, gro.count);
  const ss = Math.round(sol * 0.034);
  const su = Math.round(gro.count * 0.62);
  if (sol <= 0) return fatal(ctx, 'The solute box is too small to add any solvent. Make a bigger box with gmx editconf -d 1.0 first.', 'src/gromacs/gmxpreprocess/solvate.cpp, line 707');
  ctx.out(`Reading solute configuration\nReading solvent configuration\nInitialising inter-atomic distances...\nGenerating solvent configuration\nWill generate new solvent configuration of ${Math.ceil(gro.box[0] / 1.86)}x${Math.ceil(gro.box[1] / 1.86)}x${Math.ceil(gro.box[2] / 1.86)} boxes\nSolvent box contains ${(sol + ss + su) * 3} atoms in ${sol + ss + su} residues\nRemoved ${ss * 3} solvent atoms due to solvent-solvent overlap\nRemoved ${su * 3} solvent atoms due to solute-solvent overlap\nSorting configuration\nFound 1 molecule type:\n    SOL (   3 atoms): ${sol} residues\nGenerated solvent containing ${sol * 3} atoms in ${sol} residues\nWriting generated configuration to ${opts.o ?? 'out.gro'}\n\nOutput configuration contains ${gro.count + sol * 3} atoms in ${sol + 130} residues\nVolume                 :     ${volume.toFixed(2)} (nm^3)\nDensity                :     ${(1000 + pick(String(sol), -20, 10, 3)).toFixed(3)} (g/l)\nNumber of solvent molecules:  ${sol}   \n\n`);
  out(ctx, opts.o ?? 'out.gro', groText('Generated by gmx solvate', gro.count + sol * 3, gro.box, { sol }));
  if (opts.p) {
    const topAbs = ctx.sh.resolve(opts.p);
    const topNode = ctx.sh.vfs.get(topAbs);
    if (!topNode) return missingFile(ctx, opts.p);
    const text = topNode.content.replace(/\n*$/, '\n') + moleculeLine('SOL', sol);
    ctx.out(`Processing topology\nAdding line for ${sol} solvent molecules with resname (SOL) to topology file (${opts.p})\n`);
    out(ctx, opts.p, text);
  } else {
    ctx.coach('gmx-solvate-p', `Without \`-p topol.top\`, solvate added ${sol} waters to the coordinates but didn't write them into the topology. grompp will complain that the two don't match.`);
  }
  goodbye(ctx);
  return 0;
}

function readMdp(text) {
  const mdp = {};
  for (const line of text.split('\n')) {
    const m = line.replace(/;.*/, '').match(/^\s*([\w-]+)\s*=\s*(.*?)\s*$/);
    if (m) mdp[m[1].replace(/_/g, '-').toLowerCase()] = m[2];
  }
  return mdp;
}

function grompp(ctx, args) {
  const { opts } = readDashArgs(args, ['f', 'c', 'p', 'o', 'r', 'maxwarn', 'po']);
  const mdpFile = input(ctx, opts, 'f', 'grompp.mdp');
  if (!mdpFile) return 1;
  const conf = input(ctx, opts, 'c', 'conf.gro');
  if (!conf) return 1;
  const topFile = input(ctx, opts, 'p', 'topol.top');
  if (!topFile) return 1;
  header(ctx, 'grompp');
  const mdp = readMdp(mdpFile.node.content);
  const gro = parseGro(conf.node.content);
  if (!gro) return fatal(ctx, `Invalid line in ${conf.path} for atom 1:\nIs this a .gro file?`, 'src/gromacs/fileio/groio.cpp, line 158');
  const top = readTopology(ctx, topFile.abs);
  if (top.unknown) return fatal(ctx, `No such moleculetype ${top.unknown.name}`, 'src/gromacs/gmxpreprocess/topio.cpp, line 742');
  ctx.out(`${mdp.title !== undefined ? "Ignoring obsolete mdp entry 'title'\n" : ''}Setting the LD random seed to ${Math.round(pick(conf.path, 1e8, 2e9, 0))}\n\nGenerated 2145 of the 2145 non-bonded parameter combinations\n\nExcluding 3 bonded neighbours molecule type 'Protein_chain_A'\n`);
  if (gro.count !== top.total) {
    ctx.coach('gmx-mismatch', top.total < gro.count
      ? `The coordinates have ${gro.count - top.total} more atoms than topol.top lists. Usually the waters from solvate never made it into the topology: run solvate again with \`-p topol.top\`, or add the SOL line under [ molecules ] yourself.`
      : `topol.top lists ${top.total - gro.count} more atoms than the coordinate file has. Check the counts under [ molecules ] at the end of topol.top.`);
    return fatal(ctx, `number of coordinates in coordinate file (${conf.path}, ${gro.count})\n             does not match topology (${topFile.path}, ${top.total})`, 'src/gromacs/gmxpreprocess/grompp.cpp, line 769');
  }
  const warnings = [];
  const notes = [];
  if (Math.abs(top.charge) > 0.01) {
    notes.push(`System has non-zero total charge: ${top.charge.toFixed(6)}\nTotal charge should normally be an integer. See\nhttps://manual.gromacs.org/current/user-guide/floating-point.html\nfor discussion on how close it should be to an integer.`);
    if (/pme|ewald/i.test(mdp.coulombtype ?? 'cut-off')) warnings.push(`You are using Ewald electrostatics in a system with net charge. This can lead to\nsevere artifacts, such as ions moving into regions with low dielectric, due\nto the uniform background charge. We suggest to neutralize your system with\ncounter ions, possibly in combination with a physiological salt concentration.`);
  }
  notes.forEach((n, i) => ctx.out(`\nNOTE ${i + 1} [file ${topFile.path}, line ${top.text.split('\n').length}]:\n  ${n.replace(/\n/g, '\n  ')}\n\n`));
  warnings.forEach((w, i) => ctx.out(`\nWARNING ${i + 1} [file ${mdpFile.path}]:\n  ${w.replace(/\n/g, '\n  ')}\n\n`));
  const maxwarn = Number(opts.maxwarn ?? 0);
  if (warnings.length > maxwarn) {
    ctx.coach('gmx-charge', 'grompp stopped because the system has a net charge. Add ions with `gmx genion ... -neutral` first. Using -maxwarn to skip a warning hides real problems.');
    return fatal(ctx, `Too many warnings (${warnings.length}).\nIf you are sure all warnings are harmless, use the -maxwarn option to override.`, 'src/gromacs/gmxpreprocess/grompp.cpp, line 2425');
  }
  const integrator = mdp.integrator ?? 'md';
  const nsteps = Number(mdp.nsteps ?? 0);
  const dt = Number(mdp.dt ?? 0.001);
  const sol = top.molecules.filter((m) => m.name === 'SOL').reduce((s, m) => s + m.count, 0);
  const ions = top.molecules.filter((m) => ['NA', 'CL', 'K'].includes(m.name)).reduce((s, m) => s + m.count, 0);
  const proteinAtoms = top.molecules.filter((m) => m.name.startsWith('Protein')).reduce((s, m) => s + top.sizes[m.name] * m.count, 0);
  ctx.out(`Analysing residue names:\nThere are:   ${Math.round(proteinAtoms / 15.2)}    Protein residues\n${sol ? `There are: ${sol}      Water residues\n` : ''}${ions ? `There are:     ${ions}        Ion residues\n` : ''}Analysing Protein...\nNumber of degrees of freedom in T-Coupling group rest is ${(gro.count * 3 - 3).toFixed(2)}\n${integrator === 'md' ? `Estimate for the relative computational load of the PME mesh part: 0.22\n` : ''}\nThis run will generate roughly ${Math.max(1, Math.round(integrator === 'md' ? (gro.count * nsteps) / 1.25e7 : gro.count / 4000))} Mb of data\n`);
  if (notes.length) ctx.out(`\nThere ${notes.length === 1 ? 'was' : 'were'} ${notes.length} NOTE${notes.length === 1 ? '' : 's'}\n`);
  if (warnings.length) ctx.out(`\nThere ${warnings.length === 1 ? 'was' : 'were'} ${warnings.length} WARNING${warnings.length === 1 ? '' : 's'}\n`);
  out(ctx, opts.o ?? 'topol.tpr', null, {
    binary: 'GROMACS run input (.tpr). `gmx dump -s FILE` prints it as text; `gmx mdrun -deffnm NAME` runs it.',
    size: gro.count * 120 + 40000,
    meta: { atoms: gro.count, proteinAtoms, sol, ions, charge: top.charge, integrator, nsteps, dt, emtol: Number(mdp.emtol ?? 10), top: topFile.abs, gro: conf.abs },
  });
  goodbye(ctx);
  return 0;
}

function genion(ctx, args) {
  const { opts } = readDashArgs(args, ['s', 'o', 'p', 'pname', 'nname', 'conc', 'np', 'nn']);
  const tpr = input(ctx, opts, 's', 'topol.tpr');
  if (!tpr) return 1;
  const meta = tpr.node.meta;
  if (!meta) return fatal(ctx, `${tpr.path} is not a run input file made by gmx grompp.`, 'src/gromacs/fileio/tpxio.cpp, line 2785');
  header(ctx, 'genion');
  const groups = [['System', meta.atoms], ['Protein', meta.proteinAtoms], ['Protein-H', Math.round(meta.proteinAtoms * 0.51)], ['C-alpha', Math.round(meta.proteinAtoms / 15.2)], ['Backbone', Math.round(meta.proteinAtoms / 5.07)], ['MainChain', Math.round(meta.proteinAtoms / 3.8)], ['MainChain+Cb', Math.round(meta.proteinAtoms / 3.2)], ['MainChain+H', Math.round(meta.proteinAtoms / 3.04)], ['SideChain', Math.round(meta.proteinAtoms * 0.67)], ['SideChain-H', Math.round(meta.proteinAtoms * 0.25)], ['Prot-Masses', meta.proteinAtoms], ['non-Protein', meta.atoms - meta.proteinAtoms], ['Water', meta.sol * 3], ['SOL', meta.sol * 3], ['non-Water', meta.atoms - meta.sol * 3]];
  ctx.out(`Reading file ${tpr.path}, VERSION ${VERSION} (single precision)\n${opts.neutral ? `Will try to add ${Math.max(0, -Math.round(meta.charge))} ${opts.pname ?? 'NA'} ions and ${Math.max(0, Math.round(meta.charge))} ${opts.nname ?? 'CL'} ions.\n` : ''}Select a continuous group of solvent molecules\n${groups.map(([g, n], i) => `Group ${String(i).padStart(5)} (${g.padStart(15)}) has ${String(n).padStart(6)} elements`).join('\n')}\nSelect a group: `);
  const choice = answers(ctx)?.[0];
  if (!choice) return noAnswer(ctx, `echo SOL | gmx genion -s ${tpr.path} -o ${opts.o ?? 'out.gro'} -p ${opts.p ?? 'topol.top'} -pname NA -nname CL -neutral`);
  const idx = /^\d+$/.test(choice) ? Number(choice) : groups.findIndex(([g]) => g.toLowerCase() === choice.toLowerCase());
  ctx.out(`${choice}\nSelected ${idx}: '${groups[idx]?.[0] ?? choice}'\n`);
  if (!groups[idx]) return fatal(ctx, `Invalid group selection: ${choice}`, 'src/gromacs/topology/index.cpp, line 911');
  if (!['Water', 'SOL'].includes(groups[idx][0])) {
    ctx.coach('gmx-genion', 'genion swaps water molecules for ions, so pick the SOL group: `echo SOL | gmx genion ...`.');
    return fatal(ctx, `Your solvent group size (${groups[idx][1]}) is not a multiple of 3`, 'src/gromacs/gmxpreprocess/genion.cpp, line 450');
  }
  if (!opts.p) ctx.coach('gmx-genion-p', 'Without `-p topol.top`, the ions go in the coordinates but not the topology, and grompp will find the two don\'t match.');
  const volume = meta.atoms * 0.0103;
  const salt = opts.conc ? Math.round(Number(opts.conc) * 0.6022 * volume) : 0;
  const q = Math.round(meta.charge);
  const pos = Number(opts.np ?? 0) + salt + (opts.neutral && q < 0 ? -q : 0);
  const neg = Number(opts.nn ?? 0) + salt + (opts.neutral && q > 0 ? q : 0);
  const added = pos + neg;
  if (!added) {
    ctx.out('No ions to add, will just copy input configuration.\n');
  } else {
    ctx.out(`Number of (3-atomic) solvent molecules: ${meta.sol}\n\nProcessing topology\nReplacing ${added} solute molecules in topology file (${opts.p ?? 'topol.top'})  by ${pos} ${opts.pname ?? 'NA'} and ${neg} ${opts.nname ?? 'CL'} ions.\n`);
  }
  if (opts.p && added) {
    const topAbs = ctx.sh.resolve(opts.p);
    const node = ctx.sh.vfs.get(topAbs);
    if (!node) return missingFile(ctx, opts.p);
    // The ions replace waters from the last SOL line in [ molecules ].
    const solLines = [...node.content.matchAll(/^SOL(\s+)(\d+)\s*$/gm)];
    const last = solLines.at(-1);
    let text = node.content;
    if (last) text = text.slice(0, last.index) + `SOL${last[1]}${Number(last[2]) - added}` + text.slice(last.index + last[0].trimEnd().length);
    text = text.replace(/\n*$/, '\n') + (pos ? moleculeLine(opts.pname ?? 'NA', pos) : '') + (neg ? moleculeLine(opts.nname ?? 'CL', neg) : '');
    out(ctx, opts.p, text);
  }
  out(ctx, opts.o ?? 'out.gro', groText('Protein in water', meta.atoms - added * 3 + added, [Math.cbrt(volume), Math.cbrt(volume), Math.cbrt(volume)].map((v) => Number(v.toFixed(5))), { sol: meta.sol - added, ions: [...Array(pos).fill(opts.pname ?? 'NA'), ...Array(neg).fill(opts.nname ?? 'CL')] }));
  goodbye(ctx);
  return 0;
}

// Simulated nanoseconds per day for a system: much faster on a GPU.
export function nsPerDay(atoms, { gpu, cpus = 1 }) {
  const scale = 33000 / atoms;
  return Number((gpu ? 410 * scale : 2.2 * Math.min(cpus, 64) * scale).toFixed(3));
}

function mdrun(ctx, args) {
  const { opts } = readDashArgs(args, ['s', 'deffnm', 'cpi', 'nb', 'pme', 'bonded', 'update', 'ntomp', 'nt', 'gpu_id', 'o', 'x', 'c', 'e', 'g', 'cpo', 'maxh']);
  const name = opts.deffnm;
  const tpr = input(ctx, opts, 's', name ? `${name}.tpr` : 'topol.tpr');
  if (!tpr) return 1;
  const meta = tpr.node.meta;
  if (!meta) return fatal(ctx, `${tpr.path} is not a run input file made by gmx grompp.`, 'src/gromacs/fileio/tpxio.cpp, line 2785');
  header(ctx, 'mdrun');
  const gpu = hasGpu(ctx);
  const wantsGpu = ['nb', 'pme', 'bonded', 'update'].some((k) => opts[k] === 'gpu');
  if (wantsGpu && !gpu) {
    ctx.coach('gmx-gpu', ctx.sh.cluster.interactive?.batch ? 'The job script asks mdrun to use a GPU (`-nb gpu`) but never asks Slurm for one. Add `#SBATCH --gres=gpu:1`.' : 'mdrun was told to use a GPU, but you don\'t have one. Run it inside `srun --gres=gpu:1 ...` or a batch job with `--gres=gpu:1`.');
    return fatal(ctx, 'Inconsistency in user input:\nCannot run short-ranged nonbonded interactions on a GPU because no GPU is\ndetected.', 'src/gromacs/taskassignment/decidegpuusage.cpp, line 471');
  }
  const base = name ?? 'md';
  const file = (ext, key) => opts[key] ?? (name ? `${name}.${ext}` : { log: 'md.log', edr: 'ener.edr', gro: 'confout.gro', trr: 'traj.trr', xtc: 'traj_comp.xtc', cpt: 'state.cpt' }[ext]);
  const cpus = ctx.sh.cluster.interactive?.cpus ?? 1;
  ctx.out(`Reading file ${tpr.path}, VERSION ${VERSION} (single precision)\n`);
  if (gpu) ctx.out(`1 GPU selected for this run.\nMapping of GPU IDs to the 2 GPU tasks in the 1 rank on this node:\n  PP:0,PME:0\nPP tasks will do (non-perturbed) short-ranged interactions on the GPU\nPME tasks will do all aspects on the GPU\n`);
  ctx.out(`Using 1 MPI thread\nUsing ${cpus} OpenMP thread${cpus === 1 ? '' : 's'}\n\n`);

  if (meta.integrator === 'steep') {
    const e = emEnergies(meta);
    const minutes = Math.max(0.5, meta.atoms / 40000 * (gpu ? 0.5 : 4));
    if (!useResources(ctx, { memGB: 1 + meta.atoms / 30000, minutes })) return 137;
    ctx.out(`Steepest Descents:\n   Tolerance (Fmax)   =  ${sci(meta.emtol, 5)}\n   Number of steps    =        ${meta.nsteps}\nStep=    0, Dmax= 1.0e-02 nm, Epot= ${sci(e.final * 0.71, 5)} Fmax= 6.27e+04, atom= ${Math.round(meta.proteinAtoms / 3)}\n...\n\nwriting lowest energy coordinates.\n\nSteepest Descents converged to Fmax < ${meta.emtol} in ${e.steps} steps\nPotential Energy  = ${sci(e.final)}\nMaximum force     =  ${sci(pick(base + meta.atoms, meta.emtol * 0.6, meta.emtol * 0.99, 2))} on atom ${Math.round(pick(base, 1, meta.proteinAtoms, 0))}\nNorm of force     =  ${sci(pick(base + 'n', 15, 40, 2))}\n`);
    for (const [ext, key] of [['log', 'g'], ['edr', 'e'], ['trr', 'o'], ['gro', 'c']]) {
      if (ext === 'log') out(ctx, file(ext, key), `Log file opened on Sat Oct 24 15:00:00 2026\nGROMACS version:    ${VERSION}\nSteepest Descents converged to Fmax < ${meta.emtol} in ${e.steps} steps\nPotential Energy  = ${sci(e.final)}\n`);
      else if (ext === 'gro') out(ctx, file(ext, key), groText('Protein in water', meta.atoms, [7.1, 7.1, 7.1]));
      else out(ctx, file(ext, key), null, { binary: ext === 'edr' ? 'GROMACS energy file (.edr). Read it with `gmx energy -f FILE`.' : 'GROMACS trajectory. Look at it in a viewer such as VMD, or analyse it with gmx tools.', size: meta.atoms * (ext === 'trr' ? 40 : 2) + 1000, meta: { kind: 'em', ...meta, energies: e } });
    }
    goodbye(ctx);
    return 0;
  }

  // Molecular dynamics: how far the run gets depends on its speed and the time it has.
  const totalSteps = meta.nsteps;
  let startStep = 0;
  if (opts.cpi) {
    const cpt = ctx.sh.vfs.get(ctx.sh.resolve(opts.cpi));
    if (cpt?.meta?.step !== undefined) {
      startStep = cpt.meta.step;
      ctx.out(`Reading checkpoint file ${opts.cpi} generated: Sat Oct 24 16:12:40 2026\n\nResuming from step ${startStep}, time ${(startStep * meta.dt).toFixed(0)} ps\n\n`);
    } else {
      ctx.out(`\nNOTE: The checkpoint file ${opts.cpi} was not found, starting from the beginning.\n\n`);
    }
  }
  const speed = nsPerDay(meta.atoms, { gpu, cpus });
  const nsLeft = ((totalSteps - startStep) * meta.dt) / 1000;
  const minutes = (nsLeft / speed) * 1440;
  const appending = startStep > 0;
  const logText = (upTo) => `Log file opened on Sat Oct 24 15:00:00 2026\nGROMACS version:    ${VERSION}\n${gpu ? 'GPU support:        CUDA\n1 GPU selected for this run.\n' : 'Running on CPU only\n'}Started mdrun on rank 0 Sat Oct 24 15:00:00 2026\n           Step           Time\n${String(upTo).padStart(15)}${(upTo * meta.dt).toFixed(5).padStart(15)}\n`;
  const writeTraj = (upTo) => {
    const meta2 = { kind: 'md', ...meta, step: upTo };
    if (appending) {
      for (const [ext, key] of [['log', 'g'], ['edr', 'e'], ['xtc', 'x']]) {
        const n = ctx.sh.vfs.get(ctx.sh.resolve(file(ext, key)));
        if (n) {
          if (ext === 'log') n.content += `\nRestarted from checkpoint at step ${startStep}\n${String(upTo).padStart(15)}${(upTo * meta.dt).toFixed(5).padStart(15)}\n`;
          else n.meta = meta2;
          n.mtime = ctx.sh.cluster.clock();
          continue;
        }
        if (ext === 'log') write(ctx, ctx.sh.resolve(file(ext, key)), logText(upTo));
        else write(ctx, ctx.sh.resolve(file(ext, key)), null, { binary: ext === 'edr' ? 'GROMACS energy file (.edr). Read it with `gmx energy -f FILE`.' : 'GROMACS trajectory. Look at it in a viewer such as VMD, or analyse it with gmx tools.', size: meta.atoms * 2 + 1000, meta: meta2 });
      }
    } else {
      out(ctx, file('log', 'g'), logText(upTo));
      out(ctx, file('edr', 'e'), null, { binary: 'GROMACS energy file (.edr). Read it with `gmx energy -f FILE`.', size: 4000 + upTo / 50, meta: meta2 });
      out(ctx, file('xtc', 'x'), null, { binary: 'GROMACS trajectory. Look at it in a viewer such as VMD, or analyse it with gmx tools.', size: meta.atoms * 2 + upTo, meta: meta2 });
    }
    const cptAbs = ctx.sh.resolve(file('cpt', 'cpo'));
    write(ctx, cptAbs, null, { binary: 'GROMACS checkpoint. Continue a stopped run with `gmx mdrun -deffnm NAME -cpi NAME.cpt`.', size: meta.atoms * 30, meta: meta2 });
  };
  ctx.out(`starting mdrun 'Protein in water'\n${totalSteps} steps, ${(totalSteps * meta.dt).toFixed(1)} ps${appending ? ` (continuing from ${(startStep * meta.dt).toFixed(1)} ps)` : ''}.\n`);
  const ok = useResources(ctx, {
    memGB: 1 + meta.atoms / 20000,
    minutes,
    // mdrun writes a checkpoint every 15 minutes, so a stopped run can continue.
    onTimeout: (fraction) => writeTraj(startStep + Math.floor(((totalSteps - startStep) * fraction * 0.95) / 5000) * 5000),
  });
  if (!ok) return 137;
  ctx.out(`\nWriting final coordinates.\n\n               Core t (s)   Wall t (s)        (%)\n       Time:  ${(minutes * 60 * cpus).toFixed(3).padStart(11)}  ${(minutes * 60).toFixed(3).padStart(11)}  ${(cpus * 100).toFixed(1).padStart(9)}\n                 (ns/day)    (hour/ns)\nPerformance:  ${speed.toFixed(3).padStart(11)}  ${(24 / speed).toFixed(3).padStart(11)}\n`);
  writeTraj(totalSteps);
  out(ctx, file('gro', 'c'), groText('Protein in water', meta.atoms, [7.1, 7.1, 7.1]));
  goodbye(ctx);
  return 0;
}

const EM_TERMS = ['Bond', 'Angle', 'Proper-Dih.', 'Per.-Imp.-Dih.', 'LJ-14', 'Coulomb-14', 'LJ-(SR)', 'Disper.-corr.', 'Coulomb-(SR)', 'Coul.-recip.', 'Potential', 'Pres.-DC', 'Pressure', 'Constr.-rmsd'];
const MD_TERMS = [...EM_TERMS.slice(0, 11), 'Kinetic-En.', 'Total-Energy', 'Conserved-En.', 'Temperature', 'Pres.-DC', 'Pressure', 'Constr.-rmsd', 'Box-X', 'Box-Y', 'Box-Z', 'Volume', 'Density', 'pV', 'Enthalpy'];

function energy(ctx, args) {
  const { opts } = readDashArgs(args, ['f', 'o', 's', 'b', 'e']);
  const edr = input(ctx, opts, 'f', 'ener.edr');
  if (!edr) return 1;
  const meta = edr.node.meta;
  if (!meta || !edr.node.binary?.includes('.edr')) return fatal(ctx, `${edr.path} is not an energy file (.edr).`, 'src/gromacs/fileio/enxio.cpp, line 621');
  header(ctx, 'energy');
  const terms = meta.kind === 'em' ? EM_TERMS : MD_TERMS;
  const cols = [];
  for (let i = 0; i < terms.length; i += 4) cols.push(terms.slice(i, i + 4).map((t, j) => `${String(i + j + 1).padStart(3)}  ${t.padEnd(15)}`).join(''));
  ctx.out(`Opened ${edr.path} as single precision energy file\n\nSelect the terms you want from the following list by\nselecting either (part of) the name or the number or a combination.\nEnd your selection with an empty line or a zero.\n-------------------------------------------------------------------\n${cols.join('\n')}\n\n`);
  const picks = answers(ctx);
  if (!picks?.length) return noAnswer(ctx, `echo Potential | gmx energy -f ${edr.path} -o ${opts.o ?? 'energy.xvg'}`);
  const chosen = [];
  for (const p of picks) {
    if (p === '0') break;
    const t = /^\d+$/.test(p) ? terms[Number(p) - 1] : terms.find((x) => x.toLowerCase().startsWith(p.toLowerCase()));
    if (!t) return fatal(ctx, `Invalid energy term selection: ${p}`, 'src/gromacs/gmxana/gmx_energy.cpp, line 412');
    chosen.push(t);
  }
  if (!chosen.length) return noAnswer(ctx, `echo Potential | gmx energy -f ${edr.path}`);
  const e = meta.energies ?? emEnergies(meta);
  const value = (t) => {
    if (t === 'Potential') return meta.kind === 'em' ? e.average : Math.round(e.final * 0.86);
    if (t === 'Temperature') return 300.1;
    if (t === 'Pressure') return Number(pick(`p${meta.atoms}`, -3, 4, 2));
    if (t === 'Density') return Number(pick(`d${meta.atoms}`, 1010, 1025, 2));
    return Math.round(pick(t + meta.atoms, -60000, 20000, 0));
  };
  const units = { Temperature: '(K)', Pressure: '(bar)', Density: '(kg/m^3)' };
  ctx.out(`\nLast energy frame read ${meta.kind === 'em' ? e.steps : meta.step} time ${meta.kind === 'em' ? e.steps.toFixed(3) : (meta.step * meta.dt).toFixed(3)}\n\nStatistics over ${meta.kind === 'em' ? e.steps + 1 : meta.step / 5000 + 1} steps using ${meta.kind === 'em' ? e.steps + 1 : meta.step / 5000 + 1} frames\n\nEnergy                      Average   Err.Est.       RMSD  Tot-Drift\n-------------------------------------------------------------------------------\n${chosen.map((t) => `${t.padEnd(22)}${String(value(t)).padStart(13)}${String(Math.round(Math.abs(value(t)) * 0.017) || 0.2).padStart(11)}${(Math.abs(value(t)) * 0.0072).toFixed(2).padStart(11)}${(value(t) * -0.031).toFixed(1).padStart(11)}  ${units[t] ?? '(kJ/mol)'}`).join('\n')}\n`);
  const xvg = opts.o ?? 'energy.xvg';
  const rows = Array.from({ length: 8 }, (_, i) => `${(i * (meta.kind === 'em' ? e.steps / 7 : (meta.step * meta.dt) / 7)).toFixed(6).padStart(12)}  ${chosen.map((t) => (value(t) * (meta.kind === 'em' ? 0.71 + i * 0.041 : 1 + (i % 2 ? 0.001 : -0.001))).toFixed(4).padStart(14)).join('  ')}`);
  out(ctx, xvg, `# This file was created Sat Oct 24 15:00:00 2026\n# Created by:\n#                  :-) GROMACS - gmx energy, ${VERSION} (-:\n# Command line:\n#   gmx energy ${ctx.args.join(' ')}\n# gmx energy is part of G R O M A C S:\n#\n@    title "GROMACS Energies"\n@    xaxis  label "${meta.kind === 'em' ? 'Step' : 'Time (ps)'}"\n@    yaxis  label "(kJ/mol)"\n@TYPE xy\n${chosen.map((t, i) => `@ s${i} legend "${t}"`).join('\n')}\n${rows.join('\n')}\n`);
  goodbye(ctx);
  return 0;
}

function version(ctx) {
  header(ctx, '--version');
  ctx.out(`GROMACS version:     ${VERSION}\nPrecision:           mixed\nMemory model:        64 bit\nMPI library:         thread_mpi\nOpenMP support:      enabled (GMX_OPENMP_MAX_THREADS = 128)\nGPU support:         CUDA\nNB cluster size:     8\nSIMD instructions:   AVX2_256\nCPU FFT library:     fftw-3.3.10-sse2-avx-avx2-avx2_128\nGPU FFT library:     cuFFT\nCUDA compiler:       /opt/modules/cuda/12.8/bin/nvcc nvcc: NVIDIA (R) Cuda compiler driver;Cuda compilation tools, release 12.8\nCUDA driver:         12.80\nCUDA runtime:        12.80\n`);
  return 0;
}

const SUBCOMMANDS = { pdb2gmx, editconf, solvate, grompp, genion, mdrun, energy };

export function gmx(ctx) {
  const [sub, ...args] = ctx.args;
  if (sub === '--version' || sub === '-version') return version(ctx);
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    header(ctx, '');
    ctx.out(`SYNOPSIS\n\ngmx [-[no]h] [-[no]quiet] [-[no]version] [-[no]copyright] [-nice <int>]\n    [-[no]backup]\n\nUsing 'gmx help commands' lists the available commands, and\n'gmx help COMMAND' or 'gmx COMMAND -h' shows help for one.\n\nThe practice copy knows: ${Object.keys(SUBCOMMANDS).join(', ')}\n`);
    return 0;
  }
  const fn = SUBCOMMANDS[sub];
  if (!fn) {
    ctx.err(`Error: '${sub}' is not a GROMACS command.\n`);
    if (['rms', 'trjconv', 'make_ndx', 'gyrate', 'rmsf', 'dump'].includes(sub)) ctx.out(`(practice site: gmx ${sub} is real, but the exercises here don't use it.)\n`, 'dim');
    return 1;
  }
  if (args.includes('-h')) {
    header(ctx, sub);
    ctx.out(`(practice site: see the GROMACS manual for every option of gmx ${sub}: https://manual.gromacs.org/current/onlinehelp/gmx-${sub}.html)\n`, 'dim');
    return 0;
  }
  return fn({ ...ctx, sub }, args);
}
