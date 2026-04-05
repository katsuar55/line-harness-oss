import { Hono } from 'hono';
import {
  getAbTests,
  getAbTestById,
  createAbTest,
  updateAbTest,
  deleteAbTest,
} from '@line-crm/db';
import type { AbTest as DbAbTest, AbTestMessageType, AbTestTargetType } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { processAbTestSend, processAbTestWinnerSend, getAbTestStats } from '../services/ab-test.js';
import type { Env } from '../index.js';

const abTests = new Hono<Env>();

function serializeAbTest(row: DbAbTest) {
  return {
    id: row.id,
    title: row.title,
    variantA: {
      messageType: row.variant_a_message_type,
      messageContent: row.variant_a_message_content,
      altText: row.variant_a_alt_text,
    },
    variantB: {
      messageType: row.variant_b_message_type,
      messageContent: row.variant_b_message_content,
      altText: row.variant_b_alt_text,
    },
    targetType: row.target_type,
    targetTagId: row.target_tag_id,
    splitRatio: row.split_ratio,
    status: row.status,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    variantATotal: row.variant_a_total,
    variantASuccess: row.variant_a_success,
    variantBTotal: row.variant_b_total,
    variantBSuccess: row.variant_b_success,
    winner: row.winner,
    winnerTotal: row.winner_total,
    winnerSuccess: row.winner_success,
    lineAccountId: row.line_account_id,
    createdAt: row.created_at,
  };
}

