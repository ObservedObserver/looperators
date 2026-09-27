// Optional presentation metadata. Council completion never depends on parsing prose.
export type CouncilBrief = {
  summary: string;
  decisions: { title: string; reason: string; evidence: string }[];
  openQuestions: { question: string; whyItMatters: string }[];
};

const briefBlock = /```council-brief\s*\n([\s\S]*?)\n```/g;
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function parseCouncilBrief(content: string): CouncilBrief | undefined {
  const blocks = [...content.matchAll(briefBlock)];
  if (blocks.length !== 1 || blocks[0][1].length > 16000) return undefined;
  try {
    const value = JSON.parse(blocks[0][1]);
    if (!value || !text(value.summary, 1800) || !Array.isArray(value.decisions) || !Array.isArray(value.openQuestions)) return undefined;
    if (value.decisions.length > 8 || value.openQuestions.length > 8) return undefined;
    if (
      !value.decisions.every((item: CouncilBrief['decisions'][number]) => item && text(item.title, 300) && text(item.reason, 1800) && text(item.evidence, 1000))
    )
      return undefined;
    if (!value.openQuestions.every((item: CouncilBrief['openQuestions'][number]) => item && text(item.question, 600) && text(item.whyItMatters, 1000)))
      return undefined;
    return {
      summary: value.summary,
      decisions: value.decisions.map(({ title, reason, evidence }: CouncilBrief['decisions'][number]) => ({ title, reason, evidence })),
      openQuestions: value.openQuestions.map(({ question, whyItMatters }: CouncilBrief['openQuestions'][number]) => ({ question, whyItMatters })),
    };
  } catch {
    return undefined;
  }
}

export function councilReadableContent(content: string) {
  return parseCouncilBrief(content) ? content.replace(briefBlock, '').trim() : content;
}

export const councilBriefInstruction = [
  'After the final plan, append one fenced council-brief block containing valid JSON:',
  '{"summary":"short recommendation","decisions":[{"title":"decision","reason":"why and rejected alternative","evidence":"specific proposal, review, or file citation"}],"openQuestions":[{"question":"unresolved question","whyItMatters":"impact and evidence still needed"}]}',
  'Use at most 6 decisions and 6 open questions. Do not invent consensus or evidence. Retain material dissent and distinguish verified facts from assumptions. If nothing is unresolved, use an empty openQuestions array. This is a reading aid, not a completion verdict.',
].join('\n');
