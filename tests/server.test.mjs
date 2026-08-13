import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';

import { createCommitCanvasServer } from '../scripts/serve.mjs';

function account() {
  return { login: 'octocat', id: 1, name: 'Octo Cat', noreplyEmail: '1+octocat@users.noreply.github.com' };
}

function snapshot(endDate = '2025-01-01') {
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 52 * 7));
  const days = [];
  for (let date = new Date(start); date <= new Date(`${endDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
    days.push({ date: date.toISOString().slice(0, 10), count: 0, level: 0 });
  }
  return {
    kind: 'commit-canvas-contribution-snapshot',
    version: 1,
    account: 'octocat',
    generatedAt: '2025-01-02T00:00:00.000Z',
    rangeStart: days[0].date,
    rangeEnd: endDate,
    days,
  };
}

function blankDesign() {
  const levels = Array(53 * 7).fill(0);
  levels[levels.length - 5] = 1;
  return {
    kind: 'commit-canvas-design',
    version: 1,
    endDate: '2025-01-01',
    timeZone: 'UTC',
    counts: [0, 1, 3, 6, 10],
    levels,
  };
}

async function fixture({ validationDefaultBranch } = {}) {
  const calls = [];
  const repository = {
    fullName: 'octocat/commit-canvas-art', owner: 'octocat', name: 'commit-canvas-art',
    defaultBranch: 'main', visibility: 'public', head: 'a'.repeat(40),
    htmlUrl: 'https://github.com/octocat/commit-canvas-art',
  };
  const github = {
    async getSession() { calls.push('session'); return account(); },
    async getContributionSnapshot(endDate) { calls.push(['snapshot', endDate]); return snapshot(endDate); },
    async createOrGetManagedRepository(name, visibility) { calls.push(['repository', name, visibility]); return repository; },
    async validateManagedRepository(fullName) {
      calls.push(['validate', fullName]);
      return validationDefaultBranch ? { ...repository, defaultBranch: validationDefaultBranch } : repository;
    },
    async submitPlan({ expectedDefaultBranch, onProgress }) {
      calls.push('submit');
      assert.equal(expectedDefaultBranch, repository.defaultBranch);
      onProgress({ phase: 'creating commits', completed: 1, created: 1 });
      return { repository: repository.fullName, oldHead: repository.head, newHead: 'b'.repeat(40), created: 1, skipped: 0, commitUrl: `${repository.htmlUrl}/commit/${'b'.repeat(40)}` };
    },
  };
  const csrfToken = 'test-token';
  const created = await createCommitCanvasServer({ live: true, github, csrfToken });
  created.server.listen(0, '127.0.0.1');
  await once(created.server, 'listening');
  const address = created.server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Commit-Canvas-CSRF': csrfToken };
  return { ...created, calls, repository, origin, headers };
}

function rawStatus(origin, path, host) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: url.hostname,
      port: url.port,
      path,
      headers: { Host: host },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('live session exposes identity and CSRF token without CORS', async (t) => {
  const app = await fixture();
  t.after(() => app.server.close());
  const response = await fetch(`${app.origin}/api/session`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.deepEqual(await response.json(), { live: true, csrfToken: 'test-token', account: account() });
});

test('POST APIs require same-origin JSON and CSRF', async (t) => {
  const app = await fixture();
  t.after(() => app.server.close());
  for (const headers of [
    { Origin: 'https://attacker.example', 'Content-Type': 'application/json', 'X-Commit-Canvas-CSRF': 'test-token' },
    { Origin: app.origin, 'Content-Type': 'application/json' },
    { Origin: app.origin, 'Content-Type': 'text/plain', 'X-Commit-Canvas-CSRF': 'test-token' },
  ]) {
    const response = await fetch(`${app.origin}/api/contributions`, { method: 'POST', headers, body: JSON.stringify({ endDate: '2025-01-01' }) });
    assert.ok([403, 415].includes(response.status));
  }
});

test('every route rejects an untrusted Host before static or API routing', async (t) => {
  const app = await fixture();
  t.after(() => app.server.close());
  assert.equal(await rawStatus(app.origin, '/', 'attacker.example'), 403);
  assert.equal(await rawStatus(app.origin, '/styles.css', 'attacker.example'), 403);
});

test('static serving exposes only the explicit application allowlist', async (t) => {
  const app = await fixture();
  t.after(() => app.server.close());
  assert.equal((await fetch(`${app.origin}/`)).status, 200);
  assert.equal((await fetch(`${app.origin}/src/core.js`)).status, 200);
  assert.equal((await fetch(`${app.origin}/README.md`)).status, 404);
  assert.equal((await fetch(`${app.origin}/work/private.commit-canvas-snapshot.json`)).status, 404);
});

test('contribution and managed repository routes return sanitized data', async (t) => {
  const app = await fixture();
  t.after(() => app.server.close());
  let response = await fetch(`${app.origin}/api/contributions`, { method: 'POST', headers: app.headers, body: JSON.stringify({ endDate: '2025-01-01' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).account, 'octocat');
  response = await fetch(`${app.origin}/api/repository`, { method: 'POST', headers: app.headers, body: JSON.stringify({ name: 'commit-canvas-art', visibility: 'public' }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).repository, app.repository);
});

test('submission is revalidated, queued, and reports completion', async (t) => {
  const app = await fixture();
  t.after(() => app.server.close());
  const design = blankDesign();
  const response = await fetch(`${app.origin}/api/submissions`, {
    method: 'POST', headers: app.headers,
    body: JSON.stringify({ repository: app.repository.fullName, expectedDefaultBranch: app.repository.defaultBranch, expectedHead: app.repository.head, design, confirmation: 'CREATE 1 COMMITS FOR design-bfcb5a73' }),
  });
  // The stable export id is deliberately derived by core, so discover a mismatch
  // without weakening the server-side exact-confirmation check.
  if (response.status === 400) {
    const { buildCommitPlan } = await import('../src/core.js');
    const phrase = buildCommitPlan({ ...design, email: account().noreplyEmail }, snapshot()).confirmationPhrase;
    const retry = await fetch(`${app.origin}/api/submissions`, {
      method: 'POST', headers: app.headers,
      body: JSON.stringify({ repository: app.repository.fullName, expectedDefaultBranch: app.repository.defaultBranch, expectedHead: app.repository.head, design, confirmation: phrase }),
    });
    assert.equal(retry.status, 202);
    const accepted = await retry.json();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await fetch(`${app.origin}/api/submissions/${accepted.job.id}`, { headers: { 'X-Commit-Canvas-CSRF': 'test-token' } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).job.status, 'succeeded');
  } else {
    assert.equal(response.status, 202);
  }
  assert.ok(app.calls.some((call) => Array.isArray(call) && call[0] === 'snapshot'));
  assert.ok(app.calls.some((call) => Array.isArray(call) && call[0] === 'validate'));
});

test('submission rejects a same-SHA default branch change before queueing', async (t) => {
  const app = await fixture({ validationDefaultBranch: 'develop' });
  t.after(() => app.server.close());
  const { buildCommitPlan } = await import('../src/core.js');
  const design = blankDesign();
  const phrase = buildCommitPlan({ ...design, email: account().noreplyEmail }, snapshot()).confirmationPhrase;
  const response = await fetch(`${app.origin}/api/submissions`, {
    method: 'POST',
    headers: app.headers,
    body: JSON.stringify({
      repository: app.repository.fullName,
      expectedDefaultBranch: 'main',
      expectedHead: app.repository.head,
      design,
      confirmation: phrase,
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(app.jobs.size, 0);
  assert.equal(app.calls.includes('submit'), false);
});

test('static mode keeps API unavailable', async (t) => {
  const { server } = await createCommitCanvasServer({ live: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/session`);
  assert.equal(response.status, 404);
});
