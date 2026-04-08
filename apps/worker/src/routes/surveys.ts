import { Hono } from 'hono';
import {
  createSurvey,
  updateSurvey,
  getSurveys,
  getSurveyById,
  deleteSurvey,
  getDeliveryTargets,
  recordSurveyDelivery,
  incrementSurveySentCount,
  getSurveyResponses,
  getSurveyStats,
} from '@line-crm/db';
import type { SurveyQuestion } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { flexMessage } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

const surveys = new Hono<Env>();

const MULTICAST_BATCH_SIZE = 500;

// ─── Survey Template CRUD ───

/**
 * GET /api/surveys — アンケート一覧取得
 */
surveys.get('/api/surveys', async (c) => {
  try {
    const status = c.req.query('status') || undefined;
    const survey_type = c.req.query('type') || undefined;
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 20), 100);
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);

    const result = await getSurveys(c.env.DB, { status, survey_type, limit, offset });

    return c.json({
      success: true,
      data: {
        surveys: result.surveys.map((s) => ({
          ...s,
          questions: JSON.parse(s.questions),
        })),
        total: result.total,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('GET /api/surveys error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/surveys/:id — アンケート詳細取得
 */
surveys.get('/api/surveys/:id', async (c) => {
  try {
    const survey = await getSurveyById(c.env.DB, c.req.param('id'));
    if (!survey) return c.json({ success: false, error: 'Not found' }, 404);

    return c.json({
      success: true,
      data: { ...survey, questions: JSON.parse(survey.questions) },
    });
  } catch (err) {
    console.error('GET /api/surveys/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/surveys — アンケート作成
 */
surveys.post('/api/surveys', async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      description?: string;
      survey_type?: string;
      questions: SurveyQuestion[];
      target_tier?: string;
    }>();

    if (!body.title || body.title.length > 200) {
      return c.json({ success: false, error: 'title is required (max 200 chars)' }, 400);
    }
    if (!Array.isArray(body.questions) || body.questions.length === 0) {
      return c.json({ success: false, error: 'questions array is required (min 1)' }, 400);
    }
    if (body.questions.length > 20) {
      return c.json({ success: false, error: 'Maximum 20 questions per survey' }, 400);
    }

    const validTypes = ['survey', 'product_test', 'nps'];
    if (body.survey_type && !validTypes.includes(body.survey_type)) {
      return c.json({ success: false, error: `survey_type must be one of: ${validTypes.join(', ')}` }, 400);
    }

    const validTiers = ['all', 'standard', 'premium'];
    if (body.target_tier && !validTiers.includes(body.target_tier)) {
      return c.json({ success: false, error: `target_tier must be one of: ${validTiers.join(', ')}` }, 400);
    }

    // Validate each question
    const validQTypes = ['rating', 'text', 'choice', 'multi_choice'];
    for (const q of body.questions) {
      if (!q.id || !q.type || !q.label) {
        return c.json({ success: false, error: 'Each question needs id, type, and label' }, 400);
      }
      if (!validQTypes.includes(q.type)) {
        return c.json({ success: false, error: `Question type must be one of: ${validQTypes.join(', ')}` }, 400);
      }
      if ((q.type === 'choice' || q.type === 'multi_choice') && (!Array.isArray(q.options) || q.options.length === 0)) {
        return c.json({ success: false, error: `Question "${q.id}" requires options array` }, 400);
      }
    }

    const result = await createSurvey(c.env.DB, {
      title: body.title,
      description: body.description,
      survey_type: body.survey_type,
      questions: body.questions,
      target_tier: body.target_tier,
    });

    return c.json({ success: true, data: result }, 201);
  } catch (err) {
    console.error('POST /api/surveys error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/surveys/:id — アンケート更新
 */
surveys.put('/api/surveys/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getSurveyById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    const body = await c.req.json<{
      title?: string;
      description?: string;
      questions?: SurveyQuestion[];
      target_tier?: string;
      status?: string;
    }>();

    if (body.title !== undefined && (body.title.length === 0 || body.title.length > 200)) {
      return c.json({ success: false, error: 'title must be 1-200 chars' }, 400);
    }

    const validStatuses = ['draft', 'active', 'closed', 'archived'];
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ success: false, error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
    }

    await updateSurvey(c.env.DB, id, body);
    return c.json({ success: true, data: { id } });
  } catch (err) {
    console.error('PUT /api/surveys/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /api/surveys/:id — アンケート削除
 */
surveys.delete('/api/surveys/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getSurveyById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    if (existing.response_count > 0) {
      return c.json({ success: false, error: 'Cannot delete survey with responses. Archive instead.' }, 400);
    }

    await deleteSurvey(c.env.DB, id);
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/surveys/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Survey Delivery (Flex Message) ───

/**
 * POST /api/surveys/:id/send — アンケートをアンバサダーに配信
 */
surveys.post('/api/surveys/:id/send', async (c) => {
  try {
    const id = c.req.param('id');
    const survey = await getSurveyById(c.env.DB, id);
    if (!survey) return c.json({ success: false, error: 'Not found' }, 404);

    if (survey.status !== 'active') {
      return c.json({ success: false, error: 'Survey must be active to send. Update status to "active" first.' }, 400);
    }

    const targets = await getDeliveryTargets(c.env.DB, id, survey.target_tier);
    if (targets.length === 0) {
      return c.json({ success: true, data: { sent: 0, message: 'No eligible ambassadors found (all already received or none active)' } });
    }

    // Build Flex Message for survey
    const liffUrl = c.env.LIFF_URL || '';
    const surveyFlexMsg = buildSurveyFlexMessage(survey.title, survey.description || '', survey.survey_type, liffUrl);

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    let sentCount = 0;

    // Send in batches of 500
    for (let i = 0; i < targets.length; i += MULTICAST_BATCH_SIZE) {
      const batch = targets.slice(i, i + MULTICAST_BATCH_SIZE);
      const lineUserIds = batch.map((t) => t.line_user_id).filter(Boolean);

      if (lineUserIds.length > 0) {
        await lineClient.multicast(lineUserIds, [surveyFlexMsg]);
      }

      // Record deliveries
      for (const target of batch) {
        await recordSurveyDelivery(c.env.DB, id, target.ambassador_id, target.friend_id);
      }
      sentCount += batch.length;
    }

    await incrementSurveySentCount(c.env.DB, id, sentCount);

    return c.json({ success: true, data: { sent: sentCount } });
  } catch (err) {
    console.error('POST /api/surveys/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Survey Responses & Stats ───

/**
 * GET /api/surveys/:id/responses — 回答一覧取得
 */
surveys.get('/api/surveys/:id/responses', async (c) => {
  try {
    const id = c.req.param('id');
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 50), 100);
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);

    const result = await getSurveyResponses(c.env.DB, id, limit, offset);
    return c.json({
      success: true,
      data: {
        responses: result.responses.map((r) => ({
          ...r,
          answers: JSON.parse(r.answers),
        })),
        total: result.total,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('GET /api/surveys/:id/responses error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/surveys/:id/stats — 統計取得
 */
surveys.get('/api/surveys/:id/stats', async (c) => {
  try {
    const stats = await getSurveyStats(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: stats });
  } catch (err) {
    console.error('GET /api/surveys/:id/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Flex Message Builder ───

function buildSurveyFlexMessage(
  title: string,
  description: string,
  surveyType: string,
  liffUrl: string,
): ReturnType<typeof flexMessage> {
  const typeLabel = surveyType === 'product_test' ? '商品テスト' : surveyType === 'nps' ? '満足度調査' : 'アンケート';
  const typeColor = surveyType === 'product_test' ? '#FF6B6B' : surveyType === 'nps' ? '#4ECDC4' : '#667EEA';

  return flexMessage(`【${typeLabel}】${title}`, {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'text',
              text: typeLabel,
              size: 'xs',
              color: '#FFFFFF',
              weight: 'bold',
            },
          ],
          backgroundColor: typeColor,
          cornerRadius: 'md',
          paddingAll: '4px',
          paddingStart: '8px',
          paddingEnd: '8px',
          width: surveyType === 'product_test' ? '80px' : '76px',
        },
      ],
      backgroundColor: '#F8F9FA',
      paddingAll: '16px',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: title,
          weight: 'bold',
          size: 'lg',
          wrap: true,
        },
        {
          type: 'text',
          text: description || 'ご協力をお願いいたします',
          size: 'sm',
          color: '#666666',
          wrap: true,
          margin: 'md',
        },
        {
          type: 'separator',
          margin: 'lg',
        },
        {
          type: 'text',
          text: '⏱ 所要時間: 約2分',
          size: 'xs',
          color: '#999999',
          margin: 'md',
        },
      ],
      paddingAll: '16px',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          action: {
            type: 'uri',
            label: '回答する',
            uri: `${liffUrl}?tab=mypage`,
          },
          style: 'primary',
          color: typeColor,
        },
      ],
      paddingAll: '16px',
    },
  } as unknown as import('@line-crm/line-sdk').FlexContainer);
}

export { surveys };
