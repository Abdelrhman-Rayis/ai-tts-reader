const request = require('supertest');
const mockCreateMessage = jest.fn();

// Mock Anthropic API *before* requiring the server
jest.mock('@anthropic-ai/sdk', () => {
    return jest.fn().mockImplementation(() => {
        return {
            messages: {
                create: mockCreateMessage,
            },
        };
    });
});

const Anthropic = require('@anthropic-ai/sdk');
const app = require('./server');

describe('AI TTS Reader API', () => {
    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();
        mockCreateMessage.mockReset();
    });

    describe('GET /api/health', () => {
        it('should return health status ok', async () => {
            const response = await request(app).get('/api/health');
            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                status: 'ok',
                version: '0.1.0',
                model: 'claude-haiku-4-5-20251001',
            });
        });
    });

    describe('POST /api/annotate', () => {
        it('should return 400 if text is missing or too short', async () => {
            let response = await request(app).post('/api/annotate').send({});
            expect(response.status).toBe(400);

            response = await request(app).post('/api/annotate').send({ text: 'short' });
            expect(response.status).toBe(400);
        });

        it('should process valid text and return annotations', async () => {
            const mockAnthropicResponse = {
                content: [
                    {
                        text: JSON.stringify([
                            {
                                text: 'This is a test sentence.',
                                rate: 0.95,
                                pause_after: 110,
                                important: true,
                                type: 'normal'
                            }
                        ])
                    }
                ],
                usage: { input_tokens: 10, output_tokens: 20 },
            };

            mockCreateMessage.mockResolvedValue(mockAnthropicResponse);

            const response = await request(app)
                .post('/api/annotate')
                .send({ text: 'This is a test sentence.' });

            expect(response.status).toBe(200);
            expect(response.body.sentences).toBeDefined();
            expect(response.body.sentences).toHaveLength(1);
            expect(response.body.sentences[0].text).toBe('This is a test sentence.');
            expect(mockCreateMessage).toHaveBeenCalledTimes(1);
        });

        it('should handle markdown wrapping in Anthropic response', async () => {
            const mockAnthropicResponse = {
                content: [
                    {
                        text: '```json\n[\n  {\n    "text": "This is a test sentence.",\n    "rate": 0.95,\n    "pause_after": 110,\n    "important": true,\n    "type": "normal"\n  }\n]\n```'
                    }
                ],
                usage: { input_tokens: 10, output_tokens: 20 },
            };

            mockCreateMessage.mockResolvedValue(mockAnthropicResponse);

            const response = await request(app)
                .post('/api/annotate')
                .send({ text: 'This is a test sentence.' });

            expect(response.status).toBe(200);
            expect(response.body.sentences).toBeDefined();
            expect(response.body.sentences).toHaveLength(1);
            expect(response.body.sentences[0].text).toBe('This is a test sentence.');
        });
    });

    describe('POST /api/extract-knowledge', () => {
        it('should return 400 if text is missing or too short', async () => {
            let response = await request(app).post('/api/extract-knowledge').send({});
            expect(response.status).toBe(400);

            response = await request(app).post('/api/extract-knowledge').send({ text: 'too short for validation' });
            expect(response.status).toBe(400);
        });

        it('should process valid text and return key elements', async () => {
            const mockAnthropicResponse = {
                content: [
                    {
                        text: JSON.stringify({
                            key_elements: [
                                {
                                    match: 'This is the most critical sentence in the article.',
                                    importance: 'critical',
                                    category: 'thesis',
                                    label: 'Main Point'
                                }
                            ],
                            summary: 'This is a two sentence summary. It is very short.'
                        })
                    }
                ],
                usage: { input_tokens: 50, output_tokens: 30 },
            };

            mockCreateMessage.mockResolvedValue(mockAnthropicResponse);

            const longText = 'This is the most critical sentence in the article. '.repeat(10);

            const response = await request(app)
                .post('/api/extract-knowledge')
                .send({ text: longText });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.key_elements).toBeDefined();
            expect(response.body.key_elements).toHaveLength(1);
            expect(response.body.summary).toBeDefined();
        });
    });
});
