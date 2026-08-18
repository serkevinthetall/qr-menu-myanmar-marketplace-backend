import { env } from '../config/env.js';

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string; status?: string };
};

export type GeminiChatTurn = {
  role: 'user' | 'model';
  text: string;
};

async function geminiGenerate(params: {
  system: string;
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
  temperature?: number;
  responseMimeType?: 'application/json' | 'text/plain';
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
      contents: params.contents,
      generationConfig: {
        temperature: params.temperature ?? 0.3,
        ...(params.responseMimeType
          ? { responseMimeType: params.responseMimeType }
          : {}),
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

export async function geminiChatText(params: {
  system: string;
  history?: GeminiChatTurn[];
  user: string;
  temperature?: number;
}): Promise<string> {
  const contents: Array<{
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
  }> = [];

  for (const turn of params.history ?? []) {
    const text = turn.text.trim();
    if (!text) {
      continue;
    }
    contents.push({
      role: turn.role,
      parts: [{ text }],
    });
  }
  contents.push({
    role: 'user',
    parts: [{ text: params.user }],
  });

  return geminiGenerate({
    system: params.system,
    contents,
    temperature: params.temperature ?? 0.4,
  });
}

export async function geminiChatJson(params: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<string> {
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  return geminiGenerate({
    system: params.system,
    contents: [
      {
        role: 'user',
        parts: [{ text: params.user }],
      },
    ],
    temperature: params.temperature ?? 0.3,
    responseMimeType: 'application/json',
  });
}
