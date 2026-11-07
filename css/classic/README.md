# Classic style (backup)

Copies of `css/app.css` and `css/admin.css` as they were before the Cyberpunk theme
(git tag `classic-style`, 2026-11-07). To go back to the classic look, copy these two files
over the ones in `css/` and remove the `theme-cyber.css` link from `index.html` and
`admin.html`, or run:

```bash
git checkout classic-style -- css/app.css css/admin.css index.html admin.html
```
