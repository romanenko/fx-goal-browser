import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../test/fixture.html', import.meta.url));
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
});
server.listen(8877, '127.0.0.1', () => console.error('Local fixture: http://127.0.0.1:8877'));
