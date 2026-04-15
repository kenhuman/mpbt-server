/**
 * Article/news data-access helpers.
 */

import { pool } from './client.js';

export interface ArticleRow {
  id: number;
  slug: string;
  title: string;
  summary: string;
  body: string;
  author_id: number | null;
  published: boolean;
  published_at: Date;
  created_at: Date;
}

const ARTICLE_SELECT = `
  SELECT id, slug, title, summary, body, author_id, published, published_at, created_at
  FROM articles
`;

export async function fetchLatestPublishedArticle(): Promise<ArticleRow | null> {
  const res = await pool.query<ArticleRow>(
    `${ARTICLE_SELECT}
     WHERE published = TRUE
     ORDER BY published_at DESC, id DESC
     LIMIT 1`,
  );
  return res.rows[0] ?? null;
}

export async function fetchLatestPublishedArticleForTerm(term: string): Promise<ArticleRow | null> {
  const res = await pool.query<ArticleRow>(
    `${ARTICLE_SELECT}
     WHERE published = TRUE
       AND lower(title || ' ' || summary || ' ' || body) LIKE lower($1)
     ORDER BY published_at DESC, id DESC
     LIMIT 1`,
    [`%${term}%`],
  );
  return res.rows[0] ?? null;
}

export async function listLatestPublishedArticles(limit: number): Promise<ArticleRow[]> {
  const safeLimit = Math.max(1, Math.min(20, limit));
  const res = await pool.query<ArticleRow>(
    `${ARTICLE_SELECT}
     WHERE published = TRUE
     ORDER BY published_at DESC, id DESC
     LIMIT $1`,
    [safeLimit],
  );
  return res.rows;
}

export async function fetchPublishedArticleById(id: number): Promise<ArticleRow | null> {
  const res = await pool.query<ArticleRow>(
    `${ARTICLE_SELECT}
     WHERE id = $1 AND published = TRUE
     LIMIT 1`,
    [id],
  );
  return res.rows[0] ?? null;
}
