// ProteinMPNN: a GitHub repo cloned into /opt/ProteinMPNN, run with the python
// of the proteinmpnn conda environment. It runs on a CPU too, just slower.
//   python /opt/ProteinMPNN/protein_mpnn_run.py --pdb_path X.pdb --out_folder out/
//   python /opt/ProteinMPNN/helper_scripts/parse_multiple_chains.py --input_path=pdbs/ --output_path=parsed.jsonl
//   python /opt/ProteinMPNN/helper_scripts/assign_fixed_chains.py --input_path=parsed.jsonl --output_path=chains.jsonl --chain_list "A"
//   python /opt/ProteinMPNN/helper_scripts/make_fixed_positions_dict.py --input_path=parsed.jsonl --output_path=fixed.jsonl --chain_list "A" --position_list "1 2 3"

import { joinPath, basename } from '../vfs.js';
import { ONE } from '../library.js';
import { stem, hash, pick, readArgs, needInput, readText, write, useResources } from './common.js';

const ROOT = '/opt/ProteinMPNN';
export const MPNN_SCRIPTS = [
  `${ROOT}/protein_mpnn_run.py`,
  `${ROOT}/helper_scripts/parse_multiple_chains.py`,
  `${ROOT}/helper_scripts/assign_fixed_chains.py`,
  `${ROOT}/helper_scripts/make_fixed_positions_dict.py`,
];

// Chains and their sequences from a PDB file's CA atoms: { A: 'MKV...', B: '...' }
export function chainsOf(pdbText) {
  const chains = {};
  for (const line of pdbText.split('\n')) {
    if (!line.startsWith('ATOM') || line.slice(12, 16).trim() !== 'CA') continue;
    const id = line[21];
    chains[id] = (chains[id] ?? '') + (ONE[line.slice(17, 20)] ?? 'X');
  }
  return chains;
}

const ALPHABET = 'AEELLKKRIAEDLVKGSTNQ';

// The designs ProteinMPNN writes for one structure at one temperature.
// Scenarios use this to know the best-scoring sample ahead of time.
export function designSamples({ name, chains, designed, fixedPositions = {}, temp, n, seed }) {
  const samples = [];
  const base = pick(name + designed.join(''), 0.78, 1.12, 4);
  for (let k = 1; k <= n; k++) {
    let same = 0;
    let total = 0;
    const parts = designed.map((id) => {
      const native = chains[id];
      const fixed = new Set(fixedPositions[id] ?? []);
      return [...native].map((aa, i) => {
        total++;
        if (fixed.has(i + 1)) { same++; return aa; }
        const consensus = ALPHABET[hash(`${name}${id}${i}`) % ALPHABET.length];
        const wander = (hash(`${seed}:${temp}:${k}:${id}:${i}`) % 1000) / 1000 < Math.min(0.6, Number(temp) * 1.5);
        const out = wander ? ALPHABET[hash(`w${seed}:${temp}:${k}:${id}:${i}`) % ALPHABET.length] : consensus;
        if (out === aa) same++;
        return out;
      }).join('');
    });
    const score = Number((base + Number(temp) * 0.55 + pick(`${name}:${seed}:${temp}:${k}`, 0, 0.18, 4)).toFixed(4));
    samples.push({ sample: k, temp, score, global: Number((score + 0.0213).toFixed(4)), recovery: Number((same / total).toFixed(4)), seq: parts.join('/') });
  }
  return samples;
}

function readJsonl(ctx, path) {
  const abs = needInput(ctx, path, path);
  if (!abs) return null;
  try {
    return readText(ctx, abs).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    ctx.err(`json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0) in ${path}\n`);
    return null;
  }
}

