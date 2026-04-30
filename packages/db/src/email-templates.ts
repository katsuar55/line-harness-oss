/**
 * email_templates CRUD (Round 4 PR-2)
 */

import { jstNow } from './utils.js';

export interface EmailTemplate {
  id: string;
  name: string;
  category: string;
  subject: string;
  html_content: string;
  text_content: string;
  preheader: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertEmailTemplateInput {
  id?: string;
  name: string;
  category?: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  preheader?: string;
  isActive?: boolean;
}

export async function getEmailTemplateById(
  db: D1Database,
  id: string,
): Promise<EmailTemplate | null> {
  return await db
    .prepare(`SELECT * FROM email_templates WHERE id = ?`)
    .bind(id)
    .first<EmailTemplate>();
}

export async function listEmailTemplates(
  db: D1Database,
  filter: { category?: string; activeOnly?: boolean } = {},
): Promise<EmailTemplate[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.category) {
    where.push('category = ?');
    params.push(filter.category);
  }
  if (filter.activeOnly) {
    where.push('is_active = 1');
  }
  const sql = `SELECT * FROM email_templates ${
    where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''
  } ORDER BY updated_at DESC`;
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<EmailTemplate>();
  return result.results ?? [];
}

export async function upsertEmailTemplate(
  db: D1Database,
  input: UpsertEmailTemplateInput,
): Promise<EmailTemplate> {
  const id = input.id ?? crypto.randomUUID();
  const now = jstNow();
  const isActive = input.isActive === false ? 0 : 1;

  const existing = input.id ? await getEmailTemplateById(db, id) : null;
  if (existing) {
    await db
      .prepare(
        `UPDATE email_templates
            SET name = ?, category = ?, subject = ?, html_content = ?,
                text_content = ?, preheader = ?, is_active = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        input.name,
        input.category ?? 'general',
        input.subject,
        input.htmlContent,
        input.textContent,
        input.preheader ?? null,
        isActive,
        now,
        id,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO email_templates
            (id, name, category, subject, html_content, text_content,
             preheader, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.name,
        input.category ?? 'general',
        input.subject,
        input.htmlContent,
        input.textContent,
        input.preheader ?? null,
        isActive,
        now,
        now,
      )
      .run();
  }
  return (await getEmailTemplateById(db, id)) as EmailTemplate;
}

export async function deleteEmailTemplate(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM email_templates WHERE id = ?`)
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
