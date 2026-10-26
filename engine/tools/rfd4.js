// RFD4-Proteina (IPD and NVIDIA, from `conda activate rfd4`).
//   rfd4-generate inputs=binder.yaml out_dir=./runs/first [num_replicates=2]
//                 [inference_experiment=quickstart] ['~metrics']
// The YAML file holds one or more named design specs:
//   binder:
//     input: 5o45_cropped.cif.zst
//     contig: "50-120, /0, A17-131"
// The contig says: a new chain of 50 to 120 residues, a chain break, then
// target chain A residues 17 to 131 from the input structure.
// The real tool's log lines and sample file names aren't documented, so the
// ones printed here are close stand-ins.

import { joinPath, basename } from '../vfs.js';
import { readArgs, needInput, write, useResources, hasGpu, noGpu, pick } from './common.js';
import { chainsOf } from './mpnn.js';

// Residues present in the practice copies of the target structures.
export const TARGETS = {
  '5o45_cropped': { chain: 'A', from: 17, to: 131, name: 'PD-L1' },
  il7ra_cropped: { chain: 'A', from: 22, to: 215, name: 'IL-7 receptor alpha' },
  her2_d4_cropped: { chain: 'A', from: 488, to: 630, name: 'HER2 domain IV' },
  tnfr1_cropped: { chain: 'A', from: 12, to: 160, name: 'TNFR1' },
  rbd_cropped: { chain: 'A', from: 333, to: 527, name: 'Spike RBD' },
};

export const HELP = `rfd4-generate is powered by Hydra.

Usage: rfd4-generate [KEY=VALUE ...]

Common settings:
  inputs=FILE.yaml               design specs to run (required)
  out_dir=DIR                    where to write results (required)
  num_replicates=N               designs per spec (default: 1)
  inference_experiment=NAME      a preset, e.g. quickstart (no scoring, no
                                 torch.compile warm-up)
  seed=N                         random seed
  hf_ckpt_path=nvidia/RFD4-Proteina
                                 model bundle to use (the default; cached)
  '~metrics'                     skip scoring the designs
  compile_lengths=null           skip the torch.compile warm-up

Override anything in the config with KEY=VALUE, delete a key with ~KEY.
Use --cfg job to print the full config.
`;

// Read the small YAML subset the specs use. Returns { specs } or { error }.
export function parseSpecs(text, file) {
  const specs = [];
  const lines = text.split('\n');
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const tab = raw.indexOf('\t');
    if (tab >= 0) return { error: `yaml.scanner.ScannerError: while scanning for the next token\nfound character '\\t' that cannot start any token\n  in "${file}", line ${i + 1}, column ${tab + 1}` };
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = line.match(/^([\w.-]+):\s*$/);
    if (top) {
      current = { name: top[1] };
      specs.push(current);
      continue;
    }
    const kv = line.match(/^(\s+)([\w.-]+):\s*(.*)$/);
    if (!kv || !current) {
      if (current && /^\s+\S/.test(line)) continue; // a continued { ... } block
      return { error: `yaml.parser.ParserError: while parsing a block mapping\n  in "${file}", line ${i + 1}, column 1\nexpected <block end>, but found '<scalar>'` };
    }
    let value = kv[3].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value.at(-1) !== quote) return { error: `yaml.scanner.ScannerError: while scanning a quoted scalar\n  in "${file}", line ${i + 1}, column ${kv[1].length + kv[2].length + 3}\nfound unexpected end of stream` };
      value = value.slice(1, -1);
    }
    current[kv[2]] = value;
  }
  return { specs };
}

