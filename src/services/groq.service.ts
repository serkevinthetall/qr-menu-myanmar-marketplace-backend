import { env } from '../config/env.js';

type GroqChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type GroqChatResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: { message?: string };
};

export async function groqChatJson(params: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<string> {
  if (!env.groqApiKey) {
    throw new Error('GROQ_API_KEY is not configured.');
  }

  const messages: GroqChatMessage[] = [
    { role: 'system', content: params.system },
    { role: 'user', content: params.user },
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.groqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.groqModel,
      temperature: params.temperature ?? 0.3,
      response_format: { type: 'json_object' },
      messages,
    }),
  });

  const data = (await response.json()) as GroqChatResponse;
  if (!response.ok) {
    throw new Error(data.error?.message || `Groq request failed (${response.status}).`);
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Groq returned an empty response.');
  }
  return content;
}
