#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { defaultStateDir } from './state.mjs';
import { ensureDesktopRunning, requestJson } from './mcp-lib.mjs';

const server = new McpServer({ name: 'agentify-desktop', version: '0.1.0' });
const stateDir = defaultStateDir();
const showTabs = process.argv.includes('--show-tabs');

function registerTool(name, def, handler) {
  server.registerTool(name, def, handler);
}

async function getConn() {
  return await ensureDesktopRunning({ stateDir, showTabs });
}

registerTool(
  'agentify_query',
  {
    description:
      'Send a prompt to a local Agentify Desktop browser session and return the latest assistant response. If a CAPTCHA/login challenge appears, the browser window will ask for user intervention and resume automatically.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      vendorId: z.string().optional().describe('Target vendor id (chatgpt, perplexity, claude, aistudio, gemini, grok).'),
      tabId: z.string().optional().describe('Tab/session id to use (for parallel jobs).'),
      key: z.string().optional().describe('Stable tab key (e.g., project name); creates a tab if missing.'),
      prompt: z.string().describe('Prompt to send to the selected AI web UI.'),
      attachments: z.array(z.string()).optional().describe('Local file paths to upload before sending the prompt.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.')
    }
  },
  async ({ model, vendorId, tabId, key, prompt, attachments, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: { tabId, key, model, vendorId, prompt, attachments: attachments || [], timeoutMs: timeoutMs || 10 * 60_000 }
    });
    const structuredContent = {
      text: data.result?.text || '',
      codeBlocks: data.result?.codeBlocks || [],
      meta: data.result?.meta || null
    };
    return {
      content: [{ type: 'text', text: structuredContent.text }],
      structuredContent: { tabId: data.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_read_page',
  {
    description: 'Read text content from the active tab in the local Agentify Desktop window.',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      vendorId: z.string().optional().describe('Target vendor id when creating a tab for this key.'),
      maxChars: z.number().optional().describe('Maximum characters to return.')
    }
  },
  async ({ tabId, key, vendorId, maxChars }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/read-page',
      body: { tabId, key, vendorId, maxChars: maxChars || 200_000 }
    });
    return { content: [{ type: 'text', text: data.text || '' }] };
  }
);

registerTool(
  'agentify_navigate',
  {
    description: 'Navigate the Agentify Desktop browser window to a URL (local UI automation).',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      vendorId: z.string().optional().describe('Target vendor id when creating a tab for this key.'),
      url: z.string().describe('URL to navigate to.')
    }
  },
  async ({ tabId, key, vendorId, url }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/navigate', body: { tabId, key, vendorId, url } });
    return { content: [{ type: 'text', text: data.url || 'ok' }], structuredContent: data };
  }
);

