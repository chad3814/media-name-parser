import { z } from 'zod';
import {
  BATCH_CAP, lookupRequestSchema, lookupBatchSchema,
} from '../http/lookupHandler';

/**
 * The OpenAPI description of the key-authenticated v1 API.
 *
 * Only the Bearer surface is described. The session-authenticated routes
 * (`/api/ui/*`, `/api/keys*`, `/api/v1/admin/whoami`) and the cron route are
 * deliberately absent: they are this application's own internals, not an API
 * anyone writes a client against, and listing them in a public document would
 * advertise a surface no external caller can use.
 *
 * Request bodies are derived from the same zod schemas the handler validates
 * against, so a schema change cannot leave the document describing an older
 * contract. Response shapes are written out, because responses are typed but
 * not zod-validated -- `test/openapi/spec.test.ts` pins them against the
 * TypeScript types they claim to describe.
 */

/** A JSON Schema object, as far as this document is concerned. */
type JsonSchema = Readonly<Record<string, unknown>>;

function derive(schema: z.ZodType): JsonSchema {
  // `io: 'input'` describes what a caller may send rather than what survives
  // parsing. It matters here: `name` carries `.trim()`, a transform, and the
  // output view would describe the trimmed value as the thing to send.
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input', target: 'draft-2020-12',
  });
  // `$schema` is legal inside an OpenAPI 3.1 component but says nothing a
  // reader of this document needs, and some generators treat it as an unknown
  // keyword. The dialect is already declared by `openapi: 3.1.0`.
  return rest;
}

const problemSchema: JsonSchema = {
  type: 'object',
  description: 'An RFC 9457 problem document.',
  properties: {
    type: { type: 'string', examples: ['about:blank'] },
    title: { type: 'string', examples: ['Bad Request'] },
    status: { type: 'integer', examples: [400] },
    detail: { type: 'string', description: 'Absent when there is nothing to add.' },
  },
  required: ['type', 'title', 'status'],
};

const personSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    role: { type: 'string', examples: ['cast', 'director'] },
    characterName: { type: ['string', 'null'] },
    billingOrder: { type: ['integer', 'null'] },
  },
  required: ['name', 'role', 'characterName', 'billingOrder'],
};

const nodeProperties: JsonSchema = {
  id: { type: 'string', format: 'uuid' },
  kind: { type: 'string', enum: ['movie', 'series', 'season', 'episode', 'book', 'scene'] },
  title: { type: 'string' },
  releaseDate: { type: ['string', 'null'], description: 'ISO date, provider-supplied.' },
  year: { type: ['integer', 'null'] },
  provider: { type: 'string', enum: ['tmdb', 'ibdb', 'tpdb'] },
  providerRef: { type: 'string', examples: ['tmdb:movie:12345'] },
};

const nodeRequired = ['id', 'kind', 'title', 'releaseDate', 'year', 'provider', 'providerRef'];

const mediaSchema: JsonSchema = {
  type: 'object',
  properties: {
    ...nodeProperties,
    overview: { type: ['string', 'null'] },
    details: {
      type: 'object',
      description: 'Whichever detail table matches `kind`, flattened.',
      additionalProperties: { type: ['string', 'number', 'null'] },
    },
    parents: {
      type: 'array',
      description: "Nearest first: an episode's parents are its season, then its series.",
      items: { type: 'object', properties: nodeProperties, required: nodeRequired },
    },
    people: { type: 'array', items: personSchema },
  },
  required: [...nodeRequired, 'overview', 'details', 'parents', 'people'],
};

const envelopeSchema: JsonSchema = {
  type: 'object',
  properties: {
    lookupId: { type: 'string', format: 'uuid' },
    state: { type: 'string', enum: ['resolved', 'unresolved', 'pending'] },
    partial: {
      type: 'boolean',
      description: 'The lookup ran out of time and a background job will finish it. '
        + 'Poll `/v1/lookup/{id}` for the completed answer.',
    },
    cached: { type: 'boolean', description: 'Answered from the cache, with no provider call.' },
    confidence: { type: ['number', 'null'], description: '0 to 1. Null when nothing was scored.' },
    refusal: {
      type: ['string', 'null'],
      description: 'Why this name is not a media file, e.g. a subtitle or a sidecar. '
        + 'A refusal is a successful answer, not an error.',
    },
    parsed: {
      type: ['object', 'null'],
      additionalProperties: true,
      description: 'The parse behind this answer, whether derived now or read from the cache. '
        + 'For a refused lookup this is the stored refusal record rather than a parse.',
    },
    media: { ...mediaSchema, type: ['object', 'null'] },
  },
  required: ['lookupId', 'state', 'partial', 'cached', 'confidence', 'refusal', 'parsed', 'media'],
};