function mpnnRun(ctx, args) {
  const { opts } = readArgs(args);
  if (!opts.out_folder || opts.out_folder === true) {
    ctx.err(`Traceback (most recent call last):\n  File "${ROOT}/protein_mpnn_run.py", line 469, in <module>\n    main(args)\n  File "${ROOT}/protein_mpnn_run.py", line 54, in main\n    folder_for_outputs = args.out_folder\nTypeError: expected str, bytes or os.PathLike object, not NoneType\n`);
    ctx.coach('mpnn-out', 'Tell ProteinMPNN where to write with `--out_folder outputs/`.');
    return 1;
  }
  // Each structure: { name, chains: {A: seq}, designed: [...], fixed: [...] }
  let targets;
  if (opts.jsonl_path) {
    const parsed = readJsonl(ctx, opts.jsonl_path);
    if (!parsed) return 1;
    const chainSpec = opts.chain_id_jsonl ? readJsonl(ctx, opts.chain_id_jsonl)?.[0] : null;
    const fixedSpec = opts.fixed_positions_jsonl ? readJsonl(ctx, opts.fixed_positions_jsonl)?.[0] : null;
    if ((opts.chain_id_jsonl && !chainSpec) || (opts.fixed_positions_jsonl && !fixedSpec)) return 1;
    targets = parsed.map((p) => {
      const chains = Object.fromEntries(Object.keys(p).filter((k) => k.startsWith('seq_chain_')).map((k) => [k.slice(10), p[k]]));
      const designed = chainSpec?.[p.name]?.[0] ?? Object.keys(chains);
      return { name: p.name, chains, designed, fixed: Object.keys(chains).filter((c) => !designed.includes(c)), fixedPositions: fixedSpec?.[p.name] ?? {} };
    });
  } else {
    const pdb = needInput(ctx, opts.pdb_path, '--pdb_path');
    if (!pdb) return 1;
    const chains = chainsOf(readText(ctx, pdb));
    if (!Object.keys(chains).length) {
      ctx.err(`Traceback (most recent call last):\n  File "${ROOT}/protein_mpnn_utils.py", line 189, in parse_PDB\nKeyError: 'No protein residues (ATOM ... CA lines) found in ${opts.pdb_path}'\n`);
      return 1;
    }
    let designed = Object.keys(chains);
    if (opts.pdb_path_chains && opts.pdb_path_chains !== true) {
      designed = String(opts.pdb_path_chains).split(/[\s,]+/).filter(Boolean);
      const missing = designed.find((c) => !chains[c]);
      if (missing) {
        ctx.err(`Traceback (most recent call last):\n  File "${ROOT}/protein_mpnn_utils.py", line 237, in parse_PDB\nKeyError: 'seq_chain_${missing}'\n`);
        ctx.coach('mpnn-chain', `${basename(opts.pdb_path)} has chain${Object.keys(chains).length > 1 ? 's' : ''} ${Object.keys(chains).join(', ')}. \`grep ^ATOM ${opts.pdb_path} | cut -c22 | uniq\` lists them.`);
        return 1;
      }
    }
    targets = [{ name: stem(pdb), chains, designed, fixed: Object.keys(chains).filter((c) => !designed.includes(c)), fixedPositions: {} }];
  }
  const n = Number(opts.num_seq_per_target ?? 1);
  const temps = String(opts.sampling_temp ?? '0.1').split(/\s+/).filter(Boolean);
  const seed = Number(opts.seed ?? 0) || (hash(ctx.sh.cluster.step + ctx.args.join()) % 99999);
  const residues = targets.reduce((s, t) => s + Object.values(t.chains).join('').length, 0);
  const minutes = Math.max(1, (residues / 100) * n * temps.length * 0.05);
  if (!useResources(ctx, { memGB: 2.5, minutes })) return 137;
  const edges = 48;
  ctx.out(`Number of edges: ${edges}\nTraining noise level: 0.2A\n`);
  for (const t of targets) {
    const nativeSeq = t.designed.map((c) => t.chains[c]).join('/');
    let text = `>${t.name}, score=${pick(t.name, 1.4, 1.9, 4)}, global_score=${pick(t.name + 'g', 1.4, 1.9, 4)}, fixed_chains=${JSON.stringify(t.fixed).replace(/"/g, "'").replace(/,/g, ', ')}, designed_chains=${JSON.stringify(t.designed).replace(/"/g, "'").replace(/,/g, ', ')}, model_name=v_48_020, git_hash=8907e6671bfbfc92303b5f79c4b5e6ce47cdef57, seed=${seed}\n${nativeSeq}\n`;
    for (const temp of temps) {
      for (const s of designSamples({ name: t.name, chains: t.chains, designed: t.designed, fixedPositions: t.fixedPositions, temp, n, seed })) {
        text += `>T=${temp}, sample=${s.sample}, score=${s.score.toFixed(4)}, global_score=${s.global.toFixed(4)}, seq_recovery=${s.recovery.toFixed(4)}\n${s.seq}\n`;
      }
    }
    write(ctx, ctx.sh.resolve(joinPath(String(opts.out_folder), 'seqs', `${t.name}.fa`)), text);
    ctx.out(`Generating sequences for: ${t.name}\n${n * temps.length} sequences of length ${t.designed.reduce((s, c) => s + t.chains[c].length, 0)} generated in ${(0.6 + residues * n * 0.004).toFixed(4)} seconds\n`);
  }
  return 0;
}

