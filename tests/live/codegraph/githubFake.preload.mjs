// GITHUB, FOR MOTIR-CORE'S JOB WORKER IN THE LIVE LANE (MOTIR-12260).
//
// Loaded with `node --import` ahead of the worker bundle, so it is installed in the
// worker's OWN process before any module captures `fetch`. It answers every request
// to api.github.com from the scenario file and passes everything else — motir-ai,
// the database's HTTP neighbours — to the real `fetch`, so motir-core → motir-ai
// stays a real network hop. This is motir-core's GitHub intercept seam in the same
// place the default E2E lane keeps it (the worker), without the motir-ai stubs that
// lane carries.
//
//   POST /app/installations/<id>/access_tokens   an installation token
//   GET  /repos/<o>/<n>/commits/<ref>            the ref's (or sha's) head, as text
//   GET  /repos/<o>/<n>/pulls/<number>           the pull request, head read live
//   GET  /repos/<o>/<n>/compare/<base>...<head>  three-dot, from the merge base
//   GET  /repos/<o>/<n>/tarball/<ref>            302 to the local archive host
//   anything else on api.github.com              200 [] (the delivery handling's
//                                                 incidental reads: changed paths,
//                                                 check runs), journalled
//
// Every request is appended to LIVE_GITHUB_LOG as one JSON line (method, path,
// answer status) — never a header, so no token is written.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { compareThreeDot, readScenario } from './scenario.mjs';

const scenarioPath = process.env.LIVE_SCENARIO;
const logPath = process.env.LIVE_GITHUB_LOG;
if (!scenarioPath || !logPath) {
  throw new Error('githubFake.preload: LIVE_SCENARIO and LIVE_GITHUB_LOG must be set');
}

const realFetch = globalThis.fetch;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function journal(method, path, status) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), method, path, status })}\n`,
  );
}

function headOf(scenario, ref) {
  if (scenario.commits[ref]) return ref;
  return scenario.refs[ref] ?? null;
}

function pullRequestBody(scenario, pr) {
  const headSha = scenario.refs[pr.headRef] ?? null;
  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    draft: false,
    title: `Pull request ${pr.number}`,
    updated_at: new Date().toISOString(),
    head: {
      ref: pr.headRef,
      sha: headSha,
      repo: pr.headRepoId === null ? null : { id: pr.headRepoId },
    },
    base: { ref: pr.baseRef, sha: scenario.refs[pr.baseRef] ?? null, repo: { id: scenario.id } },
    user: { id: 4242, login: 'live-lane' },
  };
}

function answer(method, url) {
  const scenario = readScenario(scenarioPath);
  const path = decodeURIComponent(url.pathname);
  if (/^\/app\/installations\/[^/]+\/access_tokens$/.test(path)) {
    return json(201, {
      token: `ghs_live_${randomUUID().replaceAll('-', '')}`,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  const repo = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(path);
  if (repo && repo[1] === scenario.owner && repo[2] === scenario.name) {
    const rest = repo[3];
    let m = /^commits\/(.+)$/.exec(rest);
    if (m) {
      const sha = headOf(scenario, m[1]);
      return sha ? new Response(sha, { status: 200 }) : json(404, { message: 'Not Found' });
    }
    m = /^pulls\/(\d+)$/.exec(rest);
    if (m) {
      const pr = scenario.pulls[m[1]];
      return pr ? json(200, pullRequestBody(scenario, pr)) : json(404, { message: 'Not Found' });
    }
    m = /^compare\/(.+)\.\.\.(.+)$/.exec(rest);
    if (m) {
      const base = headOf(scenario, m[1]);
      const head = headOf(scenario, m[2]);
      const body = base && head ? compareThreeDot(scenario, base, head) : null;
      return body ? json(200, body) : json(404, { message: 'Not Found' });
    }
    m = /^tarball\/(.+)$/.exec(rest);
    if (m) {
      const sha = headOf(scenario, m[1]);
      if (!sha) return json(404, { message: 'Not Found' });
      return new Response(null, {
        status: 302,
        headers: {
          location: `${scenario.archiveOrigin}/archive/${sha}.tar.gz?token=${randomUUID()}`,
        },
      });
    }
  }
  return method === 'GET' ? json(200, []) : json(200, {});
}

globalThis.fetch = async function liveLaneFetch(input, init) {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(raw);
  if (url.hostname !== 'api.github.com') return realFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const res = answer(method, url);
  journal(method, url.pathname, res.status);
  return res;
};
