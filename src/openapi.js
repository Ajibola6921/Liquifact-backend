'use strict';

const config = require('./config');

const Invoice = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'INV_0001' },
    sme: { type: 'string', example: 'Acme Components Ltd' },
    smeAddress: { type: 'string', nullable: true },
    debtor: { type: 'string', example: 'Globex Retail' },
    amount: { type: 'number', example: 25000 },
    currency: { type: 'string', example: 'USDC' },
    fundedAmount: { type: 'number', example: 0 },
    yieldBps: { type: 'integer', example: 800 },
    dueDate: { type: 'string', format: 'date' },
    status: { type: 'string', enum: ['open', 'funded', 'settled', 'cancelled'] },
    onChain: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const EscrowState = {
  type: 'object',
  properties: {
    invoice_id: { type: 'string' },
    admin: { type: 'string' },
    sme_address: { type: 'string' },
    amount: { type: 'string' },
    funding_target: { type: 'string' },
    funded_amount: { type: 'string' },
    yield_bps: { type: 'integer' },
    maturity: { type: 'integer' },
    status: { type: 'integer' },
  },
};

const CacheMeta = {
  type: 'object',
  required: ['status', 'ageMs', 'fetchedAt'],
  properties: {
    status: { type: 'string', enum: ['hit', 'miss', 'stale'] },
    ageMs: { type: 'integer', minimum: 0 },
    fetchedAt: { type: 'string', format: 'date-time' },
  },
};

const EscrowLiveResponse = {
  type: 'object',
  required: ['source', 'contractId', 'escrow', 'cache'],
  properties: {
    source: { type: 'string', enum: ['soroban-rpc'] },
    contractId: { type: 'string' },
    escrow: EscrowState,
    cache: CacheMeta,
  },
};

const EscrowSnapshotResponse = {
  type: 'object',
  required: ['source', 'contractId', 'escrow', 'warning'],
  properties: {
    source: { type: 'string', enum: ['snapshot'] },
    contractId: { type: 'string' },
    warning: { type: 'string' },
    escrow: EscrowState,
  },
};

const json = (schema) => ({ content: { 'application/json': { schema } } });
const ErrorBody = { type: 'object', properties: { error: { type: 'string' } } };

/**
 * Builds the OpenAPI document for the given public base URL.
 *
 * @param {string} baseUrl server URL to advertise
 * @returns {object} OpenAPI 3.0 document
 */
function buildSpec(baseUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'LiquiFact API',
      version: config.version,
      description:
        'Invoice liquidity network on Stellar. SMEs tokenize invoices, investors fund them, and a Soroban escrow ' +
        'holds funds until settlement. Escrow contract (testnet): ' + config.contractId,
    },
    servers: [{ url: baseUrl }],
    tags: [{ name: 'System' }, { name: 'Invoices' }, { name: 'Escrow' }],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Liveness probe',
          responses: { 200: { description: 'Service is up', ...json({ type: 'object' }) } },
        },
      },
      '/api/stats': {
        get: { tags: ['System'], summary: 'Marketplace totals', responses: { 200: { description: 'Totals' } } },
      },
      '/api/invoices': {
        get: {
          tags: ['Invoices'],
          summary: 'List invoices',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'funded', 'settled', 'cancelled'] } },
          ],
          responses: {
            200: { description: 'Invoices', ...json({ type: 'object', properties: { data: { type: 'array', items: Invoice }, count: { type: 'integer' } } }) },
            400: { description: 'Invalid filter', ...json(ErrorBody) },
          },
        },
        post: {
          tags: ['Invoices'],
          summary: 'Submit an invoice for financing',
          requestBody: {
            required: true,
            ...json({
              type: 'object',
              required: ['sme', 'debtor', 'amount', 'dueDate'],
              properties: {
                sme: { type: 'string' },
                debtor: { type: 'string' },
                amount: { type: 'number' },
                currency: { type: 'string', default: 'USDC' },
                yieldBps: { type: 'integer', default: 800 },
                dueDate: { type: 'string', format: 'date' },
                smeAddress: { type: 'string' },
              },
            }),
          },
          responses: {
            201: { description: 'Created', ...json({ type: 'object', properties: { data: Invoice } }) },
            400: { description: 'Validation failed', ...json(ErrorBody) },
          },
        },
      },
      '/api/invoices/{id}': {
        get: {
          tags: ['Invoices'],
          summary: 'Get an invoice',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Invoice', ...json({ type: 'object', properties: { data: Invoice } }) },
            404: { description: 'Not found', ...json(ErrorBody) },
          },
        },
      },
      '/api/invoices/{id}/fund': {
        post: {
          tags: ['Invoices'],
          summary: 'Record an investor contribution (demo, off-chain)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, ...json({ type: 'object', properties: { amount: { type: 'number' } } }) },
          responses: {
            200: { description: 'Updated invoice' },
            400: { description: 'Invalid amount' },
            404: { description: 'Not found' },
            409: { description: 'Invoice not open' },
          },
        },
      },
      '/api/escrow': {
        get: { tags: ['Escrow'], summary: 'Deployed escrow contract metadata', responses: { 200: { description: 'Contract info' } } },
      },
      '/api/escrow/live': {
        get: {
          tags: ['Escrow'],
          summary: 'Live escrow state read from Soroban RPC (cached, falls back to deploy snapshot)',
          description:
            'Served from a small in-process TTL cache with single-flight and stale-while-revalidate. ' +
            'The `cache.status` is `miss` on the first load, `hit` within the TTL, and `stale` while ' +
            'a background refresh is in flight. Use `?fresh=1` to bypass the cache (still single-flighted).',
          parameters: [
            {
              name: 'fresh',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['1', 'true'] },
              description: 'Bypass the cache and force a reload (still single-flighted).',
            },
          ],
          responses: {
            200: {
              description: 'Live escrow state (or snapshot fallback)',
              ...json({ type: 'object', oneOf: [EscrowLiveResponse, EscrowSnapshotResponse] }),
            },
            304: { description: 'Not Modified (ETag match)' },
          },
        },
      },
    },
  };
}

module.exports = { buildSpec, EscrowLiveResponse, EscrowSnapshotResponse, CacheMeta };
