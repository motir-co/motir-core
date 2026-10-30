// MOTIR-10100 — a ready preview's fake release pointed at a STAND-IN the test
// runs, on real Postgres: the gate's route answers the stand-in's origin with the
// release's own origin credential, and the forwarder's header set, delivered over
// a real socket, arrives with the derived secret and without Motir's cookies.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN_SECRET_HEADER, deriveOriginSecret } from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  getHostingDeployPort,
  hostingFakeControls,
  hostingOriginSecretKey,
  resetHostingFakes,
} from '@/lib/orchestrator/hosting';
import { forwardedHeaders } from '@/lib/preview/gateProxy';
import { previewGateService, resetPreviewRouteCache } from '@/lib/services/previewGateService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { PREVIEW_HOST, makePreviewGateFixture } from '../helpers/previewGateFixture';
import {
  STAND_IN_PAGE,
  startPreviewUpstreamStandIn,
  type PreviewUpstreamStandIn,
} from '../helpers/previewUpstreamStandIn';

let standIn: PreviewUpstreamStandIn;

beforeEach(async () => {
  await truncateAuthTables();
  resetHostingFakes();
  resetPreviewRouteCache();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_PREVIEW_DOMAIN', 'preview.motir.site');
  standIn = await startPreviewUpstreamStandIn();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await standIn.stop();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a ready preview pointed at a stand-in', () => {
  it('routes to the stand-in with the release credential and the derived secret', async () => {
    const fixture = await makePreviewGateFixture();
    hostingFakeControls('fly').setUpstream(fixture.appRef, standIn.origin);
    resetPreviewRouteCache();

    const route = await previewGateService.route(PREVIEW_HOST);
    expect(route?.upstream?.origin).toBe(standIn.origin);
    expect(route?.upstream?.credential).toBe('origin_secret');
    expect(route?.upstream?.headers[ORIGIN_SECRET_HEADER]).toBe(
      deriveOriginSecret(hostingOriginSecretKey(), fixture.appRef),
    );
  });

  it('receives the forwarder’s headers: the derived secret, no Motir cookie', async () => {
    const fixture = await makePreviewGateFixture();
    hostingFakeControls('fly').setUpstream(fixture.appRef, standIn.origin);
    resetPreviewRouteCache();
    const upstream = (await previewGateService.route(PREVIEW_HOST))!.upstream!;

    const viewer = new Request(`https://${PREVIEW_HOST}/invoices?status=open`, {
      headers: {
        cookie: 'better-auth.session_token=abc; __Host-motir-gate=def; theme=dark',
        'x-motir-origin-secret': 'forged',
      },
    });
    const headers = forwardedHeaders(viewer, PREVIEW_HOST, upstream);
    const answer = await fetch(`${standIn.origin}/invoices?status=open`, { headers });
    expect(answer.status).toBe(200);

    const received = await standIn.waitForRequest((r) => r.path.startsWith('/invoices'));
    expect(received.method).toBe('GET');
    expect(received.path).toBe('/invoices?status=open');
    expect(received.headers['x-motir-origin-secret']).toBe(
      deriveOriginSecret(hostingOriginSecretKey(), fixture.appRef),
    );
    expect(received.headers['x-forwarded-host']).toBe(PREVIEW_HOST);
    expect(received.headers['x-forwarded-proto']).toBe('https');
    expect(received.headers.cookie).toBe('theme=dark');
  });

  it('is the one cached fake, and a narrowed-prefix caller does not see it', async () => {
    const fixture = await makePreviewGateFixture();
    hostingFakeControls('fly').setUpstream(fixture.appRef, standIn.origin);
    const port = getHostingDeployPort('fly');
    const [live] = await port.listReleases({ appRef: fixture.appRef });
    expect((await port.describe(live!.handle)).upstreamAddress).toBe(standIn.origin);
    const narrowed = getHostingDeployPort('fly', { appPrefix: 'motir-deploy-check-' });
    expect(narrowed).not.toBe(port);
    expect(await narrowed.listReleases({ appRef: fixture.appRef })).toEqual([]);
  });
});

describe('the stand-in', () => {
  it('answers one labelled page, records in order, resets and releases its port', async () => {
    const first = await fetch(`${standIn.origin}/a`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toMatch(/^text\/html/);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const page = await first.text();
    expect(page).toBe(STAND_IN_PAGE);
    expect(page).toContain('data-testid="preview-stand-in"');
    expect(page).toMatch(/<h1>[^<]*stand-in/);

    await fetch(`${standIn.origin}/b`, { method: 'POST', body: 'hello' });
    expect(standIn.requests().map((r) => r.path)).toEqual(['/a', '/b']);
    expect(standIn.last()).toMatchObject({ method: 'POST', body: 'hello' });

    const origin = standIn.origin;
    standIn.reset();
    expect(standIn.requests()).toEqual([]);
    expect(standIn.last()).toBeUndefined();
    expect(standIn.origin).toBe(origin);

    const pending = standIn.waitForRequest((r) => r.path === '/c');
    await fetch(`${standIn.origin}/not-yet`);
    await fetch(`${standIn.origin}/c`);
    expect((await pending).path).toBe('/c');
    expect((await standIn.waitForRequest()).path).toBe('/not-yet');
    await expect(standIn.waitForRequest((r) => r.path === '/never', 20)).rejects.toThrow(
      /no matching request/,
    );

    await standIn.stop();
    const next = await startPreviewUpstreamStandIn();
    expect(next.origin).not.toBe(origin);
    standIn = next;
  });
});
