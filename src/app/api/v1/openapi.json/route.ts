import { NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { PRODUCT } from '@/lib/product';

export const dynamic = 'force-dynamic';

const err = { $ref: '#/components/schemas/Error' };
const bearer = [{ bearerAuth: [] }];

export function GET() {
  const spec = {
    openapi: '3.0.3',
    info: { title: `${PRODUCT.name} API`, version: '1.0.0', description: 'Authenticated REST API. Create keys in Settings → Developers. Each key acts as its creator inside their organization (row-level security applies) and is limited to the scopes you choose. Rate limit: 120 requests/minute per key.' },
    servers: [{ url: getEnv().APP_URL }],
    security: bearer,
    paths: {
      '/api/v1/clients': {
        get: { summary: 'List clients', description: 'Scope: clients:read', parameters: [{ name: 'email', in: 'query', schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'OK' }, 401: { description: 'Bad key', content: { 'application/json': { schema: err } } } } },
        post: { summary: 'Create a client', description: 'Scope: clients:write', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['full_name'], properties: { full_name: { type: 'string' }, email: { type: 'string', format: 'email' }, phone: { type: 'string' }, preferred_language: { enum: ['en', 'es'] }, status: { enum: ['lead', 'onboarding', 'active'] }, source: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' }, 409: { description: 'Email already exists' }, 422: { description: 'Invalid request' } } },
      },
      '/api/v1/clients/{id}': { get: { summary: 'Get a client with reports, scores and disputes', description: 'Scope: clients:read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } } },
      '/api/v1/clients/{id}/reports': {
        post: {
          summary: 'Push credit reports for a client', description: 'Scope: reports:write. Requires the client’s written FCRA authorization on file. Reports are queued as "pending review"; a person must approve them before analysis. Full account numbers are reduced to their last four characters and never stored.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReportPush' } } } },
          responses: { 201: { description: 'Queued for review' }, 422: { description: 'Invalid payload or missing authorization' }, 404: { description: 'Client not found' } },
        },
      },
      '/api/v1/disputes': { get: { summary: 'List disputes', description: 'Scope: disputes:read', parameters: [{ name: 'client_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'status', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'dosk_<prefix>_<secret>' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
        ReportPush: {
          type: 'object', required: ['reports'],
          properties: {
            external_ref: { type: 'string', description: 'Your id for this pull. Re-sending the same value is rejected, so retries are safe.' },
            reports: { type: 'array', minItems: 1, maxItems: 3, description: 'At most one report per bureau.', items: { type: 'object', required: ['bureau'], properties: {
              bureau: { enum: ['experian', 'equifax', 'transunion'] }, report_date: { type: 'string', format: 'date' },
              scores: { type: 'array', items: { type: 'object', required: ['model', 'score'], properties: { model: { type: 'string', example: 'VantageScore 3.0' }, score: { type: 'integer', minimum: 250, maximum: 900 }, date: { type: 'string', format: 'date' } } } },
              tradelines: { type: 'array', maxItems: 500, items: { type: 'object', required: ['creditor_name'], properties: { creditor_name: { type: 'string' }, account_number: { type: 'string', description: 'Only the last 4 characters are kept.' }, item_type: { enum: ['tradeline', 'collection'] }, original_creditor: { type: 'string' }, account_type: { type: 'string' }, account_status: { type: 'string' }, payment_status: { type: 'string' }, balance_cents: { type: 'integer' }, credit_limit_cents: { type: 'integer' }, high_balance_cents: { type: 'integer' }, date_opened: { type: 'string', format: 'date' }, date_reported: { type: 'string', format: 'date' }, date_of_first_delinquency: { type: 'string', format: 'date' }, payment_history: { type: 'string' }, remarks: { type: 'string' } } } },
              inquiries: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, date: { type: 'string', format: 'date' } } } },
              public_records: { type: 'array', items: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' }, court: { type: 'string' }, amount_cents: { type: 'integer' }, filed_date: { type: 'string', format: 'date' }, status: { type: 'string' } } } },
              identity: { type: 'array', items: { type: 'object', required: ['kind', 'value'], properties: { kind: { enum: ['name', 'address', 'employer'] }, value: { type: 'string' } } } },
            } } },
          },
        },
      },
    },
  };
  return NextResponse.json(spec, { headers: { 'cache-control': 'public, max-age=300' } });
}
