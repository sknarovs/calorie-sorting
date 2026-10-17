// Reads a Barbora product page from stdin and prints only what the unit tests
// need: the <script> element holding `window.product =` and the nutrition table.
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const html = Buffer.concat(chunks).toString('utf8');
  const at = html.indexOf('window.product =');
  if (at === -1) {
    console.error('trim-fixture: no `window.product =` in the input');
    process.exit(1);
  }
  const parts = [html.slice(html.lastIndexOf('<script', at), html.indexOf('</script>', at) + '</script>'.length)];
  const tableStart = html.indexOf('<table class="table table-striped table-condensed"');
  if (tableStart !== -1) {
    parts.push(html.slice(tableStart, html.indexOf('</table>', tableStart) + '</table>'.length));
  }
  process.stdout.write(`${parts.join('\n')}\n`);
});
