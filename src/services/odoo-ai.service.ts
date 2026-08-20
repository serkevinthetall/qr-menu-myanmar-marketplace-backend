import { env } from '../config/env.js';
import {
  callOdooJsonRpcForUser,
  callOdooKwForUser,
} from './odoo.service.js';

export type OdooAiChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type AgentRow = {
  id: number;
  name?: string;
  is_system_agent?: boolean;
  partner_id?: [number, string] | false;
};

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractReply(raw: unknown): string {
  if (typeof raw === 'string') {
    return stripHtml(raw);
  }
  if (Array.isArray(raw)) {
    return raw
      .map(item => extractReply(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (raw && typeof raw === 'object') {
    const row = raw as Record<string, unknown>;
    for (const key of [
      'content',
      'text',
      'reply',
      'response',
      'message',
      'output',
      'body',
    ]) {
      const value = row[key];
      if (typeof value === 'string' && value.trim()) {
        return stripHtml(value);
      }
    }
  }
  return '';
}

async function listAgents(userId: string): Promise<AgentRow[]> {
  const fieldSets = [
    ['id', 'name', 'is_system_agent', 'partner_id'],
    ['id', 'name', 'is_system_agent'],
    ['id', 'name'],
  ];

  let lastError = 'Odoo AI agents could not be listed.';
  for (const fields of fieldSets) {
    try {
      const rows = await callOdooKwForUser<AgentRow[]>(
        userId,
        'ai.agent',
        'search_read',
        [[], fields],
        { limit: 40 },
      );
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    `Odoo AI is not available (${lastError}). On Odoo 19.2 Online, install the AI app and set an OpenAI or Gemini key under Settings → AI.`,
  );
}

function pickAgent(agents: AgentRow[]): AgentRow {
  if (env.odooAiAgentId) {
    const byId = agents.find(row => row.id === env.odooAiAgentId);
    if (byId) {
      return byId;
    }
  }

  const wanted = env.odooAiAgentName.toLowerCase();
  if (wanted) {
    const byName = agents.find(
      row => String(row.name ?? '').trim().toLowerCase() === wanted,
    );
    if (byName) {
      return byName;
    }
  }

  const skipAskAi = agents.filter(
    row => String(row.name ?? '').trim().toLowerCase() !== 'ask ai',
  );
  const custom = skipAskAi.find(row => !row.is_system_agent);
  if (custom) {
    return custom;
  }
  const odooAgent = skipAskAi.find(
    row => String(row.name ?? '').trim().toLowerCase() === 'odoo agent',
  );
  if (odooAgent) {
    return odooAgent;
  }
  if (skipAskAi[0]) {
    return skipAskAi[0];
  }
  if (agents[0]) {
    return agents[0];
  }
  throw new Error(
    'No Odoo AI agent found. Create an agent in the Odoo AI app.',
  );
}

/**
 * Odoo 19+ marks ai.agent._generate_response as @api.private, so call_kw
 * is blocked. The web client uses HTTP JSON-RPC controllers instead.
 */
async function tryHttpGenerate(
  userId: string,
  agentId: number,
  prompt: string,
  extraSystemContext: string,
  history: OdooAiChatTurn[],
): Promise<string> {
  const chatHistory = history.map(turn => ({
    role: turn.role,
    content: turn.content,
  }));

  const paramSets: Record<string, unknown>[] = [
    {
      prompt,
      ai_agent_id: agentId,
      chat_history: chatHistory,
      extra_system_context: extraSystemContext,
    },
    {
      prompt,
      agent_id: agentId,
      chat_history: chatHistory,
      extra_system_context: extraSystemContext,
    },
    {
      prompt,
      ai_agent_id: agentId,
    },
    {
      prompt: `${extraSystemContext}\n\nUSER QUESTION:\n${prompt}`,
      ai_agent_id: agentId,
    },
  ];

  const routes = ['/ai/generate_response', '/ai/agent/generate_response'];

  let lastError = 'Odoo AI HTTP generate_response failed.';
  for (const route of routes) {
    for (const params of paramSets) {
      try {
        const raw = await callOdooJsonRpcForUser(userId, route, params);
        const reply = extractReply(raw);
        if (reply) {
          return reply;
        }
        lastError = `Odoo AI returned an empty reply from ${route}.`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  throw new Error(lastError);
}

function findChannelId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = findChannelId(item);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id === 'number' && Number.isFinite(row.id)) {
    return row.id;
  }
  if (Array.isArray(row['discuss.channel'])) {
    return findChannelId(row['discuss.channel']);
  }
  if (row.channel && typeof row.channel === 'object') {
    return findChannelId(row.channel);
  }
  return null;
}

/**
 * Fallback used by Odoo Ask AI / agent Discuss chats:
 * open (or create) an ai_chat channel, post the user message, then read the
 * next assistant message. Avoids private ORM methods like _generate_response.
 */
async function tryDiscussChannelGenerate(
  userId: string,
  agent: AgentRow,
  prompt: string,
  extraSystemContext: string,
): Promise<string> {
  const body = `${extraSystemContext}\n\nUSER QUESTION:\n${prompt}`.trim();
  let channelId: number | null = null;

  try {
    const created = await callOdooKwForUser<number | number[]>(
      userId,
      'discuss.channel',
      'create',
      [
        {
          name: `Overview Chat · ${agent.name ?? agent.id}`,
          channel_type: 'ai_chat',
          ai_agent_id: agent.id,
        },
      ],
    );
    channelId = Array.isArray(created) ? Number(created[0]) : Number(created);
  } catch {
    const partnerId = Array.isArray(agent.partner_id)
      ? agent.partner_id[0]
      : null;
    if (!partnerId) {
      throw new Error(
        'Could not open an Odoo AI Discuss channel (no agent partner).',
      );
    }

    // Odoo 19 moved channel_get behind mail webclient / HTTP helpers.
    const mailDataAttempts: Array<{
      route: string;
      params: Record<string, unknown>;
    }> = [
      {
        route: '/discuss/get_or_create_chat',
        params: { partners_to: [partnerId], pin: false },
      },
      {
        route: '/mail/data',
        params: {
          fetch_params: [
            ['/discuss/get_or_create_chat', { partners_to: [partnerId], pin: false }],
          ],
        },
      },
    ];

    let lastError = 'Discuss get_or_create_chat failed.';
    for (const attempt of mailDataAttempts) {
      try {
        const raw = await callOdooJsonRpcForUser(
          userId,
          attempt.route,
          attempt.params,
        );
        channelId = findChannelId(raw);
        if (channelId) {
          break;
        }
        lastError = `Discuss route ${attempt.route} returned no channel id.`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (!channelId) {
      throw new Error(lastError);
    }
  }

  if (!channelId || !Number.isFinite(channelId)) {
    throw new Error('Could not create or open an Odoo AI Discuss channel.');
  }

  await callOdooKwForUser(userId, 'discuss.channel', 'message_post', [
    [channelId],
  ], {
    body,
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_comment',
  });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const messages = await callOdooKwForUser<
      Array<{ id: number; body?: string; author_id?: [number, string] | false }>
    >(
      userId,
      'mail.message',
      'search_read',
      [
        [
          ['model', '=', 'discuss.channel'],
          ['res_id', '=', channelId],
        ],
        ['id', 'body', 'author_id'],
      ],
      { limit: 8, order: 'id desc' },
    );

    for (const message of messages ?? []) {
      const text = extractReply(message.body ?? '');
      if (!text) {
        continue;
      }
      // Skip the user prompt we just posted.
      if (text.includes('USER QUESTION:') && text.includes(prompt.slice(0, 40))) {
        continue;
      }
      if (text === stripHtml(body)) {
        continue;
      }
      return text;
    }
  }

  throw new Error(
    'Odoo AI Discuss channel did not return a reply in time. Check AI provider keys in Odoo Settings → AI.',
  );
}

/**
 * Overview FAB chat via Odoo AI agents (Odoo 19.2 Online compatible).
 * Analyze six-month stays on Gemini.
 */
export async function askOdooAi(options: {
  userId: string;
  prompt: string;
  extraSystemContext: string;
  history?: OdooAiChatTurn[];
}): Promise<string> {
  const agents = await listAgents(options.userId);
  const agent = pickAgent(agents);
  const history = options.history ?? [];

  const errors: string[] = [];

  try {
    return await tryHttpGenerate(
      options.userId,
      agent.id,
      options.prompt,
      options.extraSystemContext,
      history,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    return await tryDiscussChannelGenerate(
      options.userId,
      agent,
      options.prompt,
      options.extraSystemContext,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  throw new Error(
    [
      'Odoo AI could not be reached from this app on Odoo 19.2 Online.',
      'Private ORM methods like ai.agent._generate_response cannot be called remotely.',
      'Tried the AI HTTP route and Discuss channel fallback.',
      ...errors.map(message => `- ${message}`),
    ].join('\n'),
  );
}
