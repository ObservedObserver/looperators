import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCouncilBrief, councilReadableContent } from '../../dist-electron/shared/council-brief.js';

test('optional decision metadata retains dissent and never hides an invalid source report', () => {
  const brief = { summary: 'Use a local store.', decisions: [{ title: 'SQLite', reason: 'Single host requirement.', evidence: 'Durability review, src/queue.js:4' }], openQuestions: [{ question: 'Who owns backup?', whyItMatters: 'Recovery remains unverified.' }] };
  const content = `# Final plan\nThe backup question remains open.\n\n\`\`\`council-brief\n${JSON.stringify(brief)}\n\`\`\``;
  assert.deepEqual(parseCouncilBrief(content), brief);
  assert.equal(councilReadableContent(content), '# Final plan\nThe backup question remains open.');
  const invalid = content.replace('"openQuestions":[', '"openQuestions":null,"other":[');
  assert.equal(parseCouncilBrief(invalid), undefined);
  assert.equal(councilReadableContent(invalid), invalid);
  assert.equal(parseCouncilBrief(`${content}\n${content}`), undefined, 'ambiguous summaries must not be selected silently');
  assert.equal(parseCouncilBrief('An ordinary report without metadata.'), undefined);
});