function parseMultipleChains(ctx, args) {
  const { opts } = readArgs(args);
  const dir = needInput(ctx, opts.input_path, '--input_path');
  if (!dir) return 1;
  if (!opts.output_path || opts.output_path === true) { ctx.err('TypeError: expected str, bytes or os.PathLike object, not NoneType\n'); return 1; }
  const node = ctx.sh.vfs.get(dir);
  if (node.type !== 'dir') {
    ctx.err(`NotADirectoryError: [Errno 20] Not a directory: '${opts.input_path}'\n`);
    ctx.coach('mpnn-parse', '`--input_path` is a folder of PDB files, not one file.');
    return 1;
  }
  const lines = [];
  for (const name of Object.keys(node.children).sort().filter((x) => x.endsWith('.pdb'))) {
    const chains = chainsOf(readText(ctx, joinPath(dir, name)));
    const entry = {};
    for (const [id, seq] of Object.entries(chains)) {
      entry[`seq_chain_${id}`] = seq;
      entry[`coords_chain_${id}`] = { [`N_chain_${id}`]: [[1.404, -0.767, -0.6]], [`CA_chain_${id}`]: [[2.3, 0.0, 0.0]], [`C_chain_${id}`]: [[1.531, 0.739, 0.6]], [`O_chain_${id}`]: [[1.071, 0.902, 1.4]] };
    }
    Object.assign(entry, { name: stem(name), num_of_chains: Object.keys(chains).length, seq: Object.values(chains).join('') });
    lines.push(JSON.stringify(entry));
  }
  write(ctx, ctx.sh.resolve(String(opts.output_path)), lines.join('\n') + (lines.length ? '\n' : ''));
  return 0;
}

function assignFixedChains(ctx, args) {
  const { opts } = readArgs(args);
  const parsed = readJsonl(ctx, opts.input_path);
  if (!parsed) return 1;
  const designed = String(opts.chain_list ?? '').split(/[\s,]+/).filter(Boolean);
  const out = {};
  for (const p of parsed) {
    const all = Object.keys(p).filter((k) => k.startsWith('seq_chain_')).map((k) => k.slice(10));
    out[p.name] = [designed.filter((c) => all.includes(c)), all.filter((c) => !designed.includes(c))];
  }
  write(ctx, ctx.sh.resolve(String(opts.output_path)), JSON.stringify(out) + '\n');
  return 0;
}

function makeFixedPositions(ctx, args) {
  const { opts } = readArgs(args);
  const parsed = readJsonl(ctx, opts.input_path);
  if (!parsed) return 1;
  const chainList = String(opts.chain_list ?? '').split(/\s+/).filter(Boolean);
  const positions = String(opts.position_list ?? '').split(',').map((g) => g.trim().split(/\s+/).filter(Boolean).map(Number));
  const out = {};
  for (const p of parsed) {
    const all = Object.keys(p).filter((k) => k.startsWith('seq_chain_')).map((k) => k.slice(10));
    out[p.name] = Object.fromEntries(all.map((c) => [c, chainList.includes(c) ? positions[chainList.indexOf(c)] ?? [] : []]));
  }
  write(ctx, ctx.sh.resolve(String(opts.output_path)), JSON.stringify(out) + '\n');
  return 0;
}

export const MPNN_RUNNERS = {
  'protein_mpnn_run.py': mpnnRun,
  'parse_multiple_chains.py': parseMultipleChains,
  'assign_fixed_chains.py': assignFixedChains,
  'make_fixed_positions_dict.py': makeFixedPositions,
};
