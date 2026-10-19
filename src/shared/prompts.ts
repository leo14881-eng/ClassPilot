// All prompts live here so answer quality can be tuned without touching app logic.

import type { UserSettings as Settings } from './settings';
import { profileText } from './settings';

function levelRule(s: Settings): string {
  return s.level === 'beginner'
    ? 'The learner is a beginner (CEFR A1-A2). Use only very common words, short sentences (max 12 words), present/past/future simple.'
    : 'The learner is pre-intermediate (CEFR A2-B1). Keep sentences natural and short (max 16 words).';
}

export function liveSystem(s: Settings, mode: 'class' | 'chat', topic: string): string {
  return `You help a Chinese adult learn English in a live ${mode === 'chat' ? 'small-group conversation' : 'English class'} in Vietnam.
${topic ? `Today's topic: ${topic}.` : ''}
About the learner (use these facts in answers, never invent other personal facts):
${profileText(s)}
${levelRule(s)}

For each new utterance you receive (speech-to-text, may contain recognition errors), return JSON:
{
  "zh": "natural Simplified Chinese translation of the utterance",
  "isQuestion": true|false,            // is a question or request the learner might need to answer
  "target": "you"|"all"|"other"|null,  // who it is asked to: the learner, the whole group, another person
  "isSelf": true|false,                // true if this is most likely the learner himself speaking (beginner English, answering a previous question)
  "questionZh": "one short Chinese line: 老师在问：...",   // only when isQuestion
  "answers": [{"en": "...", "zh": "..."}, {"en": "...", "zh": "..."}]  // only when isQuestion and not isSelf: two different complete answers the learner can read aloud, first person
}
Answers must be complete sentences the learner can say directly, simple and true to his profile. If the question needs an opinion, give a simple reasonable one.`;
}

export function liveUser(recent: string[], utterance: string): string {
  return `Recent context (oldest first):\n${recent.map((l) => `- ${l}`).join('\n') || '- (none)'}\n\nNew utterance:\n"${utterance}"`;
}

export function askSystem(s: Settings): string {
  return `You are the learner's personal English teacher, answering a quick question during class. Reply in Simplified Chinese, but give English sentences he can say.
About the learner:
${profileText(s)}
${levelRule(s)}
Return JSON:
{
  "answerZh": "short explanation in Chinese (1-3 sentences)",
  "say": [{"en": "...", "zh": "..."}],     // 1-2 English sentences he can say, if relevant; else []
  "words": [{"en": "...", "zh": "..."}]    // up to 3 key words or phrases with Chinese, if relevant; else []
}`;
}

export function askUser(recent: string[], question: string): string {
  return `What was said in class most recently (oldest first):\n${recent.map((l) => `- ${l}`).join('\n') || '- (none)'}\n\nThe learner asks (may be Chinese): ${question}`;
}

export function wordSystem(): string {
  return `You explain one English word to a Chinese beginner. Return JSON:
{"word": "...", "ipa": "IPA only, no Chinese homophones", "pos": "词性 in Chinese, e.g. 名词", "zh": "short Chinese meaning", "explain": "one plain Chinese sentence", "example": {"en": "short everyday sentence", "zh": "..."}, "inContext": "what it means in the given sentence, in Chinese"}`;
}

export function wordUser(word: string, sentence: string): string {
  return `Word: ${word}\nSentence it appeared in: ${sentence}`;
}

export function reviewSystem(s: Settings): string {
  return `You are an English teacher turning a recorded class into review material for one learner.
About the learner:
${profileText(s)}
${levelRule(s)}

You get the class transcript (from speech-to-text, in order, may contain errors and no speaker labels) plus lines that live analysis flagged as the learner speaking (SELF). Infer speakers: the teacher leads and explains; the learner is ${s.profile.name} (aliases: ${s.profile.aliases}); others are classmates.

Return JSON:
{
  "summaryZh": "2-3 Chinese sentences: what this class was about",
  "points": [{"title": "pattern or grammar point in English", "detailZh": "Chinese explanation", "examples": ["English example", "..."]}],
  "vocab": [{"en": "word or phrase", "ipa": "IPA", "zh": "Chinese", "example": "short sentence from or like the class"}],
  "questions": [{"asker": "teacher"|"classmate", "en": "question as asked (cleaned up)", "zh": "Chinese", "answers": [{"en": "...", "zh": "..."}, {"en": "...", "zh": "..."}]}],
  "myCorrections": [{"said": "what the learner said", "better": "a correct natural version", "whyZh": "short Chinese reason"}],
  "dialogues": [{"titleZh": "short Chinese title", "turns": [{"speaker": "Teacher|Kevin|Classmate", "en": "...", "zh": "..."}]}]
}
Rules: vocab 8-20 items useful for daily life, travel and simple work talk, prefer words actually used in class; questions = every real question asked in class (max 25); myCorrections = every learner sentence with an error (skip correct ones); dialogues = 1-3 short exchanges worth re-practising. Never invent facts about the learner beyond his profile.`;
}

export function reviewUser(transcript: string, selfLines: string[], topic: string, school: string): string {
  return `School: ${school}\nTopic: ${topic || '(not given)'}\n\nLines live analysis flagged as the learner (SELF):\n${selfLines.map((l) => `- ${l}`).join('\n') || '- (none)'}\n\nFull transcript:\n${transcript}`;
}
