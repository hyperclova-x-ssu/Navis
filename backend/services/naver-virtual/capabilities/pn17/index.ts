import type { PersonaCapability } from '../../app.ts';
import { digest, oauthAccess } from '../pn11/oauth.ts';
import type { CafeArticleResponse } from '../../../../packages/naver/contracts/pn17/index.ts';
import type { PoolClient } from 'pg';

const clubId = '10000001';
const menuId = '1';
const cafeUrl = 'navis-ansungjalbu-fixture';

function decodeForm(body: unknown) {
  if (typeof body !== 'string') return;
  const params = new URLSearchParams(body);
  const subject = params.get('subject');
  const content = params.get('content');
  if (params.size !== 2 || !subject || !content) return;
  try {
    const title = decodeURIComponent(subject.replaceAll('+', ' '));
    const text = decodeURIComponent(content.replaceAll('+', ' '));
    if (title.trim() && text.trim() && !title.includes('\0') && !text.includes('\0')) {
      return { subject: title, content: text };
    }
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
}

export const personaCapability: PersonaCapability = {
  id: 'pn17',
  migrations: [{
    id: 'pn17-cafe-001',
    up: `
      CREATE TABLE naver_virtual.pn17_article (
        account_id text NOT NULL, article_id integer GENERATED ALWAYS AS IDENTITY,
        subject text NOT NULL, content text NOT NULL, published_at timestamptz NOT NULL,
        PRIMARY KEY (account_id, article_id)
      );
      ALTER TABLE naver_virtual.pn17_article ENABLE ROW LEVEL SECURITY;
      CREATE POLICY account_scope ON naver_virtual.pn17_article
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      GRANT SELECT, INSERT ON naver_virtual.pn17_article TO nvirtual_run;
    `,
    down: 'DROP TABLE naver_virtual.pn17_article;',
  }],
  async seed(client, { accountId, previousGeneration }) {
    if (previousGeneration) await client.query('DELETE FROM naver_virtual.pn17_article WHERE account_id = $1', [accountId]);
  },
  register(app, context) {
    app.register(async (forms) => {
      forms.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, payload, done) => {
        done(null, payload);
      });
      // https://developers.naver.com/docs/login/cafe-api/cafe-api.md
      forms.post<{ Params: { clubid: string; menuid: string } }>('/v1/cafe/:clubid/menu/:menuid/articles', {
        config: { personaOperation: 'pn17.article.create' },
        bodyLimit: 128 * 1024,
      }, async (request, reply) => {
        const access = await oauthAccess(request, context, 'cafe');
        if (access === 'missing' || access === 'invalid') {
          return reply.code(401).send({ errorCode: access === 'missing' ? '028' : '024',
            errorMessage: access === 'missing' ? 'Authentication header not exists' : 'Authentication failed' });
        }
        const meta = {
          '@type': 'response', '@service': 'korea.naverkoreaservice.community.cafe', '@version': '1.0.0',
        } as const;
        if (access === 'forbidden' || request.params.clubid !== clubId || request.params.menuid !== menuId) {
          // Café API §5 403/0005. The table's "(비공개 카페 접근시)" states when it occurs, so it is not part of `msg`.
          return reply.code(403).send({ message: { ...meta, status: '403', error: { code: '0005', msg: '접속하신 카페는 카페 멤버만 들어가실 수 있습니다.' } } });
        }
        const article = decodeForm(request.body);
        if (!article) return reply.code(400).send({ errorCode: '400', errorMessage: 'Bad Request' });
        const fingerprint = digest(JSON.stringify([clubId, menuId, article.subject, article.content]));
        const insert = async (client: PoolClient) => {
          const { rows } = await client.query<{ article_id: number }>(`
            INSERT INTO naver_virtual.pn17_article (account_id, subject, content, published_at)
            VALUES ($1, $2, $3, $4) RETURNING article_id
          `, [context.accountId(request), article.subject, article.content, context.now()]);
          return String(rows[0]!.article_id);
        };
        const articleId = Number(request.headers['idempotency-key'] === undefined
          ? await context.transaction(request, insert)
          : (await context.effect(request, fingerprint, insert)).ref);
        const result: CafeArticleResponse = { ...meta, status: '200',
          result: { msg: 'Success', cafeUrl, articleId, articleUrl: `https://cafe.naver.com/${cafeUrl}/${articleId}` } };
        return { message: result };
      });
    });
  },
};
