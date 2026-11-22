import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const model = 'claude-opus-5-5';
const target = fileURLToPath(new URL('./trend-dictionary.json', import.meta.url));
const groups = ['coffee', 'non-coffee', 'tea', 'bakery', 'dessert', 'cafe-occasion'];
const validVersion = /^\d{4}-(0[1-9]|1[0-2])$/u;

function validate(draft, version) {
  if (draft?.version !== version || !Array.isArray(draft.entries) || draft.entries.length < 60 || draft.entries.length > 80) {
    throw new Error('Expected 60–80 entries and the requested dictionary version');
  }
  const ids = new Set(), keywords = new Set();
  for (const entry of draft.entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'group,id,keyword,months' ||
      typeof entry.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id) || entry.id.length > 40 || ids.has(entry.id) ||
      typeof entry.keyword !== 'string' || entry.keyword.trim() !== entry.keyword || !/[가-힣]/u.test(entry.keyword) ||
      /[\p{Cc}<>]/u.test(entry.keyword) || entry.keyword.length > 35 || !groups.includes(entry.group) ||
      /만들|레시피|굽는\s*법|홈카페|원두\s*추천|효능/u.test(entry.keyword) ||
      !Array.isArray(entry.months) || entry.months.some((month, index, months) => !Number.isInteger(month) || month < 1 || month > 12 ||
      index > 0 && months[index - 1] >= month)) throw new Error('Invalid dictionary entry');
    const keyword = entry.keyword.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
    if (keywords.has(keyword)) throw new Error('Duplicate dictionary keyword');
    keywords.add(keyword);
    ids.add(entry.id);
  }
  if (!groups.every(group => draft.entries.some(entry => entry.group === group)) || !Array.from({ length: 12 }, (_, index) => index + 1)
    .every(month => draft.entries.some(entry => entry.months.includes(month)))) throw new Error('Missing dictionary category or calendar month');
}

const [version, option, input] = process.argv.slice(2);
if (!validVersion.test(version ?? '') || (option !== undefined && (option !== '--from' || !input)) || process.argv.length > 5) {
  throw new Error('Usage: node refresh-trend-dictionary.mjs YYYY-MM [--from CLAUDE_JSON]');
}
let previous;
try { previous = JSON.parse(readFileSync(target, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous && version < previous.version) throw new Error('Dictionary version cannot go backwards');

const prompt = `Author the ${version} edition of the offline keyword dictionary for Korean café owners. Output only a JSON object with version and entries. Create 72 plausible short Korean search phrases covering evergreen and seasonal café demand across all calendar months. Each entry has only id (stable descriptive kebab-case ASCII, max 40 chars), keyword (Korean, max 35 chars), group (one of ${groups.join(', ')}), and months (distinct increasing integers 1–12, [] for evergreen). Include at least 20 evergreen terms and at least five seasonal entries per calendar month. Include drinks, pastries, desserts and café occasions. Focus on what a customer orders or does at a café. Exclude home recipes, cooking instructions, home café, recommendations for beans to brew, claims about health benefits, trending claims, brands, celebrity or news topics, and location or shop names. Use no tools, internet searches or external data. Preserve prior IDs for unchanged keywords. Previous dictionary editorial input only: ${JSON.stringify(previous?.entries ?? [])}`;
const run = option === '--from' ? { status: 0, stdout: readFileSync(input, 'utf8') } : spawnSync('claude', [
  '-p', '--model', model, '--safe-mode', '--restricted', '--tools', '', '--no-session-persistence', '--max-turns', '1', '--output-format', 'json',
], { input: prompt, cwd: tmpdir(), encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 180_000 });
if (run.status !== 0) throw new Error('Claude dictionary authoring failed');
const response = JSON.parse(run.stdout);
if (response.is_error || typeof response.result !== 'string' || !Object.hasOwn(response.modelUsage ?? {}, model)) {
  throw new Error('The output does not identify successful claude-opus-5-5 authorship');
}
const draft = JSON.parse(response.result.trim().replace(/^```(?:json)?\s*|\s*```$/gu, ''));
validate(draft, version);
const previousIds = new Map(previous?.entries.map(entry => [entry.keyword, entry.id]) ?? []);
if (draft.entries.some(entry => previousIds.has(entry.keyword) && previousIds.get(entry.keyword) !== entry.id)) {
  throw new Error('An existing keyword ID changed');
}
const temporary = `${target}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify({ version, author: model, entries: draft.entries }, null, 2) + '\n', { flag: 'wx' });
renameSync(temporary, target);
console.log(`Validated ${draft.entries.length} keywords for ${version} from ${model}`);
