import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentGraphScenarios,
  assertAgentGraphModel,
  createAgentLoopFlowElements,
  desktopParityModel,
  orientationForWidth,
} from '../dist/library/agent-graph-ui.js';

test('all paired fixtures contain an independently valid portable model', () => {
  assert.equal(agentGraphScenarios.length, 7);
  for (const fixture of agentGraphScenarios) {
    assert.equal(
      assertAgentGraphModel(fixture.expectedModel),
      fixture.expectedModel,
    );
    assert.equal(
      fixture.projection.projectionDigest,
      fixture.expectedModel.identity.projectionDigest,
    );
    assert.equal(fixture.projection.integrity.status, 'verified');
  }
});

test('Desktop parity model exercises the rich shared interaction surface', () => {
  assert.equal(assertAgentGraphModel(desktopParityModel), desktopParityModel);
  assert.equal(desktopParityModel.nodes.every((node) => node.description), true);
  assert.equal(desktopParityModel.edges.some((edge) => edge.pending), true);
  assert.equal(desktopParityModel.latestReport.issues.length, 2);
  assert.equal(desktopParityModel.laps.length, 2);
});

test('wide and narrow layouts keep three stable nodes and four relationships', () => {
  const model = agentGraphScenarios.find(
    (fixture) => fixture.name === 'reviewer-issues',
  ).expectedModel;
  for (const orientation of ['horizontal', 'vertical']) {
    const flow = createAgentLoopFlowElements(model, orientation);
    assert.deepEqual(
      flow.nodes.map((node) => node.id),
      ['root', 'role:implementer', 'role:reviewer'],
    );
    assert.deepEqual(
      flow.edges.map((edge) => edge.data.edge.kind),
      ['governs', 'handoff', 'feedback', 'verdict'],
    );
    assert.equal(
      flow.edges.filter((edge) => edge.animated).map((edge) => edge.id)[0],
      'reviewer-feedback-implementer',
    );
  }
  assert.equal(orientationForWidth(719), 'vertical');
  assert.equal(orientationForWidth(720), 'horizontal');
});

test('model validation rejects unverified, invalid, and unknown-node input', () => {
  const model = structuredClone(agentGraphScenarios[0].expectedModel);
  assert.throws(
    () =>
      assertAgentGraphModel({
        ...model,
        identity: { ...model.identity, integrity: 'unknown' },
      }),
    /verified/,
  );
  assert.throws(
    () =>
      assertAgentGraphModel({
        ...model,
        identity: { ...model.identity, projectionDigest: 'short' },
      }),
    /bounded string/,
  );
  const edges = structuredClone(model.edges);
  edges[0].target = 'missing';
  assert.throws(() => assertAgentGraphModel({ ...model, edges }), /unknown node/);
});
