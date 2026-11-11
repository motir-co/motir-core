import { afterEach, describe, expect, it } from 'vitest';

import {
  hostedAttributionLine,
  resetHostedRun,
  setActiveHostedRun,
  type HostedAttribution,
} from '../src/hostedAttribution';

// MOTIR-10973: the footer's run link must open the run modal, `/runs?run=<id>`.
// There is no `/runs/<id>` route, so that form 404s on every hosted pull request.

function attribution(overrides: Partial<HostedAttribution> = {}): HostedAttribution {
  return {
    runId: 'cmwc8wabf02fs01ad3mype5rz',
    serverUrl: 'https://app.motir.co',
    targetKey: 'MOTIR-7',
    dispatchedBy: 'Yue Zhu',
    stateDir: '/tmp/state',
    ...overrides,
  };
}

afterEach(() => resetHostedRun());

describe('hostedAttributionLine — the run link', () => {
  it('links the run to the run modal, /runs?run=<id>, never /runs/<id>', () => {
    const line = hostedAttributionLine(attribution())!;
    expect(line).toContain(
      'run [cmwc8wabf02fs01ad3mype5rz](https://app.motir.co/runs?run=cmwc8wabf02fs01ad3mype5rz).',
    );
    expect(line).not.toContain('/runs/');
  });

  it('URL-encodes the run id in the link and keeps it readable in the label', () => {
    const line = hostedAttributionLine(attribution({ runId: 'run 1&x=2/y' }))!;
    expect(line).toContain('run [run 1&x=2/y](https://app.motir.co/runs?run=run%201%26x%3D2%2Fy).');
  });

  it('drops trailing slashes from the server URL before building either link', () => {
    const line = hostedAttributionLine(attribution({ serverUrl: 'https://app.motir.co///' }))!;
    expect(line).toContain('(https://app.motir.co/runs?run=cmwc8wabf02fs01ad3mype5rz)');
    expect(line).toContain('(https://app.motir.co/items/MOTIR-7)');
  });

  it('leaves the card link as /items/<key>', () => {
    const line = hostedAttributionLine(attribution())!;
    expect(line).toContain('card [MOTIR-7](https://app.motir.co/items/MOTIR-7)');
  });

  it('names the dispatcher when known, and only "Dispatched" otherwise', () => {
    expect(hostedAttributionLine(attribution())).toContain('Dispatched by Yue Zhu through');
    expect(hostedAttributionLine(attribution({ dispatchedBy: null }))).toContain(
      '\nDispatched through a Motir hosted run',
    );
  });

  it('reads the active hosted run by default, and is null on a local run', () => {
    expect(hostedAttributionLine()).toBeNull();
    setActiveHostedRun(attribution({ runId: 'run_9' }));
    expect(hostedAttributionLine()).toContain('/runs?run=run_9');
  });
});