// "50-120, /0, A17-131" -> { binder: [50, 120], target: { chain, from, to } } or { error }
export function parseContig(contig) {
  const out = { binder: null, targets: [] };
  for (const seg of String(contig).split(',').map((s) => s.trim()).filter(Boolean)) {
    let m;
    if (seg === '/0') continue;
    if ((m = seg.match(/^(\d+)(?:-(\d+))?$/))) out.binder = [Number(m[1]), Number(m[2] ?? m[1])];
    else if ((m = seg.match(/^([A-Z])(\d+)-(\d+)$/))) out.targets.push({ chain: m[1], from: Number(m[2]), to: Number(m[3]) });
    else return { error: `ValueError: Bad contig segment '${seg}'. Use a length range like 50-120, a chain break /0, or target residues like A17-131.` };
  }
  if (!out.binder) return { error: `ValueError: Contig '${contig}' has no length range for the new chain (like 50-120).` };
  if (out.binder[0] > out.binder[1]) return { error: `ValueError: Bad length range ${out.binder.join('-')}: the first number must be the smaller one.` };
  return out;
}

// What residues an input structure has, by chain: { A: [from, to] }.
function residuesIn(ctx, abs) {
  const key = basename(abs).replace(/\.(cif|pdb)(\.zst|\.gz)?$/, '');
  if (TARGETS[key]) return { [TARGETS[key].chain]: [TARGETS[key].from, TARGETS[key].to] };
  const node = ctx.sh.vfs.get(abs);
  if (node?.binary || !/ATOM/.test(node?.content ?? '')) return null;
  return Object.fromEntries(Object.entries(chainsOf(node.content)).map(([c, seq]) => [c, [1, seq.length]]));
}

// The binder lengths each design gets. Scenarios use this to know results ahead of time.
export function designLength(spec, i, [lo, hi]) {
  return Math.round(lo + (pick(`${spec}:${i}`, 0, 1, 3) * (hi - lo)));
}

