import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BASE, LENGTHS, buildEstimateModel, multipliers } from '../estimate.mjs';

const available = { claude: true, browser: true, ffmpeg: true };

test('12.7 예 값과 같다(반올림 전 → 올림·반올림)', () => {
  const { table, basis, sampleCount, pricing, fx } = buildEstimateModel({ available });
  const at = (L, n) => table[L][n];
  assert.deepEqual([at(10, 5).seconds, at(15, 5).seconds, at(30, 5).seconds, at(15, 8).seconds, at(30, 10).seconds], [121, 153, 251, 159, 262]);
  assert.deepEqual([at(10, 5).costUsd, at(15, 5).costUsd, at(30, 5).costUsd, at(15, 8).costUsd, at(30, 10).costUsd], [0.272, 0.306, 0.409, 0.356, 0.492]);
  assert.deepEqual([at(10, 5).costKrw, at(15, 5).costKrw, at(30, 5).costKrw, at(15, 8).costKrw, at(30, 10).costKrw], [381, 429, 572, 499, 689]);
  assert.deepEqual(at(10, 0), { photoCount: 0, seconds: 104, costUsd: 0.189, costKrw: 265 });
  assert.equal(basis, 'spike'); assert.equal(sampleCount, 0);
  assert.equal(pricing.model, 'claude-sonnet-5-5'); assert.equal(fx.krwPerUsd, 1400);
});

test('단조성: 사진 수·길이가 늘면 값이 줄지 않음, 같은 입력은 같은 값(표본 있어도)', () => {
  const samples = [{ lengthSec: 15, photoCount: 5, stageMs: { look: 1000, story: 40000, scenes: 200000, merge: 20000 } }];
  for (const model of [buildEstimateModel({ available }), buildEstimateModel({ samples, available })]) {
    for (const L of LENGTHS) for (let n = 1; n <= 10; n++) {
      assert.ok(model.table[L][n].seconds >= model.table[L][n - 1].seconds);
      assert.ok(model.table[L][n].costUsd >= model.table[L][n - 1].costUsd);
    }
    for (let n = 0; n <= 10; n++) {
      assert.ok(model.table[15][n].seconds >= model.table[10][n].seconds && model.table[30][n].seconds >= model.table[15][n].seconds);
      assert.ok(model.table[15][n].costKrw >= model.table[10][n].costKrw && model.table[30][n].costKrw >= model.table[15][n].costKrw);
    }
  }
  assert.deepEqual(buildEstimateModel({ samples, available }), buildEstimateModel({ samples, available }));
});

test('실측 배율: 최근 5개 평균, 0.5~3 제한, basis average', () => {
  const s = (look, merge) => ({ lengthSec: 15, photoCount: 5, stageMs: { look, story: 27500, scenes: 90000, merge } });
  const m = multipliers(DEFAULT_BASE, [s(0, 18500 * 10), s(0, 18500 * 10)]);
  assert.equal(m.look, 0.5); assert.equal(m.merge, 3); assert.equal(m.story, 1); assert.equal(m.scenes, 1);
  const model = buildEstimateModel({ samples: [s(15000, 18500)], available });
  assert.equal(model.basis, 'average'); assert.equal(model.sampleCount, 1);
  assert.equal(model.table[15][5].seconds, 153);
});
