import { readFile, writeFile } from 'node:fs/promises';

const outputRoot = new URL('../dist/embed/', import.meta.url);
const libraryUrl = new URL(
  '../dist/library/agent-graph-ui.js',
  import.meta.url,
);
const { desktopParityModel } = await import(libraryUrl.href);

const [style, script] = await Promise.all([
  readFile(new URL('agent-graph-ui.css', outputRoot), 'utf8'),
  readFile(new URL('agent-graph-ui.iife.js', outputRoot), 'utf8'),
]);
const envelope = JSON.stringify({
  model: desktopParityModel,
  mode: 'snapshot',
  followUpAvailable: false,
}).replaceAll('<', '\\u003c');
const safeScript = script.replaceAll('</script', '<\\/script');
const document = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'"
    />
    <link rel="icon" href="data:," />
    <title>looperators Agent Graph production embed</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 16px; background: #f8fafc; }
      @media (prefers-color-scheme: dark) {
        body { background: #07090a; }
      }
      ${style}
    </style>
  </head>
  <body>
    <div id="looperators-agent-graph-root"></div>
    <script id="looperators-agent-graph-data" type="application/json">${envelope}</script>
    <script>${safeScript}</script>
  </body>
</html>
`;

await writeFile(new URL('index.html', outputRoot), document, {
  encoding: 'utf8',
  mode: 0o600,
});
