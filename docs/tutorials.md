# Writing tutorial lessons

Each track can have `tutorials/<track>.json`. Students see its lessons in the track,
between the practice scenarios, and by default must finish a lesson before the practice
after it (the dashboard can turn that off).

```json
{
  "track": "navigate",
  "lessons": [
    {
      "id": "cd",
      "title": "Moving around with cd",
      "summary": "One line shown in the track list.",
      "before": "navigate-01-where-am-i",
      "blocks": [ ... ]
    }
  ]
}
```

`before` is the id of the scenario the lesson comes just before. Leave it out to put the
lesson at the end of the track. Several lessons can share one `before`; they appear in
file order.

## Blocks

| Block | Shows |
| --- | --- |
| `{ "text": "..." }` | Paragraphs. A blank line starts a new one; `` `code` `` is shown as code. |
| `{ "command": { "name": "cd", "stands": "change directory", "syntax": "cd [FOLDER]", "what": "..." } }` | A card for a command: its name, what the name stands for, its form, and what it does. |
| `{ "flags": [["-a", "all", "Also list hidden files"], ...] }` | A table: what to write, what it's short for, what it does. |
| `{ "example": { "cmd": "ls -l", "out": "...", "note": "..." } }` | A terminal snippet with its output and a caption. Leave out `cmd` for a diagram. |
| `{ "try": { ... } }` | A small live terminal with one task (see below). |
| `{ "quiz": { "q": "...", "options": ["..."], "answer": 1, "why": "..." } }` | A multiple-choice check. `answer` counts from 0. `why` shows once they pick it. |
| `{ "tip": "..." }`, `{ "warn": "..." }` | A highlighted note. |

A lesson is done when every Try it is finished and every quiz answered correctly. A
lesson with neither has an "I've read this" button.

## Try it

```json
{ "try": {
    "text": "Move into binder_design.",
    "cwd": "~",
    "files": { "~/binder_design/README.txt": "hello\n" },
    "check": { "cwd": "~/binder_design" },
    "hint": "cd binder_design",
    "solution": ["cd binder_design"]
} }
```

`files`, `check` and `solution` work exactly as in scenarios (see `docs/scenarios.md`).
For several steps, give `tasks` (a list of `{ "text", "check" }`) instead of `check`.
For Slurm jobs or the laptop, give a full `machines` object instead of `cwd` and
`files`, and `"on": "laptop"` to put the terminal on the laptop.

`npm test` replays every solution, so a broken Try it fails the tests.
