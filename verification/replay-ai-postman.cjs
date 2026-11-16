// Replay the maintained collection over local HTTP; no Postman script evaluation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const collectionPath = path.join(
  __dirname,
  '..',
  'postman',
  'brandora-ai-local.postman_collection.json',
);

function localOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Collection replay requires a loopback HTTP origin');
  return url.origin;
}

async function replay(baseUrl = 'http://127.0.0.1:3099', transport = fetch) {
  const origin = localOrigin(baseUrl);
  const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const results = [];
  for (const item of collection.item) {
    assert.equal(item.request.url, '{{baseUrl}}/dev/ai/respond');
    assert.equal(item.request.method, 'POST');
    const expected = item.event[0].script.exec
      .join('\n')
      .match(/have.status\((\d+)\)/);
    assert(expected, 'Collection item must declare its expected status');
    const response = await transport(origin + '/dev/ai/respond', {
      method: 'POST',
      headers: Object.fromEntries(
        item.request.header.map((h) => [h.key, h.value]),
      ),
      body: item.request.body.raw,
      signal: AbortSignal.timeout(35000),
    });
    const body = await response.json();
    assert.equal(response.status, Number(expected[1]), item.name);
    if (response.status === 200) {
      assert.deepEqual(Object.keys(body).sort(), [
        'intent',
        'orderCandidate',
        'reply',
        'requiresReview',
      ]);
      assert.equal(body.orderCandidate, null);
      assert.equal(
        response.headers.get('X-Brandora-Test-Mode'),
        'synthetic-no-history',
      );
    }
    if (item.event[0].script.exec.join('\n').includes('History is unavailable'))
      assert.equal(response.headers.get('X-AI-History-Status'), 'unavailable');
    results.push({
      name: item.name,
      status: response.status,
      tools: response.headers.get('X-Brandora-Tool-Calls'),
      liveGroq: response.headers.get('X-Brandora-Live-Groq'),
    });
  }
  return {
    layer: 'collection HTTP replay; Postman GUI/pm runtime not executed',
    passed: results.length,
    failed: 0,
    results,
  };
}

if (require.main === module) {
  replay(process.argv[2])
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch(() => {
      console.error(
        'Local collection replay failed; verify local runners and the maintained collection.',
      );
      process.exitCode = 1;
    });
}
module.exports = { replay, localOrigin };
