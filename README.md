# Linux Practice

Safe Linux and Slurm practice for MIP662. Students work through short scenarios on a
pretend copy of **Geiss-01** (8 RTX PRO 6000 Blackwell GPUs, about 356 GB RAM) right in
the browser. There is no real shell or server behind it, so nothing a student types can
break anything.

- **Tracks:** Start a session, Navigate, Find files, Read files, Manage files, Run bash
  jobs, Run Slurm jobs, Transfer files. Each track has 12 scenarios in four tiers, from
  fully guided to a short problem the student solves alone.
- **No memorizing:** file names, folders, and numbers are drawn fresh on every attempt,
  and tasks check the result (where you are, what exists, what's in the queue), not the
  exact command typed.
- **Hints get shorter** as students climb: up to three at tier 1, one terse nudge at tier 4.
- **Passphrase:** finishing a track earns a word. The words depend on the student's CSU
  ID, so classmates get different ones. Students paste their passphrase into Canvas.

## Run it locally

Any static web server works. From the repo folder:

```bash
npm run serve        # same as: python3 -m http.server 8000
```

Then open http://localhost:8000.

## Tests

```bash
npm test
```

This replays every scenario's reference solution 25 times with different random values,
and checks the shell commands behave like bash. GitHub Actions runs the same tests on
every push, and only publishes the site when they pass.

## Layout

| Path | What's there |
| --- | --- |
| `index.html`, `css/app.css`, `js/app.js` | The student site |
| `admin.html`, `css/admin.css`, `js/admin.js`, `js/admin-core.js` | The instructor dashboard |
| `js/terminal.js` | The terminal and nano editor, shared by both pages |
| `engine/` | The pretend shell: file system, parser, commands, Slurm and module simulation, scenario runner, passphrase words |
| `scenarios/tracks.json` | Track list, order, and the passphrase salt |
| `scenarios/<track>/NN-name.json` | One scenario per file |
| `tests/` | Engine tests and the scenario solution check |
| `docs/scenarios.md` | How to write a scenario |

## Instructor dashboard

Open `admin.html` on the site (https://bgeiss1.github.io/linux-practice/admin.html). It isn't
linked from the student pages. The instructor and TAs can:

- **Scenarios:** browse every track, reorder, duplicate, remove, or add scenarios, and
  change the passphrase salt.
- **Edit:** a form (or raw JSON) for each scenario, with a validator that replays the
  solution for 20 random draws and a preview terminal where you can play as a student or
  watch the solution run.
- **Import & export:** download everything, one track, or one scenario as JSON, and
  upload files from a TA. You see what's new, changed, or removed before anything merges.
- **Publish:** commits your drafts to GitHub in one commit. It needs a fine-grained
  token limited to this repo with **Contents: Read and write**, which stays in your
  browser. It refuses to overwrite scenarios someone else published after you opened the
  page. Without a token you can download the changed files and upload them on GitHub.
- **History:** recent scenario commits; load any of them as drafts to roll back.
- **Class progress:** load a Canvas CSV (or paste `ID, passphrase` lines) to see which
  tracks each student finished, then download a CSV for the gradebook. Nothing you load
  leaves the browser.

Drafts are saved in your browser as you type. Students only see changes after you publish
and the tests pass (about two minutes).

## Publishing

The site deploys from `main` through GitHub Actions. In the repo's **Settings → Pages**,
set **Source** to **GitHub Actions** once. After that, every merge to `main` that passes
the tests updates the site at `https://bgeiss1.github.io/linux-practice/`.

## Passphrase salt

`passphraseSalt` in `scenarios/tracks.json` changes every student's words. Change it at
the start of each semester so last year's passphrases don't work.
