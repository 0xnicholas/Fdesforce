// PROTOTYPE — generated skeleton.
import { createServer } from 'node:http';
import { handleRuntimeRequest } from './runtime/routes';

const port = Number(process.env.PORT ?? 4111);
createServer((request, response) => {
  void handleRuntimeRequest(request, response);
}).listen(port, () => {
  console.log(`mastra-app prototype listening on :${port}`);
});
