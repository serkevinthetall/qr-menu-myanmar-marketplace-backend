import { env } from '../config/env.js';

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string; status?: string };
};

export async function geminiChatJson(params: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<string> {
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const model = env.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.geminiApiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: params.system }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: params.user }],
        },
      ],
      generationConfig: {
        temperature: params.temperature ?? 0.3,
        responseMimeType: 'application/json',
      },
    }),
  });

  const data = (await response.json()) as GeminiGenerateResponse;
  if (!response.ok) {
    throw new Error(
      data.error?.message || `Gemini request failed (${response.status}).`,
    );
  }

  const content = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text ?? '')
    .join('')
    .trim();
  if (!content) {
    throw new Error('Gemini returned an empty response.');
  }
  return content;
}