registerTool(
  'agentify_ensure_ready',
  {
    description:
      'Wait until the selected AI web UI is ready for input (e.g., after login/CAPTCHA). Triggers local user handoff if needed and resumes when the prompt textarea is visible.',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      vendorId: z.string().optional().describe('Target vendor id when creating a tab for this key.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for readiness.')
    }
  },
  async ({ tabId, key, vendorId, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/ensure-ready', body: { tabId, key, vendorId, timeoutMs: timeoutMs || 10 * 60_000 } });
    return { content: [{ type: 'text', text: JSON.stringify(data.state || {}, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_show',
  {
    description: 'Bring the Agentify Desktop window to the front.',
    inputSchema: { tabId: z.string().optional(), key: z.string().optional(), vendorId: z.string().optional() }
  },
  async ({ tabId, key, vendorId }) => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/show', body: { tabId, key, vendorId } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_hide',
  { description: 'Minimize the Agentify Desktop window.', inputSchema: { tabId: z.string().optional(), key: z.string().optional(), vendorId: z.string().optional() } },
  async ({ tabId, key, vendorId }) => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/hide', body: { tabId, key, vendorId } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_status',
  {
    description: 'Get current URL and blocked/ready status for the Agentify Desktop window.',
    inputSchema: { tabId: z.string().optional().describe('Tab/session id to query.') }
  },
  async ({ tabId }) => {
    const conn = await getConn();
    const path = tabId ? `/status?tabId=${encodeURIComponent(tabId)}` : '/status';
    const data = await requestJson({ ...conn, method: 'GET', path });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_image_gen',
  {
    description:
      'Generate images via the selected AI web UI, then download them to local files. Optional post-processing can remove fake checkerboard/chroma-key backgrounds or normalize fixed-grid monochrome sheets.',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      vendorId: z.string().optional().describe('Target vendor id when creating a tab for this key.'),
      prompt: z.string().describe('Prompt to send for image generation.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.'),
      maxImages: z.number().optional().describe('Maximum images to download.'),
      postprocessMode: z.enum(['auto', 'chroma-key', 'lcd-ink', 'none']).optional().describe('Post-processing mode. Use chroma-key for flat #FF00FF/#00FF00 keyed backgrounds; use lcd-ink for black-only transparent grid images.'),
      chromaKey: z.string().optional().describe('Hex chroma-key color to remove when postprocessMode="chroma-key"; default #FF00FF.'),
      columns: z.number().optional().describe('Grid image columns for lcd-ink mode.'),
      rows: z.number().optional().describe('Grid image rows for lcd-ink mode.'),
      cellSize: z.number().optional().describe('Output cell size in pixels for lcd-ink mode.')
    }
  },
  async ({ tabId, key, vendorId, prompt, timeoutMs, maxImages, postprocessMode, chromaKey, columns, rows, cellSize }) => {
    const conn = await getConn();
    const mode = postprocessMode === 'none' ? 'auto' : postprocessMode || 'auto';
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/image-gen',
      body: {
        tabId,
        key,
        vendorId,
        prompt,
        attachments: [],
        timeoutMs: timeoutMs || 10 * 60_000,
        maxImages: maxImages || 6,
        minImages: 1,
        postprocess: postprocessMode !== 'none',
        postprocessMode: mode,
        imageOptions: { columns, rows, cellSize, chromaKey }
      }
    });
    const structuredContent = { files: data.files || [], imageCount: data.result?.images?.length || 0, elapsedMs: data.result?.elapsedMs || null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: { tabId: data.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_download_images',
  {
    description:
      'Download images from the latest assistant message (best-effort). Useful if you generated images manually in the UI or via agentify_query.',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      vendorId: z.string().optional().describe('Target vendor id when creating a tab for this key.'),
      maxImages: z.number().optional().describe('Maximum images to download.')
    }
  },
  async ({ tabId, key, vendorId, maxImages }) => {
    const conn = await getConn();
    const d = await requestJson({ ...conn, method: 'POST', path: '/download-images', body: { tabId, key, vendorId, maxImages: maxImages || 6 } });
    const structuredContent = { files: d.files || [] };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  }
);

registerTool(
  'agentify_tabs',
  {
    description: 'List current tabs/sessions (for parallel jobs).',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/tabs' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_tab_create',
  {
    description: 'Create (or ensure) a tab/session for a given key.',
    inputSchema: {
      key: z.string().optional(),
      name: z.string().optional(),
      vendorId: z.string().optional().describe('Vendor id: chatgpt, perplexity, claude, aistudio, gemini, or grok.'),
      show: z.boolean().optional().describe('Focus the tab immediately. Does not create a separate browser window.'),
      newWindow: z.boolean().optional().describe('Create a separate browser window instead of a tab. Leave false unless the governor explicitly needs parallel visible windows.')
    }
  },
  async ({ key, name, vendorId, show, newWindow }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/tabs/create',
      body: { key, name, vendorId, show: typeof show === 'boolean' ? show : undefined, newWindow: newWindow === true }
    });
    return { content: [{ type: 'text', text: data.tabId || '' }], structuredContent: data };
  }
);

registerTool(
  'agentify_tab_close',
  {
    description: 'Close a tab/session by tabId.',
    inputSchema: { tabId: z.string().describe('Tab id to close.') }
  },
  async ({ tabId }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/tabs/close', body: { tabId } });
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }
);

registerTool(
  'agentify_shutdown',
  {
    description: 'Gracefully shut down the Agentify Desktop app.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/shutdown', body: { scope: 'app' } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_rotate_token',
  {
    description: 'Rotate the local HTTP API bearer token (requires reconnect on subsequent calls).',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/rotate-token' });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('agentify-desktop MCP server running on stdio');
}

main().catch((e) => {
  console.error('agentify-desktop MCP fatal:', e);
  process.exit(1);
});
