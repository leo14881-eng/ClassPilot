// Fake AI provider for the browser smoke test (node --import scripts/e2e/stub-ai.mjs dist-server/server.mjs).
// Answers like a real but sloppy model: reviews miss fields, so screens must cope with incomplete data.
const real = globalThis.fetch;
let n = 0;
const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
const reply = (o) => json({ choices: [{ message: { content: JSON.stringify(o) } }] });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/audio/transcriptions')) return json({ text: `What color are your eyes, Kevin? Sentence ${++n}.` });
  if (u.includes('/credits')) return json({ data: { total_credits: 10, total_usage: 1 } });
  if (!u.includes('/chat/completions')) return real(url, init);
  const body = JSON.parse(String(init?.body ?? '{}'));
  const system = body.messages?.[0]?.content ?? '';
  if (system.includes('turning a recorded class'))
    return reply({ summaryZh: '身体部位', questions: [{ asker: 'teacher', en: 'What color are your eyes?', zh: '你眼睛什么颜色？' }, { en: 'Do you have a beard?' }], points: [{ title: 'have got' }], vocab: [{ en: 'beard' }, { en: 'eyelash', ipa: 'ˈaɪlæʃ', zh: '睫毛' }], dialogues: [{ titleZh: '外貌' }], myCorrections: [{ said: 'I lash' }] });
  if (system.includes('live English class') || system.includes('small-group'))
    return reply({ zh: '你眼睛什么颜色？', isQuestion: true, target: 'you', questionZh: '老师问你眼睛的颜色', answers: [{ en: 'My eyes are brown.', zh: '我的眼睛是棕色的。' }] });
  return reply({});
};