// GET /api/ab-tests — list all
abTests.get('/api/ab-tests', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    let items: DbAbTest[];
    if (lineAccountId) {
      const result = await c.env.DB
        .prepare('SELECT * FROM ab_tests WHERE line_account_id = ? ORDER BY created_at DESC')
        .bind(lineAccountId)
        .all<DbAbTest>();
      items = result.results;
    } else {
      items = await getAbTests(c.env.DB);
    }
    return c.json({ success: true, data: items.map(serializeAbTest) });
  } catch (err) {
    console.error('GET /api/ab-tests error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/ab-tests/:id — get single
abTests.get('/api/ab-tests/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const abTest = await getAbTestById(c.env.DB, id);

    if (!abTest) {
      return c.json({ success: false, error: 'AB test not found' }, 404);
    }

    return c.json({ success: true, data: serializeAbTest(abTest) });
  } catch (err) {
    console.error('GET /api/ab-tests/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/ab-tests — create
abTests.post('/api/ab-tests', async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      variantA: { messageType: AbTestMessageType; messageContent: string; altText?: string };
      variantB: { messageType: AbTestMessageType; messageContent: string; altText?: string };
      targetType: AbTestTargetType;
      targetTagId?: string | null;
      splitRatio?: number;
      scheduledAt?: string | null;
      lineAccountId?: string | null;
    }>();

    // Validate required fields
    if (!body.title) {
      return c.json({ success: false, error: 'title is required' }, 400);
    }
    if (!body.variantA?.messageType || !body.variantA?.messageContent) {
      return c.json({ success: false, error: 'variantA.messageType and variantA.messageContent are required' }, 400);
    }
    if (!body.variantB?.messageType || !body.variantB?.messageContent) {
      return c.json({ success: false, error: 'variantB.messageType and variantB.messageContent are required' }, 400);
    }
    if (!body.targetType) {
      return c.json({ success: false, error: 'targetType is required' }, 400);
    }
    if (body.targetType === 'tag' && !body.targetTagId) {
      return c.json({ success: false, error: 'targetTagId is required when targetType is "tag"' }, 400);
    }
    if (body.splitRatio !== undefined && (body.splitRatio < 1 || body.splitRatio > 99)) {
      return c.json({ success: false, error: 'splitRatio must be between 1 and 99' }, 400);
    }

    const abTest = await createAbTest(c.env.DB, {
      title: body.title,
      variantA: {
        messageType: body.variantA.messageType,
        messageContent: body.variantA.messageContent,
        altText: body.variantA.altText ?? null,
      },
      variantB: {
        messageType: body.variantB.messageType,
        messageContent: body.variantB.messageContent,
        altText: body.variantB.altText ?? null,
      },
      targetType: body.targetType,
      targetTagId: body.targetTagId ?? null,
      splitRatio: body.splitRatio,
      scheduledAt: body.scheduledAt ?? null,
      lineAccountId: body.lineAccountId ?? null,
    });

    return c.json({ success: true, data: serializeAbTest(abTest) }, 201);
  } catch (err) {
    console.error('POST /api/ab-tests error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/ab-tests/:id — update draft/scheduled
abTests.put('/api/ab-tests/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getAbTestById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'AB test not found' }, 404);
    }

    if (existing.status !== 'draft' && existing.status !== 'scheduled') {
      return c.json({ success: false, error: 'Only draft or scheduled AB tests can be updated' }, 400);
    }

    const body = await c.req.json<{
      title?: string;
      variantA?: { messageType?: AbTestMessageType; messageContent?: string; altText?: string };
      variantB?: { messageType?: AbTestMessageType; messageContent?: string; altText?: string };
      targetType?: AbTestTargetType;
      targetTagId?: string | null;
      splitRatio?: number;
      scheduledAt?: string | null;
    }>();

    let statusUpdate: 'draft' | 'scheduled' | undefined;
    if (body.scheduledAt !== undefined) {
      statusUpdate = body.scheduledAt ? 'scheduled' : 'draft';
    }

    const updated = await updateAbTest(c.env.DB, id, {
      title: body.title,
      variant_a_message_type: body.variantA?.messageType,
      variant_a_message_content: body.variantA?.messageContent,
      variant_a_alt_text: body.variantA?.altText,
      variant_b_message_type: body.variantB?.messageType,
      variant_b_message_content: body.variantB?.messageContent,
      variant_b_alt_text: body.variantB?.altText,
      target_type: body.targetType,
      target_tag_id: body.targetTagId,
      split_ratio: body.splitRatio,
      scheduled_at: body.scheduledAt,
      ...(statusUpdate !== undefined ? { status: statusUpdate } : {}),
    });

    return c.json({ success: true, data: updated ? serializeAbTest(updated) : null });
  } catch (err) {
    console.error('PUT /api/ab-tests/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/ab-tests/:id — delete
abTests.delete('/api/ab-tests/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteAbTest(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/ab-tests/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/ab-tests/:id/send — send the A/B split now
abTests.post('/api/ab-tests/:id/send', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getAbTestById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'AB test not found' }, 404);
    }

    if (existing.status === 'sending' || existing.status === 'test_sent' || existing.status === 'winner_sent') {
      return c.json({ success: false, error: 'AB test is already sent or sending' }, 400);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await processAbTestSend(c.env.DB, lineClient, id, c.env.WORKER_URL);

    const result = await getAbTestById(c.env.DB, id);
    return c.json({ success: true, data: result ? serializeAbTest(result) : null });
  } catch (err) {
    console.error('POST /api/ab-tests/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/ab-tests/:id/stats — get click/delivery stats
abTests.post('/api/ab-tests/:id/stats', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getAbTestById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'AB test not found' }, 404);
    }

    const stats = await getAbTestStats(c.env.DB, id);
    return c.json({ success: true, data: stats });
  } catch (err) {
    console.error('POST /api/ab-tests/:id/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/ab-tests/:id/send-winner — send winning variant to remaining users
abTests.post('/api/ab-tests/:id/send-winner', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getAbTestById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'AB test not found' }, 404);
    }

    if (existing.status !== 'test_sent') {
      return c.json({ success: false, error: 'AB test must be in test_sent status to send winner' }, 400);
    }

    const body = await c.req.json<{ winner: 'A' | 'B' }>();
    if (body.winner !== 'A' && body.winner !== 'B') {
      return c.json({ success: false, error: 'winner must be "A" or "B"' }, 400);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await processAbTestWinnerSend(c.env.DB, lineClient, id, body.winner, c.env.WORKER_URL);

    const result = await getAbTestById(c.env.DB, id);
    return c.json({ success: true, data: result ? serializeAbTest(result) : null });
  } catch (err) {
    console.error('POST /api/ab-tests/:id/send-winner error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { abTests };