export function rfd4Generate(ctx) {
  if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
    ctx.out(HELP);
    return 0;
  }
  const { opts, rest } = readArgs(ctx.args);
  const deleted = rest.filter((r) => r.startsWith('~')).map((r) => r.slice(1));
  const bad = rest.find((r) => !r.startsWith('~'));
  if (bad) {
    ctx.err(`Error parsing override '${bad}'\nmissing EQUAL at '<EOF>'\nSee https://hydra.cc/docs/1.2/advanced/override_grammar/basic for details\n`);
    ctx.coach('rfd4-args', 'Settings are written KEY=VALUE with no spaces, like `inputs=binder.yaml out_dir=runs/first`.');
    return 1;
  }
  for (const key of ['inputs', 'out_dir']) {
    if (!opts[key]) {
      ctx.err(`Error executing job with overrides: [${ctx.args.map((a) => `'${a}'`).join(', ')}]\nomegaconf.errors.MissingMandatoryValue: Missing mandatory value: ${key}\n    full_key: ${key}\n`);
      ctx.coach('rfd4-args', `Add \`${key}=...\`: rfd4-generate needs \`inputs=\` (your YAML file) and \`out_dir=\` (a folder for results).`);
      return 1;
    }
  }
  const yamlPath = needInput(ctx, opts.inputs, 'inputs');
  if (!yamlPath) return 1;
  const parsed = parseSpecs(ctx.sh.vfs.get(yamlPath).content, opts.inputs);
  if (parsed.error) {
    ctx.err(parsed.error + '\n');
    ctx.coach('rfd4-yaml', 'YAML is picky: indent with spaces (never tabs), put a colon after each key, and close every quote.');
    return 1;
  }
  if (!parsed.specs.length) {
    ctx.err(`ValueError: No design specs found in ${opts.inputs}\n`);
    return 1;
  }
  // Check every spec before using the GPU, like the real tool loading its inputs.
  const plans = [];
  for (const spec of parsed.specs) {
    if (!spec.input || !spec.contig) {
      ctx.err(`omegaconf.errors.ConfigKeyError: Spec '${spec.name}' needs both 'input' and 'contig'\n`);
      return 1;
    }
    const input = ctx.sh.resolve(spec.input);
    if (!ctx.sh.vfs.get(input)) {
      ctx.err(`FileNotFoundError: [Errno 2] No such file or directory: '${spec.input}'\n`);
      ctx.coach('rfd4-input', `The \`input:\` line in ${opts.inputs} names a file that isn't there. Paths are read from the folder you run rfd4-generate in, so check it with \`ls ${spec.input.includes('/') ? spec.input.slice(0, spec.input.lastIndexOf('/')) : '.'}\`.`);
      return 1;
    }
    const contig = parseContig(spec.contig);
    if (contig.error) {
      ctx.err(contig.error + '\n');
      return 1;
    }
    const has = residuesIn(ctx, input);
    for (const t of contig.targets) {
      const range = has?.[t.chain];
      if (has && (!range || t.from < range[0] || t.to > range[1])) {
        ctx.err(`ValueError: Contig segment ${t.chain}${t.from}-${t.to} asks for residues that aren't in ${basename(spec.input)}. ${range ? `Chain ${t.chain} has residues ${range[0]}-${range[1]}.` : `It has no chain ${t.chain}.`}\n`);
        ctx.coach('rfd4-contig', 'Target segments must use residue numbers that exist in the input structure.');
        return 1;
      }
    }
    plans.push({ ...spec, contig });
  }
  if (!hasGpu(ctx)) return noGpu(ctx);
  const replicates = Number(opts.num_replicates ?? 1);
  const quick = opts.inference_experiment === 'quickstart';
  const scoring = !quick && !deleted.includes('metrics');
  const warmup = !quick && opts.compile_lengths !== 'null';
  const longest = Math.max(...plans.map((p) => p.contig.binder[1] + p.contig.targets.reduce((n, t) => n + t.to - t.from + 1, 0)));
  const minutes = (warmup ? 4 : 0.5) + plans.length * replicates * (scoring ? 3 : 0.8);
  if (!useResources(ctx, { memGB: 10 + longest / 25, minutes })) return 137;

  const out = ctx.sh.resolve(String(opts.out_dir));
  const shown = String(opts.out_dir).replace(/\/$/, '');
  ctx.out(`[rfd4-generate] Loading ${opts.hf_ckpt_path ?? 'nvidia/RFD4-Proteina'} (cached)\n`);
  if (warmup) ctx.out('[rfd4-generate] Compiling the model for these lengths (torch.compile warm-up)\n');
  ctx.out(`[rfd4-generate] ${plans.length} design spec${plans.length === 1 ? '' : 's'} in ${opts.inputs}: ${plans.map((p) => p.name).join(', ')}\n`);
  let count = 0;
  for (const p of plans) {
    const target = p.contig.targets.map((t) => `${t.chain}${t.from}-${t.to}`).join(' + ') || 'none';
    ctx.out(`[rfd4-generate] ${p.name}: target ${target} from ${basename(p.input)}, new chain ${p.contig.binder.join('-')} residues, ${replicates} design${replicates === 1 ? '' : 's'}\n`);
    for (let i = 0; i < replicates; i++) {
      const length = designLength(p.name, i, p.contig.binder);
      const file = `${p.name}_${i}.cif`;
      write(ctx, joinPath(out, 'inference_samples', file), `data_${p.name}_${i}\n#\n_entry.id ${p.name}_${i}\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\n_atom_site.label_atom_id\n_atom_site.label_comp_id\n_atom_site.label_asym_id\n_atom_site.label_seq_id\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\nATOM 1 CA GLY A 1 1.404 -0.767 -0.600\nATOM 2 CA GLY A 2 2.300 0.000 0.000\n#\n`);
      ctx.out(`[rfd4-generate] wrote ${shown}/inference_samples/${file} (new chain: ${length} residues)\n`);
      count++;
    }
  }
  if (scoring) ctx.out('[rfd4-generate] Scored designs (add \'~metrics\' to skip scoring)\n');
  write(ctx, joinPath(out, '.hydra', 'overrides.yaml'), ctx.args.map((a) => `- ${a}`).join('\n') + '\n');
  ctx.out(`[rfd4-generate] Done: ${count} design${count === 1 ? '' : 's'} in ${shown}/inference_samples/\n`);
  return 0;
}

export function rfd4Evaluate(ctx) {
  ctx.out('(practice site: rfd4-evaluate scores finished designs. The exercises here stop at generating them.)\n', 'dim');
  return 0;
}
