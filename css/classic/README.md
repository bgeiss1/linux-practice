# Classic style (backup)

Copies of `css/app.css` and `css/admin.css` as they were before the Cyberpunk theme
(commit 5439ee0, 2026-11-07). To go back to the classic look, copy these two files
over the ones in `css/` and remove the `theme-cyber.css` link from `index.html` (the dashboard
keeps the classic look), or run:

```bash
git checkout 5439ee0 -- css/app.css css/admin.css index.html admin.html
```
