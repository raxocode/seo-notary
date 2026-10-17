# Demo

A two-page fixture used by the README walkthrough and the smoke test.

- `/broken`: the server sends a good title and canonical, then a script rewrites both after load.
- `/fixed`: the same page without the script.

```bash
npm run build
npm run demo                       # serves http://127.0.0.1:4173
node packages/cli/dist/bin.js verify http://127.0.0.1:4173/broken --tier browser   # FAIL, exit 1
node packages/cli/dist/bin.js verify http://127.0.0.1:4173/fixed --tier browser    # PASS, exit 0
```

`demo.tape` is a [VHS](https://github.com/charmbracelet/vhs) script that records the same session as a GIF.
