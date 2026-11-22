// D-413: general check that a read answer is about the question. Used to decide when the model's read-only plan should be asked before the router's
// answer stands. No phrase is listed: only the question's own words against the answer's own words.

const PARTICLES = /(?:이랑|하고|에서|으로|까지|부터|에게|한테|이나|이라|처럼|보다|은|는|이|가|을|를|에|의|도|만|로|랑|과|와|나|요|죠|지|냐|까|좀|야)$/u;
const ENDINGS = /(?:알려줘|알려주세요|알려|보여줘|보여주세요|보여|해줘|해주세요|해봐|줘|주세요|있어요|있나요|있어|있나|있지|없어|없나|어때|어떻게|어떤|어느|얼마나|얼마|몇|뭐야|뭐가|뭐|누구|누가|언제|어디|왜|좀|더|그|이|저|거|것|건|게|중에|중|하는|해서)$/u;
const STOP = new Set(['알려줘', '보여줘', '해줘', '얼마', '있어', '있나', '어때', '어떻게', '뭐야', '뭐가', '누구', '언제', '어디', '지금', '요즘', '최근', '이번', '그럼', '근데', '혹시', '아무', '말', '하는', '중에', '더']);
const spell = (text: string) => text.replace(/떼/gu, '테').normalize('NFC');

/** The words of a question that name what it is about (two letters or more, without particles, endings or asking words). */
export function contentWords(question: string): string[] {
  const words = spell(question).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(Boolean);
  const kept = words.map(word => word.replace(PARTICLES, '').replace(ENDINGS, '') || word)
    .map(word => (PARTICLES.test(word) && [...word].length > 2 ? word.replace(PARTICLES, '') : word))
    .filter(word => [...word].length >= 2 && !/^\d+$/u.test(word) && !STOP.has(word) && !ENDINGS.test(word) && !/^(?:알려|보여|해줘|줘)/u.test(word));
  return [...new Set(kept)];
}

// A question that asks for a name, a time or an amount is answered by that value ("캐모마일 티 87.9%"), which does not repeat the question's words.
const ASKS_FOR_VALUE = /뭐|무엇|누구|누가|어느|어떤|어디|언제|몇|얼마/u;

/** True when some line holds a content word of the question, or when there is nothing to compare (no content word, no line). */
export function mentionsQuestion(question: string, lines: readonly string[]): boolean {
  const words = contentWords(question);
  if (!words.length || !lines.length || ASKS_FOR_VALUE.test(question)) return true;
  const said = spell(lines.join(' '));
  return words.some(word => said.includes(word) || (word.length >= 3 && said.includes(word.slice(0, -1))));
}