/** Every response this document declares, so the operations stay readable. */
const problemResponse = (description: string): JsonSchema => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

const commonErrors: JsonSchema = {
  '400': problemResponse('The request body or a path parameter is malformed.'),
  '401': problemResponse('The API key is missing, unknown, revoked, or its owner is banned.'),
  '429': problemResponse('Rate limited. `Retry-After` says how long to wait.'),
  '503': problemResponse('The database or a provider credential is unavailable.'),
};

export function buildSpec(): Readonly<Record<string, unknown>> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'media-name-parser',
      version: '1',
      description: 'Turns a media filename into provider metadata, and caches the answer.\n\n'
        + 'Every route here authenticates with an API key as a Bearer token. Mint one from '
        + 'the signed-in UI; a key is shown once at creation and only its hash is stored.',
    },
    servers: [{ url: '/', description: 'This deployment' }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API key minted for your account. Sent as `Authorization: Bearer <key>`.',
        },
      },
      schemas: {
        Problem: problemSchema,
        LookupRequest: derive(lookupRequestSchema),
        LookupBatchRequest: derive(lookupBatchSchema),
        LookupEnvelope: envelopeSchema,
        Media: mediaSchema,
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/api/v1/health': {
        get: {
          summary: 'Liveness',
          description: 'The one route here that needs no credential. Use it to check the '
            + 'deployment answers before you paste a key.',
          security: [],
          responses: {
            '200': {
              description: 'The service is up.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok'],
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/lookup': {
        post: {
          summary: 'Look up one name, or a batch',
          description: 'Send a single `{ category, name }` object, or '
            + `\`{ items: [...] }\` with at most ${String(BATCH_CAP)} of them. The shape is `
            + 'decided before validation, so an error always belongs to the schema you were '
            + 'actually attempting.\n\nA batch always answers 200; read each entry\'s own '
            + '`status`. A single lookup answers 202 when it went partial.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/LookupRequest' },
                    { $ref: '#/components/schemas/LookupBatchRequest' },
                  ],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Resolved, refused, or -- for a batch -- one result per item.',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/LookupEnvelope' },
                      {
                        type: 'object',
                        description: 'A batch response: one entry per item, in order.',
                        properties: {
                          results: {
                            type: 'array',
                            items: {
                              allOf: [
                                { $ref: '#/components/schemas/LookupEnvelope' },
                                {
                                  type: 'object',
                                  properties: { status: { type: 'integer', examples: [200, 202] } },
                                  required: ['status'],
                                },
                              ],
                            },
                          },
                        },
                        required: ['results'],
                      },
                    ],
                  },
                },
              },
            },
            '202': {
              description: 'Partial: a durable job will finish it. Poll `/api/v1/lookup/{id}`.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/LookupEnvelope' } },
              },
            },
            ...commonErrors,
          },
        },
      },
      '/api/v1/lookup/{id}': {
        get: {
          summary: 'Poll a lookup',
          description: 'The same envelope a POST returns. This is how you collect the answer '
            + 'to a lookup that came back 202.',
          parameters: [{
            name: 'id', in: 'path', required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'The `lookupId` from the envelope.',
          }],
          responses: {
            '200': {
              description: 'The lookup as it now stands.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/LookupEnvelope' } },
              },
            },
            '404': problemResponse('No lookup with that id.'),
            ...commonErrors,
          },
        },
      },
      '/api/v1/media/{id}': {
        get: {
          summary: 'Read a media record',
          description: 'A media row with its ancestors and its people. The same object the '
            + 'lookup envelope embeds, fetchable on its own.',
          parameters: [{
            name: 'id', in: 'path', required: true,
            schema: { type: 'string', format: 'uuid' },
          }],
          responses: {
            '200': {
              description: 'The media record.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { media: { $ref: '#/components/schemas/Media' } },
                    required: ['media'],
                  },
                },
              },
            },
            '404': problemResponse('No media with that id.'),
            ...commonErrors,
          },
        },
      },
    },
  };
}
