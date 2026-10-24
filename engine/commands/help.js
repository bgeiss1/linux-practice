// Text for `help` and `man`. Kept short on purpose: students read it in the terminal.

export const HELP = `Commands on this practice server (try "man NAME" for details):

  Where am I        pwd  whoami  hostname  ls [-l -a -h -R -t]  cd [DIR | .. | ~ | -]
  Files             mkdir [-p]  touch  cp [-r]  mv  rm [-r]  rmdir  chmod  du -sh
  Archives          tar -czf OUT.tar.gz DIR   tar -tzf FILE   tar -xzf FILE   gzip  gunzip
  Finding           find PATH -name "*.pdb"   grep [-r -i -n -c] TEXT FILES
  Reading           cat  less  head [-n N]  tail [-n N]  wc [-l]  sort  uniq  cut  diff
  Scripts           bash SCRIPT   ./SCRIPT   echo   >  >>  2>  |  &&   NAME=value   $(command)
                    for f in *.pdb; do echo $f; done   basename   nano FILE
  Software          module avail | list | load NAME | purge
                    conda env list | activate NAME | deactivate
  GPUs and jobs     sinfo  nvidia-smi  sbatch SCRIPT  squeue --me  scancel ID
                    sacct  seff ID  srun --gres=gpu:1 --pty bash  exit
  Design tools      protein_mpnn_run.py  run_inference.py  colabfold_batch  relax
  Your laptop       scp [-r] student@geiss-01:PATH LOCAL   scp LOCAL student@geiss-01:PATH
  This app          answer TEXT   hint   clear   history

Tab completes names. Up and down arrows bring back earlier commands.
`;

const page = (name, synopsis, body) => `NAME\n    ${name}\n\nSYNOPSIS\n    ${synopsis}\n\n${body
  .trim()
  .split('\n')
  .map((l) => '    ' + l)
  .join('\n')}\n`;

