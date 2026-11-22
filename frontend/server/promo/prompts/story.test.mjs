import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storyPrompt } from '../prompts.mjs';
import { loadReferences, rangeFor } from '../references.mjs';

test('ref-5 provides HCX-007 a timing example that includes the full ten seconds', () => {
  const { refs, rules } = loadReferences();
  const range = rangeFor(refs, rules, 'ref-5', 10);
  const prompt = storyPrompt({
    input: { lengthSec: 10, referenceId: 'ref-5', locale: 'ko', moods: ['warm'], concepts: ['day-at-shop'], memo: '' },
    rules, range, store: { name: '카페', location: '서울' }, photos: [], exterior: {},
  });
  assert.match(prompt, /\[\{"start":0,"duration":3.75\},\{"start":3.75,"duration":3.75\},\{"start":7.5,"duration":2.5\}\]/);
});
