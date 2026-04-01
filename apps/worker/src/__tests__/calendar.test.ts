/**
 * Tests for Google Calendar integration routes.
 *
 * Covers:
 *   1. GET  /api/integrations/google-calendar           — list connections
 *   2. POST /api/integrations/google-calendar/connect    — create connection
 *   3. DELETE /api/integrations/google-calendar/:id      — delete connection
 *   4. GET  /api/integrations/google-calendar/slots      — get available slots
 *   5. GET  /api/integrations/google-calendar/bookings   — list bookings
 *   6. POST /api/integrations/google-calendar/book       — create booking
 *   7. PUT  /api/integrations/google-calendar/bookings/:id/status — update status
 *   8. Auth: 401 without Bearer token
 *   9. Error handling: 500 on DB failures
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function makeConnection(overrides: Partial<{
  id: string;
  calendar_id: string;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  auth_type: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    id: 'conn-1',
    calendar_id: 'cal@example.com',
    access_token: null,
    refresh_token: null,
    api_key: null,
    auth_type: 'api_key',
    is_active: 1,
    created_at: '2025-01-01T00:00:00',
    updated_at: '2025-01-01T00:00:00',
    ...overrides,
  };
}

function makeBooking(overrides: Partial<{
  id: string;
  connection_id: string;
  friend_id: string | null;
  event_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    id: 'bk-1',
    connection_id: 'conn-1',
    friend_id: null,
    event_id: null,
    title: 'Test Booking',
    start_at: '2025-06-01T10:00:00',
    end_at: '2025-06-01T11:00:00',
    status: 'confirmed',
    metadata: null,
    created_at: '2025-01-01T00:00:00',
    updated_at: '2025-01-01T00:00:00',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

const mockGetCalendarConnections = vi.fn();
const mockGetCalendarConnectionById = vi.fn();
const mockCreateCalendarConnection = vi.fn();
const mockDeleteCalendarConnection = vi.fn();
const mockGetCalendarBookings = vi.fn();
const mockGetCalendarBookingById = vi.fn();
const mockCreateCalendarBooking = vi.fn();
const mockUpdateCalendarBookingStatus = vi.fn();
const mockUpdateCalendarBookingEventId = vi.fn();
const mockGetBookingsInRange = vi.fn();
const mockToJstString = vi.fn((d: Date) => d.toISOString());

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getCalendarConnections: (...args: unknown[]) => mockGetCalendarConnections(...args),
    getCalendarConnectionById: (...args: unknown[]) => mockGetCalendarConnectionById(...args),
    createCalendarConnection: (...args: unknown[]) => mockCreateCalendarConnection(...args),
    deleteCalendarConnection: (...args: unknown[]) => mockDeleteCalendarConnection(...args),
    getCalendarBookings: (...args: unknown[]) => mockGetCalendarBookings(...args),
    getCalendarBookingById: (...args: unknown[]) => mockGetCalendarBookingById(...args),
    createCalendarBooking: (...args: unknown[]) => mockCreateCalendarBooking(...args),
    updateCalendarBookingStatus: (...args: unknown[]) => mockUpdateCalendarBookingStatus(...args),
    updateCalendarBookingEventId: (...args: unknown[]) => mockUpdateCalendarBookingEventId(...args),
    getBookingsInRange: (...args: unknown[]) => mockGetBookingsInRange(...args),
    toJstString: (...args: unknown[]) => mockToJstString(args[0] as Date),
    // Auth middleware stubs
    getStaffByApiKey: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => []),
  };
});

// Mock GoogleCalendarClient
const mockGetFreeBusy = vi.fn();
const mockCreateEvent = vi.fn();
const mockDeleteEvent = vi.fn();

vi.mock('../services/google-calendar.js', () => ({
  GoogleCalendarClient: class {
    constructor() {}
    getFreeBusy = mockGetFreeBusy;
    createEvent = mockCreateEvent;
    deleteEvent = mockDeleteEvent;
  },
}));

// Mock line-sdk to prevent import failures
vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class {
    constructor() {}
    async replyMessage() {}
    async pushMessage() {}
    async getProfile() {
      return { displayName: 'Test', userId: 'u1', pictureUrl: '', statusMessage: '' };
    }
    async showLoadingAnimation() {}
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { calendar } from '../routes/calendar.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-calendar';

function createTestApp() {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', calendar);
  return app;
}

function createMockEnv(): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'ch-id',
    LINE_LOGIN_CHANNEL_ID: 'login-ch-id',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Calendar Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Auth guard
  // =========================================================================

  describe('Auth guard', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/api/integrations/google-calendar', {}, env);
      expect(res.status).toBe(401);
      const json = (await res.json()) as { success: boolean };
      expect(json.success).toBe(false);
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.request(
        '/api/integrations/google-calendar',
        { headers: { Authorization: 'Bearer wrong-key' } },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/integrations/google-calendar — list connections
  // =========================================================================

  describe('GET /api/integrations/google-calendar', () => {
    it('returns empty list when no connections exist', async () => {
      mockGetCalendarConnections.mockResolvedValue([]);
      const res = await app.request(
        '/api/integrations/google-calendar',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
    });

    it('returns mapped connection list', async () => {
      const conn = makeConnection();
      mockGetCalendarConnections.mockResolvedValue([conn]);
      const res = await app.request(
        '/api/integrations/google-calendar',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: { id: string; calendarId: string; authType: string; isActive: boolean }[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('conn-1');
      expect(json.data[0].calendarId).toBe('cal@example.com');
      expect(json.data[0].authType).toBe('api_key');
      expect(json.data[0].isActive).toBe(true);
    });

    it('returns 500 on DB error', async () => {
      mockGetCalendarConnections.mockRejectedValue(new Error('DB fail'));
      const res = await app.request(
        '/api/integrations/google-calendar',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/integrations/google-calendar/connect — create connection
  // =========================================================================

  describe('POST /api/integrations/google-calendar/connect', () => {
    it('creates a connection and returns 201', async () => {
      const conn = makeConnection();
      mockCreateCalendarConnection.mockResolvedValue(conn);
      const res = await app.request(
        '/api/integrations/google-calendar/connect',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarId: 'cal@example.com', authType: 'api_key' }),
        },
        env,
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as { success: boolean; data: { id: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('conn-1');
    });

    it('returns 400 when calendarId is missing', async () => {
      const res = await app.request(
        '/api/integrations/google-calendar/connect',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ authType: 'api_key' }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.error).toBe('calendarId is required');
    });

    it('returns 500 on DB error', async () => {
      mockCreateCalendarConnection.mockRejectedValue(new Error('DB fail'));
      const res = await app.request(
        '/api/integrations/google-calendar/connect',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarId: 'cal@example.com', authType: 'api_key' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // DELETE /api/integrations/google-calendar/:id — delete connection
  // =========================================================================

  describe('DELETE /api/integrations/google-calendar/:id', () => {
    it('deletes a connection and returns success', async () => {
      mockDeleteCalendarConnection.mockResolvedValue(undefined);
      const res = await app.request(
        '/api/integrations/google-calendar/conn-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns 500 on DB error', async () => {
      mockDeleteCalendarConnection.mockRejectedValue(new Error('DB fail'));
      const res = await app.request(
        '/api/integrations/google-calendar/conn-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /api/integrations/google-calendar/slots — get available slots
  // =========================================================================

  describe('GET /api/integrations/google-calendar/slots', () => {
    it('returns 400 when connectionId is missing', async () => {
      const res = await app.request(
        '/api/integrations/google-calendar/slots?date=2025-06-01',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.error).toBe('connectionId and date are required');
    });

    it('returns 400 when date is missing', async () => {
      const res = await app.request(
        '/api/integrations/google-calendar/slots?connectionId=conn-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 when connection not found', async () => {
      mockGetCalendarConnectionById.mockResolvedValue(null);
      const res = await app.request(
        '/api/integrations/google-calendar/slots?connectionId=conn-1&date=2025-06-01',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.error).toBe('Calendar connection not found');
    });

    it('returns slots with all available when no bookings exist (no access_token)', async () => {
      const conn = makeConnection({ access_token: null });
      mockGetCalendarConnectionById.mockResolvedValue(conn);
      mockGetBookingsInRange.mockResolvedValue([]);
      mockToJstString.mockImplementation((d: unknown) => (d as Date).toISOString());

      const res = await app.request(
        '/api/integrations/google-calendar/slots?connectionId=conn-1&date=2025-06-01&startHour=9&endHour=11&slotMinutes=60',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: { startAt: string; endAt: string; available: boolean }[] };
      expect(json.success).toBe(true);
      // 9-11 with 60-min slots = 2 slots
      expect(json.data).toHaveLength(2);
      expect(json.data[0].available).toBe(true);
      expect(json.data[1].available).toBe(true);
    });

    it('marks slots as unavailable when D1 bookings overlap', async () => {
      const conn = makeConnection({ access_token: null });
      mockGetCalendarConnectionById.mockResolvedValue(conn);
      // A booking covering 10:00-11:00
      mockGetBookingsInRange.mockResolvedValue([
        makeBooking({ start_at: '2025-06-01T01:00:00.000Z', end_at: '2025-06-01T02:00:00.000Z' }),
      ]);
      mockToJstString.mockImplementation((d: unknown) => (d as Date).toISOString());

      const res = await app.request(
        '/api/integrations/google-calendar/slots?connectionId=conn-1&date=2025-06-01&startHour=9&endHour=12&slotMinutes=60',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: { available: boolean }[] };
      expect(json.success).toBe(true);
      // At least one slot should be unavailable
      const unavailable = json.data.filter((s) => !s.available);
      expect(unavailable.length).toBeGreaterThanOrEqual(1);
    });

    it('calls Google FreeBusy API when access_token is present', async () => {
      const conn = makeConnection({ access_token: 'gtoken-123' });
      mockGetCalendarConnectionById.mockResolvedValue(conn);
      mockGetBookingsInRange.mockResolvedValue([]);
      mockGetFreeBusy.mockResolvedValue([]);
      mockToJstString.mockImplementation((d: unknown) => (d as Date).toISOString());

      const res = await app.request(
        '/api/integrations/google-calendar/slots?connectionId=conn-1&date=2025-06-01&startHour=9&endHour=10&slotMinutes=60',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockGetFreeBusy).toHaveBeenCalledOnce();
    });

    it('falls back gracefully when Google FreeBusy API fails', async () => {
      const conn = makeConnection({ access_token: 'gtoken-123' });
      mockGetCalendarConnectionById.mockResolvedValue(conn);
      mockGetBookingsInRange.mockResolvedValue([]);
      mockGetFreeBusy.mockRejectedValue(new Error('Google API fail'));
      mockToJstString.mockImplementation((d: unknown) => (d as Date).toISOString());

      const res = await app.request(
        '/api/integrations/google-calendar/slots?connectionId=conn-1&date=2025-06-01&startHour=9&endHour=10&slotMinutes=60',
        { headers: authHeaders() },
        env,
      );
      // Should succeed even though Google API failed
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: { available: boolean }[] };
      expect(json.success).toBe(true);
    });

    it('returns 500 on DB error', async () => {
      mockGetCalendarConnectionById.mockRejectedValue(new Error('DB fail'));
      const res = await app.request(
        '/api/integrations/google-calendar/slots?connectionId=conn-1&date=2025-06-01',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /api/integrations/google-calendar/bookings — list bookings
  // =========================================================================

  describe('GET /api/integrations/google-calendar/bookings', () => {
    it('returns empty bookings list', async () => {
      mockGetCalendarBookings.mockResolvedValue([]);
      const res = await app.request(
        '/api/integrations/google-calendar/bookings',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
    });

    it('returns mapped booking list', async () => {
      const booking = makeBooking({ metadata: JSON.stringify({ note: 'test' }) });
      mockGetCalendarBookings.mockResolvedValue([booking]);
      const res = await app.request(
        '/api/integrations/google-calendar/bookings',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: { id: string; metadata: { note: string } }[] };
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('bk-1');
      expect(json.data[0].metadata).toEqual({ note: 'test' });
    });

    it('passes connectionId filter', async () => {
      mockGetCalendarBookings.mockResolvedValue([]);
      await app.request(
        '/api/integrations/google-calendar/bookings?connectionId=conn-1',
        { headers: authHeaders() },
        env,
      );
      expect(mockGetCalendarBookings).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({ connectionId: 'conn-1' }),
      );
    });

    it('passes friendId filter', async () => {
      mockGetCalendarBookings.mockResolvedValue([]);
      await app.request(
        '/api/integrations/google-calendar/bookings?friendId=friend-1',
        { headers: authHeaders() },
        env,
      );
      expect(mockGetCalendarBookings).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({ friendId: 'friend-1' }),
      );
    });

    it('handles null metadata', async () => {
      mockGetCalendarBookings.mockResolvedValue([makeBooking({ metadata: null })]);
      const res = await app.request(
        '/api/integrations/google-calendar/bookings',
        { headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { data: { metadata: unknown }[] };
      expect(json.data[0].metadata).toBeNull();
    });

    it('returns 500 on DB error', async () => {
      mockGetCalendarBookings.mockRejectedValue(new Error('DB fail'));
      const res = await app.request(
        '/api/integrations/google-calendar/bookings',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // POST /api/integrations/google-calendar/book — create booking
  // =========================================================================

  describe('POST /api/integrations/google-calendar/book', () => {
    const validBody = {
      connectionId: 'conn-1',
      title: 'Consultation',
      startAt: '2025-06-01T10:00:00',
      endAt: '2025-06-01T11:00:00',
    };

    it('creates a booking and returns 201', async () => {
      const booking = makeBooking();
      mockCreateCalendarBooking.mockResolvedValue(booking);
      mockGetCalendarConnectionById.mockResolvedValue(makeConnection({ access_token: null }));

      const res = await app.request(
        '/api/integrations/google-calendar/book',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(validBody),
        },
        env,
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as { success: boolean; data: { id: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('bk-1');
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await app.request(
        '/api/integrations/google-calendar/book',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId: 'conn-1' }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe('connectionId, title, startAt, endAt are required');
    });

    it('creates Google Calendar event when access_token exists', async () => {
      const booking = makeBooking();
      mockCreateCalendarBooking.mockResolvedValue(booking);
      mockGetCalendarConnectionById.mockResolvedValue(makeConnection({ access_token: 'gtoken' }));
      mockCreateEvent.mockResolvedValue({ eventId: 'gcal-ev-1' });
      mockUpdateCalendarBookingEventId.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/integrations/google-calendar/book',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(validBody),
        },
        env,
      );
      expect(res.status).toBe(201);
      expect(mockCreateEvent).toHaveBeenCalledOnce();
      expect(mockUpdateCalendarBookingEventId).toHaveBeenCalledWith(env.DB, 'bk-1', 'gcal-ev-1');
    });

    it('still succeeds when Google Calendar API fails (best-effort)', async () => {
      const booking = makeBooking();
      mockCreateCalendarBooking.mockResolvedValue(booking);
      mockGetCalendarConnectionById.mockResolvedValue(makeConnection({ access_token: 'gtoken' }));
      mockCreateEvent.mockRejectedValue(new Error('Google API fail'));

      const res = await app.request(
        '/api/integrations/google-calendar/book',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(validBody),
        },
        env,
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as { success: boolean };
      expect(json.success).toBe(true);
    });

    it('stringifies metadata when provided', async () => {
      const booking = makeBooking();
      mockCreateCalendarBooking.mockResolvedValue(booking);
      mockGetCalendarConnectionById.mockResolvedValue(makeConnection({ access_token: null }));

      await app.request(
        '/api/integrations/google-calendar/book',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validBody, metadata: { source: 'liff' } }),
        },
        env,
      );
      expect(mockCreateCalendarBooking).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({ metadata: JSON.stringify({ source: 'liff' }) }),
      );
    });

    it('returns 500 on DB error', async () => {
      mockCreateCalendarBooking.mockRejectedValue(new Error('DB fail'));
      const res = await app.request(
        '/api/integrations/google-calendar/book',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(validBody),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // PUT /api/integrations/google-calendar/bookings/:id/status
  // =========================================================================

  describe('PUT /api/integrations/google-calendar/bookings/:id/status', () => {
    it('updates booking status', async () => {
      mockUpdateCalendarBookingStatus.mockResolvedValue(undefined);
      const res = await app.request(
        '/api/integrations/google-calendar/bookings/bk-1/status',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'confirmed' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(mockUpdateCalendarBookingStatus).toHaveBeenCalledWith(env.DB, 'bk-1', 'confirmed');
    });

    it('deletes Google Calendar event when status is cancelled', async () => {
      const booking = makeBooking({ event_id: 'gcal-ev-1', connection_id: 'conn-1' });
      mockGetCalendarBookingById.mockResolvedValue(booking);
      mockGetCalendarConnectionById.mockResolvedValue(makeConnection({ access_token: 'gtoken' }));
      mockDeleteEvent.mockResolvedValue(undefined);
      mockUpdateCalendarBookingStatus.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/integrations/google-calendar/bookings/bk-1/status',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockDeleteEvent).toHaveBeenCalledWith('gcal-ev-1');
    });

    it('still updates status when Google Calendar delete fails (best-effort)', async () => {
      const booking = makeBooking({ event_id: 'gcal-ev-1', connection_id: 'conn-1' });
      mockGetCalendarBookingById.mockResolvedValue(booking);
      mockGetCalendarConnectionById.mockResolvedValue(makeConnection({ access_token: 'gtoken' }));
      mockDeleteEvent.mockRejectedValue(new Error('Google API fail'));
      mockUpdateCalendarBookingStatus.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/integrations/google-calendar/bookings/bk-1/status',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockUpdateCalendarBookingStatus).toHaveBeenCalledWith(env.DB, 'bk-1', 'cancelled');
    });

    it('skips Google Calendar delete when no event_id', async () => {
      const booking = makeBooking({ event_id: null });
      mockGetCalendarBookingById.mockResolvedValue(booking);
      mockUpdateCalendarBookingStatus.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/integrations/google-calendar/bookings/bk-1/status',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockDeleteEvent).not.toHaveBeenCalled();
    });

    it('skips Google Calendar delete when no access_token', async () => {
      const booking = makeBooking({ event_id: 'gcal-ev-1', connection_id: 'conn-1' });
      mockGetCalendarBookingById.mockResolvedValue(booking);
      mockGetCalendarConnectionById.mockResolvedValue(makeConnection({ access_token: null }));
      mockUpdateCalendarBookingStatus.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/integrations/google-calendar/bookings/bk-1/status',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockDeleteEvent).not.toHaveBeenCalled();
    });

    it('returns 500 on DB error', async () => {
      mockUpdateCalendarBookingStatus.mockRejectedValue(new Error('DB fail'));
      const res = await app.request(
        '/api/integrations/google-calendar/bookings/bk-1/status',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'confirmed' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });
});
