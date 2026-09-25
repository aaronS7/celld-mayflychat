import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { post, wikiHarness } from './wiki-test-helper.mjs';

test('judged search corpus retains useful candidates, aliases and related terms', async t => {
  const corpus = JSON.parse(await readFile(new URL('./testdata/wiki-search.json', import.meta.url), 'utf8'));
  const h = await wikiHarness(t), wiki = await h.create('Search evaluation');
  for (const page of corpus.pages) {
    const result = await wiki.request('/pages', post({ ...page, author: 'evaluation' }));
    assert.equal(result.status, 201, result.text);
  }
  let useful = 0, found = 0;
  for (const item of corpus.cases) {
    await t.test(item.name, async () => {
      const response = await wiki.request('/search', post({ ...item.search, limit: 20 }));
      assert.equal(response.status, 200, response.text);
      const paths = [...new Set(response.body.results.map(hit => hit.path))];
      for (const [path, grade] of Object.entries(item.judgments)) {
        if (grade < 2) continue;
        useful++;
        if (paths.includes(path)) found++;
        assert.ok(paths.includes(path), `Missing useful candidate: ${path}`);
      }
      if (item.top) assert.equal(paths[0], item.top);
      if (item.only) assert.deepEqual(paths.toSorted(), item.only.toSorted());
      if (item.without_related_terms) {
        const baseline = await wiki.request('/search', post({ ...item.search, related_terms: [], limit: 20 }));
        assert.deepEqual(baseline.body.results.map(hit => hit.path), item.without_related_terms);
      }
    });
  }
  assert.equal(h.provider.requests.length, 0);
  t.diagnostic(`Useful-page candidate recall@20: ${found}/${useful}. Synthetic retrieval check; live Jev ranking quality is not measured.`);
});
