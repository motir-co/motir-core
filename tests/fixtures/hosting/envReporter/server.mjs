// The env-reporting fixture app for the operator deploy check (Story MOTIR-9795 ·
// MOTIR-9965). No dependencies. `GET /health` answers 200; `GET /` answers two
// lines: GREETING's plain value and only whether API_KEY is set — a secret's value
// never leaves the running app.
//
// The deploy runs the SAME server as the inline `node -e` program in
// `../motir.hosting.env-report.json`'s start command (the Fly adapter splits a
// start command on whitespace, so that program has none); a test runs both and
// holds their answers equal.
import { createServer } from 'node:http';

createServer((req, res) => {
  if (req.url === '/health') {
    res.end('ok');
    return;
  }
  res.setHeader('content-type', 'text/plain');
  res.end(
    `GREETING=${process.env.GREETING ?? ''}\n` +
      `API_KEY: ${process.env.API_KEY ? 'present' : 'absent'}\n`,
  );
}).listen(process.env.PORT || 8080);
