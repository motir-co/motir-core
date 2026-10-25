// THE HOST AGENT'S ONLY LOG LINE (Story MOTIR-9361 · MOTIR-9480). A request's
// stdin can carry a run credential, its command a prompt, and the files this
// service reads hold a private key, so nothing but the route, the status and the
// duration is ever written. There is no other logging path in this service: a
// caller cannot pass a body, a header or an env value, because this function has
// no parameter that would take one.

export interface RequestLogLine {
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
}

export type LogSink = (line: string) => void;

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/** The routes a line may name; anything else is logged as `other`. */
const KNOWN_ROUTES = new Set(['/v1/exec', '/v1/terminal', '/v1/chat']);

export function createRequestLog(sink: LogSink = stdoutSink) {
  return (entry: RequestLogLine): void => {
    const route = KNOWN_ROUTES.has(entry.route) ? entry.route : 'other';
    sink(
      JSON.stringify({
        route,
        status: Math.trunc(entry.status),
        durationMs: Math.max(0, Math.round(entry.durationMs)),
      }),
    );
  };
}

export type RequestLog = ReturnType<typeof createRequestLog>;
