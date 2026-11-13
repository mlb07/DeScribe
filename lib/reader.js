// The part that reads the handwriting.
// There are two readers: the real AI, and a free "practice" one that returns sample text.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod/v4';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { SYSTEM_PROMPT, buildUserText } from './prompt.js';

// Which AI model reads the photos. Change it with AI_MODEL in your .env file.
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const EFFORT = 'high';

// The shape the AI must answer in.
const AnswerShape = z.object({
  notes: z
    .array(
      z.object({
        heading: z
          .string()
          .describe('The printed section heading this handwriting is written under, exactly as printed; empty if it is not inside a printed section'),
        blocks: z.array(
          z.object({
            kind: z.string().describe('"paragraph", "bullet" or "numbered"'),
            level: z.number().describe('0 normally; 1 or 2 for sub-points under a list item'),
            text: z.string().describe('The text, with [[double brackets]] around words you are unsure of'),
          }),
        ),
      }),
    )
    .describe('One entry per separate handwritten note, in reading order'),
  issue: z.string().describe('Empty, or a short plain-English reason nothing could be read'),
});

// A problem to show on the phone. "retryable" means trying again later could work.
export class ReadError extends Error {
  constructor(message, { status = 500, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export function detectImageType(data) {
  if (!data || data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function explainProblem(error) {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ReadError('The AI key is not working. Check the key in your .env file.', { status: 500 });
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ReadError('The AI model name is not recognised. Check AI_MODEL in your .env file.', { status: 500 });
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.APIConnectionError) {
    return new ReadError('The AI is busy or out of reach. Trying again shortly.', { status: 503, retryable: true });
  }
  if (error instanceof Anthropic.BadRequestError) {
    const noCredit = /credit balance/i.test(String(error.message));
    return new ReadError(
      noCredit ? 'Your AI account is out of credit. Add credit at console.anthropic.com.' : 'The AI could not accept this photo.',
      { status: 422 },
    );
  }
  if (error instanceof Anthropic.APIError && error.status >= 500) {
    return new ReadError('The AI is busy or out of reach. Trying again shortly.', { status: 503, retryable: true });
  }
  return new ReadError('Something went wrong reading this photo.', { status: 500 });
}

export function createAiReader({ apiKey, client, model = DEFAULT_MODEL }) {
  const ai = client || new Anthropic({ apiKey, timeout: 180_000, maxRetries: 2 });

  return {
    async read({ image, crewInfo, crewWords }) {
      const mediaType = detectImageType(image);
      let answer;
      try {
        answer = await ai.beta.messages.parse({
          model,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          output_config: { effort: EFFORT, format: betaZodOutputFormat(AnswerShape) },
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
                { type: 'text', text: buildUserText({ teamContext: crewInfo, words: crewWords.map((term) => ({ term })) }) },
              ],
            },
          ],
        });
      } catch (error) {
        throw explainProblem(error);
      }

      if (answer.stop_reason === 'refusal') {
        throw new ReadError('The AI could not read this photo. Try another photo.', { status: 422 });
      }
      if (answer.stop_reason === 'max_tokens') {
        throw new ReadError('This photo has too much writing to read in one go. Try photographing part of it.', { status: 422 });
      }
      if (!answer.parsed_output) {
        throw new ReadError('The AI gave an unexpected answer. Trying again shortly.', { status: 502, retryable: true });
      }
      return { notes: answer.parsed_output.notes, issue: answer.parsed_output.issue || '', model, usage: answer.usage };
    },
  };
}

// True when the AI marked at least one word as a guess, or could read nothing.
export function needsSecondOpinion(result) {
  if (!result.notes || result.notes.length === 0) return true;
  return result.notes.some((note) => (note.blocks || []).some((block) => /\[\[/.test(block.text || '')));
}

// Reads every photo with the cheap model first. Only when it is unsure does the
// stronger model read the same photo again, and its answer is used instead.
// If the second read fails, the first answer (with its highlights) is kept.
export function createCheckedReader({ first, second, log = () => {} }) {
  return {
    async read(input) {
      const firstResult = await first.read(input);
      log(firstResult);
      if (!needsSecondOpinion(firstResult)) return firstResult;
      try {
        const secondResult = await second.read(input);
        log(secondResult);
        return secondResult;
      } catch (error) {
        log({ model: 'second opinion', failed: error.message });
        return firstResult;
      }
    },
  };
}

export function createPracticeReader() {
  return {
    async read() {
      return {
        notes: [
          {
            blocks: [
              { kind: 'paragraph', level: 0, text: 'Sample text: this is where your handwriting will appear.' },
              { kind: 'bullet', level: 0, text: 'Words the AI is [[unsure]] of will be highlighted in yellow.' },
              { kind: 'bullet', level: 0, text: 'Each new photo is added to the end of the document.' },
            ],
          },
        ],
        issue: '',
      };
    },
  };
}
