// One class as a Markdown file, to copy into Claude for review.
// Works with or without the after-class review (then the live captions are used).

import { formatDuration } from './text';
import type { ClassSession, Line, SessionReview } from './types';

const RULES = [
  '请用下面这节课的内容帮我复习，规则：',
  '1. 音标只用 IPA；',
  '2. 你用中文出题，我用英文回答；',
  '3. 我回答之前不要给提示；',
  '4. 答错（哪怕少一个词）就算没过，过一会儿重考；',
  '5. 同一题连续答对 3 次才算掌握。',
  '先从“老师的问题”和“我说错的句子”开始，再考生词。',
].join('\n');

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

export function classMarkdown(s: ClassSession, lines: Line[], r: SessionReview | null): string {
  const d = new Date(s.startedAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dur = s.endedAt ? formatDuration(s.endedAt - s.startedAt) : '';
  const out: string[] = [];
  out.push(`# ${s.school} 英语课 ${date}${s.topic ? ` · ${s.topic}` : ''}`, '');
  out.push(`- 时间：${date} ${time}${dur ? `，时长 ${dur}` : ''}`);
  out.push(`- 学校：${s.school}`);
  if (s.topic) out.push(`- 主题：${s.topic}`);
  out.push('', '> ' + RULES.split('\n').join('\n> '), '');

  if (r?.summaryZh) out.push('## 这节课讲了什么', '', r.summaryZh, '');

  // Questions: from the review if there is one, otherwise from the live captions.
  const liveQs = lines.filter((l) => l.kind === 'question' && l.en);
  if (r?.questions.length) {
    out.push('## 老师 / 同学的问题', '');
    r.questions.forEach((q, i) => {
      out.push(`${i + 1}. **${q.en}**（${q.asker === 'teacher' ? '老师' : '同学'}问：${q.zh}）`);
      q.answers.forEach((a) => out.push(`   - ${a.en} — ${a.zh}`));
    });
    out.push('');
  } else if (liveQs.length) {
    out.push('## 课上的问题', '');
    liveQs.forEach((q, i) => {
      const who = q.priority === 'you' ? '问我' : q.priority === 'other' ? '问同学' : '问大家';
      out.push(`${i + 1}. **${q.en}**（${who}：${q.questionZh ?? q.zh ?? ''}）`);
      (q.answers ?? []).forEach((a) => out.push(`   - ${a.en} — ${a.zh}`));
    });
    out.push('');
  }

  if (r?.myCorrections.length) {
    out.push('## 我说错的句子', '', '| 我说的 | 更好的说法 | 为什么 |', '| --- | --- | --- |');
    r.myCorrections.forEach((c) => out.push(`| ${cell(c.said)} | ${cell(c.better)} | ${cell(c.whyZh)} |`));
    out.push('');
  } else {
    const mine = lines.filter((l) => l.kind === 'self' && l.en);
    if (mine.length) {
      out.push('## 我在课上说的话', '');
      mine.forEach((l) => out.push(`- ${l.en}`));
      out.push('');
    }
  }

  if (r?.vocab.length) {
    out.push('## 生词', '', '| 单词 | IPA | 中文 | 例句 |', '| --- | --- | --- | --- |');
    r.vocab.forEach((v) => out.push(`| ${cell(v.en)} | ${cell(v.ipa)} | ${cell(v.zh)} | ${cell(v.example)} |`));
    out.push('');
  }

  if (r?.points.length) {
    out.push('## 语法和句型', '');
    r.points.forEach((p) => {
      out.push(`### ${p.title}`, '', p.detailZh);
      p.examples.forEach((e) => out.push(`- ${e}`));
      out.push('');
    });
  }

  if (r?.dialogues.length) {
    out.push('## 课上的对话', '');
    r.dialogues.forEach((dl) => {
      out.push(`### ${dl.titleZh}`, '');
      dl.turns.forEach((t) => out.push(`- **${t.speaker}**: ${t.en}${t.zh ? `（${t.zh}）` : ''}`));
      out.push('');
    });
  }

  out.push('## 完整记录', '');
  if (r?.transcript.length) {
    r.transcript.forEach((t) => out.push(t.speaker ? `- **${t.speaker}**: ${t.en}` : `- ${t.en}`));
  } else {
    const said = lines.filter((l) => l.en);
    if (!said.length) out.push('（没有记录）');
    said.forEach((l) => out.push(`- [${formatDuration(l.t)}] ${l.en}${l.zh ? ` — ${l.zh}` : ''}`));
  }
  out.push('');
  return out.join('\n');
}

/** File name like `ILA-2026-10-19-food.md`. */
export function classMarkdownName(s: ClassSession): string {
  const d = new Date(s.startedAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const topic = (s.topic || '').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30);
  return `${s.school.replace(/\s+/g, '')}-${date}${topic ? `-${topic}` : ''}.md`;
}
