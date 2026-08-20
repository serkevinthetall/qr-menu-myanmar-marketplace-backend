import { env } from '../config/env.js';
import { callOdooKwForUser } from './odoo.service.js';

export type OdooAiChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type AgentRow = {
  id: number;
  name?: string;
  is_system_agent?: boolean;
};

function extractReply(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.trim();
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
    ]) {
      const value = row[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  return '';
}

async function listAgents(userId: string): Promise<AgentRow[]> {
  try {
    const rows = await callOdooKwForUser<AgentRow[]>(
      userId,
      'ai.agent',
      'search_read',
      [[], ['id', 'name', 'is_system_agent']],
      { limit: 40 },
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    try {
      const rows = await callOdooKwForUser<AgentRow[]>(
        userId,
        'ai.agent',
        'search_read',
        [[], ['id', 'name']],
        { limit: 40 },
      );
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Odoo AI is not available (${message}). Install the Odoo AI app and configure an LLM key in Odoo.`,
      );
    }
  }
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

async function tryGenerate(
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

  const attempts: Array<{
    method: string;
    args: unknown[];
    kwargs: Record<string, unknown>;
  }> = [
    {
      method: 'generate_response',
      args: [[agentId], prompt],
      kwargs: {
        chat_history: chatHistory,
        extra_system_context: extraSystemContext,
      },
    },
    {
      method: 'generate_response',
      args: [[agentId]],
      kwargs: {
        prompt,
        chat_history: chatHistory,
        extra_system_context: extraSystemContext,
      },
    },
    {
      method: '_generate_response',
      args: [[agentId], prompt, chatHistory, extraSystemContext],
      kwargs: {},
    },
  ];

  let lastError = 'Odoo AI generate_response failed.';
  for (const attempt of attempts) {
    try {
      const raw = await callOdooKwForUser(
        userId,
        'ai.agent',
        attempt.method,
        attempt.args,
        attempt.kwargs,
      );
      const reply = extractReply(raw);
      if (reply) {
        return reply;
      }
      lastError = 'Odoo AI returned an empty reply.';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}

/**
 * Overview FAB chat via Odoo AI agents (Odoo 19+).
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
  const combinedPrompt = `${options.extraSystemContext}

USER QUESTION:
${options.prompt}`;

  try {
    return await tryGenerate(
      options.userId,
      agent.id,
      options.prompt,
      options.extraSystemContext,
      options.history ?? [],
    );
  } catch {
    return tryGenerate(
      options.userId,
      agent.id,
      combinedPrompt,
      options.extraSystemContext,
      options.history ?? [],
    );
  }
}