export const MANUAL = {
  pwd: page('pwd - print the folder you are in', 'pwd', 'Prints the full path of the current working directory.'),
  cd: page('cd - change directory', 'cd [DIR]', `cd DIR     move into DIR
cd ..      move up one level
cd ~       go to your home folder (so does plain "cd")
cd -       go back to the previous folder`),
  ls: page('ls - list folder contents', 'ls [OPTIONS] [PATH...]', `-a    include hidden files (names starting with .)
-l    long listing: permissions, size, date
-h    with -l, sizes like 4.0K and 12M
-t    newest first
-r    reverse the order
-R    list subfolders too`),
  mkdir: page('mkdir - make folders', 'mkdir [-p] DIR...', '-p    create missing parent folders, no error if it exists'),
  cp: page('cp - copy files and folders', 'cp [-r] SOURCE... DEST', '-r    copy folders and everything in them'),
  mv: page('mv - move or rename', 'mv SOURCE... DEST', 'Moves files into DEST, or renames SOURCE to DEST.'),
  rm: page('rm - remove files', 'rm [-r] [-f] FILE...', `-r    remove folders and their contents
-f    don't complain about missing files
There is no trash can. Removed files are gone.`),
  chmod: page('chmod - change permissions', 'chmod MODE FILE...', `chmod +x run.sh    make a script runnable
chmod 644 notes    owner can write, everyone can read`),
  find: page('find - search for files', 'find [PATH...] [TESTS]', `-name "*.pdb"     name matches a pattern (quote it)
-iname PATTERN    same, ignoring upper/lower case
-type f | d       only files or only folders
-size +100M       bigger than 100 MB (k, M, G)
-mtime -1         changed less than 1 day ago
-mmin -30         changed less than 30 minutes ago
-maxdepth N       don't go deeper than N levels`),
  cat: page('cat - print files', 'cat [-n] FILE...', '-n    number the lines'),
  less: page('less - page through a file', 'less FILE', 'Space or arrows to move, /word to search, q to quit.'),
  head: page('head - first lines of a file', 'head [-n N] FILE', 'Shows the first 10 lines, or N with -n.'),
  tail: page('tail - last lines of a file', 'tail [-n N] [-f] FILE', `-n N    last N lines
-n +N   everything from line N on
-f      keep printing new lines (Ctrl+C to stop)`),
  wc: page('wc - count lines, words, bytes', 'wc [-l -w -c] FILE...', '-l    lines only'),
  grep: page('grep - find lines that match', 'grep [OPTIONS] PATTERN [FILE...]', `-i    ignore case
-n    show line numbers
-c    count matching lines
-v    lines that do NOT match
-r    search every file in a folder
-l    only print file names`),
  sort: page('sort - sort lines', 'sort [-n] [-r] [-k N] [-t SEP] FILE', `-n      compare as numbers
-r      reverse
-k N    sort by column N
-t ,    columns are separated by commas`),
  cut: page('cut - pick out columns', 'cut -d SEP -f LIST FILE', 'cut -d "," -f 2,4 scores.csv'),
  tar: page('tar - bundle files into one archive', 'tar -czf OUT.tar.gz PATH...   tar -tzf FILE   tar -xzf FILE [-C DIR]', `c   create an archive
t   list what is inside
x   extract (unpack)
z   compress with gzip (.tar.gz)
v   print each file name
f   the archive file name; must come last, right before the name
-C DIR   extract into DIR`),
  gzip: page('gzip - compress a file', 'gzip FILE   gunzip FILE.gz', 'gzip replaces FILE with FILE.gz. gunzip turns it back.'),
  nano: page('nano - edit a text file', 'nano FILE', `Opens FILE (or a new, empty one) in the editor.
Ctrl+O   save ("write out")
Ctrl+X   exit (asks to save if you changed something)`),
  scp: page('scp - copy files between computers', 'scp [-r] SOURCE... DESTINATION', `Run it on your laptop. A path on Geiss-01 looks like student@geiss-01:~/project/file.pdb
scp student@geiss-01:~/results.tar.gz ~/Downloads/   download
scp target.pdb student@geiss-01:~/project/inputs/      upload
-r   copy a whole folder`),
  du: page('du - disk usage', 'du [-s] [-h] [--max-depth=N] [PATH...]', `-s   one total per PATH
-h   human-readable sizes (K, M, G)
-a   list files too, not just folders`),
  module: page('module - load software', 'module avail | list | load NAME | unload NAME | purge', 'Modules add installed software to your PATH.'),
  conda: page('conda - Python environments', 'conda env list | activate NAME | deactivate', 'Needs "module load anaconda" first.'),
  sbatch: page('sbatch - submit a batch job', 'sbatch SCRIPT', `Reads #SBATCH lines at the top of the script:
--job-name=NAME   --time=HH:MM:SS   --mem=16G
--gres=gpu:1      --partition=gpu   --output=slurm-%j.out`),
  squeue: page('squeue - show the job queue', 'squeue [--me | -u USER] [-j ID]', `ST column: PD pending, R running.
Finished jobs leave the queue; use sacct to see them.`),
  scancel: page('scancel - cancel jobs', 'scancel ID | -n NAME | -u USER', 'You can only cancel your own jobs.'),
  sacct: page('sacct - finished and running jobs', 'sacct [-j ID]', 'Shows State and ExitCode for your jobs.'),
  sinfo: page('sinfo - partitions and nodes', 'sinfo', 'Geiss-01 has two partitions: gpu (2 days) and short (1 hour).'),
  srun: page('srun - run inside a Slurm allocation', 'srun [OPTIONS] COMMAND', `srun --gres=gpu:1 --pty bash   interactive shell with one GPU
exit                            leave and give the GPU back`),
  'nvidia-smi': page('nvidia-smi - GPU status', 'nvidia-smi', 'Lists GPUs, memory in use and utilization.'),
  answer: page('answer - submit an answer (this app only)', 'answer TEXT', 'Some tasks ask you to report something you found.'),
};
