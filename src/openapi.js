// Spesifikasi OpenAPI 3.1.0 dan halaman dokumentasi interaktif (/docs) untuk AI Gateway.
// Dibangun dinamis dari origin request sehingga base URL selalu akurat (localhost maupun domain publik).

export function buildOpenApiSpec(origin) {
  const serverUrl = String(origin || 'http://localhost:8787').replace(/\/+$/, '');
  const errRef = { $ref: '#/components/schemas/ErrorResponse' };
  const errResponses = {
    400: { description: 'Permintaan tidak valid atau kombinasi model/endpoint tidak didukung', content: { 'application/json': { schema: errRef } } },
    401: { description: 'API key tidak valid', content: { 'application/json': { schema: errRef } } },
    404: { description: 'Model atau endpoint tidak ditemukan', content: { 'application/json': { schema: errRef } } },
    429: { description: 'Rate limit, kuota habis, atau budget terlampaui', content: { 'application/json': { schema: errRef } } },
  };
  const auth = [{ BearerAuth: [] }];

  return {
    openapi: '3.1.0',
    info: {
      title: 'AI Gateway API',
      version: '1.0.0',
      description:
        'OpenAI-compatible AI Gateway. Satu endpoint dan satu API key untuk semua provider. Gunakan `GET /v1/models` atau `GET /models.md` untuk daftar model aktif beserta `supported_endpoints` dan harga.',
    },
    servers: [{ url: serverUrl }],
    security: auth,
    tags: [
      { name: 'Models', description: 'Daftar dan detail kapabilitas model aktif' },
      { name: 'Text', description: 'Chat Completions, Responses API, Completions, dan Embeddings' },
      { name: 'Images', description: 'Generasi dan edit gambar' },
      { name: 'Audio', description: 'Transkripsi audio OpenAI-compatible dan ASR native' },
    ],
    paths: {
      '/v1/models': {
        get: {
          tags: ['Models'],
          summary: 'Daftar semua model aktif',
          security: auth,
          responses: {
            200: {
              description: 'Daftar model beserta supported_endpoints dan pricing',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      object: { type: 'string', example: 'list' },
                      data: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
                    },
                  },
                },
              },
            },
            401: errResponses[401],
          },
        },
      },
      '/v1/models/{model}': {
        get: {
          tags: ['Models'],
          summary: 'Detail satu model (mendukung ID yang mengandung /)',
          security: auth,
          parameters: [
            {
              name: 'model',
              in: 'path',
              required: true,
              description: 'Model ID lengkap, mis. `codex/gpt-6.2-sol` atau `antigravity/gemini-4-hydrogen` (raw atau URL-encoded).',
              schema: { type: 'string', example: 'codex/gpt-6.2-sol' },
            },
          ],
          responses: {
            200: { description: 'Metadata model', content: { 'application/json': { schema: { $ref: '#/components/schemas/Model' } } } },
            401: errResponses[401],
            404: errResponses[404],
          },
        },
      },
      '/v1/chat/completions': {
        post: {
          tags: ['Text'],
          summary: 'Buat chat completion (streaming & non-streaming)',
          security: auth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'messages'],
                  properties: {
                    model: { type: 'string', example: 'codex/gpt-6.2-sol' },
                    messages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['role', 'content'],
                        properties: {
                          role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant', 'tool'] },
                          content: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
                        },
                      },
                    },
                    stream: { type: 'boolean', default: false },
                    reasoning_effort: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
                    temperature: { type: 'number' },
                    max_completion_tokens: { type: 'integer' },
                    tools: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Chat completion JSON atau SSE stream (`delta.content` dan `delta.reasoning_content`)' },
            ...errResponses,
          },
        },
      },
      '/v1/responses': {
        post: {
          tags: ['Text'],
          summary: 'OpenAI Responses API',
          security: auth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'input'],
                  properties: {
                    model: { type: 'string', example: 'codex/gpt-6.2-sol' },
                    input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
                    stream: { type: 'boolean', default: false },
                    reasoning: { type: 'object', properties: { effort: { type: 'string' } } },
                    tools: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Responses JSON atau SSE stream' }, ...errResponses },
        },
      },
      '/v1/completions': {
        post: {
          tags: ['Text'],
          summary: 'Legacy text completions (khusus provider yang mendukung)',
          security: auth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'prompt'],
                  properties: { model: { type: 'string' }, prompt: { type: 'string' }, max_tokens: { type: 'integer' }, stream: { type: 'boolean' } },
                },
              },
            },
          },
          responses: { 200: { description: 'Completion response' }, ...errResponses },
        },
      },
      '/v1/embeddings': {
        post: {
          tags: ['Text'],
          summary: 'Buat vector embeddings (khusus provider yang mendukung)',
          security: auth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'input'],
                  properties: { model: { type: 'string' }, input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
                },
              },
            },
          },
          responses: { 200: { description: 'Embedding response' }, ...errResponses },
        },
      },
      '/v1/images/generations': {
        post: {
          tags: ['Images'],
          summary: 'Generate gambar dari prompt',
          security: auth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'prompt'],
                  properties: {
                    model: { type: 'string', example: 'codex/gpt-image-2.5' },
                    prompt: { type: 'string', example: 'A minimal red circle on white background' },
                    n: { type: 'integer', default: 1 },
                    size: { type: 'string', example: '1024x1024' },
                    quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
                    output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Daftar gambar base64 (`data[].b64_json`)' }, ...errResponses },
        },
      },
      '/v1/images/edits': {
        post: {
          tags: ['Images'],
          summary: 'Edit gambar dengan referensi (JSON atau multipart/form-data)',
          security: auth,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'prompt'],
                  properties: {
                    model: { type: 'string', example: 'antigravity/gemini-3.1-flash-image' },
                    prompt: { type: 'string' },
                    image: { type: 'string', description: 'Data URI atau base64 gambar referensi' },
                    images: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['model', 'prompt', 'image'],
                  properties: { model: { type: 'string' }, prompt: { type: 'string' }, image: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
          responses: { 200: { description: 'Gambar hasil edit (`data[].b64_json`)' }, ...errResponses },
        },
      },
      '/v1/audio/transcriptions': {
        post: {
          tags: ['Audio'],
          summary: 'Transkripsi audio (OpenAI SDK compatible)',
          security: auth,
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'model'],
                  properties: {
                    file: { type: 'string', format: 'binary', description: 'File audio WAV mono PCM 16-bit (16/24 kHz)' },
                    model: { type: 'string', example: 'meta/muse-voice-transcribe-1.0' },
                    language: { type: 'string', example: 'en', description: 'Kode ISO-639-1 (en, id, dll.) atau nama bahasa' },
                    response_format: { type: 'string', enum: ['json', 'text', 'verbose_json'], default: 'json' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Hasil transkripsi sesuai `response_format`',
              content: {
                'application/json': { schema: { type: 'object', properties: { text: { type: 'string' }, duration: { type: 'number' }, segments: { type: 'array', items: { type: 'object' } } } } },
                'text/plain': { schema: { type: 'string' } },
              },
            },
            ...errResponses,
          },
        },
      },
      '/models.md': {
        get: {
          tags: ['Models'],
          summary: 'Katalog publik Markdown (tanpa autentikasi, ramah AI agent)',
          security: [],
          responses: { 200: { description: 'Tabel Markdown semua model aktif', content: { 'text/markdown': { schema: { type: 'string' } } } } },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API Key' },
      },
      schemas: {
        Model: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'codex/gpt-6.2-sol' },
            object: { type: 'string', example: 'model' },
            created: { type: 'integer' },
            owned_by: { type: 'string', example: 'codex' },
            display_name: { type: 'string', example: 'GPT-6.2 Sol' },
            kind: { type: 'string', enum: ['text', 'image', 'transcribe', 'segment'] },
            input_modalities: { type: 'array', items: { type: 'string', enum: ['text', 'image', 'audio', 'video', 'file'] } },
            context_window: { type: ['integer', 'null'] },
            max_output: { type: ['integer', 'null'] },
            supported_endpoints: { type: 'array', items: { type: 'string' } },
            reasoning: { type: ['string', 'null'] },
            pricing: { type: 'object' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string', example: 'invalid_request_error' },
                code: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
                param: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

export function renderDocsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Gateway · API Docs</title>
  <style>body{margin:0}</style>
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}
