# Writing a scenario

Each scenario is one JSON file in `scenarios/<track>/`, listed in order in
`scenarios/tracks.json`. Run `npm test` after any change: it fails if the reference
solution doesn't finish the scenario.

```json
{
  "id": "navigate-04-one-path",
  "track": "navigate",
  "order": 4,
  "tier": 2,
  "title": "Three folders in one move",
  "story": "Your outputs for {{run}} are in {{project}}/runs/{{run}}/outputs. Get there in a single cd.",
  "vars": {
    "project": ["binder_design", "il7r_binders"],
    "runs": { "pick": 3, "from": ["run_01", "run_02", "run_03", "run_04"] },
    "run": { "fromVar": "runs" }
  },
  "machines": {
    "cluster": {
      "cwd": "~",
      "files": {
        "~/{{project}}/runs/{{runs.0}}/outputs/seqs.fa": { "lib": "fasta:designs" }
      }
    }
  },
  "tasks": [
    { "text": "Go to {{project}}/runs/{{run}}/outputs", "check": { "cwd": "~/{{project}}/runs/{{run}}/outputs" } }
  ],
  "hints": ["A path can hold several folders separated by slashes.", "Use cd with the whole path."],
  "solution": ["cd {{project}}/runs/{{run}}/outputs"]
}
```

## Tiers

| Tier | Name | Hints shown | Coach tips |
| --- | --- | --- | --- |
| 1 | Guided | up to 3; the last can give the full command | every tip |
| 2 | Practice | up to 2 | every tip |
| 3 | Applied | 1, naming the command | only tips about mistakes |
| 4 | Independent | 1 terse nudge, only after a mistake or a second click | none |

Write hints from vague to specific. Stars: 3 with no hints, 2 with one, 1 with more.

## Variables

Anything in `{{double braces}}` is filled in when the scenario starts, everywhere: story,
file paths, file contents, tasks, hints, and solution.

| Form | Result |
| --- | --- |
| `["a", "b", "c"]` | one value |
| `{ "pick": 3, "from": [...] }` | 3 different values in random order, used as `{{name.0}}`, `{{name.1}}` |
| `{ "fromVar": "runs" }` | one value from another list variable |
| `{ "from": [...], "excluding": "other" }` | one value that isn't the other variable's |
| `{ "range": [3, 7] }` | a whole number |

`{{user}}` (student) and `{{home}}` (/home/student) are always available. Don't name a
variable `i` or `n`: those are the counters for `count` and `repeat`.

## Files

Keys are paths (`~` is the home folder). A key ending in `/` is a folder.

| Value | Result |
| --- | --- |
| `"text"` | a file with that content |
| `{}` | an empty folder |
| `{ "lib": "pdb:small" }` | a file from the shared library (`pdb:small`, `pdb:complex`, `fasta:designs`, `text:readme`, `slurm:mpnn`, `log:finished`) |
| `{ "count": 5 }` with `{{i}}` in the key | 5 files, `{{i}}` = 01..05 |
| `"age": "3d"` | modified 3 days ago (`30m`, `2h`, `3d`, `1w`) |
| `"size": "150M"` | reports that size to `ls -l` and `find -size` |
| `"exec": true` | executable |
| `{ "archive": { "gz": true, "files": { "run/a.pdb": { "lib": "pdb:small" } } } }` | a .tar.gz (or .tar with `"gz": false`) holding those files, for `tar -tzf` / `tar -xzf` |
| `{ "repeat": { "n": 40, "text": "step {{n}}: ok\n", "before": "...", "after": "...", "insert": { "at": 12, "text": "WARNING ...\n" } } }` | a long file: `text` repeated `n` times with `{{n}}` = 1..n, plus an optional line dropped in at position `at` |

Other `cluster` settings: `cwd`, `modules` (preloaded), `conda` (active env), `gpusBusy`
(GPUs other users hold: 1, 2, 4 or 5; default 2), `jobs` (the student's existing jobs, e.g.
`{ "id": 47911, "name": "af2", "gpus": 1, "state": "PD", "reason": "PartitionTimeLimit" }`),
and `jobRules`, which decide what happens when a script is submitted:

```json
"jobRules": [
  { "match": "run_mpnn.sh", "needsGpu": true, "needsTimeMin": 90, "needsMemGB": 64,
    "creates": ["outputs/seqs/{{task}}.fa"], "log": "Designing 8 sequences\n", "runSteps": 3 }
]
```

A job that asks for too little time, memory, or no GPU fails the way real Slurm would
(TIMEOUT, OUT_OF_MEMORY, or a CUDA error in its log). `logStart` is what the log shows
before it fails. `{{task}}` (array task number) and `{{job}}` (job ID) are filled in per job.

### The laptop

Transfer scenarios add a second machine, the student's own laptop, shown as a Laptop tab
next to the Geiss-01 terminal. Its home is `/Users/student` and it starts with Desktop,
Documents and Downloads. `scp` works only there.

```json
"machines": {
  "cluster": { "cwd": "~/project", "files": { ... } },
  "laptop": { "cwd": "~/Downloads", "files": { "~/Documents/target.pdb": { "lib": "pdb:small" } } }
}
```

### Design tools

`protein_mpnn_run.py` (conda env proteinmpnn), `run_inference.py` (rfdiffusion),
`colabfold_batch` (module colabfold), `run_alphafold.sh` (module alphafold) and
`relax` / `rosetta_scripts` (module rosetta) exist once their module or environment is
loaded. The GPU tools need an `srun --gres=gpu:N --pty bash` session. They print a short
log and write placeholder outputs where real tools would.

## Checks

Tasks complete in order and stay complete. Pick checks that look at the outcome.

| Check | Passes when |
| --- | --- |
| `{ "cwd": "~/x" }` | the student is in that folder |
| `{ "exists": path }`, `notExists`, `isDir`, `isFile`, `executable` | the path is in that state |
| `{ "fileContains": { "path": p, "text": t } }` | the file contains the text |
| `{ "dirHas": { "path": p, "names": [...], "only": true } }` | the folder has those entries (and only those) |
| `{ "moduleLoaded": "anaconda" }`, `{ "condaEnv": "proteinmpnn" }` | environment state |
| `{ "inInteractiveJob": 1 }`, `{ "inInteractiveJob": { "gpus": 2, "memGB": 64 } }`, `{ "notInInteractiveJob": true }` | inside an `srun --pty` job with at least that much, or not |
| `{ "jobSubmitted": { "name": "mpnn", "gpus": 1, "memGB": 32, "timeMin": 60, "partition": "gpu", "array": 4, "dependency": true, "after": "rfd" } }` | the student submitted a batch job like that (every key optional; numbers are minimums; `after` names the job it waits for) |
| `{ "jobState": { "name": "mpnn", "state": "CD" } }` | same keys, plus the state: PD, R, CD, F, TO, OOM, CA |
| `{ "archiveHas": { "path": p, "names": ["run/a.pdb"], "gz": true, "only": false } }` | p is a tar archive holding those files |
| `{ "isCompressed": path }`, `{ "modeIs": { "path": p, "mode": "755" } }` | gzip'd file; exact permissions |
| `{ "laptop": { ...any check... } }` | the check passes on the laptop instead (`~` = /Users/student there) |
| `{ "ran": "ls", "flags": "a", "arg": "~/x", "argHas": "..", "lineHas": "*.pdb", "ok": true, "inDir": "~/x" }` | the student ran that command (all keys but `ran` optional; `lineHas` checks the line as typed, before wildcards expand) |
| `{ "answer": "value" }` | the student typed `answer value` (case doesn't matter; numbers match by value, so 017 = 17) |
| `{ "all": [...] }`, `{ "any": [...] }`, `{ "not": {...} }` | combine checks |

## Solutions

`solution` lists what a student would type, in order. The test suite runs it for 25
random draws and fails if the scenario doesn't finish. Besides plain command lines:

| Step | Does |
| --- | --- |
| `{ "nano": "run.sh", "text": "#!/bin/bash\n..." }` | opens the editor on run.sh and saves that text |
| `{ "laptop": "scp student@geiss-01:~/a.pdb ~/Downloads/" }` | runs the line in the Laptop tab |

Slurm jobs need a few commands to pass before they finish, so follow `sbatch` with a few
`squeue --me` lines when a later task waits for the job.
