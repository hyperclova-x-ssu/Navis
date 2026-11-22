// D-380: the model may write the answer sentences, but every number in them must come from the facts the app read.
// One guard shared by the server (before a sentence leaves) and the browser (before it is shown). It never repairs a number: a sentence
// that holds a number the facts do not hold, or a spelled-out count it cannot check, ends the answer there, and an answer with nothing left falls back
// to the fact lines the app already shows.

const NUMBER = /(?<![\p{L}\d])\d[\d,]*(?:\.\d+)?|(?<=\p{L})\d[\d,]*(?:\.\d+)?/gu;
// Counts and amounts spelled in words ("두 명", "세 잔", "삼만 원") cannot be checked against the facts, so they are not allowed.
const NATIVE_COUNT = /(?:(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|하나|둘|셋|넷)\s*(?:명|잔|개|건|곳|가지|분|장|번|사람|팀|군데|시간|종류|품목|메뉴|테이블)|하루|이틀|사흘|나흘|닷새|엿새|이레|여드레|아흐레|열흘)/u;
// A sentence that opens by leaning on one before it ("다만 …", "이 중 …", "따라서 …") is a fragment when that one is not there.
const DANGLING_START = /^(?:다만|그리고|또한|하지만|그러나|따라서|그래서|그러므로|즉|이\s*중|그\s*중|이는|이로|이때|이외|그\s*외)/u;
const SINO_AMOUNT = /[일이삼사오육칠팔구십]\s*(?:십|백|천|만|억)/u;

// A number belongs to what the sentence is about: when the sentence names the subject of one line ("카페라떼") and puts a number on it that only
// another line holds ("쿠키 세트 11,000원"), the sentence is about the first and the number is the second's. A sentence that names no subject of any
// line, or one that names a subject of the line holding the number, is left alone.
function numbersBelong(sentence, lines) {
  const said = spell(sentence);
  const names = line => subjectWords(line, lines).some(word => said.includes(word));
  return numbersIn(sentence).every(value => {
    const holders = lines.filter(line => numbersIn(line).includes(value));
    if (!holders.length) return true; // a number from the question itself
    if (holders.some(line => !subjectWords(line, lines).length || names(line))) return true;
    return !lines.some(line => !holders.includes(line) && names(line));
  });
}

/** Numeric values written in a text, in any common format ("481,220", "48.1", "08:00", "-24.9%", "11/18"). */
export function numbersIn(text) {
  const values = [];
  for (const match of String(text ?? '').matchAll(NUMBER)) {
    const value = Number(match[0].replaceAll(',', ''));
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

// A period word the facts and the question never used is a claim about another period ("어제보다" when the line says "비교 기간(11월 10일)").
// A single day the owner named ("내일", "어제") may come from the question or the turn before it; a range ("이번 주", "지난달", "올해") is a label
// the fact lines themselves must carry, or a last-7-days figure becomes "this week's" just because the owner said so.
const DAY_WORD = /그저께|그제|어제|어젯밤|내일|모레/gu;
const RANGE_WORD = /지난\s*주|저번\s*주|지난\s*달|저번\s*달|지난\s*해|작년|올해|이번\s*주|이번\s*달/gu;
const MAX_SENTENCES = 3;
// An answer that only says the facts were not there is no answer: the fact lines stay.
// "내용은 다음과 같아요." promises a list; the answer is only the lead-in once the list is gone.
const LEAD_IN = /(?:다음|아래)(?:과|와)?\s*같(?:아요|습니다|이)/u;
const GIVES_UP = /읽지\s*못|알\s*수\s*없|확인할\s*수\s*없|제공되지|확인되지\s*않|모르겠|정보가\s*없/u;
// A comparison is a claim only a number can back up here: "어제보다 적어요" with no figure is the model's own reading of the facts.
const COMPARATIVE = /보다|더\s|덜|많이|적게|늘|줄었|줄어|증가|감소|상승|하락|높|낮|올랐|내렸|떨어/u;
const MAX_ANSWER = 260;
// The words of a fact line that name its subject: Hangul or Latin words of two or more letters without digits, spelled alike for 떼/테. A word that more than
// half of the lines share ("가격", "매출") names no one subject. A sentence's number has to sit next to a word of the line that holds it.
const spell = text => String(text).replace(/떼/gu, '테');
const subjectWords = (line, lines) => {
  const words = [...new Set(spell(line).match(/[\p{L}]{2,}/gu) ?? [])].filter(word => !/\d/u.test(word));
  if (lines.length < 3) return words.filter(word => lines.some(other => other !== line) ? !lines.every(other => spell(other).includes(word)) : true);
  return words.filter(word => lines.filter(other => spell(other).includes(word)).length * 2 <= lines.length);
};
const squash = text => String(text).replace(/\s+/gu, '');

const sentencesOf = text => String(text).split(/(?<=[.!?。！？])\s+|\n+/u).map(part => part.trim()).filter(Boolean);

/**
 * @param {{ text: string, lines: readonly string[], used?: readonly number[], question?: string }} input
 * `lines` are the fact lines shown to the model; `used` the ones its answer relies on (default: all). Numbers the owner wrote in the question
 * are also allowed (for example "3개"). Returns the kept sentences, or null when nothing is left.
 */
export function guardAnswer({ text, lines, used, question = '', context = '' }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 1200 || /[{}`<>]|https?:/u.test(text)) return null;
  const chosen = Array.isArray(used) && used.length
    ? [...new Set(used)].filter(index => Number.isInteger(index) && index >= 0 && index < lines.length).map(index => lines[index]) : [...lines];
  if (!chosen.length) return null;
  const allowed = new Set([...numbersIn(chosen.join('\n')), ...numbersIn(question), 0]);
  const knownDays = squash(`${lines.join('\n')}\n${question}\n${context}`);
  const knownRanges = squash(lines.join('\n'));
  const passes = sentence => !DANGLING_START.test(sentence) && !LEAD_IN.test(sentence) && !NATIVE_COUNT.test(sentence) && !SINO_AMOUNT.test(sentence) && !GIVES_UP.test(sentence)
    && numbersIn(sentence).every(value => allowed.has(value)) && (!COMPARATIVE.test(sentence) || numbersIn(sentence).length > 0)
    && numbersBelong(sentence, lines)
    && [...sentence.matchAll(DAY_WORD)].every(([word]) => knownDays.includes(squash(word)))
    && [...sentence.matchAll(RANGE_WORD)].every(([word]) => knownRanges.includes(squash(word)));
  // One failing sentence spoils the whole answer: a later sentence may lean on it, a headline may be missing, and a list may be cut short.
  const sentences = sentencesOf(text);
  if (sentences.length > MAX_SENTENCES || !sentences.every(passes)) return null;
  const answer = sentences.join(' ').trim();
  return answer && answer.length <= MAX_ANSWER ? answer : null;
}

/**
 * Nothing is worded away: the answer carries a figure of every fact line that has one, so a tax, a person or a total the model left out
 * sends the owner back to the fact lines instead of to a shorter answer that looks complete. The model's own "used" list is not trusted here.
 */
export function coversLines(text, lines) {
  const written = new Set(numbersIn(text));
  return !lines.some(line => { const own = numbersIn(line); return own.length > 0 && !own.some(value => written.has(value)); });
}

/** The guard the composed answer goes through, on the server and again in the browser. */
export function guardComposed(input) {
  const text = guardAnswer(input);
  return text && coversLines(text, input.lines) ? text : null;
}
